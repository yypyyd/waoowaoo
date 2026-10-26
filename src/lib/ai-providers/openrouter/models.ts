import type {
  AiOptionSchema,
  AiPublicReasoningMode,
  AiReadonlyUnknownObject,
  AiUnknownObject,
} from '@/lib/ai-registry/types'
import type { PlatformModelPreset } from '@/lib/platform-models/types'
import {
  buildMediaOptionSchema,
  enumValidator,
  integerRangeValidator,
  stringArrayValidator,
  type MediaModality,
} from '@/lib/ai-providers/shared/option-schema'
import { buildGptImage2OptionSchema } from '@/lib/ai-providers/shared/gpt-image-2'
import { SEEDANCE_2_RETAIL_CREDITS_PER_SECOND } from '@/lib/ai-providers/shared/seedance-pricing'
import { usdToCredits } from '@/lib/ai-registry/pricing-currency'
import { ASPECT_RATIO_CONFIGS } from '@/lib/constants'
import type { ReasoningEffort } from '@/lib/ai-registry/reasoning-effort'
import {
  OPENROUTER_SEEDREAM_5_PRO_MODEL_ID,
  OPENROUTER_SEEDREAM_5_PRO_RESOLUTIONS,
  OPENROUTER_SEEDREAM_5_PRO_RATIOS,
  OPENROUTER_SEEDREAM_5_PRO_PRICING,
} from './seedream'
import {
  OPENROUTER_SEEDANCE_2_VIDEO_MODEL_ID,
  OPENROUTER_SEEDANCE_2_FAST_VIDEO_MODEL_ID,
  OPENROUTER_VIDEO_MODELS,
  buildOpenRouterVideoOptionSchema,
} from './video-models'
import { OPENROUTER_HAILUO_PRICING_CATALOG_ENTRIES, OPENROUTER_SEEDANCE_2_5_PRICING } from './video-pricing'

export const OPENROUTER_GPT_IMAGE_2_MODEL_ID = 'openai/gpt-image-2'
export const OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID = 'google/gemini-3-pro-image'
export const OPENROUTER_BANANA_2_IMAGE_MODEL_ID = 'google/gemini-3.1-flash-image'
export const OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID = 'google/gemini-3.1-flash-lite-image'
export const OPENROUTER_GEMINI_3_1_PRO_MODEL_ID = 'google/gemini-3.1-pro-preview'
export const OPENROUTER_GEMINI_3_5_FLASH_MODEL_ID = 'google/gemini-3.5-flash'
export const OPENROUTER_GEMINI_3_5_FLASH_LITE_MODEL_ID = 'google/gemini-3.5-flash-lite'
export const OPENROUTER_GEMINI_3_6_FLASH_MODEL_ID = 'google/gemini-3.6-flash'
export const OPENROUTER_GEMINI_3_8_FLASH_MODEL_ID = 'google/gemini-3.8-flash'
export const OPENROUTER_CLAUDE_SONNET_4_6_MODEL_ID = 'anthropic/claude-sonnet-4.6'
export const OPENROUTER_CLAUDE_SONNET_5_MODEL_ID = 'anthropic/claude-sonnet-5'
export const OPENROUTER_CLAUDE_FABLE_5_MODEL_ID = 'anthropic/claude-fable-5'
export const OPENROUTER_CLAUDE_FABLE_5_1_MODEL_ID = 'anthropic/claude-fable-5.1'
export const OPENROUTER_CLAUDE_OPUS_5_MODEL_ID = 'anthropic/claude-opus-5'
export const OPENROUTER_GPT_5_5_MODEL_ID = 'openai/gpt-5.5'
export const OPENROUTER_GPT_5_6_LUNA_MODEL_ID = 'openai/gpt-5.6-luna'
export const OPENROUTER_GPT_5_6_TERRA_MODEL_ID = 'openai/gpt-5.6-terra'
export const OPENROUTER_GPT_5_6_SOL_MODEL_ID = 'openai/gpt-5.6-sol'
export const OPENROUTER_PROVIDER_TEST_LLM_MODEL_ID = OPENROUTER_GPT_5_6_LUNA_MODEL_ID
export const OPENROUTER_GPT_IMAGE_2_RESOLUTION_OPTIONS = ['1K'] as const
export const OPENROUTER_GPT_IMAGE_2_QUALITY_OPTIONS = ['high', 'medium', 'low'] as const
export const OPENROUTER_GPT_IMAGE_2_ASPECT_RATIO_OPTIONS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] as const
export const OPENROUTER_BANANA_PRO_RESOLUTION_OPTIONS = ['1K', '2K', '4K'] as const
export const OPENROUTER_BANANA_2_RESOLUTION_OPTIONS = ['512', '1K', '2K', '4K'] as const
export const OPENROUTER_BANANA_2_LITE_RESOLUTION_OPTIONS = ['1K'] as const
export const OPENROUTER_BANANA_PRO_ASPECT_RATIO_OPTIONS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const
export const OPENROUTER_BANANA_2_ASPECT_RATIO_OPTIONS = [
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4',
  '8:1', '9:16', '16:9', '21:9',
] as const

