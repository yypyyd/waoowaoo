import { createHash } from 'node:crypto'
import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'
import { createScopedLogger } from '@/lib/logging/core'
import { normalizeOperationExecutionToolError } from '@/lib/adapters/operation-error-normalizer'
import { formatBillingActionCost } from '@/lib/billing/action-quote-preview'
import {
  canonicalJson,
  hashCanonicalJson,
} from '@/lib/operation-plan-contract/canonical-json'
import {
  buildAgentToolEffectInputHash,
  executeAgentToolEffectTransaction,
} from '@/lib/agent-turn/tool-effect'
import {
  buildDirectOperationInvocationIdentity,
  executeApprovedTaskOperationViaTemporal,
  executeDirectTaskOperationViaTemporal,
} from '@/lib/operations/durable-dispatch'
import { invokeProjectAgentOperation } from '@/lib/operations/invocation'
import { prepareProjectAgentOperationInput } from '@/lib/operations/invocation'
import { parseOperationMutationReceipt } from '@/lib/operations/mutation-receipt'
import { createProjectAgentOperationRegistry } from '@/lib/operations/registry'
import type { PlannedOperationInvocation } from '@/lib/operations/planned-operation-invocation'
import {
  hashOperationPlanArtifacts,
  loadOperationPlanSnapshotByApiRequest,
  replaceOperationPlanSnapshotArtifacts,
} from '@/lib/operations/operation-plan-snapshot'
import { getBillingMode } from '@/lib/billing'
import { changedOperationPlanArtifacts } from '@/lib/operations/operation-plan-revalidation'
import {
  persistOperationPlanView,
  planOperation,
  quoteOperationPlan,
} from '@/lib/operations/planning'
import type { OperationPlanView } from '@/lib/operations/plan-contract'
import {
  isBillablePlannedOperation,
  type JsonObject,
  type OperationMutationReceipt,
  type ProjectAgentOperationContext,
  type ProjectAgentOperationDefinition,
  type ProjectAgentOperationRegistry,
} from '@/lib/operations/types'
import { readAssistantBillingConfirmationRequired } from '@/lib/project-agent/billing-confirmation'
import { localizeProjectAgentOperationTitle } from '@/lib/project-agent/copy'
import {
  normalizeProjectAgentLocale,
  type ProjectAgentLocale,
} from '@/lib/project-agent/locale'
import { publishOperationMutationReceipt } from '@/lib/workspace-resource/resource-change-publisher'
import type {
  WaoMcpOperationExecutor,
  WaoMcpOperationExecutorResult,
  WaoMcpExecutionLifecycle,
  WaoMcpElicitationRequest,
  WaoMcpElicitationResult,
  WaoMcpTrustedCallContext,
} from './contracts'
import {
  issueWaoMcpApprovalGrant,
  requireWaoMcpBrowserApproval,
} from './approval-proof'
import { WAO_MCP_APPROVAL_META_KEY } from './approval-contract'

const logger = createScopedLogger({ module: 'wao-mcp.production-executor' })

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toJsonObject(value: unknown): JsonObject {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error('WAO_MCP_EXECUTOR_RESULT_NOT_JSON')
  }
  const parsed: unknown = JSON.parse(serialized)
  if (!isRecord(parsed)) {
    throw new Error('WAO_MCP_EXECUTOR_RESULT_NOT_OBJECT')
  }
  return parsed as JsonObject
}

function requireIdentityPart(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'WAO_MCP_STABLE_IDENTITY_REQUIRED',
      identity: label,
    })
  }
  return normalized
}

