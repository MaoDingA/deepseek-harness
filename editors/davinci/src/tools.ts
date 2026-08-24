/**
 * Model-facing Consumer surface of the `ctx.davinci` seam: the twelve
 * `resolve_*` tools plus the system-prompt section teaching the editing
 * conventions. Mutating tools gate through the approval seam before anything
 * executes — the approval prompt is how the user consents.
 * @module @deepseek-ai/dsh-davinci/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService
// augmentation. The seam stays optional at runtime.
import type {} from '@deepseek-ai/dsh-user-approval'
import { captureScreenshot, DAVINCI_MARKER_COLORS, type Config } from './provider.ts'
import type {
  DavinciFindClipInfo,
  DavinciFindByTcInfo,
  DavinciMediaPoolInfo,
  DavinciMutationInfo,
  DavinciProjectInfo,
  DavinciResult,
  DavinciSeekInfo,
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
 * distinct model-readable message; `allowed-once` resolves.
 * @param options - the approver (from `ctx.get('approval')`), the calling
 *   execution, and the human-readable reason shown in the prompt.
 */
export async function requireWriteApproval<A, C>(options: {
  readonly approval: WriteApprover<A, C> | undefined
  readonly exec: WriteApprovalExec<A, C>
  readonly reason: string
}): Promise<void> {
  const { approval, exec, reason } = options
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
- Mutating tools (place/delete/marker) are approval-gated one-shot: the approval prompt is how the user consents, so never detour through chat to ask permission first, and never retry a rejected mutation unchanged.
- After any mutation, re-read the affected track with resolve_timeline_items to confirm the result before reporting success.`

function resultText<T>(result: DavinciResult<T>, format: (data: T) => string): string {
  if (!result.ok) return `ERROR [${result.code}] ${result.message}`
  return format(result.data)
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
  lines.push(`scanned=${info.scanned} hits=${info.hits.length}`)
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

/**
 * Register the twelve `resolve_*` tools and the editing-conventions prompt
 * section on a context that already provides `ctx.tools` and
 * `ctx.systemPrompt`.
 * @param ctx - plugin context owning the registrations.
 * @param config - resolved plugin config.
 */
export function registerDavinciTools(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({ name: 'tool:resolve', order: 120, text: RESOLVE_SECTION })

  ctx.tools.register(defineTool({
    name: 'resolve_project_info',
    description:
      'Query the running DaVinci Resolve: version, current project name, all timeline names, and the current timeline\'s track counts and frame range. Requires Resolve running with a project open. Start here before any other resolve tool.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 30_000,
    async execute() {
      return resultText(await ctx.davinci.projectInfo(), projectInfoText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_media_pool',
    description:
      'List a media-pool folder (bin) and its clips with name, source Start TC, duration, FPS, and file path. Use bin paths like "VFX" or "VFX/20260702"; omit to list top-level bins.',
    parameters: {
      bin: { type: 'string', description: 'Bin path like "VFX/20260702"; empty/omitted = root bins' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 30_000,
    async execute(args) {
      return resultText(await ctx.davinci.mediaPool(args.bin ?? ''), mediaPoolText)
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
    timeoutMs: 45_000,
    async execute(args) {
      return resultText(await ctx.davinci.timelineItems(args.trackIndex, args.from, args.to), timelineItemsText)
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
    timeoutMs: 45_000,
    async execute(args) {
      return resultText(await ctx.davinci.findByTc(args.tc), findByTcText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_find_clip',
    description:
      'Search EVERY timeline and EVERY video track for items whose name contains a given substring, in one call. Prefer this over paging resolve_timeline_items when hunting a clip by name (e.g. locating a stray deliverable). Read-only.',
    parameters: {
      name: { type: 'string', required: true, description: 'Case-sensitive substring, e.g. "6585" or "ZY_EP04"' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 45_000,
    async execute(args) {
      return resultText(await ctx.davinci.findClip(args.name), findClipText)
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
    timeoutMs: 30_000,
    async execute(args) {
      return resultText(await ctx.davinci.seek(args.frame, args.tc), seekText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_screenshot',
    description:
      'Capture the screen to a PNG inside the workspace and return its path; read it with the read_image tool to see the DaVinci Resolve UI, including the viewer showing the frame at the current playhead (seek first with resolve_seek). Requires a model route that accepts image input.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 15_000,
    async execute() {
      return captureScreenshot(config.screenshotDir ?? '.resolve-agent')
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
    timeoutMs: 30_000,
    async execute(args) {
      if (args.index === undefined && args.name === undefined) {
        throw new Error('resolve_switch_timeline needs an index or a timeline name — list the project\'s timelines with resolve_project_info first')
      }
      return resultText(await ctx.davinci.switchTimeline(args.index, args.name), switchTimelineText)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_place_clip',
    description:
      'Place a media-pool clip onto the current timeline at a record frame with overwrite semantics (the VFX paste convention: V2 track, start frame aligned with the target V1 segment). Approval-gated: the approval prompt is how the user consents — do not ask in chat first.',
    parameters: {
      bin: { type: 'string', required: true, description: 'Bin path of the clip, e.g. "VFX/20260702"' },
      clipName: { type: 'string', required: true, description: 'Exact clip name in the bin' },
      trackIndex: { type: 'number', required: true, description: '1-based video track index (V2=2)' },
      recordFrame: { type: 'number', required: true, description: 'Timeline record frame to place at' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: 45_000,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        exec,
        reason: `place clip "${args.clipName}" from bin ${args.bin} at record frame ${args.recordFrame} on video track ${args.trackIndex} (overwrite)`,
      })
      return resultText(
        await ctx.davinci.place({ bin: args.bin, clipName: args.clipName, trackIndex: args.trackIndex, recordFrame: args.recordFrame }),
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
    timeoutMs: 45_000,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
        exec,
        reason: `delete the item starting at record frame ${args.startFrame} on video track ${args.trackIndex}`,
      })
      return resultText(await ctx.davinci.remove({ trackIndex: args.trackIndex, startFrame: args.startFrame }), mutationText)
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
    timeoutMs: 30_000,
    async execute(args, exec) {
      await requireWriteApproval({
        approval: ctx.get('approval'),
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
        }),
        mutationText,
      )
    },
  }))
}
