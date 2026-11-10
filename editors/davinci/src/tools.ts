/**
 * Model-facing Consumer surface of the `ctx.davinci` seam: the twenty-six
 * `resolve_*` tools (project info, project conventions, timeline working-copy
 * begin/finalize, media pool, timeline items, find-by-tc, find-clip, seek,
 * screenshot, switch-timeline, place, place-ui, delete, marker, audio items,
 * render status, render presets, add/load/delete render jobs, render control,
 * placement plan, and placement check) plus the system-prompt section teaching
 * the editing conventions. Mutating tools gate
 * through the approval seam before anything executes — the approval prompt is
 * how the user consents.
 * @module @deepseek-ai/dsh-davinci/tools
 */

import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService
// augmentation. The seam stays optional at runtime.
import type {} from '@deepseek-ai/dsh-user-approval'
import { DAVINCI_MARKER_COLORS } from './markers.ts'
import { TRANSPORT_GRACE_MS, defaultConventionsDir, discoverResolveMcp, type Config } from './provider.ts'
import { scriptTimeoutSeconds } from './protocol.ts'
import { defaultConventions } from './conventions.ts'
import type { DavinciProjectConventionsInfo } from './conventions.ts'
import type {
  DavinciAudioTimelineItemsInfo,
  DavinciCallRequest,
  DavinciFindClipInfo,
  DavinciFindByTcInfo,
  DavinciMediaPoolInfo,
  DavinciMutationInfo,
  DavinciPlacementCheckInfo,
  DavinciPlacementPlanInfo,
  DavinciProjectInfo,
  DavinciRenderJobInfo,
  DavinciRenderPresetsInfo,
  DavinciRenderStatusInfo,
  DavinciResult,
  DavinciSeekInfo,
  DavinciTimelineBeginInfo,
  DavinciTimelineFinalizeInfo,
  DavinciTimelineItemsInfo,
  DavinciTimelineSwitchInfo,
} from './types.ts'

/** Closed approval outcomes, structurally the approval seam's vocabulary. */
type WriteApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Minimal approval-requester shape, generic over the agent and call-id types. */
export interface WriteApprover<A, C> {
  request(req: { agent: A; toolName: string; callId?: C; reason?: string; signal?: AbortSignal }): Promise<WriteApprovalOutcome>
}

/** Minimal execution identity the write gate needs. */
export interface WriteApprovalExec<A, C> {
  readonly name: string
  readonly agent?: A
  readonly callId: C
  readonly signal: AbortSignal
}

/**
 * Fail-closed approval gate for mutating tools: resolve one one-shot grant
 * through the approval seam before any mutation runs. No composed approval
 * service, an agent-less execution, or any non-grant outcome throws with a
 * distinct model-readable message; `allowed-once` resolves. A deployment
 * that set `autoApproveMutations` pre-approves this plugin's own mutations
 * and skips the gate without touching any other tool's approval behavior.
 * @param options - the approver (from `ctx.get('approval')`), the calling
 *   execution, the human-readable reason shown in the prompt, and whether
 *   the deployment already pre-approved this toolset's mutations.
 */
export async function requireWriteApproval<A, C>(options: {
  readonly approval: WriteApprover<A, C> | undefined
  readonly exec: WriteApprovalExec<A, C>
  readonly reason: string
  readonly preApproved?: boolean | undefined
}): Promise<void> {
  const { approval, exec, reason, preApproved } = options
  if (preApproved === true) return
  if (approval === undefined || exec.agent === undefined) {
    throw new Error(
      `${exec.name} requires approval, but no approval channel is available `
      + '(compose dsh-user-approval and run inside an agent turn); nothing was changed',
    )
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome === 'allowed-once') return
  const cause = outcome === 'rejected'
    ? 'was rejected by the user'
    : outcome === 'cancelled'
      ? 'was cancelled before the user answered'
      : 'got no approval answer (unavailable)'
  throw new Error(`${exec.name} ${cause}; nothing was changed — do not retry the same mutation, ask the user how to proceed`)
}