function normalizeTrustedContext(
  context: WaoMcpTrustedCallContext,
  signal: AbortSignal,
): {
  turnId: string
  callId: string
  executionOwnerId: string
  userId: string
  projectId: string
  operationContext: ProjectAgentOperationContext
} {
  const turnId = requireIdentityPart(context.turnId, 'turnId')
  const callId = requireIdentityPart(context.callId, 'callId')
  const userId = requireIdentityPart(context.userId, 'userId')
  const projectId = requireIdentityPart(context.projectId, 'projectId')
  const source = requireIdentityPart(context.source, 'source')
  requireIdentityPart(context.threadId, 'threadId')
  return {
    turnId,
    callId,
    executionOwnerId: requireIdentityPart(
      context.executionOwnerId,
      'executionOwnerId',
    ),
    userId,
    projectId,
    operationContext: {
      request: null,
      requestId: requireIdentityPart(context.requestId, 'requestId'),
      signal,
      userId,
      projectId,
      productionConfigurationVersion: context.productionConfigurationVersion,
      context: {
        ...(context.locale?.trim() ? { locale: context.locale.trim() } : {}),
        turnId,
        canvasGenerationIntent: context.canvasGenerationIntent,
        userTurnText: context.userTurnText ?? null,
        userTurnMediaResourceIds: context.userTurnMediaResourceIds ?? [],
        selectedScopeRef: context.selectedScopeRef?.trim() || null,
        selectedAssetId: context.selectedAssetId?.trim() || null,
      },
      invocationChannel: 'tool',
      source,
      writer: null,
      toolCallId: callId,
      activityId: null,
    },
  }
}

interface StoredEffectResult {
  readonly data: unknown
  readonly mutationReceipt: OperationMutationReceipt | null
}

function parseStoredEffectResult(value: unknown): StoredEffectResult {
  if (!isRecord(value) || !('data' in value)) {
    throw new Error('WAO_MCP_TOOL_EFFECT_RESULT_INVALID')
  }
  return {
    data: value.data,
    mutationReceipt: parseOperationMutationReceipt(
      Object.prototype.hasOwnProperty.call(value, 'mutationReceipt')
        ? value.mutationReceipt
        : null,
    ),
  }
}

function failedResult(params: {
  operation: ProjectAgentOperationDefinition
  error: unknown
}): WaoMcpOperationExecutorResult {
  const error = normalizeOperationExecutionToolError({
    error: params.error,
    operationId: params.operation.id,
  })
  return {
    structuredContent: toJsonObject({ ok: false, error }),
    text: error.message,
    isError: true,
  }
}

type ExecutorCopyKey =
  | 'declined'
  | 'approvedSubmitted'
  | 'submitted'
  | 'completed'
  | 'notAvailable'

const EXECUTOR_COPY: Record<
  ProjectAgentLocale,
  Record<ExecutorCopyKey, string>
> = {
  zh: {
    declined: '操作已取消，未执行任何生产任务。',
    approvedSubmitted: '已提交获批的 Wao 操作。',
    submitted: '已提交 Wao 操作。',
    completed: 'Wao 操作已完成。',
    notAvailable: '此操作不能通过 Wao MCP 使用。',
  },
  en: {
    declined: 'The operation was cancelled and no production task was executed.',
    approvedSubmitted: 'The approved Wao operation was submitted.',
    submitted: 'The Wao operation was submitted.',
    completed: 'The Wao operation completed.',
    notAvailable: 'This operation is not available through Wao MCP.',
  },
}

function executorCopy(
  locale: string | null | undefined,
  key: ExecutorCopyKey,
): string {
  return EXECUTOR_COPY[normalizeProjectAgentLocale(locale)][key]
}

function operationDeclinedResult(
  operation: ProjectAgentOperationDefinition,
  locale: string | null | undefined,
): WaoMcpOperationExecutorResult {
  return {
    structuredContent: {
      ok: false,
      status: 'declined',
      error: {
        code: 'OPERATION_DECLINED',
        message: 'PROJECT_AGENT_OPERATION_DECLINED',
        operationId: operation.id,
      },
    },
    text: executorCopy(locale, 'declined'),
  }
}

function buildApprovalRequestId(params: {
  readonly turnId: string
  readonly callId: string
  readonly operationId: string
  readonly inputHash: string
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'wao-mcp-approval-v2',
      params.turnId,
      params.callId,
      params.operationId,
      params.inputHash,
    ]), 'utf8')
    .digest('hex')
  return `wao-mcp:${digest}`
}

function projectPersistedPlanView(
  snapshot: NonNullable<
    Awaited<ReturnType<typeof loadOperationPlanSnapshotByApiRequest>>
  >,
): OperationPlanView {
  return {
    operationId: snapshot.operationId,
    kind: snapshot.plan.kind,
    taskCount: snapshot.plan.tasks.length,
    quote: snapshot.quote,
    tasks: snapshot.plan.tasks.map((task) => ({
      id: task.id,
      taskType: task.taskType,
      targetType: task.target.targetType,
      targetId: task.target.targetId,
    })),
    planSnapshotId: snapshot.id,
    inputHash: snapshot.inputHash,
    planHash: snapshot.planHash,
    quoteHash: snapshot.quoteHash,
  }
}

