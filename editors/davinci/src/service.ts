/**
 * Service Definition for the `ctx.davinci` capability: the abstract
 * `DavinciService` owning the `ctx.davinci` key, the explicit
 * `resolve(request)` defaulting step, and the concrete typed operations every
 * provider must honor. Providers subclass this class and implement script
 * evaluation; consumers call the domain methods and never a raw script hook.
 * @module @deepseek-ai/dsh-davinci/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  addMarkerLua,
  addRenderJobLua,
  audioTimelineItemsLua,
  deleteItemLua,
  findByTcLua,
  findClipLua,
  mediaPoolLua,
  placeLua,
  projectInfoLua,
  renderStatusLua,
  seekLua,
  startRenderingLua,
  stopRenderingLua,
  switchTimelineLua,
  timelineItemsLua,
} from './lua.ts'
import {
  addRenderJobFrom,
  audioTimelineItemsFrom,
  findByTcFrom,
  findClipFrom,
  mediaPoolFrom,
  mutationFrom,
  parseOutput,
  projectInfoFrom,
  renderingControlFrom,
  renderStatusFrom,
  seekFrom,
  switchTimelineFrom,
  timelineItemsFrom,
} from './protocol.ts'
import type {
  DavinciAddRenderJobRequest,
  DavinciAudioTimelineItemsInfo,
  DavinciCallRequest,
  DavinciDeleteRequest,
  DavinciFindClipInfo,
  DavinciFindByTcInfo,
  DavinciMarkerRequest,
  DavinciMediaPoolInfo,
  DavinciMutationInfo,
  DavinciPlaceRequest,
  DavinciProjectInfo,
  DavinciRenderingControlRequest,
  DavinciRenderJobInfo,
  DavinciRenderStatusInfo,
  DavinciResult,
  DavinciSeekInfo,
  DavinciSpec,
  DavinciTimelineItemsInfo,
  DavinciTimelineSwitchInfo,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    davinci: DavinciService
  }
}

/**
 * Abstract DaVinci Resolve control service. Subclass, implement the abstract
 * members, and load the subclass as a plugin — it registers as `ctx.davinci`
 * (one implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Semantics every provider must honor:
 * - Every operation resolves with a {@link DavinciResult}; only infrastructure
 *   the provider cannot classify surfaces through it as coded failures.
 * - {@link resolve} is the only place defaults and caps are applied; bodies
 *   receive a fully-resolved spec and never re-default.
 */
