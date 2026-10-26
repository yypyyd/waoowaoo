import { assertCanvasGenerationIntentItems, assertCanvasGenerationIntentOptions, assertCanvasGenerationIntentMode } from '@/lib/workspace-resource/canvas-generation-intent'
import { projectReferenceDurationLimits, validateGenerationReferenceDurations } from '@/lib/ai-registry/generation-reference-duration'
import { validateGenerationReferences } from '@/lib/ai-registry/generation-reference-policy'
import { z } from 'zod'
import {
  resolveModelCapabilityGenerationOptions,
} from '@/lib/config-service'
import { assertProductionConfigurationVersion, readProductionPlanningContext } from '@/lib/project-production-context'
import { AiOptionValidationError } from '@/lib/ai-exec/normalize'
import {
  preflightMediaGenerationOptions,
  preflightMediaProviderRoutes,
} from '@/lib/ai-exec/media-preflight'
import {
  MediaInputTransportUnsupportedError,
  type ProviderMediaInputKind,
} from '@/lib/ai-exec/media-input-transport'
import { resolveBuiltinCapabilitiesByModelKey } from '@/lib/ai-registry/capabilities-catalog'
import type { CapabilitySelections, CapabilityValue } from '@/lib/ai-registry/types'
import { ApiError } from '@/lib/api-errors'
import { OUTBOUND_AUDIO_POLICY } from '@/lib/media/outbound-audio'
import { OUTBOUND_VIDEO_POLICY } from '@/lib/media/outbound-video'
import { OwnedMediaOutboundError, resolveOwnedMediaForGeneration } from '@/lib/media/outbound-owned-media'
import { getAssetImageFormatPolicy } from '@/lib/asset-generation'
import {
  readCreativeOutputDefinition,
  readCreativeOutputKind,
  safeParseCreativeOutput,
} from '@/lib/creative-skills/output-registry'
import type {
  WorkspaceResourceInputRef,
  WorkspaceResourceJsonValue,
  WorkspaceResourceMediaType,
} from '@/lib/workspace-resource/contracts'
import {
  workspaceResourceGenerationOptionsSchema,
  parseWorkspaceResourceGenerationRetrySource,
  parseWorkspaceResourceGenerationTaskPayload,
  type WorkspaceResourceGenerationTaskPayload,
} from '@/lib/workspace-resource/generation-contract'
import {
  audioGenerationBatchSchema,
  generationReferenceSchema,
  imageGenerationBatchSchema,
  stripAssetImageAspectRatio,
  videoGenerationBatchSchema,
  videoGenerationItemSchema,
  videoGenerationRevisionBatchSchema,
  type GenerationItem,
} from '@/lib/workspace-resource/generation-request'
import { buildWorkspaceResourceId } from '@/lib/workspace-resource/identity'
import {
  assertUniqueWorkspaceResourcePaths,
  workspaceResourceDisplayName,
} from '@/lib/workspace-resource/path'
import {
  bindWorkspaceResourceTasksInTransaction,
  createWorkspaceResourceFolderInTransaction,
  materializeWorkspaceResourceInTransaction,
  reserveWorkspaceResourceInTransaction,
  resolveGeneratedWorkspaceResourcePlacement,
  resolveSavedWorkspaceDocumentPlacement,
  resolveWorkspaceResourceInputs,
  retryWorkspaceResourcesInTransaction,
} from '@/lib/workspace-resource/persistence'
import {
  WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA,
  WORKSPACE_RESOURCE_SCHEMA,
  requireWorkspaceResourceSchema,
} from '@/lib/workspace-resource/schema-registry'
import { buildWorkspaceResourceLifecycleProjection } from '@/lib/workspace-resource/task-runtime-envelope'
import { defineOperation } from '@/lib/operations/define-operation'
import { resolveOperationLocale } from '@/lib/operations/environment-input'
import {
  PROJECT_VIDEO_RATIO_METADATA_KEY,
  PROJECT_VIDEO_RATIO_REQUIRED_METADATA_KEY,
  projectVideoRatioSnapshotSchema,
  readProjectVideoRatioSnapshot,
  type ProjectVideoRatioSnapshot,
} from '@/lib/operations/project-video-ratio-policy'
import {
  createPlannedTask,
  requirePlannedTaskBillingInfo,
  submitPlannedOperationTasks,
} from '@/lib/operations/planning'
import type { OperationPlan, PlannedTask } from '@/lib/operations/plan-contract'
import type {
  ProjectAgentOperationContext,
  ProjectAgentOperationRegistryDraft,
} from '@/lib/operations/types'
import { prisma } from '@/lib/prisma'
import { stableArgsFingerprint, stableArgsHash } from '@/lib/project-agent/stable-args-hash'
import { TASK_TYPE, type TaskType } from '@/lib/task/types'
import { OPERATION_EXECUTION_MAX_TASKS } from '@/lib/temporal/operation-execution/contracts'
import { requireProductionModel } from '@/lib/model-access/production-model'
import { resolveWorkspaceResourceInputMedia } from '@/lib/workspace-resource/input-media'
import { AppError } from '@/lib/errors/app-error'
import { augmentFailureRecord } from '@/lib/errors/failure'
import { normalizeAnyError } from '@/lib/errors/normalize'
import {
  musicCompositionPlanDurationMs,
  musicCompositionPlanSchema,
} from '@/lib/music/composition-plan'
import {
  musicScoreCueEndMs,
  musicScoreGenerationOptionsSchema,
  type MusicScoreGenerationOptions,
} from '@/lib/music/score-specification'

const MAX_BATCH_ITEMS = OPERATION_EXECUTION_MAX_TASKS
const MEDIA_GENERATION_PLAN_CONTRACT_REVISION = 'workspace-resource-generation-batch/v10'

const workspaceResourceJsonValueSchema: z.ZodType<WorkspaceResourceJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(workspaceResourceJsonValueSchema),
  z.record(z.string(), workspaceResourceJsonValueSchema),
]))

const retryMediaRequestSchema = z.object({
  kind: z.literal('retry'),
  resourceIds: z.array(z.string().trim().min(1).max(32)).min(1).max(MAX_BATCH_ITEMS),
}).strict()

function requireUniqueRetryResourceIds(value: { request: { kind: string; resourceIds?: string[] } }, context: z.RefinementCtx): void {
  if (value.request.kind === 'retry' && value.request.resourceIds
    && new Set(value.request.resourceIds).size !== value.request.resourceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['request', 'resourceIds'],
      message: 'resourceIds must be unique',
    })
  }
}

const imageMediaRequestSchema = z.object({
  request: z.union([imageGenerationBatchSchema, retryMediaRequestSchema]),
}).strict().superRefine(requireUniqueRetryResourceIds)
const audioMediaRequestSchema = z.object({
  request: z.union([audioGenerationBatchSchema, retryMediaRequestSchema]),
}).strict().superRefine(requireUniqueRetryResourceIds)
const videoMediaRequestSchema = z.object({
  request: z.union([
    videoGenerationBatchSchema,
    videoGenerationRevisionBatchSchema,
    retryMediaRequestSchema,
  ]),
}).strict().superRefine(requireUniqueRetryResourceIds)

const rerunFailedItemsInputSchema = z.object({
  resourceIds: z.array(z.string().trim().min(1).max(32)).min(1).max(MAX_BATCH_ITEMS),
  maxBudgetCredits: z.number().finite().positive().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.resourceIds).size !== value.resourceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resourceIds'], message: 'resourceIds must be unique' })
  }
})

const saveProjectDocumentInputSchema = z.object({
  folderPath: z.string().trim().min(1).max(512).nullable().optional()
    .describe('Optional project-relative destination folder. Missing folders are created atomically with the saved document.'),
  name: z.string().trim().min(1).max(300),
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string().max(4 * 1024 * 1024) }).strict(),
    z.object({ kind: z.literal('structured'), data: workspaceResourceJsonValueSchema }).strict(),
  ]),
  references: z.array(generationReferenceSchema).max(16).optional(),
}).strict()

const textOutputSchema = z.object({
  success: z.literal(true),
  resourceId: z.string().min(1),
  contentVersion: z.number().int().positive(),
  workspacePath: z.string().min(1),
}).strict()

const mediaOutputSchema = z.object({
  success: z.literal(true),
  async: z.literal(true),
  taskId: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1),
  resources: z.array(z.object({
    resourceId: z.string().min(1),
    workspacePath: z.string().min(1),
    memberIndex: z.number().int().nonnegative(),
  }).strict()).min(1),
}).passthrough()

