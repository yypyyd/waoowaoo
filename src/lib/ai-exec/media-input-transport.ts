import { getDeploymentConfig, type ProviderMediaInputTransport } from '@/lib/deployment/config'
import type { AiProviderRoute, AiProviderRouteSet } from '@/lib/ai-registry/provider-route-set'
import { getProviderKey, parseModelKeyStrict } from '@/lib/ai-registry/selection'
import { resolveBuiltinCapabilitiesByModelKey } from '@/lib/ai-registry/capabilities-catalog'
import {
  buildCustomPlatformVideoCapabilities,
  isCustomPlatformProviderId,
} from '@/lib/ai-providers/openrouter/video-models'
import type {
  AiResolvedSelection,
  ModelCapabilities,
  UnifiedModelType,
  VideoInputMode,
} from '@/lib/ai-registry/types'
import { AI_PROVIDER_MANIFESTS } from '@/lib/ai-providers/manifests'
import type {
  ProviderMediaInputDeclaration,
  ProviderMediaInputKind,
  ProviderMediaInputModality,
} from '@/lib/ai-providers/manifest'

export type { ProviderMediaInputKind } from '@/lib/ai-providers/manifest'
type MediaInputModality = ProviderMediaInputModality

export type ProviderMediaInputContract = {
  readonly provider: string
  readonly modality: MediaInputModality
  readonly transports: Readonly<Partial<Record<ProviderMediaInputKind, readonly ProviderMediaInputTransport[]>>>
}

function withProvider(
  provider: string,
  declaration: ProviderMediaInputDeclaration,
): ProviderMediaInputContract {
  return { provider, ...declaration }
}

const PROVIDER_MEDIA_INPUT_CONTRACTS: readonly ProviderMediaInputContract[] = AI_PROVIDER_MANIFESTS.flatMap(
  (manifest) => (manifest.mediaInputs ?? []).map((declaration) => withProvider(
    manifest.providerKey,
    declaration,
  )),
)

const CONTRACT_BY_PROVIDER_MODALITY = new Map(
  PROVIDER_MEDIA_INPUT_CONTRACTS.map((contract) => [
    `${contract.provider}:${contract.modality}`,
    contract,
  ]),
)

export function listProviderMediaInputContracts(): readonly ProviderMediaInputContract[] {
  return PROVIDER_MEDIA_INPUT_CONTRACTS.map((contract) => ({
    ...contract,
    transports: Object.fromEntries(
      Object.entries(contract.transports).map(([mediaKind, transports]) => [
        mediaKind,
        transports ? [...transports] : transports,
      ]),
    ),
  }))
}

export class MediaInputTransportUnsupportedError extends Error {
  readonly code = 'MEDIA_INPUT_TRANSPORT_UNSUPPORTED' as const
  readonly provider: string
  readonly modality: MediaInputModality
  readonly mediaKind: ProviderMediaInputKind
  readonly transport: ProviderMediaInputTransport

  constructor(input: {
    provider: string
    modality: MediaInputModality
    mediaKind: ProviderMediaInputKind
    transport: ProviderMediaInputTransport
  }) {
    super(
      `MEDIA_INPUT_TRANSPORT_UNSUPPORTED:${input.provider}:${input.modality}:${input.mediaKind}:${input.transport}`,
    )
    this.name = 'MediaInputTransportUnsupportedError'
    this.provider = input.provider
    this.modality = input.modality
    this.mediaKind = input.mediaKind
    this.transport = input.transport
  }
}

function supportsTransport(input: {
  provider: string
  modality: MediaInputModality
  mediaKind: ProviderMediaInputKind
  transport: ProviderMediaInputTransport
}): boolean {
  // Contracts are keyed by provider key; instantiated custom platforms
  // (openrouter:<suffix>) share their base provider's media-input contract.
  const contract = CONTRACT_BY_PROVIDER_MODALITY.get(`${getProviderKey(input.provider)}:${input.modality}`)
  return contract?.transports[input.mediaKind]?.includes(input.transport) === true
}

function assertRouteSupportsMediaInputs(input: {
  route: Pick<AiProviderRoute, 'provider'>
  modality: MediaInputModality
  mediaKinds: readonly ProviderMediaInputKind[]
  transport: ProviderMediaInputTransport
}): void {
  for (const mediaKind of input.mediaKinds) {
    if (supportsTransport({
      provider: input.route.provider,
      modality: input.modality,
      mediaKind,
      transport: input.transport,
    })) continue
    throw new MediaInputTransportUnsupportedError({
      provider: input.route.provider,
      modality: input.modality,
      mediaKind,
      transport: input.transport,
    })
  }
}

export function resolveCompatibleMediaProviderRoutes(input: {
  routeSet: AiProviderRouteSet
  selection: AiResolvedSelection
  modality: MediaInputModality
  mediaKinds: readonly ProviderMediaInputKind[]
}): readonly AiProviderRoute[] {
  if (input.mediaKinds.length === 0) return input.routeSet.routes
  const transport = getDeploymentConfig().providerMediaInputTransport
  const selectedRoute = input.routeSet.routes.find((route) => route.modelKey === input.selection.modelKey)
  if (!selectedRoute) {
    throw new Error(`PROVIDER_ROUTE_PRIMARY_MISSING:${input.routeSet.logicalCapabilityId}:${input.selection.modelKey}`)
  }
  assertRouteSupportsMediaInputs({
    route: selectedRoute,
    modality: input.modality,
    mediaKinds: input.mediaKinds,
    transport,
  })
  return input.routeSet.routes.filter((route) => input.mediaKinds.every((mediaKind) => supportsTransport({
    provider: route.provider,
    modality: input.modality,
    mediaKind,
    transport,
  })))
}

