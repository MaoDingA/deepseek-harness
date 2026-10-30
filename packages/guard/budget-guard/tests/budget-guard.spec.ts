import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as BudgetGuard from '@deepseek-ai/dsh-budget-guard'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the output-token budget guard, driven through a real
 * agent loop against a scripted mock adapter (no network): the three budget
 * boundaries (spend 3,422 of 3,900 → next request clamped to 478; 3,899 → 1;
 * 3,900 → no request at all, turn closed `budget-exhausted`), retry generation
 * landing in the same budget, truncated tool calls staying unexecuted under a
 * clamped request, per-session budgets, resume seeding from the durable log,
 * listener unwind on plugin disposal, and fail-loud config validation.
 */

/** One clean text turn reporting the given output-token usage. */
function usageTextResponse(text: string, outputTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One failed attempt whose embedded stream carries the given usage. */
function usageFailureResponse(outputTokens: number): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 1, outputTokens } },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'fail once', code: 'SERVER' } } },
  ]
}

/** One truncated tool-call turn: usage is recorded, the call must not run. */
function truncatedToolCallResponse(outputTokens: number): StreamChunk[] {
  const callId = ToolCallId('c1')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'echo', argumentsDelta: '{"text":"x"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** An adapter whose capability lookup fails with a non-LLM error. */
class ExplodingAdapter extends LlmAdapter {
  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.reject(new Error('capability lookup failed'))
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    throw new Error('unreached')
  }
}

/** Boot the core spine, the loop, and the guard with one budget. */
async function harness(budget: number, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(BudgetGuard, { maxOutputTokens: budget })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function turnEndReasons(agent: Agent): TurnEndReason[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    .map(event => event.data.reason)
}

const maxTokensOf = (adapter: MockAdapter): (number | undefined)[] =>
  adapter.requests.map(request => request.maxTokens)

describe('budget boundaries', () => {
  it('spend 3,422 of 3,900: the next request is clamped to the 478-token remainder', async () => {
    const adapter = new MockAdapter([
      usageTextResponse('part', 3422),
      usageTextResponse('rest', 478),
    ], undefined, 8192)
    const ctx = await harness(3900, adapter)
    const agent = await ctx.agentLoop.create(SessionId('boundary-478'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    // The first request already clamps to the whole remaining budget (3,900
    // is below the adapter's 8,192 default); the second clamps to 478.
    expect(maxTokensOf(adapter)).toEqual([3900, 478])
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })

  it('spend 3,899 of 3,900: the next request is clamped to a single token', async () => {
    const adapter = new MockAdapter([
      usageTextResponse('part', 3899),
      usageTextResponse('x', 1),
    ], undefined, 8192)
    const ctx = await harness(3900, adapter)
    const agent = await ctx.agentLoop.create(SessionId('boundary-1'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(maxTokensOf(adapter)).toEqual([3900, 1])
  })

  it('spend 3,900 of 3,900: no further request is sent and the turn ends budget-exhausted', async () => {
    const adapter = new MockAdapter([usageTextResponse('all', 3900)], undefined, 8192)
    const ctx = await harness(3900, adapter)
    const agent = await ctx.agentLoop.create(SessionId('boundary-0'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'budget-exhausted' } },
    })
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }, { kind: 'budget-exhausted' }])
  })
})

describe('retry accounting', () => {
  it('settlements that report no usage contribute nothing to the budget', async () => {
    const adapter = new MockAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { message: 'no usage reported', code: 'SERVER' } } }],
      [{ type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'finish', reason: { kind: 'stop' } }],
    ])
    const ctx = await harness(10, adapter)
    ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))
    const agent = await ctx.agentLoop.create(SessionId('no-usage'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    // Neither the usage-less failed attempt nor its usage-less success spends
    // the budget, so no request is ever clamped.
    expect(maxTokensOf(adapter)).toEqual([undefined, undefined, undefined])
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })

  it('a failed attempt\'s generation counts toward the same budget as its retry', async () => {
    const adapter = new MockAdapter([
      usageFailureResponse(3400),
      usageTextResponse('ok', 22),
      usageTextResponse('next', 478),
    ], undefined, 8192)
    const ctx = await harness(3900, adapter)
    ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))
    const agent = await ctx.agentLoop.create(SessionId('retry-budget'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    send(agent, 'again')
    await waitForIdle(ctx, agent)

    // Attempt 1 clamps to the full 3,900; the failed attempt spends 3,400 of
    // them (its assistant/attempt stream carries the usage), so the retry
    // clamps to 500 and the next turn to 3,900 - 3,422 = 478.
    expect(maxTokensOf(adapter)).toEqual([3900, 500, 478])
  })

  it('a retry launched after the budget hit zero gets the minimal legal ceiling', async () => {
    const adapter = new MockAdapter([
      usageFailureResponse(3900),
      usageTextResponse('x', 1),
    ], undefined, 8192)
    const ctx = await harness(3900, adapter)
    ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))
    const agent = await ctx.agentLoop.create(SessionId('retry-at-zero'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    send(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(maxTokensOf(adapter)).toEqual([3900, 1])
    // The overspend (3,901 > 3,900) still refuses the next turn.
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }, { kind: 'budget-exhausted' }])
  })
})

