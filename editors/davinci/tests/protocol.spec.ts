import { describe, expect, it } from 'vitest'
import {
  clampTimeout,
  findByTcFrom,
  findClipFrom,
  mediaPoolFrom,
  mutationFrom,
  parseOutput,
  projectInfoFrom,
  seekFrom,
  stripBanner,
  switchTimelineFrom,
  timelineItemsFrom,
} from '../src/protocol.ts'

describe('stripBanner', () => {
  it('drops banner and blank lines, keeps content', () => {
    const raw = [
      'DaVinci Resolve Script Interpreter 20.0',
      'Copyright (C) 2013-2026 Blackmagic Design',
      '',
      'Shell cwd was reset to /tmp',
      'resolve_version=20.0',
      '',
    ].join('\n')
    expect(stripBanner(raw)).toBe('resolve_version=20.0')
  })

  it('keeps lines that merely contain banner words', () => {
    expect(stripBanner('timeline_1=Copyright matters')).toBe('timeline_1=Copyright matters')
  })
})

describe('parseOutput', () => {
  it('collects key=value fields, splitting at the first =', () => {
    const parsed = parseOutput('a=1\nclip_1_name=my=clip\n')
    expect(parsed.status).toBe('ok')
    expect(parsed.fields.get('a')).toBe('1')
    expect(parsed.fields.get('clip_1_name')).toBe('my=clip')
  })

  it('surfaces a coded ERROR line as a typed failure', () => {
    const parsed = parseOutput('ERROR bin-not-found: VFX')
    expect(parsed).toMatchObject({ status: 'error', code: 'bin-not-found', message: 'VFX' })
  })

  it('collapses an unknown code to api-failed', () => {
    const parsed = parseOutput('ERROR mystery: boom')
    expect(parsed.code).toBe('api-failed')
    expect(parsed.message).toBe('boom')
  })

  it('keeps a colon-less ERROR message whole', () => {
    const parsed = parseOutput('ERROR boom')
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed', message: 'boom' })
  })
})

function fieldsOf(entries: readonly [string, string][]): ReadonlyMap<string, string> {
  return new Map(entries)
}

