# @deepseek-ai/dsh-davinci (editors/davinci)

English | [中文](README.zh.md)

Editing-capability plugin driving a running DaVinci Resolve: the Service Definition (`ctx.davinci`), a local Provider (the davinci-mcp stdio JSON-RPC server), and the model-visible `resolve_*` tools merged into one package (the roles stay structurally separate: abstract service / provider / consumer). This is a personal editor plugin under the repository's `editors/`, source-launched through profile user patch layers and not part of the `packages/` release set.

## Architecture

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

Transport protocol: every call spawns one node process running the davinci-mcp server (`~/.local/share/davinci-mcp/server/index.js`, stdio JSON-RPC); stdin receives the three lines `initialize`/`initialized`/`tools/call`, and once the id-matching response arrives stdin is closed so the wrapper exits on its own — measured full wall clock for a fresh process is about 0.2s. Scripts execute through the sandboxed `run_script` tool (Python, with `resolve`/`project` globals pre-injected and imports forbidden); output is `key=value` lines (everything after the first `=` is the value) and failure lines `ERROR <code>: <message>`; operations needing OS access (screenshots) go through `run_script_unsafe`. The sandbox seam is deliberately not used — the MCP server must talk to the Resolve application's local scripting IPC, which isolation would sever; destructive changes are instead gated by the tool-layer approval gate.

Absent values print empty and the parser reads empty as absent, so the literal string `nil` stays a real value. Frame math uses the timeline's nominal integer rate (23.976 reads on a 24 grid); a `;` timecode separator is drop-frame (29.97/59.94), and an unreadable `timelineFrameRate` fails the call instead of guessing 25 fps.

Inner response mapping (`innerResponseToRaw` in `protocol.ts`): `{"output": …}` passes through to kv parsing unchanged; an `{"error": …}` starting with `Script timed out` maps to `timeout` (original text kept), anything else (Traceback/SyntaxError) maps to `api-failed` (last exception line taken); a JSON-RPC-layer error (e.g. ResolveMCP binary init failure -32603), a process crash, or an envelope carrying neither `output` nor `error` maps to `spawn-failed`. stdout reading filters by id (initialize triggers `notifications/message` notification lines).

## Tool surface (26 tools)

