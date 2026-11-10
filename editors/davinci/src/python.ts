/**
 * Python sources for every `ctx.davinci` operation, executed through the
 * davinci-mcp `run_script` / `run_script_unsafe` tools. The sandbox pre-injects
 * the `resolve` and `project` globals; imports are forbidden in `run_script`
 * (zero-import bodies only) and only `os`/`subprocess`/`time` are exercised in
 * the unsafe screenshot body. Bodies embed caller arguments with
 * `JSON.stringify`, whose output is a valid Python string literal, so no manual
 * escaping exists to get wrong. Output discipline matches the retired fuscript
 * Lua bodies: `key=value` lines with an absent value printed empty (the `s`
 * helper keeps `true`/`false` literals and `%.14g` float rendering), and
 * `ERROR <code>: <message>` for refusals; every early return leaves the script
 * otherwise silent. Frame math uses the timeline's nominal integer rate with
 * drop-frame handling for 29.97/59.94, and an unreadable frame rate fails the
 * call instead of being guessed.
 * @module @deepseek-ai/dsh-davinci/python
 */

import { MAX_LISTED_ITEMS } from './protocol.ts'
import type {
  DavinciAddRenderJobRequest,
  DavinciDeleteRenderJobRequest,
  DavinciDeleteRequest,
  DavinciLoadRenderPresetRequest,
  DavinciMarkerRequest,
  DavinciPlaceRequest,
  DavinciRenderingControlRequest,
  DavinciUiPlacementRequest,
} from './types.ts'

/**
 * Shared prelude: `s`/`each` value discipline, the `_dsh_main` wrapper with
 * resolve/project guards, and object-safe helpers. Bodies are appended inside
 * `_dsh_main` by {@link pythonScriptOf}, so they run only after the guards
 * pass and can early-`return` exactly like the Lua bodies did.
 */
export const PYTHON_PRELUDE = `def s(v):
    # Lua tostring parity for the kv protocol: booleans and %.14g floats. An
    # absent value prints empty, so a literal 'nil' stays a real string.
    if v is None:
        return ''
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, float):
        return format(v, '.14g')
    return str(v)

def each(t):
    # Resolve's Python surface returns dict for GetSubFolders/GetRenderCodecs/
    # GetRenderPresets/GetRenderFormats (values are the rows) and list for the
    # item/clip/job queries; None means an absent collection.
    if t is None:
        return []
    if isinstance(t, dict):
        return list(t.values())
    if isinstance(t, (list, tuple)):
        return list(t)
    return [t]

def nominal_rate(fps):
    # Timecode fields count in whole frames: 23.976 displays on a 24 grid and
    # 29.97 on a 30 grid.
    return int(round(fps))

def tc_to_frames(tc, fps):
    # Timecode -> absolute frame number. ';' marks drop-frame timecode, which
    # only 29.97/59.94 use; other rates read as non-drop.
    if tc is None or fps is None:
        return None
    text = str(tc).strip()
    drop = ';' in text
    parts = text.replace(';', ':').split(':')
    if len(parts) != 4:
        return None
    for part in parts:
        if not (part.isascii() and part.isdigit()):
            return None
    h, m, sec, f = (int(part) for part in parts)
    nominal = nominal_rate(fps)
    if nominal <= 0 or f >= nominal:
        return None
    if drop and nominal in (30, 60):
        drop_frames = 2 if nominal == 30 else 4
        total_minutes = h * 60 + m
        return ((h * 3600 + m * 60 + sec) * nominal + f) - drop_frames * (total_minutes - total_minutes // 10)
    return ((h * 60 + m) * 60 + sec) * nominal + f

def frames_to_tc(frames, fps):
    # Absolute frame number -> timecode. Drop-frame applies the standard
    # per-minute adjustment so 29.97/59.94 output matches Resolve's ';' timecode.
    if frames is None or fps is None or frames < 0:
        return None
    nominal = nominal_rate(fps)
    if nominal <= 0:
        return None
    drop = abs(fps - nominal) > 0.01 and nominal in (30, 60)
    adjusted = frames
    if drop:
        drop_frames = 2 if nominal == 30 else 4
        per_10_minutes = nominal * 600 - drop_frames * 9
        per_minute = nominal * 60 - drop_frames
        tens, rest = divmod(frames, per_10_minutes)
        adjusted = frames + drop_frames * 9 * tens
        if rest > drop_frames:
            adjusted = adjusted + drop_frames * ((rest - drop_frames) // per_minute)
    ff = adjusted % nominal
    total_seconds = adjusted // nominal
    ss = total_seconds % 60
    total_minutes = total_seconds // 60
    mm = total_minutes % 60
    hh = total_minutes // 60
    separator = ';' if drop else ':'
    return '%02d:%02d:%02d' % (hh, mm, ss) + separator + '%02d' % ff

def _dsh_main():
    if resolve is None:
        print('ERROR resolve-unreachable: DaVinci Resolve is not running or external scripting is unavailable')
        return
    if project is None:
        print('ERROR no-project: no project is open in Resolve')
        return
    pool = project.GetMediaPool()

    def find_bin(path):
        # Bin path like "VFX/20260702"; empty string is the root folder.
        folder = pool.GetRootFolder()
        if path == '':
            return folder, None
        for seg in [p for p in path.split('/') if p != '']:
            nxt = None
            for sf in each(folder.GetSubFolders()):
                if sf.GetName() == seg:
                    nxt = sf
                    break
            if nxt is None:
                return None, seg
            folder = nxt
        return folder, None

    def current_timeline():
        t = project.GetCurrentTimeline()
        if t is None:
            print('ERROR no-timeline: the current project has no current timeline')
        return t

    def find_item_by_start(t, track_index, start_frame):
        for it in each(t.GetItemListInTrack('video', track_index)):
            if it.GetStart() == start_frame:
                return it
        return None

    def timeline_fps():
        # A missing or unparsable timelineFrameRate fails the frame math that
        # depends on it; it is never guessed.
        try:
            raw = project.GetSetting('timelineFrameRate')
        except Exception:
            return None
        if raw is None:
            return None
        token = str(raw).strip().split()
        if not token:
            return None
        try:
            fps = float(token[0])
        except ValueError:
            return None
        return fps if fps > 0 else None

    def render_job_id(row):
        # Queued render-job id across host row shapes: dict rows carry JobId
        # (Resolve 21 tables); remote objects expose GetJobId() (20.x); other
        # shapes read as id-less.
        if isinstance(row, dict):
            v = row.get('JobId')
            return None if v is None else s(v)
        if hasattr(row, 'GetJobId'):
            try:
                v = row.GetJobId()
                return None if v is None else s(v)
            except Exception:
                return None
        return None
`

/**
 * Assemble a runnable sandbox script from the prelude and one operation body:
 * the body is indented into `_dsh_main` and the invocation appended.
 * @param body - operation body source at zero indent.
 * @returns the complete Python script for `run_script`.
 */
export function pythonScriptOf(body: string): string {
  const indented = body.split('\n').map((line) => (line === '' ? '' : '    ' + line)).join('\n')
  return `${PYTHON_PRELUDE}\n${indented}\n\n_dsh_main()\n`
}

