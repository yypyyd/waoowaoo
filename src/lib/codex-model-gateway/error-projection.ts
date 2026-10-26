import { resolveAiProviderAdapter } from '@/lib/ai-providers'
import {
  ProviderHttpError,
  readProviderJsonResponse,
} from '@/lib/ai-providers/failure'
import { getDeploymentConfig } from '@/lib/deployment/config'
import { EXTERNAL_OPERATION } from '@/lib/external-operation/registry'
import type { UnifiedErrorCode } from '@/lib/errors/codes'
import {
  augmentFailureRecord,
  projectProviderCredentialOwnership,
  type FailureRecord,
} from '@/lib/errors/failure'

const CODEX_PROVIDER_ERROR_MAX_BYTES = 64 * 1024

export type CodexProviderFailureKind =
  | 'billing_required'
  | 'configuration_unavailable'
  | 'context_exceeded'
  | 'policy_rejected'
  | 'rate_limited'
  | 'request_rejected'
  | 'temporarily_unavailable'

export type CodexProviderResponseProjection = {
  readonly response: Response
  readonly failureKind: CodexProviderFailureKind | null
  readonly providerStatus: number
  readonly providerCode: string | null
  readonly providerErrorType: string | null
  readonly failure: FailureRecord | null
}

type ProviderErrorMetadata = {
  readonly code: string | null
  readonly type: string | null
  readonly errorType: string | null
  readonly providerCode: string | null
  readonly message: string | null
  readonly source: ProviderHttpError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function projectTransparentProviderResponse(
  response: Response,
  body: BodyInit | null = response.body,
): Response {
  const headers = new Headers()
  const contentType = response.headers.get('content-type')?.trim()
  const retryAfter = response.headers.get('retry-after')?.trim()
  if (contentType) headers.set('Content-Type', contentType)
  if (retryAfter) headers.set('Retry-After', retryAfter)
  headers.set('Cache-Control', 'no-store')
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function boundedProviderErrorToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized && normalized.length <= 128 ? normalized : null
}

function boundedProviderErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .trim()
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?[redacted]')
    .replace(/([?&](?:token|signature|credential|key|secret)=)[^&\s]*/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[-_]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
  return normalized ? normalized.slice(0, 2_000) : null
}

function readNestedProviderError(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null
  } catch {
    return null
  }
}

async function readProviderErrorMetadata(response: Response): Promise<ProviderErrorMetadata> {
  let parsed: unknown
  try {
    parsed = await readProviderJsonResponse({
      response,
      provider: 'openrouter',
      phase: 'submit',
      maxBytes: CODEX_PROVIDER_ERROR_MAX_BYTES,
    })
  } catch (error: unknown) {
    if (!(error instanceof ProviderHttpError)) throw error
    return {
      code: null,
      type: null,
      errorType: null,
      providerCode: null,
      message: error.message,
      source: error,
    }
  }
  const root = isRecord(parsed) ? parsed : null
  const error = isRecord(root?.error) ? root.error : null
  const errorMetadata = isRecord(error?.metadata) ? error.metadata : null
  const topLevelMetadata = isRecord(root?.metadata) ? root.metadata : null
  const nestedProviderError = readNestedProviderError(errorMetadata?.raw)
  const code = boundedProviderErrorToken(error?.code)
    ?? boundedProviderErrorToken(nestedProviderError?.code)
  const type = boundedProviderErrorToken(error?.type)
    ?? boundedProviderErrorToken(nestedProviderError?.type)
  const errorType = boundedProviderErrorToken(root?.error_type)
    ?? boundedProviderErrorToken(error?.error_type)
    ?? boundedProviderErrorToken(errorMetadata?.error_type)
    ?? boundedProviderErrorToken(topLevelMetadata?.error_type)
    ?? boundedProviderErrorToken(nestedProviderError?.error_type)
  const providerCode = boundedProviderErrorToken(errorMetadata?.provider_code)
    ?? boundedProviderErrorToken(errorMetadata?.provider_error_code)
    ?? boundedProviderErrorToken(topLevelMetadata?.provider_code)
    ?? boundedProviderErrorToken(topLevelMetadata?.provider_error_code)
    ?? boundedProviderErrorToken(nestedProviderError?.code)
  const message = boundedProviderErrorMessage(nestedProviderError?.message)
    ?? boundedProviderErrorMessage(error?.message)
    ?? boundedProviderErrorMessage(root?.message)
  const source = new ProviderHttpError({
    provider: 'openrouter',
    phase: 'submit',
    statusCode: response.status,
    requestId: response.headers.get('x-request-id')?.trim()
      || response.headers.get('x-oai-request-id')?.trim()
      || response.headers.get('cf-ray')?.trim()
      || null,
    code: providerCode ?? code ?? errorType ?? type,
    contentType: response.headers.get('content-type')?.trim() || null,
    errorEnvelope: parsed,
    diagnosticText: message,
  })
  return { code, type, errorType, providerCode, message, source }
}

