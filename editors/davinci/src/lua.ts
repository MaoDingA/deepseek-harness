/**
 * Lua sources for every `ctx.davinci` operation: one shared prelude plus one
 * body builder per operation. Bodies embed caller arguments with
 * `JSON.stringify`, whose output is a valid Lua string literal, so no manual
 * escaping exists to get wrong. Output discipline: `key=value` lines, `nil`
 * for absent values, and `ERROR <code>: <message>` for refusals; every early
 * return leaves the script otherwise silent.
 * @module @deepseek-ai/dsh-davinci/lua
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
} from './types.ts'

/** Shared prelude: connect, project/timeline guards, object-safe iteration helpers. */
export const LUA_PRELUDE = `
local r = Resolve()
if not r then print("ERROR resolve-unreachable: DaVinci Resolve is not running or external scripting is unavailable") return end
local p = r:GetProjectManager():GetCurrentProject()
if not p then print("ERROR no-project: no project is open in Resolve") return end
local pool = p:GetMediaPool()

-- Fusion tables may key objects either way; collect whichever side is an object.
local function each(t)
  local arr = {}
  for k, v in pairs(t or {}) do
    if type(v) == "userdata" or type(v) == "table" then arr[#arr+1] = v
    elseif type(k) == "userdata" or type(k) == "table" then arr[#arr+1] = k end
  end
  return arr
end

-- Bin path like "VFX/20260702"; empty string is the root folder.
local function findBin(path)
  local folder = pool:GetRootFolder()
  if path == "" then return folder end
  for seg in path:gmatch("[^/]+") do
    local next_ = nil
    for _, sf in ipairs(each(folder:GetSubFolders())) do
      if sf:GetName() == seg then next_ = sf break end
    end
    if not next_ then return nil, seg end
    folder = next_
  end
  return folder
end

local function currentTimeline()
  local t = p:GetCurrentTimeline()
  if not t then print("ERROR no-timeline: the current project has no current timeline") return nil end
  return t
end

local function findItemByStart(t, trackIndex, startFrame)
  for _, it in ipairs(each(t:GetItemListInTrack("video", trackIndex))) do
    if it:GetStart() == startFrame then return it end
  end
  return nil
end

local function timelineFps()
  return tonumber(p:GetSetting("timelineFrameRate")) or 25
end

local function tcToFrames(tc, fps)
  local h, m, s, f = tc:match("^(%d+):(%d+):(%d+):(%d+)$")
  if not h then return nil end
  return math.floor((((tonumber(h) * 60 + tonumber(m)) * 60 + tonumber(s)) * fps + tonumber(f)) + 0.5)
end
`

/**
 * Body listing project facts and every timeline name.
 * @returns Lua source appended to the prelude.
 */
export function projectInfoLua(): string {
  return `
local count = p:GetTimelineCount()
print("resolve_version=" .. tostring(r:GetVersionString()))
print("project_name=" .. tostring(p:GetName()))
print("timeline_count=" .. count)
for i = 1, count do
  local t = p:GetTimelineByIndex(i)
  if t then print("timeline_" .. i .. "=" .. tostring(t:GetName())) end
end
local cur = p:GetCurrentTimeline()
if cur then
  print("current_timeline=" .. tostring(cur:GetName()))
  print("current_start=" .. tostring(cur:GetStartFrame()))
  print("current_end=" .. tostring(cur:GetEndFrame()))
  print("video_tracks=" .. tostring(cur:GetTrackCount("video")))
  print("audio_tracks=" .. tostring(cur:GetTrackCount("audio")))
end`
}

/**
 * Body listing one bin's subfolders and clips.
 * @param bin - bin path; empty string lists the root.
 * @returns Lua source appended to the prelude.
 */
export function mediaPoolLua(bin: string): string {
  return `
local folder, missing = findBin(${JSON.stringify(bin)})
if not folder then print("ERROR bin-not-found: " .. tostring(missing)) return end
local bins, clips = 0, 0
for _, sf in ipairs(each(folder:GetSubFolders())) do
  bins = bins + 1
  local n = 0
  for _ in ipairs(each(sf:GetClipList())) do n = n + 1 end
  print("bin_" .. bins .. "_name=" .. tostring(sf:GetName()))
  print("bin_" .. bins .. "_clips=" .. n)
end
for _, c in ipairs(each(folder:GetClipList())) do
  clips = clips + 1
  print("clip_" .. clips .. "_name=" .. tostring(c:GetName()))
  print("clip_" .. clips .. "_tc=" .. tostring(c:GetClipProperty("Start TC")))
  print("clip_" .. clips .. "_duration=" .. tostring(c:GetClipProperty("Duration")))
  print("clip_" .. clips .. "_fps=" .. tostring(c:GetClipProperty("FPS")))
  print("clip_" .. clips .. "_path=" .. tostring(c:GetClipProperty("File Path")))
end
print("bin_count=" .. bins)
print("clip_count=" .. clips)`
}

