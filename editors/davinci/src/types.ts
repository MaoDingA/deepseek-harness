/**
 * Vocabulary of the `ctx.davinci` capability: the call envelope, the resolved
 * spec, per-operation results, and the closed failure taxonomy. Types only —
 * runtime lives in the sibling modules.
 * @module @deepseek-ai/dsh-davinci/types
 */

/**
 * Caller-side call envelope. Every field is optional; the provider's
 * {@link DavinciService.resolve} step fills defaults and clamps.
 */
export interface DavinciCallRequest {
  /** Requested execution budget in milliseconds; clamped by provider config. */
  readonly timeoutMs?: number
  /** Cooperative cancellation forwarded to the spawned fuscript process. */
  readonly signal?: AbortSignal
}

/** Fully-resolved execution spec produced by the provider's resolve step. */
export interface DavinciSpec {
  /** Absolute path of the Resolve `fuscript` host to spawn. */
  readonly fuscriptPath: string
  /** Execution budget in milliseconds after clamping. */
  readonly timeoutMs: number
}

/**
 * Closed failure taxonomy shared by every operation result. Codes come from
 * the Lua prelude and operation bodies (`ERROR <code>: <message>` lines) plus
 * the provider's spawn/timeout mapping.
 */
export type DavinciFailureCode =
  | 'resolve-unreachable'
  | 'no-project'
  | 'no-timeline'
  | 'timeline-not-found'
  | 'bin-not-found'
  | 'clip-not-found'
  | 'item-not-found'
  | 'job-not-found'
  | 'preset-not-found'
  | 'bad-tc'
  | 'api-failed'
  | 'spawn-failed'
  | 'timeout'

/** Every operation resolves with a typed success payload or a typed failure. */
export type DavinciResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: DavinciFailureCode; readonly message: string }

/** Project-level facts: version, name, timelines, current timeline shape. */
export interface DavinciProjectInfo {
  readonly resolveVersion: string
  readonly projectName: string
  readonly timelines: readonly string[]
  readonly currentTimeline: string | undefined
  readonly currentStartFrame: number | undefined
  readonly currentEndFrame: number | undefined
  readonly videoTracks: number | undefined
  readonly audioTracks: number | undefined
}

/** One media-pool bin listing row. */
export interface DavinciBinSummary {
  readonly name: string
  readonly clipCount: number
}

/** One media-pool clip row with the properties editing decisions need. */
export interface DavinciClipInfo {
  readonly name: string
  readonly startTc: string | undefined
  readonly duration: string | undefined
  readonly fps: string | undefined
  readonly filePath: string | undefined
}

/** Contents of one media-pool folder (bin). */
export interface DavinciMediaPoolInfo {
  readonly bins: readonly DavinciBinSummary[]
  readonly clips: readonly DavinciClipInfo[]
}

/** One timeline segment on a video track, in record-frame coordinates. */
export interface DavinciTimelineItemInfo {
  readonly name: string
  readonly startFrame: number
  readonly endFrame: number
  readonly sourceTc: string | undefined
}

/** A paged track listing: windowed rows plus full-window counts. */
export interface DavinciTimelineItemsInfo {
  readonly total: number
  readonly shown: number
  readonly items: readonly DavinciTimelineItemInfo[]
}

/** One V1 segment whose source-clip timecode range covers the target TC. */
export interface DavinciTcHitInfo {
  readonly name: string
  readonly recordStart: number
  readonly recordEnd: number
  readonly sourceTc: string | undefined
  readonly frames: number
}

/** Result of a whole-track source-TC scan. */
export interface DavinciFindByTcInfo {
  readonly fps: number
  readonly targetFrames: number
  readonly scanned: number
  readonly hits: readonly DavinciTcHitInfo[]
}

/** One placed item whose name contains the search needle. */
export interface DavinciFindClipHitInfo {
  readonly timeline: string
  readonly trackIndex: number
  readonly name: string
  readonly recordStart: number
  readonly recordEnd: number
}

/** Result of a project-wide clip-name search across every timeline and video track. */
export interface DavinciFindClipInfo {
  readonly scanned: number
  readonly hits: readonly DavinciFindClipHitInfo[]
}

/** Playhead move outcome. */
export interface DavinciSeekInfo {
  readonly ok: boolean
  readonly nowAt: string
}

/** Current-timeline switch outcome: what is current now, and what came before. */
export interface DavinciTimelineSwitchInfo {
  /** The timeline that is current after the call. */
  readonly timelineName: string
  /** Its 1-based index in the project, as resolve_project_info numbers it. */
  readonly timelineIndex: number
  /** The timeline name that was current before the call, if any. */
  readonly previousTimelineName: string | undefined
}

/** Generic single-mutation outcome used by place/delete/marker writes. */
export interface DavinciMutationInfo {
  readonly done: boolean
}

/** Placement request: bin clip onto a video track at a record frame. */
export interface DavinciPlaceRequest {
  readonly bin: string
  readonly clipName: string
  readonly trackIndex: number
  readonly recordFrame: number
}