export abstract class DavinciService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'davinci')
  }

  /**
   * Apply implementation-owned defaults and caps to a call envelope.
   * @param request - the caller's envelope; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-resolved spec handed to script evaluation.
   */
  abstract resolve(request: DavinciCallRequest): DavinciSpec

  /**
   * Evaluate one Lua body (already prefixed with the shared prelude) against
   * the live Resolve.
   * @param body - operation body source.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @param signal - cooperative cancellation for the spawned host process.
   * @returns banner-stripped stdout.
   */
  protected abstract evalScript(body: string, spec: DavinciSpec, signal: AbortSignal | undefined): Promise<string>

  private async run<T>(
    body: string,
    request: DavinciCallRequest,
    project: (fields: ReadonlyMap<string, string>) => DavinciResult<T>,
  ): Promise<DavinciResult<T>> {
    let raw: string
    try {
      raw = await this.evalScript(body, this.resolve(request), request.signal)
    } catch (error) {
      const failure = classifySpawnError(error)
      return { ok: false, code: failure.code, message: failure.message }
    }
    const parsed = parseOutput(raw)
    if (parsed.status === 'error') {
      return { ok: false, code: parsed.code, message: parsed.message }
    }
    return project(parsed.fields)
  }

  /**
   * Read project facts and every timeline name.
   * @param request - call envelope.
   * @returns the typed project facts or a coded failure.
   */
  async projectInfo(request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciProjectInfo>> {
    return this.run(projectInfoLua(), request, (fields) => ({ ok: true, data: projectInfoFrom(fields) }))
  }

  /**
   * List one media-pool bin's subfolders and clips.
   * @param bin - bin path like `VFX/20260702`; empty string lists the root.
   * @param request - call envelope.
   * @returns the bin's contents or a coded failure.
   */
  async mediaPool(bin: string, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMediaPoolInfo>> {
    return this.run(mediaPoolLua(bin), request, (fields) => ({ ok: true, data: mediaPoolFrom(fields) }))
  }

  /**
   * List one video track's items, optionally windowed by record frames.
   * @param trackIndex - 1-based video track index (V1=1, V2=2).
   * @param from - record-frame lower bound, if any.
   * @param to - record-frame upper bound, if any.
   * @param request - call envelope.
   * @returns windowed items plus total/shown counts, or a coded failure.
   */
  async timelineItems(
    trackIndex: number,
    from: number | undefined,
    to: number | undefined,
    request: DavinciCallRequest = {},
  ): Promise<DavinciResult<DavinciTimelineItemsInfo>> {
    return this.run(timelineItemsLua(trackIndex, from, to), request, (fields) => ({
      ok: true,
      data: timelineItemsFrom(fields),
    }))
  }

  /**
   * Scan V1 for segments whose source-clip timecode range covers a target TC.
   * @param tc - source timecode `HH:MM:SS:FF`.
   * @param request - call envelope.
   * @returns scan facts and covering segments, or a coded failure.
   */
  async findByTc(tc: string, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciFindByTcInfo>> {
    return this.run(findByTcLua(tc), request, (fields) => ({ ok: true, data: findByTcFrom(fields) }))
  }

  /**
   * Search every timeline's every video track for items whose name contains a
   * needle; the one-call replacement for paged `timelineItems` scans.
   * @param name - case-sensitive substring to match.
   * @param request - call envelope.
   * @returns scan count and matching placements, or a coded failure.
   */
  async findClip(name: string, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciFindClipInfo>> {
    return this.run(findClipLua(name), request, (fields) => ({ ok: true, data: findClipFrom(fields) }))
  }

  /**
   * Move the current timeline playhead.
   * @param frame - record frame to seek to.
   * @param tc - timecode to seek to; wins over `frame` when both are given.
   * @param request - call envelope.
   * @returns the move outcome or a coded failure.
   */
  async seek(frame: number | undefined, tc: string | undefined, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciSeekInfo>> {
    return this.run(seekLua(frame, tc), request, seekFrom)
  }

  /**
   * Switch the project's current timeline; timeline-dependent reads and
   * writes from then on operate on the newly current timeline.
   * @param index - 1-based timeline index, if any.
   * @param name - exact timeline name; consulted when `index` is omitted.
   * @param request - call envelope.
   * @returns the switch outcome or a coded failure.
   */
  async switchTimeline(
    index: number | undefined,
    name: string | undefined,
    request: DavinciCallRequest = {},
  ): Promise<DavinciResult<DavinciTimelineSwitchInfo>> {
    return this.run(switchTimelineLua(index, name), request, switchTimelineFrom)
  }

  /**
   * Place a bin clip onto the current timeline with overwrite semantics.
   * @param placement - the placement coordinates.
   * @param request - call envelope.
   * @returns the mutation outcome or a coded failure.
   */
  async place(placement: DavinciPlaceRequest, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(placeLua(placement), request, (fields) => mutationFrom(fields, 'AppendToTimeline'))
  }

  /**
   * Delete the video-track item that starts exactly at a record frame.
   * @param target - the deletion coordinates.
   * @param request - call envelope.
   * @returns the mutation outcome or a coded failure.
   */
  async remove(target: DavinciDeleteRequest, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(deleteItemLua(target), request, (fields) => mutationFrom(fields, 'DeleteClips'))
  }

  /**
   * Add a timeline marker at an absolute record frame.
   * @param marker - the marker placement.
   * @param request - call envelope.
   * @returns the mutation outcome or a coded failure.
   */
  async addMarker(marker: DavinciMarkerRequest, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(addMarkerLua(marker), request, (fields) => mutationFrom(fields, 'AddMarker'))
  }

  /**
   * List one audio track's items, optionally windowed by record frames.
   * Mirror of {@link timelineItems} for the audio side (the 套片 audio delivery
   * lands on A1).
   * @param trackIndex - 1-based audio track index (A1=1).
   * @param from - record-frame lower bound, if any.
   * @param to - record-frame upper bound, if any.
   * @param request - call envelope.
   * @returns windowed items plus total/shown counts, or a coded failure.
   */
  async audioTimelineItems(
    trackIndex: number,
    from: number | undefined,
    to: number | undefined,
    request: DavinciCallRequest = {},
  ): Promise<DavinciResult<DavinciAudioTimelineItemsInfo>> {
    return this.run(audioTimelineItemsLua(trackIndex, from, to), request, (fields) => ({
      ok: true,
      data: audioTimelineItemsFrom(fields),
    }))
  }

  /**
   * Read the live render-engine state (queued-job count, is-rendering flag,
   * current format/codec and codec count) without touching the queue.
   * @param request - call envelope.
   * @returns the render-engine facts or a coded failure.
   */
  async renderStatus(request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciRenderStatusInfo>> {
    return this.run(renderStatusLua(), request, (fields) => ({ ok: true, data: renderStatusFrom(fields) }))
  }

  /**
   * Enqueue the current timeline into the render queue at `targetDir`. The
   * current render preset/format/codec are preserved (this Resolve 20.3.2.9
   * build has no presets and an empty format list, so the UI-set active
   * render settings are the only selectable surface).
   * @param placement - the enqueue coordinates.
   * @param request - call envelope.
   * @returns the enqueue outcome plus the enqueued timeline name, or a coded failure.
   */
  async addRenderJob(placement: DavinciAddRenderJobRequest, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciRenderJobInfo>> {
    return this.run(addRenderJobLua(placement), request, addRenderJobFrom)
  }

  /**
   * Start the render engine (optionally scoped to a set of job ids).
   * @param request - the rendering control (job ids or whole queue).
   * @param envelope - call envelope.
   * @returns the control outcome; `null` is reported as a Resolve refusal.
   */
  async startRendering(request: DavinciRenderingControlRequest, envelope: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(startRenderingLua(request), envelope, (fields) => renderingControlFrom(fields, 'StartRendering'))
  }

  /**
   * Stop the render engine (optionally scoped to a set of job ids).
   * @param request - the rendering control (job ids or whole queue).
   * @param envelope - call envelope.
   * @returns the control outcome; `null` is reported as a Resolve refusal.
   */
  async stopRendering(request: DavinciRenderingControlRequest, envelope: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(stopRenderingLua(request), envelope, (fields) => renderingControlFrom(fields, 'StopRendering'))
  }
}

/**
 * Render an unknown thrown value as a short human-readable message.
 * @param error - the thrown value.
 * @returns a non-empty message string.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Classify a thrown evaluation error into the closed spawn-failure codes.
 * `execFile` reports its own timeout kill and caller aborts as killed
 * processes; a missing host binary is `ENOENT`.
 * @param error - the thrown value from script evaluation.
 * @returns the failure code and message the result carries.
 */
export function classifySpawnError(error: unknown): { code: 'timeout' | 'spawn-failed'; message: string } {
  const message = errorMessage(error)
  if (error !== null && typeof error === 'object') {
    const record = error as { killed?: boolean; code?: unknown; name?: unknown }
    if (record.killed === true || record.name === 'AbortError' || record.code === 'ETIMEDOUT') {
      const hint = `${message} (if this persists, DaVinci Resolve may be hung, closing, or showing a dialog — check the app window and retry)`
      return { code: 'timeout', message: hint }
    }
  }
  return { code: 'spawn-failed', message }
}

export default DavinciService
