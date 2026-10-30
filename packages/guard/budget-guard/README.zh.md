---
description: "会话级输出 token 预算：累计包括重试在内的所有已生成 token，把每次请求的 maxTokens 钳制到剩余额度，并在预算耗尽时以明确的持久原因结束轮次，面向组装该守卫的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-budget-guard

[English](README.md) | 中文

## 概述

使用本包为一个会话的模型调用总生成量设置上限。它累计每一个持久结算——成功消息、被中断的前缀、以及失败或重试的尝试——并把每次请求的 `maxTokens` 钳制到剩余额度；预算耗尽后，它不再发送请求而是拒绝后续步骤，以持久的 `budget-exhausted` 原因结束轮次，而不是报错。预算按会话计算（每个 subagent 会话各有一份），必须在 `cordis.yml` 中给出正整数，且为选配：不属于 `dsh` 基础 bundle。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

加入插件并显式给出预算；缺失、为零或为小数的值会让插件加载失败，而不是静默关闭守卫。

```yaml
- name: '@deepseek-ai/dsh-budget-guard'
  config:
    maxOutputTokens: 200000
```

### 何时选择

当会话的总生成量必须有界——共享配额、无人值守运行、或长工具循环——而单次请求上限不够时选择它。若只想限制单个响应，请改设 agent 的单次 `maxTokens`：本守卫的意义就在于支出会跨步骤、跨重试、跨中断持续累计，直到会话停止请求。

### 你会得到什么

每次请求最多申请剩余预算：`maxTokens` 变为 `min(既有单次上限, 剩余额度)`，既有上限是 agent 显式 `maxTokens` 或适配器物化的默认值。在该上限处被截断的步骤（`finish=length`）不会执行其工具调用——这是 loop 自身规则——且被截断的生成仍计入预算。额度耗尽时，下一个步骤在任何请求之前被拒绝：轮次以 `{ kind: 'budget-exhausted' }` 结束，这是客户端可像 `max-tokens` 一样读取的正常终止，而非错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

三个监听器挂在文档化扩展点上，没有 loop 私有状态。

### 支出读取自持久日志

守卫贡献一个 host-only 会话投影（`budget-guard-spent`），从每个 `assistant/message`（成功与被中断尝试）的 `usage.outputTokens` 加上每个 `assistant/attempt` 流中内嵌的 `usage` chunk 折叠出累计值——后者是重试、失败与取消尝试的唯一载体，因此重试计入同一预算。投影注册表从已提交事件增量维护该折叠，并在首次 touch 时惰性重放整个内存日志，因此恢复的会话——或在本插件挂载之前就存在的会话——都从其持久结算已记录的支出起步。失败尝试在其重试准备下一个请求之前先结算进日志，因此每次尝试——无论首发还是重试——钳制时看到的剩余额度都已包含它。

### 钳制与适配器默认值

一个 `agent/request` 监听器在 `next()` 之后返回 `{ ...config, maxTokens: min(上限, 剩余) }`。当提案不带 `maxTokens`（loop 会从后续提案中删除适配器默认值）时，监听器用 `ctx.llm.prepareCall(config)` 解析上限——只绑定能力不派发，one-shot 仅在 `stream` 时消耗——剩余额度覆盖上限或路由未声明上限时保持请求不变。钳制值随日志中的 `request/header` 落盘，模型可见的请求始终可从日志重建。

### 以命名原因终止

一个 `agent/pre-step` 监听器在剩余额度归零时拒绝。loop 会把 reject 携带的 `reason` 原样记为轮次的 `turn/end`；本插件通过声明合并向 `TurnEndReasonMap` 合并 `budget-exhausted` 变体。重试不重跑 pre-step，因此预算归零后发起的重试会钳制到最小合法上限（`maxTokens: 1`），而不是发出未钳制的请求。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`/`inject`/`Config`/`apply`、`TurnEndReasonMap` 合并、支出投影、钳制与拒绝 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。

- [架构：agent loop](../../../docs/architecture.zh.md) — 本守卫挂接的 `agent/pre-step` 与 `agent/request` waterfall。
- [会话日志](../../../docs/subsystems/session.zh.md) — 预算读取的 `assistant/message` 与 `assistant/attempt` 结算。
- [guard 组地图](../README.zh.md) — 兄弟 guard 包与 loop 卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 条件性请求上限

#### 模型看到什么

提示词与 schema 不变。每个请求携带的 `max_tokens` 不超过会话剩余预算，因此后续请求可能早于路由默认值被截断；预算耗尽后不再发出请求，轮次结束时没有错误结果。

#### Token 影响

守卫自身不增加任何 token；它只约束模型可生成的量。

#### KV Cache 影响

钳制只改变请求的控制字段，不改变消息前缀，因此既有 KV Cache 条目仍可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了守卫不适用的情况，是当前的包约束，而非任务积压。

- **只认适配器上报的 usage** — 适配器未上报 `usage` 的尝试对累计支出贡献为零；在这种路由上预算不受强制。
- **按会话而非按部署** — 每个会话（包括 subagent 子会话）各有一份完整预算；没有跨会话共享池。
- **有界的重试越界** — 预算归零后在步骤内发起的重试仍会发出一次 `maxTokens: 1` 的请求，累计支出最多可能超出该请求的上限。
- **每次尝试一次能力探测** — 单次上限来自适配器默认值时，每次尝试除 loop 自身的准备外还会经 `prepareCall` 解析一次。
- **钳制值比守卫活得久** — 被钳制的 `maxTokens` 是已记录请求 header 中的显式值，会话中途移除守卫会保留最后一次钳制作为路由上限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