type NewMediaRequest =
  | z.infer<typeof imageGenerationBatchSchema>
  | z.infer<typeof audioGenerationBatchSchema>
  | z.infer<typeof videoGenerationBatchSchema>

type PlannedResource = {
  readonly resourceId: string
  readonly workspacePath: string
  readonly folderPath: string | null
  readonly mediaType: Exclude<WorkspaceResourceMediaType, 'text'>
  readonly schemaId: string
  readonly memberIndex: number
  readonly taskPlanId: string
  readonly alternatives: boolean
  readonly usesProjectVideoRatio: boolean
}

const productionPlanMetadataSchema = z.object({
  requestId: z.string().min(1),
  retry: z.boolean(),
  resources: z.array(z.object({
    resourceId: z.string().min(1),
    workspacePath: z.string().min(1),
    folderPath: z.string().min(1).nullable(),
    mediaType: z.enum(['image', 'audio', 'video']),
    schemaId: z.string().min(1),
    memberIndex: z.number().int().nonnegative(),
    taskPlanId: z.string().min(1),
    alternatives: z.boolean(),
    usesProjectVideoRatio: z.boolean(),
  }).strict()).min(1),
  [PROJECT_VIDEO_RATIO_REQUIRED_METADATA_KEY]: z.boolean(),
  [PROJECT_VIDEO_RATIO_METADATA_KEY]: projectVideoRatioSnapshotSchema.optional(),
}).strict()

const MEDIA_EFFECTS = {
  writes: true,
  workspaceResourceImpact: 'none',
  billable: true,
  destructive: false,
  overwrite: false,
  bulk: true,
  externalSideEffects: true,
  longRunning: true,
} as const

function schemaForMedia(mediaType: PlannedResource['mediaType'], schemaId: string): string {
  const resolved = schemaId.trim()
  if (!resolved) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'WORKSPACE_RESOURCE_GENERATION_SCHEMA_REQUIRED',
      field: 'schemaId',
      mediaType,
    })
  }
  const schema = requireWorkspaceResourceSchema(resolved)
  if (schema.mediaType !== mediaType || !WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA[mediaType].includes(schema.schemaId)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'WORKSPACE_RESOURCE_GENERATION_SCHEMA_INVALID',
      field: 'schemaId',
      mediaType,
    })
  }
  return resolved
}

function providerPositions(
  references: readonly z.infer<typeof generationReferenceSchema>[],
  channel: 'image' | 'audio' | 'video',
): number[] {
  return references.flatMap((reference, position) => (
    reference.channel === channel ? [position] : []
  ))
}

function providerPlaceholderUrls(count: number, mediaType: 'image' | 'audio' | 'video'): string[] {
  return Array.from({ length: count }, (_, index) => (
    `https://preflight.invalid/${mediaType}/${String(index + 1)}`
  ))
}

function providerTransportPreflightOptions(input: {
  readonly mediaType: PlannedResource['mediaType']
  readonly options: Readonly<Record<string, unknown>>
  readonly imageCount: number
  readonly referenceImageCount: number
  readonly audioCount: number
  readonly videoCount: number
  readonly usesLastFrame: boolean
  readonly durationSeconds: number | null
}): Record<string, unknown> {
  return {
    ...input.options,
    ...(input.mediaType === 'image' && input.imageCount > 0
      ? { referenceImages: providerPlaceholderUrls(input.imageCount, 'image') }
      : {}),
    ...(input.mediaType === 'video' && input.referenceImageCount > 0
      ? { referenceImages: providerPlaceholderUrls(input.referenceImageCount, 'image') }
      : {}),
    ...(input.mediaType === 'video' && input.usesLastFrame
      ? { lastFrameImageUrl: providerPlaceholderUrls(1, 'image')[0] }
      : {}),
    ...(input.mediaType === 'video' && input.audioCount > 0
      ? { referenceAudios: providerPlaceholderUrls(input.audioCount, 'audio') }
      : {}),
    ...(input.mediaType === 'video' && input.videoCount > 0
      ? { referenceVideos: providerPlaceholderUrls(input.videoCount, 'video') }
      : {}),
  }
}

function providerMediaInputKinds(input: {
  readonly imageCount: number
  readonly audioCount: number
  readonly videoCount: number
}): ProviderMediaInputKind[] {
  return [
    ...(input.imageCount > 0 ? ['image' as const] : []),
    ...(input.audioCount > 0 ? ['audio' as const] : []),
    ...(input.videoCount > 0 ? ['video' as const] : []),
  ]
}

function frozenScalarOptions(value: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {}
  for (const [key, option] of Object.entries(value ?? {})) {
    if (
      typeof option === 'string'
      || typeof option === 'number'
      || typeof option === 'boolean'
      || option === null
    ) {
      result[key] = option
    }
  }
  return result
}

function throwMediaPreflightError(
  error: unknown,
  input: {
    readonly mediaType: PlannedResource['mediaType']
    readonly modelKey?: string
    readonly aspectRatio?: string | null
    readonly ratioOwner?: 'project' | 'asset' | 'item' | null
  },
): never {
  if (error instanceof ApiError || error instanceof AppError) throw error
  if (error instanceof MediaInputTransportUnsupportedError) {
    throw new ApiError('MEDIA_INPUT_TRANSPORT_UNSUPPORTED', {
      provider: error.provider,
      mediaType: input.mediaType,
      mediaKind: error.mediaKind,
      transport: error.transport,
    }, { cause: error })
  }
  if (error instanceof AiOptionValidationError) {
    if (error.field === 'aspectRatio' && input.aspectRatio && input.modelKey) {
      if (input.ratioOwner === 'project') {
        throw new ApiError('INVALID_PARAMS', {
          code: 'PROJECT_VIDEO_RATIO_UNSUPPORTED_BY_MODEL',
          field: 'videoRatio',
          value: input.aspectRatio,
          modelKey: input.modelKey,
          correction: {
            interaction: 'codex_request_user_input',
            commitmentOperationId: 'update_project_config',
            commitmentInputField: 'videoRatio',
          },
          agentRetryableAfterCorrection: true,
        }, { cause: error })
      }
      if (input.ratioOwner === 'asset') {
        throw new ApiError('INVALID_PARAMS', {
          code: 'ASSET_IMAGE_RATIO_UNSUPPORTED_BY_MODEL',
          field: 'modelKey',
          value: input.aspectRatio,
          modelKey: input.modelKey,
        }, { cause: error })
      }
      if (input.ratioOwner === 'item') {
        throw new ApiError('INVALID_PARAMS', {
          code: 'MEDIA_ASPECT_RATIO_UNSUPPORTED_BY_MODEL',
          field: 'options.aspectRatio',
          value: input.aspectRatio,
          modelKey: input.modelKey,
          agentRetryableAfterCorrection: true,
        }, { cause: error })
      }
    }
    throw new ApiError('INVALID_PARAMS', {
      code: 'MEDIA_GENERATION_OPTION_INVALID',
      field: error.field ?? 'generation',
      reason: error.reason ?? error.failure,
      mediaType: input.mediaType,
    }, { cause: error })
  }
  throw ApiError.fromFailure(augmentFailureRecord(normalizeAnyError(error), {
    details: {
      reasonCode: 'MEDIA_GENERATION_PREFLIGHT_FAILED',
      field: input.mediaType,
      mediaType: input.mediaType,
    },
    context: {
      system: 'application',
      phase: 'media_preflight',
    },
    message: 'Workspace media generation preflight failed',
  }), error)
}

function validateReferenceCapabilities(input: {
  readonly mediaType: PlannedResource['mediaType']
  readonly modelKey: string
  readonly references: readonly z.infer<typeof generationReferenceSchema>[]
}): void {
  const imageReferences = input.references.filter((reference) => reference.channel === 'image')
  const audioReferences = input.references.filter((reference) => reference.channel === 'audio')
  const videoReferences = input.references.filter((reference) => reference.channel === 'video')

  if (input.mediaType === 'video' || input.mediaType === 'image') {
    const capabilities = resolveBuiltinCapabilitiesByModelKey(input.mediaType, input.modelKey)
    const video = capabilities?.video
    if (input.mediaType === 'image' && capabilities?.image?.maxReferenceImages === undefined) return
    const issue = validateGenerationReferences({
      mediaType: input.mediaType,
      references: input.references,
      limits: {
        maxReferenceImages: input.mediaType === 'image' ? capabilities?.image?.maxReferenceImages ?? 0 : video?.maxReferenceImages ?? 0,
        maxReferenceAudios: video?.maxReferenceAudios ?? 0,
        maxReferenceVideos: video?.maxReferenceVideos ?? 0,
        maxReferenceFiles: video?.maxReferenceFiles ?? 0,
        referenceAudioRequiresVisual: video?.referenceAudioRequiresVisual === true,
        supportedInputModes: video?.supportedInputModes ?? [],
      },
    })
    if (issue) throw new ApiError('INVALID_PARAMS', { ...issue })
  }

  if (input.mediaType === 'audio') {
    const timelineReferences = input.references.filter((reference) => (
      reference.channel === 'context' && reference.role === 'score_timeline'
    ))
    if (
      timelineReferences.length !== 1
      || imageReferences.length > 0
      || audioReferences.length > 0
      || videoReferences.length > 0
      || input.references.length !== 1
    ) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'MUSIC_SCORE_TIMELINE_REFERENCE_INVALID',
        field: 'references',
      })
    }
  }
}

