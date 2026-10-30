# @deepseek-ai/dsh-davinci (editors/davinci)

English | [中文](README.zh.md)

Editing-capability plugin driving a running DaVinci Resolve: the Service Definition (`ctx.davinci`), a local Provider (the davinci-mcp stdio JSON-RPC server), and the model-visible `resolve_*` tools merged into one package (the roles stay structurally separate: abstract service / provider / consumer). This is a personal editor plugin under the repository's `editors/`, source-launched through profile user patch layers and not part of the `packages/` release set.

## Architecture

```
src/types.ts     词汇表：调用信封、Spec、各操作结果、失败码封闭联合（纯类型）
src/protocol.ts  纯协议层：run_script 内层响应映射、ERROR <code>: <message> 解析、kv 投影、timeout 钳制/秒换算
src/python.ts    Python 脚本体：共享 prelude（含 Lua tostring 等价的 s() 帮手）+ 每操作一个 body + unsafe 截图体
src/service.ts   抽象 DavinciService：ctx key 合并、resolve() 默认化、类型化领域方法、截图门
src/provider.ts  McpDavinci：每调用一次性 node 进程跑 MCP stdio 交换、路径自动发现、传输超时/中止
src/tools.ts     19 个 resolve_* 工具 + systemPrompt 剪辑约定节 + 审批门
src/index.ts     插件入口：name/inject/Config/apply
```

Transport protocol: every call spawns one node process running the davinci-mcp server (`~/.local/share/davinci-mcp/server/index.js`, stdio JSON-RPC); stdin receives the three lines `initialize`/`initialized`/`tools/call`, and once the id-matching response arrives stdin is closed so the wrapper exits on its own — measured full wall clock for a fresh process is about 0.2s. Scripts execute through the sandboxed `run_script` tool (Python, with `resolve`/`project` globals pre-injected and imports forbidden); output is `key=value` lines (everything after the first `=` is the value) and failure lines `ERROR <code>: <message>`; operations needing OS access (screenshots) go through `run_script_unsafe`. The sandbox seam is deliberately not used — the MCP server must talk to the Resolve application's local scripting IPC, which isolation would sever; destructive changes are instead gated by the tool-layer approval gate.

Inner response mapping (`innerResponseToRaw` in `protocol.ts`): `{"output": …}` passes through to kv parsing unchanged; an `{"error": …}` starting with `Script timed out` maps to `timeout` (original text kept), anything else (Traceback/SyntaxError) maps to `api-failed` (last exception line taken); JSON-RPC-layer errors (e.g. ResolveMCP binary init failure -32603) and process crashes map to `spawn-failed`. stdout reading filters by id (initialize triggers `notifications/message` notification lines).

## Tool surface (19 tools)

