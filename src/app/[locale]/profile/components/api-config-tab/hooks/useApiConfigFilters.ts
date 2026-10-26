'use client'

import { useMemo } from 'react'
import type { UnifiedModelType } from '@/lib/ai-registry/types'
import { resolveSingleModelSelection } from '@/lib/ai-registry/media-model-selection'
import { encodeModelKey, parseModelKey, type CustomModel, type Provider } from '../../api-config'
import { isPresetComingSoonModelKey } from '../../api-config/types'
import type { DefaultModels } from '../../api-config/selectors'

export interface ModelSlotOption {
  modelKey: string
  name: string
  provider: string
  providerName: string
  providerHasKey: boolean
  comingSoon: boolean
}

export interface ModelSlotSelection {
  /** The model this slot currently uses; empty when the slot is unused. */
  modelKey: string
  /** Legacy configs may hold several models for one slot; the user must re-pick. */
  ambiguous: boolean
}

interface UseApiConfigFiltersParams {
  providers: Provider[]
  models: CustomModel[]
  defaultModels: DefaultModels
}

function hasProviderApiKey(provider: Provider | undefined): boolean {
  if (!provider) return false
  if (provider.hasApiKey === true) return true
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : ''
  return apiKey.length > 0
}

export function useApiConfigFilters({ providers, models, defaultModels }: UseApiConfigFiltersParams) {
  const providersById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider] as const)),
    [providers],
  )

  const modelProviders = useMemo(() => {
    const modelProviderIds = new Set(models.map((model) => model.provider))
    // Custom platform instances stay visible before their first model is added.
    return providers.filter((provider) => modelProviderIds.has(provider.id) || provider.id.includes(':'))
  }, [models, providers])

  /** Every model of a type, providers holding a key first so the pickable ones lead. */
  const slotOptionsByType = useMemo(() => {
    const grouped = new Map<UnifiedModelType, ModelSlotOption[]>()
    for (const model of models) {
      const provider = providersById.get(model.provider)
      const option: ModelSlotOption = {
        modelKey: model.modelKey,
        name: model.name,
        provider: model.provider,
        providerName: provider?.name || model.provider,
        providerHasKey: hasProviderApiKey(provider),
        comingSoon: isPresetComingSoonModelKey(model.modelKey),
      }
      const bucket = grouped.get(model.type)
      if (bucket) bucket.push(option)
      else grouped.set(model.type, [option])
    }
    for (const options of grouped.values()) {
      options.sort((left, right) => Number(right.providerHasKey) - Number(left.providerHasKey))
    }
    return grouped
  }, [models, providersById])

  const enabledModels = useMemo(() => models.filter((model) => model.enabled), [models])

  const assistantModelKey = useMemo(() => {
    const parsed = parseModelKey(defaultModels.assistantModel)
    return parsed ? encodeModelKey(parsed.provider, parsed.modelId) : ''
  }, [defaultModels.assistantModel])

  /**
   * The Assistant selection is the authority for the text slot; media slots read
   * their single enabled model. Both are written through one selection action.
   */
  const getSlotSelection = (type: UnifiedModelType): ModelSlotSelection => {
    if (type === 'llm') return { modelKey: assistantModelKey, ambiguous: false }
    const selection = resolveSingleModelSelection(enabledModels, type)
    if (selection.status === 'selected') return { modelKey: selection.model.modelKey, ambiguous: false }
    return { modelKey: '', ambiguous: selection.status === 'ambiguous' }
  }

  return {
    modelProviders,
    getModelsForProvider: (providerId: string) => models.filter((model) => model.provider === providerId),
    getSlotOptions: (type: UnifiedModelType): ModelSlotOption[] => slotOptionsByType.get(type) ?? [],
    getSlotSelection,
    assistantModelKey,
  }
}
