# @deepseek-ai/dsh-davinci（editors/davinci）

[English](README.md) | 中文

驱动正在运行的 DaVinci Resolve 的剪辑能力插件：Service Definition（`ctx.davinci`）、本地 Provider（davinci-mcp stdio JSON-RPC 服务器）、模型可见的 `resolve_*` 工具三角色合并在一个包内（角色在结构上仍分离：抽象服务 / 提供者 / 消费者）。这是仓库内 `editors/` 的个人编辑器插件，走 profile 用户补丁层以源码启动，不进 `packages/` 发布集。

## 架构

```
src/types.ts     词汇表：调用信封、Spec、各操作结果、失败码封闭联合（纯类型）
src/markers.ts   标记颜色唯一来源：运行时 DAVINCI_MARKER_COLORS + 由它派生的类型
src/protocol.ts  纯协议层：run_script 内层响应映射、ERROR <code>: <message> 解析、kv 投影、timeout 钳制/秒换算
src/python.ts    Python 脚本体：共享 prelude（s()/each()、名义帧率与丢帧时间码换算）+ 每操作一个 body + unsafe 截图体
src/service.ts   抽象 DavinciService：ctx key 合并、resolve() 默认化、类型化领域方法、截图门
src/provider.ts  McpDavinci：每调用一次性 node 进程跑 MCP stdio 交换、路径自动发现、传输超时/中止
src/tools.ts     26 个 resolve_* 工具 + systemPrompt 剪辑约定节 + 审批门 + 每工具预算/截止时间
src/index.ts     插件入口：name/inject/Config/apply
```

传输协议：每次调用 spawn 一个 node 进程运行 davinci-mcp 服务器（`~/.local/share/davinci-mcp/server/index.js`，stdio JSON-RPC），stdin 喂 `initialize`/`initialized`/`tools/call` 三行，读到 id 匹配的响应后关 stdin 让 wrapper 自退；实测新进程全程墙钟约 0.2s。脚本经沙箱工具 `run_script` 执行（Python，预注入 `resolve`/`project` 全局，禁 import），输出为 `key=value` 行（首个 `=` 后均为值），失败行 `ERROR <code>: <message>`；需 OS 权限的操作（截图）走 `run_script_unsafe`。刻意不走 sandbox seam——MCP 服务器需与 Resolve 应用本地 scripting IPC 通信，隔离会切断它；破坏性变更改由工具层审批门把关。

缺失值打印为空、解析层把空串视为缺失，所以字面值 `nil` 会作为真实值保留。帧换算使用时间线的名义整数帧率（23.976 按 24 网格），`;` 分隔的时间码按丢帧处理（29.97/59.94）；读不到 `timelineFrameRate` 时调用直接报错，不再静默按 25 fps 猜。

内层响应映射（`protocol.ts` 的 `innerResponseToRaw`）：`{"output": …}` 原样透传给 kv 解析；`{"error": …}` 以 `Script timed out` 开头 → `timeout`（原文保留），其余（Traceback/SyntaxError）→ `api-failed`（取异常末行）；JSON-RPC 层 error（如 ResolveMCP 二进制 init 失败 -32603）、进程崩溃、以及既无 `output` 也无 `error` 的信封 → `spawn-failed`。stdout 读取按 id 过滤（initialize 会触发 `notifications/message` 通知行）。

## 工具面（26 个）

