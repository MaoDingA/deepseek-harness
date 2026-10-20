# @deepseek-ai/dsh-davinci（editors/davinci）

驱动正在运行的 DaVinci Resolve 的剪辑能力插件：Service Definition（`ctx.davinci`）、本地 Provider（fuscript）、模型可见的 `resolve_*` 工具三角色合并在一个包内（角色在结构上仍分离：抽象服务 / 提供者 / 消费者）。这是仓库内 `editors/` 的个人编辑器插件，走 profile 用户补丁层以源码启动，不进 `packages/` 发布集。

## 架构

```
src/types.ts     词汇表：调用信封、Spec、各操作结果、失败码封闭联合（纯类型）
src/protocol.ts  纯协议层：banner 剥离、ERROR <code>: <message> 解析、kv 投影、timeout 钳制
src/lua.ts       Lua 源：共享 prelude + 每操作一个 body（JSON.stringify 内嵌参数）
src/service.ts   抽象 DavinciService：ctx key 合并、resolve() 默认化、类型化领域方法
src/provider.ts  FuscriptDavinci：execFile 起 fuscript、fuscript 路径自动发现、截图
src/tools.ts     12 个 resolve_* 工具 + systemPrompt 剪辑约定节 + 审批门
src/index.ts     插件入口：name/inject/Config/apply
```

传输协议：每次调用 spawn 一个 fuscript 进程执行 prelude+body；输出为 `key=value` 行（首个 `=` 后均为值），失败行 `ERROR <code>: <message>`。刻意不走 sandbox seam——fuscript 需要与 Resolve 应用本地 scripting IPC 通信，隔离会切断它；破坏性变更改由工具层审批门把关。

## 工具面（16 个）

| 工具 | 类型 | 说明 |
|---|---|---|
| `resolve_project_info` | 读 | 版本、工程名、全部时间线、当前时间线轨道/帧范围 |
| `resolve_media_pool` | 读 | 列 bin 与素材（名、源 Start TC、时长、fps、路径） |
| `resolve_timeline_items` | 读 | 视频轨条目列表，可按记录帧窗口分页（单次上限 200） |
| `resolve_find_by_tc` | 读 | 按源 TC 全轨确定性扫描 V1，VFX 交付物对位首选 |
| `resolve_find_clip` | 读 | 一次调用全时间线×全视频轨按名搜索条目；找游离交付物/按名定位的首选，替代翻页扫描 |
| `resolve_seek` | 视觉 | 移动播放头到记录帧/TC |
| `resolve_screenshot` | 视觉 | 截屏到工作区 PNG，配合 `read_image`（需图像路由）；要求 Resolve 为前台应用，否则报错并指名当前前台应用，可 `activate: true` 自动前置 |
| `resolve_switch_timeline` | 会话 | `Project:SetCurrentTimeline` 按 1 基 index 或精确 name 切换当前时间线（不改内容、不审批） |
| `resolve_place_clip` | 写·审批 | MediaPool:AppendToTimeline overwrite 贴片段（贴视效与嵌套组装共用入口） |
| `resolve_delete_item` | 写·审批 | Timeline:DeleteClips 按轨道+起始帧删除条目 |
| `resolve_add_marker` | 写·审批 | Timeline:AddMarker 绝对帧时间线标记 |
| `resolve_audio_timeline_items` | 读 | 音频轨条目列表（套片/音画合套用，与 V1 视频轨条目比对帧范围） |
| `resolve_render_status` | 读 | 渲染队列现状：任务数、是否渲染中、当前格式/codec 数量 |
| `resolve_add_render_job` | 写·审批 | AddRenderJob 当前时间线入队到指定 targetDir，保留当前预设（本 Resolve 20.3.2.9 无预设/格式表，只能沿用 UI 现行） |
| `resolve_start_rendering` | 写·审批 | StartRendering 全部或指定 jobIds |
| `resolve_stop_rendering` | 写·审批 | StopRendering 全部或指定 jobIds |

### 本组术语（RESOLVE_SECTION 提示节已记录）

- **套片**：在 EP04 项目语境下是"音画合套 + 嵌套组装"两个子流程的合称：
  - 音画合套：SOUNDS 里的长 wav（如 `0130 4ji.wav` ≈ 一集混音）和 V1 上的镜头逐一对齐，检查每段视频都落在混音覆盖范围内；
  - 嵌套组装：TL bin 里的嵌套时间线（按日期命名，e.g. `EP04_20260129`）作为单条目贴到父时间线 V1 上。