/**
 * Body listing project facts and every timeline name.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function projectInfoPython(): string {
  return `
count = project.GetTimelineCount()
print('resolve_version=' + s(resolve.GetVersionString()))
print('project_name=' + s(project.GetName()))
print('timeline_count=' + s(count))
for i in range(1, count + 1):
    t = project.GetTimelineByIndex(i)
    if t is not None:
        print('timeline_' + str(i) + '=' + s(t.GetName()))
cur = project.GetCurrentTimeline()
if cur is not None:
    print('current_timeline=' + s(cur.GetName()))
    print('current_start=' + s(cur.GetStartFrame()))
    print('current_end=' + s(cur.GetEndFrame()))
    print('video_tracks=' + s(cur.GetTrackCount('video')))
    print('audio_tracks=' + s(cur.GetTrackCount('audio')))
`
}

/**
 * Body listing one bin's subfolders and clips.
 * @param bin - bin path; empty string lists the root.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function mediaPoolPython(bin: string): string {
  return `
folder, missing = find_bin(${JSON.stringify(bin)})
if folder is None:
    print('ERROR bin-not-found: ' + s(missing))
    return
bins = 0
clips = 0
for sf in each(folder.GetSubFolders()):
    bins = bins + 1
    n = 0
    for _c in each(sf.GetClipList()):
        n = n + 1
    if bins <= ${MAX_LISTED_ITEMS}:
        print('bin_' + str(bins) + '_name=' + s(sf.GetName()))
        print('bin_' + str(bins) + '_clips=' + str(n))
for c in each(folder.GetClipList()):
    clips = clips + 1
    if clips <= ${MAX_LISTED_ITEMS}:
        print('clip_' + str(clips) + '_name=' + s(c.GetName()))
        print('clip_' + str(clips) + '_tc=' + s(c.GetClipProperty('Start TC')))
        print('clip_' + str(clips) + '_duration=' + s(c.GetClipProperty('Duration')))
        print('clip_' + str(clips) + '_fps=' + s(c.GetClipProperty('FPS')))
        print('clip_' + str(clips) + '_path=' + s(c.GetClipProperty('File Path')))
print('bin_count=' + str(bins))
print('clip_count=' + str(clips))
`
}

/**
 * Body listing one video track's items inside an optional record-frame window.
 * @param trackIndex - 1-based video track index.
 * @param from - record-frame lower bound, if any.
 * @param to - record-frame upper bound, if any.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function timelineItemsPython(trackIndex: number, from: number | undefined, to: number | undefined): string {
  return `
t = current_timeline()
if t is None:
    return
from_ = ${from === undefined ? 'None' : from}
to_ = ${to === undefined ? 'None' : to}
items = each(t.GetItemListInTrack('video', ${trackIndex}))
shown = 0
total = 0
n = 0
for it in items:
    total = total + 1
    start = it.GetStart()
    end = it.GetEnd()
    if (from_ is None or end > from_) and (to_ is None or start < to_):
        shown = shown + 1
        if shown <= ${MAX_LISTED_ITEMS}:
            n = n + 1
            tc = ''
            mpi = it.GetMediaPoolItem() if hasattr(it, 'GetMediaPoolItem') else None
            if mpi is not None:
                tc = s(mpi.GetClipProperty('Start TC'))
            print('item_' + str(n) + '_name=' + s(it.GetName()))
            print('item_' + str(n) + '_start=' + s(start))
            print('item_' + str(n) + '_end=' + s(end))
            print('item_' + str(n) + '_srctc=' + tc)
print('total=' + str(total))
print('shown=' + str(shown))
`
}

/**
 * Body scanning V1 for segments whose source-clip TC range covers a target TC.
 * @param tc - source timecode `HH:MM:SS:FF`.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function findByTcPython(tc: string): string {
  return `
t = current_timeline()
if t is None:
    return
fps = timeline_fps()
if fps is None:
    print('ERROR api-failed: could not read timelineFrameRate; source-TC matching needs the timeline frame rate')
    return
target = tc_to_frames(${JSON.stringify(tc)}, fps)
if target is None:
    print('ERROR bad-tc: expected HH:MM:SS:FF, got ' + ${JSON.stringify(tc)})
    return
hits = 0
scanned = 0
for it in each(t.GetItemListInTrack('video', 1)):
    scanned = scanned + 1
    mpi = it.GetMediaPoolItem() if hasattr(it, 'GetMediaPoolItem') else None
    if mpi is not None:
        clip_start = tc_to_frames(s(mpi.GetClipProperty('Start TC') or ''), fps)
        try:
            clip_frames = float(s(mpi.GetClipProperty('Frames') or ''))
        except ValueError:
            clip_frames = 0.0
        if clip_start is not None and clip_frames > 0 and target >= clip_start and target < clip_start + clip_frames:
            hits = hits + 1
            print('hit_' + str(hits) + '_name=' + s(it.GetName()))
            print('hit_' + str(hits) + '_start=' + s(it.GetStart()))
            print('hit_' + str(hits) + '_end=' + s(it.GetEnd()))
            print('hit_' + str(hits) + '_srctc=' + s(mpi.GetClipProperty('Start TC')))
            print('hit_' + str(hits) + '_frames=' + s(it.GetEnd() - it.GetStart()))
print('fps=' + s(fps))
print('target_frames=' + s(target))
print('scanned=' + str(scanned))
print('hits=' + str(hits))
`
}

/**
 * Body scanning every timeline's every video track for items whose name
 * contains the needle; the one-call replacement for paged item scans.
 * @param name - case-sensitive substring to match.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function findClipPython(name: string): string {
  return `
needle = ${JSON.stringify(name)}
count = project.GetTimelineCount()
hits = 0
scanned = 0
for i in range(1, count + 1):
    tl = project.GetTimelineByIndex(i)
    if tl is not None:
        tl_name = s(tl.GetName())
        try:
            tracks = int(tl.GetTrackCount('video'))
        except (TypeError, ValueError):
            tracks = 0
        for ti in range(1, tracks + 1):
            for it in each(tl.GetItemListInTrack('video', ti)):
                scanned = scanned + 1
                nm = s(it.GetName())
                if needle in nm:
                    hits = hits + 1
                    if hits <= ${MAX_LISTED_ITEMS}:
                        print('hit_' + str(hits) + '_timeline=' + tl_name)
                        print('hit_' + str(hits) + '_track=' + str(ti))
                        print('hit_' + str(hits) + '_name=' + nm)
                        print('hit_' + str(hits) + '_start=' + s(it.GetStart()))
                        print('hit_' + str(hits) + '_end=' + s(it.GetEnd()))
print('scanned=' + str(scanned))
print('hits=' + str(hits))
`
}

/**
 * Body moving the playhead to a record frame or timecode.
 * @param frame - record frame to seek to.
 * @param tc - timecode to seek to; wins over `frame` when both are given.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function seekPython(frame: number | undefined, tc: string | undefined): string {
  const tcLiteral = tc !== undefined ? JSON.stringify(tc) : 'None'
  const frameLiteral = frame === undefined ? 'None' : frame
  return `
t = current_timeline()
if t is None:
    return
tc_str = ${tcLiteral}
if tc_str is None:
    f = ${frameLiteral}
    if f is None:
        print('ERROR api-failed: resolve_seek needs a frame or a timecode')
        return
    fps = timeline_fps()
    if fps is None:
        print('ERROR api-failed: could not read timelineFrameRate to convert record frame ' + s(f) + ' to a timecode')
        return
    tc_str = frames_to_tc(int(f), fps)
    if tc_str is None:
        print('ERROR bad-tc: record frame ' + s(f) + ' is outside the printable timecode range')
        return
ok = t.SetCurrentTimecode(tc_str)
print('seek_ok=' + s(ok))
print('now_at=' + s(t.GetCurrentTimecode()))
`
}

/**
 * Body switching the project's current timeline by index or exact name.
 * @param index - 1-based timeline index; wins over `name` when both are given.
 * @param name - exact timeline name; consulted when `index` is omitted.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function switchTimelinePython(index: number | undefined, name: string | undefined): string {
  const indexLiteral = index !== undefined ? String(index) : 'None'
  const nameLiteral = name !== undefined ? JSON.stringify(name) : 'None'
  return `
count = project.GetTimelineCount()
target = None
target_index = None
want_index = ${indexLiteral}
if want_index is not None:
    if want_index < 1 or want_index > count:
        print('ERROR timeline-not-found: index ' + s(want_index) + ' is outside the 1-' + s(count) + ' range of this project')
        return
    target = project.GetTimelineByIndex(want_index)
    target_index = want_index
else:
    want_name = ${nameLiteral}
    if want_name is None:
        print('ERROR timeline-not-found: provide either a 1-based timeline index or an exact timeline name')
        return
    for i in range(1, count + 1):
        t = project.GetTimelineByIndex(i)
        if t is not None and s(t.GetName()) == want_name:
            target = t
            target_index = i
            break
    if target is None:
        print('ERROR timeline-not-found: no timeline named ' + want_name + ' in this project')
        return
if target is None:
    print('ERROR timeline-not-found: Resolve returned no timeline for the request')
    return
previous = project.GetCurrentTimeline()
previous_name = s(previous.GetName()) if previous is not None else ''
ok = project.SetCurrentTimeline(target)
if ok is None or ok is False:
    print('switched=false')
    print('previous_timeline=' + previous_name)
    return
print('switched=true')
print('previous_timeline=' + previous_name)
print('timeline_name=' + s(target.GetName()))
print('timeline_index=' + s(target_index))
`
}

/**
 * Body starting a timeline edit: duplicate the current timeline through
 * `MediaPool:DuplicateTimeline`, rename the copy to `<name><suffix>`, and make
 * it current. The original is never edited. A failed rename or switch removes
 * the just-created copy so the project is left as it was.
 * @param workingSuffix - policy suffix appended to the copied timeline.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function beginTimelineEditPython(workingSuffix: string): string {
  return `
suffix = ${JSON.stringify(workingSuffix)}
t = current_timeline()
if t is None:
    return
name = s(t.GetName())
if suffix != '' and name.endswith(suffix):
    print('ERROR api-failed: "' + name + '" is already a working copy; finish it before starting another edit')
    return
original_start = None
original_end = None
try:
    original_start = t.GetStartFrame()
    original_end = t.GetEndFrame()
except Exception:
    pass
pool = project.GetMediaPool()
copy = t.DuplicateTimeline()
if copy is None:
    print('ERROR api-failed: MediaPool:DuplicateTimeline returned nothing for "' + name + '"')
    return
working = name + suffix
if s(copy.GetName()) != working:
    if not copy.SetName(working):
        try:
            pool.DeleteTimelines([copy])
        except Exception:
            pass
        print('ERROR api-failed: duplicated "' + name + '" but could not rename the copy to "' + working + '"')
        return
if not project.SetCurrentTimeline(copy):
    try:
        pool.DeleteTimelines([copy])
    except Exception:
        pass
    print('ERROR api-failed: duplicated "' + name + '" as "' + working + '" but could not switch to it')
    return
working_start = None
working_end = None
try:
    working_start = copy.GetStartFrame()
    working_end = copy.GetEndFrame()
except Exception:
    pass
print('original_name=' + name)
print('working_name=' + working)
print('original_start=' + s(original_start))
print('original_end=' + s(original_end))
print('working_start=' + s(working_start))
print('working_end=' + s(working_end))
print('done=true')
`
}

/**
 * Body reading the current working-copy state before finalize computes the
 * backup name. Refuses when the current timeline is not a `<name><suffix>`
 * copy or its original is missing.
 * @param workingSuffix - policy suffix.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function timelineEditStatePython(workingSuffix: string): string {
  return `
suffix = ${JSON.stringify(workingSuffix)}
t = current_timeline()
if t is None:
    return
name = s(t.GetName())
if suffix == '' or not name.endswith(suffix):
    print('ERROR api-failed: the current timeline "' + name + '" is not a working copy ending in "' + suffix + '"')
    return
original_name = name[:-len(suffix)]
original = None
for i in range(1, project.GetTimelineCount() + 1):
    candidate = project.GetTimelineByIndex(i)
    if candidate is not None and s(candidate.GetName()) == original_name:
        original = candidate
        break
if original is None:
    print('ERROR timeline-not-found: no original timeline named "' + original_name + '"')
    return
print('original_name=' + original_name)
print('working_name=' + name)
print('done=true')
`
}

/**
 * Body finishing a timeline edit. Rejection keeps the `_待审` copy and changes
 * nothing. Approval renames the original to its backup name and the copy back
 * to the original name; a failed second rename restores the first. Resolve has
 * no scripting API to disable a timeline, so the original stays enabled and the
 * result carries a manual-disable warning.
 *
 * Nothing is ever deleted: both timelines remain in the project, one under the
 * original name and one under the timestamped backup name.
 * @param approved - whether the user passed the review.
 * @param workingSuffix - policy suffix identifying the copy.
 * @param backupName - timestamped name for the original timeline.
 * @param disableOriginal - whether to report that a manual disable is needed.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function finalizeTimelineEditPython(
  approved: boolean,
  workingSuffix: string,
  backupName: string,
  disableOriginal: boolean,
): string {
  return `
suffix = ${JSON.stringify(workingSuffix)}
backup = ${JSON.stringify(backupName)}
approved = ${approved ? 'True' : 'False'}
disable_expected = ${disableOriginal ? 'True' : 'False'}
t = current_timeline()
if t is None:
    return
name = s(t.GetName())
if suffix == '' or not name.endswith(suffix):
    print('ERROR api-failed: the current timeline "' + name + '" is not a working copy ending in "' + suffix + '"')
    return
original_name = name[:-len(suffix)]
original = None
for i in range(1, project.GetTimelineCount() + 1):
    candidate = project.GetTimelineByIndex(i)
    if candidate is not None and s(candidate.GetName()) == original_name:
        original = candidate
        break
if original is None:
    print('ERROR timeline-not-found: no original timeline named "' + original_name + '"')
    return
if not approved:
    print('approved=false')
    print('done=false')
    print('original_name=' + original_name)
    print('working_name=' + name)
    print('original_disabled=false')
    return
if not original.SetName(backup):
    print('ERROR api-failed: could not rename the original timeline "' + original_name + '" to "' + backup + '"')
    return
if not t.SetName(original_name):
    original.SetName(original_name)
    print('ERROR api-failed: renamed the original to "' + backup + '" but could not rename the copy to "' + original_name + '"; the original name was restored')
    return
print('approved=true')
print('done=true')
print('original_name=' + backup)
print('working_name=' + original_name)
print('backup_name=' + backup)
print('original_disabled=false')
if disable_expected:
    print('warning=Resolve 没有禁用时间线的脚本 API；原时间线已改名保留但仍是启用状态，请在时间线列表右键选择「禁用时间线」。')
`
}

/**
 * Body placing a bin clip onto a video track at a record frame. Resolve
 * 21.1.1.10's scripting surface exposes only `MediaPool:AppendToTimeline` for
 * clip placement; the documented `InsertToTimeline` / `ReplaceToTimeline` are
 * ABSENT, and the options dict (`timeline`, `trackType`, `trackIndex`,
 * `recordFrame`, `insertType`) is empirically IGNORED — repeated experiments
 * show a single append always lands on the V1 timeline tail regardless of
 * `trackIndex` or `recordFrame`. Resolve's scripting surface has no
 * positioned-insert, no `MoveItemsInTrack`, no clip-reposition primitive, and
 * no Track-object API.
 *
 * This body therefore appends, reads the landing back, and compares it with
 * the request:
 *   1. snapshot every existing item (track, position, name) and the video
 *      max-start before the call,
 *   2. append via the only available primitive (`AppendToTimeline`),
 *   3. read back the newly-appended item's actual track/start/end,
 *   4. succeed only when actual == requested; otherwise remove exactly the
 *      items that arrived during the call (on every track) via `DeleteClips`,
 *      and fail loudly with the real coordinates.
 *
 * A response that claims success without a findable new item also rolls back
 * every arrival before failing, so a failed call never leaves a stray clip.
 * `done=true` is printed only on an exact placement, so
 * `mutationFrom(fields, op)`'s `done==true` gate keeps its "only true on
 * success" contract.
 * @param request - the placement coordinates (bin/clip + video track + record frame).
 * @returns Python source for {@link pythonScriptOf}.
 */