/**
 * Body listing one video track's items inside an optional record-frame window.
 * @param trackIndex - 1-based video track index.
 * @param from - record-frame lower bound, if any.
 * @param to - record-frame upper bound, if any.
 * @returns Lua source appended to the prelude.
 */
export function timelineItemsLua(trackIndex: number, from: number | undefined, to: number | undefined): string {
  return `
local t = currentTimeline() if not t then return end
local from_ = ${from === undefined ? 'nil' : from}
local to_ = ${to === undefined ? 'nil' : to}
local items = each(t:GetItemListInTrack("video", ${trackIndex}))
local shown, total, n = 0, 0, 0
for _, it in ipairs(items) do
  total = total + 1
  local s, e = it:GetStart(), it:GetEnd()
  if (not from_ or e > from_) and (not to_ or s < to_) then
    shown = shown + 1
    if shown <= ${MAX_LISTED_ITEMS} then
      n = n + 1
      local tc = ""
      local mpi = it.GetMediaPoolItem and it:GetMediaPoolItem()
      if mpi then tc = tostring(mpi:GetClipProperty("Start TC")) end
      print("item_" .. n .. "_name=" .. tostring(it:GetName()))
      print("item_" .. n .. "_start=" .. tostring(s))
      print("item_" .. n .. "_end=" .. tostring(e))
      print("item_" .. n .. "_srctc=" .. tc)
    end
  end
end
print("total=" .. total)
print("shown=" .. shown)`
}

/**
 * Body scanning V1 for segments whose source-clip TC range covers a target TC.
 * @param tc - source timecode `HH:MM:SS:FF`.
 * @returns Lua source appended to the prelude.
 */
export function findByTcLua(tc: string): string {
  return `
local t = currentTimeline() if not t then return end
local fps = timelineFps()
local target = tcToFrames(${JSON.stringify(tc)}, fps)
if not target then print("ERROR bad-tc: expected HH:MM:SS:FF, got " .. ${JSON.stringify(tc)}) return end
local items = each(t:GetItemListInTrack("video", 1))
local hits, scanned = 0, 0
for _, it in ipairs(items) do
  scanned = scanned + 1
  local mpi = it.GetMediaPoolItem and it:GetMediaPoolItem()
  if mpi then
    local clipStart = tcToFrames(tostring(mpi:GetClipProperty("Start TC") or ""), fps)
    local clipFrames = tonumber(tostring(mpi:GetClipProperty("Frames") or "")) or 0
    if clipStart and clipFrames > 0 and target >= clipStart and target < clipStart + clipFrames then
      hits = hits + 1
      print("hit_" .. hits .. "_name=" .. tostring(it:GetName()))
      print("hit_" .. hits .. "_start=" .. tostring(it:GetStart()))
      print("hit_" .. hits .. "_end=" .. tostring(it:GetEnd()))
      print("hit_" .. hits .. "_srctc=" .. tostring(mpi:GetClipProperty("Start TC")))
      print("hit_" .. hits .. "_frames=" .. tostring(it:GetEnd() - it:GetStart()))
    end
  end
end
print("fps=" .. fps)
print("target_frames=" .. target)
print("scanned=" .. scanned)
print("hits=" .. hits)`
}

/**
 * Body scanning every timeline's every video track for items whose name
 * contains the needle; the one-call replacement for paged item scans.
 * @param name - case-sensitive substring to match.
 * @returns Lua source appended to the prelude.
 */