function approvalElicitation(params: {
  readonly approvalRequestId: string
  readonly operationId: string
  readonly locale: string | null | undefined
  readonly plan: OperationPlanView | null
  readonly kind: 'billable' | 'destructive'
  readonly destructiveInputSummary?: string
}): WaoMcpElicitationRequest {
  const locale = normalizeProjectAgentLocale(params.locale)
  const operationTitle = localizeProjectAgentOperationTitle(params.operationId, locale)
  const planSummary = params.plan
    ? (() => {
        const quote = params.plan.quote
        const cost = quote.showCredits
          && typeof quote.totalMaxFrozenCost === 'number'
          ? formatBillingActionCost(quote.totalMaxFrozenCost)
          : null
        if (locale === 'en') {
          return cost
            ? `${String(params.plan.taskCount)} tasks (${String(quote.mediaTaskCount)} media), maximum ${cost} credits`
            : `${String(params.plan.taskCount)} tasks (${String(quote.mediaTaskCount)} media)`
        }
        return cost
          ? `${String(params.plan.taskCount)} 个任务（${String(quote.mediaTaskCount)} 个媒体任务），最高 ${cost} 积分`
          : `${String(params.plan.taskCount)} 个任务（${String(quote.mediaTaskCount)} 个媒体任务）`
      })()
    : null
  const message = locale === 'en'
    ? [
        `${operationTitle} requires your approval.`,
        planSummary ? `Plan: ${planSummary}` : null,
        params.destructiveInputSummary
          ? `Exact target: ${params.destructiveInputSummary}`
          : null,
        params.kind === 'billable'
          ? 'Approving authorizes the displayed immutable production plan and its quoted ceiling.'
          : 'Approving authorizes this destructive operation.',
      ].filter((value): value is string => Boolean(value)).join('\n')
    : [
        `${operationTitle}需要你的确认。`,
        planSummary ? `计划：${planSummary}` : null,
        params.destructiveInputSummary
          ? `精确目标：${params.destructiveInputSummary}`
          : null,
        params.kind === 'billable'
          ? '确认后将授权执行上述不可变生产计划及其报价上限。'
          : '确认后将授权执行此删除操作。',
      ].filter((value): value is string => Boolean(value)).join('\n')
  return {
    mode: 'form',
    _meta: {
      [WAO_MCP_APPROVAL_META_KEY]: params.approvalRequestId,
    },
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          title: locale === 'en' ? 'Approve this operation' : '确认执行此操作',
        },
      },
      required: ['confirmed'],
    },
  }
}

function elicitationApproved(result: WaoMcpElicitationResult): boolean {
  return result.action === 'accept' && result.content?.confirmed === true
}

