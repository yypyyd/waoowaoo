'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import { editionClient } from '@/lib/edition/current/client'
import { getModelSlotTypesByTier } from '@/lib/ai-registry/media-model-selection'
import type { WorkflowConcurrencyConfig } from '@/lib/workflow-concurrency'
import { useLocale } from 'next-intl'
import { getProviderDisplayName, useProviders } from '../api-config'
import { ApiConfigToolbar } from './ApiConfigToolbar'
import { ApiConfigProviderList } from './ApiConfigProviderList'
import { ModelSlotCard } from './ModelSlotCard'
import { useApiConfigFilters } from './hooks/useApiConfigFilters'

export function ApiConfigTabContainer() {
  const locale = useLocale()
  const {
    providers,
    models,
    defaultModels,
    workflowConcurrency,
    capabilityDefaults,
    fixedParameterFields,
    loading,
    saveStatus,
    saveError,
    updateProviderApiKey,
    updateProviderBaseUrl,
    addProvider,
    reorderProviders,
    deleteProvider,
    selectSlotModel,
    deleteModel,
    addModel,
    updateModel,
    updateWorkflowConcurrency,
    updateCapabilityDefault,
  } = useProviders()

  const t = useTranslations('apiConfig')
  const tc = useTranslations('common')
  const saveFailedLabel = saveError?.code === 'PROVIDER_NOT_SUPPORTED' && saveError.providerId
    ? t('saveFailedProviderUnsupported', {
      provider: getProviderDisplayName(saveError.providerId, locale),
    })
    : t('saveFailed')

  const savingState =
    saveStatus === 'saving'
      ? resolveTaskPresentationState({
        phase: 'processing',
        intent: 'modify',
        resource: 'text',
        hasOutput: true,
      })
      : null

  const {
    modelProviders,
    getModelsForProvider,
    getSlotOptions,
    getSlotSelection,
  } = useApiConfigFilters({ providers, models, defaultModels })

  const handleWorkflowConcurrencyChange = useCallback(
    (field: keyof WorkflowConcurrencyConfig, rawValue: string) => {
      const parsed = Number.parseInt(rawValue, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) return
      updateWorkflowConcurrency(field, parsed)
    },
    [updateWorkflowConcurrency],
  )

  const ConcurrencyPanel = editionClient.ApiConfigConcurrency
  if (workflowConcurrency && !ConcurrencyPanel) {
    throw new Error('API_CONFIG_CONCURRENCY_EDITION_MISMATCH')
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[var(--glass-text-tertiary)]">
        {tc('loading')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ApiConfigToolbar
        title={t('title')}
        saveStatus={saveStatus}
        savingState={savingState}
        savingLabel={t('saving')}
        savedLabel={t('saved')}
        saveFailedLabel={saveFailedLabel}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-6 p-6">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {getModelSlotTypesByTier('core').map((type) => (
              <ModelSlotCard
                key={type}
                type={type}
                options={getSlotOptions(type)}
                selection={getSlotSelection(type)}
                onSelect={selectSlotModel}
                t={t}
                fixedParameterFields={fixedParameterFields}
                capabilityDefaults={capabilityDefaults}
                onFixedParameterChange={updateCapabilityDefault}
              />
            ))}
          </div>

          {workflowConcurrency && ConcurrencyPanel && (
            <ConcurrencyPanel value={workflowConcurrency} onChange={handleWorkflowConcurrencyChange} />
          )}

          <ApiConfigProviderList
            modelProviders={modelProviders}
            allModels={models}
            defaultModels={defaultModels}
            getModelsForProvider={getModelsForProvider}
            onUpdateApiKey={updateProviderApiKey}
            onUpdateBaseUrl={updateProviderBaseUrl}
            onAddProvider={addProvider}
            onReorderProviders={reorderProviders}
            onDeleteModel={deleteModel}
            onUpdateModel={updateModel}
            onDeleteProvider={deleteProvider}
            onAddModel={addModel}
            labels={{
              providerPool: t('providerPool'),
              providerPoolHint: t('providerPoolHint'),
              dragToSort: t('dragToSort'),
              moreProviders: t('moreProviders'),
              addPlatform: t('addPlatform'),
              addPlatformHint: t('addPlatformHint'),
              platformName: t('platformName'),
              platformNamePlaceholder: t('platformNamePlaceholder'),
              platformBaseUrlPlaceholder: t('platformBaseUrlPlaceholder'),
              platformApiKeyPlaceholder: t('platformApiKeyPlaceholder'),
              createPlatform: t('createPlatform'),
              platformNameRequired: t('platformNameRequired'),
              baseUrlInvalid: t('baseUrlInvalid'),
              cancel: t('cancel'),
            }}
          />
        </div>
      </div>
    </div>
  )
}
