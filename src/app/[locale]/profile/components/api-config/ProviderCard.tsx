'use client'

import { useTranslations } from 'next-intl'
import { ProviderModelSections } from './provider-card/ProviderModelSections'
import { ProviderBaseFields } from './provider-card/ProviderBaseFields'
import { ProviderRowShell } from './provider-card/ProviderRowShell'
import { useProviderCardState } from './provider-card/hooks/useProviderCardState'
import type { ProviderCardProps } from './provider-card/types'

export function ProviderCard({
  provider,
  dragHandle,
  models,
  allModels,
  defaultModels,
  expanded,
  onExpandChange,
  onUpdateApiKey,
  onUpdateBaseUrl,
  onDeleteModel,
  onUpdateModel,
  onDeleteProvider,
  onAddModel,
}: ProviderCardProps) {
  const t = useTranslations('apiConfig')

  const state = useProviderCardState({
    provider,
    models,
    allModels,
    defaultModels,
    onUpdateApiKey,
    onUpdateBaseUrl,
    onUpdateModel,
    onAddModel,
    t,
  })

  return (
    <ProviderRowShell
      provider={provider}
      dragHandle={dragHandle}
      expanded={expanded}
      onExpandChange={onExpandChange}
      onDeleteProvider={onDeleteProvider}
      modelCount={models.length}
      t={t}
      state={state}
    >
      <ProviderBaseFields provider={provider} t={t} state={state} />
      <ProviderModelSections
        provider={provider}
        onDeleteModel={onDeleteModel}
        onUpdateModel={onUpdateModel}
        t={t}
        state={state}
      />
    </ProviderRowShell>
  )
}

export default ProviderCard
