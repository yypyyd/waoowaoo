import { z } from 'zod'
import { ASPECT_RATIO_CONFIGS } from '@/lib/constants'
import { OPERATION_EXECUTION_MAX_TASKS } from '@/lib/temporal/operation-execution/contracts'
import { musicScoreCueRequestSchema } from '@/lib/music/score-specification'
import {
  WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA,
  WORKSPACE_RESOURCE_SCHEMA,
} from './schema-registry'

const finalPromptSchema = z.string().min(1).max(100_000)
  .refine((value) => value.trim().length > 0, 'prompt must contain non-whitespace content.')
  .describe('Complete final provider-ready creative prompt. The server validates and freezes it verbatim.')

const resourceNameSchema = z.string().trim().min(1).max(300)
  .describe('User-visible resource name. The server derives the canonical WorkspaceResource path.')

const folderPathSchema = z.string().trim().min(1).max(512).nullable().optional()
  .describe('Optional project-relative destination folder path. Omit or use null for the project root; missing folders are created atomically with the output Resources.')

export const generationReferenceSchema = z.object({
  resourceId: z.string().trim().min(1).max(32)
    .describe('Canonical ready WorkspaceResource identity.'),
  contentVersion: z.number().int().positive()
    .describe('Exact immutable input version.'),
  role: z.string().trim().min(1).max(64),
  channel: z.enum(['context', 'image', 'audio', 'video']),
}).strict().describe('One ordered reference. Array order is authoritative; the server assigns frozen internal positions.')

export const videoGenerationReferenceSchema = z.discriminatedUnion('channel', [
  generationReferenceSchema.extend({
    channel: z.literal('context'),
  }).strict(),
  generationReferenceSchema.extend({
    channel: z.literal('image'),
    role: z.enum(['first_frame', 'last_frame', 'reference_image']),
  }).strict(),
  generationReferenceSchema.extend({
    channel: z.literal('audio'),
    role: z.literal('reference_audio'),
  }).strict(),
  generationReferenceSchema.extend({
    channel: z.literal('video'),
    role: z.literal('reference_video'),
  }).strict(),
])

/**
 * Per-item frame ratio. Omitted means the project frame owner resolves it;
 * the value set is the same project frame vocabulary, never a free string.
 */
export const generationAspectRatioSchema = z.string().trim()
  .refine((value) => Object.prototype.hasOwnProperty.call(ASPECT_RATIO_CONFIGS, value), {
    message: `aspectRatio must be one of ${Object.keys(ASPECT_RATIO_CONFIGS).join(', ')}.`,
  })
  .describe('Optional W:H frame ratio for this item. Omit to use the project frame. Fixed-format asset images (character/location/prop) must omit it.')

const imageParametersSchema = z.object({
  aspectRatio: generationAspectRatioSchema.optional(),
  resolution: z.string().trim().min(1).optional(),
  quality: z.string().trim().min(1).optional(),
}).strict()

const videoParametersSchema = z.object({
  aspectRatio: generationAspectRatioSchema.optional(),
  resolution: z.string().trim().min(1).optional(),
  generateAudio: z.boolean().optional(),
}).strict()

export type ImageGenerationParameters = z.infer<typeof imageParametersSchema>
export type VideoGenerationParameters = z.infer<typeof videoParametersSchema>

const commonItemShape = {
  itemId: z.string().trim().min(1).max(191),
  name: resourceNameSchema,
  folderPath: folderPathSchema,
  count: z.number().int().min(1).max(6).default(1),
} as const

const textList = (maxItems: number, maxLength: number) => z.array(
  z.string().trim().min(1).max(maxLength),
).max(maxItems)

/**
 * Reusable asset images use a server-owned fixed format (4:3). Agents sometimes
 * still send options.aspectRatio because the shared create_image tool also
 * serves ordinary images — drop it so validation matches regeneration-projection.
 */
export function stripAssetImageAspectRatio<T extends {
  readonly assetKind?: string | null
  readonly options?: { readonly aspectRatio?: string } & Record<string, unknown>
}>(item: T): T {
  if (item.assetKind == null || item.options?.aspectRatio === undefined) return item
  const { aspectRatio: _omit, ...rest } = item.options
  const options = Object.keys(rest).length > 0 ? rest : undefined
  return { ...item, options } as T
}