const RESOLVE_SECTION = `DaVinci Resolve editing conventions:
- Call resolve_project_info first in a fresh session; every other resolve tool requires Resolve running with a project (and, for timeline tools, a current timeline) open.
- Timeline tools operate on the timeline current in Resolve; use resolve_switch_timeline (1-based index or exact name from resolve_project_info) to change which timeline they target.
- Frame math uses the current timeline's fps; convert timecodes to frames with that fps before comparing positions.
- To match a VFX deliverable to its timeline segment, prefer resolve_find_by_tc with the deliverable's source Start TC over paging resolve_timeline_items.
- Business terms (confirmed with the user; project conventions vary, so ask before assuming):
  - 套片 (conform): rebuild each reel (本) from the editor's locked workprint against the original camera source, on V1. One timeline per reel, leader at the head, reel-local hour TC. Audio is not part of this step: source clips may carry linked audio tracks, but do not judge or re-time sound unless the user asks. A shot may be built from several source segments (multiple time ranges of the same clip), so compare frame ranges rather than assuming one clip covers one shot.
  - 贴视效 (VFX layup): project-specific. Before planning, ask the user for the deliverable bin, naming/TC convention, target track (default V2), handles, and whether to replace or overlay; then resolve_plan_vfx_placement -> resolve_place_clip_ui -> resolve_verify_placement. resolve_place_clip only appends to the tail and rolls back; do not use it for positioned layups.
  - 输出 (output): project-specific. Before enqueuing, ask the user for the deliverable format/codec or preset, target directory, naming, per-reel vs master, leader inclusion, and the QC checklist; then confirm with resolve_render_status / resolve_render_presets and use the render tools.
  - Never guess a project convention. If it is not already in the conversation, ask the user with ask_user_question; when no user channel exists (headless), stop and report the missing conventions instead of guessing. State any default you use explicitly.
- Project conventions: call resolve_project_conventions before a 套片/贴视效/输出 workflow. Ask the user the returned questions once at project start (not every session) and save the answers with resolve_save_project_conventions; reuse them for the rest of the project.
- Timeline edits: call resolve_begin_timeline_edit FIRST. It duplicates the current timeline to "<name>_待审" and switches to the copy; never edit the original. After the edit, ask the user in Chinese "是否检查通过？" and pass the answer to resolve_finalize_timeline_edit. Rejection keeps the copy. Approval renames the original to "__OLD_<timestamp>" and the copy back to the original name; both are kept. Resolve has no scripting API to disable a timeline, so the finalize result warns that the original must be disabled manually (右键 → 禁用时间线).
- Mutating tools (place/place-ui/delete/marker/render-queue/render-control) are approval-gated one-shot: the approval prompt is how the user consents, so never detour through chat to ask permission first, and never retry a rejected mutation unchanged.
- After any mutation, re-read the affected state with resolve_timeline_items or resolve_render_status to confirm the result before reporting success.`

function resultText<T>(result: DavinciResult<T>, format: (data: T) => string): string {
  if (!result.ok) return `ERROR [${result.code}] ${result.message}`
  return format(result.data)
}

/**
 * Slack added after the provider's own wall clock so the exchange's coded
 * timeout message reaches the model before the tool-level deadline fires.
 */
const TOOL_DEADLINE_SLACK_MS = 2_000

/**
 * Build the call envelope every operation needs: the script budget and the
 * caller's cancellation, which the provider forwards to the spawned server.
 * @param exec - the tool execution owning the signal.
 * @param budgetMs - requested script budget.
 * @returns the call envelope.
 */
function callEnvelope(exec: Pick<ToolRunContext, 'signal'>, budgetMs: number): DavinciCallRequest {
  return { timeoutMs: budgetMs, signal: exec.signal }
}

/**
 * Tool-level deadline for one script budget: the script's whole-second budget,
 * the transport grace, and one slack step. Always beyond the provider's own
 * wall clock, so the provider reports the coded timeout first.
 * @param budgetMs - requested script budget.
 * @returns the tool deadline in milliseconds.
 */
function toolDeadlineMs(budgetMs: number): number {
  return scriptTimeoutSeconds(budgetMs) * 1000 + TRANSPORT_GRACE_MS + TOOL_DEADLINE_SLACK_MS
}

/**
 * Resolve the configured screenshot directory against the Session's working
 * directory. An absolute configuration is used as-is.
 * @param exec - the tool execution carrying the calling agent.
 * @param configured - the plugin's `screenshotDir` value.
 * @returns the absolute directory receiving the PNG.
 */
function screenshotDirectory(exec: Pick<ToolRunContext, 'agent'>, configured: string): string {
  if (isAbsolute(configured)) return configured
  return join(exec.agent?.session.header.cwd ?? process.cwd(), configured)
}

/**
 * Derive the Resolve `.app` bundle path from the configured or discovered
 * ResolveMCP binary (`<app>/Contents/Applications/ResolveMCP`).
 * @param config - plugin config.
 * @returns the absolute app path, or undefined when no install is found.
 */
function resolveAppPath(config: Config): string | undefined {
  const mcp = config.resolveMcpPath ?? discoverResolveMcp(config.applicationsDir ?? '/Applications')
  return mcp === undefined ? undefined : dirname(dirname(dirname(mcp)))
}

function projectInfoText(info: DavinciProjectInfo): string {
  const lines = [
    `resolve=${info.resolveVersion} project="${info.projectName}"`,
    `timelines (${info.timelines.length}): ${info.timelines.join(', ') || '(none)'}`,
  ]
  if (info.currentTimeline !== undefined) {
    lines.push(
      `current="${info.currentTimeline}" frames=[${info.currentStartFrame ?? '?'}-${info.currentEndFrame ?? '?'}] `
      + `videoTracks=${info.videoTracks ?? '?'} audioTracks=${info.audioTracks ?? '?'}`,
    )
  }
  return lines.join('\n')
}

function mediaPoolText(info: DavinciMediaPoolInfo): string {
  const lines = info.bins.map((bin) => `bin: ${bin.name} (${bin.clipCount} clips)`)
  for (const clip of info.clips) {
    lines.push(`clip: ${clip.name}`)
    lines.push(`  tc=${clip.startTc ?? '?'} duration=${clip.duration ?? '?'} fps=${clip.fps ?? '?'}`)
    if (clip.filePath !== undefined) lines.push(`  path=${clip.filePath}`)
  }
  if (info.binTotal > info.bins.length) lines.push(`(showing ${info.bins.length} of ${info.binTotal} bins)`)
  if (info.clipTotal > info.clips.length) {
    lines.push(`(showing ${info.clips.length} of ${info.clipTotal} clips — list a narrower bin)`)
  }
  if (lines.length === 0) return '(empty bin)'
  return lines.join('\n')
}