describe('projections', () => {
  it('projectInfoFrom reads timelines and current facts', () => {
    const info = projectInfoFrom(fieldsOf([
      ['resolve_version', '20.0'],
      ['project_name', 'Show'],
      ['timeline_count', '2'],
      ['timeline_1', 'Main'],
      ['timeline_2', 'Alt'],
      ['current_timeline', 'Main'],
      ['current_start', '0'],
      ['current_end', '2500'],
      ['video_tracks', '3'],
      ['audio_tracks', '4'],
    ]))
    expect(info).toEqual({
      resolveVersion: '20.0',
      projectName: 'Show',
      timelines: ['Main', 'Alt'],
      currentTimeline: 'Main',
      currentStartFrame: 0,
      currentEndFrame: 2500,
      videoTracks: 3,
      audioTracks: 4,
    })
  })

  it('projectInfoFrom treats nil and missing as absent', () => {
    const info = projectInfoFrom(fieldsOf([
      ['resolve_version', 'nil'],
      ['project_name', 'Show'],
      ['timeline_count', '0'],
    ]))
    expect(info.resolveVersion).toBe('')
    expect(info.currentTimeline).toBeUndefined()
    expect(info.videoTracks).toBeUndefined()
  })

  it('mediaPoolFrom reads bins and clip rows', () => {
    const info = mediaPoolFrom(fieldsOf([
      ['bin_count', '1'],
      ['bin_1_name', 'VFX'],
      ['bin_1_clips', '2'],
      ['clip_count', '1'],
      ['clip_1_name', 'shot_010'],
      ['clip_1_tc', '01:00:00:00'],
      ['clip_1_duration', '00:00:04:00'],
      ['clip_1_fps', '25'],
      ['clip_1_path', '/tmp/shot_010.mov'],
    ]))
    expect(info.bins).toEqual([{ name: 'VFX', clipCount: 2 }])
    expect(info.clips).toEqual([{
      name: 'shot_010',
      startTc: '01:00:00:00',
      duration: '00:00:04:00',
      fps: '25',
      filePath: '/tmp/shot_010.mov',
    }])
  })

  it('timelineItemsFrom parses rows and caps the window at MAX_LISTED_ITEMS', () => {
    const small = timelineItemsFrom(fieldsOf([
      ['total', '2'],
      ['shown', '2'],
      ['item_1_name', 'a'],
      ['item_1_start', '0'],
      ['item_1_end', '100'],
      ['item_1_srctc', '01:00:00:00'],
      ['item_2_name', 'b'],
      ['item_2_start', '100'],
      ['item_2_end', '200'],
    ]))
    expect(small).toEqual({
      total: 2,
      shown: 2,
      items: [
        { name: 'a', startFrame: 0, endFrame: 100, sourceTc: '01:00:00:00' },
        { name: 'b', startFrame: 100, endFrame: 200, sourceTc: undefined },
      ],
    })

    const truncated = timelineItemsFrom(fieldsOf([
      ['total', '300'],
      ['shown', '300'],
      ['item_1_name', 'a'],
      ['item_1_start', '0'],
      ['item_1_end', '100'],
    ]))
    expect(truncated.total).toBe(300)
    expect(truncated.items).toHaveLength(200)
    expect(truncated.items[0]).toEqual({ name: 'a', startFrame: 0, endFrame: 100, sourceTc: undefined })
  })

  it('findByTcFrom reads scan facts and hits', () => {
    const info = findByTcFrom(fieldsOf([
      ['fps', '25'],
      ['target_frames', '90000'],
      ['scanned', '42'],
      ['hits', '1'],
      ['hit_1_name', 'shot_010'],
      ['hit_1_start', '500'],
      ['hit_1_end', '600'],
      ['hit_1_srctc', '01:00:00:00'],
      ['hit_1_frames', '100'],
    ]))
    expect(info.fps).toBe(25)
    expect(info.scanned).toBe(42)
    expect(info.hits).toEqual([{
      name: 'shot_010',
      recordStart: 500,
      recordEnd: 600,
      sourceTc: '01:00:00:00',
      frames: 100,
    }])
  })

  it('findClipFrom reads scan count and placements', () => {
    const info = findClipFrom(fieldsOf([
      ['scanned', '1500'],
      ['hits', '1'],
      ['hit_1_timeline', 'EP04_20260129'],
      ['hit_1_track', '8'],
      ['hit_1_name', 'ZY_EP03_6585_CMP_v001.mov'],
      ['hit_1_start', '7700'],
      ['hit_1_end', '7764'],
    ]))
    expect(info.scanned).toBe(1500)
    expect(info.hits).toEqual([{
      timeline: 'EP04_20260129',
      trackIndex: 8,
      name: 'ZY_EP03_6585_CMP_v001.mov',
      recordStart: 7700,
      recordEnd: 7764,
    }])
  })

  it('seekFrom maps a refused move to an api-failed result', () => {
    expect(seekFrom(fieldsOf([['seek_ok', 'true'], ['now_at', '00:00:20:00']]))).toEqual({
      ok: true,
      data: { ok: true, nowAt: '00:00:20:00' },
    })
    expect(seekFrom(fieldsOf([['seek_ok', 'false'], ['now_at', '00:00:19:00']]))).toMatchObject({
      ok: false,
      code: 'api-failed',
    })
  })

  it('switchTimelineFrom reads the switch facts and maps a refusal to api-failed', () => {
    expect(switchTimelineFrom(fieldsOf([
      ['switched', 'true'],
      ['previous_timeline', 'Main'],
      ['timeline_name', 'EP04_20260129'],
      ['timeline_index', '3'],
    ]))).toEqual({
      ok: true,
      data: { timelineName: 'EP04_20260129', timelineIndex: 3, previousTimelineName: 'Main' },
    })
    expect(switchTimelineFrom(fieldsOf([['switched', 'false'], ['previous_timeline', 'Main']]))).toMatchObject({
      ok: false,
      code: 'api-failed',
    })
  })

  it('mutationFrom maps a Resolve refusal to an api-failed result', () => {
    expect(mutationFrom(fieldsOf([['done', 'true']]), 'AddMarker')).toEqual({ ok: true, data: { done: true } })
    expect(mutationFrom(fieldsOf([['done', 'false']]), 'AddMarker')).toMatchObject({ ok: false, code: 'api-failed' })
  })
})

describe('clampTimeout', () => {
  it('uses the default when omitted and clamps to max and floor', () => {
    expect(clampTimeout(undefined, 30_000, 120_000)).toBe(30_000)
    expect(clampTimeout(999_000, 30_000, 120_000)).toBe(120_000)
    expect(clampTimeout(10, 30_000, 120_000)).toBe(1_000)
    expect(clampTimeout(45_000, 30_000, 120_000)).toBe(45_000)
  })
})