const imageGenerationItemObjectSchema = z.object({
  ...commonItemShape,
  mediaType: z.literal('image'),
  options: imageParametersSchema.optional(),
  prompt: finalPromptSchema,
  schemaId: z.enum(WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA.image),
  assetKind: z.enum(['character', 'location', 'prop']).nullable().default(null),
  references: z.array(generationReferenceSchema.extend({
    channel: z.enum(['context', 'image']),
  }).strict()).optional(),
  aliases: textList(64, 300).optional(),
  stableDescription: z.string().trim().min(1).max(16_000).optional(),
  consumedByShots: textList(512, 512).optional(),
}).strict().superRefine((item, context) => {
  const expectedSchema = item.assetKind === 'character'
    ? WORKSPACE_RESOURCE_SCHEMA.CHARACTER_IMAGE
    : item.assetKind === 'location'
      ? WORKSPACE_RESOURCE_SCHEMA.LOCATION_IMAGE
      : item.assetKind === 'prop'
        ? WORKSPACE_RESOURCE_SCHEMA.PROP_IMAGE
        : null
  if (expectedSchema !== null && item.schemaId !== expectedSchema) {
    context.addIssue({ code: 'custom', path: ['schemaId'], message: `schemaId must match assetKind ${item.assetKind}.` })
  }
  const assetSchemaIds: readonly string[] = [
    WORKSPACE_RESOURCE_SCHEMA.CHARACTER_IMAGE,
    WORKSPACE_RESOURCE_SCHEMA.LOCATION_IMAGE,
    WORKSPACE_RESOURCE_SCHEMA.PROP_IMAGE,
  ]
  if (item.assetKind === null && assetSchemaIds.includes(item.schemaId)) {
    context.addIssue({ code: 'custom', path: ['assetKind'], message: 'assetKind is required for a reusable asset image schema.' })
  }
})

/**
 * Canonical item schema for create_image / JSON Schema projection.
 * Do NOT attach .transform() here: z.toJSONSchema (creative skills and tool
 * projection) cannot represent transforms unless every caller passes io:"input",
 * and creativeOutputJsonSchema historically did not. Strip asset aspectRatio
 * via stripAssetImageAspectRatio after parse instead.
 */
export const imageGenerationItemSchema = imageGenerationItemObjectSchema

export const audioGenerationItemSchema = musicScoreCueRequestSchema.safeExtend({
  ...commonItemShape,
  mediaType: z.literal('audio'),
  schemaId: z.enum(WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA.audio),
  references: z.array(generationReferenceSchema.extend({
    channel: z.literal('context'),
    role: z.literal('score_timeline'),
  }).strict()).length(1),
}).strict()

export const videoGenerationItemSchema = z.object({
  ...commonItemShape,
  mediaType: z.literal('video'),
  options: videoParametersSchema.optional(),
  prompt: finalPromptSchema,
  schemaId: z.enum(WORKSPACE_RESOURCE_GENERATION_SCHEMA_IDS_BY_MEDIA.video),
  references: z.array(videoGenerationReferenceSchema).optional(),
  durationSeconds: z.number().int().positive(),
}).strict()

export const videoGenerationRevisionItemSchema = z.object({
  resourceId: z.string().trim().min(1).max(32)
    .describe('Exact failed or canceled video Resource to regenerate in place. Its canonical identity, name, path, and schema are preserved.'),
  prompt: finalPromptSchema,
  options: videoParametersSchema.optional(),
  references: z.array(videoGenerationReferenceSchema).optional(),
  durationSeconds: z.number().int().positive(),
}).strict()

function validateGenerationItems(
  value: { readonly items: readonly { readonly itemId: string; readonly count: number }[] },
  context: z.RefinementCtx,
): void {
  if (new Set(value.items.map((item) => item.itemId)).size !== value.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'itemId values must be unique.' })
  }
  const taskCount = value.items.reduce((total, item) => total + item.count, 0)
  if (taskCount > OPERATION_EXECUTION_MAX_TASKS) {
    context.addIssue({
      code: 'custom',
      path: ['items'],
      message: `The expanded batch may contain at most ${String(OPERATION_EXECUTION_MAX_TASKS)} tasks.`,
    })
  }
}

const batchCommonShape = {
  expectedConfigurationVersion: z.string().min(1).max(128).optional()
    .describe('Optional configuration version observed by the caller. A mismatch rejects the new plan before any side effect.'),
  kind: z.literal('new'),
  maxBudgetCredits: z.number().finite().positive().optional(),
} as const

