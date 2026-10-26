import { describe, expect, it } from 'vitest'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { validateReferenceCapabilities } from '@/lib/operations/domains/workspace-resource/generation-ops'

ensureAiCatalogsRegistered()

const CUSTOM_KLING_MODEL_KEY = 'openrouter:custom1::kling-4.0'

describe('workspace resource generation reference capabilities', () => {
  it('accepts text-to-video for a custom-platform video model', () => {
    expect(() => validateReferenceCapabilities({
      mediaType: 'video',
      modelKey: CUSTOM_KLING_MODEL_KEY,
      references: [],
    })).not.toThrow()
  })

  it('accepts first-frame and reference media for a custom-platform video model', () => {
    expect(() => validateReferenceCapabilities({
      mediaType: 'video',
      modelKey: CUSTOM_KLING_MODEL_KEY,
      references: [{
        resourceId: 'res_first_frame',
        contentVersion: 1,
        role: 'first_frame',
        channel: 'image',
      }],
    })).not.toThrow()

    expect(() => validateReferenceCapabilities({
      mediaType: 'video',
      modelKey: CUSTOM_KLING_MODEL_KEY,
      references: [
        {
          resourceId: 'res_reference_image',
          contentVersion: 1,
          role: 'reference_image',
          channel: 'image',
        },
        {
          resourceId: 'res_reference_video',
          contentVersion: 1,
          role: 'reference_video',
          channel: 'video',
        },
        {
          resourceId: 'res_reference_audio',
          contentVersion: 1,
          role: 'reference_audio',
          channel: 'audio',
        },
      ],
    })).not.toThrow()
  })

  it('still rejects first/last-frame mode when the custom model does not declare it', () => {
    expect(() => validateReferenceCapabilities({
      mediaType: 'video',
      modelKey: CUSTOM_KLING_MODEL_KEY,
      references: [
        {
          resourceId: 'res_first_frame',
          contentVersion: 1,
          role: 'first_frame',
          channel: 'image',
        },
        {
          resourceId: 'res_last_frame',
          contentVersion: 1,
          role: 'last_frame',
          channel: 'image',
        },
      ],
    })).toThrow(expect.objectContaining({
      details: expect.objectContaining({
        code: 'VIDEO_MODEL_INPUT_MODE_UNSUPPORTED',
        inputMode: 'first_last_frame',
      }),
    }))
  })
})
