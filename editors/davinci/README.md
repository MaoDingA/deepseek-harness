# @deepseek-ai/dsh-davinci（editors/davinci）

驱动正在运行的 DaVinci Resolve 的剪辑能力插件：Service Definition（`ctx.davinci`）、本地 Provider（fuscript）、模型可见的 `resolve_*` 工具三角色合并在一个包内（角色在结构上仍分离：抽象服务 / 提供者 / 消费者）。这是仓库内 `editors/` 的个人编辑器插件，走 profile 用户补丁层以源码启动，不进 `packages/` 发布集。

## 架构

```
src/types.ts     词汇表：调用信封、Spec、各操作结果、失败码封闭联合（纯类型）
src/protocol.ts  纯协议层：banner 剥离、ERROR <code>: <message> 解析、kv 投影、timeout 钳制
src/lua.ts       Lua 源：共享 prelude + 每操作一个 body（JSON.stringify 内嵌参数）
src/service.ts   抽象 DavinciService：ctx key 合并、resolve() 默认化、类型化领域方法
src/provider.ts  FuscriptDavinci：execFile 起 fuscript、fuscript 路径自动发现、截图
src/tools.ts     19 个 resolve_* 工具 + systemPrompt 剪辑约定节 + 审批门
src/index.ts     插件入口：name/inject/Config/apply
```

传输协议：每次调用 spawn 一个 fuscript 进程执行 prelude+body；输出为 `key=value` 行（首个 `=` 后均为值），失败行 `ERROR <code>: <message>`。刻意不走 sandbox seam——fuscript 需要与 Resolve 应用本地 scripting IPC 通信，隔离会切断它；破坏性变更改由工具层审批门把关。

## 工具面（19 个）

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
| `resolve_place_clip` | 写·审批 | 在 trackIndex+recordFrame 贴片段。脚本面仅有 `MediaPool:AppendToTimeline`（21.1.1.10 上其 `recordFrame`/`trackIndex`/`insertType` 选项被完全忽略，总是落到 V1 末尾），所以本工具 = append + 读回落点 + 与请求轨道/帧严格比对，不一致时 `DeleteClips` 回滚并报 `ERROR mislanded-placement`。真正的定位贴段请用 Edit 页 UI（拖拽/`Select+`）驱动 |
| `resolve_delete_item` | 写·审批 | Timeline:DeleteClips 按轨道+起始帧删除条目 |
| `resolve_add_marker` | 写·审批 | Timeline:AddMarker 绝对帧时间线标记 |
| `resolve_audio_timeline_items` | 读 | 音频轨条目列表（套片/音画合套用，与 V1 视频轨条目比对帧范围） |
| `resolve_render_status` | 读 | 渲染队列现状：任务数、是否渲染中、当前 (format, codec)、当前格式 codec 数、preset 数、format 数（后三项 Resolve 21+ 面；20.x 报 0） |
| `resolve_render_presets` | 读 | 渲染引擎当前 (format, codec) 与主机 preset 列表（Resolve 21+；20.x 列表为空）+ `LoadRenderPreset` 能力标志 |
| `resolve_add_render_job` | 写·审批 | AddRenderJob 当前时间线入队到指定 targetDir，保留当前预设；21.1+ 返回新任务的 `job_id`（UUID，可传给 `resolve_delete_render_job` 撤销） |
| `resolve_load_render_preset` | 写·审批 | `Project:LoadRenderPreset(name)` 切换渲染预设（21.x only，20.x 返回 `api-failed`；name 需与 `resolve_render_presets` 列表精确匹配，否则 `preset-not-found`） |
| `resolve_delete_render_job` | 写·审批 | `Project:DeleteRenderJob(jobId)` 删除队列中一个任务（21.x only；按 `resolve_add_render_job` 返回的 `job_id` 定位，缺失时 `job-not-found`，拒删时 `api-failed`） |
| `resolve_start_rendering` | 写·审批 | StartRendering 全部或指定 jobIds |
| `resolve_stop_rendering` | 写·审批 | StopRendering 全部或指定 jobIds |

### 本组术语（RESOLVE_SECTION 提示节已记录）

- **套片**：在 EP04 项目语境下是"音画合套 + 嵌套组装"两个子流程的合称：
  - 音画合套：SOUNDS 里的长 wav（如 `0130 4ji.wav` ≈ 一集混音）和 V1 上的镜头逐一对齐，检查每段视频都落在混音覆盖范围内；
  - 嵌套组装：TL bin 里的嵌套时间线（按日期命名，e.g. `EP04_20260129`）作为单条目贴到父时间线 V1 上。
