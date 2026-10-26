import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'
import { lockAgentTurnEffectFence } from '@/lib/agent-turn/effect-fence'
import {
  isBillablePlannedOperation,
  type ProjectAgentOperationContext,
  type ProjectAgentOperationDefinition,
} from './types'
import {
  loadOperationPlanSnapshot,
  replaceOperationPlanSnapshotArtifacts,
} from './operation-plan-snapshot'
import { hashCanonicalJson } from '@/lib/operation-plan-contract/canonical-json'
import {
  buildCurrentOperationPlanArtifacts,
  changedOperationPlanArtifacts,
} from './operation-plan-revalidation'
import { getBillingMode } from '@/lib/billing'
import type { OperationPlan } from './plan-contract'
import { GLOBAL_ASSET_PROJECT_ID } from '@/lib/workspace-resource/resource-impact'
import { schedulePersistedTask } from '@/lib/temporal/task-client'
import type { PersistedTaskReference, ScheduledTaskReceipt } from '@/lib/temporal/task/contracts'
import { isTaskType } from '@/lib/task/types'
import { OPERATION_EXECUTION_MAX_TASKS } from '@/lib/temporal/operation-execution/contracts'

const APPROVED_OPERATION_TRANSACTION_TIMEOUT_MS = 60_000
const APPROVED_OPERATION_MAX_TASKS = OPERATION_EXECUTION_MAX_TASKS

export interface PlannedOperationInvocation {
  approvalGrantId: string
  requestId: string
}

export interface OperationExecutionAuthorization {
  approvalGrantId: string
  operationExecutionId: string
  transaction: Prisma.TransactionClient
}

export interface ApprovalGrantRequest {
  planSnapshotId: string
  requestId: string
}

export interface IssuedApprovalGrant extends PlannedOperationInvocation {
  planSnapshotId: string
  operationId: string
}

export interface ApprovedOperationExecutionTaskReceipt {
  reference: PersistedTaskReference
  schedule: ScheduledTaskReceipt
}

export interface ApprovedOperationExecutionReceipt {
  operationExecutionId: string
  approvalGrantId: string
  operationRequestId: string
  outputHash: string
  tasks: readonly ApprovedOperationExecutionTaskReceipt[]
}

export interface ApprovedOperationPlanInvocationResult<Output> {
  output: Output
  receipt: ApprovedOperationExecutionReceipt
}

export class ApprovedOperationExecutionReceiptError extends Error {
  constructor(
    readonly code: string,
    ...details: unknown[]
  ) {
    super([code, ...details.map((detail) => String(detail))].join(':'))
    this.name = 'ApprovedOperationExecutionReceiptError'
  }
}

function receiptError(code: string, ...details: unknown[]): never {
  throw new ApprovedOperationExecutionReceiptError(code, ...details)
}

export function requireOperationExecutionTransaction(
  ctx: ProjectAgentOperationContext,
): Prisma.TransactionClient {
  const transaction = ctx.executionAuthorization?.transaction
  if (!transaction) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'OPERATION_EXECUTION_TRANSACTION_REQUIRED',
    })
  }
  return transaction
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function splitPlannedOperationInvocation(input: unknown): {
  invocation: PlannedOperationInvocation | null
  businessInput: unknown
} {
  if (!isRecord(input)) return { invocation: null, businessInput: input }
  if ('confirmed' in input || 'confirmedMaxCost' in input) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'LEGACY_OPERATION_CONFIRMATION_UNSUPPORTED',
      message:
        'boolean operation confirmation is not accepted; approve the immutable plan snapshot',
    })
  }
  const approvalGrantId = input.approvalGrantId
  const requestId = input.operationRequestId
  const businessInput = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => key !== 'approvalGrantId' && key !== 'operationRequestId',
    ),
  )
  if (approvalGrantId === undefined && requestId === undefined) {
    return { invocation: null, businessInput }
  }
  if (
    typeof approvalGrantId !== 'string' ||
    !approvalGrantId.trim() ||
    typeof requestId !== 'string' ||
    !requestId.trim()
  ) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'OPERATION_PLAN_INVOCATION_INVALID',
      message: 'approvalGrantId and operationRequestId are both required',
    })
  }
  return {
    invocation: {
      approvalGrantId: approvalGrantId.trim(),
      requestId: requestId.trim(),
    },
    businessInput,
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('OPERATION_EXECUTION_OUTPUT_NOT_JSON')
  return JSON.parse(serialized) as Prisma.InputJsonValue
}

export async function issueApprovalGrantGroupInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    requests: readonly ApprovalGrantRequest[]
  },
): Promise<IssuedApprovalGrant[]> {
  if (params.requests.length === 0) return []
  const planSnapshotIds = params.requests.map((request) => request.planSnapshotId.trim())
  if (
    planSnapshotIds.some((id) => !id) ||
    new Set(planSnapshotIds).size !== planSnapshotIds.length
  ) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'APPROVAL_GROUP_PLAN_SNAPSHOT_INVALID',
    })
  }
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM operation_plan_snapshots
    WHERE id IN (${Prisma.join([...planSnapshotIds].sort())})
    ORDER BY id
    FOR UPDATE
  `)
  if (locked.length !== planSnapshotIds.length) {
    throw new ApiError('NOT_FOUND', {
      code: 'OPERATION_PLAN_SNAPSHOT_NOT_FOUND',
    })
  }
  const issued: IssuedApprovalGrant[] = []
  for (const request of params.requests) {
    const snapshot = await loadOperationPlanSnapshot(request.planSnapshotId, tx)
    if (!snapshot) {
      throw new ApiError('NOT_FOUND', {
        code: 'OPERATION_PLAN_SNAPSHOT_NOT_FOUND',
      })
    }
    if (snapshot.userId !== params.userId) {
      throw new ApiError('FORBIDDEN', {
        code: 'OPERATION_PLAN_SCOPE_MISMATCH',
      })
    }
    if (snapshot.apiRequestId !== null && snapshot.apiRequestId !== request.requestId) {
      throw new ApiError('FORBIDDEN', {
        code: 'APPROVAL_GRANT_REQUEST_MISMATCH',
      })
    }
    const existing = await tx.approvalGrant.findUnique({
      where: { planSnapshotId: snapshot.id },
    })
    if (existing) {
      if (
        existing.userId !== params.userId
        || existing.requestId !== request.requestId
      ) {
        throw new ApiError('CONFLICT', { code: 'APPROVAL_GRANT_NOT_USABLE' })
      }
      // Revoked grants (plan/price drift) must not dead-end local OFF/SHADOW
      // retries that reuse the same apiRequestId/snapshot after a refresh.
      if (existing.revokedAt) {
        if (existing.consumedAt || existing.consumedExecutionId) {
          throw new ApiError('CONFLICT', { code: 'APPROVAL_GRANT_NOT_USABLE' })
        }
        const billingMode = await getBillingMode()
        if (billingMode === 'ENFORCE') {
          throw new ApiError('CONFLICT', { code: 'APPROVAL_GRANT_NOT_USABLE' })
        }
        await tx.approvalGrant.delete({ where: { id: existing.id } })
      } else {
        issued.push({
          planSnapshotId: snapshot.id,
          operationId: snapshot.operationId,
          approvalGrantId: existing.id,
          requestId: existing.requestId,
        })
        continue
      }
    }
    const grant = await tx.approvalGrant.create({
      data: {
        id: randomUUID(),
        userId: snapshot.userId,
        scopeKind: snapshot.scopeKind,
        scopeId: snapshot.scopeId,
        projectId: snapshot.projectId,
        operationId: snapshot.operationId,
        planSnapshotId: snapshot.id,
        requestId: request.requestId,
        inputHash: snapshot.inputHash,
        planHash: snapshot.planHash,
        quoteHash: snapshot.quoteHash,
        quoteCeiling: snapshot.quote.totalMaxFrozenCost ?? null,
        currency: snapshot.quote.currency ?? null,
      },
    })
    issued.push({
      planSnapshotId: snapshot.id,
      operationId: snapshot.operationId,
      approvalGrantId: grant.id,
      requestId: grant.requestId,
    })
  }
  return issued
}

export async function issueApprovalGrantGroup(params: {
  userId: string
  requests: readonly ApprovalGrantRequest[]
}): Promise<IssuedApprovalGrant[]> {
  if (params.requests.length === 0) return []
  return await prisma.$transaction(
    async (tx) => await issueApprovalGrantGroupInTransaction(tx, params),
  )
}

export async function issueApprovalGrant(params: {
  userId: string
  planSnapshotId: string
  requestId: string
}): Promise<{ approvalGrantId: string; operationRequestId: string }> {
  const [issued] = await issueApprovalGrantGroup({
    userId: params.userId,
    requests: [
      {
        planSnapshotId: params.planSnapshotId,
        requestId: params.requestId,
      },
    ],
  })
  if (!issued) throw new Error('APPROVAL_GRANT_ISSUANCE_EMPTY')
  return {
    approvalGrantId: issued.approvalGrantId,
    operationRequestId: issued.requestId,
  }
}

function assertSnapshotScope(params: {
  userId: string
  projectId: string
  operationId: string
  normalizedInput: unknown
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOperationPlanSnapshot>>>
}): void {
  const expectedScopeKind =
    params.projectId === GLOBAL_ASSET_PROJECT_ID ? 'global_asset_hub' : 'project'
  if (
    params.snapshot.userId !== params.userId ||
    params.snapshot.scopeKind !== expectedScopeKind ||
    params.snapshot.scopeId !== params.projectId ||
    params.snapshot.operationId !== params.operationId
  ) {
    throw new ApiError('FORBIDDEN', {
      code: 'OPERATION_PLAN_SCOPE_MISMATCH',
      message: 'the approved plan does not belong to this user, scope, or operation',
    })
  }
  if (hashCanonicalJson(params.normalizedInput) !== params.snapshot.inputHash) {
    throw new ApiError('CONFLICT', {
      code: 'OPERATION_PLAN_INPUT_CHANGED',
      message: 'the operation input differs from the approved immutable plan',
    })
  }
}

async function lockApprovalGrant(
  tx: Prisma.TransactionClient,
  approvalGrantId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM approval_grants
    WHERE id = ${approvalGrantId}
    FOR UPDATE
  `)
  if (rows.length !== 1) {
    throw new ApiError('NOT_FOUND', { code: 'APPROVAL_GRANT_NOT_FOUND' })
  }
}

