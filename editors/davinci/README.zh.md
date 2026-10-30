# @deepseek-ai/dsh-davinci（editors/davinci）

[English](README.md) | 中文

驱动正在运行的 DaVinci Resolve 的剪辑能力插件：Service Definition（`ctx.davinci`）、本地 Provider（davinci-mcp stdio JSON-RPC 服务器）、模型可见的 `resolve_*` 工具三角色合并在一个包内（角色在结构上仍分离：抽象服务 / 提供者 / 消费者）。这是仓库内 `editors/` 的个人编辑器插件，走 profile 用户补丁层以源码启动，不进 `packages/` 发布集。

## 架构

```
src/types.ts     词汇表：调用信封、Spec、各操作结果、失败码封闭联合（纯类型）
src/protocol.ts  纯协议层：run_script 内层响应映射、ERROR <code>: <message> 解析、kv 投影、timeout 钳制/秒换算
src/python.ts    Python 脚本体：共享 prelude（含 Lua tostring 等价的 s() 帮手）+ 每操作一个 body + unsafe 截图体
src/service.ts   抽象 DavinciService：ctx key 合并、resolve() 默认化、类型化领域方法、截图门
src/provider.ts  McpDavinci：每调用一次性 node 进程跑 MCP stdio 交换、路径自动发现、传输超时/中止
src/tools.ts     19 个 resolve_* 工具 + systemPrompt 剪辑约定节 + 审批门
src/index.ts     插件入口：name/inject/Config/apply
```

传输协议：每次调用 spawn 一个 node 进程运行 davinci-mcp 服务器（`~/.local/share/davinci-mcp/server/index.js`，stdio JSON-RPC），stdin 喂 `initialize`/`initialized`/`tools/call` 三行，读到 id 匹配的响应后关 stdin 让 wrapper 自退；实测新进程全程墙钟约 0.2s。脚本经沙箱工具 `run_script` 执行（Python，预注入 `resolve`/`project` 全局，禁 import），输出为 `key=value` 行（首个 `=` 后均为值），失败行 `ERROR <code>: <message>`；需 OS 权限的操作（截图）走 `run_script_unsafe`。刻意不走 sandbox seam——MCP 服务器需与 Resolve 应用本地 scripting IPC 通信，隔离会切断它；破坏性变更改由工具层审批门把关。

内层响应映射（`protocol.ts` 的 `innerResponseToRaw`）：`{"output": …}` 原样透传给 kv 解析；`{"error": …}` 以 `Script timed out` 开头 → `timeout`（原文保留），其余（Traceback/SyntaxError）→ `api-failed`（取异常末行）；JSON-RPC 层 error（如 ResolveMCP 二进制 init 失败 -32603）与进程崩溃 → `spawn-failed`。stdout 读取按 id 过滤（initialize 会触发 `notifications/message` 通知行）。

## 工具面（19 个）