export function placePython(request: DavinciPlaceRequest): string {
  return `
t = current_timeline()
if t is None:
    return
folder, missing = find_bin(${JSON.stringify(request.bin)})
if folder is None:
    print('ERROR bin-not-found: ' + s(missing))
    return
target = None
for c in each(folder.GetClipList()):
    if s(c.GetName()) == ${JSON.stringify(request.clipName)}:
        target = c
        break
if target is None:
    print('ERROR clip-not-found: no clip named ' + ${JSON.stringify(request.clipName)} + ' in bin ' + ${JSON.stringify(request.bin)})
    return
track_index = ${request.trackIndex}
record_frame = ${request.recordFrame}

# Snapshot every item before the append: the rollback then removes exactly the
# arrivals (any track, any position), so even a future host that honors
# trackIndex/recordFrame cannot leave a mislanded clip behind.
pre_items = {}
max_start = None
for kind in ('video', 'audio'):
    for ti in range(1, int(t.GetTrackCount(kind)) + 1):
        for it in each(t.GetItemListInTrack(kind, ti)):
            start = it.GetStart()
            key = (kind, ti, start, it.GetEnd(), s(it.GetName()))
            pre_items[key] = pre_items.get(key, 0) + 1
            if kind == 'video' and (max_start is None or start > max_start):
                max_start = start

def rollback_appended():
    doomed = []
    for kind in ('video', 'audio'):
        for ti in range(1, int(t.GetTrackCount(kind)) + 1):
            for it in each(t.GetItemListInTrack(kind, ti)):
                key = (kind, ti, it.GetStart(), it.GetEnd(), s(it.GetName()))
                if pre_items.get(key, 0) > 0:
                    pre_items[key] = pre_items[key] - 1
                else:
                    doomed.append(it)
    return t.DeleteClips(doomed) if doomed else True

ok = pool.AppendToTimeline([target])
if ok is None or ok is False:
    print('ERROR api-failed: MediaPool:AppendToTimeline reported failure')
    return

landed = None
landed_track = None
best_start = None
for ti in range(1, int(t.GetTrackCount('video')) + 1):
    for it in each(t.GetItemListInTrack('video', ti)):
        if s(it.GetName()) == ${JSON.stringify(request.clipName)}:
            start = it.GetStart()
            if (best_start is None or start > best_start) and (max_start is None or start > max_start):
                best_start = start
                landed = it
                landed_track = ti

if landed is None:
    removed = rollback_appended()
    print('rolled_back=' + s(removed is True))
    print('ERROR api-failed: AppendToTimeline reported success but no item named ' + ${JSON.stringify(request.clipName)} + ' was found beyond frame ' + s(max_start) + ' on any video track; every item added by the call was rolled back')
    return

actual_track = landed_track
actual_start = landed.GetStart()
actual_end = landed.GetEnd()

print('landed_track=' + s(actual_track))
print('landed_start=' + s(actual_start))
print('landed_end=' + s(actual_end))

if actual_track == track_index and actual_start == record_frame:
    print('done=true')
else:
    # AppendToTimeline lands the clip's companion audio alongside the video
    # item, so the rollback removes every arrival on every track, not just the
    # video item; otherwise the audio remainder stretches the timeline.
    removed = rollback_appended()
    print('rolled_back=' + s(removed is True))
    print('ERROR mislanded-placement: requested video track ' + s(track_index) + ' at record frame ' + s(record_frame) + "; Resolve 21's only positioned placement is tail-append, which landed on video track " + s(actual_track) + ' at record frame ' + s(actual_start) + ' (end ' + s(actual_end) + '). The item was rolled back via DeleteClips to leave the timeline unchanged. For a true positioned insert, use the Edit page (select + drag on the UI), or run a fuscript that drives the Resolve UI.')
`
}

