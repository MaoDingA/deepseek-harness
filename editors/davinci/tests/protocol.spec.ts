import { describe, expect, it } from 'vitest'
import {
  addRenderJobFrom,
  audioTimelineItemsFrom,
  clampTimeout,
  deleteRenderJobFrom,
  findByTcFrom,
  findClipFrom,
  innerResponseToRaw,
  loadRenderPresetFrom,
  mediaPoolFrom,
  mutationFrom,
  parseOutput,
  projectInfoFrom,
  renderingControlFrom,
  renderStatusFrom,
  scriptTimeoutSeconds,
  seekFrom,
  switchTimelineFrom,
  timelineItemsFrom,
} from '../src/protocol.ts'

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

  it('audioTimelineItemsFrom mirrors the video-track rows for the audio side', () => {
    const info = audioTimelineItemsFrom(fieldsOf([
      ['total', '1'],
      ['shown', '1'],
      ['item_1_name', '0130 4ji.wav'],
      ['item_1_start', '0'],
      ['item_1_end', '73862'],
      ['item_1_srctc', '03:00:00:00'],
    ]))
    expect(info).toEqual({
      total: 1,
      shown: 1,
      items: [{ name: '0130 4ji.wav', startFrame: 0, endFrame: 73862, sourceTc: '03:00:00:00' }],
    })
  })

  it('renderStatusFrom reads the live render-engine facts', () => {
    expect(renderStatusFrom(fieldsOf([
      ['job_count', '2'],
      ['first_job_name', 'EP04_20260129'],
      ['is_rendering', 'false'],
      ['cur_format', 'MP4'],
      ['cur_codec_count', '3'],
    ]))).toEqual({
      ok: true,
      data: {
        jobCount: 2,
        isRendering: false,
        currentFormat: 'MP4',
        currentCodec: undefined,
        codecCount: 3,
      },
    })
    expect(renderStatusFrom(fieldsOf([['job_count', '0'], ['is_rendering', 'true']]))).toEqual({
      ok: true,
      data: {
        jobCount: 0,
        isRendering: true,
        currentFormat: undefined,
        currentCodec: undefined,
        codecCount: undefined,
      },
    })
  })

  it('renderStatusFrom fails loud on read-failed markers instead of reporting an empty queue', () => {
    const failed = renderStatusFrom(fieldsOf([['job_count', 'read-failed'], ['is_rendering', 'read-failed']]))
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.code).toBe('api-failed')
      expect(failed.message).toContain('job_count')
      expect(failed.message).toContain('is_rendering')
    }
  })

  it('addRenderJobFrom maps the enqueue outcome, including the job id', () => {
    expect(addRenderJobFrom(fieldsOf([['ok', 'true'], ['job_id', 'job-1'], ['job_count', '1'], ['first_job_name', 'EP04_20260129']]))).toEqual({
      ok: true,
      data: { jobCount: 1, firstJobName: 'EP04_20260129', jobId: 'job-1' },
    })
    expect(addRenderJobFrom(fieldsOf([['ok', 'true'], ['job_count', '1']]))).toEqual({
      ok: true,
      data: { jobCount: 1, firstJobName: undefined, jobId: undefined },
    })
    expect(addRenderJobFrom(fieldsOf([['ok', 'false']]))).toMatchObject({ ok: false, code: 'api-failed' })
  })

  it('loadRenderPresetFrom reads the active preset and refuses on failure', () => {
    expect(loadRenderPresetFrom(fieldsOf([['done', 'true'], ['loaded_preset', 'H.264']]))).toEqual({
      ok: true,
      data: { done: true, loadedPreset: 'H.264' },
    })
    expect(loadRenderPresetFrom(fieldsOf([['done', 'false']]))).toMatchObject({ ok: false, code: 'api-failed' })
  })

  it('deleteRenderJobFrom reads the queue depth after deletion and refuses on failure', () => {
    expect(deleteRenderJobFrom(fieldsOf([['done', 'true'], ['job_id', 'job-1'], ['job_count_after', '0']]))).toEqual({
      ok: true,
      data: { done: true, jobId: 'job-1', jobCountAfter: 0 },
    })
    expect(deleteRenderJobFrom(fieldsOf([['done', 'false']]))).toMatchObject({ ok: false, code: 'api-failed' })
  })

  it('renderingControlFrom reads the control outcome for both start and stop', () => {
    expect(renderingControlFrom(fieldsOf([['done', 'true'], ['is_rendering', 'true']]), 'StartRendering')).toEqual({
      ok: true,
      data: { done: true },
    })
    expect(renderingControlFrom(fieldsOf([['done', 'true'], ['is_rendering', 'false']]), 'StopRendering')).toEqual({
      ok: true,
      data: { done: true },
    })
    expect(renderingControlFrom(fieldsOf([['done', 'false']]), 'StartRendering')).toMatchObject({ ok: false, code: 'api-failed' })
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

describe('scriptTimeoutSeconds', () => {
  it('ceils partial seconds and clamps into the run_script 1..60 range', () => {
    expect(scriptTimeoutSeconds(30_000)).toBe(30)
    expect(scriptTimeoutSeconds(1_500)).toBe(2)
    expect(scriptTimeoutSeconds(500)).toBe(1)
    expect(scriptTimeoutSeconds(60_000)).toBe(60)
    expect(scriptTimeoutSeconds(90_000)).toBe(60)
  })
})

describe('innerResponseToRaw', () => {
  it('passes a captured print payload through verbatim', () => {
    expect(innerResponseToRaw('run_script', JSON.stringify({ output: 'a=1\nb=2\n' }))).toBe('a=1\nb=2\n')
  })

  it('returns empty output when the payload carries no output field', () => {
    expect(innerResponseToRaw('run_script', JSON.stringify({ result: 42 }))).toBe('')
    expect(innerResponseToRaw('run_script', JSON.stringify({}))).toBe('')
  })

  it('maps a sandbox timeout to the timeout code with the verbatim text', () => {
    const raw = innerResponseToRaw('run_script', JSON.stringify({ error: 'Script timed out after 2s. Avoid long iterations; fetch only what you need.' }))
    const parsed = parseOutput(raw)
    expect(parsed).toMatchObject({
      status: 'error',
      code: 'timeout',
      message: 'Script timed out after 2s. Avoid long iterations; fetch only what you need.',
    })
  })

  it('maps a traceback to api-failed with only the exception line as the message', () => {
    const trace = 'Traceback (most recent call last):\n  File "<script>", line 1, in <module>\n    raise RuntimeError("boom")\nRuntimeError: boom\n'
    const parsed = parseOutput(innerResponseToRaw('run_script', JSON.stringify({ error: trace })))
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed', message: 'RuntimeError: boom' })
  })

  it('maps a SyntaxError report (no Traceback header) to the same api-failed shape', () => {
    const trace = '  File "<script>", line 23\n    print("x"\n     ^\nSyntaxError: \'(\' was never closed\n'
    const parsed = parseOutput(innerResponseToRaw('run_script', JSON.stringify({ error: trace })))
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed', message: "SyntaxError: '(' was never closed" })
  })

  it('fails loud on a non-inner-JSON reply, naming the tool', () => {
    expect(() => innerResponseToRaw('run_script_unsafe', 'Error: DaVinci Resolve Studio is not installed'))
      .toThrow(/run_script_unsafe response was not inner JSON.*DaVinci Resolve Studio is not installed/)
  })
})
