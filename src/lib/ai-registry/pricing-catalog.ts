import type { CapabilityValue } from '@/lib/ai-registry/types'
import { isCapabilityValue, isPlainObject, readTrimmedString } from './catalog-utils'
import {
  describePricingMarginViolation,
  findPricingMarginViolations,
  retailFromCost,
} from './pricing-retail'

let registeredPricingEntries: readonly unknown[] = []

export function registerBuiltinPricingCatalogEntries(entries: readonly unknown[]) {
  registeredPricingEntries = entries
  pricingCache = null
}

function ensureBuiltinPricingCatalogEntriesRegistered() {
  if (registeredPricingEntries.length === 0) {
    throw new Error('PRICING_CATALOG_MISSING: empty builtin catalog')
  }
}

// -----------------------------
// Pricing catalog + lookup
// -----------------------------

export type PricingApiType =
  | 'text'
  | 'image'
  | 'video'
  | 'music'
  | 'voice'

export interface BuiltinPricingTier {
  when: Record<string, CapabilityValue>
  amount: number
}

export type BuiltinPricingUnit = 'per_call' | 'per_second'

export interface BuiltinPricingDefinition {
  mode: 'flat' | 'capability'
  unit?: BuiltinPricingUnit
  flatAmount?: number
  tiers?: BuiltinPricingTier[]
}

/**
 * One model's price, in both faces the system needs.
 *
 * `cost` is CNY paid to the provider and exists only for margin reporting and
 * the margin guard. `retail` is credits charged to the user and is the only
 * face billing ever resolves. A provider file may omit `retail`, in which case
 * it is derived from `cost` at the api type's markup — so every registered
 * model always has a price the billing path can resolve.
 */
export interface BuiltinPricingCatalogEntry {
  apiType: PricingApiType
  provider: string
  modelId: string
  cost: BuiltinPricingDefinition
  retail: BuiltinPricingDefinition
}

/** Which face of a catalog entry a lookup wants. */
export type PricingFace = 'cost' | 'retail'

interface PricingCatalogCache {
  entries: BuiltinPricingCatalogEntry[]
  exact: Map<string, BuiltinPricingCatalogEntry>
  byModelId: Map<string, BuiltinPricingCatalogEntry[]>
}

let pricingCache: PricingCatalogCache | null = null

function isPricingApiType(value: unknown): value is PricingApiType {
  return value === 'text'
    || value === 'image'
    || value === 'video'
    || value === 'music'
    || value === 'voice'
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizePricingUnit(raw: unknown, where: string): BuiltinPricingUnit | undefined {
  if (raw === undefined) return undefined
  if (raw === 'per_call' || raw === 'per_second') return raw
  throw new Error(`PRICING_CATALOG_INVALID: ${where}.unit must be per_call or per_second`)
}

function normalizePricingTier(raw: unknown, where: string, tierIndex: number): BuiltinPricingTier {
  if (!isPlainObject(raw)) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.tiers[${tierIndex}] must be object`)
  }

  const whenRaw = Reflect.get(raw, 'when')
  if (!isPlainObject(whenRaw) || Object.keys(whenRaw).length === 0) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.tiers[${tierIndex}].when must be non-empty object`)
  }

  const when: Record<string, CapabilityValue> = {}
  for (const [field, value] of Object.entries(whenRaw)) {
    if (!isCapabilityValue(value)) {
      throw new Error(`PRICING_CATALOG_INVALID: ${where}.tiers[${tierIndex}].when.${field} must be string/number/boolean`)
    }
    when[field] = value
  }

  const amount = readFiniteNumber(Reflect.get(raw, 'amount'))
  if (amount === null || amount < 0) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.tiers[${tierIndex}].amount must be finite number >= 0`)
  }

  return { when, amount }
}

function normalizePricing(raw: unknown, where: string): BuiltinPricingDefinition {
  if (!isPlainObject(raw)) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where} must be object`)
  }

  const modeRaw = Reflect.get(raw, 'mode')
  if (modeRaw !== 'flat' && modeRaw !== 'capability') {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.mode must be flat or capability`)
  }
  const unit = normalizePricingUnit(Reflect.get(raw, 'unit'), where)

  if (modeRaw === 'flat') {
    const flatAmount = readFiniteNumber(Reflect.get(raw, 'flatAmount'))
    if (flatAmount === null || flatAmount < 0) {
      throw new Error(`PRICING_CATALOG_INVALID: ${where}.flatAmount must be finite number >= 0`)
    }
    return { mode: 'flat', ...(unit ? { unit } : {}), flatAmount }
  }

  const tiersRaw = Reflect.get(raw, 'tiers')
  if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.tiers must be a non-empty array`)
  }

  const tiers = tiersRaw.map((tier, tierIndex) => normalizePricingTier(tier, where, tierIndex))
  return { mode: 'capability', ...(unit ? { unit } : {}), tiers }
}

