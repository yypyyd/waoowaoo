import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type {
  BillingQuoteView,
  OperationPlan,
  OperationPlanView,
  PlannedTask,
  PlannedTaskDependency,
} from './plan-contract'
import { assertOperationPlanTaskResourceScopes } from './operation-plan-resource-scope'
import { canonicalJson, hashCanonicalJson } from '@/lib/operation-plan-contract/canonical-json'
import { isTaskType } from '@/lib/task/types'
import { GLOBAL_ASSET_PROJECT_ID } from '@/lib/workspace-resource/resource-impact'
import { ApiError } from '@/lib/api-errors'

type OperationPlanSnapshotRow = Prisma.OperationPlanSnapshotGetPayload<Record<string, never>>

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(canonicalJson(value)) as Prisma.InputJsonValue
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:${key}`)
  }
  return value
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:${key}`)
  return value
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:${field}`)
  }
  return value as Record<string, unknown>
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:${field}`)
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:${field}.${String(index)}`)
    }
    return item
  })
}

function readOptionalArray<T>(
  value: unknown,
  field: string,
  parseItem: (item: unknown) => T,
): T[] | undefined {
  if (value === null || value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:${field}`)
  return value.map(parseItem)
}

function parsePlannedTask(value: unknown): PlannedTask {
  const record = readRecord(value, 'tasks[]')
  const target = readRecord(record.target, 'tasks[].target')
  const payload = readRecord(record.payload, 'tasks[].payload')
  const billingInfo = readRecord(record.billingInfo, 'tasks[].billingInfo') as PlannedTask['billingInfo']
  const locale = readString(record, 'locale') as PlannedTask['locale']
  return {
    id: readString(record, 'id'),
    taskType: readString(record, 'taskType') as PlannedTask['taskType'],
    target: {
      targetType: readString(target, 'targetType'),
      targetId: readString(target, 'targetId'),
    },
    payload,
    billingInfo,
    locale,
    dedupeKey: readNullableString(record, 'dedupeKey'),
  }
}

function parsePlannedTaskDependency(value: unknown): PlannedTaskDependency {
  const record = readRecord(value, 'taskDependencies[]')
  const target = readRecord(record.target, 'taskDependencies[].target')
  const taskType = readString(record, 'taskType')
  if (!isTaskType(taskType)) {
    throw new Error(`OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:taskDependencies[].taskType:${taskType}`)
  }
  return {
    taskId: readString(record, 'taskId'),
    taskType,
    target: {
      targetType: readString(target, 'targetType'),
      targetId: readString(target, 'targetId'),
    },
  }
}