async function authorizeBillableOperation(params: {
  readonly operation: ProjectAgentOperationDefinition
  readonly input: Readonly<Record<string, unknown>>
  readonly trusted: ReturnType<typeof normalizeTrustedContext>
  readonly context: WaoMcpTrustedCallContext
  readonly signal: AbortSignal
  readonly elicit: (request: WaoMcpElicitationRequest) => Promise<WaoMcpElicitationResult>
  readonly assertAuthorized: () => Promise<void>
}): Promise<PlannedOperationInvocation | null> {
  const prepared = await prepareProjectAgentOperationInput({
    channel: 'tool',
    operation: params.operation,
    context: params.trusted.operationContext,
    input: params.input,
  })
  if (prepared.invocation) {
    throw new Error(`WAO_MCP_APPROVAL_PROVENANCE_AMBIGUOUS:${params.operation.id}`)
  }
  if (!params.operation.plan || !params.operation.planContractRevision) {
    throw new Error(`WAO_MCP_OPERATION_PLAN_CONTRACT_MISSING:${params.operation.id}`)
  }
  const planContractRevision = params.operation.planContractRevision
  const inputHash = hashCanonicalJson(prepared.input)
  const approvalRequestId = buildApprovalRequestId({
    turnId: params.trusted.turnId,
    callId: params.trusted.callId,
    operationId: params.operation.id,
    inputHash,
  })
  const apiRequestContext = {
    turnId: params.trusted.turnId,
    callId: params.trusted.callId,
    locale: params.context.locale ?? null,
  }
  const replay = await loadOperationPlanSnapshotByApiRequest({
    userId: params.trusted.userId,
    projectId: params.trusted.projectId,
    operationId: params.operation.id,
    apiRequestId: approvalRequestId,
    executionContractRevision: planContractRevision,
    normalizedInput: prepared.input,
    apiRequestContext,
  })
  const view = await (async (): Promise<OperationPlanView> => {
    if (replay) {
      await params.assertAuthorized()
      const plan = await planOperation({
        operation: params.operation,
        ctx: params.trusted.operationContext,
        input: prepared.input,
      })
      await params.assertAuthorized()
      const quote = await quoteOperationPlan(plan)
      const current = hashOperationPlanArtifacts({
        normalizedInput: prepared.input,
        plan,
        quote,
      })
      const changedArtifacts = changedOperationPlanArtifacts(replay, current)
      if (changedArtifacts.length === 0) {
        return projectPersistedPlanView(replay)
      }
      const billingMode = await getBillingMode()
      if (billingMode === 'ENFORCE') {
        throw new ApiError('OPERATION_PLAN_CHANGED', {
          code: 'OPERATION_PLAN_CHANGED',
          changedArtifacts,
        })
      }
      // OFF/SHADOW: refresh the idempotent snapshot so retries after schema or
      // pricing alias changes do not loop on a stale frozen quote.
      const refreshed = await replaceOperationPlanSnapshotArtifacts({
        snapshotId: replay.id,
        plan,
        quote,
      })
      // Drop unused grants bound to the old fingerprint so the next issue
      // writes hashes that match the refreshed snapshot.
      await prisma.approvalGrant.deleteMany({
        where: {
          planSnapshotId: refreshed.id,
          consumedAt: null,
        },
      })
      return projectPersistedPlanView(refreshed)
    }
    await params.assertAuthorized()
    const plan = await planOperation({
      operation: params.operation,
      ctx: params.trusted.operationContext,
      input: prepared.input,
    })
    await params.assertAuthorized()
    return await persistOperationPlanView({
      plan,
      executionContractRevision: planContractRevision,
      normalizedInput: prepared.input,
      apiRequestId: approvalRequestId,
      apiRequestContext,
    })
  })()
  if (!view.planSnapshotId) {
    throw new Error(`WAO_MCP_OPERATION_PLAN_ID_MISSING:${params.operation.id}`)
  }
  const confirmationRequired = await readAssistantBillingConfirmationRequired(
    params.trusted.userId,
  )
  params.signal.throwIfAborted()
  if (confirmationRequired) {
    const decision = await params.elicit(approvalElicitation({
      approvalRequestId,
      operationId: params.operation.id,
      locale: params.context.locale,
      plan: view,
      kind: 'billable',
    }))
    if (!elicitationApproved(decision)) return null
    params.signal.throwIfAborted()
    await params.assertAuthorized()
    params.signal.throwIfAborted()
  }
  await params.assertAuthorized()
  const grant = await issueWaoMcpApprovalGrant({
    userId: params.trusted.userId,
    projectId: params.trusted.projectId,
    turnId: params.trusted.turnId,
    executionOwnerId: params.trusted.executionOwnerId,
    approvalRequestId,
    planSnapshotId: view.planSnapshotId,
    requireBrowserProof: confirmationRequired,
  })
  if (!grant || grant.operationId !== params.operation.id) {
    throw new Error(`WAO_MCP_APPROVAL_GRANT_DIVERGED:${params.operation.id}`)
  }
  return {
    approvalGrantId: grant.approvalGrantId,
    requestId: grant.requestId,
  }
}

