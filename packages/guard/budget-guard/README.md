---
description: "Session-wide output-token budget: count every generated token including retries, clamp each request's maxTokens to the remainder, and end spent turns with a durable reason, for users and maintainers composing the guard."
kind: "package-reference"
---

# @deepseek-ai/dsh-budget-guard

English | [中文](README.zh.md)

## Summary

Use this package to cap how many output tokens one session's model calls may generate in total. It counts every durable settlement — successful messages, interrupted prefixes, and failed or retried attempts alike — clamps each next request's `maxTokens` to the remainder, and once the budget is spent it refuses further steps without sending a request, closing the turn with the durable `budget-exhausted` reason instead of an error. The budget is per session (each subagent session gets its own), requires a positive integer in `cordis.yml`, and is opt-in: it is not part of the `dsh` base bundle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the plugin with an explicit budget; a missing, zero, or fractional value fails plugin load instead of silently disabling the guard.

```yaml
- name: '@deepseek-ai/dsh-budget-guard'
  config:
    maxOutputTokens: 200000
```

### When to choose it

Choose it when a session's total generation must stay bounded — shared quotas, unattended runs, or long tool loops — and a per-request ceiling alone is not enough. Avoid it when you only want to cap a single response; set the agent's per-request `maxTokens` instead, because this guard's whole point is that spending accumulates across steps, retries, and interruptions until the session stops requesting.

### What you get

Each request asks for at most the remaining budget: `maxTokens` becomes `min(existing per-request cap, remainder)`, where the existing cap is the agent's explicit `maxTokens` or the adapter-materialized default. A step truncated at that ceiling (`finish=length`) never executes its tool calls — the loop's own rule — and the truncated generation still lands in the budget. When nothing remains, the next step is refused before any request: the turn ends `{ kind: 'budget-exhausted' }`, a normal termination a client reads like `max-tokens`, not an error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Three listeners over documented extension points; no loop-private state.

### Spending is read from the durable log

The guard contributes a host-only session projection (`budget-guard-spent`) that folds `usage.outputTokens` out of every `assistant/message` (successful and interrupted attempts) plus the `usage` chunk embedded in every `assistant/attempt` stream — the only carrier for retried, failed, and cancelled attempts, so retries count against the same budget. The projection registry maintains the fold incrementally from committed events and lazily replays the whole in-memory log on first touch, so a resumed session — or the plugin mounted after one — starts from the spend its durable settlements already record. A failed attempt settles into the log before its retry prepares the next request, so every attempt — first or retry — clamps against a remainder that already includes it.

### Clamping and the adapter default

An `agent/request` listener returns `{ ...config, maxTokens: min(cap, remaining) }` after `next()`. When the proposal carries no `maxTokens` (the loop strips adapter-defaulted values from later proposals), the listener resolves the cap with `ctx.llm.prepareCall(config)` — capability binding without dispatch, since the one-shot is consumed only by `stream` — and keeps the request unchanged when the remainder covers the cap or the route declares none. The clamped value travels in the logged `request/header`, so model-visible requests stay reconstructable from the log.

### Termination with a named reason

An `agent/pre-step` listener rejects once the remainder reaches zero. The loop records a reject's carried `reason` verbatim as the turn's `turn/end`; this plugin merges the `budget-exhausted` variant into `TurnEndReasonMap` by declaration merging. Retries do not re-run pre-step, so a retry launched after the budget hit zero clamps to the minimal legal ceiling (`maxTokens: 1`) instead of sending an unclamped request.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`/`inject`/`Config`/`apply`, the `TurnEndReasonMap` merge, the spend projection, clamp, and refusal |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Architecture: the agent loop](../../../docs/architecture.md) — the `agent/pre-step` and `agent/request` waterfalls this guard hooks.
- [Session log](../../../docs/subsystems/session.md) — `assistant/message` and `assistant/attempt` settlements the budget reads.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional request ceiling

#### What the model sees

No prompt or schema changes. Each request carries a `max_tokens` no larger than the session's remaining budget, so later requests may truncate earlier than the route default; once the budget is spent, no further request is made and the turn ends without an error result.

#### Token effect

The guard itself adds zero tokens; it only bounds what the model may generate.

#### KV Cache effect

Clamping changes only the request's control fields, not its message prefix, so existing KV Cache entries stay reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Adapter-reported usage only** — attempts whose adapter reports no `usage` contribute zero to the accumulated spend; a budget over such a route is not enforced.
- **Per-session, not per-deployment** — every session (subagent children included) gets its own full budget; there is no shared cross-session pool.
- **Bounded retry overshoot** — an in-step retry launched after the budget hit zero still sends one request with `maxTokens: 1`, so the accumulated spend can exceed the budget by at most that request's ceiling.
- **One capability probe per attempt** — when the per-request cap comes from the adapter default, each attempt resolves it once via `prepareCall` in addition to the loop's own preparation.
- **Persisted clamp outlives the guard** — a clamped `maxTokens` is an explicit value in the logged request header, so removing the guard mid-session keeps the last clamp as the route's cap.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