- **贴视效**：VFX 交付物（`ZY_EP04_4650_CMP_v006.mov` 等）按源 Start TC 匹配到 V1 段落后贴 V2，`resolve_place_clip` 的 V2 贴放约定已经在此。
- **输出**：渲染队列流；Resolve 21+ 暴露 `GetRenderPresets` + `LoadRenderPreset`/`DeleteRenderJob`（本机 21.1.10 活体探测 40 个预设，`GetRenderFormats` 返回空表 + `has_load_preset=true`），`resolve_render_presets`（预设清单 + 能力标志）+ `resolve_load_render_preset`（切换预设，21.x）+ `resolve_add_render_job`（入队，21.x 返回 UUID `job_id`）+ `resolve_delete_render_job`（撤销入队，21.x）+ `resolve_start_rendering`/`resolve_stop_rendering`（启停渲染）+ `resolve_render_status`（活体状态面）组成完整流程。20.x（含 20.3.2.9）没有 `LoadRenderPreset`/`DeleteRenderJob`/`GetRenderPresets`——只能依赖 UI 里现行的渲染设置，21 专用工具报 `api-failed` 让模型识别能力边界。

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

`editors/davinci/tests/`（已并入根 vitest 收集范围）：协议解析与投影（含 `loadRenderPresetFrom`/`deleteRenderJobFrom`/带 `job_id` 的 `addRenderJobFrom`）、banner 剥离、timeout 钳制、fuscript 发现排序、审批门全部非授权路径、真实 Context 组合下 19 工具注册（含音频轨列表、渲染队列流、Resolve 21+ 渲染预设/删任务面）。包 tsconfig 走 project references（已加入 `tsconfig.host.json`）。

## Model Experience

- 模型看到：systemPrompt 的剪辑约定节（order 120）+ 19 个工具 schema 与描述；工具结果为格式化文本（失败带 `ERROR [code] message`）。
- Token 效应：工具 schema 每请求常驻；约定节约 6 行。
- KV Cache 效应：注册集合稳定时前缀稳定。

## Known Limitations and Deferred Work

- **修剪不可用**：本机 Resolve 20.3.2.9 活体探测 `TimelineItem` 无 `SetStart`/`SetEnd`，`Timeline` 无 `MoveClips`；v1 以 delete+重贴组合替代，真正的边界修剪待 Resolve scripting API 支持。
- **渲染预设跨版本不一致**：Resolve 21+（21.1.10 活体探测 40 预设）暴露 `GetRenderPresets` + `LoadRenderPreset` + `AddRenderJob`（返回新任务 UUID）+ `DeleteRenderJob`，`resolve_render_presets`/`resolve_load_render_preset`/`resolve_add_render_job`/`resolve_delete_render_job` 把该能力面投影给模型（`resolve_render_status` 同时给出队列深度 / 是否渲染中 / 当前 (format, codec)）；20.x（含 20.3.2.9）没有这些方法，`LoadRenderPreset`/`DeleteRenderJob` 均为 `nil`，`GetRenderFormats()` 返回空表——21 专用工具在 20.x 上报 coded refusal（`resolve_load_render_preset` → `api-failed: this Resolve build lacks Project:LoadRenderPreset (Resolve 21+ only)`，`resolve_delete_render_job` → `job-not-found` 或 `api-failed`），让模型识别宿主能力面再决策。20.x 想改渲染预设/格式，需要走 Resolve Deliver 页手动设好再调用 `resolve_add_render_job`。
- **Resolve 21.1.10 fuscript 在本机会间歇性 SIGSEGV**：21.1.10 + 本机的 fuscript 进程在读取渲染引擎（`GetRenderFormats()` / `GetCurrentRenderFormatAndCodec()` 等）时会间歇性原生 segfault（exit 139）——pcall 抓不住 native crash，且不是每次调用都触发（读 `GetRenderPresets` 时稳定 0 失败，读 `GetRenderFormats` 时复现）。根因是 21.1.10 该原生面不稳定，不是插件代码 bug；插件侧 `renderStatusLua` 与 `renderPresetsLua` 已用 pcall 逐个 API 包裹以隔离失败，避免一个坏 API 连累整次脚本返回。
- **截图走全屏**：当前 `resolve_screenshot` 用 `screencapture -x`（全屏），多显示器时会把其他显示器内容一并抓进 PNG；窗口级截取（CGWindowList + `screencapture -l`）为后续工作。
- **macOS only**：截图依赖 `screencapture`，fuscript 发现扫 `/Applications`。
- **单实例假设**：连到本机唯一运行中的 Resolve；多开时行为未定义。
- **headless 默认只读**：headless profile 审批策略 `never` 使写入自动拒绝；需要无人值守写入时要显式改策略。
- **视觉回路需图像路由**：`resolve_screenshot` 产出的 PNG 要经 `read_image` 进模型，而 DeepSeek 适配器当前 `inputModalities: ['text']`。
- **协议限制**：kv 行协议在名称含换行时会破坏行结构；`=` 无碍（首个 `=` 分割）。
- **并发**：所有工具未标 `isConcurrencySafe`（保守串行）；Resolve 侧脚本本身也是串行语义。
