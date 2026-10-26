'use client'

import { useState, useMemo } from 'react'
import {
  encodeModelKey,
  getProviderTutorial,
  matchesModelKey,
} from '../../types'
import type {
  ModelFormState,
  ProviderCardGroupedModels,
  ProviderCardModelType,
  ProviderCardProps,
  ProviderCardTranslator,
} from '../types'
import type { CustomModel } from '../../types'
import { useToast } from '@/contexts/ToastContext'

interface UseProviderCardStateParams {
  provider: ProviderCardProps['provider']
  models: ProviderCardProps['models']
  allModels?: ProviderCardProps['allModels']
  defaultModels: ProviderCardProps['defaultModels']
  onUpdateApiKey: ProviderCardProps['onUpdateApiKey']
  onUpdateBaseUrl: ProviderCardProps['onUpdateBaseUrl']
  onUpdateModel: ProviderCardProps['onUpdateModel']
  onAddModel: ProviderCardProps['onAddModel']
  t: ProviderCardTranslator
}

const EMPTY_MODEL_FORM: ModelFormState = {
  name: '',
  modelId: '',
}

export function buildProviderCardGroupedModels(
  models: CustomModel[],
): ProviderCardGroupedModels {
  const groupedModels: ProviderCardGroupedModels = {}
  for (const model of models) {
    const groupedType = model.type
    if (!groupedModels[groupedType]) {
      groupedModels[groupedType] = []
    }
    groupedModels[groupedType]!.push(model)
  }
  return groupedModels
}

export interface UseProviderCardStateResult {
  isPresetProvider: boolean
  tutorial: ReturnType<typeof getProviderTutorial>
  groupedModels: ProviderCardGroupedModels
  isEditing: boolean
  tempKey: string
  isEditingBaseUrl: boolean
  tempBaseUrl: string
  showTutorial: boolean
  showAddForm: ProviderCardModelType | null
  newModel: ModelFormState
  editingModelId: string | null
  editModel: ModelFormState
  isPresetModel: (modelKey: string) => boolean
  isDefaultModel: (model: CustomModel) => boolean
  setShowTutorial: (value: boolean) => void
  setShowAddForm: (value: ProviderCardModelType | null) => void
  setNewModel: (value: ModelFormState) => void
  setEditModel: (value: ModelFormState) => void
  setTempKey: (value: string) => void
  startEditKey: () => void
  handleSaveKey: () => void
  handleCancelEdit: () => void
  startEditBaseUrl: () => void
  setTempBaseUrl: (value: string) => void
  handleSaveBaseUrl: () => void
  handleCancelEditBaseUrl: () => void
  handleEditModel: (model: CustomModel) => void
  handleCancelEditModel: () => void
  handleSaveModel: (originalModelKey: string) => Promise<void>
  handleAddModel: (type: ProviderCardModelType) => Promise<void>
  handleCancelAdd: () => void
  isModelSavePending: boolean
}