| 工具 | 类型 | 说明 |
|---|---|---|
| `resolve_project_info` | 读 | 版本、工程名、全部时间线、当前时间线轨道/帧范围 |
| `resolve_project_conventions` | 读 | 当前工程的 IO 约定（帧率、套片、视效、输出、时间线策略）、仍缺字段与要问的中文问题；视效/输出在项目开始时问一次 |
| `resolve_save_project_conventions` | 写·审批 | 把部分约定答案合并后原子写入 `$DSH_HOME/davinci/projects/<project>.json`；校验先于写入 |
| `resolve_begin_timeline_edit` | 写·审批 | 复制当前时间线为 `<原名>_待审` 并切到副本，原时间线不动；改名/切换失败会删掉新副本 |
| `resolve_finalize_timeline_edit` | 写·审批 | 不通过则保留副本；通过则原线改名 `__OLD_YYYYMMDD_HHmm`、副本改回原名，并报告“需手动禁用原线”的提醒（Resolve 无禁用时间线脚本 API） |
| `resolve_media_pool` | 读 | 列 bin 与素材（名、源 Start TC、时长、fps、路径）；单次最多 200 个 bin 与 200 条素材，并报告目录总数 |
| `resolve_timeline_items` | 读 | 视频轨条目列表，可按记录帧窗口分页（单次上限 200） |
| `resolve_find_by_tc` | 读 | 按源 TC 全轨确定性扫描 V1，VFX 交付物对位首选；支持丢帧 `;` 时间码 |
| `resolve_find_clip` | 读 | 一次调用全时间线×全视频轨按名搜索条目；找游离交付物/按名定位的首选，替代翻页扫描；单次最多 200 条命中，并报告总数 |
| `resolve_seek` | 视觉 | 移动播放头到记录帧/TC；两个参数都不给时拒绝，帧→TC 按名义帧率/丢帧规则换算 |
| `resolve_screenshot` | 视觉 | 截屏到会话工作区内 PNG，配合 `read_image`（需图像路由）；要求 Resolve 为前台应用，否则返回 `ERROR [api-failed]` 并指名当前前台应用，可 `activate: true` 自动前置。整条 OS 链（`open` 激活 + `lsappinfo` 前台判定 + `screencapture -x`）跑在一次 `run_script_unsafe` 交换内 |
| `resolve_switch_timeline` | 会话 | `Project:SetCurrentTimeline` 按 1 基 index 或精确 name 切换当前时间线（不改内容、不审批） |
| `resolve_place_clip` | 写·审批 | append 后在 trackIndex+recordFrame 校验落点。脚本面仅有 `MediaPool:AppendToTimeline`（21.1.1.10 上其 `recordFrame`/`trackIndex`/`insertType` 选项被完全忽略，总是落到 V1 末尾），所以本工具 = 快照全部条目 + append + 读回落点 + 严格比对；落点不符或找不到新条目时，删除本次调用新增的全部条目（所有轨道）并报真实坐标。真正的定位贴段请用 Edit 页 UI（拖拽/`Select+`）驱动 |
| `resolve_plan_vfx_placement` | 读 | 对一个 bin（或指定交付物）按源 Start TC 匹配 V1 段，算出落点帧、目标范围与超出段尾的 overhang，输出 `ready` / `no-match` / `occupied` 及占用条目 |
| `resolve_place_clip_ui` | 写·审批 | 通过 Edit 页 UI 把交付物定位贴到 V2：前置检查（落点帧处 V1 有内容、V2 及以上在目标范围为空）→ 选中素材 → seek → 经 System Events 点 `Place On Top`（中英文菜单名均可，找不到时回退 F12） → 读回校验，不符则回滚。需要给 DSH 宿主 App 开 macOS 辅助功能/自动化权限，且 Resolve 在前台；仅支持 V2 |
| `resolve_verify_placement` | 读 | 结构质检：对目标轨每个条目，与匹配轨最近的段落起点比较，输出 `covered` / `offset` / `no-segment` |
| `resolve_delete_item` | 写·审批 | Timeline:DeleteClips 按轨道+起始帧删除条目 |
| `resolve_add_marker` | 写·审批 | Timeline:AddMarker 绝对帧时间线标记 |
| `resolve_audio_timeline_items` | 读 | 音频轨条目列表（套片/音画合套用，与 V1 视频轨条目比对帧范围） |
| `resolve_render_status` | 读 | 渲染队列现状：任务数、是否渲染中、当前 (format, codec)、当前格式 codec 数、preset 数、format 数（后三项 Resolve 21+ 面；20.x 报 0） |
| `resolve_render_presets` | 读 | 渲染引擎当前 (format, codec) 与主机 preset 列表（Resolve 21+；20.x 列表为空）+ `LoadRenderPreset` 能力标志 |
| `resolve_add_render_job` | 写·审批 | 当前时间线入队到指定 targetDir，保留当前渲染设置。空串防御：调用前快照队列 ID 集；AddRenderJob 返回空/不确定时读回队列，唯一新增 ID 才作为 `job_id` 返回并在结果标注 `读回确认`；多候选报 `ambiguous-job` 不猜不追加；确认无新增（且前次同步调用已结束）才按"仅重试一次"策略重试；异常/读回失败视为未知结局不重试。入队后读回失败时不报队列深度；`first_job_name` 只取新任务自身名称（不再回退到时间线名） |
| `resolve_load_render_preset` | 写·审批 | `Project:LoadRenderPreset(name)` 切换渲染预设（21.x only，20.x 返回 `api-failed`；先按宿主预设列表校验 name，列表外直接 `preset-not-found` 且不触发宿主调用；宿主返回非真值时按 `api-failed` 拒绝） |
| `resolve_delete_render_job` | 写·审批 | 按传入的真实 `job_id` 删除队列中一个任务：ID 必须命中队列行，未命中（含空队列/空 ID）报 `job-not-found` 且不调用宿主删除；`done=true` 仅在删除后读回确认该 ID 已离队才打印；任何异常绝不退化成清空队列（代码面无 delete-all 回退，测试锁定） |
| `resolve_start_rendering` | 写·审批 | StartRendering 全部或指定 jobIds |
| `resolve_stop_rendering` | 写·审批 | StopRendering 全部或指定 jobIds |