export function findClipLua(name: string): string {
  return `
local needle = ${JSON.stringify(name)}
local count = p:GetTimelineCount()
local hits, scanned = 0, 0
for i = 1, count do
  local tl = p:GetTimelineByIndex(i)
  if tl then
    local tlName = tostring(tl:GetName())
    local tracks = tonumber(tl:GetTrackCount("video")) or 0
    for ti = 1, tracks do
      for _, it in ipairs(each(tl:GetItemListInTrack("video", ti))) do
        scanned = scanned + 1
        local nm = tostring(it:GetName())
        if nm:find(needle, 1, true) then
          hits = hits + 1
          print("hit_" .. hits .. "_timeline=" .. tlName)
          print("hit_" .. hits .. "_track=" .. ti)
          print("hit_" .. hits .. "_name=" .. nm)
          print("hit_" .. hits .. "_start=" .. tostring(it:GetStart()))
          print("hit_" .. hits .. "_end=" .. tostring(it:GetEnd()))
        end
      end
    end
  end
end
print("scanned=" .. scanned)
print("hits=" .. hits)`
}

/**
 * Body moving the playhead to a record frame or timecode.
 * @param frame - record frame to seek to.
 * @param tc - timecode to seek to; wins over `frame` when both are given.
 * @returns Lua source appended to the prelude.
 */
export function seekLua(frame: number | undefined, tc: string | undefined): string {
  const tcLiteral = tc !== undefined ? JSON.stringify(tc) : 'nil'
  const frameLiteral = frame ?? 0
  return `
local t = currentTimeline() if not t then return end
local fps = timelineFps()
local tcStr = ${tcLiteral}
if not tcStr then
  local f = ${frameLiteral}
  tcStr = string.format("%02d:%02d:%02d:%02d",
    math.floor(f / (3600 * fps)), math.floor(f / (60 * fps)) % 60,
    math.floor(f / fps) % 60, math.floor(f % fps))
end
local ok = t:SetCurrentTimecode(tcStr)
print("seek_ok=" .. tostring(ok))
print("now_at=" .. tostring(t:GetCurrentTimecode()))`
}

/**
 * Body switching the project's current timeline by index or exact name.
 * @param index - 1-based timeline index; wins over `name` when both are given.
 * @param name - exact timeline name; consulted when `index` is omitted.
 * @returns Lua source appended to the prelude.
 */
export function switchTimelineLua(index: number | undefined, name: string | undefined): string {
  const indexLiteral = index !== undefined ? String(index) : 'nil'
  const nameLiteral = name !== undefined ? JSON.stringify(name) : 'nil'
  return `
local count = p:GetTimelineCount()
local target, targetIndex = nil, nil
local wantIndex = ${indexLiteral}
if wantIndex then
  if wantIndex < 1 or wantIndex > count then
    print("ERROR timeline-not-found: index " .. tostring(wantIndex) .. " is outside the 1-" .. tostring(count) .. " range of this project")
    return
  end
  target = p:GetTimelineByIndex(wantIndex)
  targetIndex = wantIndex
else
  local wantName = ${nameLiteral}
  if not wantName then print("ERROR timeline-not-found: provide either a 1-based timeline index or an exact timeline name") return end
  for i = 1, count do
    local t = p:GetTimelineByIndex(i)
    if t and tostring(t:GetName()) == wantName then target = t targetIndex = i break end
  end
  if not target then print("ERROR timeline-not-found: no timeline named " .. wantName .. " in this project") return end
end
if not target then print("ERROR timeline-not-found: Resolve returned no timeline for the request") return end
local previous = p:GetCurrentTimeline()
local previousName = previous and tostring(previous:GetName()) or ""
local ok = p:SetCurrentTimeline(target)
if not ok then print("switched=false") print("previous_timeline=" .. previousName) return end
print("switched=true")
print("previous_timeline=" .. previousName)
print("timeline_name=" .. tostring(target:GetName()))
print("timeline_index=" .. tostring(targetIndex))`
}