/**
 * AppleScript that clicks Resolve's "Place On Top" menu item, searching every
 * top-level menu for the English or Chinese label and falling back to the F12
 * shortcut when the item is not exposed. Exported for the UI-placement body
 * and its tests.
 */
export const PLACE_ON_TOP_APPLESCRIPT = `tell application "System Events"
  if not (exists process "DaVinci Resolve") then error "DaVinci Resolve process not found"
  tell process "DaVinci Resolve"
    set foundItem to missing value
    repeat with bar in menu bar items of menu bar 1
      repeat with m in menus of bar
        repeat with mi in menu items of m
          set nm to name of mi
          if nm is not missing value then
            if nm is "Place On Top" or nm is "Place on Top" or nm is "叠加" then
              set foundItem to mi
            end if
          end if
        end repeat
      end repeat
    end repeat
    if foundItem is missing value then
      key code 111
    else
      click foundItem
    end if
  end tell
end tell`

/**
 * Body planning a VFX layup: for every deliverable in a bin (or one named
 * clip), find the match-track segment whose source TC range covers the
 * deliverable's Start TC, compute the landing record frame from the offset
 * inside that segment, and report whether the target track and every track
 * above it are free over the target range.
 * @param bin - bin path holding the deliverables; empty string is the root.
 * @param clipName - one deliverable name, or undefined for the whole bin.
 * @param matchTrack - 1-based video track whose source TC range is matched.
 * @param targetTrack - 1-based video track the deliverable would land on.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function placementPlanPython(
  bin: string,
  clipName: string | undefined,
  matchTrack: number,
  targetTrack: number,
): string {
  const wanted = clipName === undefined ? 'None' : JSON.stringify(clipName)
  return `
t = current_timeline()
if t is None:
    return
fps = timeline_fps()
if fps is None:
    print('ERROR api-failed: could not read timelineFrameRate; VFX placement planning needs it')
    return
folder, missing = find_bin(${JSON.stringify(bin)})
if folder is None:
    print('ERROR bin-not-found: ' + s(missing))
    return

def clip_frames(item):
    try:
        value = float(s(item.GetClipProperty('Frames') or ''))
    except (TypeError, ValueError):
        return 0
    return int(value) if value > 0 else 0

segments = []
for it in each(t.GetItemListInTrack('video', ${matchTrack})):
    mpi = it.GetMediaPoolItem() if hasattr(it, 'GetMediaPoolItem') else None
    if mpi is None:
        continue
    start = tc_to_frames(s(mpi.GetClipProperty('Start TC') or ''), fps)
    frames = clip_frames(mpi)
    if start is not None and frames > 0:
        segments.append((it, start, frames))

targets = []
for ti in range(${targetTrack}, int(t.GetTrackCount('video')) + 1):
    for it in each(t.GetItemListInTrack('video', ti)):
        targets.append((ti, it.GetStart(), it.GetEnd(), s(it.GetName())))

wanted = ${wanted}
plans = 0
scanned = 0
for c in each(folder.GetClipList()):
    name = s(c.GetName())
    if wanted is not None and name != wanted:
        continue
    scanned = scanned + 1
    tc = s(c.GetClipProperty('Start TC') or '')
    frames = clip_frames(c)
    source_start = tc_to_frames(tc, fps)
    segment = None
    if source_start is not None and frames > 0:
        for seg in segments:
            if source_start >= seg[1] and source_start < seg[1] + seg[2]:
                segment = seg
                break
    segment_name = ''
    seg_start_record = None
    seg_end_record = None
    landing = None
    target_end = None
    overhang = None
    conflicts = []
    verdict = 'no-match'
    if segment is not None:
        offset = source_start - segment[1]
        landing = segment[0].GetStart() + offset
        target_end = landing + frames
        overhang = target_end - segment[0].GetEnd()
        segment_name = s(segment[0].GetName())
        seg_start_record = segment[0].GetStart()
        seg_end_record = segment[0].GetEnd()
        for (ti, start, end, tname) in targets:
            if not (end <= landing or start >= target_end):
                conflicts.append(tname + ' V' + str(ti) + ' [' + str(start) + '-' + str(end) + ']')
        verdict = 'occupied' if conflicts else 'ready'
    plans = plans + 1
    if plans <= ${MAX_LISTED_ITEMS}:
        print('plan_' + str(plans) + '_clip=' + name)
        print('plan_' + str(plans) + '_tc=' + tc)
        print('plan_' + str(plans) + '_frames=' + str(frames))
        print('plan_' + str(plans) + '_segment=' + segment_name)
        print('plan_' + str(plans) + '_seg_start=' + s(seg_start_record))
        print('plan_' + str(plans) + '_seg_end=' + s(seg_end_record))
        print('plan_' + str(plans) + '_landing=' + s(landing))
        print('plan_' + str(plans) + '_end=' + s(target_end))
        print('plan_' + str(plans) + '_overhang=' + s(overhang))
        print('plan_' + str(plans) + '_verdict=' + verdict)
        print('plan_' + str(plans) + '_conflicts=' + ';'.join(conflicts))
if scanned == 0:
    if wanted is None:
        print('ERROR clip-not-found: bin ' + ${JSON.stringify(bin)} + ' has no clips')
    else:
        print('ERROR clip-not-found: no clip named ' + wanted + ' in bin ' + ${JSON.stringify(bin)})
    return
print('plan_count=' + str(plans))
print('fps=' + s(fps))
print('match_track=' + str(${matchTrack}))
print('target_track=' + str(${targetTrack}))
print('scanned=' + str(scanned))
`
}

/**
 * Body structurally checking a VFX layup: for each item on the target track,
 * find the closest match-track segment by start frame and report whether the
 * target starts exactly on it (`covered`), at an offset, or on no segment.
 * @param matchTrack - 1-based video track holding the picture cut.
 * @param targetTrack - 1-based video track holding the placed deliverables.
 * @param from - optional record-frame lower bound for the target items.
 * @param to - optional record-frame upper bound for the target items.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function placementCheckPython(
  matchTrack: number,
  targetTrack: number,
  from: number | undefined,
  to: number | undefined,
): string {
  return `
t = current_timeline()
if t is None:
    return
from_ = ${from === undefined ? 'None' : from}
to_ = ${to === undefined ? 'None' : to}
segments = []
for it in each(t.GetItemListInTrack('video', ${matchTrack})):
    segments.append((it.GetStart(), it.GetEnd(), s(it.GetName())))
checked = 0
covered = 0
offsets = 0
missing = 0
for it in each(t.GetItemListInTrack('video', ${targetTrack})):
    start = it.GetStart()
    end = it.GetEnd()
    if (from_ is not None and end <= from_) or (to_ is not None and start >= to_):
        continue
    name = s(it.GetName())
    best = None
    for seg in segments:
        if best is None or abs(seg[0] - start) < abs(best[0] - start):
            best = seg
    checked = checked + 1
    delta = None
    verdict = 'no-segment'
    segment_name = ''
    segment_start = None
    segment_end = None
    if best is not None:
        segment_name = best[2]
        segment_start = best[0]
        segment_end = best[1]
        delta = start - best[0]
        if delta == 0:
            verdict = 'covered'
            covered = covered + 1
        else:
            verdict = 'offset'
            offsets = offsets + 1
    else:
        missing = missing + 1
    if checked <= ${MAX_LISTED_ITEMS}:
        print('check_' + str(checked) + '_name=' + name)
        print('check_' + str(checked) + '_start=' + s(start))
        print('check_' + str(checked) + '_end=' + s(end))
        print('check_' + str(checked) + '_segment=' + segment_name)
        print('check_' + str(checked) + '_seg_start=' + s(segment_start))
        print('check_' + str(checked) + '_seg_end=' + s(segment_end))
        print('check_' + str(checked) + '_delta=' + s(delta))
        print('check_' + str(checked) + '_verdict=' + verdict)
print('check_count=' + str(checked))
print('match_track=' + str(${matchTrack}))
print('target_track=' + str(${targetTrack}))
print('checked=' + str(checked))
print('covered=' + str(covered))
print('offset=' + str(offsets))
print('missing=' + str(missing))
`
}

/**
 * Body positioning one deliverable on V2 through the Edit page UI. Resolve's
 * scripting surface cannot insert at a record frame, so this body selects the
 * media-pool clip, seeks the playhead, clicks "Place On Top" through System
 * Events, then reads the landing back and rolls back every arrival when the
 * result is not exactly V2 at the requested frame.
 *
 * Preflight is fail-closed: V1 must have content over the landing frame (so
 * "Place On Top" has a layer to sit above) and every track from V2 upward must
 * be free over the deliverable's range, which makes the landing deterministic.
 * The UI chain needs macOS Accessibility/Automation permission for the DSH host
 * app and Resolve frontmost; a denied or failed UI step rolls back and reports
 * it instead of leaving a stray clip.
 * @param request - the placement coordinates plus the Resolve `.app` path.
 * @returns Python source for `pythonScriptOf`, routed through `run_script_unsafe`.
 */
