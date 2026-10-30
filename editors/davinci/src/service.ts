/**
 * Service Definition for the `ctx.davinci` capability: the abstract
 * `DavinciService` owning the `ctx.davinci` key, the explicit
 * `resolve(request)` defaulting step, and the concrete typed operations every
 * provider must honor. Providers subclass this class and implement script
 * evaluation; consumers call the domain methods and never a raw script hook.
 * @module @deepseek-ai/dsh-davinci/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve as resolvePath } from 'node:path'
import {
  addMarkerPython,
  addRenderJobPython,
  audioTimelineItemsPython,
  deleteItemPython,
  deleteRenderJobPython,
  findByTcPython,
  findClipPython,
  loadRenderPresetPython,
  mediaPoolPython,
  placePython,
  projectInfoPython,
  pythonScriptOf,
  renderPresetsPython,
  renderStatusPython,
  screenshotPython,
  seekPython,
  startRenderingPython,
  stopRenderingPython,
  switchTimelinePython,
  timelineItemsPython,
} from './python.ts'
import {
  addRenderJobFrom,
  audioTimelineItemsFrom,
  deleteRenderJobFrom,
  findByTcFrom,
  findClipFrom,
  loadRenderPresetFrom,
  mediaPoolFrom,
  mutationFrom,
  parseOutput,
  projectInfoFrom,
  renderingControlFrom,
  renderPresetsFrom,
  renderStatusFrom,
  seekFrom,
  switchTimelineFrom,
  timelineItemsFrom,
} from './protocol.ts'
import type {
  DavinciAddRenderJobRequest,
  DavinciAudioTimelineItemsInfo,
  DavinciCallRequest,
  DavinciDeleteRenderJobRequest,
  DavinciDeleteRequest,
  DavinciFindClipInfo,
  DavinciFindByTcInfo,
  DavinciLoadRenderPresetRequest,
  DavinciMarkerRequest,
  DavinciMediaPoolInfo,
  DavinciMutationInfo,
  DavinciPlaceRequest,
  DavinciProjectInfo,
  DavinciRenderingControlRequest,
  DavinciRenderJobInfo,
  DavinciRenderPresetsInfo,
  DavinciRenderStatusInfo,
  DavinciResult,
  DavinciScreenshotRequest,
  DavinciScriptTool,
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
   * Evaluate one complete Python script (the shared prelude plus an operation
   * body for `run_script`, or a standalone body for `run_script_unsafe`)
   * against the live Resolve through the provider's transport.
   * @param script - complete Python script source.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @param signal - cooperative cancellation for the spawned server process.
   * @param tool - script tool to route through: the sandboxed `run_script` or
   *   the OS-capable `run_script_unsafe`.
   * @returns the script's captured `key=value` output, with inner script
   *   failures already mapped to `ERROR <code>: <message>` lines.
   */
  protected abstract evalScript(
    script: string,
    spec: DavinciSpec,
    signal: AbortSignal | undefined,
    tool: DavinciScriptTool,
  ): Promise<string>

  private async run<T>(
    body: string,
    request: DavinciCallRequest,
    project: (fields: ReadonlyMap<string, string>) => DavinciResult<T>,
  ): Promise<DavinciResult<T>> {
    let raw: string
    try {
      raw = await this.evalScript(pythonScriptOf(body), this.resolve(request), request.signal, 'run_script')
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
    return this.run(projectInfoPython(), request, (fields) => ({ ok: true, data: projectInfoFrom(fields) }))
  }

  /**
   * List one media-pool bin's subfolders and clips.
   * @param bin - bin path like `VFX/20260702`; empty string lists the root.
   * @param request - call envelope.
   * @returns the bin's contents or a coded failure.
   */
  async mediaPool(bin: string, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMediaPoolInfo>> {
    return this.run(mediaPoolPython(bin), request, (fields) => ({ ok: true, data: mediaPoolFrom(fields) }))
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
    return this.run(timelineItemsPython(trackIndex, from, to), request, (fields) => ({
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
    return this.run(findByTcPython(tc), request, (fields) => ({ ok: true, data: findByTcFrom(fields) }))
  }

  /**
   * Search every timeline's every video track for items whose name contains a
   * needle; the one-call replacement for paged `timelineItems` scans.
   * @param name - case-sensitive substring to match.
   * @param request - call envelope.
   * @returns scan count and matching placements, or a coded failure.
   */
  async findClip(name: string, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciFindClipInfo>> {
    return this.run(findClipPython(name), request, (fields) => ({ ok: true, data: findClipFrom(fields) }))
  }

  /**
   * Move the current timeline playhead.
   * @param frame - record frame to seek to.
   * @param tc - timecode to seek to; wins over `frame` when both are given.
   * @param request - call envelope.
   * @returns the move outcome or a coded failure.
   */
  async seek(frame: number | undefined, tc: string | undefined, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciSeekInfo>> {
    return this.run(seekPython(frame, tc), request, seekFrom)
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
    return this.run(switchTimelinePython(index, name), request, switchTimelineFrom)
  }

  /**
   * Place a bin clip onto the current timeline with overwrite semantics.
   * @param placement - the placement coordinates.
   * @param request - call envelope.
   * @returns the mutation outcome or a coded failure.
   */
  async place(placement: DavinciPlaceRequest, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(placePython(placement), request, (fields) => mutationFrom(fields, 'AppendToTimeline'))
  }

  /**
   * Delete the video-track item that starts exactly at a record frame.
   * @param target - the deletion coordinates.
   * @param request - call envelope.
   * @returns the mutation outcome or a coded failure.
   */
  async remove(target: DavinciDeleteRequest, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(deleteItemPython(target), request, (fields) => mutationFrom(fields, 'DeleteClips'))
  }

  /**
   * Add a timeline marker at an absolute record frame.
   * @param marker - the marker placement.
   * @param request - call envelope.
   * @returns the mutation outcome or a coded failure.
   */
  async addMarker(marker: DavinciMarkerRequest, request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(addMarkerPython(marker), request, (fields) => mutationFrom(fields, 'AddMarker'))
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
    return this.run(audioTimelineItemsPython(trackIndex, from, to), request, (fields) => ({
      ok: true,
      data: audioTimelineItemsFrom(fields),
    }))
  }

  /**
   * Read the live render-engine state (queued-job count, is-rendering flag,
   * active format/codec pair, and — when the host exposes `GetRenderPresets`
   * and `GetRenderFormats` — the preset and format list sizes) without
   * touching the queue.
   *
   * Resolve 20.x leaves `presetCount` and `formatCount` undefined (the host
   * lacks those methods); Resolve 21.1 reports the UI-set preset list size
   * (e.g. 40) and format list size (e.g. 23 including `mov`).
   * @param request - call envelope.
   * @returns the render-engine facts or a coded failure.
   */
  async renderStatus(request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciRenderStatusInfo>> {
    return this.run(renderStatusPython(), request, renderStatusFrom)
  }

  /**
   * Read the render-engine's active (format, codec) pair and, on Resolve 21+,
   * its full preset list and the `LoadRenderPreset` capability flag.
   *
   * Resolve 20.x lacks the preset API; the result reports
   * `presetCount` of 0, an empty `presets` array, and `hasLoadPreset` of
   * `false`. The current (format, codec) pair is always read when the host
   * exposes `GetCurrentRenderFormatAndCodec`.
   * @param request - call envelope.
   * @returns the preset list and active (format, codec) pair, or a coded failure.
   */
  async renderPresets(request: DavinciCallRequest = {}): Promise<DavinciResult<DavinciRenderPresetsInfo>> {
    return this.run(renderPresetsPython(), request, (fields) => ({ ok: true, data: renderPresetsFrom(fields) }))
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
    return this.run(addRenderJobPython(placement), request, addRenderJobFrom)
  }

  /**
   * Start the render engine (optionally scoped to a set of job ids).
   * @param request - the rendering control (job ids or whole queue).
   * @param envelope - call envelope.
   * @returns the control outcome; `null` is reported as a Resolve refusal.
   */
  async startRendering(request: DavinciRenderingControlRequest, envelope: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(startRenderingPython(request), envelope, (fields) => renderingControlFrom(fields, 'StartRendering'))
  }

  /**
   * Stop the render engine (optionally scoped to a set of job ids).
   * @param request - the rendering control (job ids or whole queue).
   * @param envelope - call envelope.
   * @returns the control outcome; `null` is reported as a Resolve refusal.
   */
  async stopRendering(request: DavinciRenderingControlRequest, envelope: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo>> {
    return this.run(stopRenderingPython(request), envelope, (fields) => renderingControlFrom(fields, 'StopRendering'))
  }

  /**
   * Load a render preset by exact name via `Project:LoadRenderPreset`.
   * @param request - the preset name to load (must match a host-reported entry).
   * @param envelope - call envelope.
   * @returns the mutation outcome and the active preset name after the call.
   */
  async loadRenderPreset(request: DavinciLoadRenderPresetRequest, envelope: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo & { readonly loadedPreset: string }>> {
    return this.run(loadRenderPresetPython(request), envelope, loadRenderPresetFrom)
  }

  /**
   * Delete a queued render job by its id via `Project:DeleteRenderJob`.
   * @param request - the job id (UUID) to delete.
   * @param envelope - call envelope.
   * @returns the mutation outcome plus the job id and post-delete queue depth.
   */
  async deleteRenderJob(request: DavinciDeleteRenderJobRequest, envelope: DavinciCallRequest = {}): Promise<DavinciResult<DavinciMutationInfo & { readonly jobId: string; readonly jobCountAfter: number }>> {
    return this.run(deleteRenderJobPython(request), envelope, deleteRenderJobFrom)
  }

  /**
   * Capture the screen to a fresh PNG under the configured screenshot
   * directory, activating Resolve first when asked to. The OS-capability chain
   * (`open`, `lsappinfo`, `screencapture`) runs inside one `run_script_unsafe`
   * exchange; the foreground refusal decision stays here so its message is
   * verbatim. Refuses unless DaVinci Resolve is the frontmost app — the
   * capture otherwise shows whatever covers it.
   * @param request - activation flag and the screenshot directory.
   * @param envelope - call envelope.
   * @returns the absolute path of the written PNG.
   * @throws when Resolve is not frontmost after any activation attempt, or the
   *   unsafe exchange itself failed.
   */
  async screenshot(request: DavinciScreenshotRequest, envelope: DavinciCallRequest = {}): Promise<string> {
    const spec = this.resolve(envelope)
    const dir = resolvePath(request.screenshotDir)
    const pngPath = join(dir, `screen-${randomUUID()}.png`)
    const script = screenshotPython({
      activate: request.activate,
      appPath: request.activate ? resolveAppFromMcp(spec.resolveMcpPath) : undefined,
      dir,
      pngPath,
    })
    const raw = await this.evalScript(script, spec, envelope.signal, 'run_script_unsafe')
    const parsed = parseOutput(raw)
    if (parsed.status === 'error') {
      throw new Error(`screenshot failed: [${parsed.code}] ${parsed.message}`)
    }
    const front = parsed.fields.get('frontmost') ?? ''
    if (front !== RESOLVE_BUNDLE_ID) {
      throw new Error(
        `screenshot skipped: the frontmost app is ${front || 'unknown'}, not DaVinci Resolve — the capture would show the covering window. `
        + 'Ask the user to bring Resolve to the front, or retry with activate: true.',
      )
    }
    const captured = parsed.fields.get('path')
    if (captured === undefined || captured === '') {
      throw new Error('screenshot failed: the capture script reported no file path')
    }
    return captured
  }
}

/** Bundle identifier macOS reports for DaVinci Resolve. */
const RESOLVE_BUNDLE_ID = 'com.blackmagic-design.DaVinciResolve'

/**
 * Derive the `.app` bundle path that ships a given ResolveMCP binary:
 * `<app>/Contents/Applications/ResolveMCP`.
 * @param resolveMcpPath - absolute ResolveMCP path.
 * @returns the absolute `.app` path.
 */
function resolveAppFromMcp(resolveMcpPath: string): string {
  return dirname(dirname(dirname(resolveMcpPath)))
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
 * Classify a thrown evaluation error into the closed transport-failure codes.
 * The provider marks its wall-clock kills with `killed` and caller aborts with
 * an `AbortError` name; a missing or crashing server is everything else.
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
