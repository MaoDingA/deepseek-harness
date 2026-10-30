/**
 * Pure script-output protocol: `run_script` inner-response mapping,
 * `ERROR <code>: <message>` extraction, per-operation `key=value` projections,
 * and timeout clamping/conversion. Everything here is a function of strings
 * and maps, so the contract is unit-testable without a live Resolve.
 * @module @deepseek-ai/dsh-davinci/protocol
 */

import type {
  DavinciAudioItemInfo,
  DavinciAudioTimelineItemsInfo,
  DavinciBinSummary,
  DavinciClipInfo,
  DavinciFindClipHitInfo,
  DavinciFindClipInfo,
  DavinciFindByTcInfo,
  DavinciFailureCode,
  DavinciMediaPoolInfo,
  DavinciMutationInfo,
  DavinciProjectInfo,
  DavinciRenderJobInfo,
  DavinciRenderPresetsInfo,
  DavinciRenderStatusInfo,
  DavinciResult,
  DavinciSeekInfo,
  DavinciTcHitInfo,
  DavinciTimelineItemInfo,
  DavinciTimelineItemsInfo,
  DavinciTimelineSwitchInfo,
} from './types.ts'

const FAILURE_CODES: readonly DavinciFailureCode[] = [
  'resolve-unreachable',
  'no-project',
  'no-timeline',
  'timeline-not-found',
  'bin-not-found',
  'clip-not-found',
  'item-not-found',
  'job-not-found',
  'ambiguous-job',
  'preset-not-found',
  'bad-tc',
  'api-failed',
  'spawn-failed',
  'timeout',
]

/** Widest listing any single read emits before switching to windowed paging. */
export const MAX_LISTED_ITEMS = 200

/** Lower clamp bound for every resolved execution budget. */
export const MIN_TIMEOUT_MS = 1_000

/** `run_script`'s own hard cap on the per-script `timeout` argument, in seconds. */
export const RUN_SCRIPT_MAX_TIMEOUT_SECONDS = 60

/** Parsed script output: either kv fields or a coded failure line. */
export interface ParsedOutput {
  readonly status: 'ok' | 'error'
  readonly code: DavinciFailureCode
  readonly message: string
  readonly fields: ReadonlyMap<string, string>
}

/**
 * Parse captured script output. A line `ERROR <code>: <message>` fails the
 * call with that code (unknown codes collapse to `api-failed`); every other
 * line is collected as `key=value`, splitting at the first `=`.
 * @param raw - the `output` payload of a `run_script` response (captured prints).
 * @returns the parsed output with all kv fields.
 */
export function parseOutput(raw: string): ParsedOutput {
  const lines = raw.split('\n').filter((line) => line !== '')
  const fields = new Map<string, string>()
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1))
  }
  for (const line of lines) {
    if (!line.startsWith('ERROR ')) continue
    const rest = line.slice('ERROR '.length)
    const colon = rest.indexOf(':')
    const rawCode = colon > 0 ? rest.slice(0, colon) : ''
    const message = colon > 0 ? rest.slice(colon + 2) : rest
    const code = FAILURE_CODES.includes(rawCode as DavinciFailureCode)
      ? rawCode as DavinciFailureCode
      : 'api-failed'
    return { status: 'error', code, message, fields }
  }
  return { status: 'ok', code: 'api-failed', message: '', fields }
}

function text(fields: ReadonlyMap<string, string>, key: string): string | undefined {
  const value = fields.get(key)
  if (value === undefined || value === '' || value === 'nil') return undefined
  return value
}