function timelineItemsText(info: DavinciTimelineItemsInfo): string {
  const lines = info.items.map((item) =>
    `item: ${item.name}  [${item.startFrame}-${item.endFrame}]  srcTC=${item.sourceTc ?? '?'}`)
  lines.push(`total=${info.total} shown=${info.shown}`)
  if (info.shown > info.items.length) lines.push('(window truncated — page with from/to)')
  return lines.join('\n')
}

function findByTcText(info: DavinciFindByTcInfo): string {
  const lines = info.hits.map((hit) =>
    `hit: ${hit.name}  record=[${hit.recordStart}-${hit.recordEnd}]  srcTC=${hit.sourceTc ?? '?'}  frames=${hit.frames}`)
  lines.push(`fps=${info.fps} target_frames=${info.targetFrames} scanned=${info.scanned} hits=${info.hits.length}`)
  return lines.join('\n')
}

function findClipText(info: DavinciFindClipInfo): string {
  if (info.hits.length === 0) {
    return `no items match; scanned ${info.scanned} items across every timeline and video track`
  }
  const lines = info.hits.map((hit) =>
    `hit: ${hit.name}  ${hit.timeline} V${hit.trackIndex}  [${hit.recordStart}-${hit.recordEnd}]`)
  lines.push(`scanned=${info.scanned} hits=${info.hitTotal}`)
  if (info.hitTotal > info.hits.length) {
    lines.push(`(showing ${info.hits.length} of ${info.hitTotal} hits — use a narrower name)`)
  }
  return lines.join('\n')
}

function placementPlanText(info: DavinciPlacementPlanInfo): string {
  const lines = info.entries.map((entry) => {
    const segment = entry.segmentName === undefined
      ? 'no segment'
      : `${entry.segmentName} [${entry.segmentRecordStart ?? '?'}-${entry.segmentRecordEnd ?? '?'}]`
    const target = entry.landingFrame === undefined
      ? '-'
      : `${entry.landingFrame}-${entry.targetEndFrame ?? '?'}`
    const overhang = entry.overhangFrames === undefined
      ? ''
      : ` overhang=${entry.overhangFrames > 0 ? '+' : ''}${entry.overhangFrames}`
    const conflicts = entry.conflicts.length > 0 ? ` conflicts=${entry.conflicts.join(', ')}` : ''
    return `plan: ${entry.clipName}  tc=${entry.sourceTc} frames=${entry.frames}  V${info.matchTrack}=${segment}  -> V${info.targetTrack} ${target}${overhang}  ${entry.verdict}${conflicts}`
  })
  const ready = info.entries.filter((entry) => entry.verdict === 'ready').length
  lines.push(`fps=${info.fps} scanned=${info.scanned} shown=${info.entries.length} ready=${ready}`)
  if (info.scanned > info.entries.length) lines.push('(plan truncated — name one deliverable to keep the output short)')
  return lines.join('\n')
}

function placementCheckText(info: DavinciPlacementCheckInfo): string {
  const lines = info.entries.map((entry) =>
    `check: ${entry.targetName}  V${info.targetTrack} [${entry.targetStart}-${entry.targetEnd}]  `
    + `segment=${entry.segmentName ?? '?'} [${entry.segmentStart ?? '?'}-${entry.segmentEnd ?? '?'}]  `
    + `delta=${entry.deltaFrames ?? '?'}  ${entry.verdict}`)
  lines.push(`checked=${info.checked} covered=${info.covered} offset=${info.offset} missing=${info.missing}`)
  if (info.checked > info.entries.length) lines.push('(check truncated — narrow the from/to window)')
  return lines.join('\n')
}

function seekText(info: DavinciSeekInfo): string {
  return `playhead now at ${info.nowAt}`
}

function switchTimelineText(info: DavinciTimelineSwitchInfo): string {
  const parts = [
    `current_timeline="${info.timelineName}" (index ${info.timelineIndex})`,
  ]
  if (info.previousTimelineName !== undefined) {
    parts.push(`was "${info.previousTimelineName}"`)
  }
  return parts.join(', ')
}

function mutationText(_info: DavinciMutationInfo): string {
  return 'done'
}

function audioTimelineItemsText(info: DavinciAudioTimelineItemsInfo): string {
  const lines = info.items.map((item) =>
    `item: ${item.name}  [${item.startFrame}-${item.endFrame}]  srcTC=${item.sourceTc ?? '?'}`)
  lines.push(`total=${info.total} shown=${info.shown}`)
  if (info.shown > info.items.length) lines.push('(window truncated — page with from/to)')
  return lines.join('\n')
}