function validateMusicCompositionCapability(input: {
  readonly modelKey: string
  readonly compositionPlan: z.infer<typeof musicCompositionPlanSchema>
}): void {
  const music = resolveBuiltinCapabilitiesByModelKey('music', input.modelKey)?.music
  const limits = music?.compositionPlan
  if (!music?.generationModes?.includes('composition_plan') || !limits) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MUSIC_COMPOSITION_PLAN_UNSUPPORTED',
      field: 'compositionPlan',
      modelKey: input.modelKey,
    })
  }
  const durationMs = musicCompositionPlanDurationMs(input.compositionPlan)
  const invalidChunk = input.compositionPlan.chunks.find((chunk) => (
    chunk.durationMs < limits.minChunkDurationMs
    || chunk.durationMs > limits.maxChunkDurationMs
    || chunk.positiveStyles.length > limits.maxPositiveStyles
    || chunk.negativeStyles.length > limits.maxNegativeStyles
    || !limits.contextAdherenceOptions.includes(chunk.contextAdherence)
  ))
  if (
    input.compositionPlan.chunks.length > limits.maxChunks
    || durationMs < limits.minPlanDurationMs
    || durationMs > limits.maxPlanDurationMs
    || invalidChunk
  ) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MUSIC_COMPOSITION_PLAN_CAPABILITY_EXCEEDED',
      field: 'compositionPlan',
      modelKey: input.modelKey,
    })
  }
}

async function validateFrozenMusicScoreTimeline(input: {
  readonly ctx: ProjectAgentOperationContext
  readonly references: readonly WorkspaceResourceInputRef[]
  readonly specification: MusicScoreGenerationOptions
}): Promise<void> {
  const timelineReference = input.references.find((reference) => (
    reference.position === input.specification.timelineInputPosition
    && reference.role === 'score_timeline'
  ))
  if (!timelineReference || input.references.length !== 1) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MUSIC_SCORE_TIMELINE_REFERENCE_INVALID',
      field: 'references',
    })
  }
  const [timeline] = await resolveWorkspaceResourceInputMedia({
    userId: input.ctx.userId,
    projectId: input.ctx.projectId,
    references: [timelineReference],
    expectedMediaType: 'video',
  })
  if (!timeline || timeline.durationMs === null) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MUSIC_SCORE_TIMELINE_DURATION_UNKNOWN',
      field: 'references',
      resourceId: timelineReference.resourceId,
      contentVersion: timelineReference.contentVersion,
    })
  }
  const cueEndMs = musicScoreCueEndMs(input.specification)
  if (cueEndMs > timeline.durationMs) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MUSIC_SCORE_CUE_EXCEEDS_TIMELINE',
      field: 'startMs',
      cueEndMs,
      timelineDurationMs: timeline.durationMs,
      resourceId: timelineReference.resourceId,
      contentVersion: timelineReference.contentVersion,
    })
  }
}

async function validateReferenceMediaCapabilities(input: {
  readonly ctx: ProjectAgentOperationContext
  readonly mediaType: PlannedResource['mediaType']
  readonly modelKey: string
  readonly publicReferences: readonly z.infer<typeof generationReferenceSchema>[]
  readonly frozenReferences: readonly WorkspaceResourceInputRef[]
}): Promise<void> {
  if (input.mediaType !== 'video') return
  const capabilities = resolveBuiltinCapabilitiesByModelKey('video', input.modelKey)?.video
  for (const [channel, minimumDurationMs, maximumDurationMs, maximumTotalDurationMs] of [
    ['audio', capabilities?.minReferenceAudioDurationMs, capabilities?.maxReferenceAudioDurationMs, capabilities?.maxTotalReferenceAudioDurationMs],
    ['video', capabilities?.minReferenceVideoDurationMs, capabilities?.maxReferenceVideoDurationMs, capabilities?.maxTotalReferenceVideoDurationMs],
  ] as const) {
    const positions = new Set(providerPositions(input.publicReferences, channel))
    const references = input.frozenReferences.filter((reference) => positions.has(reference.position))
    if (references.length === 0) continue
    const resolved = await resolveWorkspaceResourceInputMedia({
      userId: input.ctx.userId,
      projectId: input.ctx.projectId,
      references,
      expectedMediaType: channel,
    })
    const durationIssue = validateGenerationReferenceDurations(channel, projectReferenceDurationLimits(capabilities ?? {})[channel], resolved)
    if (durationIssue) throw new ApiError('INVALID_PARAMS', { ...durationIssue, agentRetryableAfterCorrection: true })
    let totalBytes = 0
    const codePrefix = `VIDEO_MODEL_REFERENCE_${channel.toUpperCase()}`
    const policy = channel === 'audio' ? OUTBOUND_AUDIO_POLICY : OUTBOUND_VIDEO_POLICY
    const supportedMimeTypes = channel === 'video' && capabilities?.referenceVideoMimeTypes
      ? new Set(capabilities.referenceVideoMimeTypes.filter((mimeType) => policy.supportedMimeTypes.has(mimeType)))
      : policy.supportedMimeTypes
    for (const reference of resolved) {
      const details = {
        field: 'references',
        resourceId: reference.reference.resourceId,
        contentVersion: reference.reference.contentVersion,
        ...(minimumDurationMs !== undefined ? { minimumDurationMs } : {}),
        ...(maximumDurationMs !== undefined ? { maximumDurationMs } : {}),
        ...(maximumTotalDurationMs !== undefined ? { maximumTotalDurationMs } : {}),
        agentRetryableAfterCorrection: true,
      }
      try {
        const media = await resolveOwnedMediaForGeneration(reference.storageKey, input.ctx.userId, {
          ...policy, supportedMimeTypes,
        })
        totalBytes += media.sizeBytes
      } catch (error) {
        if (error instanceof OwnedMediaOutboundError && [
          'OWNED_MEDIA_EMPTY', 'OWNED_MEDIA_SIZE_EXCEEDED', 'OWNED_MEDIA_FORMAT_UNSUPPORTED',
        ].includes(error.code)) {
          throw new ApiError('INVALID_PARAMS', {
            ...details, code: error.code, supportedMimeTypes: [...supportedMimeTypes], maxBytes: policy.maxBytes,
          })
        }
        throw error
      }
    }
    if (channel === 'video' && capabilities?.maxTotalReferenceVideoBytes !== undefined
      && totalBytes >= capabilities.maxTotalReferenceVideoBytes) {
      throw new ApiError('INVALID_PARAMS', {
        code: `${codePrefix}_TOTAL_SIZE_EXCEEDED`, field: 'references',
        actualTotalBytes: totalBytes, maximumTotalBytes: capabilities.maxTotalReferenceVideoBytes,
        agentRetryableAfterCorrection: true,
      })
    }
  }
}

type GenerationAspectRatioOwner = 'project' | 'asset' | 'item' | null

/**
 * The frame ratio has exactly one owner per item: the asset format policy for
 * reusable asset images, the item's explicit request, or the project frame.
 */
function resolveGenerationAspectRatioOwner(item: GenerationItem): GenerationAspectRatioOwner {
  if (item.mediaType === 'audio') return null
  if (item.mediaType === 'image' && item.assetKind !== null) return 'asset'
  return item.options?.aspectRatio ? 'item' : 'project'
}

/** The frame ratio is resolved by its owner; it never enters model option resolution as a runtime selection. */
function providerRuntimeSelections(
  options: Record<string, CapabilityValue | undefined> | undefined,
): Record<string, CapabilityValue> | undefined {
  if (!options) return undefined
  const selections: Record<string, CapabilityValue> = {}
  for (const [key, value] of Object.entries(options)) {
    if (key === 'aspectRatio' || value === undefined) continue
    selections[key] = value
  }
  return selections
}