### 本组术语（RESOLVE_SECTION 提示节已记录）

- **套片**：按剪辑师的定版 WP，把每本的原始素材对回 V1，一本一条时间线；片头 Leader 在头、按本的小时 TC。声音不参与这一步：源素材可能带 linked 音轨，但不判断也不重排声音。一个镜头可能由多段源素材（同一素材的多个时间段）组成，比较时要看帧范围，不能假设一个 clip 就是一个镜头。
- **贴视效**：项目相关。先问用户交付物 bin、命名/TC 约定、目标轨（默认 V2）、handle、覆盖还是叠加；然后 `resolve_plan_vfx_placement` → `resolve_place_clip_ui` → `resolve_verify_placement`。`resolve_place_clip` 只做尾部 append 并回滚。
- **输出**：项目相关。先问用户交付格式/编码或预设、目标目录、命名、每本还是整片、是否带片头、QC 清单；再用 `resolve_render_status` / `resolve_render_presets` 确认并调用渲染工具。Resolve 21 有预设；20.x 只有 UI 里的设置。

#### 项目约定（先问再动）

贴视效和输出的约定每个项目都不一样，不能假设。第一次贴片或渲染前用 `ask_user_question` 问清楚，并在方案/结果里复述；headless 没有用户通道时停下来报告缺失的约定，不要猜：

- 贴视效：交付物 bin、命名/TC 约定、目标轨、handle、覆盖还是叠加。
- 输出：格式/编码或预设、目标目录、命名、每本还是整片、片头、QC 清单。
- 套片：WP bin、原始素材 bin、每本时间线名、片头 bin、是否要整片 master。

写入工具在 execute 内先经 `requireWriteApproval`（机会式 `ctx.get('approval')`，一次性 `allowed-once` 才执行；无通道/无 agent/`rejected`/`cancelled`/`unavailable` 分别抛模型可读错误，fail-closed）。审批提示就是用户同意的方式——不要在聊天里绕行先问。

## Config（cordis.yml 可配）

| 字段 | 默认 | 说明 |
|---|---|---|
| `mcpServerPath` | `~/.local/share/davinci-mcp/server/index.js` | davinci-mcp stdio 服务器入口绝对路径；默认位置缺失时首次调用 fail-loud |
| `resolveMcpPath` | 自动发现 | ResolveMCP 二进制绝对路径，作为 `RESOLVE_MCP_PATH` 传给服务器；省略时扫 `applicationsDir` 下最高版本 `DaVinci Resolve*/…/Applications/ResolveMCP`（服务器内建默认路径无版本后缀，必须传） |
| `applicationsDir` | `/Applications` | Resolve 安装发现扫描根（非标准安装位置用） |
| `defaultTimeoutMs` | 30000 | 快读/快写脚本预算；也是各工具截止时间的基数 |
| `maxTimeoutMs` | 60000 | 全工程扫描与贴片段的脚本预算，同时是任何请求预算的上限；`run_script` 沙箱自身硬上限 60s，超出部分在交换时按 60s 封顶 |
| `screenshotDir` | `.resolve-agent` | 截图输出目录：绝对路径，或相对调用会话的工作目录（由工具在调用前解析） |
| `conventionsDir` | `$DSH_HOME/davinci/projects` | 按项目约定根目录；`DSH_HOME` 未设时默认 `~/.dsh/davinci/projects` |
| `autoApproveMutations` | `false` | 部署级预授权：跳过本插件写工具的审批门（显式信任决策，不动其他工具） |

超时与取消：每个工具调用都携带 `{ timeoutMs, signal: exec.signal }`，工具级超时/取消会中止已启动的交换，而不是任其继续跑。请求预算在 [1s, default, max] 内钳制后，按 `Math.ceil` 换算为整数秒并夹进 `run_script` 的 [1,60]；provider 墙钟 = 该整数秒预算 + 5s 传输余量，工具自身截止时间再晚 2s，保证模型先拿到 `ERROR [timeout]` 编码文本而不是通用工具超时。脚本超时以正常 result 文本到达并映射为 `timeout` 失败码（消息为沙箱原文），与旧 fuscript 时代的 killed/ETIMEDOUT 超时提示文案不同——模型可见差异，属迁移已知变更。