function unifiedCodeForFailure(
  kind: CodexProviderFailureKind,
  providerStatus: number,
): UnifiedErrorCode {
  switch (kind) {
    case 'billing_required':
      return 'PROVIDER_BILLING_REQUIRED'
    case 'configuration_unavailable':
      return providerStatus === 404 ? 'MODEL_NOT_OPEN' : 'PROVIDER_AUTH_INVALID'
    case 'context_exceeded':
      return 'CONTEXT_BUDGET_EXCEEDED'
    case 'policy_rejected':
      return 'SENSITIVE_CONTENT'
    case 'rate_limited':
      return 'RATE_LIMIT'
    case 'request_rejected':
      return 'PROVIDER_SUBMISSION_REJECTED'
    case 'temporarily_unavailable':
      return 'EXTERNAL_ERROR'
  }
}

function capturedFailure(input: {
  readonly metadata: ProviderErrorMetadata
  readonly kind: CodexProviderFailureKind
  readonly providerStatus: number
}): FailureRecord {
  const normalized = resolveAiProviderAdapter('openrouter').failure.normalize({
    error: input.metadata.source,
    phase: 'submit',
    operation: EXTERNAL_OPERATION.PROVIDER_SUBMIT,
  })
  const projected = augmentFailureRecord(normalized, {
    code: unifiedCodeForFailure(input.kind, input.providerStatus),
    details: {
      providerStatus: input.providerStatus,
      providerCode: input.metadata.providerCode ?? input.metadata.code ?? input.metadata.type,
      providerErrorType: input.metadata.errorType,
    },
  })
  return projectProviderCredentialOwnership(
    projected,
    getDeploymentConfig().providerCredentialMode,
  )
}

function failedProjection(input: Omit<CodexProviderResponseProjection, 'failure'> & {
  readonly metadata: ProviderErrorMetadata
}): CodexProviderResponseProjection {
  if (!input.failureKind) throw new Error('CODEX_PROVIDER_FAILURE_KIND_REQUIRED')
  return {
    response: input.response,
    failureKind: input.failureKind,
    providerStatus: input.providerStatus,
    providerCode: input.providerCode,
    providerErrorType: input.providerErrorType,
    failure: capturedFailure({
      metadata: input.metadata,
      kind: input.failureKind,
      providerStatus: input.providerStatus,
    }),
  }
}

function canonicalCodexErrorResponse(params: {
  readonly source: Response
  readonly status: 400 | 429 | 500 | 503
  readonly type: string
  readonly code: string
  readonly message: string | null
}): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  })
  const retryAfter = params.source.headers.get('retry-after')?.trim()
  if (retryAfter) headers.set('Retry-After', retryAfter)
  return Response.json({
    error: {
      type: params.type,
      code: params.code,
      message: params.message ?? params.code,
    },
  }, { status: params.status, headers })
}

function canonicalCodexStreamFailureResponse(params: {
  readonly code: string
  readonly message: string | null
}): Response {
  const event = {
    type: 'response.failed',
    sequence_number: 0,
    response: {
      id: 'resp_wao_gateway_failure',
      object: 'response',
      created_at: 0,
      status: 'failed',
      background: false,
      error: {
        code: params.code,
        message: params.message ?? params.code,
      },
      incomplete_details: null,
      usage: null,
      metadata: {},
    },
  }
  return new Response(
    `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`,
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/event-stream',
      },
    },
  )
}

function hasProviderErrorToken(
  metadata: ProviderErrorMetadata,
  values: ReadonlySet<string>,
): boolean {
  return Boolean(
    (metadata.code && values.has(metadata.code))
    || (metadata.type && values.has(metadata.type))
    || (metadata.errorType && values.has(metadata.errorType))
    || (metadata.providerCode && values.has(metadata.providerCode))
  )
}

const PROVIDER_BILLING_ERROR_TOKENS = new Set([
  'billing_required',
  'insufficient_balance',
  'insufficient_credits',
  'insufficient_quota',
  'payment_required',
  'usage_not_included',
])

const PROVIDER_POLICY_ERROR_TOKENS = new Set([
  'content_policy_violation',
  'cyber_policy',
  'policy_violation',
])

const PROVIDER_CONTEXT_ERROR_TOKENS = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'max_tokens_exceeded',
  'string_too_long',
  'token_limit_exceeded',
])

const PROVIDER_OVERLOAD_ERROR_TOKENS = new Set([
  'overloaded',
  'provider_overloaded',
  'provider_unavailable',
  'server_is_overloaded',
  'slow_down',
])