export function placeUiPython(request: DavinciUiPlacementRequest): string {
  return `
import os
import subprocess
import time

t = current_timeline()
if t is None:
    return
if ${request.trackIndex} != 2:
    print('ERROR placement-blocked: UI placement currently supports video track 2 only')
    return
fps = timeline_fps()
if fps is None:
    print('ERROR api-failed: could not read timelineFrameRate to position the playhead')
    return
folder, missing = find_bin(${JSON.stringify(request.bin)})
if folder is None:
    print('ERROR bin-not-found: ' + s(missing))
    return

def clip_frames(item):
    try:
        value = float(s(item.GetClipProperty('Frames') or ''))
    except (TypeError, ValueError):
        return 0
    return int(value) if value > 0 else 0

target = None
for c in each(folder.GetClipList()):
    if s(c.GetName()) == ${JSON.stringify(request.clipName)}:
        target = c
        break
if target is None:
    print('ERROR clip-not-found: no clip named ' + ${JSON.stringify(request.clipName)} + ' in bin ' + ${JSON.stringify(request.bin)})
    return
frames = clip_frames(target)
if frames <= 0:
    print('ERROR api-failed: could not read the deliverable length; refusing a UI placement without a known range')
    return
record_frame = ${request.recordFrame}
end_frame = record_frame + frames

# V1 must have content at the playhead, or "Place On Top" would land on V1.
on_match = False
for it in each(t.GetItemListInTrack('video', 1)):
    if it.GetStart() <= record_frame < it.GetEnd():
        on_match = True
        break
if not on_match:
    print('ERROR placement-blocked: V1 has no segment covering frame ' + s(record_frame) + '; Place On Top would land on V1, not V2')
    return

# Every track from V2 upward must be free over the deliverable range, which is
# what makes "Place On Top" land on V2.
video_tracks = int(t.GetTrackCount('video'))
for ti in range(2, video_tracks + 1):
    for it in each(t.GetItemListInTrack('video', ti)):
        if not (it.GetEnd() <= record_frame or it.GetStart() >= end_frame):
            print('ERROR placement-blocked: video track ' + str(ti) + ' already has ' + s(it.GetName()) + ' [' + s(it.GetStart()) + '-' + s(it.GetEnd()) + '] over the target range [' + str(record_frame) + '-' + str(end_frame) + ']; delete or move it first')
            return

pre_items = {}
for kind in ('video', 'audio'):
    for ti in range(1, int(t.GetTrackCount(kind)) + 1):
        for it in each(t.GetItemListInTrack(kind, ti)):
            key = (kind, ti, it.GetStart(), it.GetEnd(), s(it.GetName()))
            pre_items[key] = pre_items.get(key, 0) + 1

def rollback_appended():
    doomed = []
    for kind in ('video', 'audio'):
        for ti in range(1, int(t.GetTrackCount(kind)) + 1):
            for it in each(t.GetItemListInTrack(kind, ti)):
                key = (kind, ti, it.GetStart(), it.GetEnd(), s(it.GetName()))
                if pre_items.get(key, 0) > 0:
                    pre_items[key] = pre_items[key] - 1
                else:
                    doomed.append(it)
    return t.DeleteClips(doomed) if doomed else True

if hasattr(resolve, 'OpenPage'):
    try:
        resolve.OpenPage('edit')
    except Exception:
        pass
try:
    pool.SetSelectedClip(target)
except Exception:
    print('ERROR api-failed: MediaPool:SetSelectedClip failed; the deliverable cannot be loaded for a UI edit')
    return
t.SetCurrentTimecode(frames_to_tc(record_frame, fps))
try:
    subprocess.run(['open', ${JSON.stringify(request.appPath)}], check=True, timeout=10)
except Exception:
    removed = rollback_appended()
    print('rolled_back=' + s(removed is True))
    print('ERROR api-failed: could not activate DaVinci Resolve; nothing was placed')
    return
time.sleep(0.8)
applescript = ${JSON.stringify(PLACE_ON_TOP_APPLESCRIPT)}
result = subprocess.run(['osascript', '-e', applescript], capture_output=True, timeout=20)
time.sleep(1.0)
if result.returncode != 0:
    removed = rollback_appended()
    detail = (result.stderr or b'').decode('utf-8', 'replace').strip()[-300:]
    print('rolled_back=' + s(removed is True))
    print('ERROR api-failed: the UI edit could not be driven (osascript exit ' + str(result.returncode) + '): ' + detail + ' - grant Accessibility/Automation permission to the DSH host app and keep Resolve frontmost; every item added by the call was rolled back')
    return
landed = None
for it in each(t.GetItemListInTrack('video', 2)):
    if s(it.GetName()) == ${JSON.stringify(request.clipName)} and it.GetStart() == record_frame:
        landed = it
        break
if landed is None:
    removed = rollback_appended()
    print('rolled_back=' + s(removed is True))
    print('ERROR api-failed: the UI edit ran but no ' + ${JSON.stringify(request.clipName)} + ' appeared on V2 at frame ' + s(record_frame) + '; verify the Source Viewer shows the deliverable and Accessibility is granted - every item added by the call was rolled back')
    return
print('landed_track=2')
print('landed_start=' + s(landed.GetStart()))
print('landed_end=' + s(landed.GetEnd()))
print('done=true')
`
}