## 挂载与运行

`web` 与 `headless` 两个 profile 的用户补丁层（`~/.dsh/profiles/<name>/cordis.patch.yml`）已插入：

```yaml
- insert:
    - id: davinci-resolve
      name: '/Users/phenom8010/code/github/deepseek-harness/editors/davinci/src/index.ts'
```

打包版桌面 App 的 `desktop` profile **没有**挂载这一行：它的运行时（0.2.1-rc.5）比本 checkout 新，而源码启动的 TypeScript 入口需要 checkout 的 tsx loader。那里单独安装的是左侧达芬奇面板 bundle（[panel/client.js](panel/client.js)），只做 UI 入口；它的快捷提示词要在真正挂载本插件的 profile 里执行。

`pnpm dsh --profile web --dump-config` 验证组合；`node --import tsx/esm editors/davinci/smoke.ts` 对运行中的 Resolve 做只读冒烟 + 失败路径探针（2026-10-30 本机实测：Resolve 21.1.1.10，工程 20261029，Timeline 1（帧 90000-158450），媒体池根列 3 素材，渲染队列 0、mov/77 codecs/40 presets；timeout/沙箱拒绝/unsafe/截图拒绝四条失败路径均按预期报文）。

## 测试

`editors/davinci/tests/`（已并入根 vitest 收集范围）：协议解析与投影（含 `id_source`→`idSource`、`ambiguous-job` 失败码、字面值 `nil`、200 行上限）、`innerResponseToRaw` 内层响应映射（timeout/Traceback/SyntaxError/非 JSON/无 output 信封 fail-loud）、timeout 钳制与秒换算、ResolveMCP 发现排序、审批门全部非授权路径、真实 Context 组合下 26 工具注册、`addRenderJobText` 的 `读回确认` 标注与队列深度缺省、非丢帧/29.97 丢帧时间码往返、预设名校验、贴片单/质检投影、截图 coded 拒绝/成功；传输层用临时 fake MCP 服务器（FAKE_MODE 驱动）覆盖成功交换（含通知行过滤）、内层超时、内层 Traceback、RPC error、进程崩溃、非内层 JSON（wrapper isError）、墙钟超时击杀、调用方中止，以及 add/delete 渲染任务走真实 stdio 传输的读回确认与 `ambiguous-job` 拒绝；`python.spec.ts` 锁定 prelude 的 s()/each() 契约与生成体结构（含快照先于调用、重试上界、无 clear-queue 回退、append 前全量快照回滚），并在有 python3 的机器上对全部生成体做 ast.parse 语法校验，另以 fake `project`（队列快照逐次消耗、变更全量记录）真实执行 add/delete 渲染体，覆盖空串→读回确认、多候选→报错且不重试、无新增→仅重试一次、两次落空→报错、直接返回/字典返回、预读失败拒入队、AddRenderJob 抛异常不重试、删除读回确认、删除目标不存在/空队列/空 ID 不触发宿主删除、删除"成功"但仍在职队→报错、删除抛异常、删除后读回失败等分支（无 python3 时跳过）。包 tsconfig 走 project references（已加入 `tsconfig.host.json`）。

## Model Experience

- 模型看到：systemPrompt 的剪辑约定节（order 120）+ 26 个工具 schema 与描述；工具结果为格式化文本（失败带 `ERROR [code] message`）。
- Token 效应：工具 schema 每请求常驻；约定节约 6 行。
- KV Cache 效应：注册集合稳定时前缀稳定。

## Known Limitations and Deferred Work