async function settleApprovalGrant(
  tx: Prisma.TransactionClient,
  params:
    | { readonly kind: 'revoke'; readonly grantId: string }
    | {
        readonly kind: 'consume'
        readonly grantId: string
        readonly executionId: string
      },
): Promise<void> {
  const settled = await tx.approvalGrant.updateMany({
    where: {
      id: params.grantId,
      version: 0,
      consumedAt: null,
      consumedExecutionId: null,
      revokedAt: null,
    },
    data:
      params.kind === 'consume'
        ? {
            consumedAt: new Date(),
            consumedExecutionId: params.executionId,
            version: { increment: 1 },
          }
        : {
            revokedAt: new Date(),
            version: { increment: 1 },
          },
  })
  if (settled.count !== 1) {
    throw new Error(
      `APPROVAL_GRANT_${params.kind === 'consume' ? 'CONSUME' : 'REVOKE'}_RACED:${params.grantId}`,
    )
  }
}

function assertGrantMatchesSnapshot(params: {
  grant: {
    id: string
    requestId: string
    inputHash: string
    planHash: string
    quoteHash: string
    revokedAt: Date | null
  }
  requestId: string
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOperationPlanSnapshot>>>
}): void {
  if (params.grant.requestId !== params.requestId) {
    throw new ApiError('FORBIDDEN', {
      code: 'APPROVAL_GRANT_REQUEST_MISMATCH',
    })
  }
  if (
    params.grant.inputHash !== params.snapshot.inputHash ||
    params.grant.planHash !== params.snapshot.planHash ||
    params.grant.quoteHash !== params.snapshot.quoteHash ||
    params.grant.revokedAt
  ) {
    throw new ApiError('CONFLICT', { code: 'APPROVAL_GRANT_NOT_USABLE' })
  }
}

