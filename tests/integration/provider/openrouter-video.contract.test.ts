import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decodeCustomVideoRequestId,
  executeOpenRouterVideoGeneration,
  queryCustomPlatformVideoStatus,
  submitOpenRouterVideoTask,
} from '@/lib/ai-providers/openrouter/video'
import { resolveEffectiveCapabilitiesByModelKey } from '@/lib/ai-exec/media-input-transport'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { projectProductionCapabilities } from '@/lib/project-production-context'

ensureAiCatalogsRegistered()
import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'
import { startScenarioServer } from '../../helpers/fakes/scenario-server'

describe('provider contract - OpenRouter video', () => {
  let server: Awaited<ReturnType<typeof startScenarioServer>> | null = null

  const providerConfig = () => {
    if (!server) throw new Error('TEST_SCENARIO_SERVER_REQUIRED')
    return {
      id: 'openrouter',
      name: 'openrouter',
      apiKey: 'openrouter-video-key',
      baseUrl: `${server.baseUrl}/openrouter`,
    }
  }

  beforeEach(async () => {
    server = await startScenarioServer()
  })

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('does not retry an uncertain SDK video submission', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'retryable_error_then_success',
      submitResponse: { status: 503, body: { error: 'upstream unavailable' } },
      pollSequence: [{
        status: 202,
        body: {
          id: 'must-not-be-reached',
          status: 'pending',
          polling_url: `${server!.baseUrl}/openrouter/videos/must-not-be-reached`,
        },
      }],
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0',
        prompt: 'submit exactly once',
        duration: 5,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({ statusCode: 503 })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('preserves an accepted external id when the SDK rejects only the response shape', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'malformed_response',
      submitResponse: {
        status: 202,
        body: {
          id: 'accepted-job-id',
          status: 'pending',
          error: { message: 'non-contract warning shape' },
        },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'preserve the accepted provider identity',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).resolves.toBe('accepted-job-id')

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('surfaces the typed provider rejection hidden by an SDK response validation error', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'fatal_error',
      submitResponse: {
        status: 202,
        body: {
          error: {
            code: 400,
            message: 'Reference images must use directly downloadable URLs',
            metadata: { error_type: 'invalid_request' },
          },
        },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'surface the provider rejection',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'PROVIDER_SUBMISSION_REJECTED',
      disposition: 'rejected',
      details: {
        providerCode: 400,
        providerErrorType: 'invalid_request',
      },
      message: expect.stringContaining('Reference images must use directly downloadable URLs'),
    })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('does not infer a submission disposition from a bare retryable HTTP status', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'fatal_error',
      submitResponse: {
        status: 429,
        body: { error: { code: 429, message: 'Rate limited' } },
      },
    })

    try {
      await submitOpenRouterVideoTask({
        baseUrl: `${server!.baseUrl}/openrouter`,
        apiKey: 'openrouter-video-key',
        payload: {
          model: 'bytedance/seedance-2.0-fast',
          prompt: 'do not infer acceptance from HTTP status',
          duration: 15,
          resolution: '720p',
          aspectRatio: '16:9',
        },
      })
      throw new Error('Expected the submission to fail')
    } catch (error) {
      expect(error).not.toBeInstanceOf(ProviderSubmissionError)
      expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    }

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('preserves the provider privacy rejection as a permanent content-policy fact', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'fatal_error',
      submitResponse: {
        status: 202,
        body: {
          error: {
            code: 400,
            message: 'The supplied reference was rejected.',
            metadata: {
              error_type: 'InputImageSensitiveContentDetected.PrivacyInformation',
            },
          },
        },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'Do not collapse a machine policy code into an internal error.',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'SENSITIVE_CONTENT',
      disposition: 'rejected',
      provider: 'openrouter',
    })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('does not turn an unclassified accepted response into a safe-to-retry rejection', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'malformed_response',
      submitResponse: {
        status: 202,
        body: { status: 'pending' },
      },
    })

    await expect(submitOpenRouterVideoTask({
      baseUrl: `${server!.baseUrl}/openrouter`,
      apiKey: 'openrouter-video-key',
      payload: {
        model: 'bytedance/seedance-2.0-fast',
        prompt: 'keep an ambiguous submission outcome fenced',
        duration: 15,
        resolution: '720p',
        aspectRatio: '16:9',
      },
    })).rejects.toMatchObject({
      name: 'Error',
      message: 'OPENROUTER_VIDEO_SUBMIT_RESPONSE_INVALID_WITHOUT_ACCEPTANCE_ID_OR_ERROR',
    })

    expect(server!.getRequests('POST', '/openrouter/videos')).toHaveLength(1)
  })

  it('serializes Seedance image and voice references through one multimodal input list', async () => {
    const referenceAudioDataUrl = 'data:audio/wav;base64,UklGRgQAAABXQVZF'
    server!.defineScenario({
      method: 'POST',
      path: '/openrouter/videos',
      mode: 'success',
      submitResponse: {
        status: 202,
        body: {
          id: 'seedance-audio-reference-job',
          status: 'pending',
          polling_url: '/openrouter/videos/seedance-audio-reference-job',
        },
      },
    })

    await expect(executeOpenRouterVideoGeneration({
      userId: 'user-1',
      providerConfig: providerConfig(),
      selection: {
        provider: 'openrouter',
        modelId: 'bytedance/seedance-2.0-fast',
        modelKey: 'openrouter::bytedance/seedance-2.0-fast',
        variantSubKind: 'official',
      },
      imageUrl: '',
      options: {
        prompt: 'Image 1 speaks with audio 1 while following video 1 motion.',
        referenceImages: ['https://example.com/character.png'],
        referenceAudios: [referenceAudioDataUrl],
        referenceVideos: ['https://example.com/motion.mp4'],
        duration: 6,
        resolution: '720p',
        aspectRatio: '16:9',
        generateAudio: true,
      },
    })).resolves.toMatchObject({
      externalId: 'OPENROUTER:VIDEO:seedance-audio-reference-job',
    })

    const requests = server!.getRequests('POST', '/openrouter/videos')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.bodyText || '{}')).toMatchObject({
      input_references: [
        { type: 'image_url', image_url: { url: 'https://example.com/character.png' } },
        { type: 'audio_url', audio_url: { url: referenceAudioDataUrl } },
        { type: 'video_url', video_url: { url: 'https://example.com/motion.mp4' } },
      ],
    })
  })

  it('gives custom-platform video models synthesized production capabilities', () => {
    const kling = resolveEffectiveCapabilitiesByModelKey('video', 'openrouter:custom1::kling-4.0')
    expect(kling?.video?.durationOptions).toEqual([8])
    expect(kling?.video?.resolutionOptions).toEqual(['720p'])
    expect(kling?.video?.maxReferenceImages).toBe(1)
    expect(kling?.video?.maxReferenceVideos).toBe(0)
    expect(kling?.video?.supportedInputModes).toEqual(
      expect.arrayContaining(['text_to_video', 'first_frame', 'reference']),
    )
    const generic = resolveEffectiveCapabilitiesByModelKey('video', 'openrouter:custom1::future-model-x')
    expect(generic?.video?.durationOptions).toEqual([5, 8, 10])

    const capabilities = projectProductionCapabilities({
      videoRatio: '16:9',
      models: [{
        provider: 'openrouter:custom1',
        modelId: 'kling-4.0',
        modelKey: 'openrouter:custom1::kling-4.0',
        name: 'Kling 4.0',
        type: 'video',
        price: 0,
      }],
    })
    expect(capabilities.video.models).toHaveLength(1)
    expect(capabilities.video.models[0]?.allowedSegmentDurationsSeconds).toEqual([8])
    expect(capabilities.video.models[0]?.supportedInputModes.length).toBeGreaterThan(0)
  })

  it('submits custom-platform video as multipart and polls it with the instance config', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/relay/videos',
      mode: 'success',
      submitResponse: { status: 200, body: { id: 'video_abc123', status: 'queued' } },
    })
    server!.defineScenario({
      method: 'GET',
      path: '/relay/videos/video_abc123',
      mode: 'success',
      submitResponse: { status: 200, body: { id: 'video_abc123', status: 'completed' } },
    })

    const result = await executeOpenRouterVideoGeneration({
      userId: 'user-1',
      providerConfig: {
        id: 'openrouter:custom1',
        name: 'huantu',
        apiKey: 'relay-key',
        baseUrl: `${server!.baseUrl}/relay`,
      },
      selection: {
        provider: 'openrouter:custom1',
        modelId: 'kling-4.0',
        modelKey: 'openrouter:custom1::kling-4.0',
        variantSubKind: 'official',
      },
      imageUrl: '',
      options: {
        prompt: 'a cat runs through neon streets',
        duration: 8,
        resolution: '720p',
        aspectRatio: '16:9',
        referenceImages: [`data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}`],
        referenceVideos: ['data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE='],
      },
    })

    expect(result.async).toBe(true)
    const decoded = decodeCustomVideoRequestId(result.requestId ?? '')
    expect(decoded).toEqual({
      providerId: 'openrouter:custom1',
      modelId: 'kling-4.0',
      jobId: 'video_abc123',
    })

    const requests = server!.getRequests('POST', '/relay/videos')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.authorization).toBe('Bearer relay-key')
    expect(requests[0]?.headers['content-type']).toContain('multipart/form-data')
    expect(requests[0]?.bodyText).toContain('name="model"')
    expect(requests[0]?.bodyText).toContain('kling-4.0')
    expect(requests[0]?.bodyText).toContain('name="seconds"')
    expect(requests[0]?.bodyText).toContain('name="size"')
    expect(requests[0]?.bodyText).toContain('1280x720')
    expect(requests[0]?.bodyText).toContain('name="input_reference"')
    expect(requests[0]?.bodyText).toContain('name="reference_videos"')
    expect(server!.getRequests('POST', '/relay/videos/generations')).toHaveLength(0)

    const poll = await queryCustomPlatformVideoStatus({
      baseUrl: `${server!.baseUrl}/relay`,
      apiKey: 'relay-key',
      modelId: decoded!.modelId,
      jobId: decoded!.jobId,
    })
    expect(poll.status).toBe('completed')
    expect(poll.videoUrl).toBe(`${server!.baseUrl}/relay/videos/video_abc123/content?model=kling-4.0`)
    expect(poll.downloadHeaders).toEqual({ Authorization: 'Bearer relay-key' })
    const pollRequests = server!.getRequests('GET', '/relay/videos/video_abc123')
    expect(pollRequests).toHaveLength(1)
    expect(pollRequests[0]?.query).toContain('model=kling-4.0')
  })

  it('surfaces a custom-platform video rejection with the relay message', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/relay/videos',
      mode: 'fatal_error',
      submitResponse: {
        status: 400,
        body: { error: { message: '模型不存在', type: 'invalid_request_error', code: 'invalid_request' } },
      },
    })

    await expect(executeOpenRouterVideoGeneration({
      userId: 'user-1',
      providerConfig: {
        id: 'openrouter:custom1',
        name: 'huantu',
        apiKey: 'relay-key',
        baseUrl: `${server!.baseUrl}/relay`,
      },
      selection: {
        provider: 'openrouter:custom1',
        modelId: 'kling-4.0',
        modelKey: 'openrouter:custom1::kling-4.0',
        variantSubKind: 'official',
      },
      imageUrl: '',
      options: { prompt: 'a cat runs', duration: 8, resolution: '720p', aspectRatio: '16:9' },
    })).rejects.toMatchObject({
      code: 'PROVIDER_SUBMISSION_REJECTED',
      message: '模型不存在',
    })
    expect(server!.getRequests('POST', '/relay/videos')).toHaveLength(1)
  })
})