async function compileMediaExecution(input: {
  readonly ctx: ProjectAgentOperationContext
  readonly fixedParameters: CapabilitySelections
  readonly item: GenerationItem
  readonly aspectRatio: string | null
  readonly schemaId: string
  readonly modelKey: string
  readonly references: readonly z.infer<typeof generationReferenceSchema>[]
}): Promise<{
  readonly prompt: string | null
  readonly generationOptions: z.infer<typeof workspaceResourceGenerationOptionsSchema>
}> {
  const { item, modelKey } = input
  const aspectRatio = input.aspectRatio
  const prompt = item.mediaType === 'audio' ? null : item.prompt

  try {
    let requested: Record<string, CapabilityValue>
    if (item.mediaType === 'image') {
      const configured = resolveModelCapabilityGenerationOptions({
        capabilityDefaults: input.fixedParameters,
        modelType: 'image',
        modelKey,
        runtimeSelections: providerRuntimeSelections(item.options),
      })
      requested = {
        ...configured,
        ...(aspectRatio ? { aspectRatio } : {}),
      }
    } else if (item.mediaType === 'video') {
      const generationMode = input.references.some((reference) => reference.role === 'last_frame')
        ? 'firstlastframe'
        : 'normal'
      const configured = resolveModelCapabilityGenerationOptions({
        capabilityDefaults: input.fixedParameters,
        modelType: 'video',
        modelKey,
        runtimeSelections: {
          ...providerRuntimeSelections(item.options),
          duration: item.durationSeconds,
          generationMode,
        },
      })
      const providerConfigured = { ...configured }
      delete providerConfigured.generationMode
      requested = {
        ...providerConfigured,
        duration: item.durationSeconds,
        ...(aspectRatio ? { aspectRatio } : {}),
      }
    } else {
      validateMusicCompositionCapability({
        modelKey,
        compositionPlan: item.compositionPlan,
      })
      requested = {
        outputFormat: 'mp3',
      }
    }

    const imageCount = input.references.filter((reference) => reference.channel === 'image').length
    const referenceImageCount = item.mediaType === 'video'
      ? input.references.filter((reference) => reference.channel === 'image' && reference.role === 'reference_image').length
      : 0
    const audioCount = input.references.filter((reference) => reference.channel === 'audio').length
    const videoCount = input.references.filter((reference) => reference.channel === 'video').length
    const usesLastFrame = item.mediaType === 'video'
      && input.references.some((reference) => reference.role === 'last_frame')
    const durationSeconds = item.mediaType === 'video' ? item.durationSeconds : null
    const preflightOptions = providerTransportPreflightOptions({
      mediaType: item.mediaType,
      options: requested,
      imageCount,
      referenceImageCount,
      audioCount,
      videoCount,
      usesLastFrame,
      durationSeconds,
    })
    const preflight = await preflightMediaGenerationOptions({
      userId: input.ctx.userId,
      modelKey,
      modality: item.mediaType === 'audio' ? 'music' : item.mediaType,
      options: preflightOptions,
      ...(prompt ? { prompt } : {}),
      ...(item.mediaType === 'audio' ? { musicGenerationMode: 'composition_plan' as const } : {}),
    })
    const frozenExecutionOptions = providerTransportPreflightOptions({
      mediaType: item.mediaType,
      options: frozenScalarOptions(preflight.options),
      imageCount,
      referenceImageCount,
      audioCount,
      videoCount,
      usesLastFrame,
      durationSeconds,
    })
    preflightMediaProviderRoutes({
      selection: preflight.selection,
      modality: item.mediaType === 'audio' ? 'music' : item.mediaType,
      options: frozenExecutionOptions,
      mediaInputKinds: providerMediaInputKinds({ imageCount, audioCount, videoCount }),
      ...(prompt ? { prompt } : {}),
      ...(item.mediaType === 'audio' ? { musicGenerationMode: 'composition_plan' as const } : {}),
    })
    const generationOptions = item.mediaType === 'audio'
      ? musicScoreGenerationOptionsSchema.parse({
          kind: 'music_score_v1',
          compositionPlan: item.compositionPlan,
          startMs: item.startMs,
          fadeInMs: item.fadeInMs,
          fadeOutMs: item.fadeOutMs,
          gainDb: item.gainDb,
          timelineInputPosition: 0,
          outputFormat: 'mp3',
        })
      : frozenScalarOptions(preflight.options)
    return {
      prompt,
      generationOptions,
    }
  } catch (error) {
    throwMediaPreflightError(error, {
      mediaType: item.mediaType,
      modelKey,
      aspectRatio,
      ratioOwner: resolveGenerationAspectRatioOwner(item),
    })
  }
}

async function preflightFrozenRetry(input: {
  readonly ctx: ProjectAgentOperationContext
  readonly mediaType: PlannedResource['mediaType']
  readonly modelKey: string
  readonly prompt: string | null
  readonly source: ReturnType<typeof parseWorkspaceResourceGenerationRetrySource>
  readonly generationOptions: z.infer<typeof workspaceResourceGenerationOptionsSchema>
}): Promise<void> {
  const imagePositions = new Set(input.source.resource.imageInputPositions)
  const audioPositions = new Set(input.source.resource.audioInputPositions)
  const videoPositions = new Set(input.source.resource.videoInputPositions)
  const references: Array<z.infer<typeof generationReferenceSchema>> = input.source.resource.inputs.map((reference) => ({
    resourceId: reference.resourceId,
    contentVersion: reference.contentVersion,
    role: reference.role,
    channel: imagePositions.has(reference.position)
      ? 'image'
      : audioPositions.has(reference.position)
        ? 'audio'
        : videoPositions.has(reference.position)
          ? 'video'
          : 'context',
  }))
  validateReferenceCapabilities({
    mediaType: input.mediaType,
    modelKey: input.modelKey,
    references,
  })
  await validateReferenceMediaCapabilities({
    ctx: input.ctx,
    mediaType: input.mediaType,
    modelKey: input.modelKey,
    publicReferences: references,
    frozenReferences: input.source.resource.inputs,
  })
  const musicSpecification = input.mediaType === 'audio'
    ? musicScoreGenerationOptionsSchema.parse(input.generationOptions)
    : null
  if (musicSpecification) {
    validateMusicCompositionCapability({
      modelKey: input.modelKey,
      compositionPlan: musicSpecification.compositionPlan,
    })
    await validateFrozenMusicScoreTimeline({
      ctx: input.ctx,
      references: input.source.resource.inputs,
      specification: musicSpecification,
    })
  }
  const inputByPosition = new Map(
    input.source.resource.inputs.map((reference) => [reference.position, reference]),
  )
  const imageReferences = input.source.resource.imageInputPositions.map((position) => (
    inputByPosition.get(position)
  ))
  const usesLastFrame = imageReferences.some((reference) => reference?.role === 'last_frame')
  const referenceImageCount = imageReferences.filter((reference) => reference?.role === 'reference_image').length
  const options = providerTransportPreflightOptions({
    mediaType: input.mediaType,
    options: musicSpecification
      ? { outputFormat: musicSpecification.outputFormat }
      : input.generationOptions,
    imageCount: input.source.resource.imageInputPositions.length,
    referenceImageCount,
    audioCount: input.source.resource.audioInputPositions.length,
    videoCount: input.source.resource.videoInputPositions.length,
    usesLastFrame,
    durationSeconds: input.source.durationSeconds ?? null,
  })
  try {
    const preflight = await preflightMediaGenerationOptions({
      userId: input.ctx.userId,
      selectionSource: 'frozen_task',
      modelKey: input.modelKey,
      modality: input.mediaType === 'audio' ? 'music' : input.mediaType,
      options,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(musicSpecification ? { musicGenerationMode: 'composition_plan' as const } : {}),
    })
    preflightMediaProviderRoutes({
      selection: preflight.selection,
      modality: input.mediaType === 'audio' ? 'music' : input.mediaType,
      options,
      mediaInputKinds: providerMediaInputKinds({
        imageCount: input.source.resource.imageInputPositions.length,
        audioCount: input.source.resource.audioInputPositions.length,
        videoCount: input.source.resource.videoInputPositions.length,
      }),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(musicSpecification ? { musicGenerationMode: 'composition_plan' as const } : {}),
    })
  } catch (error) {
    throwMediaPreflightError(error, { mediaType: input.mediaType })
  }
}

function taskTypeForMedia(mediaType: PlannedResource['mediaType']): TaskType {
  if (mediaType === 'image') return TASK_TYPE.WORKSPACE_RESOURCE_IMAGE
  if (mediaType === 'audio') return TASK_TYPE.WORKSPACE_RESOURCE_AUDIO
  return TASK_TYPE.WORKSPACE_RESOURCE_VIDEO
}