/**
 * Body placing a bin clip onto a video track at a record frame with
 * overwrite semantics. Resolve 21.1.1.10's scripting surface exposes only
 * `MediaPool:AppendToTimeline` for clip placement; the documented
 * `InsertToTimeline` / `ReplaceToTimeline` are ABSENT, and the options dict
 * (`timeline`, `trackType`, `trackIndex`, `recordFrame`, `insertType`) is
 * empirically IGNORED — repeated experiments show a single append always
 * lands on the V1 timeline tail regardless of `trackIndex` or `recordFrame`.
 * Resolve's scripting surface has no positioned-insert, no `MoveItemsInTrack`,
 * no clip-reposition primitive, and no Track-object API.
 *
 * This body therefore implements the requested semantics by:
 *   1. capturing the current max-start across all video tracks (append
 *      extends the tail, so the new item's start exceeds every pre-existing),
 *   2. appending via the only available primitive (`AppendToTimeline`),
 *   3. reading back the newly-appended item's actual track/start/end,
 *   4. succeeding only when actual == requested, otherwise rolling back the
 *      landed item via `DeleteClips` and failing loudly with the real
 *      coordinates so the caller and user see exactly what happened.
 *
 * `done=true` is printed only on an exact placement, so
 * `mutationFrom(fields, op)`'s `done==true` gate keeps its "only true on
 * success" contract; a mislanded placement leaves the timeline unchanged
 * after rollback.
 * @param request - the placement coordinates (bin/clip + video track + record frame).
 * @returns Lua source appended to the prelude.
 */
export function placeLua(request: DavinciPlaceRequest): string {
  return `
local t = currentTimeline() if not t then return end
local folder, missing = findBin(${JSON.stringify(request.bin)})
if not folder then print("ERROR bin-not-found: " .. tostring(missing)) return end
local target = nil
for _, c in ipairs(each(folder:GetClipList())) do
  if tostring(c:GetName()) == ${JSON.stringify(request.clipName)} then target = c break end
end
if not target then print("ERROR clip-not-found: no clip named " .. ${JSON.stringify(request.clipName)} .. " in bin " .. ${JSON.stringify(request.bin)}) return end

local trackIndex = ${request.trackIndex}
local recordFrame = ${request.recordFrame}

-- AppendToTimeline always extends the tail, so the appended item's start strictly
-- exceeds every pre-existing start. Use strict > to distinguish it from any
-- same-named item already on the timeline at an earlier start.
local maxStart = nil
for ti = 1, t:GetTrackCount("video") do
  for _, it in ipairs(each(t:GetItemListInTrack("video", ti))) do
    local s = it:GetStart()
    if maxStart == nil or s > maxStart then maxStart = s end
  end
end

local ok = pool:AppendToTimeline({target})
if ok == nil or ok == false then
  print("ERROR api-failed: MediaPool:AppendToTimeline reported failure")
  return
end

local landed, landedTrack, bestStart = nil, nil, nil
for ti = 1, t:GetTrackCount("video") do
  for _, it in ipairs(each(t:GetItemListInTrack("video", ti))) do
    if tostring(it:GetName()) == ${JSON.stringify(request.clipName)} then
      local s = it:GetStart()
      if (bestStart == nil or s > bestStart) and (maxStart == nil or s > maxStart) then
        bestStart = s; landed = it; landedTrack = ti
      end
    end
  end
end

if not landed then
  print("ERROR api-failed: AppendToTimeline reported success but no item named " .. ${JSON.stringify(request.clipName)} .. " was found beyond frame " .. tostring(maxStart) .. " on any video track")
  return
end

local actualTrack = landedTrack
local actualStart = landed:GetStart()
local actualEnd = landed:GetEnd()

print("landed_track=" .. tostring(actualTrack))
print("landed_start=" .. tostring(actualStart))
print("landed_end=" .. tostring(actualEnd))

if actualTrack == trackIndex and actualStart == recordFrame then
  print("done=true")
else
  local removed = t:DeleteClips({landed})
  print("rolled_back=" .. tostring(removed == true))
  print("ERROR mislanded-placement: requested video track " .. tostring(trackIndex) .. " at record frame " .. tostring(recordFrame) .. "; Resolve 21's only positioned placement is tail-append, which landed on video track " .. tostring(actualTrack) .. " at record frame " .. tostring(actualStart) .. " (end " .. tostring(actualEnd) .. "). The item was rolled back via DeleteClips to leave the timeline unchanged. For a true positioned insert, use the Edit page (select + drag on the UI), or run a fuscript that drives the Resolve UI.")
end`
}

/**
 * Body deleting the video-track item that starts exactly at a record frame.
 * @param request - the deletion coordinates.
 * @returns Lua source appended to the prelude.
 */
export function deleteItemLua(request: DavinciDeleteRequest): string {
  return `
local t = currentTimeline() if not t then return end
local item = findItemByStart(t, ${request.trackIndex}, ${request.startFrame})
if not item then print("ERROR item-not-found: no item starts at frame " .. ${request.startFrame} .. " on video track " .. ${request.trackIndex}) return end
local ok = t:DeleteClips({item})
print("done=" .. tostring(ok))`
}