function renderStatusText(info: DavinciRenderStatusInfo): string {
  const lines = [
    `job_count=${info.jobCount}`,
    `is_rendering=${info.isRendering}`,
  ]
  if (info.currentFormat !== undefined) lines.push(`current_format=${info.currentFormat}`)
  if (info.currentCodec !== undefined) lines.push(`current_codec=${info.currentCodec}`)
  if (info.codecCount !== undefined) lines.push(`codec_count=${info.codecCount}`)
  if (info.presetCount !== undefined) lines.push(`preset_count=${info.presetCount}`)
  if (info.formatCount !== undefined) lines.push(`format_count=${info.formatCount}`)
  if (info.presetCount === 0 && info.formatCount === 0) {
    lines.push('this Resolve build reports no presets and no selectable formats — the active UI-set render settings are the only selectable surface')
  }
  return lines.join('\n')
}

function renderPresetsText(info: DavinciRenderPresetsInfo): string {
  const lines = [
    `active=${info.currentFormat || 'n/a'}/${info.currentCodec || 'n/a'}`,
    `preset_count=${info.presetCount}`,
    `has_load_preset=${info.hasLoadPreset}`,
  ]
  if (info.presetCount > 0) {
    lines.push(`presets=${info.presets.map((n) => `"${n}"`).join(', ')}`)
  } else {
    lines.push('this Resolve build exposes no preset list; use the active UI-set settings as the only selectable surface')
  }
  return lines.join('\n')
}

/**
 * Render the model-facing result lines of `resolve_add_render_job`. A
 * read-back-resolved id carries the 读回确认 marker so the model can tell it
 * apart from a host-returned id when it later targets the id.
 * @param info - the projected enqueue outcome.
 * @returns the `key=value` result text.
 */
export function addRenderJobText(info: DavinciRenderJobInfo): string {
  const lines: string[] = []
  if (info.jobCount !== undefined) lines.push(`queued_jobs=${info.jobCount}`)
  if (info.jobId !== undefined) {
    lines.push(info.idSource === 'read-back' ? `job_id=${info.jobId} (读回确认)` : `job_id=${info.jobId}`)
  }
  if (info.firstJobName !== undefined) lines.push(`first_job=${info.firstJobName}`)
  return lines.join('\n')
}

function loadRenderPresetText(info: DavinciMutationInfo & { readonly loadedPreset: string }): string {
  const lines = ['done=true']
  if (info.loadedPreset !== '') lines.push(`loaded_preset=${info.loadedPreset}`)
  return lines.join('\n')
}

function deleteRenderJobText(info: DavinciMutationInfo & { readonly jobId: string; readonly jobCountAfter: number }): string {
  return [
    'done=true',
    `deleted_job_id=${info.jobId}`,
    `queued_jobs=${info.jobCountAfter}`,
  ].join('\n')
}

function conventionsText(info: DavinciProjectConventionsInfo): string {
  const lines = [
    `project=${info.project}`,
    `path=${info.path}`,
    JSON.stringify(info.conventions, null, 2),
  ]
  if (info.missing.length > 0) {
    lines.push(`missing (${info.missing.length}): ${info.missing.join(', ')}`)
    for (const question of info.questions) lines.push(`ask: ${question.field} — ${question.question}`)
  } else {
    lines.push('missing: none')
  }
  return lines.join('\n')
}

function beginTimelineEditText(info: DavinciTimelineBeginInfo): string {
  return [
    `original="${info.originalName}" [${info.originalStartFrame ?? '?'}-${info.originalEndFrame ?? '?'}]`,
    `working="${info.workingName}" [${info.workingStartFrame ?? '?'}-${info.workingEndFrame ?? '?'}]`,
    'current=working',
  ].join('\n')
}

function finalizeTimelineEditText(info: DavinciTimelineFinalizeInfo): string {
  const lines = [
    `approved=${info.approved}`,
    `done=${info.done}`,
    `old_timeline="${info.originalName}"`,
    `new_timeline="${info.workingName}"`,
  ]
  if (info.backupName !== undefined) lines.push(`backup_name="${info.backupName}"`)
  lines.push(`original_disabled=${info.originalDisabled}`)
  if (info.warning !== undefined) lines.push(`warning=${info.warning}`)
  return lines.join('\n')
}

/**
 * Register the twenty-six `resolve_*` tools and the editing-conventions prompt
 * section on a context that already provides `ctx.tools` and
 * `ctx.systemPrompt`.
 * @param ctx - plugin context owning the registrations.
 * @param config - resolved plugin config.
 */
