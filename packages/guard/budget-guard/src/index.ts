/**
 * Whole-session output-token budget guard. It counts every output token a
 * session's model calls generated — successful, interrupted, and retried
 * attempts alike — clamps each next request's `maxTokens` to the remainder,
 * and refuses further steps once the budget is spent, closing the turn with
 * the durable `budget-exhausted` reason instead of an error.
 *
 * @module @deepseek-ai/dsh-budget-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { LlmError, lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session' {
  interface TurnEndReasonMap {
    /**
     * The session-wide output-token budget configured by `dsh-budget-guard`
     * ran out, so its `agent/pre-step` listener refused to enter another step.
     * The loop never emits this reason on its own.
     */
    'budget-exhausted': { kind: 'budget-exhausted' }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Output tokens this session's model calls generated, per `dsh-budget-guard`. */
    'budget-guard-spent': number
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'budget-guard'

/** The `llm` service resolves the adapter-owned per-request cap; the projection registry owns the spend fold. */
export const inject = ['llm', 'sessionProjections']

/**
 * Plugin config. `maxOutputTokens` must be a positive safe integer; a missing,
 * zero, or fractional value fails plugin load in `apply` (misconfiguration
 * fails loud).
 */
export interface Config {
  /** Total output tokens this session's model calls may generate. */
  maxOutputTokens?: number
}

export const Config: z<Config> = z.object({
  maxOutputTokens: z.number(),
})

/** Output tokens one durable settlement recorded, zero when it carried none. */
function outputTokensOf(event: SessionEvent): number {
  if (event.type === 'assistant/message') return event.data.usage?.outputTokens ?? 0
  if (event.type === 'assistant/attempt') {
    // The embedded compact stream is the only usage carrier for a failed,
    // retried, or cancelled attempt; its `usage` chunk stays a raw record.
    return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage.outputTokens ?? 0
  }
  return 0
}

/** Host-only fold of generated output tokens over committed session events. */
export const budgetSpentProjectionDefinition = {
  key: 'budget-guard-spent',
  stateVersion: 1,
  stateSchema: zod.number().int().nonnegative(),
  init: () => 0,
  // A primitive sum satisfies the same-reference rule for uninterested events
  // by value: `Object.is(spent + 0, spent)` holds.
  apply: (spent: number, event: SessionEvent): number => spent + outputTokensOf(event),
} satisfies ProjectionDefinition<'budget-guard-spent', number>

/**
 * Register the spend fold, the `agent/pre-step` refusal at a spent budget,
 * and the `agent/request` clamp.
 * @param ctx - plugin context; every registration is an effect disposed with it.
 * @param config - validated {@link Config}; re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const budget = config.maxOutputTokens
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error(`budget-guard: maxOutputTokens must be a positive safe integer, got ${String(budget)}`)
  }

  // The registry lazily folds the whole in-memory log on first touch, so a
  // resumed session — or this plugin mounted after one — starts from the
  // spend its durable settlements already record.
  ctx.sessionProjections.register(budgetSpentProjectionDefinition)
  const spentOf = (session: Session): number => {
    /* v8 ignore next -- the plugin's own registration owns this key for its whole lifetime */
    return ctx.sessionProjections.stateOf(session, 'budget-guard-spent') ?? 0
  }

  // A spent budget refuses the step here: the loop sends no request and the
  // durable turn/end carries the merged budget-exhausted reason.
  ctx.on('agent/pre-step', ({ agent }, next): Promise<PreStepDecision> => {
    if (budget - spentOf(agent.session) <= 0) {
      return Promise.resolve<PreStepDecision>({ kind: 'reject', reason: { kind: 'budget-exhausted' } })
    }
    return next()
  })

  // Every attempt (retries included) re-runs this waterfall, and a failed
  // attempt's settlement is committed before its retry prepares the next
  // request, so the clamp always sees the retry's own generation.
  ctx.on('agent/request', async ({ agent, signal }, next): Promise<LlmCallConfig> => {
    const config = await next()
    const remaining = budget - spentOf(agent.session)
    if (remaining <= 0) {
      // Only an in-step retry reaches a spent budget here — the admitting
      // pre-step already refused new steps. It gets the minimal legal ceiling
      // instead of an unclamped full-size request.
      return { ...config, maxTokens: 1 }
    }
    const cap = config.maxTokens ?? await probeCap(ctx, config, signal)
    if (cap === undefined || remaining >= cap) return config
    return { ...config, maxTokens: remaining }
  })
}

/**
 * Resolve the per-request cap the adapter would materialize for a proposal
 * that omits `maxTokens`. `prepareCall` binds capability metadata without
 * dispatching (the one-shot is consumed only by `stream`), so this probe has
 * no request side effect.
 * @param ctx - context carrying the `llm` service.
 * @param config - the proposal whose effective cap is needed.
 * @param signal - the current turn's cancellation signal.
 * @returns the materialized cap, or undefined when the route cannot resolve
 *   one; a non-LLM failure propagates because the loop's own `prepareCall`
 *   would hit the same failure right after.
 */
async function probeCap(ctx: Context, config: LlmCallConfig, signal: AbortSignal): Promise<number | undefined> {
  try {
    return (await ctx.llm.prepareCall(config, signal)).config.maxTokens
  } catch (error: unknown) {
    if (!(error instanceof LlmError)) throw error
    // An unresolvable route (no adapter yet, unsupported effort, …) is the
    // loop's own failure to surface; clamping stays exact for explicit values.
    return undefined
  }
}