| 工具 | 类型 | 说明 |
|---|---|---|
| `resolve_project_info` | 读 | 版本、工程名、全部时间线、当前时间线轨道/帧范围 |
| `resolve_media_pool` | 读 | 列 bin 与素材（名、源 Start TC、时长、fps、路径） |
| `resolve_timeline_items` | 读 | 视频轨条目列表，可按记录帧窗口分页（单次上限 200） |
| `resolve_find_by_tc` | 读 | 按源 TC 全轨确定性扫描 V1，VFX 交付物对位首选 |
| `resolve_find_clip` | 读 | 一次调用全时间线×全视频轨按名搜索条目；找游离交付物/按名定位的首选，替代翻页扫描 |
| `resolve_seek` | 视觉 | 移动播放头到记录帧/TC |
| `resolve_screenshot` | 视觉 | 截屏到工作区 PNG，配合 `read_image`（需图像路由）；要求 Resolve 为前台应用，否则报错并指名当前前台应用，可 `activate: true` 自动前置。整条 OS 链（`open` 激活 + `lsappinfo` 前台判定 + `screencapture -x`）跑在一次 `run_script_unsafe` 交换内 |
| `resolve_switch_timeline` | 会话 | `Project:SetCurrentTimeline` 按 1 基 index 或精确 name 切换当前时间线（不改内容、不审批） |
| `resolve_place_clip` | 写·审批 | 在 trackIndex+recordFrame 贴片段。脚本面仅有 `MediaPool:AppendToTimeline`（21.1.1.10 上其 `recordFrame`/`trackIndex`/`insertType` 选项被完全忽略，总是落到 V1 末尾），所以本工具 = append + 读回落点 + 与请求轨道/帧严格比对，不一致时 `DeleteClips` 回滚并报 `ERROR mislanded-placement`。真正的定位贴段请用 Edit 页 UI（拖拽/`Select+`）驱动 |
| `resolve_delete_item` | 写·审批 | Timeline:DeleteClips 按轨道+起始帧删除条目 |
| `resolve_add_marker` | 写·审批 | Timeline:AddMarker 绝对帧时间线标记 |
| `resolve_audio_timeline_items` | 读 | 音频轨条目列表（套片/音画合套用，与 V1 视频轨条目比对帧范围） |
| `resolve_render_status` | 读 | 渲染队列现状：任务数、是否渲染中、当前 (format, codec)、当前格式 codec 数、preset 数、format 数（后三项 Resolve 21+ 面；20.x 报 0） |
| `resolve_render_presets` | 读 | 渲染引擎当前 (format, codec) 与主机 preset 列表（Resolve 21+；20.x 列表为空）+ `LoadRenderPreset` 能力标志 |
| `resolve_add_render_job` | 写·审批 | 当前时间线入队到指定 targetDir，保留当前渲染设置。空串防御：调用前快照队列 ID 集；AddRenderJob 返回空/不确定时读回队列，唯一新增 ID 才作为 `job_id` 返回并在结果标注 `读回确认`；多候选报 `ambiguous-job` 不猜不追加；确认无新增（且前次同步调用已结束）才按"仅重试一次"策略重试；异常/读回失败视为未知结局不重试 |
| `resolve_load_render_preset` | 写·审批 | `Project:LoadRenderPreset(name)` 切换渲染预设（21.x only，20.x 返回 `api-failed`；name 需与 `resolve_render_presets` 列表精确匹配，否则 `preset-not-found`） |
| `resolve_delete_render_job` | 写·审批 | 按传入的真实 `job_id` 删除队列中一个任务：ID 必须命中队列行，未命中（含空队列/空 ID）报 `job-not-found` 且不调用宿主删除；`done=true` 仅在删除后读回确认该 ID 已离队才打印；任何异常绝不退化成清空队列（代码面无 delete-all 回退，测试锁定） |
| `resolve_start_rendering` | 写·审批 | StartRendering 全部或指定 jobIds |
| `resolve_stop_rendering` | 写·审批 | StopRendering 全部或指定 jobIds |

### 本组术语（RESOLVE_SECTION 提示节已记录）

- **套片**：在 EP04 项目语境下是"音画合套 + 嵌套组装"两个子流程的合称：
  - 音画合套：SOUNDS 里的长 wav（如 `0130 4ji.wav` ≈ 一集混音）和 V1 上的镜头逐一对齐，检查每段视频都落在混音覆盖范围内；
  - 嵌套组装：TL bin 里的嵌套时间线（按日期命名，e.g. `EP04_20260129`）作为单条目贴到父时间线 V1 上。
- **贴视效**：VFX 交付物（`ZY_EP04_4650_CMP_v006.mov` 等）按源 Start TC 匹配到 V1 段落后贴 V2，`resolve_place_clip` 的 V2 贴放约定已经在此。
- **输出**：渲染队列流；Resolve 21+ 暴露 `GetRenderPresets` + `LoadRenderPreset`/`DeleteRenderJob`（本机 21.1.10 经 MCP 活体探测 40 个预设、`GetRenderFormats` 23 项、`has_load_preset=true`），`resolve_render_presets`（预设清单 + 能力标志）+ `resolve_load_render_preset`（切换预设，21.x）+ `resolve_add_render_job`（入队，21.x 返回 UUID `job_id`）+ `resolve_delete_render_job`（撤销入队，21.x）+ `resolve_start_rendering`/`resolve_stop_rendering`（启停渲染）+ `resolve_render_status`（活体状态面）组成完整流程。20.x（含 20.3.2.9）没有 `LoadRenderPreset`/`DeleteRenderJob`/`GetRenderPresets`——只能依赖 UI 里现行的渲染设置，21 专用工具报 `api-failed` 让模型识别能力边界。

写入工具在 execute 内先经 `requireWriteApproval`（机会式 `ctx.get('approval')`，一次性 `allowed-once` 才执行；无通道/无 agent/`rejected`/`cancelled`/`unavailable` 分别抛模型可读错误，fail-closed）。审批提示就是用户同意的方式——不要在聊天里绕行先问。