const OPENROUTER_IMAGE_REFERENCE_LIMITS: Readonly<Record<string, number>> = {
  [OPENROUTER_GPT_IMAGE_2_MODEL_ID]: 16,
  [OPENROUTER_SEEDREAM_5_PRO_MODEL_ID]: 14,
  [OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID]: 14,
  [OPENROUTER_BANANA_2_IMAGE_MODEL_ID]: 14,
  [OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID]: 14,
}

export const OPENROUTER_IMAGE_MODEL_IDS = new Set([
  OPENROUTER_SEEDREAM_5_PRO_MODEL_ID,
  OPENROUTER_GPT_IMAGE_2_MODEL_ID,
  OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID,
  OPENROUTER_BANANA_2_IMAGE_MODEL_ID,
  OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID,
])

/**
 * Custom openrouter:<suffix> instances often store short OpenAI-compatible ids
 * (gpt-image-2) while the catalog uses namespaced OpenRouter ids
 * (openai/gpt-image-2). Map a unique short/suffix form onto the catalog id.
 */
export function resolveOpenRouterCatalogImageModelId(
  modelId: string | undefined,
): string | undefined {
  if (!modelId) return undefined
  if (OPENROUTER_IMAGE_MODEL_IDS.has(modelId)) return modelId
  const suffix = `/${modelId}`
  const matches = [...OPENROUTER_IMAGE_MODEL_IDS].filter(
    (candidate) => candidate === modelId || candidate.endsWith(suffix),
  )
  return matches.length === 1 ? matches[0] : undefined
}

export const OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS = [
  'medium',
  'low',
  'high',
  'xhigh',
  'max',
  'none',
] as const satisfies readonly ReasoningEffort[]

type OpenRouterLlmModelDefinition = {
  modelId: string
  name: string
  pricingUsdPerMillion: readonly [input: number, output: number]
  publicReasoningMode: Exclude<AiPublicReasoningMode, 'none'>
  reasoningEffortOptions: readonly [ReasoningEffort, ...ReasoningEffort[]]
  /** Product default, not the provider's implicit default. */
  defaultReasoningEffort: ReasoningEffort
  /** Verified total input + output window; not the maximum prompt length. */
  contextWindow: number
  showInApiConfig: boolean
  showInPlatform: boolean
}