function numeric(fields: ReadonlyMap<string, string>, key: string): number | undefined {
  const value = text(fields, key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Collect `1..count` indexed rows of `key`/`value` string pairs under
 * `${base}_${i}_${key}` field names.
 * @param fields - parsed kv fields.
 * @param base - row field prefix, e.g. `item` or `hit`.
 * @param count - row count read from a `${base}_count`-style total field.
 * @param keys - per-row suffixes to collect.
 * @returns one object per index with only the present suffixes.
 */
function indexedRows(
  fields: ReadonlyMap<string, string>,
  base: string,
  count: number,
  keys: readonly string[],
): Record<string, string | undefined>[] {
  const rows: Record<string, string | undefined>[] = []
  for (let i = 1; i <= count; i += 1) {
    const row: Record<string, string | undefined> = {}
    for (const key of keys) row[key] = text(fields, `${base}_${i}_${key}`)
    rows.push(row)
  }
  return rows
}

/**
 * Project project-info fields.
 * @param fields - parsed kv fields from the project-info body.
 * @returns the typed project facts.
 */
export function projectInfoFrom(fields: ReadonlyMap<string, string>): DavinciProjectInfo {
  const timelineCount = numeric(fields, 'timeline_count') ?? 0
  const timelines: string[] = []
  for (let i = 1; i <= timelineCount; i += 1) {
    const name = text(fields, `timeline_${i}`)
    if (name !== undefined) timelines.push(name)
  }
  return {
    resolveVersion: text(fields, 'resolve_version') ?? '',
    projectName: text(fields, 'project_name') ?? '',
    timelines,
    currentTimeline: text(fields, 'current_timeline'),
    currentStartFrame: numeric(fields, 'current_start'),
    currentEndFrame: numeric(fields, 'current_end'),
    videoTracks: numeric(fields, 'video_tracks'),
    audioTracks: numeric(fields, 'audio_tracks'),
  }
}

/**
 * Project media-pool fields.
 * @param fields - parsed kv fields from the media-pool body.
 * @returns the bins and clips of the listed folder.
 */
export function mediaPoolFrom(fields: ReadonlyMap<string, string>): DavinciMediaPoolInfo {
  const binCount = numeric(fields, 'bin_count') ?? 0
  const clipCount = numeric(fields, 'clip_count') ?? 0
  const bins: DavinciBinSummary[] = indexedRows(fields, 'bin', binCount, ['name', 'clips'])
    .map((row, i) => ({ name: row.name ?? `bin ${i + 1}`, clipCount: Number(row.clips ?? 0) }))
  const clips: DavinciClipInfo[] = indexedRows(
    fields,
    'clip',
    clipCount,
    ['name', 'tc', 'duration', 'fps', 'path'],
  ).map((row) => ({
    name: row.name ?? '',
    startTc: row.tc,
    duration: row.duration,
    fps: row.fps,
    filePath: row.path,
  }))
  return { bins, clips }
}

/**
 * Project audio-timeline-item fields (mirror of the video-track rows).
 * @param fields - parsed kv fields from the audio-track-listing body.
 * @returns windowed items plus total/shown counts.
 */
export function audioTimelineItemsFrom(fields: ReadonlyMap<string, string>): DavinciAudioTimelineItemsInfo {
  const total = numeric(fields, 'total') ?? 0
  const shown = numeric(fields, 'shown') ?? 0
  const listed = Math.min(shown, MAX_LISTED_ITEMS)
  const items: DavinciAudioItemInfo[] = indexedRows(
    fields,
    'item',
    listed,
    ['name', 'start', 'end', 'srctc'],
  ).map((row) => ({
    name: row.name ?? '',
    startFrame: Number(row.start ?? 0),
    endFrame: Number(row.end ?? 0),
    sourceTc: row.srctc,
  }))
  return { total, shown, items }
}

/**
 * Project render-status fields: the live render-engine state. On Resolve 21+
 * the body also reports `preset_count` and `format_count`; on Resolve 20.x
 * those keys are absent (or zero) and the corresponding fields stay undefined.
 * A `read-failed` marker on any render-engine field (the Python body emits one
 * when its pcall-protected host call errored) fails the whole projection: a
 * failed read must not masquerade as an empty queue or `is_rendering=false`.
 * @param fields - parsed kv fields from the render-status body.
 * @returns a failure result when any render-engine read failed; otherwise the
 *   job count, the active rendering flag, the active (format, codec) pair, the
 *   format's codec list size, and — when the host exposes them — the preset
 *   and format list sizes.
 */
export function renderStatusFrom(fields: ReadonlyMap<string, string>): DavinciResult<DavinciRenderStatusInfo> {
  const failedReads = ['job_count', 'is_rendering', 'cur_format', 'cur_codec_count']
    .filter((key) => fields.get(key) === 'read-failed')
  if (failedReads.length > 0) {
    return {
      ok: false,
      code: 'api-failed',
      message: `render-status read failed (${failedReads.join(', ')}): the scripting bridge could not `
        + 'read the render engine — the Resolve script listener may be wedged (a Resolve restart '
        + 'restores it). Refusing to report queue state from a failed read.',
    }
  }
  return {
    ok: true,
    data: {
      jobCount: numeric(fields, 'job_count') ?? 0,
      isRendering: fields.get('is_rendering') === 'true',
      currentFormat: text(fields, 'cur_format'),
      currentCodec: text(fields, 'cur_codec'),
      codecCount: numeric(fields, 'cur_codec_count'),
      presetCount: numeric(fields, 'preset_count'),
      formatCount: numeric(fields, 'format_count'),
    },
  }
}

/**
 * Project render-preset fields: the active (format, codec) pair plus the
 * host's preset list (Resolve 21+ surface).
 *
 * `presets` is filled from `preset_<i>=<name>` rows (1-based `i`) in
 * host-reported order; an absent or zero `preset_count` means the host lacks
 * the API (Resolve 20.x) and the array stays empty.
 * @param fields - parsed kv fields from the render-presets body.
 * @returns the typed preset list with the active (format, codec) pair.
 */
export function renderPresetsFrom(fields: ReadonlyMap<string, string>): DavinciRenderPresetsInfo {
  const currentFormat = text(fields, 'current_format') ?? ''
  const currentCodec = text(fields, 'current_codec') ?? ''
  const presetCount = numeric(fields, 'preset_count') ?? 0
  const presets: string[] = []
  for (let i = 1; i <= presetCount; i += 1) {
    const name = fields.get(`preset_${i}`)
    if (name !== undefined) presets.push(name)
  }
  return {
    currentFormat,
    currentCodec,
    presetCount,
    presets,
    hasLoadPreset: fields.get('has_load_preset') === 'true',
  }
}

/**
 * Project add-render-job fields: the queue outcome and how the new job's id
 * was established. `id_source=read-back` means the host returned no usable id
 * and the id came from a queue read-back that showed exactly one new row —
 * the tool output marks that id 读回确认; multi-candidate and unattributable
 * outcomes never reach here (the body refuses with `ambiguous-job` /
 * `api-failed` instead).
 * @param fields - parsed kv fields from the add-render-job body.
 * @returns the enqueue outcome plus the id and its source.
 */
export function addRenderJobFrom(fields: ReadonlyMap<string, string>): DavinciResult<DavinciRenderJobInfo> {
  const ok = fields.get('ok') === 'true'
  if (!ok) {
    return { ok: false, code: 'api-failed', message: `Resolve returned false for AddRenderJob; nothing was queued` }
  }
  return {
    ok: true,
    data: {
      jobCount: numeric(fields, 'job_count') ?? 1,
      firstJobName: text(fields, 'first_job_name'),
      jobId: text(fields, 'job_id'),
      idSource: fields.get('id_source') === 'read-back' ? 'read-back' : 'returned',
    },
  }
}

/**
 * Project load-render-preset fields: the success flag and the read-back
 * preset name.
 * @param fields - parsed kv fields from the load-render-preset body.
 * @returns the mutation outcome and the active preset name after the call.
 */
export function loadRenderPresetFrom(fields: ReadonlyMap<string, string>): DavinciResult<DavinciMutationInfo & { readonly loadedPreset: string }> {
  const done = fields.get('done') === 'true'
  if (!done) {
    return { ok: false, code: 'api-failed', message: 'Resolve did not confirm the preset load' }
  }
  return { ok: true, data: { done, loadedPreset: text(fields, 'loaded_preset') ?? '' } }
}

/**
 * Project delete-render-job fields: the success flag, the deleted job id, and
 * the post-delete queue depth. The body prints `done=true` only after its
 * read-back confirmed the id left the queue, so a truthy `done` here is a
 * confirmed deletion, never a host promise taken on faith.
 * @param fields - parsed kv fields from the delete-render-job body.
 * @returns the mutation outcome plus the job id and queue depth.
 */
export function deleteRenderJobFrom(fields: ReadonlyMap<string, string>): DavinciResult<DavinciMutationInfo & { readonly jobId: string; readonly jobCountAfter: number }> {
  const done = fields.get('done') === 'true'
  if (!done) {
    return { ok: false, code: 'api-failed', message: 'Resolve did not confirm the job deletion' }
  }
  return {
    ok: true,
    data: {
      done,
      jobId: text(fields, 'job_id') ?? '',
      jobCountAfter: numeric(fields, 'job_count_after') ?? 0,
    },
  }
}

/**
 * Project rendering-control (start/stop) fields: the live engine flag after the call.
 * @param fields - parsed kv fields from the start/stop-rendering body.
 * @param op - operation name for the refusal message (`StartRendering` or `StopRendering`).
 * @returns the control outcome; a Resolve refusal is an `api-failed` failure.
 */
export function renderingControlFrom(fields: ReadonlyMap<string, string>, op: string): DavinciResult<DavinciMutationInfo> {
  const done = fields.get('done') === 'true'
  if (!done) {
    return { ok: false, code: 'api-failed', message: `Resolve returned false for ${op}; rendering state is unchanged` }
  }
  return { ok: true, data: { done } }
}

/**
 * Project timeline-item fields.
 * @param fields - parsed kv fields from the track-listing body.
 * @returns windowed items plus total/shown counts.
 */
export function timelineItemsFrom(fields: ReadonlyMap<string, string>): DavinciTimelineItemsInfo {
  const total = numeric(fields, 'total') ?? 0
  const shown = numeric(fields, 'shown') ?? 0
  const listed = Math.min(shown, MAX_LISTED_ITEMS)
  const items: DavinciTimelineItemInfo[] = indexedRows(
    fields,
    'item',
    listed,
    ['name', 'start', 'end', 'srctc'],
  ).map((row) => ({
    name: row.name ?? '',
    startFrame: Number(row.start ?? 0),
    endFrame: Number(row.end ?? 0),
    sourceTc: row.srctc,
  }))
  return { total, shown, items }
}

/**
 * Project find-by-TC fields.
 * @param fields - parsed kv fields from the TC-scan body.
 * @returns scan facts and the covering V1 segments.
 */
export function findByTcFrom(fields: ReadonlyMap<string, string>): DavinciFindByTcInfo {
  const hits = numeric(fields, 'hits') ?? 0
  const rows: DavinciTcHitInfo[] = indexedRows(
    fields,
    'hit',
    hits,
    ['name', 'start', 'end', 'srctc', 'frames'],
  ).map((row) => ({
    name: row.name ?? '',
    recordStart: Number(row.start ?? 0),
    recordEnd: Number(row.end ?? 0),
    sourceTc: row.srctc,
    frames: Number(row.frames ?? 0),
  }))
  return {
    fps: numeric(fields, 'fps') ?? 0,
    targetFrames: numeric(fields, 'target_frames') ?? 0,
    scanned: numeric(fields, 'scanned') ?? 0,
    hits: rows,
  }
}

/**
 * Project find-clip fields.
 * @param fields - parsed kv fields from the name-search body.
 * @returns scan count and the matching placements.
 */
export function findClipFrom(fields: ReadonlyMap<string, string>): DavinciFindClipInfo {
  const hits = numeric(fields, 'hits') ?? 0
  const rows: DavinciFindClipHitInfo[] = indexedRows(
    fields,
    'hit',
    hits,
    ['timeline', 'track', 'name', 'start', 'end'],
  ).map((row) => ({
    timeline: row.timeline ?? '',
    trackIndex: Number(row.track ?? 0),
    name: row.name ?? '',
    recordStart: Number(row.start ?? 0),
    recordEnd: Number(row.end ?? 0),
  }))
  return { scanned: numeric(fields, 'scanned') ?? 0, hits: rows }
}

/**
 * Project seek fields.
 * @param fields - parsed kv fields from the seek body.
 * @returns the move outcome; a refused move is an `api-failed` failure.
 */
export function seekFrom(fields: ReadonlyMap<string, string>): DavinciResult<DavinciSeekInfo> {
  const ok = fields.get('seek_ok') === 'true'
  const nowAt = text(fields, 'now_at') ?? ''
  if (!ok) {
    return { ok: false, code: 'api-failed', message: `SetCurrentTimecode returned false; playhead now at ${nowAt}` }
  }
  return { ok: true, data: { ok, nowAt } }
}

/**
 * Project current-timeline switch fields.
 * @param fields - parsed kv fields from the switch body.
 * @returns the switch outcome; a Resolve refusal is an `api-failed` failure.
 */
export function switchTimelineFrom(fields: ReadonlyMap<string, string>): DavinciResult<DavinciTimelineSwitchInfo> {
  const switched = fields.get('switched') === 'true'
  if (!switched) {
    return { ok: false, code: 'api-failed', message: 'SetCurrentTimeline returned false; the current timeline is unchanged' }
  }
  return {
    ok: true,
    data: {
      timelineName: text(fields, 'timeline_name') ?? '',
      timelineIndex: numeric(fields, 'timeline_index') ?? 0,
      previousTimelineName: text(fields, 'previous_timeline'),
    },
  }
}

/**
 * Project single-mutation fields (place/delete/marker).
 * @param fields - parsed kv fields from a mutation body.
 * @param op - operation name for the refusal message.
 * @returns the mutation outcome; a Resolve refusal is an `api-failed` failure.
 */
export function mutationFrom(fields: ReadonlyMap<string, string>, op: string): DavinciResult<DavinciMutationInfo> {
  const done = fields.get('done') === 'true'
  if (!done) {
    return { ok: false, code: 'api-failed', message: `Resolve returned false for ${op}; nothing was changed` }
  }
  return { ok: true, data: { done } }
}

/**
 * Clamp a requested execution budget between the floor and the provider cap.
 * @param requested - caller-requested budget, if any.
 * @param defaultMs - budget used when the caller omitted one.
 * @param maxMs - provider cap.
 * @returns the clamped budget.
 */
export function clampTimeout(requested: number | undefined, defaultMs: number, maxMs: number): number {
  const value = requested ?? defaultMs
  return Math.min(Math.max(value, MIN_TIMEOUT_MS), Math.max(maxMs, MIN_TIMEOUT_MS))
}

/**
 * Convert a clamped millisecond budget to the integer `timeout` seconds the
 * `run_script` schema accepts: ceil so a partial second is never truncated
 * away from the script, then clamped into the tool's 1..60 range.
 * @param timeoutMs - clamped execution budget in milliseconds.
 * @returns whole seconds for the `run_script` `timeout` argument.
 */
export function scriptTimeoutSeconds(timeoutMs: number): number {
  return Math.min(Math.max(Math.ceil(timeoutMs / 1000), 1), RUN_SCRIPT_MAX_TIMEOUT_SECONDS)
}

/**
 * Map the inner JSON text of a `run_script`/`run_script_unsafe` response to
 * the raw kv output {@link parseOutput} consumes. `{"output": ...}` passes the
 * captured prints through; an `error` payload becomes a synthesized
 * `ERROR <code>: <message>` line — script timeouts keep the sandbox's verbatim
 * text under the `timeout` code, every other script failure (traceback or
 * SyntaxError) reports the exception's last line under `api-failed`.
 * @param tool - tool name for the fail-loud non-JSON message.
 * @param text - `content[0].text` of the MCP tool response.
 * @returns raw kv lines for {@link parseOutput}.
 * @throws when the text is not the inner JSON envelope (the wrapper's
 *   `isError` path or a protocol drift); the caller classifies it as a
 *   transport failure.
 */
export function innerResponseToRaw(tool: string, text: string): string {
  let inner: unknown
  try {
    inner = JSON.parse(text)
  } catch {
    throw new Error(`davinci MCP ${tool} response was not inner JSON: ${text.slice(0, 200)}`)
  }
  const error = (inner as { error?: unknown }).error
  if (typeof error === 'string') {
    if (error.startsWith('Script timed out')) return `ERROR timeout: ${error}`
    return `ERROR api-failed: ${lastExceptionLine(error)}`
  }
  const output = (inner as { output?: unknown }).output
  return typeof output === 'string' ? output : ''
}

/**
 * Keep only the final non-empty line of a Python failure report: the
 * `Error: ...`/`SyntaxError: ...` sentence naming the cause.
 * @param trace - the sandbox's full error string.
 * @returns the last non-empty line, or the whole string when every line is blank.
 */
function lastExceptionLine(trace: string): string {
  const lines = trace.split('\n').filter((line) => line.trim() !== '')
  return lines[lines.length - 1] ?? trace
}