/**
 * A hand-written retail definition must mirror its cost definition's shape:
 * same mode, same unit, and the same tiers declared in the same order. This is
 * what lets the margin guard pair cost and retail amounts by index, and it
 * stops a retail table from quietly covering fewer cases than the cost table it
 * is priced against.
 */
function assertRetailMirrorsCost(
  cost: BuiltinPricingDefinition,
  retail: BuiltinPricingDefinition,
  filePath: string,
  index: number,
): void {
  const where = `${filePath}#${index}`
  if (cost.mode !== retail.mode) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.retail.mode must match cost.mode`)
  }
  if ((cost.unit ?? null) !== (retail.unit ?? null)) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.retail.unit must match cost.unit`)
  }
  if (cost.mode === 'flat') return

  const costTiers = cost.tiers ?? []
  const retailTiers = retail.tiers ?? []
  if (costTiers.length !== retailTiers.length) {
    throw new Error(`PRICING_CATALOG_INVALID: ${where}.retail.tiers must declare the same tiers as cost.tiers`)
  }
  for (let tierIndex = 0; tierIndex < costTiers.length; tierIndex += 1) {
    const costWhen = costTiers[tierIndex].when
    const retailWhen = retailTiers[tierIndex].when
    const costKeys = Object.keys(costWhen).sort()
    const retailKeys = Object.keys(retailWhen).sort()
    const sameShape = costKeys.length === retailKeys.length
      && costKeys.every((key, keyIndex) => key === retailKeys[keyIndex])
      && costKeys.every((key) => costWhen[key] === retailWhen[key])
    if (!sameShape) {
      throw new Error(
        `PRICING_CATALOG_INVALID: ${where}.retail.tiers[${tierIndex}].when must match cost.tiers[${tierIndex}].when`,
      )
    }
  }
}

function normalizePricingEntry(raw: unknown, filePath: string, index: number): BuiltinPricingCatalogEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`PRICING_CATALOG_INVALID: ${filePath}#${index} must be object`)
  }

  const apiTypeRaw = Reflect.get(raw, 'apiType')
  if (!isPricingApiType(apiTypeRaw)) {
    throw new Error(`PRICING_CATALOG_INVALID: ${filePath}#${index}.apiType must be one of text/image/video/music/voice`)
  }

  const provider = readTrimmedString(Reflect.get(raw, 'provider'))
  const modelId = readTrimmedString(Reflect.get(raw, 'modelId'))
  if (!provider || !modelId) {
    throw new Error(`PRICING_CATALOG_INVALID: ${filePath}#${index}.provider/modelId are required`)
  }

  const cost = normalizePricing(Reflect.get(raw, 'cost'), `${filePath}#${index}.cost`)
  if (apiTypeRaw === 'video' && cost.mode === 'capability' && !cost.unit) {
    throw new Error(`PRICING_CATALOG_INVALID: ${filePath}#${index}.cost.unit is required for video capability pricing`)
  }

  const retailRaw = Reflect.get(raw, 'retail')
  const retail = retailRaw === undefined
    ? retailFromCost(cost, apiTypeRaw)
    : normalizePricing(retailRaw, `${filePath}#${index}.retail`)
  if (retailRaw !== undefined) {
    assertRetailMirrorsCost(cost, retail, filePath, index)
  }

  return { apiType: apiTypeRaw, provider, modelId, cost, retail }
}

