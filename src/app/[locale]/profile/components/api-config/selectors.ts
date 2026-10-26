import type { CustomModel, Provider } from './types'
import { encodeModelKey, getProviderKey, isPresetComingSoonModelKey } from './types'
import {
  type WorkflowConcurrencyConfig,
} from '@/lib/workflow-concurrency'

export interface DefaultModels {
  assistantModel?: string
}

export const DEFAULT_MODEL_FIELDS = ['assistantModel'] as const satisfies ReadonlyArray<keyof DefaultModels>

export function createInitialProviders(presetProviders: Provider[]): Provider[] {
  return presetProviders.map((provider) => ({
    ...provider,
    apiKey: '',
    hasApiKey: false,
  }))
}

export function createInitialModels(presetModels: ReadonlyArray<Omit<CustomModel, 'modelKey' | 'enabled'> & Partial<Pick<CustomModel, 'modelKey' | 'enabled'>>>): CustomModel[] {
  return presetModels.map((model) => {
    const modelKey = encodeModelKey(model.provider, model.modelId)
    return {
      ...model,
      modelKey,
      enabled: !isPresetComingSoonModelKey(modelKey),
    }
  })
}

export function mergeProvidersForDisplay(
  savedProviders: Provider[],
  presetProviders: Provider[],
): Provider[] {
  const merged: Provider[] = []
  const seenProviderIds = new Set<string>()
  const seenPresetKeys = new Set<string>()

  for (const savedProvider of savedProviders) {
    if (seenProviderIds.has(savedProvider.id)) continue
    seenProviderIds.add(savedProvider.id)

    const providerKey = getProviderKey(savedProvider.id)
    const matchedPreset = presetProviders.find((presetProvider) => presetProvider.id === providerKey)
    if (matchedPreset) {
      merged.push({
        ...matchedPreset,
        id: savedProvider.id,
        name: savedProvider.name || matchedPreset.name,
        hasApiKey: savedProvider.hasApiKey === true,
        baseUrl: savedProvider.baseUrl || matchedPreset.baseUrl,
      })
      if (savedProvider.id === matchedPreset.id) {
        seenPresetKeys.add(providerKey)
      }
      continue
    }

    merged.push({
      ...savedProvider,
      apiKey: undefined,
      hasApiKey: savedProvider.hasApiKey === true,
    })
  }

  for (const presetProvider of presetProviders) {
    if (seenPresetKeys.has(presetProvider.id)) continue
    merged.push({
      ...presetProvider,
      apiKey: '',
      hasApiKey: false,
    })
  }

  return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseWorkflowConcurrency(raw: unknown): WorkflowConcurrencyConfig | null {
  if (raw === null) return null
  if (!isRecord(raw)) throw new Error('WORKFLOW_CONCURRENCY_VIEW_INVALID')
  function readLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error('WORKFLOW_CONCURRENCY_VIEW_INVALID')
    }
    return value
  }
  return {
    analysis: readLimit(raw.analysis),
    image: readLimit(raw.image),
    video: readLimit(raw.video),
  }
}

export function normalizeSavedModels(savedModelsRaw: CustomModel[]): CustomModel[] {
  const savedModels: CustomModel[] = []
  const seen = new Set<string>()
  for (const model of savedModelsRaw) {
    const modelKey = model.modelKey || encodeModelKey(model.provider, model.modelId)
    if (seen.has(modelKey)) continue
    seen.add(modelKey)
    savedModels.push({ ...model, modelKey })
  }
  return savedModels
}

export function mergeModelsForDisplay(
  savedModelsRaw: CustomModel[],
  catalogModels: ReadonlyArray<Omit<CustomModel, 'modelKey' | 'enabled'> & Partial<Pick<CustomModel, 'modelKey' | 'enabled'>>>,
): CustomModel[] {
  const savedModels = normalizeSavedModels(savedModelsRaw)
  const hasSavedModels = savedModels.length > 0
  const catalogModelKeys = new Set(catalogModels.map((catalogModel) => encodeModelKey(catalogModel.provider, catalogModel.modelId)))

  const presetModels = catalogModels.map((preset) => {
    const presetModelKey = encodeModelKey(preset.provider, preset.modelId)
    const saved = savedModels.find((model) => model.modelKey === presetModelKey)
    const mergedPreset: CustomModel = {
      ...preset,
      modelKey: presetModelKey,
      enabled: isPresetComingSoonModelKey(presetModelKey)
        ? false
        : (hasSavedModels ? !!saved : false),
      capabilities: saved?.capabilities ?? preset.capabilities,
    }
    return mergedPreset
  })

  const customModels = savedModels
    .filter((model) => !catalogModelKeys.has(model.modelKey))
    .map((model) => ({
      ...model,
      enabled: model.enabled !== false,
    }))

  return [...presetModels, ...customModels]
}

export function replaceDefaultModelKey(
  defaultModels: DefaultModels,
  previousModelKey: string,
  nextModelKey: string,
): DefaultModels {
  const next = { ...defaultModels }
  for (const field of DEFAULT_MODEL_FIELDS) {
    if (next[field] === previousModelKey) next[field] = nextModelKey
  }
  return next
}

export function clearMissingDefaultModels(
  defaultModels: DefaultModels,
  remainingModelKeys: ReadonlySet<string>,
): DefaultModels {
  const next = { ...defaultModels }
  for (const field of DEFAULT_MODEL_FIELDS) {
    const current = next[field]
    if (current && !remainingModelKeys.has(current)) {
      next[field] = ''
    }
  }
  return next
}