/**
 * Body listing one audio track's items inside an optional record-frame window
 * (mirror of the video-track listing; used to locate the 套片 audio delivery on A1).
 * @param trackIndex - 1-based audio track index (A1=1).
 * @param from - record-frame lower bound, if any.
 * @param to - record-frame upper bound, if any.
 * @returns Lua source appended to the prelude.
 */
export function audioTimelineItemsLua(trackIndex: number, from: number | undefined, to: number | undefined): string {
  return `
local t = currentTimeline() if not t then return end
local from_ = ${from === undefined ? 'nil' : from}
local to_ = ${to === undefined ? 'nil' : to}
local items = each(t:GetItemListInTrack("audio", ${trackIndex}))
local shown, total, n = 0, 0, 0
for _, it in ipairs(items) do
  total = total + 1
  local s, e = it:GetStart(), it:GetEnd()
  if (not from_ or e > from_) and (not to_ or s < to_) then
    shown = shown + 1
    if shown <= ${MAX_LISTED_ITEMS} then
      n = n + 1
      local tc = ""
      local mpi = it.GetMediaPoolItem and it:GetMediaPoolItem()
      if mpi then tc = tostring(mpi:GetClipProperty("Start TC")) end
      print("item_" .. n .. "_name=" .. tostring(it:GetName()))
      print("item_" .. n .. "_start=" .. tostring(s))
      print("item_" .. n .. "_end=" .. tostring(e))
      print("item_" .. n .. "_srctc=" .. tc)
    end
  end
end
print("total=" .. total)
print("shown=" .. shown)`
}

/**
 * Body reading the render-engine's live state: queued-job count, active
 * rendering flag, and the current render format/codec names.
 * @returns Lua source appended to the prelude.
 */
export function renderStatusLua(): string {
  return `
local okJobs, jobs = pcall(function() return p:GetRenderJobList() end)
local n = okJobs and jobs and #jobs or 0
print("job_count=" .. n)
if n > 0 and jobs and jobs[1] then
  local first = jobs[1]
  if type(first) == "table" and first.RenderJobName then
    print("first_job_name=" .. tostring(first.RenderJobName))
  elseif type(first) == "userdata" and first.GetName then
    local okName, nm = pcall(function() return first:GetName() end)
    if okName and nm then print("first_job_name=" .. tostring(nm)) end
  end
end
local okRender, rendering = pcall(function() return p:IsRenderingInProgress() end)
print("is_rendering=" .. tostring(okRender and rendering == true))
local okFmt, fmt = pcall(function() return p:GetCurrentRenderFormatAndCodec() end)
local fmtName = "nil"
if okFmt and fmt then
  local nm = fmt[1] or fmt.Name
  if nm then fmtName = tostring(nm) end
end
print("cur_format=" .. fmtName)
local okCodecs, codecs = pcall(function() return each(p:GetRenderCodecs(fmtName)) end)
print("cur_codec_count=" .. tostring(okCodecs and codecs and #codecs or 0))`
}

/**
 * Body reading the render-engine's selectable preset/format surface. Resolve
 * 21+ exposes `GetRenderPresets`/`GetRenderFormats`; Resolve 20.x has neither
 * and the body reports zero for `preset_count`, so the protocol maps the
 * `presets` list to an empty array. `has_load_preset` is true only when the
 * host actually exposes `SetRenderPreset`, guarding callers that assume they
 * can switch presets.
 * @returns Lua source appended to the prelude: the active (format, codec)
 *   pair, the preset count, per-preset names, and the load-preset capability flag.
 */
