/**
 * Per-project DaVinci conventions and the timeline working-copy policy.
 *
 * Conventions are the project-specific half of the editing contract: frame
 * rate, conform defaults, VFX layup conventions, output targets, and the
 * `_待审` working-copy workflow. They are stored as one JSON document per
 * project under the configured directory, read before an IO workflow, and
 * merged field-by-field when the agent records answers the user gave at
 * project start.
 * @module @deepseek-ai/dsh-davinci/conventions
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAVINCI_MARKER_COLORS, type DavinciMarkerColor } from './markers.ts'

/** How a conform handles source audio; the default IO workflow ignores it. */
export const CONFORM_AUDIO = ['ignore', 'keep'] as const
export type DavinciConformAudio = typeof CONFORM_AUDIO[number]

/** Which timecode anchors a VFX deliverable to its shot. */
export const VFX_ANCHORS = ['record-tc', 'source-tc'] as const
export type DavinciVfxAnchor = typeof VFX_ANCHORS[number]

/** Conform (套片) conventions; every field has a useful default except the WP naming pattern. */
export interface DavinciConformConventions {
  /** Timeline-name pattern identifying the locked workprint reels, e.g. `WP_*`. */
  readonly workprintPattern?: string
  /** 1-based video track the conform lands on. */
  readonly targetTrack: number
  /** Whether source audio is ignored or kept; IO conform ignores it. */
  readonly audio: DavinciConformAudio
  /** Whether one shot may be built from several source time ranges. */
  readonly multiSegment: boolean
  /** How source segments are matched; only source timecode is supported today. */
  readonly sourceMatch: 'source-tc'
  /** Source handles trimmed around each segment, in frames. */
  readonly handles: number
}

/** VFX layup (贴视效) conventions; project-specific, asked once at project start. */
export interface DavinciVfxConventions {
  /** Media-pool bin holding the deliverables. */
  readonly bin?: string
  /** 1-based video track the deliverables land on. */
  readonly targetTrack?: number
  /** Timeline marker color used to flag deliverables. */
  readonly markerColor?: DavinciMarkerColor
  /** Whether placement is anchored on record TC or source TC. */
  readonly anchor?: DavinciVfxAnchor
  /** Handles kept around each deliverable, in frames. */
  readonly handles?: number
  /** Deliverable naming pattern, e.g. `{shot}_{version}`. */
  readonly namePattern?: string
}

/** Output (输出) conventions; project-specific, asked once at project start. */
export interface DavinciOutputConventions {
  /** Render preset name, when the project uses one. */
  readonly preset?: string
  /** Container/format, e.g. `mov`. */
  readonly format?: string
  /** Codec, e.g. `ProRes 422 HQ`. */
  readonly codec?: string
  /** Absolute output directory for this deliverable class. */
  readonly directory?: string
  /** Output file naming pattern. */
  readonly namePattern?: string
}

/** Working-copy and review policy applied to every timeline edit. */
export interface DavinciTimelinePolicy {
  /** Suffix on the duplicated working timeline (`_待审`). */
  readonly workingSuffix: string
  /** Backup suffix pattern appended to the disabled original (`__OLD_YYYYMMDD_HHmm`). */
  readonly backupSuffixFormat: string
  /** Whether the original timeline should be disabled in Resolve after approval. */
  readonly disableOriginal: boolean
  /** Whether the working copy is kept when the review is rejected. */
  readonly keepCopy: boolean
  /** Review language; the agent asks in Chinese. */
  readonly review: 'zh'
}

/** One project's complete conventions document. Missing fields are `undefined`. */
export interface DavinciProjectConventions {
  readonly version: 1
  readonly project: string
  readonly frameRate?: number
  readonly dropFrame?: boolean
  readonly conform: DavinciConformConventions
  readonly vfx: DavinciVfxConventions
  readonly output: DavinciOutputConventions
  readonly timelinePolicy: DavinciTimelinePolicy
  readonly notes: string
}

/** Partial answer set accepted by the save tool; absent fields stay unchanged. */
export interface DavinciProjectConventionsPatch {
  readonly frameRate?: number
  readonly dropFrame?: boolean
  readonly conform?: Partial<DavinciConformConventions>
  readonly vfx?: DavinciVfxConventions
  readonly output?: DavinciOutputConventions
  readonly timelinePolicy?: Partial<DavinciTimelinePolicy>
  readonly notes?: string
}

/** One missing convention field plus the Chinese question that resolves it. */
export interface DavinciConventionsQuestion {
  readonly field: string
  readonly question: string
}

/** Read result: the merged document, the fields still missing, and the questions. */
export interface DavinciProjectConventionsInfo {
  readonly project: string
  readonly path: string
  readonly conventions: DavinciProjectConventions
  readonly missing: readonly string[]
  readonly questions: readonly DavinciConventionsQuestion[]
}

