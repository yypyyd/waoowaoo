import type { ImageGenerationRequest } from '@openrouter/sdk/models'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'
import type { GptImage2ImageSize } from '@/lib/ai-providers/shared/gpt-image-2'
import {
  OPENROUTER_GPT_IMAGE_2_MODEL_ID,
  OPENROUTER_IMAGE_MODEL_IDS,
  resolveOpenRouterCatalogImageModelId,
} from './models'

export type OpenRouterImageOptions = Record<string, unknown> & {
  aspectRatio: string
  resolution: string
  referenceImages: string[]
  imageSize?: GptImage2ImageSize
  outputFormat?: string
  quality?: string
  background?: string
  outputCompression?: number
  moderation?: string
}

async function normalizeReferences(referenceImages: readonly string[]): Promise<string[]> {
  return await Promise.all(referenceImages.map(normalizeToBase64ForGeneration))
}

export async function resolveOpenRouterImageInput(input: {
  modelId: string
  prompt: string
  options: OpenRouterImageOptions
}) {
  const promptText = input.prompt.trim()
  if (!promptText) throw new Error('OPENROUTER_IMAGE_PROMPT_REQUIRED')
  const catalogModelId = resolveOpenRouterCatalogImageModelId(input.modelId)
  if (!catalogModelId || !OPENROUTER_IMAGE_MODEL_IDS.has(catalogModelId)) {
    throw new Error(`OPENROUTER_IMAGE_MODEL_UNSUPPORTED: ${input.modelId}`)
  }
  const referenceImages = await normalizeReferences(input.options.referenceImages)
  const inputReferences = referenceImages.length > 0
    ? referenceImages.map((url) => ({
        type: 'image_url' as const,
        imageUrl: { url },
      }))
    : undefined

  if (catalogModelId !== OPENROUTER_GPT_IMAGE_2_MODEL_ID) {
    const request = {
      prompt: promptText,
      n: 1,
      resolution: input.options.resolution as ImageGenerationRequest['resolution'],
      aspectRatio: input.options.aspectRatio as ImageGenerationRequest['aspectRatio'],
      ...(typeof input.options.seed === 'number' ? { seed: input.options.seed } : {}),
      ...(inputReferences ? { inputReferences } : {}),
    } satisfies Omit<ImageGenerationRequest, 'model' | 'stream'>
    return {
      request,
      size: input.options.resolution,
      quality: null,
      outputFormat: 'png',
      referenceImagesCount: referenceImages.length,
      stream: false,
    }
  }

  const imageSize = input.options.imageSize
  const quality = input.options.quality?.trim() ?? ''
  const outputFormat = input.options.outputFormat?.trim() ?? ''
  if (!imageSize || !quality || !outputFormat) {
    throw new Error('OPENROUTER_GPT_IMAGE_2_OPTIONS_INCOMPLETE')
  }
  const request = {
    prompt: promptText,
    n: 1,
    size: `${imageSize.width}x${imageSize.height}`,
    quality: quality as ImageGenerationRequest['quality'],
    outputFormat: outputFormat as ImageGenerationRequest['outputFormat'],
    ...(inputReferences ? { inputReferences } : {}),
    ...(input.options.background
      ? { background: input.options.background as ImageGenerationRequest['background'] }
      : {}),
    ...(input.options.outputCompression !== undefined
      ? { outputCompression: input.options.outputCompression }
      : {}),
    provider: {
      only: ['openai'],
      allowFallbacks: false,
      ...(input.options.moderation
        ? { options: { openai: { moderation: input.options.moderation } } }
        : {}),
    },
  } satisfies Omit<ImageGenerationRequest, 'model' | 'stream'>

  return {
    request,
    size: request.size,
    quality,
    outputFormat,
    referenceImagesCount: referenceImages.length,
    // OpenRouter advertises streaming at the model endpoint level, but the
    // pinned OpenAI image endpoint rejects streaming when input_references
    // turns the request into image editing. Keep SSE for text-to-image only;
    // reference-image requests use the same dedicated Images API buffered.
    stream: referenceImages.length === 0,
  }
}