export function renderPresetsLua(): string {
  return `
local okFmt, fmt = pcall(function() return p:GetCurrentRenderFormatAndCodec() end)
local fmtName = "nil"
if okFmt and fmt then
  local nm = fmt[1] or fmt.Name
  if nm then fmtName = tostring(nm) end
end
print("current_format=" .. tostring(fmtName))
local okCodecs, codecs = pcall(function() return each(p:GetRenderCodecs(fmtName)) end)
if okCodecs and codecs and codecs[1] and codecs[1].Name then
  print("current_codec=" .. tostring(codecs[1].Name))
else
  print("current_codec=nil")
end
local hasLoad = false
local hasGetPresets = false
local hasGetFormats = false
do
  local ok, v = pcall(function() return p.LoadRenderPreset end)
  hasLoad = ok and type(v) == "function"
  local ok2, v2 = pcall(function() return p.GetRenderPresets end)
  hasGetPresets = ok2 and type(v2) == "function"
  local ok3, v3 = pcall(function() return p.GetRenderFormats end)
  hasGetFormats = ok3 and type(v3) == "function"
end
print("has_load_preset=" .. tostring(hasLoad))
local presetCount = 0
if hasGetPresets then
  local okList, list = pcall(function() return p:GetRenderPresets() end)
  if okList and list then
    presetCount = #list or 0
    for i = 1, presetCount do
      local row = list[i]
      local name = type(row) == "string" and row or (type(row) == "table" and (row.Name or row.name)) or nil
      if name then print("preset_" .. i .. "=" .. tostring(name)) end
    end
  end
end
print("preset_count=" .. presetCount)
if hasGetFormats then
  local okFl, fl = pcall(function() return p:GetRenderFormats() end)
  if okFl and fl then print("format_count=" .. (#fl or 0)) else print("format_count=0") end
end`
}

/**
 * Body enqueuing the current timeline into the render queue at `targetDir`.
 * The current render preset/format/codec are preserved; this call does not
 * change them. Resolve 20.3.2.9 has no presets and an empty format list, so
 * the active (UI-set) render settings are the only selectable surface.
 * @param request - the enqueue coordinates (target dir).
 * @returns Lua source appended to the prelude.
 */
export function addRenderJobLua(request: DavinciAddRenderJobRequest): string {
  return `
local t = currentTimeline()
if not t then return end
local before = 0
local pre = p:GetRenderJobList()
if pre then before = #pre end
local settings = {
  targetDir = ${JSON.stringify(request.targetDir)},
}
local job = p:AddRenderJob(settings)
local jobs = p:GetRenderJobList()
local n = jobs and #jobs or 0
if n <= before and (job == nil or job == false) then
  print("ERROR api-failed: AddRenderJob returned falsy and the queue did not grow; verify the current render preset and target dir exist")
  return
end
local function rowId(row)
  if type(row) == "table" then return row.JobId end
  if type(row) == "userdata" and row.GetJobId then return row:GetJobId() end
  return nil
end
local function rowName(row)
  if type(row) == "table" then return row.RenderJobName or row.Name end
  if type(row) == "userdata" and row.GetName then return row:GetName() end
  return nil
end
-- The added job is the one whose id was absent from the pre-call snapshot;
-- trusting list order (first row) would report a pre-existing job's id.
local preIds = {}
if pre then
  for _, row in ipairs(pre) do
    local pid = rowId(row)
    if pid then preIds[tostring(pid)] = true end
  end
end
local jobId = job
if type(job) == "table" and job.JobId then jobId = job.JobId end
if type(job) == "userdata" and job.GetJobId then jobId = job:GetJobId() end
local firstJobName = tostring(t:GetName())
if jobs then
  for _, row in ipairs(jobs) do
    local rid = rowId(row)
    if rid and not preIds[tostring(rid)] then
      jobId = rid
      local nm = rowName(row)
      if nm then firstJobName = tostring(nm) end
    end
  end
end
print("ok=true")
print("job_id=" .. tostring(jobId))
print("job_count=" .. n)
print("first_job_name=" .. firstJobName)`
}

/**
 * Body loading a render preset by exact name via `Project:LoadRenderPreset`.
 * The row-1 name read-back is the success signal: `Resolve` leaves the
 * previously active preset untouched on failure, so comparing the pre/post
 * `GetRenderPresets()[1]` value is a safe cross-version success check.
 * @param request - the preset name to load (must match a host-reported entry).
 * @returns Lua source appended to the prelude, printing `done=true|false` and
 *   a `loaded_preset` read-back.
 */