describe('truncation under a clamped request', () => {
  it('a finish=length tool call is never executed and its generation still lands in the budget', async () => {
    let executions = 0
    const adapter = new MockAdapter([
      usageTextResponse('part', 3422),
      truncatedToolCallResponse(478),
    ], undefined, 8192)
    const ctx = await harness(3900, adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: '',
      parameters: { text: { type: 'string' } },
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'should not run' }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('truncated-under-clamp'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    send(agent, 'third')
    await waitForIdle(ctx, agent)

    expect(adapter.requests[1]?.maxTokens).toBe(478)
    expect(executions).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
    expect(turnEndReasons(agent)).toEqual([
      { kind: 'completed' },
      { kind: 'max-tokens' },
      { kind: 'budget-exhausted' },
    ])
    const truncated = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    expect(truncated?.type === 'assistant/message' && truncated.data).toMatchObject({
      turn: 2,
      step: 1,
      message: { content: [] },
      usage: { inputTokens: 10, outputTokens: 478 },
    })
  })
})

describe('cap resolution', () => {
  it('leaves an explicit per-agent maxTokens in control, clamping below it', async () => {
    const adapter = new MockAdapter([usageTextResponse('part', 3422)])
    const ctx = await harness(3900, adapter)
    const agent = await ctx.agentLoop.create(SessionId('explicit-cap'), {
      provider: 'mock',
      model: 'mock',
      maxTokens: 4096,
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    expect(maxTokensOf(adapter)).toEqual([3900])
  })

  it('keeps a request unchanged while the remaining budget covers the adapter default', async () => {
    const adapter = new MockAdapter([
      usageTextResponse('one', 3422),
      usageTextResponse('two', 10),
    ], undefined, 8192)
    const ctx = await harness(8192, adapter)
    const agent = await ctx.agentLoop.create(SessionId('headroom'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    // 8,192 remaining covers the adapter's 8,192 default: the guard proposes
    // no change and the request carries the materialized default itself.
    // After spending 3,422, the remainder 4,770 is below the default and the
    // guard clamps it into the request.
    expect(maxTokensOf(adapter)).toEqual([8192, 4770])
  })

  it('keeps a request unchanged when the adapter declares no default cap', async () => {
    const adapter = new MockAdapter([usageTextResponse('one', 10)])
    const ctx = await harness(1_000_000, adapter)
    const agent = await ctx.agentLoop.create(SessionId('no-default'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    expect(maxTokensOf(adapter)).toEqual([undefined])
  })

  it('propagates a non-LLM capability failure instead of masking it behind the clamp', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(1_000_000, adapter)
    ctx.llm.registerAdapter(['exploding'], new ExplodingAdapter())
    const agent = await ctx.agentLoop.create(SessionId('probe-failure'), { provider: 'exploding', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0)
    const [reason] = turnEndReasons(agent)
    expect(reason?.kind).toBe('error')
    expect(reason?.kind === 'error' && reason.error.message).toContain('capability lookup failed')
  })

  it('ignores an unresolvable route for clamping and lets the loop surface the route failure', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(1_000_000, adapter)
    const agent = await ctx.agentLoop.create(SessionId('no-route'), {})

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0)
    const [reason] = turnEndReasons(agent)
    expect(reason?.kind).toBe('error')
    expect(reason?.kind === 'error' && reason.error.message).toContain('no provider/model')
  })
})

describe('scope and lifecycle', () => {
  it('budgets each session independently', async () => {
    const adapter = new MockAdapter([
      usageTextResponse('a', 10),
      usageTextResponse('b', 10),
    ])
    const ctx = await harness(10, adapter)
    const first = await ctx.agentLoop.create(SessionId('isolation-a'), { provider: 'mock', model: 'mock' })
    const second = await ctx.agentLoop.create(SessionId('isolation-b'), { provider: 'mock', model: 'mock' })

    send(first, 'go')
    await waitForIdle(ctx, first)
    send(first, 'again')
    await waitForIdle(ctx, first)
    send(second, 'go')
    await waitForIdle(ctx, second)

    expect(adapter.requests).toHaveLength(2)
    expect(turnEndReasons(first)).toEqual([{ kind: 'completed' }, { kind: 'budget-exhausted' }])
    expect(turnEndReasons(second)).toEqual([{ kind: 'completed' }])
  })

  it('unwinds with its plugin and re-seeds a remount from the durable log', async () => {
    const adapter = new MockAdapter([
      usageTextResponse('all', 3900),
      usageTextResponse('rest', 478),
    ], undefined, 8192)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const guard = await ctx.plugin(BudgetGuard, { maxOutputTokens: 3900 })
    const agent = await ctx.agentLoop.create(SessionId('remount'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    await guard.dispose()
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    // The guard is gone, so nothing refuses the spent-budget step; the request
    // keeps the explicit 3,900 cap turn 1's clamp persisted into the header.
    expect(maxTokensOf(adapter)).toEqual([3900, 3900])

    const remounted = await ctx.plugin(BudgetGuard, { maxOutputTokens: 3900 })
    send(agent, 'third')
    await waitForIdle(ctx, agent)
    await remounted.dispose()

    // The fresh guard seeds 3,900 + 478 from the session log and refuses the
    // next step without sending a request.
    expect(adapter.requests).toHaveLength(2)
    expect(turnEndReasons(agent)).toEqual([
      { kind: 'completed' },
      { kind: 'completed' },
      { kind: 'budget-exhausted' },
    ])
  })
})

describe('config validation', () => {
  it('rejects a missing budget at load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(BudgetGuard, {})).rejects.toThrow('maxOutputTokens must be a positive safe integer')
  })

  it('rejects a zero budget at load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(BudgetGuard, { maxOutputTokens: 0 })).rejects.toThrow('maxOutputTokens must be a positive safe integer')
  })

  it('rejects a fractional budget at load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(BudgetGuard, { maxOutputTokens: 1.5 })).rejects.toThrow('maxOutputTokens must be a positive safe integer')
  })
})