export const imageGenerationBatchSchema = z.object({
  ...batchCommonShape,
  items: z.array(imageGenerationItemSchema).min(1).max(OPERATION_EXECUTION_MAX_TASKS),
}).strict().superRefine(validateGenerationItems)

export const audioGenerationBatchSchema = z.object({
  ...batchCommonShape,
  items: z.array(audioGenerationItemSchema).min(1).max(OPERATION_EXECUTION_MAX_TASKS),
}).strict().superRefine(validateGenerationItems)

export const videoGenerationBatchSchema = z.object({
  ...batchCommonShape,
  items: z.array(videoGenerationItemSchema).min(1).max(OPERATION_EXECUTION_MAX_TASKS),
}).strict().superRefine(validateGenerationItems)

export const videoGenerationRevisionBatchSchema = z.object({
  kind: z.literal('revise_failed'),
  items: z.array(videoGenerationRevisionItemSchema).min(1).max(OPERATION_EXECUTION_MAX_TASKS),
  maxBudgetCredits: z.number().finite().positive().optional(),
}).strict().superRefine((batch, context) => {
  if (new Set(batch.items.map((item) => item.resourceId)).size !== batch.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'resourceId values must be unique.' })
  }
})

export type GenerationItem =
  | z.infer<typeof imageGenerationItemSchema>
  | z.infer<typeof audioGenerationItemSchema>
  | z.infer<typeof videoGenerationItemSchema>

const assetGenerationItemSchema = imageGenerationItemObjectSchema.safeExtend({
  assetKind: z.enum(['character', 'location', 'prop']),
  aliases: textList(64, 300),
  stableDescription: z.string().trim().min(1).max(16_000),
  consumedByShots: textList(512, 512),
}).strict()

export const assetGenerationBatchOutputSchema = z.object({
  schemaVersion: z.literal(2),
  outputKind: z.literal('asset_generation_batch'),
  batchId: z.string().trim().min(1).max(191),
  decision: z.enum(['produce', 'no_assets']),
  overview: z.string().trim().min(1).max(8_000),
  items: z.array(assetGenerationItemSchema).max(OPERATION_EXECUTION_MAX_TASKS),
  assumptions: textList(64, 2_000),
  warnings: textList(64, 2_000),
}).strict().superRefine((batch, context) => {
  if (batch.decision === 'produce' && batch.items.length === 0) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'decision=produce requires at least one item.' })
  }
  if (batch.decision === 'no_assets' && batch.items.length !== 0) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'decision=no_assets requires items to be empty.' })
  }
  validateGenerationItems(batch, context)
})

export const videoGenerationBatchOutputSchema = z.object({
  schemaVersion: z.literal(2),
  outputKind: z.literal('video_generation_batch'),
  batchId: z.string().trim().min(1).max(191),
  overview: z.string().trim().min(1).max(8_000),
  items: z.array(videoGenerationItemSchema).min(1).max(OPERATION_EXECUTION_MAX_TASKS),
  assumptions: textList(64, 2_000),
  warnings: textList(64, 2_000),
}).strict().superRefine(validateGenerationItems)

export const audioGenerationBatchOutputSchema = z.object({
  schemaVersion: z.literal(3),
  outputKind: z.literal('audio_generation_batch'),
  batchId: z.string().trim().min(1).max(191),
  decision: z.enum(['produce', 'no_music']),
  overview: z.string().trim().min(1).max(12_000),
  items: z.array(audioGenerationItemSchema).max(OPERATION_EXECUTION_MAX_TASKS),
  globalContinuity: z.string().trim().max(8_000),
  assumptions: textList(64, 2_000),
  warnings: textList(64, 2_000),
}).strict().superRefine((batch, context) => {
  if (batch.decision === 'produce' && batch.items.length === 0) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'decision=produce requires at least one item.' })
  }
  if (batch.decision === 'no_music' && batch.items.length !== 0) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'decision=no_music requires items to be empty.' })
  }
  validateGenerationItems(batch, context)
})

export function normalizeImageGenerationItems<T extends {
  readonly assetKind?: string | null
  readonly options?: { readonly aspectRatio?: string } & Record<string, unknown>
}>(items: readonly T[]): T[] {
  return items.map((item) => stripAssetImageAspectRatio(item))
}