/**
 * Project every Provider failure into the error vocabulary supported by the
 * pinned official Codex app-server. This is the sole Provider adaptation
 * boundary: no Runtime fork, terminal side channel, or message parsing is used.
 */
export async function projectCodexProviderResponse(
  response: Response,
): Promise<CodexProviderResponseProjection> {
  const providerStatus = response.status
  if (response.ok) {
    return {
      response: projectTransparentProviderResponse(response),
      failureKind: null,
      providerStatus,
      providerCode: null,
      providerErrorType: null,
      failure: null,
    }
  }

  const metadata = await readProviderErrorMetadata(response)
  const providerCode = metadata.providerCode ?? metadata.code ?? metadata.type
  const providerErrorType = metadata.errorType
  if (
    providerStatus === 402
    || hasProviderErrorToken(metadata, PROVIDER_BILLING_ERROR_TOKENS)
  ) {
    return failedProjection({
      response: canonicalCodexErrorResponse({
        source: response,
        status: 429,
        type: 'usage_not_included',
        code: 'usage_not_included',
        message: metadata.message,
      }),
      failureKind: 'billing_required',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata,
    })
  }
  if (hasProviderErrorToken(metadata, PROVIDER_POLICY_ERROR_TOKENS)) {
    return failedProjection({
      response: canonicalCodexStreamFailureResponse({
        code: 'cyber_policy',
        message: metadata.message,
      }),
      failureKind: 'policy_rejected',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata,
    })
  }
  if (hasProviderErrorToken(metadata, PROVIDER_CONTEXT_ERROR_TOKENS)) {
    return failedProjection({
      response: canonicalCodexStreamFailureResponse({
        code: 'context_length_exceeded',
        message: metadata.message,
      }),
      failureKind: 'context_exceeded',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata,
    })
  }
  if (providerStatus === 429) {
    return failedProjection({
      response: projectTransparentProviderResponse(
        response,
        typeof metadata.source.errorEnvelope === 'string'
          ? metadata.source.errorEnvelope
          : JSON.stringify(metadata.source.errorEnvelope),
      ),
      failureKind: 'rate_limited',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata,
    })
  }
  if (hasProviderErrorToken(metadata, PROVIDER_OVERLOAD_ERROR_TOKENS)) {
    return failedProjection({
      response: canonicalCodexErrorResponse({
        source: response,
        status: 503,
        type: 'server_error',
        code: 'slow_down',
        message: metadata.message,
      }),
      failureKind: 'temporarily_unavailable',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata,
    })
  }
  if (providerStatus === 401 || providerStatus === 403 || providerStatus === 404) {
    return failedProjection({
      response: canonicalCodexErrorResponse({
        source: response,
        status: 503,
        type: 'server_error',
        code: 'slow_down',
        message: metadata.message,
      }),
      failureKind: 'configuration_unavailable',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata,
    })
  }
  if (providerStatus >= 400 && providerStatus < 500) {
    // Some OpenAI-compatible relays (custom openrouter:* base URLs) reject
    // prompts under a content filter but answer with HTTP 400 + machine code
    // `server_error` and the prose "Invalid request parameter". Keep the
    // request_rejected kind (prose is not an oracle for SENSITIVE_CONTENT),
    // but replace that misleading diagnostic so the product View points at
    // input content rather than a bogus request-shape bug.
    const misleadingGatewayRejection = metadata.code === 'server_error'
      && typeof metadata.message === 'string'
      && metadata.message.trim().toLowerCase() === 'invalid request parameter'
    const diagnosticMessage = misleadingGatewayRejection
      ? 'Upstream gateway rejected the request. Some OpenAI-compatible relays report content-policy blocks as Invalid request parameter; revise the prompt or try another model.'
      : metadata.message
    return failedProjection({
      response: canonicalCodexErrorResponse({
        source: response,
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: diagnosticMessage,
      }),
      failureKind: 'request_rejected',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata: misleadingGatewayRejection
        ? { ...metadata, message: diagnosticMessage }
        : metadata,
    })
  }
  if (providerStatus >= 500) {
    return failedProjection({
      response: canonicalCodexErrorResponse({
        source: response,
        status: 503,
        type: 'server_error',
        code: 'slow_down',
        message: metadata.message,
      }),
      failureKind: 'temporarily_unavailable',
      providerStatus,
      providerCode,
      providerErrorType,
      metadata,
    })
  }
  return failedProjection({
    response: canonicalCodexErrorResponse({
      source: response,
      status: 500,
      type: 'server_error',
      code: 'provider_response_invalid',
      message: metadata.message,
    }),
    failureKind: 'temporarily_unavailable',
    providerStatus,
    providerCode,
    providerErrorType,
    metadata,
  })
}