function buildPricingCache(entries: BuiltinPricingCatalogEntry[]): PricingCatalogCache {
  const exact = new Map<string, BuiltinPricingCatalogEntry>()
  const byModelId = new Map<string, BuiltinPricingCatalogEntry[]>()

  for (const entry of entries) {
    const exactKey = `${entry.apiType}::${entry.provider}::${entry.modelId}`
    if (exact.has(exactKey)) {
      throw new Error(`PRICING_CATALOG_DUPLICATE: ${exactKey}`)
    }
    exact.set(exactKey, entry)

    const modelIdKey = `${entry.apiType}::${entry.modelId}`
    const group = byModelId.get(modelIdKey) || []
    group.push(entry)
    byModelId.set(modelIdKey, group)
  }

  return { entries, exact, byModelId }
}

function clonePricingEntry(entry: BuiltinPricingCatalogEntry): BuiltinPricingCatalogEntry {
  return JSON.parse(JSON.stringify(entry)) as BuiltinPricingCatalogEntry
}

function loadPricingCatalog(): PricingCatalogCache {
  if (pricingCache) return pricingCache
  ensureBuiltinPricingCatalogEntriesRegistered()
  const entries: BuiltinPricingCatalogEntry[] = []
  for (let index = 0; index < registeredPricingEntries.length; index += 1) {
    entries.push(normalizePricingEntry(registeredPricingEntries[index], 'builtin', index))
  }

  const violations = findPricingMarginViolations(entries)
  if (violations.length > 0) {
    throw new Error(
      `PRICING_CATALOG_MARGIN_VIOLATION: ${violations.length} model price(s) are unprofitable at the`
      + ` deepest plan discount:\n${violations.map(describePricingMarginViolation).join('\n')}`,
    )
  }

  pricingCache = buildPricingCache(entries)
  return pricingCache
}

export function listBuiltinPricingCatalog(): BuiltinPricingCatalogEntry[] {
  return loadPricingCatalog().entries.map(clonePricingEntry)
}

export function findBuiltinPricingCatalogEntry(
  apiType: PricingApiType,
  provider: string,
  modelId: string,
): BuiltinPricingCatalogEntry | null {
  const loaded = loadPricingCatalog()

  const exactKey = `${apiType}::${provider}::${modelId}`
  const entry = loaded.exact.get(exactKey)
  if (entry) return clonePricingEntry(entry)

  const providerKey = provider.includes(':') ? provider.slice(0, provider.indexOf(':')) : provider
  if (providerKey !== provider) {
    const keyWithProviderKey = `${apiType}::${providerKey}::${modelId}`
    const keyEntry = loaded.exact.get(keyWithProviderKey)
    if (keyEntry) return clonePricingEntry(keyEntry)

    // Custom platform instances (openrouter:<suffix>) often store short
    // OpenAI-compatible ids (gpt-image-2) while the builtin catalog uses
    // namespaced OpenRouter ids (openai/gpt-image-2). Prefer a unique suffix
    // match within the base provider over failing as not_configured.
    const suffix = `/${modelId}`
    const suffixMatches = loaded.entries.filter((candidate) => (
      candidate.apiType === apiType
      && candidate.provider === providerKey
      && (candidate.modelId === modelId || candidate.modelId.endsWith(suffix))
    ))
    if (suffixMatches.length === 1) return clonePricingEntry(suffixMatches[0])
  }

  return null
}

export function findBuiltinPricingCatalogEntriesByModelId(
  apiType: PricingApiType,
  modelId: string,
): BuiltinPricingCatalogEntry[] {
  const loaded = loadPricingCatalog()
  const key = `${apiType}::${modelId}`
  const group = loaded.byModelId.get(key) || []
  return group.map(clonePricingEntry)
}