/** Questions for every project-specific field, in the order the agent should ask. */
export const CONVENTION_QUESTIONS: Readonly<Record<string, string>> = {
  frameRate: '这个项目的帧率是多少（例如 24、25、23.976）？',
  dropFrame: '这个项目使用丢帧时间码吗（29.97/59.97 常见）？',
  'conform.workprintPattern': '套片用的 WP/工作版时间线的命名规则是什么？',
  'vfx.bin': '视效素材放在哪个媒体池 bin？',
  'vfx.targetTrack': '视效贴到哪条视频轨（V2、V3…）？',
  'vfx.markerColor': '视效标记用什么颜色？',
  'vfx.anchor': '视效按 record TC 还是 source TC 对齐？',
  'vfx.handles': '视效保留多少帧 handles？',
  'vfx.namePattern': '视效片段/输出的命名规则是什么？',
  'output.preset': '输出用哪个渲染 preset？',
  'output.format': '输出的格式/容器是什么（mov、mxf…）？',
  'output.codec': '输出的编码是什么？',
  'output.directory': '这类物料输出到哪个目录？',
  'output.namePattern': '输出文件的命名规则是什么？',
}

/**
 * Defaults for one project: conform and timeline policy are usable out of the
 * box; VFX and output stay unanswered until the project-start questions.
 * @param project - current Resolve project name.
 * @returns a fresh conventions document.
 */
export function defaultConventions(project: string): DavinciProjectConventions {
  return {
    version: 1,
    project,
    conform: { targetTrack: 1, audio: 'ignore', multiSegment: true, sourceMatch: 'source-tc', handles: 0 },
    vfx: {},
    output: {},
    timelinePolicy: {
      workingSuffix: '_待审',
      backupSuffixFormat: '__OLD_YYYYMMDD_HHmm',
      disableOriginal: true,
      keepCopy: true,
      review: 'zh',
    },
    notes: '',
  }
}

/** Required field paths, in question order. */
const REQUIRED_FIELDS: readonly string[] = [
  'frameRate',
  'dropFrame',
  'conform.workprintPattern',
  'vfx.bin',
  'vfx.targetTrack',
  'vfx.markerColor',
  'vfx.anchor',
  'vfx.handles',
  'vfx.namePattern',
  'output.preset',
  'output.format',
  'output.codec',
  'output.directory',
  'output.namePattern',
]