// Public catalog: https://openrouter.ai/api/v1/models (verified 2026-09-05).
// Prices are the catalog's base prompt/completion USD rates per million tokens;
// endpoint premiums, cache rates and long-context overrides are not represented
// by this two-tier cost contract. Hidden entries retain exact model identity for
// existing configurations; neither selector offers them for new selection.
export const OPENROUTER_LLM_MODEL_DEFINITIONS = [
  {
    modelId: OPENROUTER_GEMINI_3_1_PRO_MODEL_ID,
    name: 'Gemini 3.1 Pro',
    pricingUsdPerMillion: [2, 12],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_048_576,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: OPENROUTER_GEMINI_3_8_FLASH_MODEL_ID,
    name: 'Gemini 3.8 Flash',
    pricingUsdPerMillion: [0.75, 3.75],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_048_576,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: OPENROUTER_GEMINI_3_6_FLASH_MODEL_ID,
    name: 'Gemini 3.6 Flash',
    pricingUsdPerMillion: [0.75, 3.75],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['minimal', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_048_576,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: OPENROUTER_GEMINI_3_5_FLASH_MODEL_ID,
    name: 'Gemini 3.5 Flash',
    pricingUsdPerMillion: [1.5, 9],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['minimal', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_048_576,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: OPENROUTER_GEMINI_3_5_FLASH_LITE_MODEL_ID,
    name: 'Gemini 3.5 Flash Lite',
    pricingUsdPerMillion: [0.3, 2.5],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['minimal', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_048_576,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: 'google/gemini-3.1-flash-lite-preview',
    name: 'Gemini 3.1 Flash Lite',
    pricingUsdPerMillion: [0.25, 1.5],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['minimal', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_048_576,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: OPENROUTER_CLAUDE_SONNET_4_6_MODEL_ID,
    name: 'Claude Sonnet 4.6',
    pricingUsdPerMillion: [3, 15],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_000_000,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: OPENROUTER_CLAUDE_SONNET_5_MODEL_ID,
    name: 'Claude Sonnet 5',
    pricingUsdPerMillion: [2, 10],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_000_000,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: OPENROUTER_CLAUDE_FABLE_5_MODEL_ID,
    name: 'Claude Fable 5',
    pricingUsdPerMillion: [10, 50],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_000_000,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: OPENROUTER_CLAUDE_FABLE_5_1_MODEL_ID,
    name: 'Claude Fable 5.1',
    pricingUsdPerMillion: [10, 50],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_000_000,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: OPENROUTER_CLAUDE_OPUS_5_MODEL_ID,
    name: 'Claude Opus 5',
    pricingUsdPerMillion: [5, 25],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_000_000,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    pricingUsdPerMillion: [3, 15],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_000_000,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    pricingUsdPerMillion: [3, 15],
    publicReasoningMode: 'native',
    reasoningEffortOptions: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_000_000,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: OPENROUTER_GPT_5_5_MODEL_ID,
    name: 'GPT-5.5',
    pricingUsdPerMillion: [5, 30],
    publicReasoningMode: 'summary_auto',
    reasoningEffortOptions: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
    contextWindow: 1_050_000,
    showInApiConfig: false,
    showInPlatform: false,
  },
  {
    modelId: OPENROUTER_GPT_5_6_LUNA_MODEL_ID,
    name: 'GPT-5.6 Luna',
    pricingUsdPerMillion: [0.2, 1.2],
    publicReasoningMode: 'summary_auto',
    reasoningEffortOptions: OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS,
    defaultReasoningEffort: 'medium',
    contextWindow: 1_050_000,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: OPENROUTER_GPT_5_6_TERRA_MODEL_ID,
    name: 'GPT-5.6 Terra',
    pricingUsdPerMillion: [2, 12],
    publicReasoningMode: 'summary_auto',
    reasoningEffortOptions: OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS,
    defaultReasoningEffort: 'medium',
    contextWindow: 1_050_000,
    showInApiConfig: true,
    showInPlatform: true,
  },
  {
    modelId: OPENROUTER_GPT_5_6_SOL_MODEL_ID,
    name: 'GPT-5.6 Sol',
    pricingUsdPerMillion: [2, 10],
    publicReasoningMode: 'summary_auto',
    reasoningEffortOptions: OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS,
    defaultReasoningEffort: 'medium',
    contextWindow: 1_050_000,
    showInApiConfig: true,
    showInPlatform: true,
  },
] as const satisfies readonly OpenRouterLlmModelDefinition[]

function openrouterTokenPricing(inputUsdPerMillion: number, outputUsdPerMillion: number) {
  return {
    mode: 'capability' as const,
    tiers: [
      { when: { tokenType: 'input' }, amount: usdToCredits(inputUsdPerMillion) },
      { when: { tokenType: 'output' }, amount: usdToCredits(outputUsdPerMillion) },
    ],
  }
}

const OPENROUTER_LLM_PRICING_CATALOG_ENTRIES = OPENROUTER_LLM_MODEL_DEFINITIONS.map((model) => {
  const [inputUsdPerMillion, outputUsdPerMillion] = model.pricingUsdPerMillion
  return {
    apiType: 'text' as const,
    provider: 'openrouter',
    modelId: model.modelId,
    cost: openrouterTokenPricing(inputUsdPerMillion, outputUsdPerMillion),
  }
})

const OPENROUTER_LLM_CAPABILITY_CATALOG_ENTRIES = OPENROUTER_LLM_MODEL_DEFINITIONS.map((model) => ({
  modelType: 'llm' as const,
  provider: 'openrouter',
  modelId: model.modelId,
  capabilities: {
    llm: {
      protocol: 'openrouter-chat' as const,
      codexRuntimeWireApi: 'responses' as const,
      publicReasoningMode: model.publicReasoningMode,
      reasoningEffortOptions: [...model.reasoningEffortOptions],
      defaultReasoningEffort: model.defaultReasoningEffort,
      contextWindow: model.contextWindow,
    },
  },
}))

const OPENROUTER_LLM_API_CONFIG_CATALOG_MODELS = OPENROUTER_LLM_MODEL_DEFINITIONS
  .filter((model) => model.showInApiConfig)
  .map((model) => ({
    modelId: model.modelId,
    name: model.name,
    type: 'llm' as const,
    provider: 'openrouter',
  }))

const OPENROUTER_LLM_PLATFORM_MODEL_PRESETS: PlatformModelPreset[] = OPENROUTER_LLM_MODEL_DEFINITIONS
  .filter((model) => model.showInPlatform)
  .map((model) => ({
    provider: 'openrouter',
    modelId: model.modelId,
    name: model.name,
    type: 'llm',
  }))

function openrouterVideoSecondPricing(tiers: ReadonlyArray<readonly [resolution: string, amountUsdPerSecond: number]>) {
  return {
    mode: 'capability' as const,
    unit: 'per_second' as const,
    tiers: tiers.map(([resolution, amountUsdPerSecond]) => ({
      when: { resolution },
      amount: usdToCredits(amountUsdPerSecond),
    })),
  }
}

function openrouterVideoRetailPricing(tiers: ReadonlyArray<readonly [resolution: string, credits: number]>) {
  return {
    mode: 'capability' as const,
    unit: 'per_second' as const,
    tiers: tiers.map(([resolution, credits]) => ({ when: { resolution }, amount: credits })),
  }
}

function openrouterGptImage2Pricing() {
  const rows = [
    ['1024x768', { low: 0.005, medium: 0.037, high: 0.145 }],
    ['1024x1024', { low: 0.006, medium: 0.053, high: 0.211 }],
    ['1024x1536', { low: 0.005, medium: 0.042, high: 0.165 }],
    ['1920x1080', { low: 0.005, medium: 0.040, high: 0.158 }],
  ] as const
  return {
    mode: 'capability' as const,
    tiers: rows.flatMap(([imageSize, prices]) => [
      { when: { imageSize, quality: 'low' }, amount: usdToCredits(prices.low) },
      { when: { imageSize, quality: 'medium' }, amount: usdToCredits(prices.medium) },
      { when: { imageSize, quality: 'high' }, amount: usdToCredits(prices.high) },
    ]),
  }
}

function openrouterImageResolutionPricing(
  tiers: ReadonlyArray<readonly [resolution: string, amountUsdPerImage: number]>,
) {
  return {
    mode: 'capability' as const,
    tiers: tiers.map(([resolution, amountUsdPerImage]) => ({
      when: { resolution },
      amount: usdToCredits(amountUsdPerImage),
    })),
  }
}

export const OPENROUTER_BUILTIN_PRICING_CATALOG_ENTRIES = [
  OPENROUTER_SEEDREAM_5_PRO_PRICING,
  OPENROUTER_SEEDANCE_2_5_PRICING,
  ...OPENROUTER_HAILUO_PRICING_CATALOG_ENTRIES,
  {
    apiType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_GPT_IMAGE_2_MODEL_ID,
    cost: openrouterGptImage2Pricing(),
  },
  {
    apiType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID,
    cost: openrouterImageResolutionPricing([
      ['1K', 0.134],
      ['2K', 0.134],
      ['4K', 0.24],
    ]),
  },
  {
    apiType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_BANANA_2_IMAGE_MODEL_ID,
    cost: openrouterImageResolutionPricing([
      ['512', 0.045],
      ['1K', 0.067],
      ['2K', 0.101],
      ['4K', 0.151],
    ]),
  },
  {
    apiType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID,
    cost: openrouterImageResolutionPricing([
      ['1K', 0.0336],
    ]),
  },
  ...OPENROUTER_LLM_PRICING_CATALOG_ENTRIES,
  {
    apiType: 'video',
    provider: 'openrouter',
    modelId: OPENROUTER_SEEDANCE_2_VIDEO_MODEL_ID,
    cost: openrouterVideoSecondPricing([
      ['480p', 0.06726],
      ['720p', 0.151335],
      ['1080p', 0.3405386],
    ]),
    retail: openrouterVideoRetailPricing([
      ['480p', SEEDANCE_2_RETAIL_CREDITS_PER_SECOND.standard['480p']],
      ['720p', SEEDANCE_2_RETAIL_CREDITS_PER_SECOND.standard['720p']],
      ['1080p', SEEDANCE_2_RETAIL_CREDITS_PER_SECOND.standard['1080p']],
    ]),
  },
  {
    apiType: 'video',
    provider: 'openrouter',
    modelId: OPENROUTER_SEEDANCE_2_FAST_VIDEO_MODEL_ID,
    cost: openrouterVideoSecondPricing([
      ['480p', 0.0538],
      ['720p', 0.12105],
    ]),
    retail: openrouterVideoRetailPricing([
      ['480p', SEEDANCE_2_RETAIL_CREDITS_PER_SECOND.fast['480p']],
      ['720p', SEEDANCE_2_RETAIL_CREDITS_PER_SECOND.fast['720p']],
    ]),
  },
] as const

export const OPENROUTER_BUILTIN_CAPABILITY_CATALOG_ENTRIES = [
  {
    modelType: 'image', provider: 'openrouter', modelId: OPENROUTER_SEEDREAM_5_PRO_MODEL_ID,
    capabilities: { image: { resolutionOptions: [...OPENROUTER_SEEDREAM_5_PRO_RESOLUTIONS], maxReferenceImages: OPENROUTER_IMAGE_REFERENCE_LIMITS[OPENROUTER_SEEDREAM_5_PRO_MODEL_ID] } },
  },
  {
    modelType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_GPT_IMAGE_2_MODEL_ID,
    capabilities: {
      image: {
        resolutionOptions: [...OPENROUTER_GPT_IMAGE_2_RESOLUTION_OPTIONS],
        maxReferenceImages: OPENROUTER_IMAGE_REFERENCE_LIMITS[OPENROUTER_GPT_IMAGE_2_MODEL_ID],
        qualityOptions: [...OPENROUTER_GPT_IMAGE_2_QUALITY_OPTIONS],
      },
    },
  },
  {
    modelType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID,
    capabilities: {
      image: {
        resolutionOptions: [...OPENROUTER_BANANA_PRO_RESOLUTION_OPTIONS],
        maxReferenceImages: OPENROUTER_IMAGE_REFERENCE_LIMITS[OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID],
      },
    },
  },
  {
    modelType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_BANANA_2_IMAGE_MODEL_ID,
    capabilities: {
      image: {
        resolutionOptions: [...OPENROUTER_BANANA_2_RESOLUTION_OPTIONS],
        maxReferenceImages: OPENROUTER_IMAGE_REFERENCE_LIMITS[OPENROUTER_BANANA_2_IMAGE_MODEL_ID],
      },
    },
  },
  {
    modelType: 'image',
    provider: 'openrouter',
    modelId: OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID,
    capabilities: {
      image: {
        resolutionOptions: [...OPENROUTER_BANANA_2_LITE_RESOLUTION_OPTIONS],
        maxReferenceImages: OPENROUTER_IMAGE_REFERENCE_LIMITS[OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID],
      },
    },
  },
  ...OPENROUTER_LLM_CAPABILITY_CATALOG_ENTRIES,
  ...OPENROUTER_VIDEO_MODELS.map((model) => ({
    modelType: 'video' as const,
    provider: 'openrouter',
    modelId: model.modelId,
    capabilities: { video: model.capabilities },
  })),
] as const

export const OPENROUTER_API_CONFIG_CATALOG_MODELS = [
  { modelId: OPENROUTER_SEEDREAM_5_PRO_MODEL_ID, name: 'Seedream 5.0 Pro', type: 'image', provider: 'openrouter' },
  { modelId: OPENROUTER_GPT_IMAGE_2_MODEL_ID, name: 'GPT Image 2', type: 'image', provider: 'openrouter' },
  { modelId: OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID, name: 'Nano Banana Pro', type: 'image', provider: 'openrouter' },
  { modelId: OPENROUTER_BANANA_2_IMAGE_MODEL_ID, name: 'Nano Banana 2', type: 'image', provider: 'openrouter' },
  { modelId: OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID, name: 'Nano Banana 2 Lite', type: 'image', provider: 'openrouter' },
  ...OPENROUTER_LLM_API_CONFIG_CATALOG_MODELS,
  ...OPENROUTER_VIDEO_MODELS.map(({ modelId, name }) => ({
    modelId, name, type: 'video' as const, provider: 'openrouter',
  })),
] as const

export const OPENROUTER_PLATFORM_MODEL_PRESETS = [
  { provider: 'openrouter', modelId: OPENROUTER_SEEDREAM_5_PRO_MODEL_ID, name: 'Seedream 5.0 Pro', type: 'image' },
  { provider: 'openrouter', modelId: OPENROUTER_GPT_IMAGE_2_MODEL_ID, name: 'GPT Image 2', type: 'image' },
  { provider: 'openrouter', modelId: OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID, name: 'Nano Banana Pro', type: 'image' },
  { provider: 'openrouter', modelId: OPENROUTER_BANANA_2_IMAGE_MODEL_ID, name: 'Nano Banana 2', type: 'image' },
  { provider: 'openrouter', modelId: OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID, name: 'Nano Banana 2 Lite', type: 'image' },
  ...OPENROUTER_LLM_PLATFORM_MODEL_PRESETS,
  ...OPENROUTER_VIDEO_MODELS.map(({ modelId, name }) => ({
    modelId, name, type: 'video' as const, provider: 'openrouter',
  })),
] as const satisfies ReadonlyArray<PlatformModelPreset>

/**
 * Resolves the option schema for an OpenRouter media variant. `providerId` may be
 * an instantiated identity (openrouter:<suffix>) backing a user-added platform:
 * those accept arbitrary OpenAI-compatible model ids, so unknown models fall
 * back to a generic schema instead of failing the catalog whitelist.
 */
export function resolveOpenRouterOptionSchema(
  modality: MediaModality,
  modelId?: string,
  providerId?: string,
): AiOptionSchema {
  if (modality === 'image') {
    const catalogModelId = resolveOpenRouterCatalogImageModelId(modelId) ?? modelId
    if (catalogModelId === OPENROUTER_GPT_IMAGE_2_MODEL_ID) {
      return buildGptImage2OptionSchema({
        resolutionOptions: OPENROUTER_GPT_IMAGE_2_RESOLUTION_OPTIONS,
        aspectRatioOptions: OPENROUTER_GPT_IMAGE_2_ASPECT_RATIO_OPTIONS,
        qualityOptions: OPENROUTER_GPT_IMAGE_2_QUALITY_OPTIONS,
        defaultResolution: '1K',
        defaultQuality: 'high',
        defaultOutputFormat: 'png',
        maxReferenceImages: OPENROUTER_IMAGE_REFERENCE_LIMITS[OPENROUTER_GPT_IMAGE_2_MODEL_ID],
        allowedKeys: ['background', 'outputCompression', 'moderation'],
        excludedKeys: ['keepOriginalAspectRatio', 'responseFormat'],
        validators: {
          background: enumValidator(['auto', 'opaque']),
          outputCompression: integerRangeValidator({ min: 0, max: 100 }),
          moderation: enumValidator(['auto', 'low']),
        },
        objectValidators: [(options) => {
          if (options.outputCompression === undefined) return { ok: true }
          const outputFormat = options.outputFormat ?? 'png'
          return outputFormat === 'jpeg' || outputFormat === 'webp'
            ? { ok: true }
            : { ok: false, reason: 'outputCompression_requires_jpeg_or_webp' }
        }],
      })
    }

    const imagePolicy = catalogModelId === OPENROUTER_BANANA_PRO_IMAGE_MODEL_ID
      ? {
          resolutionOptions: OPENROUTER_BANANA_PRO_RESOLUTION_OPTIONS,
          aspectRatioOptions: OPENROUTER_BANANA_PRO_ASPECT_RATIO_OPTIONS,
        }
      : catalogModelId === OPENROUTER_BANANA_2_IMAGE_MODEL_ID
        ? {
            resolutionOptions: OPENROUTER_BANANA_2_RESOLUTION_OPTIONS,
            aspectRatioOptions: OPENROUTER_BANANA_2_ASPECT_RATIO_OPTIONS,
          }
        : catalogModelId === OPENROUTER_BANANA_2_LITE_IMAGE_MODEL_ID
          ? {
              resolutionOptions: OPENROUTER_BANANA_2_LITE_RESOLUTION_OPTIONS,
              aspectRatioOptions: OPENROUTER_BANANA_2_ASPECT_RATIO_OPTIONS,
            }
          : catalogModelId === OPENROUTER_SEEDREAM_5_PRO_MODEL_ID
            ? {
                resolutionOptions: OPENROUTER_SEEDREAM_5_PRO_RESOLUTIONS,
                aspectRatioOptions: OPENROUTER_SEEDREAM_5_PRO_RATIOS,
              }
            : null
    if (!imagePolicy || !catalogModelId) {
      if (providerId && providerId.includes(':')) {
        return buildMediaOptionSchema('image', {
          required: ['aspectRatio'],
          validators: {
            aspectRatio: enumValidator(Object.keys(ASPECT_RATIO_CONFIGS)),
          },
        })
      }
      throw new Error(`OPENROUTER_OPTION_SCHEMA_UNSUPPORTED_IMAGE_MODEL:${modelId || '<missing>'}`)
    }
    return buildMediaOptionSchema('image', {
      excludedKeys: [
        'keepOriginalAspectRatio',
        'outputFormat',
        'quality',
        'responseFormat',
        'size',
      ],
      required: ['aspectRatio'],
      validators: {
        aspectRatio: enumValidator(imagePolicy.aspectRatioOptions),
        resolution: enumValidator(imagePolicy.resolutionOptions),
        referenceImages: stringArrayValidator({ maxLength: OPENROUTER_IMAGE_REFERENCE_LIMITS[catalogModelId] }),
        ...(catalogModelId === OPENROUTER_SEEDREAM_5_PRO_MODEL_ID ? { seed: integerRangeValidator({}) } : {}),
      },
      normalize: (options: AiReadonlyUnknownObject): AiUnknownObject => ({
        ...options,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution ?? '1K',
        referenceImages: options.referenceImages ?? [],
      }),
    })
  }
  if (modality === 'video') return buildOpenRouterVideoOptionSchema(modelId, providerId)
  return buildMediaOptionSchema(modality)
}