- **贴视效**：VFX 交付物（`ZY_EP04_4650_CMP_v006.mov` 等）按源 Start TC 匹配到 V1 段落后贴 V2，`resolve_place_clip` 的 V2 贴放约定已经在此。
- **输出**：渲染队列流；`LoadRenderPreset("1080p")` 等预设加载在本 Resolve 20.3.2.9 全部 `false`，`GetRenderFormats()` 也返回空表——只能依赖 UI 里现行的渲染设置。

写入工具在 execute 内先经 `requireWriteApproval`（机会式 `ctx.get('approval')`，一次性 `allowed-once` 才执行；无通道/无 agent/`rejected`/`cancelled`/`unavailable` 分别抛模型可读错误，fail-closed）。审批提示就是用户同意的方式——不要在聊天里绕行先问。

## Config（cordis.yml 可配）

| 字段 | 默认 | 说明 |
|---|---|---|
| `fuscriptPath` | 自动发现 | 省略时取 `/Applications` 下最高版本 `DaVinci Resolve*/…/fuscript` |
| `defaultTimeoutMs` | 30000 | 单次脚本调用预算 |
| `maxTimeoutMs` | 120000 | 请求预算上限 |
| `screenshotDir` | `.resolve-agent` | 截图输出目录（相对工作区） |

## 挂载与运行

两个 profile 的用户补丁层（`~/.dsh/profiles/<name>/cordis.patch.yml`）已插入：

```yaml
- insert:
    - id: davinci-resolve
      name: '/Users/phenom8010/code/github/deepseek-harness/editors/davinci/src/index.ts'
```

`pnpm dsh --profile web --dump-config` 验证组合；`node --import tsx/esm editors/davinci/smoke.ts` 对运行中的 Resolve 做只读冒烟（当前机器实测：Resolve 20.3.2.9，工程 EP04，6 条时间线；媒体池 SC/TL/REF/VFX/OP 均可列出）。

## 测试

`editors/davinci/tests/`（已并入根 vitest 收集范围）：协议解析与投影、banner 剥离、timeout 钳制、fuscript 发现排序、审批门全部非授权路径、真实 Context 组合下 16 工具注册（含音频轨列表与渲染队列流）。包 tsconfig 走 project references（已加入 `tsconfig.host.json`）。

## Model Experience

- 模型看到：systemPrompt 的剪辑约定节（order 120）+ 16 个工具 schema 与描述；工具结果为格式化文本（失败带 `ERROR [code] message`）。
- Token 效应：工具 schema 每请求常驻；约定节约 6 行。
- KV Cache 效应：注册集合稳定时前缀稳定。

## Known Limitations and Deferred Work

- **修剪不可用**：本机 Resolve 20.3.2.9 活体探测 `TimelineItem` 无 `SetStart`/`SetEnd`，`Timeline` 无 `MoveClips`；v1 以 delete+重贴组合替代，真正的边界修剪待 Resolve scripting API 支持。
- **渲染预设不可编程**：本机 Resolve 20.3.2.9 的 `Project:LoadRenderPreset("1080p"|"4K"|"4K DCI"|nil)` 全部返回 `false`，`GetRenderPresets()` 与 `GetRenderFormats()` 返回空表；`resolve_add_render_job` 只能沿用 UI 里现行的渲染预设/格式，无法在工具里切换预设（如需改，请去 Resolve Deliver 页手动设好再调用）。
- **macOS only**：截图依赖 `screencapture`，fuscript 发现扫 `/Applications`。
- **单实例假设**：连到本机唯一运行中的 Resolve；多开时行为未定义。
- **headless 默认只读**：headless profile 审批策略 `never` 使写入自动拒绝；需要无人值守写入时要显式改策略。
- **视觉回路需图像路由**：`resolve_screenshot` 产出的 PNG 要经 `read_image` 进模型，而 DeepSeek 适配器当前 `inputModalities: ['text']`。
- **协议限制**：kv 行协议在名称含换行时会破坏行结构；`=` 无碍（首个 `=` 分割）。
- **并发**：所有工具未标 `isConcurrencySafe`（保守串行）；Resolve 侧脚本本身也是串行语义。