function parseOperationPlan(value: unknown): OperationPlan {
  const record = readRecord(value, 'planSnapshot')
  if (record.kind !== 'task_submission') {
    throw new Error('OPERATION_PLAN_SNAPSHOT_KIND_INVALID')
  }
  if (!Array.isArray(record.tasks)) {
    throw new Error('OPERATION_PLAN_SNAPSHOT_FIELD_INVALID:tasks')
  }
  const summary = readNullableString(record, 'summary')
  const metadata = record.metadata === null || record.metadata === undefined ? undefined : readRecord(record.metadata, 'metadata')
  const reservedIdentityIds = record.reservedIdentityIds === null || record.reservedIdentityIds === undefined
    ? undefined
    : readStringArray(record.reservedIdentityIds, 'reservedIdentityIds')
  const taskDependencies = readOptionalArray(
    record.taskDependencies,
    'taskDependencies',
    parsePlannedTaskDependency,
  )
  return {
    kind: 'task_submission',
    operationId: readString(record, 'operationId'),
    projectId: readString(record, 'projectId'),
    userId: readString(record, 'userId'),
    tasks: record.tasks.map(parsePlannedTask),
    ...(taskDependencies ? { taskDependencies } : {}),
    ...(reservedIdentityIds ? { reservedIdentityIds } : {}),
    ...(summary !== null ? { summary } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

async function assertOperationPlanTaskDependencies(plan: OperationPlan): Promise<void> {
  const dependencies = plan.taskDependencies ?? []
  if (dependencies.length === 0) return
  const dependencyIds = dependencies.map((dependency) => dependency.taskId)
  if (new Set(dependencyIds).size !== dependencyIds.length) {
    throw new Error(`OPERATION_PLAN_TASK_DEPENDENCY_DUPLICATE:${plan.operationId}`)
  }
  const tasks = await prisma.task.findMany({
    where: { id: { in: dependencyIds } },
    select: {
      id: true,
      userId: true,
      projectId: true,
      type: true,
      targetType: true,
      targetId: true,
      status: true,
    },
  })
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  for (const dependency of dependencies) {
    const task = taskById.get(dependency.taskId)
    if (!task) throw new Error(`OPERATION_PLAN_TASK_DEPENDENCY_NOT_FOUND:${dependency.taskId}`)
    if (
      task.userId !== plan.userId
      || task.projectId !== plan.projectId
      || task.type !== dependency.taskType
      || task.targetType !== dependency.target.targetType
      || task.targetId !== dependency.target.targetId
    ) {
      throw new Error(`OPERATION_PLAN_TASK_DEPENDENCY_SCOPE_MISMATCH:${dependency.taskId}`)
    }
    if (task.status !== 'queued' && task.status !== 'processing') {
      throw new Error(`OPERATION_PLAN_TASK_DEPENDENCY_NOT_ACTIVE:${dependency.taskId}:${task.status}`)
    }
  }
}

export interface PersistedOperationPlanSnapshot {
  id: string
  userId: string
  scopeKind: string
  scopeId: string
  projectId: string | null
  operationId: string
  apiRequestId: string | null
  apiRequestContextHash: string | null
  executionContractRevision: string
  normalizedInput: unknown
  inputHash: string
  plan: OperationPlan
  planHash: string
  quote: BillingQuoteView
  quoteHash: string
}

export interface OperationPlanArtifactHashes {
  readonly inputHash: string
  readonly planHash: string
  readonly quoteHash: string
}

export function hashOperationPlanArtifacts(params: {
  readonly normalizedInput: unknown
  readonly plan: OperationPlan
  readonly quote: BillingQuoteView
}): OperationPlanArtifactHashes {
  return {
    inputHash: hashCanonicalJson(params.normalizedInput),
    planHash: hashCanonicalJson(params.plan),
    quoteHash: hashCanonicalJson(params.quote),
  }
}

function parsePersistedOperationPlanSnapshot(
  record: OperationPlanSnapshotRow,
): PersistedOperationPlanSnapshot {
  const plan = parseOperationPlan(record.planSnapshot)
  const quote = readRecord(record.quoteSnapshot, 'quoteSnapshot') as unknown as BillingQuoteView
  if (hashCanonicalJson(record.normalizedInput) !== record.inputHash) {
    throw new Error(`OPERATION_PLAN_INPUT_HASH_MISMATCH:${record.id}`)
  }
  if (hashCanonicalJson(record.planSnapshot) !== record.planHash) {
    throw new Error(`OPERATION_PLAN_HASH_MISMATCH:${record.id}`)
  }
  if (hashCanonicalJson(record.quoteSnapshot) !== record.quoteHash) {
    throw new Error(`OPERATION_QUOTE_HASH_MISMATCH:${record.id}`)
  }
  if (
    (record.apiRequestId === null) !== (record.apiRequestContextHash === null)
  ) {
    throw new Error(`OPERATION_PLAN_API_REQUEST_CONTEXT_INVALID:${record.id}`)
  }
  return {
    id: record.id,
    userId: record.userId,
    scopeKind: record.scopeKind,
    scopeId: record.scopeId,
    projectId: record.projectId,
    operationId: record.operationId,
    apiRequestId: record.apiRequestId,
    apiRequestContextHash: record.apiRequestContextHash,
    executionContractRevision: readString(record, 'executionContractRevision'),
    normalizedInput: record.normalizedInput,
    inputHash: record.inputHash,
    plan,
    planHash: record.planHash,
    quote,
    quoteHash: record.quoteHash,
  }
}

function assertApiRequestReplayMatches(params: {
  readonly snapshot: PersistedOperationPlanSnapshot
  readonly executionContractRevision: string
  readonly inputHash: string
  readonly apiRequestContextHash?: string
  readonly planHash?: string
  readonly quoteHash?: string
}): void {
  const snapshot = params.snapshot
  if (
    snapshot.executionContractRevision !== params.executionContractRevision
    || snapshot.inputHash !== params.inputHash
    || (
      params.apiRequestContextHash !== undefined
      && snapshot.apiRequestContextHash !== params.apiRequestContextHash
    )
    || (params.planHash !== undefined && snapshot.planHash !== params.planHash)
    || (params.quoteHash !== undefined && snapshot.quoteHash !== params.quoteHash)
  ) {
    throw new ApiError('CONFLICT', {
      code: 'OPERATION_PLAN_REQUEST_REPLAY_DIVERGED',
      operationId: snapshot.operationId,
    })
  }
}

export async function loadOperationPlanSnapshotByApiRequest(params: {
  readonly userId: string
  readonly projectId: string
  readonly operationId: string
  readonly apiRequestId: string
  readonly executionContractRevision: string
  readonly normalizedInput: unknown
  readonly apiRequestContext: unknown
}): Promise<PersistedOperationPlanSnapshot | null> {
  const apiRequestId = params.apiRequestId.trim()
  if (!apiRequestId || apiRequestId.length > 128) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'OPERATION_IDEMPOTENCY_KEY_INVALID',
      header: 'Idempotency-Key',
    })
  }
  const record = await prisma.operationPlanSnapshot.findFirst({
    where: {
      userId: params.userId,
      scopeKind: 'project',
      scopeId: params.projectId,
      projectId: params.projectId,
      operationId: params.operationId,
      apiRequestId,
    },
  })
  if (!record) return null
  const snapshot = parsePersistedOperationPlanSnapshot(record)
  assertApiRequestReplayMatches({
    snapshot,
    executionContractRevision: params.executionContractRevision,
    inputHash: hashCanonicalJson(params.normalizedInput),
    apiRequestContextHash: hashCanonicalJson(params.apiRequestContext),
  })
  return snapshot
}