/**
 * Returns the exact normalized input that was priced and approved for a
 * granted plan. Approval resume executes this snapshot: normalization happens
 * exactly once, at preflight, and the persisted snapshot the user approved is
 * the only input authority afterwards. Re-normalizing the model's original
 * tool arguments on resume is forbidden because it would create a second
 * interpretation path and could change what executes versus what was approved.
 */
export async function loadApprovedOperationExecutionInput(params: {
  userId: string
  operationId: string
  invocation: PlannedOperationInvocation
}): Promise<unknown> {
  const grant = await prisma.approvalGrant.findUnique({
    where: { id: params.invocation.approvalGrantId },
  })
  if (!grant) throw new ApiError('NOT_FOUND', { code: 'APPROVAL_GRANT_NOT_FOUND' })
  if (grant.userId !== params.userId || grant.operationId !== params.operationId) {
    throw new ApiError('FORBIDDEN', { code: 'OPERATION_PLAN_SCOPE_MISMATCH' })
  }
  const snapshot = await loadOperationPlanSnapshot(grant.planSnapshotId)
  if (!snapshot)
    throw new ApiError('NOT_FOUND', {
      code: 'OPERATION_PLAN_SNAPSHOT_NOT_FOUND',
    })
  assertGrantMatchesSnapshot({
    grant,
    requestId: params.invocation.requestId,
    snapshot,
  })
  return snapshot.normalizedInput
}

