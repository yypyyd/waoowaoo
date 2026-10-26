import { HTTPClient, OpenRouter } from '@openrouter/sdk'
import type {
  ImageGenerationResponse,
  ImageGenerationUsage,
  ImageStreamingResponseData,
} from '@openrouter/sdk/models'
import {
  BadRequestResponseError,
  ForbiddenResponseError,
  NotFoundResponseError,
  PayloadTooLargeResponseError,
  PaymentRequiredResponseError,
  UnauthorizedResponseError,
} from '@openrouter/sdk/models/errors'
import { createScopedLogger } from '@/lib/logging/core'
import { AppError } from '@/lib/errors/app-error'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import {
  decodeBase64WithLimit,
  MAX_IMAGE_BYTES,
} from '@/lib/http/body-limits'
import { requireSelectedModelId } from '@/lib/ai-providers/shared/model-selection'
import type {
  AiProviderImageExecutionContext,
  GenerateResult,
} from '@/lib/ai-providers/runtime-types'
import {
  resolveOpenRouterImageInput,
  type OpenRouterImageOptions,
} from './image-options'
import {
  OPENROUTER_IMAGE_MODEL_IDS,
  resolveOpenRouterCatalogImageModelId,
} from './models'
import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'
import {
  classifyOpenRouterMachineErrorCode,
  OPENROUTER_CONTENT_POLICY_REJECTION_MESSAGE,
  throwNormalizedOpenRouterSdkError,
} from './error-normalization'

const OPENROUTER_IMAGE_TIMEOUT_MS = 5 * 60 * 1000

function requireOpenRouterBaseUrl(baseUrl: string | undefined): string {
  const normalized = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  if (!normalized) throw new Error('PROVIDER_BASE_URL_MISSING: openrouter (image)')
  return normalized
}

function resolveResponseMediaType(
  mediaTypeValue: string | undefined,
  outputFormat: string,
): string {
  const mediaType = mediaTypeValue?.trim().toLowerCase() ?? ''
  if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp') {
    return mediaType
  }
  if (!mediaType) {
    if (outputFormat === 'jpeg') return 'image/jpeg'
    if (outputFormat === 'webp') return 'image/webp'
    if (outputFormat === 'png') return 'image/png'
  }
  throw new Error(`OPENROUTER_IMAGE_RESPONSE_MEDIA_TYPE_UNSUPPORTED: ${mediaType}`)
}

function isProviderAccountHardLimit(error: unknown): boolean {
  return error instanceof BadRequestResponseError
    && error.error.message.trim().toLowerCase() === 'billing hard limit has been reached.'
}

function isStructuredImageSubmissionRejection(error: unknown): boolean {
  return error instanceof BadRequestResponseError
    || error instanceof UnauthorizedResponseError
    || error instanceof PaymentRequiredResponseError
    || error instanceof ForbiddenResponseError
    || error instanceof NotFoundResponseError
    || error instanceof PayloadTooLargeResponseError
}

function throwStructuredImageSubmissionRejection(error: unknown): never {
  try {
    throwNormalizedOpenRouterSdkError(error)
  } catch (normalized) {
    const failure = normalized instanceof AppError
      ? normalized
      : new AppError('PROVIDER_SUBMISSION_REJECTED', 'OpenRouter rejected the image request', {
          provider: 'openrouter',
          details: error instanceof Error ? { diagnostic: error.message.slice(0, 1_000) } : null,
          cause: error,
        })
    throw new ProviderSubmissionError(failure.code, failure.message, {
      disposition: 'rejected',
      provider: 'openrouter',
      details: failure.details,
      cause: normalized,
    })
  }
}

function createOpenRouterImageClient(input: {
  baseUrl: string
  apiKey: string
}): OpenRouter {
  return new OpenRouter({
    apiKey: input.apiKey,
    serverURL: input.baseUrl,
    httpClient: new HTTPClient({
      fetcher: async (requestInput, requestInit) => (
        await fetchWithProviderProxy(requestInput, requestInit)
      ),
    }),
    retryConfig: { strategy: 'none' },
    timeoutMs: OPENROUTER_IMAGE_TIMEOUT_MS,
  })
}

function projectOpenRouterUsage(
  usage: ImageGenerationUsage | undefined,
): Record<string, unknown> | null {
  if (!usage) return null
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  }
}

function projectCompletedImage(input: {
  imageBase64: string
  mediaType?: string
  outputFormat: string
  usage?: ImageGenerationUsage
}): GenerateResult {
  decodeBase64WithLimit(input.imageBase64, MAX_IMAGE_BYTES, 'OpenRouter generated image')
  const mediaType = resolveResponseMediaType(input.mediaType, input.outputFormat)
  const usage = projectOpenRouterUsage(input.usage)
  return {
    success: true,
    imageBase64: input.imageBase64,
    imageUrl: `data:${mediaType};base64,${input.imageBase64}`,
    ...(usage ? { metadata: { openRouterUsage: usage } } : {}),
  }
}