export async function persistOperationPlanSnapshot(params: {
  plan: OperationPlan
  executionContractRevision: string
  normalizedInput: unknown
  quote: BillingQuoteView
  apiRequestId?: string | null
  apiRequestContext?: unknown
}): Promise<PersistedOperationPlanSnapshot> {
  const executionContractRevision = params.executionContractRevision.trim()
  if (!executionContractRevision) {
    throw new Error(`OPERATION_PLAN_EXECUTION_CONTRACT_REVISION_MISSING:${params.plan.operationId}`)
  }
  assertOperationPlanTaskResourceScopes(params.plan)
  await assertOperationPlanTaskDependencies(params.plan)
  const scopeKind = params.plan.projectId === GLOBAL_ASSET_PROJECT_ID ? 'global_asset_hub' : 'project'
  const scopeId = params.plan.projectId
  const apiRequestId = params.apiRequestId?.trim() || null
  if (apiRequestId && apiRequestId.length > 128) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'OPERATION_IDEMPOTENCY_KEY_INVALID',
      header: 'Idempotency-Key',
    })
  }
  const normalizedInput = toInputJson(params.normalizedInput)
  const apiRequestContextHash = apiRequestId
    ? hashCanonicalJson(params.apiRequestContext ?? {})
    : null
  const planSnapshot = toInputJson(params.plan)
  const quoteSnapshot = toInputJson(params.quote)
  const { inputHash, planHash, quoteHash } = hashOperationPlanArtifacts({
    normalizedInput,
    plan: params.plan,
    quote: params.quote,
  })
  const snapshotData = {
    id: randomUUID(),
    userId: params.plan.userId,
    scopeKind,
    scopeId,
    projectId: scopeKind === 'project' ? params.plan.projectId : null,
    operationId: params.plan.operationId,
    apiRequestId,
    apiRequestContextHash,
    executionContractRevision,
    normalizedInput,
    inputHash,
    planSnapshot,
    planHash,
    quoteSnapshot,
    quoteHash,
  }
  try {
    const created = await prisma.operationPlanSnapshot.create({ data: snapshotData })
    return parsePersistedOperationPlanSnapshot(created)
  } catch (error) {
    if (
      !apiRequestId
      || !(error instanceof Prisma.PrismaClientKnownRequestError)
      || error.code !== 'P2002'
    ) {
      throw error
    }
    const record = await prisma.operationPlanSnapshot.findFirst({
      where: {
        userId: params.plan.userId,
        scopeKind,
        scopeId,
        operationId: params.plan.operationId,
        apiRequestId,
      },
    })
    if (!record) throw error
    const snapshot = parsePersistedOperationPlanSnapshot(record)
    assertApiRequestReplayMatches({
      snapshot,
      executionContractRevision,
      inputHash,
      ...(apiRequestContextHash ? { apiRequestContextHash } : {}),
      planHash,
      quoteHash,
    })
    return snapshot
  }
}


export async function replaceOperationPlanSnapshotArtifacts(params: {
  readonly snapshotId: string
  readonly plan: OperationPlan
  readonly quote: BillingQuoteView
  readonly client?: Prisma.TransactionClient
}): Promise<PersistedOperationPlanSnapshot> {
  const client = params.client ?? prisma
  assertOperationPlanTaskResourceScopes(params.plan)
  await assertOperationPlanTaskDependencies(params.plan)
  const planSnapshot = toInputJson(params.plan)
  const quoteSnapshot = toInputJson(params.quote)
  const planHash = hashCanonicalJson(params.plan)
  const quoteHash = hashCanonicalJson(params.quote)
  const updated = await client.operationPlanSnapshot.update({
    where: { id: params.snapshotId },
    data: {
      planSnapshot,
      planHash,
      quoteSnapshot,
      quoteHash,
    },
  })
  return parsePersistedOperationPlanSnapshot(updated)
}
type OperationPlanSnapshotReader = Pick<Prisma.TransactionClient, 'operationPlanSnapshot'>

export async function loadOperationPlanSnapshot(
  id: string,
  client: OperationPlanSnapshotReader = prisma,
): Promise<PersistedOperationPlanSnapshot | null> {
  const record = await client.operationPlanSnapshot.findUnique({
    where: { id },
  })
  if (!record) return null
  return parsePersistedOperationPlanSnapshot(record)
}

export function attachPersistedPlanIdentity(view: OperationPlanView, snapshot: PersistedOperationPlanSnapshot): OperationPlanView {
  return {
    ...view,
    planSnapshotId: snapshot.id,
    inputHash: snapshot.inputHash,
    planHash: snapshot.planHash,
    quoteHash: snapshot.quoteHash,
  }
}