function readPath(conventions: DavinciProjectConventions, path: string): unknown {
  const parts = path.split('.')
  let value: unknown = conventions
  for (const part of parts) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/**
 * Fields still unanswered in a conventions document.
 * @param conventions - merged conventions.
 * @returns missing field paths in question order.
 */
export function missingConventionFields(conventions: DavinciProjectConventions): readonly string[] {
  return REQUIRED_FIELDS.filter((path) => {
    const value = readPath(conventions, path)
    return value === undefined || (typeof value === 'string' && value.trim() === '')
  })
}

/**
 * Build the questions for the missing fields.
 * @param missing - missing field paths.
 * @returns field/question pairs in order.
 */
export function conventionQuestions(missing: readonly string[]): readonly DavinciConventionsQuestion[] {
  return missing.map((field) => ({ field, question: CONVENTION_QUESTIONS[field] ?? `请补充 ${field}` }))
}

/**
 * Filesystem name for a project's conventions document. Path separators and
 * characters illegal on any supported platform become `_`; an empty or
 * traversal-only name is refused instead of writing outside the directory.
 * @param directory - conventions root.
 * @param project - Resolve project name.
 * @returns absolute document path.
 */
export function conventionsPath(directory: string, project: string): string {
  const safe = project.trim().replace(/[\\/:*?"<>|]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') {
    throw new Error(`project name "${project}" cannot be used as a conventions file name`)
  }
  return join(directory, `${safe}.json`)
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`)
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
}

function assertMarkerColor(value: unknown, field: string): asserts value is DavinciMarkerColor {
  if (typeof value !== 'string' || !(DAVINCI_MARKER_COLORS as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${DAVINCI_MARKER_COLORS.join(', ')}`)
  }
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): asserts value is T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`)
  }
}

function applyConform(target: DavinciConformConventions, patch: Record<string, unknown>): DavinciConformConventions {
  const next = { ...target }
  if (patch.workprintPattern !== undefined) {
    assertString(patch.workprintPattern, 'conform.workprintPattern')
    next.workprintPattern = patch.workprintPattern
  }
  if (patch.targetTrack !== undefined) {
    assertPositiveInteger(patch.targetTrack, 'conform.targetTrack')
    next.targetTrack = patch.targetTrack
  }
  if (patch.audio !== undefined) {
    assertEnum(patch.audio, CONFORM_AUDIO, 'conform.audio')
    next.audio = patch.audio
  }
  if (patch.multiSegment !== undefined) {
    assertBoolean(patch.multiSegment, 'conform.multiSegment')
    next.multiSegment = patch.multiSegment
  }
  if (patch.sourceMatch !== undefined) {
    if (patch.sourceMatch !== 'source-tc') throw new Error('conform.sourceMatch must be "source-tc"')
    next.sourceMatch = 'source-tc'
  }
  if (patch.handles !== undefined) {
    assertNonNegativeInteger(patch.handles, 'conform.handles')
    next.handles = patch.handles
  }
  return next
}

function applyVfx(target: DavinciVfxConventions, patch: Record<string, unknown>): DavinciVfxConventions {
  const next = { ...target }
  if (patch.bin !== undefined) {
    assertString(patch.bin, 'vfx.bin')
    next.bin = patch.bin
  }
  if (patch.targetTrack !== undefined) {
    assertPositiveInteger(patch.targetTrack, 'vfx.targetTrack')
    next.targetTrack = patch.targetTrack
  }
  if (patch.markerColor !== undefined) {
    assertMarkerColor(patch.markerColor, 'vfx.markerColor')
    next.markerColor = patch.markerColor
  }
  if (patch.anchor !== undefined) {
    assertEnum(patch.anchor, VFX_ANCHORS, 'vfx.anchor')
    next.anchor = patch.anchor
  }
  if (patch.handles !== undefined) {
    assertNonNegativeInteger(patch.handles, 'vfx.handles')
    next.handles = patch.handles
  }
  if (patch.namePattern !== undefined) {
    assertString(patch.namePattern, 'vfx.namePattern')
    next.namePattern = patch.namePattern
  }
  return next
}

function applyOutput(target: DavinciOutputConventions, patch: Record<string, unknown>): DavinciOutputConventions {
  const next = { ...target }
  for (const field of ['preset', 'format', 'codec', 'directory', 'namePattern'] as const) {
    if (patch[field] !== undefined) {
      assertString(patch[field], `output.${field}`)
      next[field] = patch[field]
    }
  }
  return next
}

function applyTimelinePolicy(target: DavinciTimelinePolicy, patch: Record<string, unknown>): DavinciTimelinePolicy {
  const next = { ...target }
  if (patch.workingSuffix !== undefined) {
    assertString(patch.workingSuffix, 'timelinePolicy.workingSuffix')
    if (patch.workingSuffix === '') throw new Error('timelinePolicy.workingSuffix must not be empty')
    next.workingSuffix = patch.workingSuffix
  }
  if (patch.backupSuffixFormat !== undefined) {
    assertString(patch.backupSuffixFormat, 'timelinePolicy.backupSuffixFormat')
    if (patch.backupSuffixFormat === '') throw new Error('timelinePolicy.backupSuffixFormat must not be empty')
    next.backupSuffixFormat = patch.backupSuffixFormat
  }
  if (patch.disableOriginal !== undefined) {
    assertBoolean(patch.disableOriginal, 'timelinePolicy.disableOriginal')
    next.disableOriginal = patch.disableOriginal
  }
  if (patch.keepCopy !== undefined) {
    assertBoolean(patch.keepCopy, 'timelinePolicy.keepCopy')
    next.keepCopy = patch.keepCopy
  }
  if (patch.review !== undefined) {
    if (patch.review !== 'zh') throw new Error('timelinePolicy.review must be "zh"')
    next.review = 'zh'
  }
  return next
}

/**
 * Merge a partial answer set over an existing document. Immutable fields
 * (`version`, `project`) are never changed; invalid values fail loud instead of
 * being stored.
 * @param current - current conventions.
 * @param patch - partial answers.
 * @returns a new merged document.
 */
export function mergeConventions(
  current: DavinciProjectConventions,
  patch: DavinciProjectConventionsPatch | Record<string, unknown>,
): DavinciProjectConventions {
  assertObject(patch, 'conventions patch')
  const record = patch as Record<string, unknown>
  let next: DavinciProjectConventions = {
    ...current,
    conform: { ...current.conform },
    vfx: { ...current.vfx },
    output: { ...current.output },
    timelinePolicy: { ...current.timelinePolicy },
  }
  if (record.frameRate !== undefined) {
    if (typeof record.frameRate !== 'number' || !Number.isFinite(record.frameRate) || record.frameRate <= 0) {
      throw new Error('frameRate must be a positive number')
    }
    next = { ...next, frameRate: record.frameRate }
  }
  if (record.dropFrame !== undefined) {
    assertBoolean(record.dropFrame, 'dropFrame')
    next = { ...next, dropFrame: record.dropFrame }
  }
  if (record.conform !== undefined) {
    assertObject(record.conform, 'conform')
    next = { ...next, conform: applyConform(next.conform, record.conform) }
  }
  if (record.vfx !== undefined) {
    assertObject(record.vfx, 'vfx')
    next = { ...next, vfx: applyVfx(next.vfx, record.vfx) }
  }
  if (record.output !== undefined) {
    assertObject(record.output, 'output')
    next = { ...next, output: applyOutput(next.output, record.output) }
  }
  if (record.timelinePolicy !== undefined) {
    assertObject(record.timelinePolicy, 'timelinePolicy')
    next = { ...next, timelinePolicy: applyTimelinePolicy(next.timelinePolicy, record.timelinePolicy) }
  }
  if (record.notes !== undefined) {
    assertString(record.notes, 'notes')
    next = { ...next, notes: record.notes }
  }
  return next
}

/**
 * Validate a stored document and fill defaults. A missing or empty document is
 * represented by `undefined` at {@link readConventions}; this function handles
 * a present document, including older partial files.
 * @param project - current project name; must match the document when present.
 * @param raw - parsed JSON.
 * @returns the normalized document.
 */
export function normalizeConventions(project: string, raw: unknown): DavinciProjectConventions {
  assertObject(raw, 'project conventions')
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`unsupported project-conventions version ${String(raw.version)}`)
  }
  if (raw.project !== undefined) {
    assertString(raw.project, 'project')
    if (raw.project !== project) {
      throw new Error(`project conventions belong to "${raw.project}", not "${project}"`)
    }
  }
  return mergeConventions(defaultConventions(project), raw)
}

/**
 * Read one project's conventions.
 * @param directory - conventions root.
 * @param project - current project name.
 * @returns the normalized document, or `undefined` when no file exists.
 * @throws when the file is unreadable, malformed, or belongs to another project.
 */
export function readConventions(directory: string, project: string): DavinciProjectConventions | undefined {
  const path = conventionsPath(directory, project)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`could not read project conventions at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`project conventions at ${path} are not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeConventions(project, raw)
}

/**
 * Write a project's conventions atomically: a sibling temporary file is
 * renamed over the target, so a crash never leaves a half-written document.
 * @param directory - conventions root.
 * @param conventions - validated document.
 * @returns the absolute path written.
 */
export function writeConventions(directory: string, conventions: DavinciProjectConventions): string {
  mkdirSync(directory, { recursive: true })
  const path = conventionsPath(directory, conventions.project)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(conventions, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  return path
}

/**
 * Read a project's conventions or start from defaults.
 * @param directory - conventions root.
 * @param project - current project name.
 * @returns the document and its path.
 */
export function loadConventions(directory: string, project: string): { conventions: DavinciProjectConventions; path: string } {
  const conventions = readConventions(directory, project) ?? defaultConventions(project)
  return { conventions, path: conventionsPath(directory, project) }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Render the backup name for a disabled original timeline. The policy's
 * `YYYY`, `MM`, `DD`, `HH`, and `mm` tokens are replaced with the local
 * timestamp; a pattern without tokens is appended literally.
 * @param originalName - the original timeline name.
 * @param policy - timeline policy holding the suffix format.
 * @param date - timestamp to embed; tests pass a fixed date.
 * @returns the original name plus the backup suffix.
 */
export function formatBackupName(
  originalName: string,
  policy: Pick<DavinciTimelinePolicy, 'backupSuffixFormat'>,
  date: Date = new Date(),
): string {
  const suffix = policy.backupSuffixFormat
    .replaceAll('YYYY', String(date.getFullYear()))
    .replaceAll('MM', pad2(date.getMonth() + 1))
    .replaceAll('DD', pad2(date.getDate()))
    .replaceAll('HH', pad2(date.getHours()))
    .replaceAll('mm', pad2(date.getMinutes()))
  return `${originalName}${suffix}`
}

/**
 * Name of the duplicated working timeline.
 * @param originalName - current timeline name.
 * @param workingSuffix - policy suffix (`_待审`).
 * @returns the working-copy name.
 */
export function workingTimelineName(originalName: string, workingSuffix: string): string {
  return `${originalName}${workingSuffix}`
}

/**
 * Strip the working suffix from a `_待审` copy.
 * @param name - timeline name.
 * @param workingSuffix - policy suffix.
 * @returns the original name, or `undefined` when the suffix is absent.
 */
export function stripWorkingSuffix(name: string, workingSuffix: string): string | undefined {
  if (workingSuffix === '' || !name.endsWith(workingSuffix)) return undefined
  return name.slice(0, -workingSuffix.length)
}
