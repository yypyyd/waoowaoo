import type { BillingQuoteView, OperationPlan } from './plan-contract'
import type { ProjectAgentOperationContext, ProjectAgentOperationDefinition } from './types'
import {
  hashOperationPlanArtifacts,
  type OperationPlanArtifactHashes,
} from './operation-plan-snapshot'
import { quoteOperationPlan } from './planning'
import { freezeProjectVideoRatioIntoPlan } from './project-video-ratio-policy'

export type OperationPlanArtifactKey = keyof OperationPlanArtifactHashes

export type CurrentOperationPlanArtifacts = OperationPlanArtifactHashes & {
  readonly plan: OperationPlan
  readonly quote: BillingQuoteView
}

export function changedOperationPlanArtifacts(
  snapshot: OperationPlanArtifactHashes,
  current: OperationPlanArtifactHashes,
): OperationPlanArtifactKey[] {
  return (['inputHash', 'planHash', 'quoteHash'] as const).filter((key) => snapshot[key] !== current[key])
}

export async function buildCurrentOperationPlanArtifacts<Input>(params: {
  operation: ProjectAgentOperationDefinition<Input, unknown>
  ctx: ProjectAgentOperationContext
  normalizedInput: Input
}): Promise<CurrentOperationPlanArtifacts> {
  if (!params.operation.plan) {
    throw new Error(`BILLABLE_OPERATION_PLAN_MISSING:${params.operation.id}`)
  }
  const rawCurrentPlan = await params.operation.plan({
    ...params.ctx,
    writer: null,
    executionAuthorization: null,
  }, params.normalizedInput)
  const currentPlan = await freezeProjectVideoRatioIntoPlan(rawCurrentPlan)
  const currentQuote = await quoteOperationPlan(currentPlan)
  return {
    plan: currentPlan,
    quote: currentQuote,
    ...hashOperationPlanArtifacts({
      normalizedInput: params.normalizedInput,
      plan: currentPlan,
      quote: currentQuote,
    }),
  }
}

/** @deprecated Prefer buildCurrentOperationPlanArtifacts when the plan body is needed. */
export async function buildCurrentOperationPlanArtifactHashes<Input>(params: {
  operation: ProjectAgentOperationDefinition<Input, unknown>
  ctx: ProjectAgentOperationContext
  normalizedInput: Input
}): Promise<OperationPlanArtifactHashes> {
  const current = await buildCurrentOperationPlanArtifacts(params)
  return {
    inputHash: current.inputHash,
    planHash: current.planHash,
    quoteHash: current.quoteHash,
  }
}