function modelPayload(mediaType: PlannedResource['mediaType'], modelKey: string): Record<string, string> {
  if (mediaType === 'image') return { imageModel: modelKey }
  if (mediaType === 'audio') return { musicModel: modelKey }
  return { videoModel: modelKey }
}

function generationInputFingerprint(input: {
  readonly mediaType: PlannedResource['mediaType']
  readonly schemaId: string
  readonly modelKey: string
  readonly prompt: string | null
  readonly references: readonly WorkspaceResourceInputRef[]
  readonly generationOptions: z.infer<typeof workspaceResourceGenerationOptionsSchema>
  readonly durationSeconds: number | null
}): string {
  return stableArgsFingerprint(input)
}

async function freezeReferences(
  ctx: ProjectAgentOperationContext,
  references: readonly z.infer<typeof generationReferenceSchema>[],
): Promise<readonly WorkspaceResourceInputRef[]> {
  const frozen = await resolveWorkspaceResourceInputs(prisma, {
    userId: ctx.userId,
    projectId: ctx.projectId,
    references: references.map((reference, position) => ({
      resourceId: reference.resourceId,
      contentVersion: reference.contentVersion,
      role: reference.role,
      position,
    })),
  })
  const resources = frozen.length === 0 ? [] : await prisma.workspaceResource.findMany({
    where: { id: { in: frozen.map((reference) => reference.resourceId) } },
    select: { id: true, mediaType: true },
  })
  const mediaById = new Map(resources.map((resource) => [resource.id, resource.mediaType]))
  for (const reference of references) {
    if (reference.channel === 'context') continue
    if (mediaById.get(reference.resourceId) !== reference.channel) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'WORKSPACE_RESOURCE_REFERENCE_CHANNEL_MISMATCH',
        field: 'references',
        resourceId: reference.resourceId,
      })
    }
  }
  return frozen
}

async function buildPlannedItem(input: {
  readonly ctx: ProjectAgentOperationContext
  readonly fixedParameters: CapabilitySelections
  readonly modelKey: string
  readonly operationId: string
  readonly requestId: string
  readonly item: GenerationItem
  readonly memberIndex: number
  readonly alternatives: boolean
  readonly projectVideoRatio: ProjectVideoRatioSnapshot | null
  readonly existingTarget?: {
    readonly resourceId: string
    readonly workspacePath: string
    readonly schemaId: string
    readonly memberIndex: number
    readonly alternatives: boolean
    readonly sourceTaskId: string
  }
}): Promise<{ readonly task: PlannedTask; readonly resource: PlannedResource }> {
  const mediaType = input.item.mediaType
  const schemaId = schemaForMedia(
    mediaType,
    input.existingTarget?.schemaId ?? input.item.schemaId,
  )
  const requestedAssetKind = input.item.mediaType === 'image' ? input.item.assetKind : null
  const ratioOwner = resolveGenerationAspectRatioOwner(input.item)
  const usesProjectVideoRatio = ratioOwner === 'project'
  const aspectRatio = ratioOwner === null
    ? null
    : ratioOwner === 'asset' && requestedAssetKind
      ? getAssetImageFormatPolicy(requestedAssetKind).aspectRatio
      : ratioOwner === 'item' && input.item.mediaType !== 'audio'
        ? input.item.options?.aspectRatio
          ?? (() => { throw new Error('GENERATION_ITEM_ASPECT_RATIO_REQUIRED') })()
        : input.projectVideoRatio?.value
          ?? (() => { throw new Error('PROJECT_VIDEO_RATIO_SNAPSHOT_REQUIRED') })()
  const item = input.item
  const resourceId = input.existingTarget?.resourceId ?? buildWorkspaceResourceId({
    operationId: input.operationId,
    requestId: `${input.requestId}:${input.item.itemId}`,
    memberIndex: input.memberIndex,
  })
  const workspacePath = input.existingTarget?.workspacePath
    ?? await resolveGeneratedWorkspaceResourcePlacement(prisma, {
      userId: input.ctx.userId,
      projectId: input.ctx.projectId,
      folderPath: input.item.folderPath,
      name: input.item.name,
      resourceId,
      mediaType,
      schemaId,
      alternativeIndex: input.alternatives ? input.memberIndex : null,
    })
  const modelKey = input.modelKey
  const publicReferences = item.references ?? []
  validateReferenceCapabilities({ mediaType, modelKey, references: publicReferences })
  const references = await freezeReferences(input.ctx, publicReferences)
  await validateReferenceMediaCapabilities({
    ctx: input.ctx,
    mediaType,
    modelKey,
    publicReferences,
    frozenReferences: references,
  })
  const compiled = await compileMediaExecution({
    ctx: input.ctx,
    fixedParameters: input.fixedParameters,
    item,
    aspectRatio,
    schemaId,
    modelKey,
    references: publicReferences,
  })
  assertCanvasGenerationIntentOptions(input.ctx.context.canvasGenerationIntent, { ...compiled.generationOptions, aspectRatio })
  if (item.mediaType === 'audio') {
    await validateFrozenMusicScoreTimeline({
      ctx: input.ctx,
      references,
      specification: musicScoreGenerationOptionsSchema.parse(compiled.generationOptions),
    })
  }
  const durationSeconds = item.mediaType === 'video' ? item.durationSeconds : undefined
  const inputHash = generationInputFingerprint({
    mediaType,
    schemaId,
    modelKey,
    prompt: compiled.prompt,
    references,
    generationOptions: compiled.generationOptions,
    durationSeconds: durationSeconds ?? null,
  })
  const resourcePayload: WorkspaceResourceGenerationTaskPayload['resource'] = {
    resourceId,
    workspacePath,
    mediaType,
    schemaId,
    inputHash,
    prompt: compiled.prompt,
    modelKey,
    inputs: [...references],
    imageInputPositions: providerPositions(publicReferences, 'image'),
    audioInputPositions: providerPositions(publicReferences, 'audio'),
    videoInputPositions: providerPositions(publicReferences, 'video'),
    toolCallId: input.ctx.toolCallId?.trim() || null,
    sourceTurnId: input.ctx.context.turnId?.trim() || null,
  }
  const payload: WorkspaceResourceGenerationTaskPayload = {
    lifecycleProjection: buildWorkspaceResourceLifecycleProjection([{
      resourceId,
      mediaType,
      schemaId,
      name: workspaceResourceDisplayName({ workspacePath, resourceId }),
    }]),
    protocol: 'workspace_resource_generation_v2',
    resource: resourcePayload,
    ...modelPayload(mediaType, modelKey),
    count: 1,
    generationOptions: compiled.generationOptions,
    ...(durationSeconds ? { durationSeconds } : {}),
  }
  const taskType = taskTypeForMedia(mediaType)
  const taskPlanId = input.existingTarget
    ? `${input.operationId}:revise_failed:${resourceId}`
    : `${input.operationId}:${resourceId}`
  return {
    task: createPlannedTask({
      id: taskPlanId,
      taskType,
      targetType: 'WorkspaceResource',
      targetId: resourceId,
      payload,
      locale: resolveOperationLocale(input.ctx.context),
      dedupeKey: input.existingTarget
        ? `${input.operationId}:revise_failed:${resourceId}:${input.existingTarget.sourceTaskId}:${inputHash}`
        : `${input.operationId}:${resourceId}:${inputHash}`,
      billingInfo: requirePlannedTaskBillingInfo({
        taskType,
        payload,
        allowedApiTypes: [mediaType === 'audio' ? 'music' : mediaType],
      }),
    }),
    resource: {
      resourceId,
      workspacePath,
      folderPath: input.existingTarget ? null : input.item.folderPath ?? null,
      mediaType,
      schemaId,
      memberIndex: input.existingTarget?.memberIndex ?? input.memberIndex,
      taskPlanId,
      alternatives: input.existingTarget?.alternatives ?? input.alternatives,
      usesProjectVideoRatio,
    },
  }
}

function requestIdentity(ctx: ProjectAgentOperationContext, operationId: string, value: unknown): string {
  return [
    operationId,
    ctx.userId,
    ctx.projectId,
    ctx.context.turnId?.trim() || 'no-turn',
    ctx.toolCallId?.trim() || ctx.requestId?.trim() || stableArgsHash(value),
  ].join(':')
}