async function executeOperation(params: {
  registry: ProjectAgentOperationRegistry
  operation: ProjectAgentOperationDefinition
  input: Readonly<Record<string, unknown>>
  context: WaoMcpTrustedCallContext
  signal: AbortSignal
  elicit: (request: WaoMcpElicitationRequest) => Promise<WaoMcpElicitationResult>
  assertAuthorized: () => Promise<void>
}): Promise<WaoMcpOperationExecutorResult> {
  params.signal.throwIfAborted()
  const trusted = normalizeTrustedContext(params.context, params.signal)
  let executionInput = params.input
  let destructiveApprovalVerified = params.context.destructiveApproved === true

  if (isBillablePlannedOperation(params.operation)) {
    const invocation = params.context.approvedInvocation ?? await authorizeBillableOperation({
      operation: params.operation,
      input: params.input,
      trusted,
      context: params.context,
      signal: params.signal,
      elicit: params.elicit,
      assertAuthorized: params.assertAuthorized,
    })
    if (!invocation) {
      return operationDeclinedResult(params.operation, params.context.locale)
    }
    params.signal.throwIfAborted()
    await params.assertAuthorized()
    const result = await executeApprovedTaskOperationViaTemporal({
      registry: params.registry,
      operationId: params.operation.id,
      userId: trusted.userId,
      projectId: trusted.projectId,
      source: trusted.operationContext.source,
      invocation,
      context: trusted.operationContext.context,
      origin: {
        kind: 'agent_turn',
        turnId: trusted.turnId,
        callId: trusted.callId,
      },
    })
    return {
      structuredContent: toJsonObject({ ok: true, data: result.data }),
      text: executorCopy(params.context.locale, 'approvedSubmitted'),
    }
  }

  if (
    params.operation.confirmation.kind === 'destructive'
    && params.operation.confirmation.required
  ) {
    const prepared = await prepareProjectAgentOperationInput({
      channel: 'tool',
      operation: params.operation,
      context: trusted.operationContext,
      input: params.input,
    })
    if (prepared.invocation) {
      throw new Error(`WAO_MCP_DESTRUCTIVE_PROVENANCE_AMBIGUOUS:${params.operation.id}`)
    }
    if (!isRecord(prepared.input)) {
      throw new Error(`WAO_MCP_DESTRUCTIVE_INPUT_INVALID:${params.operation.id}`)
    }
    executionInput = prepared.input
    if (params.context.destructiveApproved !== true) {
      const destructiveInputSummary = canonicalJson(prepared.input).slice(0, 1_200)
      const approvalRequestId = buildApprovalRequestId({
        turnId: trusted.turnId,
        callId: trusted.callId,
        operationId: params.operation.id,
        inputHash: hashCanonicalJson(prepared.input),
      })
      const decision = await params.elicit(approvalElicitation({
        approvalRequestId,
        operationId: params.operation.id,
        locale: params.context.locale,
        plan: null,
        kind: 'destructive',
        destructiveInputSummary,
      }))
      if (!elicitationApproved(decision)) {
        return operationDeclinedResult(params.operation, params.context.locale)
      }
      params.signal.throwIfAborted()
      await requireWaoMcpBrowserApproval({
        userId: trusted.userId,
        projectId: trusted.projectId,
        turnId: trusted.turnId,
        approvalRequestId,
      })
      params.signal.throwIfAborted()
      await params.assertAuthorized()
    }
    destructiveApprovalVerified = true
  }

  if (
    params.operation.assistantWriteAuthority?.kind
      === 'temporal_operation_execution'
  ) {
    params.signal.throwIfAborted()
    await params.assertAuthorized()
    const identity = buildDirectOperationInvocationIdentity({
      channel: 'tool',
      projectId: trusted.projectId,
      operationId: params.operation.id,
      stableSourceId: JSON.stringify([trusted.turnId, trusted.callId]),
    })
    const result = await executeDirectTaskOperationViaTemporal({
      registry: params.registry,
      channel: 'tool',
      operationId: params.operation.id,
      userId: trusted.userId,
      projectId: trusted.projectId,
      source: trusted.operationContext.source,
      context: trusted.operationContext.context,
      input: executionInput,
      ...identity,
      origin: {
        kind: 'agent_turn',
        turnId: trusted.turnId,
        callId: trusted.callId,
      },
    })
    return {
      structuredContent: toJsonObject({ ok: true, data: result.data }),
      text: executorCopy(params.context.locale, 'submitted'),
    }
  }

  if (params.operation.effects.writes) {
    params.signal.throwIfAborted()
    await params.assertAuthorized()
    const contractRevision = params.operation.toolContractRevision
    if (!contractRevision) {
      throw new Error(
        `WAO_MCP_TOOL_EFFECT_CONTRACT_REVISION_MISSING:${params.operation.id}`,
      )
    }
    const stored = parseStoredEffectResult(
      await executeAgentToolEffectTransaction({
        turnId: trusted.turnId,
        executionOwnerId: trusted.executionOwnerId,
        callId: trusted.callId,
        operationId: params.operation.id,
        contractRevision,
        inputHash: buildAgentToolEffectInputHash({
          operationId: params.operation.id,
          contractRevision,
          input: executionInput,
        }),
        execute: async (transaction) => {
          const result = await invokeProjectAgentOperation({
            registry: params.registry,
            channel: 'tool',
            operationId: params.operation.id,
            context: {
              ...trusted.operationContext,
              destructiveApprovalVerified,
            },
            input: executionInput,
            transaction,
            invocationMode: 'agent_tool_effect',
          })
          if (result.kind !== 'executed') {
            throw new Error(
              `WAO_MCP_TOOL_EFFECT_RESULT_KIND_INVALID:${params.operation.id}`,
            )
          }
          return {
            data: result.data,
            mutationReceipt: result.mutationReceipt,
          } satisfies StoredEffectResult
        },
      }),
    )
    await publishOperationMutationReceipt({
      projectId: trusted.projectId,
      userId: trusted.userId,
      receipt: stored.mutationReceipt,
    })
    return {
      structuredContent: toJsonObject({ ok: true, data: stored.data }),
      text: executorCopy(params.context.locale, 'completed'),
    }
  }

  const result = await invokeProjectAgentOperation({
    registry: params.registry,
    channel: 'tool',
    operationId: params.operation.id,
    context: trusted.operationContext,
    input: executionInput,
  })
  return {
    structuredContent: toJsonObject({ ok: true, data: result.data }),
    text: executorCopy(params.context.locale, 'completed'),
  }
}

