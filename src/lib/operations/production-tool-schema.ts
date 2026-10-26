import { productionModelUnavailableReason } from '@/lib/model-access/production-model'
import type {
  ProjectProductionContext,
  ProductionImageModel,
  ProductionMusicModel,
  ProductionVideoModel,
  ProductionVoiceModel,
} from '@/lib/project-production-context'
import type { CapabilityValue } from '@/lib/ai-registry/types'
import type {
  JsonObject,
  JsonValue,
  ProjectAgentOperationDefinition,
  ProjectAgentToolInputSchema,
} from './types'

type ProductionModel = ProductionImageModel | ProductionVideoModel | ProductionMusicModel | ProductionVoiceModel

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function enumSchema(values: readonly CapabilityValue[]): JsonObject {
  if (values.length === 0) throw new Error('PRODUCTION_TOOL_ENUM_EMPTY')
  const type = typeof values[0]
  if (values.some((value) => typeof value !== type)) throw new Error('PRODUCTION_TOOL_ENUM_TYPE_MISMATCH')
  return { type, enum: [...values] }
}

function projectConfiguredModel(
  node: JsonObject,
  model: ProductionModel,
  context: ProjectProductionContext,
): JsonObject {
  if (!isObject(node.properties)) throw new Error('PRODUCTION_TOOL_PROPERTIES_REQUIRED')
  const properties = { ...node.properties }
  // Fixed fields and their values are server-owned and intentionally absent
  // from both the input fields and the model description.
  const { parameters, ...facts } = 'parameters' in model ? model : { ...model, parameters: [] }
  if ('options' in properties) {
    const originalOptions = properties.options
    if (!isObject(originalOptions) || !isObject(originalOptions.properties)) {
      throw new Error('PRODUCTION_TOOL_OPTIONS_SHAPE_INVALID')
    }
    const choices: JsonObject = Object.fromEntries(parameters
      .filter(({ field }) => context.fixedParameters[model.model]?.[field] === undefined)
      .map(({ field, options }) => [field, enumSchema(options)]))
    // Image create_image serves both ordinary frames and fixed-format asset
    // images. Asset items must omit aspectRatio (server applies 4:3); ordinary
    // items may omit it to inherit the project frame. Never require it for
    // image models — requiring it baited agents into failing asset validation.
    // Video keeps aspectRatio required so the agent always picks an explicit frame.
    const videoLocksAspectRatio = 'allowedSegmentDurationsSeconds' in model
    if (originalOptions.properties.aspectRatio !== undefined && 'aspectRatios' in model && model.aspectRatios.length > 0) {
      const originalAspect = originalOptions.properties.aspectRatio
      const description = isObject(originalAspect) && typeof originalAspect.description === 'string'
        ? originalAspect.description
        : videoLocksAspectRatio
          ? 'W:H frame ratio for this item.'
          : 'Optional W:H frame ratio for this item. Omit to use the project frame. Fixed-format asset images (character/location/prop) must omit it; the server applies the asset format.'
      choices.aspectRatio = { ...enumSchema(model.aspectRatios), description }
    }
    if (Object.keys(choices).length === 0) delete properties.options
    else {
      const required = Object.keys(choices).filter((key) => videoLocksAspectRatio || key !== 'aspectRatio')
      properties.options = {
        type: 'object', properties: choices,
        required,
        additionalProperties: false,
        description: videoLocksAspectRatio
          ? 'Select every exposed parameter for this item. Fixed parameters are applied by the server and are not input fields.'
          : 'Fill every required exposed parameter for this item. aspectRatio is optional: omit to use the project frame, and always omit it for reusable asset images (character/location/prop); the server applies the fixed asset format. Fixed parameters are applied by the server and are not input fields.',
      }
    }
  }
  if ('allowedSegmentDurationsSeconds' in model) {
    properties.durationSeconds = enumSchema(model.allowedSegmentDurationsSeconds)
    if (isObject(properties.references)) properties.references = {
      ...properties.references,
      description: 'The server derives input mode from reference roles. Obey the model’s supportedInputModes, per-channel counts and audio constraints; context references are not sent to the provider.',
    }
  }
  if ('languageOptions' in model) {
    properties.language = {
      ...enumSchema(model.languageOptions),
      ...(model.languageMode === 'inferred' ? {
        description: 'Auto: language is inferred from the original description and preview text. Write the intended native language and dialect in the description and use that language for the preview. No separate provider language override is supported.',
      } : {}),
    }
    for (const [field, min, max] of [
      ['description', model.descriptionMinChars, model.descriptionMaxChars],
      ['previewText', model.previewTextMinChars, model.previewTextMaxChars],
    ] as const) {
      const original = properties[field]
      if (!isObject(original)) throw new Error(`PRODUCTION_TOOL_VOICE_FIELD_MISSING:${field}`)
      properties[field] = {
        ...original,
        ...(min === undefined ? {} : { minLength: min }),
        ...(max === undefined ? {} : { maxLength: max }),
      }
    }
  }
  if ('generationMode' in model && isObject(properties.compositionPlan)) {
    properties.compositionPlan = projectMusicPlan(properties.compositionPlan, model)
  }
  return { ...node, description: `Configured model: ${JSON.stringify(facts)}`, properties, required: Object.keys(properties), additionalProperties: false }
}