## Config（cordis.yml 可配）

| 字段 | 默认 | 说明 |
|---|---|---|
| `mcpServerPath` | `~/.local/share/davinci-mcp/server/index.js` | davinci-mcp stdio 服务器入口绝对路径；默认位置缺失时首次调用 fail-loud |
| `resolveMcpPath` | 自动发现 | ResolveMCP 二进制绝对路径，作为 `RESOLVE_MCP_PATH` 传给服务器；省略时扫 `applicationsDir` 下最高版本 `DaVinci Resolve*/…/Applications/ResolveMCP`（服务器内建默认路径无版本后缀，必须传） |
| `applicationsDir` | `/Applications` | Resolve 安装发现扫描根（非标准安装位置用） |
| `defaultTimeoutMs` | 30000 | 单次脚本调用预算 |
| `maxTimeoutMs` | 60000 | 请求预算上限；`run_script` 沙箱自身硬上限 60s，超出部分在交换时按 60s 封顶 |
| `screenshotDir` | `.resolve-agent` | 截图输出目录（相对工作区） |
| `autoApproveMutations` | `false` | 部署级预授权：跳过本插件写工具的审批门（显式信任决策，不动其他工具） |

超时钳制：请求预算在 [1s, default, max] 内钳制后，按 `Math.ceil` 换算为整数秒并夹进 `run_script` 的 [1,60]；外层交换墙钟 = 毫秒预算 + 5s 传输余量，保证内层超时文本先到达。脚本超时以正常 result 文本到达并映射为 `timeout` 失败码（消息为沙箱原文），与旧 fuscript 时代的 killed/ETIMEDOUT 超时提示文案不同——模型可见差异，属迁移已知变更。

## 挂载与运行

两个 profile 的用户补丁层（`~/.dsh/profiles/<name>/cordis.patch.yml`）已插入：

```yaml
- insert:
    - id: davinci-resolve
      name: '/Users/phenom8010/code/github/deepseek-harness/editors/davinci/src/index.ts'
```

`pnpm dsh --profile web --dump-config` 验证组合；`node --import tsx/esm editors/davinci/smoke.ts` 对运行中的 Resolve 做只读冒烟 + 失败路径探针（2026-10-30 本机实测：Resolve 21.1.1.10，工程 20261029，Timeline 1（帧 90000-158450），媒体池根列 3 素材，渲染队列 0、mov/77 codecs/40 presets；timeout/沙箱拒绝/unsafe/截图拒绝四条失败路径均按预期报文）。

## 测试

`editors/davinci/tests/`（已并入根 vitest 收集范围）：协议解析与投影（含 `id_source`→`idSource`、`ambiguous-job` 失败码）、`innerResponseToRaw` 内层响应映射（timeout/Traceback/SyntaxError/非 JSON fail-loud）、timeout 钳制与秒换算、ResolveMCP 发现排序、审批门全部非授权路径、真实 Context 组合下 19 工具注册、`addRenderJobText` 的 `读回确认` 标注；传输层用临时 fake MCP 服务器（FAKE_MODE 驱动）覆盖成功交换（含通知行过滤）、内层超时、内层 Traceback、RPC error、进程崩溃、非内层 JSON（wrapper isError）、墙钟超时击杀、调用方中止，以及 add/delete 渲染任务走真实 stdio 传输的读回确认与 `ambiguous-job` 拒绝；`python.spec.ts` 锁定 prelude 的 s()/each() 契约与生成体结构（含快照先于调用、重试上界、无 clear-queue 回退），并在有 python3 的机器上对全部生成体做 ast.parse 语法校验，另以 fake `project`（队列快照逐次消耗、变更全量记录）真实执行 add/delete 渲染体，覆盖空串→读回确认、多候选→报错且不重试、无新增→仅重试一次、两次落空→报错、直接返回/字典返回、预读失败拒入队、AddRenderJob 抛异常不重试、删除读回确认、删除目标不存在/空队列/空 ID 不触发宿主删除、删除"成功"但仍在职队→报错、删除抛异常、删除后读回失败等分支（无 python3 时跳过）。包 tsconfig 走 project references（已加入 `tsconfig.host.json`）。

## Model Experience

- 模型看到：systemPrompt 的剪辑约定节（order 120）+ 19 个工具 schema 与描述；工具结果为格式化文本（失败带 `ERROR [code] message`）。
- Token 效应：工具 schema 每请求常驻；约定节约 6 行。
- KV Cache 效应：注册集合稳定时前缀稳定。