export function createProductionWaoMcpOperationExecutor(params?: {
  readonly registry?: ProjectAgentOperationRegistry
  readonly lifecycle?: WaoMcpExecutionLifecycle
}): WaoMcpOperationExecutor {
  const registry = params?.registry ?? createProjectAgentOperationRegistry()

  return {
    async execute(call): Promise<WaoMcpOperationExecutorResult> {
      const operation = registry[call.operationId]
      if (!operation?.channels.mcp) {
        return {
          structuredContent: {
            ok: false,
            error: {
              code: 'OPERATION_NOT_ALLOWED',
              message: 'This operation is not available through Wao MCP.',
              operationId: call.operationId,
            },
          },
          text: executorCopy(call.context.locale, 'notAvailable'),
          isError: true,
        }
      }

      let lifecycleStarted = false
      try {
        await params?.lifecycle?.before(call.context)
        lifecycleStarted = true
        const result = await executeOperation({
          registry,
          operation,
          input: call.input,
          context: call.context,
          signal: call.signal,
          elicit: call.elicit,
          assertAuthorized: async () => {
            await params?.lifecycle?.assertAuthorized(call.context)
          },
        })
        try {
          await params?.lifecycle?.after(call.context)
        } catch (error) {
          logger.warn({
            action: 'wao_mcp.post_effect_refresh_failed',
            message: 'Wao MCP operation succeeded but post-effect workspace refresh failed',
            projectId: call.context.projectId,
            userId: call.context.userId,
            details: {
              operationId: call.operationId,
              turnId: call.context.turnId,
              error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
            },
          })
        }
        return result
      } catch (error) {
        if (lifecycleStarted) {
          try {
            await params?.lifecycle?.after(call.context)
          } catch (refreshError) {
            logger.warn({
              action: 'wao_mcp.failed_effect_refresh_failed',
              message: 'Wao MCP operation and post-effect workspace refresh both failed',
              projectId: call.context.projectId,
              userId: call.context.userId,
              details: {
                operationId: call.operationId,
                turnId: call.context.turnId,
                operationError: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
                refreshError: refreshError instanceof Error
                  ? refreshError.message
                  : 'UNKNOWN_ERROR',
              },
            })
          }
        }
        call.signal.throwIfAborted()
        return failedResult({ operation, error })
      }
    },
  }
}