function projectMusicPlan(node: JsonObject, model: ProductionMusicModel): JsonObject {
  const properties = node.properties
  if (!isObject(properties) || !isObject(properties.chunks)
    || !isObject(properties.chunks.items) || !isObject(properties.chunks.items.properties)) {
    throw new Error('PRODUCTION_TOOL_COMPOSITION_PLAN_SHAPE_INVALID')
  }
  const chunk = properties.chunks.items
  const chunkProperties = chunk.properties as JsonObject
  const limitArray = (field: string, maxItems: number): JsonObject => {
    const existing = chunkProperties[field]
    if (!isObject(existing)) throw new Error(`PRODUCTION_TOOL_MUSIC_FIELD_MISSING:${field}`)
    return { ...existing, maxItems }
  }
  return {
    ...node,
    description: `Composition Plan total duration: ${model.minPlanDurationMs}–${model.maxPlanDurationMs} ms. Output format is fixed MP3.`,
    properties: {
      ...properties,
      chunks: {
        ...properties.chunks, maxItems: model.maxChunks,
        items: {
          ...chunk,
          properties: {
            ...chunkProperties,
            durationMs: { type: 'integer', minimum: model.minChunkDurationMs, maximum: model.maxChunkDurationMs },
            positiveStyles: limitArray('positiveStyles', model.maxPositiveStyles),
            negativeStyles: limitArray('negativeStyles', model.maxNegativeStyles),
            contextAdherence: enumSchema(model.contextAdherenceOptions),
          },
        },
      },
    },
  }
}

/** The Operation registry owns schema specialization; MCP transports it verbatim. */
export function projectProductionToolInputSchema(
  operation: ProjectAgentOperationDefinition,
  context: ProjectProductionContext,
): ProjectAgentToolInputSchema | null {
  const modality = operation.productionModality
  if (!modality) return operation.toolInputSchema
  const pools = context.productionCapabilities
  const models = modality === 'video' ? pools.video.models : pools[modality]
  if (models.length === 0) return null
  if (models.length !== 1) throw new Error(`PRODUCTION_TOOL_MODEL_SELECTION_AMBIGUOUS:${modality}`)
  const model = models[0]
  if (productionModelUnavailableReason(context, model)) return null
  let matched = false
  function visit(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(visit)
    if (!isObject(value)) return value
    if (isObject(value.properties) && 'expectedConfigurationVersion' in value.properties) {
      const properties = { ...value.properties }
      delete properties.expectedConfigurationVersion
      return visit({ ...value, properties, required: Array.isArray(value.required) ? value.required.filter((field) => field !== 'expectedConfigurationVersion') : [] })
    }
    if (isObject(value.properties) && (modality === 'voice'
      ? 'previewText' in value.properties && 'description' in value.properties
      : ('mediaType' in value.properties && 'schemaId' in value.properties)
        || (modality === 'video' && 'resourceId' in value.properties && 'prompt' in value.properties && 'durationSeconds' in value.properties))) {
      matched = true
      return projectConfiguredModel(value, model, context)
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
  }
  const schema = operation.toolInputSchema
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, visit(value)]))
  if (!matched) throw new Error(`PRODUCTION_TOOL_GENERATION_INPUT_MISSING:${operation.id}`)
  return {
    ...schema, properties,
    description: 'The model is selected in settings and applied by the server. Fill only the exposed creative parameters. Model identity and fixed parameters are not input fields.',
  }
}
