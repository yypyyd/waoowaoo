import type { AsyncTaskProviderRegistration, ParsedAsyncExternalId } from '@/lib/ai-providers/async-task-types'
import { normalizeAsyncPollResult } from '@/lib/ai-providers/async-task-types'
import {
  decodeCustomVideoRequestId,
  queryCustomPlatformVideoStatus,
  queryOpenRouterVideoStatus,
} from './video'

function parseOpenRouterExternalId(externalId: string): ParsedAsyncExternalId {
  const parts = externalId.split(':')
  const type = parts[1]
  const requestId = parts.slice(2).join(':')
  if (type !== 'VIDEO' || !requestId) {
    throw new Error(`无效 OPENROUTER externalId: "${externalId}"，应为 OPENROUTER:VIDEO:requestId`)
  }
  return {
    provider: 'OPENROUTER',
    type: 'VIDEO',
    requestId,
  }
}

export const openRouterAsyncTaskProvider: AsyncTaskProviderRegistration = {
  providerCode: 'OPENROUTER',
  providerKey: 'openrouter',
  canParseExternalId: (externalId) => externalId.startsWith('OPENROUTER:'),
  parseExternalId: parseOpenRouterExternalId,
  formatExternalId: (input) => `OPENROUTER:${input.type}:${input.requestId}`,
  poll: async ({ parsed, context }) => {
    // Custom-platform submissions encode their provider instance and model
    // in the request id; poll them with that instance's own config, not the
    // builtin OpenRouter provider config.
    const custom = decodeCustomVideoRequestId(parsed.requestId)
    if (custom) {
      const { apiKey, baseUrl } = await context.getProviderConfig(context.userId, custom.providerId)
      if (!baseUrl) {
        throw new Error(`PROVIDER_BASE_URL_MISSING: ${custom.providerId} (video)`)
      }
      const result = await queryCustomPlatformVideoStatus({
        baseUrl,
        apiKey,
        modelId: custom.modelId,
        jobId: custom.jobId,
      })
      return normalizeAsyncPollResult({
        status: result.status,
        ...(result.status === 'failed' ? { failure: result.failure } : {}),
        videoUrl: result.videoUrl,
        resultUrl: result.resultUrl,
        downloadHeaders: result.downloadHeaders,
      })
    }
    const { apiKey, baseUrl } = await context.getProviderConfig(context.userId, 'openrouter')
    if (!baseUrl) {
      throw new Error('PROVIDER_BASE_URL_MISSING: openrouter (video)')
    }
    const result = await queryOpenRouterVideoStatus({
      baseUrl,
      apiKey,
      requestId: parsed.requestId,
    })
    return normalizeAsyncPollResult({
      status: result.status,
      ...(result.status === 'failed' ? { failure: result.failure } : {}),
      videoUrl: result.videoUrl,
      resultUrl: result.resultUrl,
      downloadHeaders: result.downloadHeaders,
    })
  },
}
