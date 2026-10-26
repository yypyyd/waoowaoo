import { z } from 'zod'
import { creativeDirectionSchema } from '@/lib/creative-direction/contracts'
import {
  assetGenerationBatchOutputSchema,
  audioGenerationBatchOutputSchema,
  stripAssetImageAspectRatio,
  videoGenerationBatchOutputSchema,
} from '@/lib/workspace-resource/generation-request'
import {
  WORKSPACE_RESOURCE_SCHEMA,
  type WorkspaceResourceSchemaId,
} from '@/lib/workspace-resource/schema-registry'
import type {
  CreativeOutputKind,
  CreativeSkillId,
  CreativeDomainKind,
} from './types'

const textList = (maxItems: number, maxLength: number) => z.array(
  z.string().trim().min(1).max(maxLength),
).max(maxItems)

export const screenplayOutputSchema = z.object({
  schemaVersion: z.literal(1),
  outputKind: z.literal('screenplay'),
  title: z.string().trim().min(1).max(300),
  logline: z.string().trim().max(2_000).nullable(),
  synopsis: z.string().trim().max(12_000),
  screenplayText: z.string().min(1).max(600_000),
  source: z.object({
    kind: z.enum(['generated', 'provided', 'revised']),
    label: z.string().trim().min(1).max(500),
  }).strict(),
  assumptions: textList(64, 2_000),
  openQuestions: textList(64, 2_000),
}).strict()

export const creativeDirectionOutputSchema = creativeDirectionSchema.safeExtend({
  schemaVersion: z.literal(1),
  outputKind: z.literal('creative_direction'),
  assumptions: textList(64, 2_000),
  warnings: textList(64, 2_000),
}).strict()

export const CREATIVE_OUTPUT_SCHEMAS = {
  screenplay: screenplayOutputSchema,
  creative_direction: creativeDirectionOutputSchema,
  asset_generation_batch: assetGenerationBatchOutputSchema,
  video_generation_batch: videoGenerationBatchOutputSchema,
  audio_generation_batch: audioGenerationBatchOutputSchema,
} as const satisfies Record<CreativeOutputKind, z.ZodType>

export const creativeOutputSchema = z.discriminatedUnion('outputKind', [
  screenplayOutputSchema,
  creativeDirectionOutputSchema,
  assetGenerationBatchOutputSchema,
  videoGenerationBatchOutputSchema,
  audioGenerationBatchOutputSchema,
])

export type CreativeOutput = z.infer<typeof creativeOutputSchema>

export const CREATIVE_DOMAIN_OUTPUT_KIND = {
  script: 'screenplay',
  direction: 'creative_direction',
  assets: 'asset_generation_batch',
  video: 'video_generation_batch',
  music: 'audio_generation_batch',
} as const satisfies Record<CreativeDomainKind, CreativeOutputKind>

type CreativeOutputDefinition = {
  readonly outputKind: CreativeOutputKind
  readonly domainKind: CreativeDomainKind
  readonly professionalSkillId: Exclude<CreativeSkillId, 'creative-core'>
  readonly savedDocumentSchemaId: WorkspaceResourceSchemaId
  readonly mediaOperationId: 'create_image' | 'create_audio' | 'create_video' | null
  readonly schema: z.ZodType
}

function defineOutput(
  definition: CreativeOutputDefinition,
): CreativeOutputDefinition {
  return definition
}

export const CREATIVE_OUTPUT_REGISTRY: Readonly<Record<CreativeOutputKind, CreativeOutputDefinition>> = {
  screenplay: defineOutput({
    outputKind: 'screenplay',
    domainKind: 'script',
    professionalSkillId: 'script-development',
    savedDocumentSchemaId: WORKSPACE_RESOURCE_SCHEMA.SCREENPLAY,
    mediaOperationId: null,
    schema: screenplayOutputSchema,
  }),
  creative_direction: defineOutput({
    outputKind: 'creative_direction',
    domainKind: 'direction',
    professionalSkillId: 'creative-direction',
    savedDocumentSchemaId: WORKSPACE_RESOURCE_SCHEMA.CREATIVE_DIRECTION,
    mediaOperationId: null,
    schema: creativeDirectionOutputSchema,
  }),
  asset_generation_batch: defineOutput({
    outputKind: 'asset_generation_batch',
    domainKind: 'assets',
    professionalSkillId: 'asset-development',
    savedDocumentSchemaId: WORKSPACE_RESOURCE_SCHEMA.ASSET_GENERATION_BATCH,
    mediaOperationId: 'create_image',
    schema: assetGenerationBatchOutputSchema,
  }),
  video_generation_batch: defineOutput({
    outputKind: 'video_generation_batch',
    domainKind: 'video',
    professionalSkillId: 'video-direction',
    savedDocumentSchemaId: WORKSPACE_RESOURCE_SCHEMA.VIDEO_GENERATION_BATCH,
    mediaOperationId: 'create_video',
    schema: videoGenerationBatchOutputSchema,
  }),
  audio_generation_batch: defineOutput({
    outputKind: 'audio_generation_batch',
    domainKind: 'music',
    professionalSkillId: 'music-direction',
    savedDocumentSchemaId: WORKSPACE_RESOURCE_SCHEMA.AUDIO_GENERATION_BATCH,
    mediaOperationId: 'create_audio',
    schema: audioGenerationBatchOutputSchema,
  }),
}

export function readCreativeOutputDefinition(outputKind: CreativeOutputKind): CreativeOutputDefinition {
  return CREATIVE_OUTPUT_REGISTRY[outputKind]
}

export function creativeOutputJsonSchema(outputKind: CreativeOutputKind): Record<string, unknown> {
  // io:"input" so any future Zod effects/transforms stay representable; never
  // project output-side transforms into skill prompt JSON Schema.
  return z.toJSONSchema(readCreativeOutputDefinition(outputKind).schema, {
    target: 'draft-7',
    io: 'input',
  }) as Record<string, unknown>
}

function normalizeCreativeOutput(parsed: CreativeOutput): CreativeOutput {
  if (parsed.outputKind !== 'asset_generation_batch') return parsed
  return {
    ...parsed,
    items: parsed.items.map((item) => stripAssetImageAspectRatio(item)),
  }
}

export function parseCreativeOutput(value: unknown): CreativeOutput {
  return normalizeCreativeOutput(creativeOutputSchema.parse(value))
}

export function safeParseCreativeOutput(value: unknown): ReturnType<typeof creativeOutputSchema.safeParse> {
  const parsed = creativeOutputSchema.safeParse(value)
  if (!parsed.success) return parsed
  return { ...parsed, data: normalizeCreativeOutput(parsed.data) }
}

export function readCreativeOutputKind(value: unknown): CreativeOutputKind | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const outputKind = (value as Record<string, unknown>).outputKind
  return typeof outputKind === 'string' && outputKind in CREATIVE_OUTPUT_REGISTRY
    ? outputKind as CreativeOutputKind
    : null
}