export function useProviderCardState({
  provider,
  models,
  allModels,
  defaultModels,
  onUpdateApiKey,
  onUpdateBaseUrl,
  onUpdateModel,
  onAddModel,
  t,
}: UseProviderCardStateParams): UseProviderCardStateResult {
  const { showToast } = useToast()
  const [isEditing, setIsEditing] = useState(false)
  const [tempKey, setTempKey] = useState(provider.apiKey || '')
  const [isEditingBaseUrl, setIsEditingBaseUrl] = useState(false)
  const [tempBaseUrl, setTempBaseUrl] = useState(provider.baseUrl || '')
  const [showTutorial, setShowTutorial] = useState(false)
  const [showAddForm, setShowAddForm] = useState<ProviderCardModelType | null>(null)
  const [newModel, setNewModel] = useState<ModelFormState>(EMPTY_MODEL_FORM)
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [editModel, setEditModel] = useState<ModelFormState>(EMPTY_MODEL_FORM)
  const [isModelSavePending, setIsModelSavePending] = useState(false)

  const isPresetProvider = !provider.id.includes(':')
  const tutorial = getProviderTutorial(provider.id)

  const groupedModels = useMemo(
    () => buildProviderCardGroupedModels(models),
    [models],
  )

  const isPresetModel = () => false

  const isDefaultModel = (model: CustomModel) => (
    model.type === 'llm'
      ? matchesModelKey(defaultModels.assistantModel, model.provider, model.modelId)
      : model.enabled
  )

  const startEditKey = () => {
    setTempKey('')
    setIsEditing(true)
  }

  const handleSaveKey = () => {
    if (!tempKey.trim()) {
      showToast(t('enterApiKey'), 'warning')
      return
    }
    onUpdateApiKey(provider.id, tempKey.trim())
    setTempKey('')
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setTempKey('')
    setIsEditing(false)
  }

  const startEditBaseUrl = () => {
    setTempBaseUrl(provider.baseUrl || '')
    setIsEditingBaseUrl(true)
  }

  const handleSaveBaseUrl = () => {
    const value = tempBaseUrl.trim()
    if (value) {
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('PROTOCOL_INVALID')
        }
      } catch {
        showToast(t('baseUrlInvalid'), 'warning')
        return
      }
    }
    onUpdateBaseUrl(provider.id, value)
    setIsEditingBaseUrl(false)
  }

  const handleCancelEditBaseUrl = () => {
    setTempBaseUrl(provider.baseUrl || '')
    setIsEditingBaseUrl(false)
  }

  const handleEditModel = (model: CustomModel) => {
    setEditingModelId(model.modelKey)
    setEditModel({
      name: model.name,
      modelId: model.modelId,
    })
  }

  const handleCancelEditModel = () => {
    setEditingModelId(null)
    setEditModel(EMPTY_MODEL_FORM)
  }

  const handleSaveModel = async (originalModelKey: string): Promise<void> => {
    if (isModelSavePending) return
    if (!editModel.name || !editModel.modelId) {
      showToast(t('fillComplete'), 'warning')
      return
    }

    const nextModelKey = encodeModelKey(provider.id, editModel.modelId)
    const all = allModels || models
    const duplicate = all.some(
      (model) =>
        model.modelKey === nextModelKey &&
        model.modelKey !== originalModelKey,
    )

    if (duplicate) {
      showToast(t('modelIdExists'), 'warning')
      return
    }

    setIsModelSavePending(true)
    try {
      onUpdateModel?.(originalModelKey, {
        name: editModel.name,
        modelId: editModel.modelId,
      })

      handleCancelEditModel()
    } finally {
      setIsModelSavePending(false)
    }
  }

  const handleAddModel = async (type: ProviderCardModelType): Promise<void> => {
    if (isModelSavePending) return
    if (!newModel.name || !newModel.modelId) {
      showToast(t('fillComplete'), 'warning')
      return
    }

    const finalModelId = newModel.modelId
    const finalModelKey = encodeModelKey(provider.id, finalModelId)

    const all = allModels || models
    if (all.some((model) => model.modelKey === finalModelKey)) {
      showToast(t('modelIdExists'), 'warning')
      return
    }

    setIsModelSavePending(true)
    try {
      onAddModel({
        modelId: finalModelId,
        modelKey: finalModelKey,
        name: newModel.name,
        type,
        provider: provider.id,
      })

      setNewModel(EMPTY_MODEL_FORM)
      setShowAddForm(null)
    } finally {
      setIsModelSavePending(false)
    }
  }

  const handleCancelAdd = () => {
    setShowAddForm(null)
    setNewModel(EMPTY_MODEL_FORM)
  }

  return {
    isPresetProvider,
    tutorial,
    groupedModels,
    isEditing,
    tempKey,
    isEditingBaseUrl,
    tempBaseUrl,
    showTutorial,
    showAddForm,
    newModel,
    editingModelId,
    editModel,
    isPresetModel,
    isDefaultModel,
    setShowTutorial,
    setShowAddForm,
    setNewModel,
    setEditModel,
    setTempKey,
    startEditKey,
    handleSaveKey,
    handleCancelEdit,
    startEditBaseUrl,
    setTempBaseUrl,
    handleSaveBaseUrl,
    handleCancelEditBaseUrl,
    handleEditModel,
    handleCancelEditModel,
    handleSaveModel,
    handleAddModel,
    handleCancelAdd,
    isModelSavePending,
  }
}