| Tool | Kind | Description |
|---|---|---|
| `resolve_project_info` | read | Version, project name, all timelines, current timeline's tracks/frame range |
| `resolve_media_pool` | read | List bins and clips (name, source Start TC, duration, fps, path) |
| `resolve_timeline_items` | read | Video-track item list, paginable by record-frame window (200 per call cap) |
| `resolve_find_by_tc` | read | Deterministic full-track V1 scan by source TC; first choice for VFX-deliverable matching |
| `resolve_find_clip` | read | One call searches items by name across all timelines × all video tracks; first choice for finding stray deliverables / locating by name, replacing paginated scans |
| `resolve_seek` | visual | Move the playhead to a record frame/TC |
| `resolve_screenshot` | visual | Screenshot to a workspace PNG, paired with `read_image` (needs an image route); requires Resolve to be the frontmost app, otherwise errors naming the current frontmost app, with `activate: true` to bring it forward. The whole OS chain (`open` activation + `lsappinfo` frontmost check + `screencapture -x`) runs inside one `run_script_unsafe` exchange |
| `resolve_switch_timeline` | session | `Project:SetCurrentTimeline` switches the current timeline by 1-based index or exact name (no content change, no approval) |
| `resolve_place_clip` | write·approval | Place a clip at trackIndex+recordFrame. The scripting surface only offers `MediaPool:AppendToTimeline` (on 21.1.1.10 its `recordFrame`/`trackIndex`/`insertType` options are fully ignored and it always lands at V1's tail), so this tool = append + read back the landing + strict comparison against the requested track/frame; on mismatch it rolls back with `DeleteClips` and reports `ERROR mislanded-placement`. For true positioned placement drive the Edit page UI (drag / `Select+`) |
| `resolve_delete_item` | write·approval | Timeline:DeleteClips removes an item by track + start frame |
| `resolve_add_marker` | write·approval | Timeline:AddMarker absolute-frame timeline marker |
| `resolve_audio_timeline_items` | read | Audio-track item list (for conform / audio-picture sync, compared against V1 video items by frame range) |
| `resolve_render_status` | read | Render-queue state: job count, is-rendering, current (format, codec), current-format codec count, preset count, format count (last three are Resolve 21+ surfaces; 20.x reports 0) |
| `resolve_render_presets` | read | Render engine's current (format, codec) and host preset list (Resolve 21+; empty list on 20.x) + `LoadRenderPreset` capability flag |
| `resolve_add_render_job` | write·approval | Enqueue the current timeline to a targetDir, keeping current render settings. Empty-string defense: snapshot the queue id set before the call; when AddRenderJob returns empty/uncertain, read the queue back and only a uniquely new id becomes `job_id`, annotated `读回确认` (read-back confirmed) in the result; several candidates report `ambiguous-job` with no guessing and no extra enqueue; only a confirmed nothing-was-added (and the previous synchronous call finished) triggers the single-sanctioned-retry policy; exceptions / failed read-backs count as unknown outcomes with no retry |
| `resolve_load_render_preset` | write·approval | `Project:LoadRenderPreset(name)` switches the render preset (21.x only, 20.x returns `api-failed`; name must match the `resolve_render_presets` list exactly, otherwise `preset-not-found`) |
| `resolve_delete_render_job` | write·approval | Delete one queued job by its passed real `job_id`: the id must hit a queue row; a miss (including empty queue / empty id) reports `job-not-found` without calling the host delete; `done=true` is printed only after a post-delete read-back confirms the id left the queue; no exception ever degrades into clearing the queue (no delete-all fallback in code, locked by tests) |
| `resolve_start_rendering` | write·approval | StartRendering for all or specified jobIds |
| `resolve_stop_rendering` | write·approval | StopRendering for all or specified jobIds |

### Domain terms (also recorded in the RESOLVE_SECTION prompt section)

- **套片 (conform)**: in the EP04 project context, the umbrella for two sub-flows:
  - audio-picture sync: long wavs in SOUNDS (e.g. `0130 4ji.wav` ≈ one episode mix) aligned one-to-one against shots on V1, checking every video segment falls inside the mix coverage;
  - nested assembly: nested timelines in the TL bin (named by date, e.g. `EP04_20260129`) placed as single items onto the parent timeline's V1.
- **贴视效 (VFX layup)**: VFX deliverables (`ZY_EP04_4650_CMP_v006.mov` etc.) matched to V1 segments by source Start TC and laid onto V2; `resolve_place_clip`'s V2 placement convention lives here.
- **输出 (output)**: the render-queue flow; Resolve 21+ exposes `GetRenderPresets` + `LoadRenderPreset`/`DeleteRenderJob` (on local 21.1.10, live MCP probing found 40 presets, 23 `GetRenderFormats` entries, `has_load_preset=true`), and `resolve_render_presets` (preset list + capability flag) + `resolve_load_render_preset` (switch preset, 21.x) + `resolve_add_render_job` (enqueue, 21.x returns a UUID `job_id`) + `resolve_delete_render_job` (undo an enqueue, 21.x) + `resolve_start_rendering`/`resolve_stop_rendering` (start/stop rendering) + `resolve_render_status` (live state surface) form the complete flow. 20.x (including 20.3.2.9) has no `LoadRenderPreset`/`DeleteRenderJob`/`GetRenderPresets` — it can only rely on the render settings currently in the UI, and 21-only tools report `api-failed` so the model recognizes the capability boundary.

Write tools pass through `requireWriteApproval` inside execute before running (opportunistic `ctx.get('approval')`; only a one-shot `allowed-once` executes; no channel / no agent / `rejected` / `cancelled` / `unavailable` each raise a model-readable error, fail-closed). The approval prompt is how the user consents — do not bypass it by asking in chat first.

## Config (cordis.yml)

| Field | Default | Description |
|---|---|---|
| `mcpServerPath` | `~/.local/share/davinci-mcp/server/index.js` | Absolute entry path of the davinci-mcp stdio server; a missing default location fails loud on first call |
| `resolveMcpPath` | auto-discovered | Absolute path of the ResolveMCP binary, passed to the server as `RESOLVE_MCP_PATH`; when omitted, the highest-version `DaVinci Resolve*/…/Applications/ResolveMCP` under `applicationsDir` is scanned (the server's built-in default path has no version suffix, so it must be passed) |
| `applicationsDir` | `/Applications` | Scan root for Resolve install discovery (for non-standard install locations) |
| `defaultTimeoutMs` | 30000 | Per-script-call budget |
| `maxTimeoutMs` | 60000 | Request budget cap; the `run_script` sandbox's own hard cap is 60s and anything beyond is clamped to 60s at exchange time |
| `screenshotDir` | `.resolve-agent` | Screenshot output directory (workspace-relative) |
| `autoApproveMutations` | `false` | Deployment-level pre-approval: skips this plugin's write-tool approval gate (an explicit trust decision, leaves other tools untouched) |

Timeout clamping: the request budget is clamped into [1s, default, max], converted to whole seconds with `Math.ceil`, and clamped into `run_script`'s [1,60]; the outer exchange wall clock = the millisecond budget + 5s transport grace so the inner timeout text arrives first. A script timeout arrives as a normal result text and maps to the `timeout` failure code (message is the sandbox's original text), differing from the old fuscript-era killed/ETIMEDOUT timeout wording — a model-visible difference and a known migration change.

## Mounting and running

Both profiles' user patch layers (`~/.dsh/profiles/<name>/cordis.patch.yml`) already insert:

```yaml
- insert:
    - id: davinci-resolve
      name: '/Users/phenom8010/code/github/deepseek-harness/editors/davinci/src/index.ts'
```

`pnpm dsh --profile web --dump-config` verifies the composition; `node --import tsx/esm editors/davinci/smoke.ts` runs a read-only smoke plus failure-path probes against a running Resolve (2026-10-30 local run: Resolve 21.1.1.10, project 20261029, Timeline 1 (frames 90000-158450), 3 clips in the media-pool root listing, render queue 0, mov/77 codecs/40 presets; the timeout / sandbox-refusal / unsafe / screenshot-refusal failure paths all reported the expected texts).

## Tests

`editors/davinci/tests/` (already in the root vitest collection): protocol parsing and projection (including `id_source`→`idSource`, the `ambiguous-job` failure code), `innerResponseToRaw` inner response mapping (timeout/Traceback/SyntaxError/non-JSON fail-loud), timeout clamping and second conversion, ResolveMCP discovery ordering, every non-authorized approval-gate path, 19-tool registration under a real Context composition, and the `读回确认` (read-back confirmed) annotation of `addRenderJobText`; the transport layer uses a temporary fake MCP server (FAKE_MODE driven) covering successful exchange (including notification-line filtering), inner timeout, inner Traceback, RPC error, process crash, non-inner JSON (wrapper isError), wall-clock kill, caller abort, plus add/delete render job read-back confirmation and `ambiguous-job` refusal through the real stdio transport; `python.spec.ts` locks the prelude's s()/each() contract and generated-body structure (snapshot-before-call, retry bound, no clear-queue fallback), ast.parse-validates every generated body where python3 exists, and really executes the add/delete render bodies against a fake `project` (queue snapshots consumed per call, mutations fully recorded), covering empty-string→read-back confirm, multi-candidate→error without retry, nothing-added→single retry, two misses→error, direct/dict returns, pre-read failure refusing to enqueue, AddRenderJob raising without retry, delete read-back confirm, delete target-missing/empty-queue/empty-id never touching the host delete, delete "succeeded" but still queued→error, delete raising, and post-delete read-back failure branches (skipped without python3). The package tsconfig uses project references (added to `tsconfig.host.json`).

## Model Experience

- The model sees: the editing-conventions section of systemPrompt (order 120) + the 19 tool schemas and descriptions; tool results are formatted text (failures carry `ERROR [code] message`).
- Token effect: tool schemas ride every request; the conventions section is about 6 lines.
- KV-cache effect: a stable registration set keeps the prefix stable.

## Known Limitations and Deferred Work

- **The fuscript Lua bridge is dead (why we migrated)**: on local Resolve 21.1.1 the fuscript process first intermittently native-SIGSEGV'd while reading the render engine (`GetRenderFormats()` etc.; exit 139, pcall cannot catch a native crash), then lost the scripting IPC bridge entirely (nil injection; preference and restart both ruled out) — which is why the transport layer moved wholesale to davinci-mcp (Python sandbox + stdio JSON-RPC). Historical detail lives in git history (this README section once recorded the SIGSEGV specifics).
- **Sandbox import ban**: `run_script` forbids every import (`os`/`sys`/`pathlib`/`shutil` are the documented bans; `subprocess` and transitive `typing` measured banned too); all script bodies import nothing. `run_script_unsafe` allows `os`/`subprocess`/`time` (measured), used only by the screenshot body. New imports need live verification first.
- **60s hard cap**: the `run_script` sandbox caps timeout at 60s, so slow scans that used to request up to 120s (whole-project find_clip) now cap at 60s; `maxTimeoutMs`'s default changing from 120000 to 60000 is a config-surface breaking change (an explicit 120000 still gets clamped to 60s at exchange time).
- **Trimming unavailable**: live probing on local Resolve found no `SetStart`/`SetEnd` on `TimelineItem` and no `MoveClips` on `Timeline`; v1 substitutes a delete+replace combination, and true boundary trimming waits on Resolve scripting API support.
- **Render presets differ across versions**: Resolve 21+ (21.1.1.10, live MCP probing: 40 presets) exposes `GetRenderPresets` + `LoadRenderPreset` + `AddRenderJob` (returns the new job's UUID) + `DeleteRenderJob`, which `resolve_render_presets`/`resolve_load_render_preset`/`resolve_add_render_job`/`resolve_delete_render_job` project to the model; 20.x (including 20.3.2.9) has none of these — 21-only tools report coded refusals on 20.x so the model reads the host capability surface before deciding. To change render preset/format on 20.x, set it manually on the Resolve Deliver page and then call `resolve_add_render_job`.
- **Screenshots are full-screen + unsafe**: `resolve_screenshot` uses `screencapture -x` (full screen), so multi-monitor setups capture the other displays into the PNG too; window-level capture (CGWindowList + `screencapture -l`) is future work. Frontmost detection uses the two-step `lsappinfo front` → ASN → `info -only bundleid` chain (the old one-step `… bundleid front` returns empty on darwin 25, which would make screenshots forever refuse with "unknown" frontmost); the whole OS chain runs inside `run_script_unsafe` with refusal texts byte-identical to the old version.
- **Four marker colors unverified**: the tail of `resolve_add_marker`'s enum — Tan/Beige/Brown/Chocolate — comes from the old plugin (provider constants) and diverges from 21.1.1 official stubs' MarkerColor (Lemon/Sand/Cocoa/Cream); those four colors' runtime acceptance by 21.1.1.10 `AddMarker` is unverified (needs one mutating call).
- **macOS only**: screenshots depend on `screencapture` and `lsappinfo`, and ResolveMCP discovery scans `/Applications`.
- **Single-instance assumption**: connects to the one running local Resolve; behavior with multiple instances is undefined.
- **Resolve-death paths not live-verified**: the `resolve`/`project`-None guards (script-level ERROR resolve-unreachable/no-project) and the ResolveMCP binary init-failure RPC -32603 path are supported by code reading and fake-server tests, never run against a real severed link.
- **headless defaults to read-only**: the headless profile's `never` approval policy auto-rejects writes; unattended writes need an explicit policy change.
- **The vision loop needs an image route**: the PNG from `resolve_screenshot` reaches the model via `read_image`, while the DeepSeek adapter currently declares `inputModalities: ['text']`.
- **Protocol limits**: the kv line protocol breaks when a name contains a newline; `=` is harmless (split on the first `=`). Chinese values round-trip cleanly (\uXXXX escaping at the wire layer, restored by JSON parsing).
- **Concurrency**: no tool is marked `isConcurrencySafe` (conservatively serial); the Resolve-side scripting is itself serial in semantics.