/** Deletion request: the video-track item that starts exactly at a frame. */
export interface DavinciDeleteRequest {
  readonly trackIndex: number
  readonly startFrame: number
}

/** One timeline audio-track item, in record-frame coordinates (mirror of the video-track row). */
export interface DavinciAudioItemInfo {
  readonly name: string
  readonly startFrame: number
  readonly endFrame: number
  readonly sourceTc: string | undefined
}

/** A paged audio-track listing: windowed rows plus full-window counts. */
export interface DavinciAudioTimelineItemsInfo {
  readonly total: number
  readonly shown: number
  readonly items: readonly DavinciAudioItemInfo[]
}

/**
 * Render-engine facts: the queued-job count, the live render flag, the active
 * format/codec pair, and the host's preset/format surface.
 *
 * Resolve 20.x (e.g. 20.3.2.9) reports zero for `presetCount` and zero for
 * `formatCount` and leaves `currentFormat`/`currentCodec` undefined; the
 * live render settings are the only selectable surface. Resolve 21.1
 * reports the UI-set preset list (e.g. 40 entries) and format list (e.g.
 * 23 entries including `mov`); see `davinci-resolve-21` skill and the
 * project's 21.1.10 live probe for the exact surface.
 */
export interface DavinciRenderStatusInfo {
  readonly jobCount: number
  readonly isRendering: boolean
  readonly currentFormat: string | undefined
  readonly currentCodec: string | undefined
  readonly codecCount: number | undefined
  /** Number of render presets the host exposes; 0 on Resolve 20.x. */
  readonly presetCount: number | undefined
  /** Number of render formats the host exposes; 0 on Resolve 20.x. */
  readonly formatCount: number | undefined
}

/**
 * Live render preset list (Resolve 21+ surface). Resolve 20.x reports
 * `presetCount` of 0 and an empty `presets` array; the current (format,
 * codec) pair is still reported when the host exposes the query.
 */
export interface DavinciRenderPresetsInfo {
  /** Currently selected render format, or '' when the host lacks the query. */
  readonly currentFormat: string
  /** Currently selected codec, or '' when the host lacks the query. */
  readonly currentCodec: string
  /** Number of presets in the list (0 on Resolve 20.x). */
  readonly presetCount: number
  /** Preset names in host-reported order; empty when the host lacks the API. */
  readonly presets: readonly string[]
  /** Whether `Project:LoadRenderPreset` is callable (Resolve 21+ surface). */
  readonly hasLoadPreset: boolean
}

/**
 * Queued render job, as read from Resolve after enqueue.
 *
 * Resolve 21.1 reports the new job's id in `jobId` (a UUID string read from
 * the `JobId` table field of the newest `GetRenderJobList()` row) and its
 * queue name in `firstJobName`. On 20.x both are reported as-is — `jobId`
 * is the `JobId` field of the newest row when the host exposes the table
 * shape, otherwise `firstJobName`. `jobCount` is the post-enqueue queue
 * depth.
 */
export interface DavinciRenderJobInfo {
  readonly jobCount: number
  readonly firstJobName: string | undefined
  readonly jobId: string | undefined
}

/** Add-render-job request: enqueue the current timeline into the render queue. */
export interface DavinciAddRenderJobRequest {
  readonly targetDir: string
}

/** Request to start or stop background rendering. */
export interface DavinciRenderingControlRequest {
  readonly jobIds: readonly string[] | undefined
}

/**
 * Load-render-preset request: select a render preset by exact name.
 *
 * The name must match one of the entries `resolve_render_presets` reported
 * for the running Resolve build. Resolve 20.x builds lack the API and the
 * call returns `api-failed` with a `preset-not-found` refusal.
 */
export interface DavinciLoadRenderPresetRequest {
  readonly presetName: string
}

/**
 * Delete-render-job request: remove a single queued render job by its id.
 *
 * The id must match the `JobId` of a row in `p:GetRenderJobList()`. The
 * host's `DeleteRenderJob` returns false for an unknown id, which is
 * reported as `api-failed`.
 */
export interface DavinciDeleteRenderJobRequest {
  readonly jobId: string
}

/**
 * Marker colors accepted by `Timeline:AddMarker`. Keep in sync with the
 * runtime `DAVINCI_MARKER_COLORS` list in the provider.
 */
export type DavinciMarkerColor =
  | 'Blue' | 'Cyan' | 'Green' | 'Yellow' | 'Red' | 'Pink' | 'Purple' | 'Fuchsia'
  | 'Rose' | 'Lavender' | 'Sky' | 'Mint' | 'Tan' | 'Beige' | 'Brown' | 'Chocolate'

/** Timeline marker request; `frame` is an absolute record frame. */
export interface DavinciMarkerRequest {
  readonly frame: number
  readonly color: DavinciMarkerColor
  readonly name: string
  readonly note: string
  /** Marker duration in frames; undefined means the host default of 1. */
  readonly durationFrames: number | undefined
}