function assertBudget(tasks: readonly PlannedTask[], maxBudgetCredits: number | undefined): void {
  if (maxBudgetCredits === undefined) return
  const frozen = tasks.reduce((total, task) => (
    task.billingInfo.billable ? total + task.billingInfo.maxFrozenCost : total
  ), 0)
  if (frozen > maxBudgetCredits) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'WORKSPACE_RESOURCE_BATCH_BUDGET_EXCEEDED',
      field: 'maxBudgetCredits',
      requiredCredits: frozen,
      maxBudgetCredits,
    })
  }
}

function buildPlan(input: {
  readonly ctx: ProjectAgentOperationContext
  readonly operationId: string
  readonly requestId: string
  readonly tasks: readonly PlannedTask[]
  readonly resources: readonly PlannedResource[]
  readonly retry: boolean
  readonly projectVideoRatio: ProjectVideoRatioSnapshot | null
}): OperationPlan {
  return {
    kind: 'task_submission',
    operationId: input.operationId,
    projectId: input.ctx.projectId,
    userId: input.ctx.userId,
    tasks: [...input.tasks],
    reservedIdentityIds: input.resources.map((resource) => resource.resourceId),
    metadata: productionPlanMetadataSchema.parse({
      requestId: input.requestId,
      retry: input.retry,
      resources: input.resources,
      [PROJECT_VIDEO_RATIO_REQUIRED_METADATA_KEY]: input.resources.some(
        (resource) => resource.usesProjectVideoRatio,
      ),
      ...(input.projectVideoRatio
        ? { [PROJECT_VIDEO_RATIO_METADATA_KEY]: input.projectVideoRatio }
        : {}),
    }),
  }
}

async function planNewMedia(
  ctx: ProjectAgentOperationContext,
  operationId: 'create_image' | 'create_audio' | 'create_video',
  mediaType: PlannedResource['mediaType'],
  request: NewMediaRequest,
): Promise<OperationPlan> {
  const production = await readProductionPlanningContext(ctx)
  assertProductionConfigurationVersion(production, request.expectedConfigurationVersion)
  const modelKey = requireProductionModel(production, mediaType === 'audio' ? 'music' : mediaType)
  const requestId = requestIdentity(ctx, operationId, request)
  const items = (request.items as readonly GenerationItem[]).map((item) => (
    item.mediaType === 'image' ? stripAssetImageAspectRatio(item) : item
  ))
  assertCanvasGenerationIntentItems(ctx.context.canvasGenerationIntent, items)
  if (items.some((item) => item.mediaType !== mediaType)) {
    throw new Error(`WORKSPACE_RESOURCE_GENERATION_MEDIA_TYPE_INVALID:${operationId}`)
  }
  const usesProjectVideoRatio = items.some((item) => resolveGenerationAspectRatioOwner(item) === 'project')
  const projectVideoRatio = usesProjectVideoRatio
    ? await readProjectVideoRatioSnapshot({ projectId: ctx.projectId, userId: ctx.userId })
    : null
  const built = await Promise.all(items.flatMap((item) => (
    Array.from({ length: item.count }, (_, memberIndex) => buildPlannedItem({
      ctx,
      fixedParameters: production.fixedParameters,
      modelKey,
      operationId,
      requestId,
      item,
      memberIndex,
      alternatives: item.count > 1,
      projectVideoRatio,
    }))
  )))
  assertUniqueWorkspaceResourcePaths(built.map((entry) => entry.resource.workspacePath))
  assertBudget(built.map((entry) => entry.task), request.maxBudgetCredits)
  return buildPlan({
    ctx,
    operationId,
    requestId,
    tasks: built.map((entry) => entry.task),
    resources: built.map((entry) => entry.resource),
    retry: false,
    projectVideoRatio,
  })
}

