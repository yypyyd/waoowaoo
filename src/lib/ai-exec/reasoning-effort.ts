import {
  getUserModelConfig,
  resolveModelCapabilityGenerationOptions,
} from '@/lib/config-service'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { isPlatformProviderCredentialMode } from '@/lib/deployment/config'
import {
  parseReasoningEffort,
  type ReasoningEffort,
} from '@/lib/ai-registry/reasoning-effort'
import { resolveBuiltinCapabilitiesByModelKey } from '@/lib/ai-registry/capabilities-catalog'
import { parseModelKeyStrict } from '@/lib/ai-registry/selection'

/**
 * `utility` covers short mechanical LLM work that is not the Primary Agent and
 * not professional creative analysis — conversation summarisation, normalisation
 * and similar. It exists as its own declared role so those callers stop
 * borrowing the assistant or analysis role and inheriting an effort level that
 * was tuned for a different job.
 */
export type ReasoningEffortPurpose = 'analysis' | 'assistant' | 'utility'

const PLATFORM_REASONING_EFFORT_ENV: Record<ReasoningEffortPurpose, string> = {
  analysis: 'PLATFORM_DEFAULT_ANALYSIS_REASONING_EFFORT',
  assistant: 'PLATFORM_DEFAULT_ASSISTANT_REASONING_EFFORT',
  utility: 'PLATFORM_DEFAULT_UTILITY_REASONING_EFFORT',
}

function readPlatformReasoningEffort(purpose: ReasoningEffortPurpose): ReasoningEffort | undefined {
  const envName = PLATFORM_REASONING_EFFORT_ENV[purpose]
  const raw = process.env[envName]?.trim()
  return raw
    ? parseReasoningEffort(raw, envName)
    : undefined
}

export async function resolveReasoningEffort(input: {
  userId: string
  modelKey: string
  purpose: ReasoningEffortPurpose
  projectId?: string
  explicit?: unknown
}): Promise<ReasoningEffort> {
  ensureAiCatalogsRegistered()

  const capabilities = resolveBuiltinCapabilitiesByModelKey('llm', input.modelKey)?.llm
  if (!capabilities) {
    // Custom platform instances (openrouter:<suffix>) carry user-defined model
    // ids outside the builtin catalog; skip reasoning effort negotiation.
    const provider = parseModelKeyStrict(input.modelKey)?.provider ?? ''
    if (provider.includes(':')) return 'none'
    throw new Error(`LLM_CAPABILITIES_REQUIRED:${input.modelKey}`)
  }
  if (!capabilities.reasoningEffortOptions?.length) return 'none'
  const modelDefault = parseReasoningEffort(
    capabilities.defaultReasoningEffort,
    `${input.modelKey}:default`,
  )
  const config = await getUserModelConfig(input.userId)
  const capabilityDefaults = config.capabilityDefaults
  const candidate = isPlatformProviderCredentialMode()
    ? readPlatformReasoningEffort(input.purpose) ?? modelDefault
    : modelDefault

  const validated = resolveModelCapabilityGenerationOptions({
    modelType: 'llm',
    modelKey: input.modelKey,
    capabilityDefaults,
    runtimeSelections: { reasoningEffort: candidate },
  }).reasoningEffort

  const effort = parseReasoningEffort(validated, `${input.purpose}:${input.modelKey}`)
  // Runtime callers can repeat the fixed choice, but cannot override it.
  if (input.explicit !== undefined
    && parseReasoningEffort(input.explicit, `${input.purpose}:runtime`) !== effort) {
    throw new Error(`LLM_REASONING_EFFORT_FIXED:${input.modelKey}`)
  }
  return effort
}