/**
 * Body deleting the video-track item that starts exactly at a record frame.
 * @param request - the deletion coordinates.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function deleteItemPython(request: DavinciDeleteRequest): string {
  return `
t = current_timeline()
if t is None:
    return
item = find_item_by_start(t, ${request.trackIndex}, ${request.startFrame})
if item is None:
    print('ERROR item-not-found: no item starts at frame ' + str(${request.startFrame}) + ' on video track ' + str(${request.trackIndex}))
    return
ok = t.DeleteClips([item])
print('done=' + s(ok))
`
}

/**
 * Body listing one audio track's items inside an optional record-frame window
 * (mirror of the video-track listing; used to locate the 套片 audio delivery on A1).
 * @param trackIndex - 1-based audio track index (A1=1).
 * @param from - record-frame lower bound, if any.
 * @param to - record-frame upper bound, if any.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function audioTimelineItemsPython(trackIndex: number, from: number | undefined, to: number | undefined): string {
  return `
t = current_timeline()
if t is None:
    return
from_ = ${from === undefined ? 'None' : from}
to_ = ${to === undefined ? 'None' : to}
items = each(t.GetItemListInTrack('audio', ${trackIndex}))
shown = 0
total = 0
n = 0
for it in items:
    total = total + 1
    start = it.GetStart()
    end = it.GetEnd()
    if (from_ is None or end > from_) and (to_ is None or start < to_):
        shown = shown + 1
        if shown <= ${MAX_LISTED_ITEMS}:
            n = n + 1
            tc = ''
            mpi = it.GetMediaPoolItem() if hasattr(it, 'GetMediaPoolItem') else None
            if mpi is not None:
                tc = s(mpi.GetClipProperty('Start TC'))
            print('item_' + str(n) + '_name=' + s(it.GetName()))
            print('item_' + str(n) + '_start=' + s(start))
            print('item_' + str(n) + '_end=' + s(end))
            print('item_' + str(n) + '_srctc=' + tc)
print('total=' + str(total))
print('shown=' + str(shown))
`
}

/**
 * Body reading the render-engine's live state: queued-job count, active
 * rendering flag, and the current render format/codec names. Every host call
 * is individually try/except-guarded (the pcall discipline of the retired Lua
 * body) so one wedged API cannot sink the whole read; a failed read prints
 * `read-failed`, which the projection turns into a loud refusal.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function renderStatusPython(): string {
  return `
try:
    jobs = project.GetRenderJobList()
    if jobs is None:
        print('job_count=read-failed')
    else:
        n = len(jobs)
        print('job_count=' + str(n))
        if n > 0:
            first = jobs[0]
            if isinstance(first, dict):
                first_name = first.get('RenderJobName')
                if first_name is not None and first_name is not False:
                    print('first_job_name=' + s(first_name))
            elif hasattr(first, 'GetName'):
                try:
                    nm = first.GetName()
                    if nm is not None and nm is not False:
                        print('first_job_name=' + s(nm))
                except Exception:
                    pass  # first.GetName() itself failed; the Lua pcall skipped the row, keep parity
except Exception:
    print('job_count=read-failed')
try:
    rendering = project.IsRenderingInProgress()
    print('is_rendering=' + s(rendering is True))
except Exception:
    print('is_rendering=read-failed')
fmt = None
ok_fmt = True
try:
    fmt = project.GetCurrentRenderFormatAndCodec()
except Exception:
    ok_fmt = False
if ok_fmt:
    nm = None
    if isinstance(fmt, dict):
        nm = fmt.get('format')
        if nm is None:
            nm = fmt.get('Name')
    elif fmt is not None:
        nm = getattr(fmt, 'Name', None)
    print('cur_format=' + s(nm))
else:
    print('cur_format=read-failed')
try:
    fmt_nm = None
    if isinstance(fmt, dict):
        fmt_nm = fmt.get('format')
        if fmt_nm is None:
            fmt_nm = fmt.get('Name')
    elif fmt is not None:
        fmt_nm = getattr(fmt, 'Name', None)
    raw = project.GetRenderCodecs(fmt_nm)
    if raw is None:
        # None means the format exposes no codec list, matching the HEAD Lua
        # body's each(nil) == {} == 0; only real exceptions read-fail below.
        print('cur_codec_count=0')
    else:
        print('cur_codec_count=' + str(len(each(raw))))
except Exception:
    print('cur_codec_count=read-failed')
`
}

/**
 * Body reading the render-engine's selectable preset/format surface. Resolve
 * 21+ exposes `GetRenderPresets`/`GetRenderFormats`; Resolve 20.x has neither
 * and the body reports zero for `preset_count`, so the protocol maps the
 * `presets` list to an empty array. `has_load_preset` is true only when the
 * host actually exposes `LoadRenderPreset`, guarding callers that assume they
 * can switch presets.
 * @returns Python source for {@link pythonScriptOf}: the active (format, codec)
 *   pair, the preset count, per-preset names, and the load-preset capability flag.
 */
export function renderPresetsPython(): string {
  return `
fmt = None
ok_fmt = True
try:
    fmt = project.GetCurrentRenderFormatAndCodec()
except Exception:
    ok_fmt = False
fmt_name = ''
if ok_fmt and fmt is not None:
    nm = None
    if isinstance(fmt, dict):
        nm = fmt.get('format')
        if nm is None:
            nm = fmt.get('Name')
    else:
        nm = getattr(fmt, 'Name', None)
    if nm is not None and nm is not False:
        fmt_name = s(nm)
print('current_format=' + fmt_name)
if fmt_name == '':
    print('current_codec=')
else:
    try:
        raw = project.GetRenderCodecs(fmt_name)
        codecs = each(raw)
        nm = None
        if codecs:
            first = codecs[0]
            if isinstance(first, dict):
                nm = first.get('Name')
                if nm is None:
                    nm = first.get('name')
            elif not isinstance(first, str):
                nm = getattr(first, 'Name', None)
                if nm is None:
                    nm = getattr(first, 'name', None)
        if nm is not None and nm is not False:
            print('current_codec=' + s(nm))
        else:
            print('current_codec=')
    except Exception:
        print('current_codec=')
has_load = callable(getattr(project, 'LoadRenderPreset', None))
has_get_presets = callable(getattr(project, 'GetRenderPresets', None))
has_get_formats = callable(getattr(project, 'GetRenderFormats', None))
print('has_load_preset=' + s(has_load))
preset_count = 0
if has_get_presets:
    try:
        lst = project.GetRenderPresets()
        if lst is not None:
            rows = each(lst)
            preset_count = len(rows)
            for i, row in enumerate(rows, 1):
                name = None
                if isinstance(row, str):
                    name = row
                elif isinstance(row, dict):
                    name = row.get('Name')
                    if name is None:
                        name = row.get('name')
                else:
                    name = getattr(row, 'Name', None)
                    if name is None:
                        name = getattr(row, 'name', None)
                if name is not None and name is not False:
                    print('preset_' + str(i) + '=' + s(name))
    except Exception:
        pass  # preset listing failed; report the zero count like the Lua pcall did
print('preset_count=' + str(preset_count))
if has_get_formats:
    try:
        fl = project.GetRenderFormats()
        if fl is None:
            print('format_count=0')
        else:
            print('format_count=' + str(len(each(fl))))
    except Exception:
        print('format_count=0')
`
}