## Known Limitations and Deferred Work

- **fuscript Lua 桥已死（迁移动因）**：本机 Resolve 21.1.1 的 fuscript 进程先是在读渲染引擎（`GetRenderFormats()` 等）时间歇性原生 SIGSEGV（exit 139，pcall 抓不住 native crash），随后彻底丢失 scripting IPC 桥（注入 nil，偏好/重启均排除）——这是本次把传输层整体迁到 davinci-mcp（Python 沙箱 + stdio JSON-RPC）的动因。历史正文见 git 历史（README 本节曾记录 SIGSEGV 细节）。
- **沙箱 import 禁令**：`run_script` 禁一切 import（`os`/`sys`/`pathlib`/`shutil` 文档化禁令，实测 `subprocess`、传递性 `typing` 同禁）；所有脚本体零 import。`run_script_unsafe` 允许 `os`/`subprocess`/`time`（实测），仅截图体使用。新增 import 需先活体验证。
- **60s 硬上限**：`run_script` 沙箱 timeout 上限 60s，过去可请求到 120s 的慢扫描（全工程 find_clip）现在封顶 60s；`maxTimeoutMs` 默认值从 120000 改为 60000 是配置面破坏性变更（显式配置 120000 仍会在交换时按 60s 封顶）。
- **修剪不可用**：本机 Resolve 活体探测 `TimelineItem` 无 `SetStart`/`SetEnd`，`Timeline` 无 `MoveClips`；v1 以 delete+重贴组合替代，真正的边界修剪待 Resolve scripting API 支持。
- **渲染预设跨版本不一致**：Resolve 21+（21.1.1.10 经 MCP 活体探测 40 预设）暴露 `GetRenderPresets` + `LoadRenderPreset` + `AddRenderJob`（返回新任务 UUID）+ `DeleteRenderJob`，`resolve_render_presets`/`resolve_load_render_preset`/`resolve_add_render_job`/`resolve_delete_render_job` 把该能力面投影给模型；20.x（含 20.3.2.9）没有这些方法——21 专用工具在 20.x 上报 coded refusal 让模型识别宿主能力面再决策。20.x 想改渲染预设/格式，需要走 Resolve Deliver 页手动设好再调用 `resolve_add_render_job`。
- **截图走全屏 + unsafe**：`resolve_screenshot` 用 `screencapture -x`（全屏），多显示器时会把其他显示器内容一并抓进 PNG；窗口级截取（CGWindowList + `screencapture -l`）为后续工作。前台判定用 `lsappinfo front` → ASN → `info -only bundleid` 两步链（旧一步式 `… bundleid front` 在 darwin 25 返回空，会让截图永远以 "unknown" 前台拒绝）；整条 OS 链在 `run_script_unsafe` 内执行，拒绝文案与旧版逐字一致。
- **marker 四色未验证**：`resolve_add_marker` 枚举尾部 Tan/Beige/Brown/Chocolate 承自旧插件（provider 常量），与 21.1.1 官方 stubs 的 MarkerColor（Lemon/Sand/Cocoa/Cream）有分歧——这四色在 21.1.1.10 `AddMarker` 的运行时接受度未验证（需一次变更调用）。
- **macOS only**：截图依赖 `screencapture` 与 `lsappinfo`，ResolveMCP 发现扫 `/Applications`。
- **单实例假设**：连到本机唯一运行中的 Resolve；多开时行为未定义。
- **Resolve 挂掉路径未活体验证**：`resolve`/`project` 为 None 的守卫（脚本面 ERROR resolve-unreachable/no-project）与 ResolveMCP 二进制 init 失败的 RPC -32603 路径由代码审读与 fake-server 测试支撑，未在真实断链下跑过。
- **headless 默认只读**：headless profile 审批策略 `never` 使写入自动拒绝；需要无人值守写入时要显式改策略。
- **视觉回路需图像路由**：`resolve_screenshot` 产出的 PNG 要经 `read_image` 进模型，而 DeepSeek 适配器当前 `inputModalities: ['text']`。
- **协议限制**：kv 行协议在名称含换行时会破坏行结构；`=` 无碍（首个 `=` 分割）。值内中文 round-trip 干净（wire 层 \uXXXX 转义、JSON 解析后还原）。
- **并发**：所有工具未标 `isConcurrencySafe`（保守串行）；Resolve 侧脚本本身也是串行语义。
