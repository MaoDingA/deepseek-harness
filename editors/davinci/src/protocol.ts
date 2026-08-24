/**
 * Pure fuscript stdout protocol: banner stripping, `ERROR <code>: <message>`
 * extraction, per-operation `key=value` projections, and timeout clamping.
 * Everything here is a function of strings and maps, so the contract is
 * unit-testable without a live Resolve.
 * @module @deepseek-ai/dsh-davinci/protocol
 */

import type {
  DavinciBinSummary,
  DavinciClipInfo,
  DavinciFindClipHitInfo,
  DavinciFindClipInfo,
  DavinciFindByTcInfo,
  DavinciFailureCode,
  DavinciMediaPoolInfo,
  DavinciMutationInfo,
  DavinciProjectInfo,
  DavinciResult,
  DavinciSeekInfo,
  DavinciTcHitInfo,
  DavinciTimelineItemInfo,
  DavinciTimelineItemsInfo,
  DavinciTimelineSwitchInfo,
} from './types.ts'

const BANNER_LINE_PREFIXES = [
  'DaVinci Resolve Script Interpreter',
  'Copyright (C)',
  'Shell cwd was reset',
] as const

const FAILURE_CODES: readonly DavinciFailureCode[] = [
  'resolve-unreachable',
  'no-project',
  'no-timeline',
  'timeline-not-found',
  'bin-not-found',
  'clip-not-found',
  'item-not-found',
  'bad-tc',
  'api-failed',
  'spawn-failed',
  'timeout',
]

/** Widest listing any single read emits before switching to windowed paging. */
export const MAX_LISTED_ITEMS = 200

/** Lower clamp bound for every resolved execution budget. */
export const MIN_TIMEOUT_MS = 1_000

/**
 * Drop fuscript's banner lines and blank lines from captured stdout.
 * @param stdout - raw fuscript stdout.
 * @returns the remaining lines joined with newlines.
 */
export function stripBanner(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) =>
      line !== '' && !BANNER_LINE_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join('\n')
}

/** Parsed script output: either kv fields or a coded failure line. */
export interface ParsedOutput {
  readonly status: 'ok' | 'error'
  readonly code: DavinciFailureCode
  readonly message: string
  readonly fields: ReadonlyMap<string, string>
}

/**
 * Parse stripped script output. A line `ERROR <code>: <message>` fails the
 * call with that code (unknown codes collapse to `api-failed`); every other
 * line is collected as `key=value`, splitting at the first `=`.
 * @param raw - banner-stripped fuscript stdout.
 * @returns the parsed output with all kv fields.
 */
export function parseOutput(raw: string): ParsedOutput {
  const lines = stripBanner(raw).split('\n').filter((line) => line !== '')
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