/**
 * Body enqueuing the current timeline into the render queue at `targetDir`,
 * with the empty-return defense around `Project:AddRenderJob`. The host
 * sometimes returns `''` (or an uncertain shape) even though a job was
 * queued, so the body never trusts a falsy return and never guesses from
 * list order:
 *
 * 1. before the call, snapshot the queued-job id set (ids of every
 *    `GetRenderJobList` row); a raised or `None` pre-read refuses to enqueue
 *    at all — without a baseline no delta could ever be attributed;
 * 2. a non-empty id return is used directly (`id_source=returned`);
 * 3. an empty or uncertain return routes into a queue read-back: exactly one
 *    new id ⇒ that id, marked `id_source=read-back` (the tool output then
 *    flags it 读回确认); more than one new id ⇒ an `ambiguous-job` refusal —
 *    no first-row guess, no retry, no further enqueue; zero new ids ⇒ the
 *    synchronous call has provably ended and added nothing, so the one-retry
 *    policy re-runs `AddRenderJob` exactly once against the fresh baseline
 *    (the post-attempt-1 id set); a second empty outcome is a final
 *    `api-failed` — nothing was queued;
 * 4. an exception from `AddRenderJob`, or a failed post-call read-back, is an
 *    UNKNOWN outcome: refuse without retrying — a retry could double-enqueue.
 *
 * The current render preset/format/codec are preserved; this call does not
 * change them. Resolve 20.3.2.9 has no presets and an empty format list, so
 * the active (UI-set) render settings are the only selectable surface.
 * @param request - the enqueue coordinates (target dir).
 * @returns Python source for {@link pythonScriptOf}, printing `ok=true`,
 *   `job_id`, `id_source` (`returned` or `read-back`), `job_count`, and
 *   `first_job_name` on success; `ERROR <code>: <message>` otherwise.
 */
export function addRenderJobPython(request: DavinciAddRenderJobRequest): string {
  return `
t = current_timeline()
if t is None:
    return

def render_job_name(row):
    if isinstance(row, dict):
        v = row.get('RenderJobName')
        if v is None:
            v = row.get('Name')
        return None if v is None else s(v)
    if hasattr(row, 'GetName'):
        try:
            v = row.GetName()
            return None if v is None else s(v)
        except Exception:
            return None
    return None

def queue_ids():
    # Snapshot of every queued job id; None means the queue read itself failed
    # (raised or returned None), which is distinct from an empty queue.
    try:
        rows = project.GetRenderJobList()
    except Exception:
        return None
    if rows is None:
        return None
    ids = []
    for row in each(rows):
        rid = render_job_id(row)
        if rid is not None and rid != '' and rid not in ids:
            ids.append(rid)
    return ids

def extract_returned_id(value):
    # AddRenderJob's return across host shapes: a str id, a dict carrying
    # JobId, an object exposing GetJobId(); absent/falsy/other shapes read as
    # '' (uncertain) and route into the queue read-back.
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        v = value.get('JobId')
        return '' if v is None else s(v)
    if hasattr(value, 'GetJobId'):
        try:
            v = value.GetJobId()
            return '' if v is None else s(v)
        except Exception:
            return ''
    return ''

pre_ids = queue_ids()
if pre_ids is None:
    print('ERROR api-failed: the render queue could not be read before enqueue; refusing to add a job without a pre-call queue snapshot')
    return
settings = {
    'targetDir': ${JSON.stringify(request.targetDir)},
}
baseline = pre_ids
attempts = 0
candidate = ''
source = ''
while attempts < 2:
    # At most one retry, and only after a returned call whose queue delta was
    # provably empty; every other outcome leaves the loop or refuses.
    attempts = attempts + 1
    try:
        returned = extract_returned_id(project.AddRenderJob(settings))
    except Exception:
        print('ERROR api-failed: AddRenderJob raised an exception; the enqueue outcome is unknown - read resolve_render_status before any retry')
        return
    if returned != '':
        candidate = returned
        source = 'returned'
        break
    post_ids = queue_ids()
    if post_ids is None:
        print('ERROR api-failed: AddRenderJob returned no id and the queue read-back failed; the enqueue outcome is unknown - read resolve_render_status before any retry')
        return
    fresh = []
    for i in post_ids:
        if i not in baseline and i not in fresh:
            fresh.append(i)
    if len(fresh) == 1:
        candidate = fresh[0]
        source = 'read-back'
        break
    if len(fresh) > 1:
        print('ERROR ambiguous-job: ' + str(len(fresh)) + ' new jobs appeared while AddRenderJob returned no id, so this call cannot be attributed to one job; candidates: ' + ', '.join(fresh) + '. No id is reported, nothing further is enqueued, and nothing is deleted - read resolve_render_status and disambiguate.')
        return
    # Zero new jobs: the synchronous call has ended and the queue provably did
    # not grow, so the one-retry policy allows exactly one more attempt.
    baseline = post_ids
if candidate == '':
    print('ERROR api-failed: AddRenderJob returned no id twice and the queue never grew; nothing was queued')
    return

job_name = None
job_count = None
try:
    rows = project.GetRenderJobList()
except Exception:
    rows = None
if rows is not None:
    job_count = len(each(rows))
    for row in each(rows):
        if render_job_id(row) == candidate:
            nm = render_job_name(row)
            if nm is not None:
                job_name = nm
            break
print('ok=true')
print('job_id=' + s(candidate))
print('id_source=' + source)
if job_count is not None:
    print('job_count=' + str(job_count))
if job_name is not None:
    print('first_job_name=' + job_name)
`
}

/**
 * Body loading a render preset by exact name via `Project:LoadRenderPreset`.
 * The name is validated against the host's `GetRenderPresets` list first, so a
 * typo refuses as `preset-not-found` without touching the host. The host's
 * return is the success signal: a falsy return (False/None) is an `api-failed`
 * refusal; `done=true` prints only after a truthy return.
 * @param request - the preset name to load (must match a host-reported entry).
 * @returns Python source for {@link pythonScriptOf}, printing `done=true` and
 *   the host-confirmed preset name.
 */
export function loadRenderPresetPython(request: DavinciLoadRenderPresetRequest): string {
  return `
name = ${JSON.stringify(request.presetName)}
if name == '':
    print('ERROR preset-not-found: empty preset name')
    return
has_load = callable(getattr(project, 'LoadRenderPreset', None))
if not has_load:
    print('ERROR api-failed: this Resolve build lacks Project:LoadRenderPreset (Resolve 21+ only)')
    return
try:
    lst = project.GetRenderPresets()
except Exception:
    print('ERROR api-failed: GetRenderPresets failed, so the preset name cannot be validated; read resolve_render_presets and retry')
    return
names = []
for row in each(lst) if lst is not None else []:
    candidate = None
    if isinstance(row, str):
        candidate = row
    elif isinstance(row, dict):
        candidate = row.get('Name')
        if candidate is None:
            candidate = row.get('name')
    else:
        candidate = getattr(row, 'Name', None)
        if candidate is None:
            candidate = getattr(row, 'name', None)
    if candidate is not None and candidate is not False:
        names.append(s(candidate))
if name not in names:
    print('ERROR preset-not-found: ' + name + ' is not one of the ' + str(len(names)) + ' presets this Resolve build reports; read resolve_render_presets for the exact names')
    return
try:
    ok = project.LoadRenderPreset(name)
except Exception:
    print('ERROR api-failed: LoadRenderPreset raised an exception; the active preset is unchanged or unknown - read resolve_render_presets before retrying')
    return
if not ok:
    print('ERROR api-failed: Resolve did not confirm the preset load (returned ' + s(ok) + '); the active preset may be unchanged')
    return
print('done=true')
print('loaded_preset=' + name)
`
}

