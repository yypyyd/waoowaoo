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

function isOfficialOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'openrouter.ai'
  } catch {
    return false
  }
}

/**
 * Instantiated custom platforms (openrouter:<suffix>) are contracted in the
 * API-config UI as OpenAI-compatible relays ("中转/镜像站"), not as OpenRouter
 * protocol endpoints. The OpenRouter SDK Images API posts to {base}/images
 * with OpenRouter-only fields (provider pinning, SSE streaming events), which
 * those relays do not implement — they answer 404 {"code":1,"msg":"接口不存在"},
 * and the SDK then surfaces only "Response validation failed". Custom
 * instances on a non-official base URL must therefore use the
 * OpenAI-compatible Images API ({base}/images/generations) with the
 * user-configured model id sent verbatim.
 */
function usesOpenAiCompatibleImageTransport(input: {
  baseUrl: string
  providerId?: string
}): boolean {
  if (!input.providerId?.includes(':')) return false
  return !isOfficialOpenRouterBaseUrl(input.baseUrl)
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

type ResolvedOpenRouterImageInput = Awaited<ReturnType<typeof resolveOpenRouterImageInput>>

function readRelayErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null
  for (const candidate of [record.msg, record.message, error?.message, error?.msg]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 1_000)
  }
  return null
}

async function requestOpenAiCompatibleImage(input: {
  baseUrl: string
  apiKey: string
  modelId: string
  prompt: string
  resolved: ResolvedOpenRouterImageInput
}): Promise<GenerateResult> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const url = baseUrl.endsWith('/images/generations')
    ? baseUrl
    : `${baseUrl}/images/generations`
  const request = input.resolved.request as Record<string, unknown>
  const referenceUrls = Array.isArray(request.inputReferences)
    ? request.inputReferences
      .map((reference) => (reference as { imageUrl?: { url?: unknown } }).imageUrl?.url)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  const body: Record<string, unknown> = {
    model: input.modelId,
    prompt: input.prompt.trim(),
    n: 1,
    ...(typeof request.size === 'string' ? { size: request.size } : {}),
    ...(typeof request.quality === 'string' ? { quality: request.quality } : {}),
    ...(typeof request.resolution === 'string' ? { resolution: request.resolution } : {}),
    ...(typeof request.aspectRatio === 'string' ? { aspect_ratio: request.aspectRatio } : {}),
    ...(referenceUrls.length > 0 ? { image: referenceUrls } : {}),
  }

  const logger = createScopedLogger({
    module: 'worker.openrouter-image',
    action: 'openrouter_image_generate_openai_compatible',
  })
  logger.info({
    message: 'OpenAI-compatible image generation request (custom platform)',
    details: {
      modelId: input.modelId,
      size: input.resolved.size,
      quality: input.resolved.quality,
      outputFormat: input.resolved.outputFormat,
      referenceImagesCount: referenceUrls.length,
    },
  })

  const response = await fetchWithProviderProxy(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OPENROUTER_IMAGE_TIMEOUT_MS),
  })

  const responseText = await response.text()
  let payload: unknown = null
  try {
    payload = responseText ? JSON.parse(responseText) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const relayMessage = readRelayErrorMessage(payload)
      ?? (responseText.trim() ? responseText.trim().slice(0, 1_000) : `HTTP ${response.status}`)
    const code = response.status === 401 || response.status === 403
      ? 'PROVIDER_AUTH_INVALID' as const
      : response.status === 402
        ? 'PROVIDER_BILLING_REQUIRED' as const
        : response.status === 429
          ? 'RATE_LIMIT' as const
          : 'PROVIDER_SUBMISSION_REJECTED' as const
    const cause = new Error(
      `OpenAI-compatible image provider returned HTTP ${response.status}: ${relayMessage}`,
    )
    throw new ProviderSubmissionError(code, relayMessage, {
      disposition: 'rejected',
      provider: 'openrouter',
      details: { providerStatus: response.status },
      cause,
    })
  }

  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).data
    : null
  const first = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined
  if (!first) throw new Error('OPENAI_COMPATIBLE_IMAGE_RESPONSE_MISSING_IMAGE')
  if (typeof first.b64_json === 'string' && first.b64_json) {
    return projectCompletedImage({
      imageBase64: first.b64_json,
      mediaType: typeof first.media_type === 'string' ? first.media_type : undefined,
      outputFormat: input.resolved.outputFormat,
    })
  }
  if (typeof first.url === 'string' && first.url) {
    const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]+)$/.exec(first.url)
    if (dataUrlMatch) {
      return projectCompletedImage({
        imageBase64: dataUrlMatch[2] ?? '',
        mediaType: dataUrlMatch[1],
        outputFormat: input.resolved.outputFormat,
      })
    }
    return { success: true, imageUrl: first.url }
  }
  throw new Error('OPENAI_COMPATIBLE_IMAGE_RESPONSE_MISSING_IMAGE')
}

export async function requestOpenRouterImage(input: {
  baseUrl: string
  apiKey: string
  modelId: string
  prompt: string
  options: OpenRouterImageOptions
  providerId?: string
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

  if (usesOpenAiCompatibleImageTransport({ baseUrl: input.baseUrl, providerId: input.providerId })) {
    return await requestOpenAiCompatibleImage({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      // Custom relays register the model under the user-configured id
      // (gpt-image-2); do not rewrite it to the OpenRouter catalog id
      // (openai/gpt-image-2), which the relay does not know.
      modelId: input.modelId,
      prompt: input.prompt,
      resolved,
    })
  }

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
    providerId: input.selection.provider || input.providerConfig.id,
  })
}