export function registerDavinciTools(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({ name: 'tool:resolve', order: 120, text: RESOLVE_SECTION })
  // Fast reads/writes use the configured default budget; whole-project scans
  // and clip placement use the configured cap, clamped by the sandbox's 60s
  // script limit inside the provider.
  const fastBudgetMs = config.defaultTimeoutMs ?? 30_000
  const scanBudgetMs = config.maxTimeoutMs ?? 60_000
  const fastDeadlineMs = toolDeadlineMs(fastBudgetMs)
  const scanDeadlineMs = toolDeadlineMs(scanBudgetMs)

  ctx.tools.register(defineTool({
    name: 'resolve_project_info',
    description:
      'Query the running DaVinci Resolve: version, current project name, all timeline names, and the current timeline\'s track counts and frame range. Requires Resolve running with a project open. Start here before any other resolve tool.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(_args, exec) {
      return resultText(await ctx.davinci.projectInfo(callEnvelope(exec, fastBudgetMs)), projectInfoText)
    },
  }))

  const conventionsDir = config.conventionsDir ?? defaultConventionsDir()

  ctx.tools.register(defineTool({
    name: 'resolve_project_conventions',
    description:
      'Read the current project\'s IO conventions: frame rate, conform defaults, VFX layup conventions, output targets, and the timeline working-copy policy. Returns the stored/merged document, the fields still missing, and the Chinese questions to ask. VFX and output fields are project-specific: ask them once at project start, save with resolve_save_project_conventions, and reuse them for the rest of the project. Read-only.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(_args, exec) {
      return resultText(
        await ctx.davinci.projectConventions(conventionsDir, callEnvelope(exec, fastBudgetMs)),
        conventionsText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_save_project_conventions',
    description:
      'Merge partial project-convention answers into one project document and write it atomically. Only provide fields whose answers you have; absent fields stay unchanged. VFX and output fields are asked once at project start, not every session. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      frameRate: { type: 'number', description: 'Project frame rate, e.g. 24 or 23.976' },
      dropFrame: { type: 'boolean', description: 'Whether timecode is drop-frame' },
      conform: {
        type: 'object',
        additionalProperties: false,
        description: 'Conform (套片) conventions',
        properties: {
          workprintPattern: { type: 'string', description: 'WP/workprint timeline name pattern' },
          targetTrack: { type: 'number', description: '1-based target video track (default 1)' },
          audio: { type: 'string', enum: ['ignore', 'keep'], description: 'Ignore or keep source audio' },
          multiSegment: { type: 'boolean', description: 'Allow one shot to use several source ranges' },
          sourceMatch: { type: 'string', enum: ['source-tc'], description: 'Source matching strategy' },
          handles: { type: 'number', description: 'Source handles in frames' },
        },
      },
      vfx: {
        type: 'object',
        additionalProperties: false,
        description: 'VFX layup (贴视效) conventions',
        properties: {
          bin: { type: 'string', description: 'Media-pool bin holding deliverables' },
          targetTrack: { type: 'number', description: '1-based target video track' },
          markerColor: { type: 'string', enum: DAVINCI_MARKER_COLORS, description: 'Marker color' },
          anchor: { type: 'string', enum: ['record-tc', 'source-tc'], description: 'Placement anchor' },
          handles: { type: 'number', description: 'Handles in frames' },
          namePattern: { type: 'string', description: 'Deliverable naming pattern' },
        },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        description: 'Output (输出) conventions',
        properties: {
          preset: { type: 'string', description: 'Render preset name' },
          format: { type: 'string', description: 'Container/format, e.g. mov' },
          codec: { type: 'string', description: 'Codec, e.g. ProRes 422 HQ' },
          directory: { type: 'string', description: 'Absolute output directory' },
          namePattern: { type: 'string', description: 'Output file naming pattern' },
        },
      },
      timelinePolicy: {
        type: 'object',
        additionalProperties: false,
        description: 'Timeline working-copy policy',
        properties: {
          workingSuffix: { type: 'string', description: 'Working-copy suffix (default _待审)' },
          backupSuffixFormat: { type: 'string', description: 'Backup suffix format (default __OLD_YYYYMMDD_HHmm)' },
          disableOriginal: { type: 'boolean', description: 'Disable the original after approval' },
          keepCopy: { type: 'boolean', description: 'Keep the copy when review is rejected' },
          review: { type: 'string', enum: ['zh'], description: 'Review language' },
        },
      },
      notes: { type: 'string', description: 'Free-form project notes' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: 'save the current project\'s IO conventions',
      })
      return resultText(
        await ctx.davinci.saveProjectConventions(conventionsDir, args, callEnvelope(exec, fastBudgetMs)),
        conventionsText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_begin_timeline_edit',
    description:
      'Start an edit safely: duplicate the current timeline through MediaPool:DuplicateTimeline, rename the copy to "<name>_待审", and switch to it. The original is not edited; a failed rename/switch removes the new copy. Call this before any timeline-changing workflow, then perform the edit on the copy. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(_args, exec) {
      const envelope = callEnvelope(exec, fastBudgetMs)
      const conventions = await ctx.davinci.projectConventions(conventionsDir, envelope)
      const suffix = conventions.ok ? conventions.data.conventions.timelinePolicy.workingSuffix : '_待审'
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `duplicate the current timeline as a "${suffix}" working copy`,
      })
      return resultText(await ctx.davinci.beginTimelineEdit(suffix, envelope), beginTimelineEditText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_finalize_timeline_edit',
    description:
      'Finish a working-copy edit after the user reviews it. approved=false keeps the "_待审" copy and changes nothing. approved=true renames the original to "__OLD_<timestamp>" and the copy back to the original name; both timelines are kept. Resolve has no scripting API to disable a timeline, so the original stays enabled and the result carries a manual-disable warning (右键 → 禁用时间线). Approval-gated when approved=true.',
    parameters: {
      approved: { type: 'boolean', required: true, description: 'The user\'s review decision' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      const envelope = callEnvelope(exec, fastBudgetMs)
      const conventions = await ctx.davinci.projectConventions(conventionsDir, envelope)
      const policy = conventions.ok
        ? conventions.data.conventions.timelinePolicy
        : defaultConventions('').timelinePolicy
      if (args.approved) {
        await requireWriteApproval({
          approval: ctx.get('approval'),
          preApproved: config.autoApproveMutations,
          exec,
          reason: `finalize the review: rename the original to "${policy.backupSuffixFormat}" backup and the copy to the original name`,
        })
      }
      return resultText(await ctx.davinci.finalizeTimelineEdit(args.approved, policy, envelope), finalizeTimelineEditText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_media_pool',
    description:
      'List a media-pool folder (bin) and its clips with name, source Start TC, duration, FPS, and file path. Use bin paths like "VFX" or "VFX/20260702"; omit to list top-level bins. Returns at most 200 bins and 200 clips; the totals say how many exist.',
    parameters: {
      bin: { type: 'string', description: 'Bin path like "VFX/20260702"; empty/omitted = root bins' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      return resultText(await ctx.davinci.mediaPool(args.bin ?? '', callEnvelope(exec, fastBudgetMs)), mediaPoolText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_timeline_items',
    description:
      'List timeline items on one video track of the current timeline, optionally windowed by record frames. Each item: name, start/end record frames, source clip Start TC. Use from/to to page through long tracks.',
    parameters: {
      trackIndex: { type: 'number', required: true, description: '1-based video track index (V1=1, V2=2)' },
      from: { type: 'number', description: 'Record frame lower bound (inclusive)' },
      to: { type: 'number', description: 'Record frame upper bound (inclusive)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      return resultText(
        await ctx.davinci.timelineItems(args.trackIndex, args.from, args.to, callEnvelope(exec, scanBudgetMs)),
        timelineItemsText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_find_by_tc',
    description:
      'Find V1 segments of the current timeline whose SOURCE clip timecode range covers the given TC. Deterministic whole-track scan; prefer this over paging resolve_timeline_items when matching VFX deliverables by their Start TC. Returns hits with record positions and durations.',
    parameters: {
      tc: { type: 'string', required: true, description: 'Source timecode HH:MM:SS:FF, e.g. the deliverable Start TC' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      return resultText(await ctx.davinci.findByTc(args.tc, callEnvelope(exec, scanBudgetMs)), findByTcText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_find_clip',
    description:
      'Search EVERY timeline and EVERY video track for items whose name contains a given substring, in one call. Prefer this over paging resolve_timeline_items when hunting a clip by name (e.g. locating a stray deliverable). Read-only. Returns at most 200 hits; the total says how many matched.',
    parameters: {
      name: { type: 'string', required: true, description: 'Case-sensitive substring, e.g. "6585" or "ZY_EP04"' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      return resultText(await ctx.davinci.findClip(args.name, callEnvelope(exec, scanBudgetMs)), findClipText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_seek',
    description:
      'Move the current timeline playhead to a record frame (or timecode). The Resolve viewer then shows that frame, so a following resolve_screenshot captures it. Use this to visually inspect a segment at its start frame.',
    parameters: {
      frame: { type: 'number', description: 'Record frame to seek to' },
      tc: { type: 'string', description: 'Timecode HH:MM:SS:FF to seek to (alternative to frame)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      if (args.frame === undefined && args.tc === undefined) {
        throw new Error('resolve_seek needs a record frame or a timecode — nothing was moved')
      }
      return resultText(await ctx.davinci.seek(args.frame, args.tc, callEnvelope(exec, fastBudgetMs)), seekText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_screenshot',
    description:
      'Capture the DaVinci Resolve UI to a PNG and return its path; read it with the read_image tool. Requires Resolve to be the FRONTMOST app — if another window covers it the call fails and names the frontmost app; then either ask the user to bring Resolve to the front, or retry with activate: true to focus it automatically. Seek first with resolve_seek so the viewer shows the frame you need. Requires a model route that accepts image input.',
    parameters: {
      activate: { type: 'boolean', description: 'Bring DaVinci Resolve to the front before capturing (takes window focus)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      if (args.activate === true && config.resolveMcpPath === undefined
        && discoverResolveMcp(config.applicationsDir ?? '/Applications') === undefined) {
        throw new Error('activate requested but no DaVinci Resolve install found under the configured applicationsDir — set resolveMcpPath in config')
      }
      return resultText(
        await ctx.davinci.screenshot({
          activate: args.activate === true,
          screenshotDir: screenshotDirectory(exec, config.screenshotDir ?? '.resolve-agent'),
        }, callEnvelope(exec, fastBudgetMs)),
        (info) => info.path,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_switch_timeline',
    description:
      "Make a specific timeline the project's current one so the timeline tools target it. Give a 1-based index from resolve_project_info or the exact timeline name. Session state only: no timeline content is modified and no approval prompt is shown.",
    parameters: {
      index: { type: 'number', description: '1-based timeline index from resolve_project_info; wins over name when both are given' },
      name: { type: 'string', description: 'Exact timeline name; used when index is omitted' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      if (args.index === undefined && args.name === undefined) {
        throw new Error('resolve_switch_timeline needs an index or a timeline name — list the project\'s timelines with resolve_project_info first')
      }
      return resultText(
        await ctx.davinci.switchTimeline(args.index, args.name, callEnvelope(exec, fastBudgetMs)),
        switchTimelineText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_place_clip',
    description:
      'Append a media-pool clip to the tail of the current timeline, then verify the landing against the requested video track and record frame. Resolve 21\'s scripting surface has no positioned insert: the append always lands on the timeline tail, so a mismatched placement is rolled back and the call fails with the actual coordinates. For a true positioned insert, drive the Edit page UI. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      bin: { type: 'string', required: true, description: 'Bin path of the clip, e.g. "VFX/20260702"' },
      clipName: { type: 'string', required: true, description: 'Exact clip name in the bin' },
      trackIndex: { type: 'number', required: true, description: '1-based video track index (V2=2)' },
      recordFrame: { type: 'number', required: true, description: 'Timeline record frame to place at' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `place clip "${args.clipName}" from bin ${args.bin} at record frame ${args.recordFrame} on video track ${args.trackIndex} (append + landing check)`,
      })
      return resultText(
        await ctx.davinci.place(
          { bin: args.bin, clipName: args.clipName, trackIndex: args.trackIndex, recordFrame: args.recordFrame },
          callEnvelope(exec, scanBudgetMs),
        ),
        mutationText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_plan_vfx_placement',
    description:
      'Read-only VFX layup plan: for every deliverable in a media-pool bin (or one named deliverable), match its source Start TC to a segment on the match track, compute the landing record frame and target range, and report ready / no-match / occupied. Start here before any paste.',
    parameters: {
      bin: { type: 'string', required: true, description: 'Bin path holding the VFX deliverables, e.g. "VFX/20260702"' },
      clipName: { type: 'string', description: 'One deliverable name; omit to plan the whole bin' },
      matchTrack: { type: 'number', description: '1-based video track holding the picture cut (default 1)' },
      targetTrack: { type: 'number', description: '1-based video track for the deliverables (default 2)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      return resultText(
        await ctx.davinci.placementPlan(
          args.bin,
          args.clipName,
          args.matchTrack ?? 1,
          args.targetTrack ?? 2,
          callEnvelope(exec, scanBudgetMs),
        ),
        placementPlanText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_verify_placement',
    description:
      'Read-only structural QC of a VFX layup: for each item on the target track, compare its start with the closest match-track segment start and report covered / offset / no-segment. Use after pasting (or after a manual paste) to confirm every deliverable sits on its shot.',
    parameters: {
      matchTrack: { type: 'number', description: '1-based video track holding the picture cut (default 1)' },
      targetTrack: { type: 'number', description: '1-based video track holding the deliverables (default 2)' },
      from: { type: 'number', description: 'Record frame lower bound for the checked items' },
      to: { type: 'number', description: 'Record frame upper bound for the checked items' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      return resultText(
        await ctx.davinci.placementCheck(
          args.matchTrack ?? 1,
          args.targetTrack ?? 2,
          args.from,
          args.to,
          callEnvelope(exec, scanBudgetMs),
        ),
        placementCheckText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_place_clip_ui',
    description:
      'Position a deliverable at a record frame on V2 by driving the Edit page UI (Resolve\'s scripting surface cannot insert at a frame). Requires V1 content at the landing frame and a free V2 and above over the deliverable range; it selects the clip, seeks, clicks "Place On Top", verifies the landing, and rolls back on any mismatch. Requires macOS Accessibility/Automation permission for the DSH host app and a frontmost Resolve; fails closed and changes nothing when the UI step is denied. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      bin: { type: 'string', required: true, description: 'Bin path of the deliverable, e.g. "VFX/20260702"' },
      clipName: { type: 'string', required: true, description: 'Exact deliverable name in the bin' },
      recordFrame: { type: 'number', required: true, description: 'Record frame where the deliverable starts on V2' },
      trackIndex: { type: 'number', description: 'Video track to land on; only V2 is supported (default 2)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      if ((args.trackIndex ?? 2) !== 2) {
        throw new Error('resolve_place_clip_ui currently supports video track 2 only; nothing was changed')
      }
      const appPath = resolveAppPath(config)
      if (appPath === undefined) {
        throw new Error('resolve_place_clip_ui needs the DaVinci Resolve .app path — set resolveMcpPath in config; nothing was changed')
      }
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `place "${args.clipName}" from ${args.bin} on V2 at record frame ${args.recordFrame} via the Edit page UI (Place On Top)`,
      })
      return resultText(
        await ctx.davinci.placeUi({
          bin: args.bin,
          clipName: args.clipName,
          trackIndex: 2,
          recordFrame: args.recordFrame,
          appPath,
        }, callEnvelope(exec, scanBudgetMs)),
        mutationText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_delete_item',
    description:
      'Delete the video-track item that starts exactly at a record frame (identify items and their start frames with resolve_timeline_items). Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      trackIndex: { type: 'number', required: true, description: '1-based video track index the item lives on' },
      startFrame: { type: 'number', required: true, description: 'Record frame the item starts at (from resolve_timeline_items)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `delete the item starting at record frame ${args.startFrame} on video track ${args.trackIndex}`,
      })
      return resultText(
        await ctx.davinci.remove({ trackIndex: args.trackIndex, startFrame: args.startFrame }, callEnvelope(exec, scanBudgetMs)),
        mutationText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_audio_timeline_items',
    description:
      'List audio items on one audio track of the current timeline, optionally windowed by record frames. Use this to locate the 套片 audio delivery on A1 and compare frame ranges against V1 picture segments. The A1 item is typically one long clip covering the whole episode.',
    parameters: {
      trackIndex: { type: 'number', required: true, description: '1-based audio track index (A1=1)' },
      from: { type: 'number', description: 'Record frame lower bound (inclusive)' },
      to: { type: 'number', description: 'Record frame upper bound (inclusive)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      return resultText(
        await ctx.davinci.audioTimelineItems(args.trackIndex, args.from, args.to, callEnvelope(exec, scanBudgetMs)),
        audioTimelineItemsText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_render_status',
    description:
      'Read the live render-engine state: queued-job count, is-rendering flag, the current (format, codec) pair, and the sizes of the selectable preset and format lists (absent on builds without them). Read-only. Use before enqueueing or starting a render to confirm the current Resolve settings.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(_args, exec) {
      return resultText(await ctx.davinci.renderStatus(callEnvelope(exec, fastBudgetMs)), renderStatusText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_render_presets',
    description:
      'Read the render engine\'s active (format, codec) pair and the selectable render preset list (empty when this Resolve build exposes none). Read-only. Use before switching presets or enqueueing to confirm what will render.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(_args, exec) {
      return resultText(await ctx.davinci.renderPresets(callEnvelope(exec, fastBudgetMs)), renderPresetsText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_add_render_job',
    description:
      'Enqueue the current timeline into the render queue for output under an absolute target directory. Keeps the currently active render settings. Returns the new job\'s id — use it to cancel the job (resolve_delete_render_job) or start/stop rendering (resolve_start_rendering / resolve_stop_rendering). Confirm the active render settings and queue depth with resolve_render_status first. When the queue does not confirm exactly one new job, the call refuses with an error instead of guessing. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      targetDir: { type: 'string', required: true, description: 'Absolute target directory the render output will land in' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: scanDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `enqueue the current timeline for render into ${args.targetDir} (active render settings preserved)`,
      })
      return resultText(
        await ctx.davinci.addRenderJob({ targetDir: args.targetDir }, callEnvelope(exec, scanBudgetMs)),
        addRenderJobText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_load_render_preset',
    description:
      'Make one render preset active by its exact name. The name is first checked against the preset list this Resolve build reports (read it with resolve_render_presets); a name outside that list refuses with preset-not-found without touching the host, and a host that does not confirm the load is an api-failed refusal. The active render settings stay as they are on any refusal. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      presetName: { type: 'string', required: true, description: 'Exact preset name as reported by resolve_render_presets (case-sensitive).' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `load render preset "${args.presetName}"`,
      })
      return resultText(
        await ctx.davinci.loadRenderPreset({ presetName: args.presetName }, callEnvelope(exec, fastBudgetMs)),
        loadRenderPresetText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_delete_render_job',
    description:
      'Cancel one queued render job by the exact id resolve_add_render_job returned. The deletion is confirmed by reading the queue back, so success is only reported once the job is really gone; a refusal names why (no queued job has that id / the queue is empty / the host refused) and never deletes anything else. Does not start or stop rendering. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'The job id returned by resolve_add_render_job.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `delete render job ${args.jobId} from the queue`,
      })
      return resultText(
        await ctx.davinci.deleteRenderJob({ jobId: args.jobId }, callEnvelope(exec, fastBudgetMs)),
        deleteRenderJobText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_start_rendering',
    description:
      'Start the render engine, either the whole queue or a set of specific job ids from resolve_render_status. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      jobIds: { type: 'array', items: { type: 'string' }, description: 'Job ids to start; omit to start the whole queue' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: args.jobIds?.length
          ? `start rendering jobs: ${args.jobIds.join(', ')}`
          : 'start rendering the whole queue',
      })
      return resultText(
        await ctx.davinci.startRendering({ jobIds: args.jobIds }, callEnvelope(exec, fastBudgetMs)),
        mutationText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_stop_rendering',
    description:
      'Stop the render engine, either the whole queue or a set of specific job ids. Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      jobIds: { type: 'array', items: { type: 'string' }, description: 'Job ids to stop; omit to stop the whole engine' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: args.jobIds?.length
          ? `stop rendering jobs: ${args.jobIds.join(', ')}`
          : 'stop the render engine (whole queue)',
      })
      return resultText(
        await ctx.davinci.stopRendering({ jobIds: args.jobIds }, callEnvelope(exec, fastBudgetMs)),
        mutationText,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_add_marker',
    description:
      'Add a timeline marker at an absolute record frame with a color, name, and note (useful for flagging review points). Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      frame: { type: 'number', required: true, description: 'Absolute record frame for the marker' },
      color: { type: 'string', required: true, enum: DAVINCI_MARKER_COLORS, description: 'Marker color' },
      name: { type: 'string', required: true, description: 'Marker name' },
      note: { type: 'string', description: 'Marker note' },
      durationFrames: { type: 'number', description: 'Marker duration in frames (default 1)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: fastDeadlineMs,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        preApproved: config.autoApproveMutations,
        exec,
        reason: `add a ${args.color} marker "${args.name}" at record frame ${args.frame}`,
      })
      return resultText(
        await ctx.davinci.addMarker({
          frame: args.frame,
          color: args.color,
          name: args.name,
          note: args.note ?? '',
          durationFrames: args.durationFrames,
        }, callEnvelope(exec, fastBudgetMs)),
        mutationText,
      )
    },
  }))
}