export async function invokeApprovedOperationPlan<Input, Output>(params: {
  operation: ProjectAgentOperationDefinition<Input, Output>
  ctx: ProjectAgentOperationContext
  normalizedInput: Input
  invocation: PlannedOperationInvocation
}): Promise<Output> {
  if (!isBillablePlannedOperation(params.operation)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'APPROVAL_GRANT_NOT_APPLICABLE',
    })
  }
  const planContractRevision = params.operation.planContractRevision
  const commit = params.operation.commit
  type OperationWriter = NonNullable<ProjectAgentOperationContext['writer']>
  type BufferedOperationPart = Parameters<OperationWriter['write']>[0]
  const bufferedParts: BufferedOperationPart[] = []
  const bufferedWriter = {
    write(part: BufferedOperationPart) {
      bufferedParts.push(part)
    },
  } as OperationWriter
  const previewGrant = await prisma.approvalGrant.findUnique({
    where: { id: params.invocation.approvalGrantId },
  })
  if (!previewGrant) throw new ApiError('NOT_FOUND', { code: 'APPROVAL_GRANT_NOT_FOUND' })
  const previewSnapshot = await loadOperationPlanSnapshot(previewGrant.planSnapshotId)
  if (!previewSnapshot)
    throw new ApiError('NOT_FOUND', {
      code: 'OPERATION_PLAN_SNAPSHOT_NOT_FOUND',
    })
  assertGrantMatchesSnapshot({
    grant: previewGrant,
    requestId: params.invocation.requestId,
    snapshot: previewSnapshot,
  })
  assertSnapshotScope({
    userId: params.ctx.userId,
    projectId: params.ctx.projectId,
    operationId: params.operation.id,
    normalizedInput: params.normalizedInput,
    snapshot: previewSnapshot,
  })
  const existingExecution = await prisma.operationExecution.findUnique({
    where: { approvalGrantId: previewGrant.id },
    select: { id: true },
  })
  const executionContractChanged =
    !existingExecution && previewSnapshot.executionContractRevision !== planContractRevision
  const currentArtifacts =
    existingExecution || executionContractChanged
      ? null
      : await buildCurrentOperationPlanArtifacts({
          operation: params.operation,
          ctx: params.ctx,
          normalizedInput: params.normalizedInput,
        })
  const transactionResult = await prisma.$transaction(
    async (tx) => {
      const projects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM projects
        WHERE id = ${params.ctx.projectId}
        FOR UPDATE
      `)
      if (projects.length !== 1) {
        throw new Error(`OPERATION_EXECUTION_PROJECT_NOT_FOUND:${params.ctx.projectId}`)
      }
      await lockApprovalGrant(tx, params.invocation.approvalGrantId)
      const grant = await tx.approvalGrant.findUnique({
        where: { id: params.invocation.approvalGrantId },
      })
      if (!grant) throw new ApiError('NOT_FOUND', { code: 'APPROVAL_GRANT_NOT_FOUND' })
      const snapshot = await loadOperationPlanSnapshot(grant.planSnapshotId, tx)
      if (!snapshot)
        throw new ApiError('NOT_FOUND', {
          code: 'OPERATION_PLAN_SNAPSHOT_NOT_FOUND',
        })
      assertGrantMatchesSnapshot({
        grant,
        requestId: params.invocation.requestId,
        snapshot,
      })
      assertSnapshotScope({
        userId: params.ctx.userId,
        projectId: params.ctx.projectId,
        operationId: params.operation.id,
        normalizedInput: params.normalizedInput,
        snapshot,
      })

      const existing = await tx.operationExecution.findUnique({
        where: { approvalGrantId: grant.id },
      })
      if (existing) {
        if (existing.status !== 'completed' || existing.output === null) {
          throw new Error(
            `OPERATION_EXECUTION_DURABLE_INTERMEDIATE_STATE:${existing.id}:${existing.status}`,
          )
        }
        return { kind: 'output' as const, output: existing.output as Output }
      }
      if (params.ctx.context.turnId) {
        await lockAgentTurnEffectFence(tx, {
          turnId: params.ctx.context.turnId,
          projectId: params.ctx.projectId,
          userId: params.ctx.userId,
        })
      }
      if (grant.consumedAt || grant.consumedExecutionId) {
        throw new Error(`APPROVAL_GRANT_CONSUMED_WITHOUT_EXECUTION:${grant.id}`)
      }
      if (snapshot.executionContractRevision !== planContractRevision) {
        await settleApprovalGrant(tx, {
          kind: 'revoke',
          grantId: grant.id,
        })
        return {
          kind: 'plan_changed' as const,
          changedArtifacts: ['executionContractRevision'] as const,
        }
      }
      if (!currentArtifacts) {
        throw new Error(`OPERATION_PLAN_REVALIDATION_MISSING:${grant.id}`)
      }
      const changedArtifacts = changedOperationPlanArtifacts(snapshot, currentArtifacts)
      let activePlan: OperationPlan = snapshot.plan
      if (changedArtifacts.length > 0) {
        const billingMode = await getBillingMode()
        if (billingMode === 'ENFORCE') {
          await settleApprovalGrant(tx, {
            kind: 'revoke',
            grantId: grant.id,
          })
          return { kind: 'plan_changed' as const, changedArtifacts }
        }
        // Local OFF/SHADOW: provider schema/pricing aliases can shift the
        // recomputed plan after a quote was frozen. Refresh the snapshot and
        // grant fingerprints in place so generation can proceed instead of
        // looping on OPERATION_PLAN_CHANGED.
        const refreshed = await replaceOperationPlanSnapshotArtifacts({
          snapshotId: snapshot.id,
          plan: currentArtifacts.plan,
          quote: currentArtifacts.quote,
          client: tx,
        })
        await tx.approvalGrant.update({
          where: { id: grant.id },
          data: {
            planHash: refreshed.planHash,
            quoteHash: refreshed.quoteHash,
            quoteCeiling: refreshed.quote.totalMaxFrozenCost ?? null,
            currency: refreshed.quote.currency ?? null,
          },
        })
        activePlan = refreshed.plan
      }

      const execution = await tx.operationExecution.create({
        data: {
          id: randomUUID(),
          userId: snapshot.userId,
          scopeKind: snapshot.scopeKind,
          scopeId: snapshot.scopeId,
          projectId: snapshot.projectId,
          operationId: snapshot.operationId,
          planSnapshotId: snapshot.id,
          approvalGrantId: grant.id,
          requestId: params.invocation.requestId,
          status: 'committing',
        },
      })
      await settleApprovalGrant(tx, {
        kind: 'consume',
        grantId: grant.id,
        executionId: execution.id,
      })
      const committedOutput = await commit(
        {
          ...params.ctx,
          context: params.ctx.context,
          writer: bufferedWriter,
          executionAuthorization: {
            approvalGrantId: grant.id,
            operationExecutionId: execution.id,
            transaction: tx,
          },
        },
        params.normalizedInput,
        activePlan,
      )

      const parsedOutput = params.operation.outputSchema.safeParse(committedOutput)
      if (!parsedOutput.success) {
        throw new ApiError('EXTERNAL_ERROR', {
          code: 'OPERATION_OUTPUT_INVALID',
          message: `operation output schema mismatch: ${params.operation.id}`,
          issues: parsedOutput.error.issues,
        })
      }
      const output = parsedOutput.data
      const tasks = await tx.task.findMany({
        where: { operationExecutionId: execution.id },
        select: { id: true },
      })
      const consumedGrant = await tx.approvalGrant.findUnique({
        where: { id: grant.id },
      })
      if (
        !consumedGrant?.consumedAt ||
        consumedGrant.consumedExecutionId !== execution.id ||
        tasks.length !== activePlan.tasks.length
      ) {
        throw new Error(`OPERATION_PLAN_ATOMIC_COMMIT_INCOMPLETE:${execution.id}`)
      }
      const followUpTaskIds = Array.from(
        new Set([
          ...tasks.map((task) => task.id),
          ...(activePlan.taskDependencies ?? []).map((dependency) => dependency.taskId),
        ]),
      ).sort()
      if (followUpTaskIds.length > 0) {
        await params.ctx.followUpBatchBinding?.bindInTransaction(tx, {
          operationId: params.operation.id,
          taskIds: followUpTaskIds,
        })
      }
      if (
        params.ctx.context.turnId &&
        followUpTaskIds.length > 0 &&
        (!params.ctx.followUpBatchBinding || !params.ctx.followUpBatchBinding.isBound())
      ) {
        throw new Error(`OPERATION_EXECUTION_FOLLOW_UP_BATCH_MISSING:${params.operation.id}`)
      }
      await tx.operationExecution.update({
        where: { id: execution.id },
        data: {
          status: 'completed',
          output: toJson(output),
          completedAt: new Date(),
        },
      })
      return { kind: 'output' as const, output }
    },
    {
      maxWait: 10_000,
      timeout: APPROVED_OPERATION_TRANSACTION_TIMEOUT_MS,
    },
  )
  if (transactionResult.kind === 'plan_changed') {
    throw new ApiError('OPERATION_PLAN_CHANGED', {
      code: 'OPERATION_PLAN_CHANGED',
      changedArtifacts: transactionResult.changedArtifacts,
    })
  }
  for (const part of bufferedParts) {
    params.ctx.writer?.write(part)
  }
  return transactionResult.output
}

async function loadApprovedOperationExecutionReceipt(params: {
  approvalGrantId: string
  operationRequestId: string
  userId: string
  projectId: string
  operationId: string
}): Promise<ApprovedOperationExecutionReceipt> {
  const execution = await prisma.operationExecution.findUnique({
    where: { approvalGrantId: params.approvalGrantId },
    include: { tasks: true },
  })
  if (
    !execution ||
    execution.status !== 'completed' ||
    execution.output === null ||
    execution.userId !== params.userId ||
    execution.projectId !== params.projectId ||
    execution.operationId !== params.operationId ||
    execution.approvalGrantId !== params.approvalGrantId ||
    execution.planSnapshotId === null ||
    execution.requestId !== params.operationRequestId ||
    execution.tasks.length > APPROVED_OPERATION_MAX_TASKS
  ) {
    receiptError('OPERATION_EXECUTION_RECEIPT_DIVERGED', params.approvalGrantId)
  }
  const snapshot = await loadOperationPlanSnapshot(execution.planSnapshotId)
  if (
    !snapshot ||
    snapshot.userId !== params.userId ||
    snapshot.projectId !== params.projectId ||
    snapshot.operationId !== params.operationId ||
    snapshot.plan.tasks.length !== execution.tasks.length
  ) {
    receiptError('OPERATION_EXECUTION_TASK_BATCH_DIVERGED', execution.id)
  }

  const byPlanTaskId = new Map(execution.tasks.map((task) => [task.operationPlanTaskId, task]))
  if (byPlanTaskId.has(null) || byPlanTaskId.size !== execution.tasks.length) {
    receiptError('OPERATION_EXECUTION_TASK_IDENTITY_DIVERGED', execution.id)
  }
  const orderedTasks = snapshot.plan.tasks.map((planTask) => {
    const task = byPlanTaskId.get(planTask.id)
    if (!task) {
      receiptError('OPERATION_EXECUTION_TASK_IDENTITY_DIVERGED', execution.id)
    }
    return task
  })
  const references: PersistedTaskReference[] = []
  for (const task of orderedTasks) {
    if (
      task.userId !== params.userId ||
      task.projectId !== params.projectId ||
      task.operationId !== params.operationId ||
      task.approvalGrantId !== params.approvalGrantId ||
      task.operationExecutionId !== execution.id ||
      task.operationRequestId !== params.operationRequestId ||
      !isTaskType(task.type)
    ) {
      receiptError('OPERATION_EXECUTION_TASK_RECEIPT_DIVERGED', execution.id, task.id)
    }
    const reference: PersistedTaskReference = {
      taskId: task.id,
      userId: task.userId,
      taskType: task.type,
    }
    references.push(reference)
  }
  const tasks: ApprovedOperationExecutionTaskReceipt[] = []
  for (const reference of references) {
    tasks.push({ reference, schedule: await schedulePersistedTask(reference) })
  }
  return {
    operationExecutionId: execution.id,
    approvalGrantId: params.approvalGrantId,
    operationRequestId: params.operationRequestId,
    outputHash: hashCanonicalJson(execution.output),
    tasks,
  }
}

export async function invokeApprovedOperationPlanWithReceipt<Input, Output>(params: {
  operation: ProjectAgentOperationDefinition<Input, Output>
  ctx: ProjectAgentOperationContext
  normalizedInput: Input
  invocation: PlannedOperationInvocation
}): Promise<ApprovedOperationPlanInvocationResult<Output>> {
  const output = await invokeApprovedOperationPlan({
    ...params,
  })
  return {
    output,
    receipt: await loadApprovedOperationExecutionReceipt({
      approvalGrantId: params.invocation.approvalGrantId,
      operationRequestId: params.invocation.requestId,
      userId: params.ctx.userId,
      projectId: params.ctx.projectId,
      operationId: params.operation.id,
    }),
  }
}
