import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requestOpenRouterImage } from '@/lib/ai-providers/openrouter/image'
import type { OpenRouterImageOptions } from '@/lib/ai-providers/openrouter/image-options'
import {
  OPENROUTER_BANANA_2_IMAGE_MODEL_ID,
  OPENROUTER_GPT_IMAGE_2_MODEL_ID,
  resolveOpenRouterOptionSchema,
} from '@/lib/ai-providers/openrouter/models'
import { AiOptionValidationError, normalizeAiOptions } from '@/lib/ai-exec/normalize'
import { startScenarioServer } from '../../helpers/fakes/scenario-server'
import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_1X1_DATA_URL = `data:image/png;base64,${PNG_1X1_BASE64}`

function normalizeImageOptions(options: Record<string, unknown>): OpenRouterImageOptions {
  return normalizeAiOptions({
    schema: resolveOpenRouterOptionSchema('image', OPENROUTER_GPT_IMAGE_2_MODEL_ID),
    options,
    context: 'openrouter-image-contract',
  }) as OpenRouterImageOptions
}

function normalizeBananaImageOptions(options: Record<string, unknown>): OpenRouterImageOptions {
  return normalizeAiOptions({
    schema: resolveOpenRouterOptionSchema('image', OPENROUTER_BANANA_2_IMAGE_MODEL_ID),
    options,
    context: 'openrouter-banana-image-contract',
  }) as OpenRouterImageOptions
}

