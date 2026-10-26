import type { AiProviderAdapter } from '@/lib/ai-providers/runtime-types'
import { describeMediaVariantBase } from '@/lib/ai-providers/shared/media-adapter'
import { openRouterConnectionTester } from './connection-test'
import { executeOpenRouterImageGeneration } from './image'
import {
  createOpenRouterLanguageModel,
  validateOpenRouterLanguageModelResult,
} from './language-model'
import { resolveOpenRouterOptionSchema } from './models'
import { buildOpenRouterSessionId, normalizeOpenRouterSessionId } from './session'
import { executeOpenRouterVideoGeneration } from './video'
import { openRouterFailureAdapter } from './error-normalization'

function describeOpenRouterMediaVariant(
  modality: 'image' | 'video',
  selection: Parameters<NonNullable<AiProviderAdapter['image']>['describe']>[0],
) {
  return describeMediaVariantBase({
    modality,
    selection,
    executionMode: modality === 'image' ? 'sync' : 'async',
    optionSchema: resolveOpenRouterOptionSchema(modality, selection.modelId, selection.provider),
  })
}

export const openRouterAdapter: AiProviderAdapter = {
  providerKey: 'openrouter',
  failure: openRouterFailureAdapter,
  image: {
    describe: (selection) => describeOpenRouterMediaVariant('image', selection),
    execute: executeOpenRouterImageGeneration,
  },
  languageModel: {
    create: createOpenRouterLanguageModel,
    validateResult: validateOpenRouterLanguageModelResult,
  },
  connectionTest: openRouterConnectionTester,
  resolveLlmSessionId: (input) => normalizeOpenRouterSessionId(input.explicitSessionId)
    ?? buildOpenRouterSessionId({
      kind: input.kind,
      userId: input.userId,
      projectId: input.projectId,
      action: input.action,
      modelKey: input.modelKey,
    }),
  video: {
    describe: (selection) => describeOpenRouterMediaVariant('video', selection),
    execute: executeOpenRouterVideoGeneration,
  },
}