/**
 * Body deleting one queued render job by its id via `Project:DeleteRenderJob`,
 * with targeted-delete and read-back guarantees:
 *
 * - the passed id is the only delete target: it must match the `JobId` field
 *   of a `GetRenderJobList` row (table shape, Resolve 21) or a `GetJobId()`
 *   method (remote-object shape, 20.x); a miss (or an empty queue/id) is a
 *   `job-not-found` refusal and the host delete is never invoked;
 * - `done=true` prints only after a post-delete read-back confirms the id left
 *   the queue; a contradictory read-back (id still queued) or a failed
 *   read-back is an `api-failed` refusal, never a success;
 * - exceptions from the queue reads or the delete itself surface as
 *   `api-failed` with an unknown-outcome message. No path deletes anything
 *   except the single passed id — the body contains no clear-queue or
 *   delete-all fallback, so a failing delete can never widen into deleting
 *   the rest of the queue.
 * @param request - the job id (UUID) reported by `resolve_add_render_job`.
 * @returns Python source for {@link pythonScriptOf}, printing `done=true`,
 *   `job_id`, and the post-delete queue depth on success;
 *   `ERROR <code>: <message>` otherwise.
 */
export function deleteRenderJobPython(request: DavinciDeleteRenderJobRequest): string {
  return `
job_id = ${JSON.stringify(request.jobId)}
if job_id == '':
    print('ERROR job-not-found: empty job id')
    return

def queue_rows():
    # Live queue rows; None means the queue read itself failed (raised or
    # returned None), which is distinct from an empty queue.
    try:
        return project.GetRenderJobList()
    except Exception:
        return None

rows = queue_rows()
if rows is None:
    print('ERROR api-failed: the render queue could not be read; refusing to delete without confirming the target job is queued')
    return
n = len(each(rows))
if n == 0:
    print('ERROR job-not-found: the render queue is empty; nothing to delete')
    return
found = False
for row in each(rows):
    if render_job_id(row) == job_id:
        found = True
        break
if not found:
    print('ERROR job-not-found: no queued job has id ' + job_id + '; nothing was deleted')
    return
try:
    ok = project.DeleteRenderJob(job_id)
except Exception:
    print('ERROR api-failed: DeleteRenderJob raised an exception; the outcome is unknown - read resolve_render_status. Only the passed job id is ever targeted, so no other queued job can be affected here.')
    return
if ok is False:
    print('ERROR api-failed: Resolve refused to delete job ' + job_id)
    return
after = queue_rows()
if after is None:
    print('ERROR api-failed: the delete call returned but the queue read-back failed, so the deletion could not be confirmed - read resolve_render_status')
    return
still_queued = False
m = 0
for row in each(after):
    m = m + 1
    if render_job_id(row) == job_id:
        still_queued = True
if still_queued:
    print('ERROR api-failed: the delete call reported success but job ' + job_id + ' is still queued; no further delete was attempted and every other queued job is untouched')
    return
print('done=true')
print('job_id=' + job_id)
print('job_count_after=' + str(m))
`
}

/**
 * Render a readonly string list as a Python list literal; JSON array syntax is
 * valid Python, so `JSON.stringify` embeds it directly.
 * @param values - the strings to embed.
 * @returns the Python list literal source.
 */
function pythonStringList(values: readonly string[]): string {
  return JSON.stringify(values)
}

/**
 * Body starting the render engine (optionally scoped to a set of job ids).
 * @param request - job ids to start, or none to start the whole queue.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function startRenderingPython(request: DavinciRenderingControlRequest): string {
  return `
jids = ${pythonStringList(request.jobIds ?? [])}
if jids:
    ok = project.StartRendering(jids)
else:
    ok = project.StartRendering()
print('done=' + s(ok is True))
print('is_rendering=' + s(project.IsRenderingInProgress() is True))
`
}

/**
 * Body stopping the render engine (optionally scoped to a set of job ids).
 * @param request - job ids to stop, or none to stop the whole queue.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function stopRenderingPython(request: DavinciRenderingControlRequest): string {
  return `
jids = ${pythonStringList(request.jobIds ?? [])}
if jids:
    ok = project.StopRendering(jids)
else:
    ok = project.StopRendering()
print('done=' + s(ok is True))
print('is_rendering=' + s(project.IsRenderingInProgress() is True))
`
}

/**
 * Body adding a timeline marker at an absolute record frame.
 * @param request - the marker placement.
 * @returns Python source for {@link pythonScriptOf}.
 */
export function addMarkerPython(request: DavinciMarkerRequest): string {
  return `
t = current_timeline()
if t is None:
    return
ok = t.AddMarker(${request.frame}, ${JSON.stringify(request.color)}, ${JSON.stringify(request.name)}, ${JSON.stringify(request.note)}, ${request.durationFrames ?? 1})
print('done=' + s(ok))
`
}

/** Activation and capture coordinates for the unsafe screenshot body. */
export interface DavinciScreenshotScriptRequest {
  /** Bring the Resolve `.app` to the front before the foreground check. */
  readonly activate: boolean
  /** Resolve `.app` bundle path; required when `activate` is true. */
  readonly appPath: string | undefined
  /** Directory receiving the PNG; created when absent. */
  readonly dir: string
  /** Absolute PNG path to write. */
  readonly pngPath: string
}

/**
 * Standalone `run_script_unsafe` body for `resolve_screenshot`: activate the
 * Resolve `.app` (`open`), name the frontmost application via `lsappinfo`
 * (`front` ASN, then `info -only bundleid` — the one-step `… bundleid front`
 * form returns empty on darwin 25), refuse before capturing unless Resolve is
 * frontmost, then `screencapture -x` the screen to the PNG path. The refusal
 * decision stays in the TypeScript service so its message stays verbatim; the
 * body only reports `frontmost=` (always) and `path=` (after a capture).
 * @param request - activation and capture coordinates.
 * @returns the complete Python script for `run_script_unsafe`.
 * @throws when `activate` is requested without an `appPath`.
 */
export function screenshotPython(request: DavinciScreenshotScriptRequest): string {
  if (request.activate && request.appPath === undefined) {
    throw new Error('screenshot activation requested without a Resolve app path')
  }
  const activation = request.activate
    ? `subprocess.run(['open', ${JSON.stringify(request.appPath)}], check=True, timeout=10)\n    time.sleep(0.8)\n    `
    : ''
  return `import os
import subprocess
import time

def quoted_value(text):
    close = text.find('="')
    if close >= 0:
        end = text.find('"', close + 2)
        if end > close:
            return text[close + 2:end]
    first = text.find('"')
    if first >= 0:
        end = text.find('"', first + 1)
        if end > first:
            return text[first + 1:end]
    return ''

def _main():
    ${activation}front = ''
    try:
        asn = subprocess.run(['lsappinfo', 'front'], capture_output=True, text=True, timeout=5).stdout.strip()
        if asn != '':
            info = subprocess.run(['lsappinfo', 'info', '-only', 'bundleid', asn], capture_output=True, text=True, timeout=5).stdout
            front = quoted_value(info)
    except Exception:
        front = ''  # lsappinfo failed; report the unknown-front refusal like the old shell path
    print('frontmost=' + front)
    if front != 'com.blackmagic-design.DaVinciResolve':
        return
    os.makedirs(${JSON.stringify(request.dir)}, exist_ok=True)
    subprocess.run(['screencapture', '-x', ${JSON.stringify(request.pngPath)}], check=True, timeout=10)
    print('path=' + ${JSON.stringify(request.pngPath)})

_main()
`
}