describe('provider contract - OpenRouter image', () => {
  let server: Awaited<ReturnType<typeof startScenarioServer>> | null = null

  beforeEach(async () => {
    server = await startScenarioServer()
  })

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('normalizes model defaults and conflicts before SDK execution', () => {
    expect(normalizeImageOptions({ aspectRatio: '1:1' })).toMatchObject({
      aspectRatio: '1:1',
      resolution: '1K',
      quality: 'high',
      outputFormat: 'png',
      referenceImages: [],
      imageSize: { width: 1088, height: 1088 },
    })
    expect(normalizeImageOptions({ aspectRatio: '4:3' })).toMatchObject({
      imageSize: { width: 1440, height: 1088 },
    })
    expect(() => normalizeImageOptions({
      aspectRatio: '1:1',
      size: '1K',
      resolution: '2K',
    })).toThrow('size_and_resolution_must_match')
    expect(() => normalizeImageOptions({
      aspectRatio: '1:1',
      outputCompression: 50,
    })).toThrow('outputCompression_requires_jpeg_or_webp')
    try {
      normalizeImageOptions({
        aspectRatio: '1:1',
        keepOriginalAspectRatio: true,
      })
      throw new Error('Expected option validation to reject an unsupported field')
    } catch (error) {
      expect(error).toBeInstanceOf(AiOptionValidationError)
      expect(error).toMatchObject({
        failure: 'unsupported_option',
        field: 'keepOriginalAspectRatio',
      })
    }
  })

  it('streams a text-to-image request exactly once and projects only the completed image', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'success',
      submitResponse: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          `data: ${JSON.stringify({
            type: 'image_generation.partial_image',
            partial_image_index: 0,
            b64_json: PNG_1X1_BASE64,
          })}`,
          '',
          `data: ${JSON.stringify({
            type: 'image_generation.completed',
            b64_json: PNG_1X1_BASE64,
            media_type: 'image/webp',
            created: 1_785_406_500,
            usage: {
              prompt_tokens: 100,
              completion_tokens: 4075,
              total_tokens: 4175,
              cost: 0.165,
            },
          })}`,
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'),
      },
    })

    const result = await requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'paint a watercolor city scene',
      options: normalizeImageOptions({
        aspectRatio: '9:16',
        resolution: '1K',
        quality: 'high',
        outputFormat: 'webp',
        background: 'opaque',
        outputCompression: 60,
        moderation: 'low',
      }),
    })

    expect(result).toEqual({
      success: true,
      imageBase64: PNG_1X1_BASE64,
      imageUrl: `data:image/webp;base64,${PNG_1X1_BASE64}`,
      metadata: {
        openRouterUsage: { inputTokens: 100, outputTokens: 4075, totalTokens: 4175 },
      },
    })
    const requests = server!.getRequests('POST', '/openrouter/images')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.authorization).toBe('Bearer openrouter-image-key')
    expect(requests[0]?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(requests[0]?.bodyText || '{}')).toEqual({
      model: 'openai/gpt-image-2',
      prompt: 'paint a watercolor city scene',
      n: 1,
      size: '1088x1920',
      quality: 'high',
      output_format: 'webp',
      background: 'opaque',
      output_compression: 60,
      stream: true,
      provider: {
        only: ['openai'],
        allow_fallbacks: false,
        options: { openai: { moderation: 'low' } },
      },
    })
    expect(requests[0]?.headers.accept).toBe('text/event-stream')
  })

  it('uses the buffered Images API when GPT Image 2 receives reference images', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: {
          created: 1_785_406_500,
          data: [{ b64_json: PNG_1X1_BASE64, media_type: 'image/webp' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 4075,
            total_tokens: 4175,
            cost: 0.165,
          },
        },
      },
    })

    const result = await requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'paint this as a watercolor scene',
      options: normalizeImageOptions({
        referenceImages: [PNG_1X1_DATA_URL],
        aspectRatio: '9:16',
        resolution: '1K',
        quality: 'high',
        outputFormat: 'webp',
        background: 'opaque',
        outputCompression: 60,
        moderation: 'low',
      }),
    })

    expect(result).toEqual({
      success: true,
      imageBase64: PNG_1X1_BASE64,
      imageUrl: `data:image/webp;base64,${PNG_1X1_BASE64}`,
      metadata: {
        openRouterUsage: { inputTokens: 100, outputTokens: 4075, totalTokens: 4175 },
      },
    })
    const requests = server!.getRequests('POST', '/openrouter/images')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.bodyText || '{}')).toEqual({
      model: 'openai/gpt-image-2',
      prompt: 'paint this as a watercolor scene',
      n: 1,
      size: '1088x1920',
      quality: 'high',
      output_format: 'webp',
      input_references: [{
        type: 'image_url',
        image_url: { url: PNG_1X1_DATA_URL },
      }],
      background: 'opaque',
      output_compression: 60,
      stream: false,
      provider: {
        only: ['openai'],
        allow_fallbacks: false,
        options: { openai: { moderation: 'low' } },
      },
    })
    expect(requests[0]?.headers.accept).not.toBe('text/event-stream')
  })

  it('uses the same dedicated Image API for Nano Banana without provider failover', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: {
          created: 1_785_406_500,
          data: [{ b64_json: PNG_1X1_BASE64, media_type: 'image/png' }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 1_120,
            total_tokens: 1_140,
            cost: 0.067,
          },
        },
      },
    })

    const result = await requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: OPENROUTER_BANANA_2_IMAGE_MODEL_ID,
      prompt: 'cinematic desert city at sunrise',
      options: normalizeBananaImageOptions({
        referenceImages: [PNG_1X1_DATA_URL],
        aspectRatio: '16:9',
        resolution: '2K',
      }),
    })

    expect(result).toMatchObject({
      success: true,
      imageUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
      metadata: {
        openRouterUsage: { inputTokens: 20, outputTokens: 1_120, totalTokens: 1_140 },
      },
    })
    const requests = server!.getRequests('POST', '/openrouter/images')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.bodyText || '{}')).toEqual({
      model: OPENROUTER_BANANA_2_IMAGE_MODEL_ID,
      prompt: 'cinematic desert city at sunrise',
      n: 1,
      resolution: '2K',
      aspect_ratio: '16:9',
      input_references: [{
        type: 'image_url',
        image_url: { url: PNG_1X1_DATA_URL },
      }],
      stream: false,
    })
  })

  it('does not retry an uncertain image POST', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'retryable_error_then_success',
      submitResponse: { status: 503, body: { error: 'upstream unavailable' } },
      pollSequence: [{
        status: 200,
        body: { data: [{ b64_json: PNG_1X1_BASE64, media_type: 'image/png' }] },
      }],
    })

    await expect(requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'generate once',
      options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
    })).rejects.toMatchObject({ statusCode: 503 })

    expect(server!.getRequests('POST', '/openrouter/images')).toHaveLength(1)
  })

  it('surfaces a mid-stream provider failure without replaying the image POST', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'fatal_error',
      submitResponse: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          `data: ${JSON.stringify({
            type: 'image_generation.partial_image',
            partial_image_index: 0,
            b64_json: PNG_1X1_BASE64,
          })}`,
          '',
          `data: ${JSON.stringify({
            type: 'error',
            error: {
              code: 'server_error',
              message: 'Generation failed',
            },
          })}`,
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'),
      },
    })

    await expect(requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'surface the stream failure',
      options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'EXTERNAL_ERROR',
      disposition: 'rejected',
      provider: 'openrouter',
      message: 'Generation failed',
    })

    expect(server!.getRequests('POST', '/openrouter/images')).toHaveLength(1)
  })

  it('preserves a streaming content-policy machine code as a permanent typed failure', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'fatal_error',
      submitResponse: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          `data: ${JSON.stringify({
            type: 'error',
            error: {
              code: 'content_policy_violation',
              message: 'The supplied reference was rejected.',
            },
          })}`,
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'),
      },
    })

    await expect(requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'preserve the machine policy fact',
      options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'SENSITIVE_CONTENT',
      disposition: 'rejected',
      provider: 'openrouter',
    })

    expect(server!.getRequests('POST', '/openrouter/images')).toHaveLength(1)
  })

  it('types an upstream billing hard limit as a proven pre-accept rejection', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'fatal_error',
      submitResponse: {
        status: 400,
        body: {
          error: {
            message: 'Billing hard limit has been reached.',
            code: 400,
            metadata: { provider_name: 'OpenAI' },
          },
        },
      },
    })

    await expect(requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'route only after explicit rejection',
      options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
    })).rejects.toBeInstanceOf(ProviderSubmissionError)

    expect(server!.getRequests('POST', '/openrouter/images')).toHaveLength(1)
  })

  it('types a structured initial 4xx response as an explicit rejection', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'fatal_error',
      submitResponse: {
        status: 400,
        body: {
          error: {
            message: 'Input image URL is not directly downloadable.',
            code: 400,
            metadata: { error_type: 'invalid_request' },
          },
        },
      },
    })

    await expect(requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'surface a proven provider rejection',
      options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'PROVIDER_SUBMISSION_REJECTED',
      disposition: 'rejected',
      provider: 'openrouter',
      message: 'Input image URL is not directly downloadable.',
    })

    expect(server!.getRequests('POST', '/openrouter/images')).toHaveLength(1)
  })

  it('does not infer a disposition from a bare image rate-limit response', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'fatal_error',
      submitResponse: {
        status: 429,
        body: { error: { message: 'Rate limited', code: 429 } },
      },
    })

    try {
      await requestOpenRouterImage({
        baseUrl: `${server!.baseUrl}/openrouter`,
        apiKey: 'openrouter-image-key',
        modelId: 'openai/gpt-image-2',
        prompt: 'keep HTTP-only rate limit ambiguous',
        options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
      })
      throw new Error('Expected the submission to fail')
    } catch (error) {
      expect(error).not.toBeInstanceOf(ProviderSubmissionError)
      expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    }

    expect(server!.getRequests('POST', '/openrouter/images')).toHaveLength(1)
  })

  it('fails explicitly when a successful response has no image bytes', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/images',
      mode: 'malformed_response',
      submitResponse: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: [DONE]\n\n',
      },
    })

    await expect(requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-image-key',
      modelId: 'openai/gpt-image-2',
      prompt: 'missing output',
      options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
    })).rejects.toThrow('OPENROUTER_IMAGE_RESPONSE_MISSING_IMAGE')
  })

  it('uses the OpenAI-compatible generations endpoint for custom platforms', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/relay/v1/images/generations',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: {
          created: 1_785_406_500,
          data: [{ b64_json: PNG_1X1_BASE64 }],
        },
      },
    })

    const result = await requestOpenRouterImage({
      baseUrl: `${server!.baseUrl}/relay/v1`,
      apiKey: 'relay-image-key',
      modelId: 'gpt-image-2',
      providerId: 'openrouter:custom1',
      prompt: 'paint a watercolor city scene',
      options: normalizeImageOptions({
        aspectRatio: '1:1',
        resolution: '1K',
        quality: 'high',
        outputFormat: 'png',
      }),
    })

    expect(result).toEqual({
      success: true,
      imageBase64: PNG_1X1_BASE64,
      imageUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
    })
    const requests = server!.getRequests('POST', '/relay/v1/images/generations')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.authorization).toBe('Bearer relay-image-key')
    const body = JSON.parse(requests[0]?.bodyText || '{}')
    expect(body).toEqual({
      model: 'gpt-image-2',
      prompt: 'paint a watercolor city scene',
      n: 1,
      size: '1088x1088',
      quality: 'high',
    })
    expect(server!.getRequests('POST', '/relay/v1/images')).toHaveLength(0)
  })

  it('surfaces a custom relay 404 message as a rejected submission, not validation failure', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/relay/v1/images/generations',
      mode: 'fatal_error',
      submitResponse: {
        status: 404,
        body: { code: 1, msg: '接口不存在' },
      },
    })

    try {
      await requestOpenRouterImage({
        baseUrl: `${server!.baseUrl}/relay/v1`,
        apiKey: 'relay-image-key',
        modelId: 'gpt-image-2',
        providerId: 'openrouter:custom1',
        prompt: 'paint a watercolor city scene',
        options: normalizeImageOptions({ aspectRatio: '1:1', resolution: '1K', quality: 'low' }),
      })
      throw new Error('Expected the submission to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSubmissionError)
      expect(error).toMatchObject({
        code: 'PROVIDER_SUBMISSION_REJECTED',
        message: '接口不存在',
        disposition: 'rejected',
      })
    }
    expect(server!.getRequests('POST', '/relay/v1/images/generations')).toHaveLength(1)
  })
})