async function planReviseFailedVideo(
  ctx: ProjectAgentOperationContext,
  request: z.infer<typeof videoGenerationRevisionBatchSchema>,
): Promise<OperationPlan> {
  assertCanvasGenerationIntentMode(ctx.context.canvasGenerationIntent, 'revise_failed')
  const production = await readProductionPlanningContext(ctx)
  const resourceIds = request.items.map((item) => item.resourceId)
  const rows = await prisma.workspaceResource.findMany({
    where: {
      id: { in: resourceIds },
      userId: ctx.userId,
      projectId: ctx.projectId,
      resourceKind: 'file',
      mediaType: 'video',
      status: { in: ['failed', 'canceled'] },
      deletedAt: null,
    },
    include: { task: { select: { id: true, type: true } } },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const projectVideoRatio = request.items.some((item) => !item.options?.aspectRatio)
    ? await readProjectVideoRatioSnapshot({
        projectId: ctx.projectId,
        userId: ctx.userId,
      })
    : null
  const requestId = requestIdentity(ctx, 'create_video', request)
  const built = await Promise.all(request.items.map(async (replacement, index) => {
    const resource = byId.get(replacement.resourceId)
    if (!resource) {
      throw new ApiError('WORKSPACE_RESOURCE_RETRY_TARGET_NOT_FOUND', {
        resourceId: replacement.resourceId,
      })
    }
    if (!resource.task || resource.task.type !== TASK_TYPE.WORKSPACE_RESOURCE_VIDEO) {
      throw new ApiError('WORKSPACE_RESOURCE_RETRY_TARGET_INVALID', {
        resourceId: replacement.resourceId,
      })
    }
    const schemaId = schemaForMedia('video', resource.schemaId)
    const item = videoGenerationItemSchema.parse({
      itemId: resource.id,
      name: workspaceResourceDisplayName({
        workspacePath: resource.workspacePath,
        resourceId: resource.id,
      }),
      folderPath: null,
      mediaType: 'video',
      schemaId,
      options: replacement.options,
      prompt: replacement.prompt,
      references: replacement.references,
      durationSeconds: replacement.durationSeconds,
      count: 1,
    })
    return await buildPlannedItem({
      ctx,
      fixedParameters: production.fixedParameters,
      modelKey: requireProductionModel(production, 'video'),
      operationId: 'create_video',
      requestId,
      item,
      memberIndex: resource.memberIndex ?? index,
      alternatives: false,
      projectVideoRatio,
      existingTarget: {
        resourceId: resource.id,
        workspacePath: resource.workspacePath,
        schemaId,
        memberIndex: resource.memberIndex ?? index,
        alternatives: Boolean(resource.alternativeGroupExecutionId),
        sourceTaskId: resource.task.id,
      },
    })
  }))
  assertBudget(built.map((entry) => entry.task), request.maxBudgetCredits)
  return buildPlan({
    ctx,
    operationId: 'create_video',
    requestId,
    tasks: built.map((entry) => entry.task),
    resources: built.map((entry) => entry.resource),
    retry: true,
    projectVideoRatio,
  })
}

async function loadFailedTasks(
  ctx: ProjectAgentOperationContext,
  resourceIds: readonly string[],
): Promise<Array<{ readonly resource: PlannedResource; readonly task: PlannedTask }>> {
  const resources = await prisma.workspaceResource.findMany({
    where: {
      id: { in: [...resourceIds] },
      userId: ctx.userId,
      projectId: ctx.projectId,
      resourceKind: 'file',
      status: { in: ['failed', 'canceled'] },
      deletedAt: null,
    },
    include: { task: { select: { id: true, type: true, payload: true } } },
  })
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  return await Promise.all(resourceIds.map(async (resourceId) => {
    const resource = byId.get(resourceId)
    if (!resource) throw new ApiError('WORKSPACE_RESOURCE_RETRY_TARGET_NOT_FOUND', { resourceId })
    if (!resource.task || !resource.mediaType) {
      throw new ApiError('WORKSPACE_RESOURCE_RETRY_TARGET_INVALID', { resourceId })
    }
    const taskType = taskTypeForMedia(resource.mediaType as PlannedResource['mediaType'])
    if (resource.task.type !== taskType) throw new Error(`WORKSPACE_RESOURCE_RETRY_TASK_TYPE_INVALID:${resourceId}`)
    const source = parseWorkspaceResourceGenerationRetrySource(resource.task.payload)
    if (source.resource.resourceId !== resource.id) {
      throw new Error(`WORKSPACE_RESOURCE_RETRY_TASK_TARGET_MISMATCH:${resourceId}`)
    }
    const mediaType = resource.mediaType as PlannedResource['mediaType']
    schemaForMedia(mediaType, resource.schemaId)
    const prompt = resource.prompt
    const modelKey = resource.modelKey?.trim()
    if (!modelKey || (mediaType !== 'audio' && !prompt?.trim())) {
      throw new ApiError('WORKSPACE_RESOURCE_RETRY_FROZEN_INPUT_MISSING', { resourceId })
    }
    const generationOptions = workspaceResourceGenerationOptionsSchema.parse(resource.generationOptions ?? {})
    if (mediaType === 'video' && !source.durationSeconds) {
      throw new Error(`WORKSPACE_RESOURCE_RETRY_DURATION_MISSING:${resourceId}`)
    }
    if (mediaType === 'audio') musicScoreGenerationOptionsSchema.parse(generationOptions)
    await preflightFrozenRetry({
      ctx,
      mediaType,
      modelKey,
      prompt,
      source,
      generationOptions,
    })
    const payload = parseWorkspaceResourceGenerationTaskPayload({
      lifecycleProjection: buildWorkspaceResourceLifecycleProjection([{
        resourceId: resource.id,
        mediaType,
        schemaId: resource.schemaId,
        name: workspaceResourceDisplayName({
          workspacePath: resource.workspacePath,
          resourceId: resource.id,
        }),
      }]),
      protocol: 'workspace_resource_generation_v2',
      resource: {
        resourceId: resource.id,
        workspacePath: resource.workspacePath,
        mediaType,
        schemaId: resource.schemaId,
        inputHash: generationInputFingerprint({
          mediaType,
          schemaId: resource.schemaId,
          modelKey,
          prompt,
          references: source.resource.inputs,
          generationOptions,
          durationSeconds: source.durationSeconds ?? null,
        }),
        prompt,
        modelKey,
        inputs: source.resource.inputs,
        imageInputPositions: source.resource.imageInputPositions,
        audioInputPositions: source.resource.audioInputPositions,
        videoInputPositions: source.resource.videoInputPositions,
        toolCallId: ctx.toolCallId?.trim() || null,
        sourceTurnId: ctx.context.turnId?.trim() || null,
      },
      ...modelPayload(mediaType, modelKey),
      count: 1,
      generationOptions,
      ...(source.durationSeconds ? { durationSeconds: source.durationSeconds } : {}),
    })
    const taskPlanId = `rerun_failed_production_items:${resourceId}`
    return {
      task: createPlannedTask({
        id: taskPlanId,
        taskType,
        targetType: 'WorkspaceResource',
        targetId: resource.id,
        payload,
        billingInfo: requirePlannedTaskBillingInfo({
          taskType,
          payload,
          allowedApiTypes: [mediaType === 'audio' ? 'music' : mediaType],
        }),
        locale: resolveOperationLocale(ctx.context),
        dedupeKey: `rerun:${resource.id}:${resource.task.id}`,
      }),
      resource: {
        resourceId: resource.id,
        workspacePath: resource.workspacePath,
        folderPath: null,
        mediaType,
        schemaId: resource.schemaId,
        memberIndex: resource.memberIndex ?? 0,
        taskPlanId,
        alternatives: Boolean(resource.alternativeGroupExecutionId),
        usesProjectVideoRatio: false,
      },
    }
  }))
}

async function planRetry(
  ctx: ProjectAgentOperationContext,
  operationId: string,
  resourceIds: readonly string[],
  maxBudgetCredits?: number,
): Promise<OperationPlan> {
  assertCanvasGenerationIntentMode(ctx.context.canvasGenerationIntent, 'retry')
  const built = await loadFailedTasks(ctx, resourceIds)
  const expectedType = operationId === 'create_image'
    ? 'image'
    : operationId === 'create_audio'
      ? 'audio'
      : operationId === 'create_video'
        ? 'video'
        : null
  if (expectedType && built.some((entry) => entry.resource.mediaType !== expectedType)) {
    throw new Error(`WORKSPACE_RESOURCE_RETRY_MEDIA_TYPE_INVALID:${operationId}`)
  }
  assertBudget(built.map((entry) => entry.task), maxBudgetCredits)
  return buildPlan({
    ctx,
    operationId,
    requestId: requestIdentity(ctx, operationId, resourceIds),
    tasks: built.map((entry) => entry.task),
    resources: built.map((entry) => entry.resource),
    retry: true,
    projectVideoRatio: null,
  })
}

async function commitProductionPlan(
  ctx: ProjectAgentOperationContext,
  operationId: string,
  plan: OperationPlan,
) {
  const authorization = ctx.executionAuthorization
  if (!authorization) throw new Error('OPERATION_EXECUTION_AUTHORIZATION_REQUIRED')
  const metadata = productionPlanMetadataSchema.parse(plan.metadata)
  if (!metadata.retry) {
    const folderPaths = new Set(metadata.resources.flatMap((resource) => (
      resource.folderPath ? [resource.folderPath] : []
    )))
    for (const folderPath of folderPaths) {
      await createWorkspaceResourceFolderInTransaction(authorization.transaction, {
        userId: ctx.userId,
        projectId: ctx.projectId,
        workspacePath: folderPath,
        sourceType: 'operation_output_folder',
        sourceId: null,
      })
    }
    for (const resource of metadata.resources) {
      const task = plan.tasks.find((candidate) => candidate.id === resource.taskPlanId)
      if (!task) throw new Error(`WORKSPACE_RESOURCE_PLAN_TASK_MISSING:${resource.taskPlanId}`)
      const payload = task.payload as unknown as WorkspaceResourceGenerationTaskPayload
      await reserveWorkspaceResourceInTransaction(authorization.transaction, {
        resourceId: resource.resourceId,
        userId: ctx.userId,
        projectId: ctx.projectId,
        outputPath: resource.workspacePath,
        mediaType: resource.mediaType,
        schemaId: resource.schemaId,
        memberIndex: resource.memberIndex,
        operationExecutionId: authorization.operationExecutionId,
        alternativeGroupExecutionId: resource.alternatives ? authorization.operationExecutionId : null,
        toolCallId: ctx.toolCallId?.trim() || null,
        prompt: payload.resource.prompt,
        modelKey: payload.resource.modelKey,
        generationOptions: payload.generationOptions,
        operationId,
        inputHash: payload.resource.inputHash,
        taskId: null,
      })
    }
  } else {
    await retryWorkspaceResourcesInTransaction(authorization.transaction, {
      userId: ctx.userId,
      projectId: ctx.projectId,
      resources: metadata.resources.map((resource) => {
        const task = plan.tasks.find((candidate) => candidate.id === resource.taskPlanId)
        if (!task) throw new Error(`WORKSPACE_RESOURCE_PLAN_TASK_MISSING:${resource.taskPlanId}`)
        const payload = parseWorkspaceResourceGenerationTaskPayload(task.payload)
        return {
          resourceId: resource.resourceId,
          operationId,
          operationExecutionId: authorization.operationExecutionId,
          inputHash: payload.resource.inputHash,
          prompt: payload.resource.prompt,
          modelKey: payload.resource.modelKey,
          generationOptions: payload.generationOptions,
          toolCallId: ctx.toolCallId?.trim() || null,
        }
      }),
    })
  }
  const submitted = await submitPlannedOperationTasks({ ctx, operationId })
  const results = plan.tasks.map((task) => {
    const result = submitted.get(task.id)
    if (!result) throw new Error(`WORKSPACE_RESOURCE_TASK_RESULT_MISSING:${task.id}`)
    return result
  })
  const first = results[0]
  if (!first) throw new Error('WORKSPACE_RESOURCE_PLAN_EMPTY')
  await bindWorkspaceResourceTasksInTransaction(authorization.transaction, {
    userId: ctx.userId,
    projectId: ctx.projectId,
    bindings: metadata.resources.map((resource) => {
      const submittedTask = submitted.get(resource.taskPlanId)
      if (!submittedTask) throw new Error(`WORKSPACE_RESOURCE_TASK_RESULT_MISSING:${resource.taskPlanId}`)
      return { resourceId: resource.resourceId, taskId: submittedTask.taskId }
    }),
  })
  return mediaOutputSchema.parse({
    ...first,
    taskIds: results.map((result) => result.taskId),
    resources: metadata.resources.map((resource) => ({
      resourceId: resource.resourceId,
      workspacePath: resource.workspacePath,
      memberIndex: resource.memberIndex,
    })),
  })
}

function mediaOperationBase(input: {
  readonly operationId: 'create_image' | 'create_audio' | 'create_video'
  readonly mediaType: PlannedResource['mediaType']
  readonly schemaIds: readonly string[]
  readonly defaultSchemaId: string
  readonly mediaKind: 'image' | 'music' | 'video'
}) {
  return {
    id: input.operationId,
    productionModality: input.mediaKind,
    summary: input.mediaType === 'video'
      ? 'Generate a batch of video Resources from independent items. The server owns placement; retry accepts only failed Resource IDs, and revise_failed corrects failed inputs in place.'
      : `Generate a batch of ${input.mediaType} Resources from independent items. The server owns placement; retry accepts only failed Resource IDs.`,
    intent: 'act',
    channels: { tool: true, api: true, mcp: true },
    effects: MEDIA_EFFECTS,
    resourceContract: {
      kind: 'resource',
      assistantPresentation: 'created_resources',
      acceptsReferences: true,
      outputResourceKinds: ['file'],
      outputMediaTypes: [input.mediaType],
      outputSchemaIds: input.schemaIds,
      placement: 'required',
      alternativeGeneration: {
        kind: 'request_count',
        mediaKind: input.mediaKind,
        requestKind: 'new',
        defaultSchemaId: input.defaultSchemaId,
        minCount: 1,
        maxCount: 6,
        inputLimits: {
          promptMaxLength: 100_000,
        },
      },
    },
    confirmation: { kind: 'billable_media', required: true },
    planContractRevision: MEDIA_GENERATION_PLAN_CONTRACT_REVISION,
    outputSchema: mediaOutputSchema,
  } as const
}

export function createWorkspaceResourceGenerationOperations(): ProjectAgentOperationRegistryDraft {
  return {
    save_project_document: defineOperation({
      id: 'save_project_document',
      summary: 'Explicitly save one text or structured document as a canonical project Resource. Runtime scratch and in-turn professional results are never saved implicitly.',
      intent: 'act',
      channels: { tool: true, api: true, mcp: true },
      toolContractRevision: 'save_project_document/v5',
      effects: {
        writes: true,
        workspaceResourceImpact: 'workspace_resources',
        billable: false,
        destructive: false,
        overwrite: false,
        bulk: false,
        externalSideEffects: false,
        longRunning: false,
      },
      resourceContract: {
        kind: 'resource',
        assistantPresentation: 'created_resources',
        acceptsReferences: true,
        outputResourceKinds: ['file'],
        outputMediaTypes: ['text'],
        outputSchemaIds: WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA.text,
        placement: 'required',
      },
      confirmation: { kind: 'none', required: false },
      inputSchema: saveProjectDocumentInputSchema,
      outputSchema: textOutputSchema,
      executeInTransaction: async (ctx, input, tx) => {
        let schemaId: string = WORKSPACE_RESOURCE_SCHEMA.GENERIC_TEXT
        if (input.content.kind === 'structured') {
          const outputKind = readCreativeOutputKind(input.content.data)
          if (outputKind) {
            const parsed = safeParseCreativeOutput(input.content.data)
            if (!parsed.success) {
              throw new ApiError('INVALID_PARAMS', {
                code: 'PROJECT_DOCUMENT_SCHEMA_INVALID',
                field: 'content.data',
                issues: parsed.error.issues.slice(0, 20).map((issue) => ({
                  path: issue.path.join('.'),
                  message: issue.message,
                })),
              })
            }
            schemaId = readCreativeOutputDefinition(outputKind).savedDocumentSchemaId
          } else if (
            input.content.data !== null
            && typeof input.content.data === 'object'
            && !Array.isArray(input.content.data)
            && Object.prototype.hasOwnProperty.call(input.content.data, 'outputKind')
          ) {
            throw new ApiError('INVALID_PARAMS', {
              code: 'PROJECT_DOCUMENT_OUTPUT_KIND_INVALID',
              field: 'content.data.outputKind',
            })
          }
        }
        const resourceId = buildWorkspaceResourceId({
          operationId: 'save_project_document',
          requestId: requestIdentity(ctx, 'save_project_document', input),
          memberIndex: 0,
        })
        if (input.folderPath) {
          await createWorkspaceResourceFolderInTransaction(tx, {
            userId: ctx.userId,
            projectId: ctx.projectId,
            workspacePath: input.folderPath,
            sourceType: 'operation_output_folder',
            sourceId: null,
          })
        }
        const outputPath = await resolveSavedWorkspaceDocumentPlacement(tx, {
          userId: ctx.userId,
          projectId: ctx.projectId,
          folderPath: input.folderPath,
          name: input.name,
          resourceId,
          contentKind: input.content.kind,
          schemaId,
        })
        const references = await resolveWorkspaceResourceInputs(tx, {
          userId: ctx.userId,
          projectId: ctx.projectId,
          references: (input.references ?? []).map((reference, position) => ({
            resourceId: reference.resourceId,
            contentVersion: reference.contentVersion,
            role: reference.role,
            position,
          })),
        })
        const reserved = await reserveWorkspaceResourceInTransaction(tx, {
          resourceId,
          userId: ctx.userId,
          projectId: ctx.projectId,
          outputPath,
          mediaType: 'text',
          schemaId,
          operationId: 'save_project_document',
          prompt: null,
          toolCallId: ctx.toolCallId?.trim() || null,
        })
        const content = input.content.kind === 'text'
          ? input.content
          : { kind: 'structured' as const, data: input.content.data }
        const materialized = await materializeWorkspaceResourceInTransaction(tx, {
          resourceId: reserved.resourceId,
          userId: ctx.userId,
          projectId: ctx.projectId,
          mediaType: 'text',
          schemaId,
          content,
          inputs: references,
          sourceTurnId: ctx.context.turnId?.trim() || null,
          provenance: {
            operationId: 'save_project_document',
            inputHash: stableArgsFingerprint(input),
            taskId: null,
            operationExecutionId: ctx.operationExecutionId ?? null,
            toolCallId: ctx.toolCallId?.trim() || null,
            prompt: null,
            modelKey: null,
            generationOptions: null,
          },
        })
        return textOutputSchema.parse({ success: true, ...reserved, ...materialized })
      },
    }),
    create_image: defineOperation({
      ...mediaOperationBase({
        operationId: 'create_image',
        mediaType: 'image',
        mediaKind: 'image',
        schemaIds: WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA.image,
        defaultSchemaId: WORKSPACE_RESOURCE_SCHEMA.GENERIC_IMAGE,
      }),
      inputSchema: imageMediaRequestSchema,
      plan: async (ctx, value) => value.request.kind === 'retry'
        ? await planRetry(ctx, 'create_image', value.request.resourceIds)
        : await planNewMedia(ctx, 'create_image', 'image', value.request),
      commit: async (ctx, _value, plan) => await commitProductionPlan(ctx, 'create_image', plan),
    }),
    create_audio: defineOperation({
      ...mediaOperationBase({
        operationId: 'create_audio',
        mediaType: 'audio',
        mediaKind: 'music',
        schemaIds: WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA.audio,
        defaultSchemaId: WORKSPACE_RESOURCE_SCHEMA.BGM_AUDIO,
      }),
      inputSchema: audioMediaRequestSchema,
      plan: async (ctx, value) => value.request.kind === 'retry'
        ? await planRetry(ctx, 'create_audio', value.request.resourceIds)
        : await planNewMedia(ctx, 'create_audio', 'audio', value.request),
      commit: async (ctx, _value, plan) => await commitProductionPlan(ctx, 'create_audio', plan),
    }),
    create_video: defineOperation({
      ...mediaOperationBase({
        operationId: 'create_video',
        mediaType: 'video',
        mediaKind: 'video',
        schemaIds: WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA.video,
        defaultSchemaId: WORKSPACE_RESOURCE_SCHEMA.VIDEO_SEGMENT,
      }),
      inputSchema: videoMediaRequestSchema,
      plan: async (ctx, value) => value.request.kind === 'retry'
        ? await planRetry(ctx, 'create_video', value.request.resourceIds)
        : value.request.kind === 'revise_failed'
          ? await planReviseFailedVideo(ctx, value.request)
          : await planNewMedia(ctx, 'create_video', 'video', value.request),
      commit: async (ctx, _value, plan) => await commitProductionPlan(ctx, 'create_video', plan),
    }),
    rerun_failed_production_items: defineOperation({
      id: 'rerun_failed_production_items',
      summary: 'Requote and rerun only exact failed/canceled production Resource IDs using their original frozen Task payloads.',
      intent: 'act',
      channels: { tool: true, api: true, mcp: true },
      effects: MEDIA_EFFECTS,
      resourceContract: { kind: 'none', reason: 'reruns existing failed Resource identities without creating new Resources' },
      confirmation: { kind: 'billable_media', required: true },
      planContractRevision: MEDIA_GENERATION_PLAN_CONTRACT_REVISION,
      inputSchema: rerunFailedItemsInputSchema,
      outputSchema: mediaOutputSchema,
      plan: async (ctx, input) => await planRetry(
        ctx,
        'rerun_failed_production_items',
        input.resourceIds,
        input.maxBudgetCredits,
      ),
      commit: async (ctx, _input, plan) => await commitProductionPlan(ctx, 'rerun_failed_production_items', plan),
    }),
  }
}