| Tool | Kind | Description |
|---|---|---|
| `resolve_project_info` | read | Version, project name, all timelines, current timeline's tracks/frame range |
| `resolve_project_conventions` | read | Current project's IO conventions (frame rate, conform, VFX, output, timeline policy), the fields still missing, and the Chinese questions to ask; VFX/output are asked once at project start |
| `resolve_save_project_conventions` | write·approval | Merge partial convention answers into `$DSH_HOME/davinci/projects/<project>.json` atomically; validation happens before the write |
| `resolve_begin_timeline_edit` | write·approval | Duplicate the current timeline to `<name>_待审`, switch to the copy, and leave the original untouched; a failed rename/switch removes the new copy |
| `resolve_finalize_timeline_edit` | write·approval | Rejected review keeps the copy; approved review renames the original to `__OLD_YYYYMMDD_HHmm`, the copy to the original name, and reports the manual-disable warning (Resolve has no timeline-disable script API) |
| `resolve_media_pool` | read | List bins and clips (name, source Start TC, duration, fps, path); at most 200 bins and 200 clips per call, with the folder totals reported |
| `resolve_timeline_items` | read | Video-track item list, paginable by record-frame window (200 per call cap) |
| `resolve_find_by_tc` | read | Deterministic full-track V1 scan by source TC; first choice for VFX-deliverable matching; drop-frame `;` TCs are honored |
| `resolve_find_clip` | read | One call searches items by name across all timelines × all video tracks; first choice for finding stray deliverables / locating by name, replacing paginated scans; at most 200 hits, with the total reported |
| `resolve_seek` | visual | Move the playhead to a record frame/TC; refuses when neither is given, and converts a frame with the timeline's nominal/drop-frame math |
| `resolve_screenshot` | visual | Screenshot to a Session-relative PNG, paired with `read_image` (needs an image route); requires Resolve to be the frontmost app, otherwise refuses with `ERROR [api-failed]` naming the current frontmost app, with `activate: true` to bring it forward. The whole OS chain (`open` activation + `lsappinfo` frontmost check + `screencapture -x`) runs inside one `run_script_unsafe` exchange |
| `resolve_switch_timeline` | session | `Project:SetCurrentTimeline` switches the current timeline by 1-based index or exact name (no content change, no approval) |
| `resolve_place_clip` | write·approval | Append a clip, then verify the landing against trackIndex+recordFrame. The scripting surface only offers `MediaPool:AppendToTimeline` (on 21.1.1.10 its `recordFrame`/`trackIndex`/`insertType` options are fully ignored and it always lands at V1's tail), so this tool = snapshot every item + append + read back the landing + strict comparison; on mismatch, or when no new item can be found, it removes every item added by the call and reports the actual coordinates. For true positioned placement drive the Edit page UI (drag / `Select+`) |
| `resolve_plan_vfx_placement` | read | Match every deliverable in a bin (or one named clip) to a match-track segment by source Start TC, compute the landing record frame and target range (including any overhang past the shot), and report `ready` / `no-match` / `occupied` with the blocking items |
| `resolve_place_clip_ui` | write·approval | Position a deliverable on V2 through the Edit page UI: preflight (V1 content at the landing frame, V2 and above free over the range), select the clip, seek, click `Place On Top` (English or Chinese label, with an F12 fallback) through System Events, then verify the landing and roll back every arrival on a mismatch. Needs macOS Accessibility/Automation permission for the DSH host app and a frontmost Resolve; V2 only |
| `resolve_verify_placement` | read | Structural QC: for each target-track item, compare its start with the closest match-track segment start and report `covered` / `offset` / `no-segment` |
| `resolve_delete_item` | write·approval | Timeline:DeleteClips removes an item by track + start frame |
| `resolve_add_marker` | write·approval | Timeline:AddMarker absolute-frame timeline marker |
| `resolve_audio_timeline_items` | read | Audio-track item list (for conform / audio-picture sync, compared against V1 video items by frame range) |
| `resolve_render_status` | read | Render-queue state: job count, is-rendering, current (format, codec), current-format codec count, preset count, format count (last three are Resolve 21+ surfaces; 20.x reports 0) |
| `resolve_render_presets` | read | Render engine's current (format, codec) and host preset list (Resolve 21+; empty list on 20.x) + `LoadRenderPreset` capability flag |
| `resolve_add_render_job` | write·approval | Enqueue the current timeline to a targetDir, keeping current render settings. Empty-string defense: snapshot the queue id set before the call; when AddRenderJob returns empty/uncertain, read the queue back and only a uniquely new id becomes `job_id`, annotated `读回确认` (read-back confirmed) in the result; several candidates report `ambiguous-job` with no guessing and no extra enqueue; only a confirmed nothing-was-added (and the previous synchronous call finished) triggers the single-sanctioned-retry policy; exceptions / failed read-backs count as unknown outcomes with no retry. The queue depth is reported only when the post-enqueue read succeeds, and `first_job_name` is the new job's own name (never the timeline name) |
| `resolve_load_render_preset` | write·approval | `Project:LoadRenderPreset(name)` switches the render preset (21.x only, 20.x returns `api-failed`; the name is checked against the host's preset list first, so a name outside it refuses as `preset-not-found` without touching the host, and a host return that is not truthy is an `api-failed` refusal) |
| `resolve_delete_render_job` | write·approval | Delete one queued job by its passed real `job_id`: the id must hit a queue row; a miss (including empty queue / empty id) reports `job-not-found` without calling the host delete; `done=true` is printed only after a post-delete read-back confirms the id left the queue; no exception ever degrades into clearing the queue (no delete-all fallback in code, locked by tests) |
| `resolve_start_rendering` | write·approval | StartRendering for all or specified jobIds |
| `resolve_stop_rendering` | write·approval | StopRendering for all or specified jobIds |

### Domain terms (also recorded in the RESOLVE_SECTION prompt section)

- **套片 (conform)**: rebuild each reel (本) from the editor's locked workprint against the original camera source, on V1. One timeline per reel, leader at the head, reel-local hour TC. Audio is not part of the step: source clips may carry linked audio tracks, but sound is not judged or re-timed here. A shot may be built from several source segments (multiple time ranges of the same clip), so compare frame ranges rather than assuming one clip covers one shot.
- **贴视效 (VFX layup)**: project-specific. Ask the user for the deliverable bin, naming/TC convention, target track (default V2), handles, and whether to replace or overlay; then `resolve_plan_vfx_placement` → `resolve_place_clip_ui` → `resolve_verify_placement`. `resolve_place_clip` only appends to the tail and rolls back.
- **输出 (output)**: project-specific. Ask the user for the deliverable format/codec or preset, target directory, naming, per-reel vs master, leader inclusion, and the QC checklist; then confirm with `resolve_render_status` / `resolve_render_presets` and use the render tools. Resolve 21 exposes presets; 20.x only has the UI-set settings.

#### Project conventions (ask first)

VFX and output conventions vary per project; never assume them. Ask with `ask_user_question` before the first VFX placement or render, and restate the answers in the plan/result; in a headless run with no user channel, stop and report the missing conventions instead of guessing:

- VFX: deliverable bin, naming/TC convention, target track, handles, replace vs overlay.
- Output: format/codec or preset, target directory, naming, per-reel or master, leader, QC checklist.
- Conform: workprint bin, source bin, reel timeline names (本), leader bin, and whether a master timeline is wanted.

Write tools pass through `requireWriteApproval` inside execute before running (opportunistic `ctx.get('approval')`; only a one-shot `allowed-once` executes; no channel / no agent / `rejected` / `cancelled` / `unavailable` each raise a model-readable error, fail-closed). The approval prompt is how the user consents — do not bypass it by asking in chat first.

## Config (cordis.yml)

| Field | Default | Description |
|---|---|---|
| `mcpServerPath` | `~/.local/share/davinci-mcp/server/index.js` | Absolute entry path of the davinci-mcp stdio server; a missing default location fails loud on first call |
| `resolveMcpPath` | auto-discovered | Absolute path of the ResolveMCP binary, passed to the server as `RESOLVE_MCP_PATH`; when omitted, the highest-version `DaVinci Resolve*/…/Applications/ResolveMCP` under `applicationsDir` is scanned (the server's built-in default path has no version suffix, so it must be passed) |
| `applicationsDir` | `/Applications` | Scan root for Resolve install discovery (for non-standard install locations) |
| `defaultTimeoutMs` | 30000 | Script budget for fast reads and writes; also the base of each tool's deadline |
| `maxTimeoutMs` | 60000 | Script budget for whole-project scans and clip placement, and the cap for any requested budget; the `run_script` sandbox's own hard cap is 60s, so anything beyond is clamped to 60s at exchange time |
| `screenshotDir` | `.resolve-agent` | Screenshot output directory: absolute, or relative to the calling Session's working directory (resolved by the tool before the call) |
| `conventionsDir` | `$DSH_HOME/davinci/projects` | Per-project conventions root; defaults to `~/.dsh/davinci/projects` when `DSH_HOME` is unset |
| `autoApproveMutations` | `false` | Deployment-level pre-approval: skips this plugin's write-tool approval gate (an explicit trust decision, leaves other tools untouched) |

Timeout and cancellation: each tool sends `{ timeoutMs, signal: exec.signal }` with every call, so a tool-level timeout or cancellation aborts the spawned exchange instead of letting it run on. The request budget is clamped into [1s, default, max], converted to whole seconds with `Math.ceil`, and clamped into `run_script`'s [1,60]; the provider's wall clock is that whole-second budget + 5s transport grace, and each tool's own deadline sits 2s beyond that, so the coded `ERROR [timeout]` text wins over the generic tool timeout. A script timeout arrives as a normal result text and maps to the `timeout` failure code (message is the sandbox's original text), differing from the old fuscript-era killed/ETIMEDOUT timeout wording — a model-visible difference and a known migration change.

## Mounting and running

The `web` and `headless` profiles' user patch layers (`~/.dsh/profiles/<name>/cordis.patch.yml`) already insert:

```yaml
- insert:
    - id: davinci-resolve
      name: '/Users/phenom8010/code/github/deepseek-harness/editors/davinci/src/index.ts'
```

The packaged Desktop app's `desktop` profile does **not** mount this row: it runs a newer runtime (0.2.1-rc.5) than this checkout, and the source-launched TypeScript entry needs the checkout's tsx loader. The left-rail DaVinci panel bundle ([panel/client.js](panel/client.js)) is installed there separately and is UI-only; its launcher prompts run against whichever profile does mount this plugin.

`pnpm dsh --profile web --dump-config` verifies the composition; `node --import tsx/esm editors/davinci/smoke.ts` runs a read-only smoke plus failure-path probes against a running Resolve (2026-10-30 local run: Resolve 21.1.1.10, project 20261029, Timeline 1 (frames 90000-158450), 3 clips in the media-pool root listing, render queue 0, mov/77 codecs/40 presets; the timeout / sandbox-refusal / unsafe / screenshot-refusal failure paths all reported the expected texts).

## Tests

`editors/davinci/tests/` (already in the root vitest collection): protocol parsing and projection (including `id_source`→`idSource`, the `ambiguous-job` failure code, literal `nil` values, and the 200-row caps), `innerResponseToRaw` inner response mapping (timeout/Traceback/SyntaxError/non-JSON and output-less envelopes fail loud), timeout clamping and second conversion, ResolveMCP discovery ordering, every non-authorized approval-gate path, 26-tool registration under a real Context composition, the `读回确认` (read-back confirmed) annotation and the omitted queue depth of `addRenderJobText`, timecode round-trips (non-drop and 29.97 drop-frame), load-preset name validation, placement-plan/check projections, and screenshot coded refusals/success; the transport layer uses a temporary fake MCP server (FAKE_MODE driven) covering successful exchange (including notification-line filtering), inner timeout, inner Traceback, RPC error, process crash, non-inner JSON (wrapper isError), wall-clock kill, caller abort, plus add/delete render job read-back confirmation and `ambiguous-job` refusal through the real stdio transport; `python.spec.ts` locks the prelude's s()/each() contract and generated-body structure (snapshot-before-call, retry bound, no clear-queue fallback, full pre-append snapshot rollback), ast.parse-validates every generated body where python3 exists, and really executes the add/delete render bodies against a fake `project` (queue snapshots consumed per call, mutations fully recorded), covering empty-string→read-back confirm, multi-candidate→error without retry, nothing-added→single retry, two misses→error, direct/dict returns, pre-read failure refusing to enqueue, AddRenderJob raising without retry, delete read-back confirm, delete target-missing/empty-queue/empty-id never touching the host delete, delete "succeeded" but still queued→error, delete raising, and post-delete read-back failure branches (skipped without python3). The package tsconfig uses project references (added to `tsconfig.host.json`).

## Model Experience

- The model sees: the editing-conventions section of systemPrompt (order 120) + the 26 tool schemas and descriptions; tool results are formatted text (failures carry `ERROR [code] message`).
- Token effect: tool schemas ride every request; the conventions section is about 6 lines.
- KV-cache effect: a stable registration set keeps the prefix stable.

## Known Limitations and Deferred Work

- **The fuscript Lua bridge is dead (why we migrated)**: on local Resolve 21.1.1 the fuscript process first intermittently native-SIGSEGV'd while reading the render engine (`GetRenderFormats()` etc.; exit 139, pcall cannot catch a native crash), then lost the scripting IPC bridge entirely (nil injection; preference and restart both ruled out) — which is why the transport layer moved wholesale to davinci-mcp (Python sandbox + stdio JSON-RPC). Historical detail lives in git history (this README section once recorded the SIGSEGV specifics).
- **Sandbox import ban**: `run_script` forbids every import (`os`/`sys`/`pathlib`/`shutil` are the documented bans; `subprocess` and transitive `typing` measured banned too); all script bodies import nothing. `run_script_unsafe` allows `os`/`subprocess`/`time` (measured), used only by the screenshot body. New imports need live verification first.
- **60s hard cap**: the `run_script` sandbox caps timeout at 60s, so a scan requests `maxTimeoutMs` (default 60000) and anything beyond is clamped to 60s at exchange time; `maxTimeoutMs`'s default changing from 120000 to 60000 remains a config-surface breaking change.
- **Timecode math**: frame positions are absolute frame numbers; converting to/from timecode uses the timeline's nominal integer rate (24 for 23.976) and the drop-frame rule for 29.97/59.94 (`;` separator). An unreadable `timelineFrameRate` refuses the call rather than assuming 25 fps.
- **Trimming unavailable**: live probing on local Resolve found no `SetStart`/`SetEnd` on `TimelineItem` and no `MoveClips` on `Timeline`; v1 substitutes a delete+replace combination, and true boundary trimming waits on Resolve scripting API support.
- **Positioned placement is UI automation**: `Timeline`/`MediaPool` expose no positioned insert, so `resolve_place_clip_ui` drives the Edit page (`Place On Top`) through System Events. It is restricted to V2, requires V1 content at the landing frame and a free V2 and above, needs Accessibility/Automation permission for the DSH host app, and fails closed (with rollback) when the UI step is denied. Live-verified on 21.1.1.10 with a Chinese UI (the menu item is labeled 叠加): the clip was placed at frame 86400 on V2 and the structural check reported `covered`; the AppleScript menu search itself still has no automated test because no test can grant the permission.
- **Render presets differ across versions**: Resolve 21+ (21.1.1.10, live MCP probing: 40 presets) exposes `GetRenderPresets` + `LoadRenderPreset` + `AddRenderJob` (returns the new job's UUID) + `DeleteRenderJob`, which `resolve_render_presets`/`resolve_load_render_preset`/`resolve_add_render_job`/`resolve_delete_render_job` project to the model; 20.x (including 20.3.2.9) has none of these — 21-only tools report coded refusals on 20.x so the model reads the host capability surface before deciding. To change render preset/format on 20.x, set it manually on the Resolve Deliver page and then call `resolve_add_render_job`.
- **Screenshots are full-screen + unsafe**: `resolve_screenshot` uses `screencapture -x` (full screen), so multi-monitor setups capture the other displays into the PNG too; window-level capture (CGWindowList + `screencapture -l`) is future work. Frontmost detection uses the two-step `lsappinfo front` → ASN → `info -only bundleid` chain (the old one-step `… bundleid front` returns empty on darwin 25, which would make screenshots forever refuse with "unknown" frontmost); the whole OS chain runs inside `run_script_unsafe`, and a refusal is a coded `api-failed` result rather than a thrown error. The PNG lands in `screenshotDir`, resolved against the calling Session's working directory (or used as-is when absolute).
- **Four marker colors unverified**: [`src/markers.ts`](src/markers.ts) is now the single source for the enum; its tail — Tan/Beige/Brown/Chocolate — comes from the old plugin and diverges from 21.1.1 official stubs' MarkerColor (Lemon/Sand/Cocoa/Cream); those four colors' runtime acceptance by 21.1.1.10 `AddMarker` is unverified (needs one mutating call).
- **macOS only**: screenshots depend on `screencapture` and `lsappinfo`, and ResolveMCP discovery scans `/Applications`.
- **Single-instance assumption**: connects to the one running local Resolve; behavior with multiple instances is undefined.
- **Resolve-death paths not live-verified**: the `resolve`/`project`-None guards (script-level ERROR resolve-unreachable/no-project) and the ResolveMCP binary init-failure RPC -32603 path are supported by code reading and fake-server tests, never run against a real severed link.
- **headless defaults to read-only**: the headless profile's `never` approval policy auto-rejects writes; unattended writes need an explicit policy change.
- **The vision loop needs an image route**: the PNG from `resolve_screenshot` reaches the model via `read_image`, while the DeepSeek adapter currently declares `inputModalities: ['text']`.
- **Protocol limits**: the kv line protocol breaks when a name contains a newline; `=` is harmless (split on the first `=`). Absent values print empty (no `nil` sentinel), so a literal `nil` round-trips as a real value. Chinese values round-trip cleanly (\uXXXX escaping at the wire layer, restored by JSON parsing).
- **Concurrency**: no tool is marked `isConcurrencySafe` (conservatively serial); the Resolve-side scripting is itself serial in semantics.