- **fuscript Lua 桥已死（迁移动因）**：本机 Resolve 21.1.1 的 fuscript 进程先是在读渲染引擎（`GetRenderFormats()` 等）时间歇性原生 SIGSEGV（exit 139，pcall 抓不住 native crash），随后彻底丢失 scripting IPC 桥（注入 nil，偏好/重启均排除）——这是本次把传输层整体迁到 davinci-mcp（Python 沙箱 + stdio JSON-RPC）的动因。历史正文见 git 历史（README 本节曾记录 SIGSEGV 细节）。
- **沙箱 import 禁令**：`run_script` 禁一切 import（`os`/`sys`/`pathlib`/`shutil` 文档化禁令，实测 `subprocess`、传递性 `typing` 同禁）；所有脚本体零 import。`run_script_unsafe` 允许 `os`/`subprocess`/`time`（实测），仅截图体使用。新增 import 需先活体验证。
- **60s 硬上限**：`run_script` 沙箱 timeout 上限 60s，慢扫描请求 `maxTimeoutMs`（默认 60000），超出部分在交换时按 60s 封顶；`maxTimeoutMs` 默认值从 120000 改为 60000 仍是配置面破坏性变更。
- **时间码换算**：帧位置是绝对帧号；帧↔时间码使用时间线名义整数帧率（23.976 用 24）并对 29.97/59.94 应用丢帧规则（`;` 分隔）。读不到 `timelineFrameRate` 时拒绝调用，不再假定 25 fps。
- **修剪不可用**：本机 Resolve 活体探测 `TimelineItem` 无 `SetStart`/`SetEnd`，`Timeline` 无 `MoveClips`；v1 以 delete+重贴组合替代，真正的边界修剪待 Resolve scripting API 支持。
- **定位贴片靠 UI 自动化**：`Timeline`/`MediaPool` 没有定位插入，`resolve_place_clip_ui` 通过 System Events 驱动 Edit 页的 `Place On Top`。它只支持 V2，要求落点帧处 V1 有内容且 V2 及以上在目标范围为空，需要给 DSH 宿主 App 开辅助功能/自动化权限；UI 步骤被拒或落点不符时 fail-closed 并回滚。已在 21.1.1.10 的中文 UI 上真机验证（菜单项叫「叠加」）：交付物成功贴到 V2 的 86400 帧，结构质检报 `covered`；AppleScript 菜单搜索仍没有自动化测试，因为测试无法授予权限。
- **渲染预设跨版本不一致**：Resolve 21+（21.1.1.10 经 MCP 活体探测 40 预设）暴露 `GetRenderPresets` + `LoadRenderPreset` + `AddRenderJob`（返回新任务 UUID）+ `DeleteRenderJob`，`resolve_render_presets`/`resolve_load_render_preset`/`resolve_add_render_job`/`resolve_delete_render_job` 把该能力面投影给模型；20.x（含 20.3.2.9）没有这些方法——21 专用工具在 20.x 上报 coded refusal 让模型识别宿主能力面再决策。20.x 想改渲染预设/格式，需要走 Resolve Deliver 页手动设好再调用 `resolve_add_render_job`。
- **截图走全屏 + unsafe**：`resolve_screenshot` 用 `screencapture -x`（全屏），多显示器时会把其他显示器内容一并抓进 PNG；窗口级截取（CGWindowList + `screencapture -l`）为后续工作。前台判定用 `lsappinfo front` → ASN → `info -only bundleid` 两步链（旧一步式 `… bundleid front` 在 darwin 25 返回空，会让截图永远以 "unknown" 前台拒绝）；整条 OS 链在 `run_script_unsafe` 内执行，拒绝以 coded `api-failed` 结果返回而非抛错。PNG 落在 `screenshotDir`：相对路径按调用会话工作目录解析，绝对路径原样使用。
- **marker 四色未验证**：标记颜色现以 [`src/markers.ts`](src/markers.ts) 为唯一来源；枚举尾部 Tan/Beige/Brown/Chocolate 承自旧插件，与 21.1.1 官方 stubs 的 MarkerColor（Lemon/Sand/Cocoa/Cream）有分歧——这四色在 21.1.1.10 `AddMarker` 的运行时接受度未验证（需一次变更调用）。
- **macOS only**：截图依赖 `screencapture` 与 `lsappinfo`，ResolveMCP 发现扫 `/Applications`。
- **单实例假设**：连到本机唯一运行中的 Resolve；多开时行为未定义。
- **Resolve 挂掉路径未活体验证**：`resolve`/`project` 为 None 的守卫（脚本面 ERROR resolve-unreachable/no-project）与 ResolveMCP 二进制 init 失败的 RPC -32603 路径由代码审读与 fake-server 测试支撑，未在真实断链下跑过。
- **headless 默认只读**：headless profile 审批策略 `never` 使写入自动拒绝；需要无人值守写入时要显式改策略。
- **视觉回路需图像路由**：`resolve_screenshot` 产出的 PNG 要经 `read_image` 进模型，而 DeepSeek 适配器当前 `inputModalities: ['text']`。
- **协议限制**：kv 行协议在名称含换行时会破坏行结构；`=` 无碍（首个 `=` 分割）。缺失值打印为空（不再有 `nil` 哨兵），字面值 `nil` 会原样往返。值内中文 round-trip 干净（wire 层 \uXXXX 转义、JSON 解析后还原）。
- **并发**：所有工具未标 `isConcurrencySafe`（保守串行）；Resolve 侧脚本本身也是串行语义。
