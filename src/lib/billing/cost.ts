import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import {
  resolveBuiltinPricing,
  type PricingResolution,
} from '@/lib/ai-registry/pricing-resolution'
import { parseModelKeyStrict } from '@/lib/ai-registry/selection'
import type { CapabilityValue } from '@/lib/ai-registry/types'
import { resolveImageSizeFromGenerationOptions } from '@/lib/image-generation/runtime-options'
import { BillingOperationError } from './errors'
import { getBootBillingEnabled } from './mode'

export type ApiType = 'text' | 'image' | 'video' | 'music' | 'voice'
export type UsageUnit = 'token' | 'image' | 'video' | 'second' | 'call' | 'character'

type BillingMetadata = { [field: string]: unknown }
type TextCacheCostMetadata = {
  cachedInputTokens?: number
}

const GOOGLE_CONTEXT_CACHE_INPUT_PRICE_MULTIPLIER = 0.1

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizePositiveNumber(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function resolveDurationSeconds(metadata?: BillingMetadata): number | null {
  const duration = readNumber(metadata?.duration)
  if (duration !== null && duration > 0) return duration
  const durationSeconds = readNumber(metadata?.durationSeconds)
  if (durationSeconds !== null && durationSeconds > 0) return durationSeconds
  return null
}

function roundCredits(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000
}

function toCapabilitySelections(metadata?: BillingMetadata): Record<string, CapabilityValue> {
  const selections: Record<string, CapabilityValue> = {}
  if (!metadata) return selections
  for (const [field, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      selections[field] = value
    }
  }
  return selections
}

function describePricingResolution(resolution: PricingResolution): string {
  switch (resolution.status) {
    case 'not_configured':
      return 'model pricing is not configured'
    case 'ambiguous_model':
      return 'model pricing is ambiguous; use provider::modelId'
    case 'missing_capability_match':
      return 'model pricing does not match selected capabilities'
    case 'resolved':
      return 'model pricing resolved'
  }
}

function throwPricingResolutionError(
  apiType: ApiType,
  model: string,
  resolution: Exclude<PricingResolution, { status: 'resolved' }>,
): never {
  if (resolution.status === 'ambiguous_model') {
    throw new BillingOperationError(
      'BILLING_PRICING_MODEL_AMBIGUOUS',
      `BILLING_PRICING_MODEL_AMBIGUOUS: ${apiType} ${model}`,
      {
        apiType,
        model,
        candidates: resolution.candidates.map((candidate) => `${candidate.provider}::${candidate.modelId}`),
      },
    )
  }

  if (resolution.status === 'missing_capability_match') {
    throw new BillingOperationError(
      'BILLING_CAPABILITY_PRICE_NOT_FOUND',
      `BILLING_CAPABILITY_PRICE_NOT_FOUND: ${apiType} ${model}`,
      {
        apiType,
        model,
        selections: resolution.selections,
        provider: resolution.entry.provider,
        modelId: resolution.entry.modelId,
      },
    )
  }

  throw new BillingOperationError(
    'BILLING_UNKNOWN_MODEL',
    `BILLING_UNKNOWN_MODEL: ${apiType} ${model}`,
    {
      apiType,
      model,
      reason: describePricingResolution(resolution),
    },
  )
}

/**
 * Resolve the retail price of a model.
 *
 * Billing only ever reads the retail face — the cost face exists for margin
 * reporting and never reaches a user-facing amount.
 */
/**
 * When BILLING_MODE is not ENFORCE (self-hosted/local OFF or SHADOW), custom
 * provider models often have no SaaS catalog price. Quote them at zero instead
 * of blocking generation with BILLING_UNKNOWN_MODEL.
 */
function resolveZeroLocalPricing(input: {
  apiType: ApiType
  model: string
}): Extract<PricingResolution, { status: 'resolved' }> {
  const parsed = parseModelKeyStrict(input.model)
  return {
    status: 'resolved',
    entry: {
      apiType: input.apiType,
      provider: parsed?.provider ?? 'local',
      modelId: parsed?.modelId ?? input.model,
      cost: { mode: 'flat', flatAmount: 0 },
      retail: { mode: 'flat', flatAmount: 0 },
    },
    amount: 0,
    face: 'retail',
    mode: 'flat',
    unit: 'per_call',
  }
}

function resolveCatalogPricing(input: {
  apiType: ApiType
  model: string
  selections?: Record<string, CapabilityValue>
}): Extract<PricingResolution, { status: 'resolved' }> {
  ensureAiCatalogsRegistered()
  const resolution = resolveBuiltinPricing({
    apiType: input.apiType,
    model: input.model,
    face: 'retail',
    selections: input.selections,
  })
  if (resolution.status === 'resolved') return resolution

  const parsed = parseModelKeyStrict(input.model)
  const isCustomPlatformInstance = Boolean(parsed?.provider.includes(':'))
  if (
    !getBootBillingEnabled()
    && (
      resolution.status === 'not_configured'
      || (isCustomPlatformInstance && resolution.status === 'missing_capability_match')
    )
  ) {
    return resolveZeroLocalPricing(input)
  }

  return throwPricingResolutionError(input.apiType, input.model, resolution)
}

export function calcText(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return calcTextWithCache(model, inputTokens, outputTokens)
}

export function calcTextWithCache(
  model: string,
  inputTokens: number,
  outputTokens: number,
  metadata?: TextCacheCostMetadata,
): number {
  const normalizedInputTokens = normalizePositiveInteger(inputTokens)
  const normalizedOutputTokens = normalizePositiveInteger(outputTokens)
  if (normalizedInputTokens === 0 && normalizedOutputTokens === 0) return 0

  let cost = 0
  if (normalizedInputTokens > 0) {
    const inputPricing = resolveCatalogPricing({
      apiType: 'text',
      model,
      selections: { tokenType: 'input' },
    })
    const cachedInputTokens = Math.min(
      normalizePositiveInteger(metadata?.cachedInputTokens ?? 0),
      normalizedInputTokens,
    )
    const useGoogleContextCachePricing = inputPricing.entry.provider === 'google' && cachedInputTokens > 0
    const fullPriceInputTokens = useGoogleContextCachePricing
      ? normalizedInputTokens - cachedInputTokens
      : normalizedInputTokens
    cost += (fullPriceInputTokens / 1_000_000) * inputPricing.amount
    if (useGoogleContextCachePricing) {
      cost += (
        cachedInputTokens
        / 1_000_000
        * inputPricing.amount
        * GOOGLE_CONTEXT_CACHE_INPUT_PRICE_MULTIPLIER
      )
    }
  }

  if (normalizedOutputTokens > 0) {
    const outputPricing = resolveCatalogPricing({
      apiType: 'text',
      model,
      selections: { tokenType: 'output' },
    })
    cost += (normalizedOutputTokens / 1_000_000) * outputPricing.amount
  }

  return roundCredits(cost)
}

/**
 * Price a model's server-side tool calls, which some providers bill per call on
 * top of tokens. Only models that declare a `toolCall` tier have one, so a
 * model without that tier costs nothing here — but an entirely unpriced model
 * still throws, exactly as it does for tokens. Silently pricing an unknown
 * model at zero is how unbilled usage happens.
 */
export function calcTextToolCalls(model: string, toolCalls: number): number {
  const normalizedToolCalls = normalizePositiveInteger(toolCalls)
  if (normalizedToolCalls === 0) return 0
  ensureAiCatalogsRegistered()
  const resolution = resolveBuiltinPricing({
    apiType: 'text',
    model,
    face: 'retail',
    selections: { tokenType: 'toolCall' },
  })
  if (resolution.status === 'missing_capability_match') return 0
  if (resolution.status !== 'resolved') {
    if (!getBootBillingEnabled() && resolution.status === 'not_configured') {
      return 0
    }
    return throwPricingResolutionError('text', model, resolution)
  }
  return roundCredits((normalizedToolCalls / 1_000_000) * resolution.amount)
}

export function calcImage(
  model: string,
  quantity = 1,
  metadata?: BillingMetadata,
): number {
  const units = Math.max(1, normalizePositiveInteger(quantity))
  const selections = toCapabilitySelections(metadata)
  const imageSize = resolveImageSizeFromGenerationOptions(metadata)
  if (imageSize) selections.imageSize = imageSize
  if (!selections.quality) selections.quality = 'high'

  const pricing = resolveCatalogPricing({
    apiType: 'image',
    model,
    selections,
  })
  return roundCredits(units * pricing.amount)
}

export function calcVideo(
  model: string,
  resolution = '720p',
  quantity = 1,
  metadata?: BillingMetadata,
): number {
  const units = Math.max(1, normalizePositiveInteger(quantity))
  const duration = resolveDurationSeconds(metadata)
  const selections = {
    ...toCapabilitySelections(metadata),
    resolution,
    ...(duration !== null ? { duration } : {}),
  }

  const pricing = resolveCatalogPricing({
    apiType: 'video',
    model,
    selections,
  })
  if (pricing.mode === 'capability' && !pricing.unit) {
    throw new BillingOperationError(
      'BILLING_CAPABILITY_PRICE_NOT_FOUND',
      `BILLING_CAPABILITY_PRICE_NOT_FOUND: video ${model} missing pricing unit`,
      { apiType: 'video', model, selections },
    )
  }

  const pricingUnit = pricing.mode === 'flat' ? 'per_call' : pricing.unit
  if (pricingUnit === 'per_second' && duration === null) {
    throw new BillingOperationError(
      'BILLING_CAPABILITY_PRICE_NOT_FOUND',
      `BILLING_CAPABILITY_PRICE_NOT_FOUND: video ${model} requires duration`,
      { apiType: 'video', model, selections },
    )
  }

  const unitCost = pricing.mode === 'flat' || pricingUnit === 'per_call'
    ? pricing.amount
    : pricing.amount * normalizePositiveNumber(duration || 0)
  return roundCredits(units * unitCost)
}

export function calcMusic(
  model: string,
  quantity = 1,
  metadata?: BillingMetadata,
): number {
  const units = Math.max(1, normalizePositiveInteger(quantity))
  const duration = resolveDurationSeconds(metadata)
  const pricing = resolveCatalogPricing({
    apiType: 'music',
    model,
    selections: toCapabilitySelections(metadata),
  })
  const pricingUnit = pricing.mode === 'flat' ? pricing.unit ?? 'per_call' : pricing.unit
  if (pricingUnit === 'per_second' && duration === null) {
    throw new BillingOperationError(
      'BILLING_CAPABILITY_PRICE_NOT_FOUND',
      `BILLING_CAPABILITY_PRICE_NOT_FOUND: music ${model} requires duration`,
      { apiType: 'music', model },
    )
  }
  const unitCost = pricingUnit === 'per_second'
    ? pricing.amount * normalizePositiveNumber(duration || 0)
    : pricing.amount
  return roundCredits(units * unitCost)
}

export function calcVoice(model: string, characters: number): number {
  const units = Math.max(1, normalizePositiveInteger(characters))
  const pricing = resolveCatalogPricing({
    apiType: 'voice',
    model,
  })
  return roundCredits(units * pricing.amount)
}