function projectBufferedImage(
  response: ImageGenerationResponse,
  outputFormat: string,
): GenerateResult {
  if (response.data.length !== 1) {
    throw new Error(`OPENROUTER_IMAGE_RESPONSE_IMAGE_COUNT_INVALID: ${response.data.length}`)
  }
  const image = response.data[0]
  if (!image) throw new Error('OPENROUTER_IMAGE_RESPONSE_MISSING_IMAGE')
  return projectCompletedImage({
    imageBase64: image.b64Json,
    mediaType: image.mediaType,
    outputFormat,
    usage: response.usage,
  })
}

async function projectStreamingImage(
  response: ReadableStream<ImageStreamingResponseData>,
  outputFormat: string,
): Promise<GenerateResult> {
  let completed: Extract<
    ImageStreamingResponseData,
    { type: 'image_generation.completed' }
  > | null = null

  for await (const event of response) {
    if (event.type === 'image_generation.partial_image') {
      decodeBase64WithLimit(event.b64Json, MAX_IMAGE_BYTES, 'OpenRouter partial image')
      continue
    }
    if (event.type === 'image_generation.completed') {
      if (completed) throw new Error('OPENROUTER_IMAGE_STREAM_DUPLICATE_COMPLETED')
      completed = event
      continue
    }
    if (event.type === 'error') {
      const code = event.error.code?.trim() || 'unknown'
      const errorCode = classifyOpenRouterMachineErrorCode(code)
      throw new ProviderSubmissionError(
        errorCode ?? 'PROVIDER_SUBMISSION_REJECTED',
        errorCode === 'SENSITIVE_CONTENT'
          ? OPENROUTER_CONTENT_POLICY_REJECTION_MESSAGE
          : event.error.message,
        {
          disposition: 'rejected',
          provider: 'openrouter',
          details: { providerErrorType: code },
          context: { system: 'provider', provider: 'openrouter', phase: 'result' },
          cause: event,
        },
      )
    }
    throw new Error(`OPENROUTER_IMAGE_STREAM_EVENT_UNSUPPORTED: ${String(event.type)}`)
  }

  if (!completed) throw new Error('OPENROUTER_IMAGE_RESPONSE_MISSING_IMAGE')
  return projectCompletedImage({
    imageBase64: completed.b64Json,
    mediaType: completed.mediaType,
    outputFormat,
    usage: completed.usage,
  })
}

export async function requestOpenRouterImage(input: {
  baseUrl: string
  apiKey: string
  modelId: string
  prompt: string
  options: OpenRouterImageOptions
}): Promise<GenerateResult> {
  if (!input.apiKey.trim()) throw new AppError('PROVIDER_AUTH_INVALID', undefined, { provider: 'openrouter' })
  const catalogModelId = resolveOpenRouterCatalogImageModelId(input.modelId)
  if (!catalogModelId || !OPENROUTER_IMAGE_MODEL_IDS.has(catalogModelId)) {
    throw new Error(`OPENROUTER_IMAGE_MODEL_UNSUPPORTED: ${input.modelId}`)
  }
  const resolved = await resolveOpenRouterImageInput({ ...input, modelId: catalogModelId })
  const logger = createScopedLogger({
    module: 'worker.openrouter-image',
    action: 'openrouter_image_generate',
  })
  logger.info({
    message: 'OpenRouter image generation request',
    details: {
      modelId: catalogModelId,
      requestedModelId: input.modelId,
      size: resolved.size,
      quality: resolved.quality,
      outputFormat: resolved.outputFormat,
      referenceImagesCount: resolved.referenceImagesCount,
    },
  })

  const openRouter = createOpenRouterImageClient(input)
  try {
    const response = await openRouter.images.generate({
      imageGenerationRequest: {
        model: catalogModelId,
        ...resolved.request,
        stream: resolved.stream,
      },
    })
    return response instanceof ReadableStream
      ? await projectStreamingImage(response, resolved.outputFormat)
      : projectBufferedImage(response, resolved.outputFormat)
  } catch (error) {
    if (isProviderAccountHardLimit(error)) {
      throw new ProviderSubmissionError(
        'PROVIDER_BILLING_REQUIRED',
        'OpenRouter upstream provider account reached its billing hard limit before accepting the image request',
        {
          disposition: 'pre_accept_rejected',
          provider: 'openrouter',
          cause: error,
        },
      )
    }
    if (isStructuredImageSubmissionRejection(error)) {
      throwStructuredImageSubmissionRejection(error)
    }
    throwNormalizedOpenRouterSdkError(error)
  }
}

export async function executeOpenRouterImageGeneration(
  input: AiProviderImageExecutionContext,
): Promise<GenerateResult> {
  const { apiKey, baseUrl } = input.providerConfig
  const modelId = requireSelectedModelId(input.selection, 'openrouter:image')
  return await requestOpenRouterImage({
    baseUrl: requireOpenRouterBaseUrl(baseUrl),
    apiKey,
    modelId,
    prompt: input.prompt,
    options: input.options as OpenRouterImageOptions,
  })
}
