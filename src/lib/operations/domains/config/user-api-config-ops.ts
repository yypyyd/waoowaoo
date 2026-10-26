import { z } from 'zod'
import { getUserApiConfig, putUserApiConfig } from '@/lib/user-api/api-config'
import type { ProjectAgentOperationRegistryDraft } from '@/lib/operations/types'
import { defineOperation } from '@/lib/operations/define-operation'
import { capabilitySelectionCommandSchema } from '@/lib/ai-registry/capability-selection-command'
import { parseModelKeyStrict } from '@/lib/ai-registry/selection'

const modelKeySchema = z.string()
  .refine((value) => value === '' || parseModelKeyStrict(value)?.modelKey === value, {
    message: 'MODEL_KEY_INVALID',
  })
  .describe('Exact provider::modelId key of the Assistant model. Pass an empty string to clear it.')

const apiConfigInputSchema = z.object({
  providers: z.array(z.object({
    id: z.string().trim().min(1)
      .describe('Exact provider identity returned by get_user_api_config; unsupported identities fail.'),
    name: z.string().trim().min(1).describe('User-visible provider name.'),
    baseUrl: z.string().trim().min(1).optional().describe('Optional provider API base URL.'),
    apiKey: z.string().optional()
      .describe('Provider API key. Omit to preserve the stored key; pass an empty string to remove it.'),
  }).strict()).optional(),
  models: z.array(z.object({
    modelId: z.string().trim().min(1).describe('Provider model ID.'),
    name: z.string().trim().min(1).describe('User-visible model name.'),
    type: z.enum(['llm', 'image', 'video', 'music'])
      .describe('The model modality implemented by this model.'),
    provider: z.string().trim().min(1).describe('Exact configured provider ID.'),
  }).strict()).optional(),
  defaultModels: z.object({
    assistantModel: modelKeySchema.optional(),
  }).strict().optional(),
  capabilityDefaults: capabilitySelectionCommandSchema.optional(),
  workflowConcurrency: z.object({
    analysis: z.number().int().min(1).optional(),
    image: z.number().int().min(1).optional(),
    video: z.number().int().min(1).optional(),
  }).strict().optional(),
}).strict()

export function createUserApiConfigOperations(): ProjectAgentOperationRegistryDraft {
  return {
    get_user_api_config: defineOperation({
      id: 'get_user_api_config',
      summary: 'Read user API config (masked provider credential state, pricing/capabilities enrichment).',
      intent: 'query',
      effects: {
        writes: false,
        billable: false,
        destructive: false,
        overwrite: false,
        bulk: false,
        externalSideEffects: false,
        longRunning: false,
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: async (ctx) => await getUserApiConfig(ctx.userId),
    }),
    put_user_api_config: defineOperation({
      id: 'put_user_api_config',
      summary: 'Save/update user API config.',
      intent: 'act',
      effects: {
        writes: true,
        workspaceResourceImpact: 'none',
        billable: false,
        destructive: false,
        overwrite: true,
        bulk: false,
        externalSideEffects: false,
        longRunning: false,
      },
      confirmation: {
        required: true,
        summary: '将覆盖更新用户 API 配置（可能影响后续调用与计费）。系统会在获得明确批准后执行同一份已审核请求。',
      },
      inputSchema: apiConfigInputSchema,
      outputSchema: z.unknown(),
      executeInTransaction: async (ctx, input, transaction) =>
        await putUserApiConfig(ctx.userId, input, transaction),
    }),
  }
}