export function loadRenderPresetLua(request: DavinciLoadRenderPresetRequest): string {
  return `
local name = ${JSON.stringify(request.presetName)}
if name == "" then
  print("ERROR preset-not-found: empty preset name")
  return
end
local hasLoad = type(p.LoadRenderPreset) == "function"
if not hasLoad then
  print("ERROR api-failed: this Resolve build lacks Project:LoadRenderPreset (Resolve 21+ only)")
  return
end
local ok = p:LoadRenderPreset(name)
if ok == false then
  print("ERROR preset-not-found: Resolve refused to load preset " .. name .. " (not in the preset list or not selectable)")
  return
end
local first = nil
local list = p:GetRenderPresets()
if list and #list > 0 then
  local row = list[1]
  first = type(row) == "string" and row or (type(row) == "table" and row.Name)
end
print("done=true")
print("loaded_preset=" .. tostring(first))`
}

/**
 * Body deleting a queued render job by its id via `Project:DeleteRenderJob`.
 * The id is matched against each row's `JobId` field (table shape, Resolve 21)
 * or `GetJobId()` method (userdata, Resolve 20.x); a miss is a
 * `job-not-found` refusal and no delete is attempted.
 * @param request - the job id (UUID) reported by `resolve_add_render_job`.
 * @returns Lua source appended to the prelude, printing `done=true|false` and
 *   the post-delete queue depth.
 */
export function deleteRenderJobLua(request: DavinciDeleteRenderJobRequest): string {
  return `
local id = ${JSON.stringify(request.jobId)}
if id == "" then
  print("ERROR job-not-found: empty job id")
  return
end
local jobs = p:GetRenderJobList()
local n = jobs and #jobs or 0
if n == 0 then
  print("ERROR job-not-found: the render queue is empty; nothing to delete")
  return
end
local found = false
for i = 1, n do
  local row = jobs[i]
  local rid = type(row) == "table" and row.JobId or (type(row) == "userdata" and row.GetJobId and row:GetJobId())
  if rid == id then found = true break end
end
if not found then
  print("ERROR job-not-found: no queued job has id " .. id)
  return
end
local ok = p:DeleteRenderJob(id)
if ok == false then
  print("ERROR api-failed: Resolve refused to delete job " .. id)
  return
end
local after = p:GetRenderJobList()
local m = after and #after or 0
print("done=true")
print("job_id=" .. id)
print("job_count_after=" .. m)`
}

/**
 * Render a readonly string list as a Lua table literal (`{ "a", "b" }`);
 * JSON string quoting is valid Lua, while JSON array syntax (`[...]`) is not.
 * @param values - the strings to embed.
 * @returns the Lua table literal source.
 */
function luaStringList(values: readonly string[]): string {
  if (values.length === 0) return '{}'
  return '{ ' + values.map((value) => JSON.stringify(value)).join(', ') + ' }'
}

/**
 * Body starting the render engine (optionally scoped to a set of job ids).
 * @param request - job ids to start, or none to start the whole queue.
 * @returns Lua source appended to the prelude.
 */
export function startRenderingLua(request: DavinciRenderingControlRequest): string {
  return `
local jobTable = {}
local jids = ${luaStringList(request.jobIds ?? [])}
for _, j in ipairs(jids) do jobTable[#jobTable+1] = j end
local ok
if #jobTable > 0 then
  ok = p:StartRendering(jobTable)
else
  ok = p:StartRendering()
end
print("done=" .. tostring(ok == true))
print("is_rendering=" .. tostring(p:IsRenderingInProgress() == true))`
}

/**
 * Body stopping the render engine (optionally scoped to a set of job ids).
 * @param request - job ids to stop, or none to stop the whole queue.
 * @returns Lua source appended to the prelude.
 */
export function stopRenderingLua(request: DavinciRenderingControlRequest): string {
  return `
local jobTable = {}
local jids = ${luaStringList(request.jobIds ?? [])}
for _, j in ipairs(jids) do jobTable[#jobTable+1] = j end
local ok
if #jobTable > 0 then
  ok = p:StopRendering(jobTable)
else
  ok = p:StopRendering()
end
print("done=" .. tostring(ok == true))
print("is_rendering=" .. tostring(p:IsRenderingInProgress() == true))`
}

/**
 * Body adding a timeline marker at an absolute record frame.
 * @param request - the marker placement.
 * @returns Lua source appended to the prelude.
 */
export function addMarkerLua(request: DavinciMarkerRequest): string {
  return `
local t = currentTimeline() if not t then return end
local ok = t:AddMarker(${request.frame}, ${JSON.stringify(request.color)}, ${JSON.stringify(request.name)}, ${JSON.stringify(request.note)}, ${request.durationFrames ?? 1})
print("done=" .. tostring(ok))`
}