export function assertSelectionSupportsMediaInputs(input: {
  selection: AiResolvedSelection
  modality: MediaInputModality
  mediaKinds: readonly ProviderMediaInputKind[]
}): void {
  if (input.mediaKinds.length === 0) return
  assertRouteSupportsMediaInputs({
    route: { provider: input.selection.provider },
    modality: input.modality,
    mediaKinds: input.mediaKinds,
    transport: getDeploymentConfig().providerMediaInputTransport,
  })
}

export function collectMediaInputKinds(input: {
  modality: MediaInputModality
  imageUrl?: string
  options?: unknown
}): ProviderMediaInputKind[] {
  const kinds = new Set<ProviderMediaInputKind>()
  if (input.modality === 'video' && input.imageUrl?.trim()) kinds.add('image')
  if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)) {
    return [...kinds]
  }
  const options = input.options as Record<string, unknown>
  if (Array.isArray(options.referenceImages) && options.referenceImages.length > 0) kinds.add('image')
  if (typeof options.lastFrameImageUrl === 'string' && options.lastFrameImageUrl.trim()) kinds.add('image')
  if (Array.isArray(options.referenceAudios) && options.referenceAudios.length > 0) kinds.add('audio')
  if (Array.isArray(options.referenceVideos) && options.referenceVideos.length > 0) kinds.add('video')
  return [...kinds]
}

function supportsEffectiveInput(
  provider: string,
  modality: MediaInputModality,
  mediaKind: ProviderMediaInputKind,
): boolean {
  return supportsTransport({
    provider,
    modality,
    mediaKind,
    transport: getDeploymentConfig().providerMediaInputTransport,
  })
}

export function projectEffectiveMediaCapabilities(
  modelType: UnifiedModelType,
  modelKey: string,
  capabilities: ModelCapabilities | undefined,
): ModelCapabilities | undefined {
  if (!capabilities || (modelType !== 'image' && modelType !== 'video')) return capabilities
  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed) return capabilities
  if (modelType === 'image') return capabilities

  const video = capabilities.video
  if (!video) return capabilities
  // Custom-platform transports materialize reference media server-side and
  // upload them as files, so audio/video references are available even when
  // the base provider's URL-based contract only accepts public URLs.
  const isCustomPlatform = isCustomPlatformProviderId(parsed.provider)
  const imageAvailable = supportsEffectiveInput(parsed.provider, 'video', 'image')
  const audioAvailable = isCustomPlatform || supportsEffectiveInput(parsed.provider, 'video', 'audio')
  const videoAvailable = isCustomPlatform || supportsEffectiveInput(parsed.provider, 'video', 'video')
  const supportedInputModes = video.supportedInputModes?.filter((mode: VideoInputMode) => {
    if (mode === 'text_to_video') return true
    if (mode === 'first_frame' || mode === 'first_last_frame') return imageAvailable
    return imageAvailable || audioAvailable || videoAvailable
  })
  const maxReferenceImages = imageAvailable ? video.maxReferenceImages : 0
  const maxReferenceAudios = audioAvailable ? video.maxReferenceAudios : 0
  const maxReferenceVideos = videoAvailable ? video.maxReferenceVideos : 0
  const availableReferenceTotal = (maxReferenceImages ?? 0)
    + (maxReferenceAudios ?? 0)
    + (maxReferenceVideos ?? 0)
  const generationModeOptions = video.generationModeOptions?.filter((mode) => (
    mode !== 'firstlastframe' || imageAvailable
  ))
  return {
    ...capabilities,
    video: {
      ...video,
      ...(supportedInputModes ? { supportedInputModes } : {}),
      ...(video.maxReferenceImages !== undefined ? { maxReferenceImages } : {}),
      ...(video.maxReferenceAudios !== undefined ? { maxReferenceAudios } : {}),
      ...(video.maxReferenceVideos !== undefined ? { maxReferenceVideos } : {}),
      ...(video.maxReferenceFiles !== undefined
        ? { maxReferenceFiles: Math.min(video.maxReferenceFiles, availableReferenceTotal) }
        : {}),
      ...(generationModeOptions ? { generationModeOptions } : {}),
      ...(video.firstlastframe !== undefined
        ? { firstlastframe: video.firstlastframe && imageAvailable }
        : {}),
      ...(video.assetReferenceMultiReference !== undefined
        ? {
            assetReferenceMultiReference: video.assetReferenceMultiReference
              && (imageAvailable || audioAvailable || videoAvailable),
          }
        : {}),
    },
  }
}

export function resolveEffectiveCapabilitiesByModelKey(
  modelType: UnifiedModelType,
  modelKey: string,
): ModelCapabilities | undefined {
  const builtin = resolveBuiltinCapabilitiesByModelKey(modelType, modelKey)
  if (builtin) return projectEffectiveMediaCapabilities(modelType, modelKey, builtin)
  if (modelType === 'video') {
    // Video models on instantiated custom platforms (openrouter:<suffix>)
    // have no builtin catalog entry. Synthesize the generic relay defaults
    // instead of dropping the model, mirroring the generic option-schema
    // fallback custom platforms already get for media generation.
    const parsed = parseModelKeyStrict(modelKey)
    if (parsed && isCustomPlatformProviderId(parsed.provider)) {
      return projectEffectiveMediaCapabilities(modelType, modelKey, {
        video: buildCustomPlatformVideoCapabilities(parsed.modelId),
      })
    }
  }
  return undefined
}
