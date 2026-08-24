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
import type { DavinciDeleteRequest, DavinciMarkerRequest, DavinciPlaceRequest } from './types.ts'

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
 * Body placing a bin clip onto the current timeline with overwrite semantics.
 * @param request - the placement coordinates.
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
local ok = pool:AppendToTimeline({target}, {
  timeline = t,
  trackType = "video",
  trackIndex = ${request.trackIndex},
  recordFrame = ${request.recordFrame},
  insertType = "overwrite",
})
print("done=" .. tostring(ok))`
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
