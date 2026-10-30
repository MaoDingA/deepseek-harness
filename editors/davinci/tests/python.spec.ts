import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  PYTHON_PRELUDE,
  pythonScriptOf,
  renderPresetsPython,
  renderStatusPython,
  screenshotPython,
  seekPython,
  startRenderingPython,
  stopRenderingPython,
  switchTimelinePython,
  timelineItemsPython,
} from '../src/python.ts'

describe('prelude value discipline', () => {
  it('locks the Lua-tostring parity the kv parser reads (nil/true/false literals, %.14g floats)', () => {
    expect(PYTHON_PRELUDE).toContain(`def s(v):
    # Lua tostring parity: nil/true/false literals and %.14g float rendering,
    # because the kv protocol and its TypeScript parser read those literals.
    if v is None:
        return 'nil'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, float):
        return format(v, '.14g')
    return str(v)`)
  })

  it('collects dict values, list rows, and None as empty for every collection shape', () => {
    expect(PYTHON_PRELUDE).toContain('if isinstance(t, dict):')
    expect(PYTHON_PRELUDE).toContain('return list(t.values())')
    expect(PYTHON_PRELUDE).toContain('if isinstance(t, (list, tuple)):')
    expect(PYTHON_PRELUDE).toContain('if t is None:\n        return []')
  })

  it('guards on the injected resolve/project globals inside _dsh_main', () => {
    expect(PYTHON_PRELUDE).toContain('def _dsh_main():')
    expect(PYTHON_PRELUDE).toContain('if resolve is None:')
    expect(PYTHON_PRELUDE).toContain('if project is None:')
    expect(PYTHON_PRELUDE).toContain("print('ERROR resolve-unreachable: DaVinci Resolve is not running or external scripting is unavailable')")
    expect(PYTHON_PRELUDE).toContain("print('ERROR no-project: no project is open in Resolve')")
  })
})

describe('pythonScriptOf', () => {
  it('wraps the body inside _dsh_main and appends the invocation', () => {
    const script = pythonScriptOf("print('a=1')")
    expect(script.indexOf('def _dsh_main():')).toBeLessThan(script.indexOf("    print('a=1')"))
    expect(script.trimEnd().endsWith('_dsh_main()')).toBe(true)
  })

  it('keeps blank body lines blank instead of indenting whitespace', () => {
    const script = pythonScriptOf("print('a=1')\n\nprint('b=2')")
    expect(script).toContain("    print('a=1')\n\n    print('b=2')")
  })
})

describe('render control Python body generation', () => {
  it('embeds job id lists as valid Python list literals', () => {
    for (const body of [startRenderingPython({ jobIds: [] }), stopRenderingPython({ jobIds: [] })]) {
      expect(body).toContain('jids = []')
    }
    for (const body of [
      startRenderingPython({ jobIds: ['job-1', 'job-2'] }),
      stopRenderingPython({ jobIds: ['job-1', 'job-2'] }),
    ]) {
      expect(body).toContain('jids = ["job-1","job-2"]')
    }
  })

  it('resolves the added job id by queue delta, not by list order', () => {
    const body = addRenderJobPython({ targetDir: '/tmp/dsh-render-test' })
    expect(body).toContain('pre_ids')
    expect(body).toContain('s(rid) not in pre_ids')
    // The stale first-row overwrite this replaced indexed row 0 unconditionally.
    expect(body).not.toContain('jobs[0]')
  })
})

describe('renderStatusPython fail-loud reads', () => {
  it('marks guarded render-engine reads as read-failed instead of zero', () => {
    const body = renderStatusPython()
    expect(body).toContain("print('job_count=read-failed')")
    expect(body).toContain("print('is_rendering=read-failed')")
    expect(body).toContain("print('cur_format=read-failed')")
    expect(body).toContain("print('cur_codec_count=read-failed')")
    // The pcall guards translate to per-read try/except blocks: jobs, the
    // first-job name probe, the rendering flag, the format read, the codec count.
    expect(body.match(/except Exception:/g)).toHaveLength(5)
  })
})

describe('screenshotPython unsafe body', () => {
  it('routes the OS-capability chain through run_script_unsafe', () => {
    const script = screenshotPython({ activate: false, appPath: undefined, dir: '/tmp/shots', pngPath: '/tmp/shots/a.png' })
    expect(script).toContain('import subprocess')
    expect(script).toContain("['lsappinfo', 'front']")
    expect(script).toContain("['lsappinfo', 'info', '-only', 'bundleid', asn]")
    expect(script).toContain("print('frontmost=' + front)")
    expect(script).toContain("front != 'com.blackmagic-design.DaVinciResolve'")
    expect(script).toContain("['screencapture', '-x', \"/tmp/shots/a.png\"]")
    expect(script).toContain("print('path=' + \"/tmp/shots/a.png\")")
  })

  it('activates the Resolve app before the foreground check when asked', () => {
    const script = screenshotPython({ activate: true, appPath: '/Applications/DaVinci Resolve21/DaVinci Resolve.app', dir: '/tmp/shots', pngPath: '/tmp/shots/a.png' })
    expect(script).toContain("['open', \"/Applications/DaVinci Resolve21/DaVinci Resolve.app\"]")
    expect(script).toContain('time.sleep(0.8)')
  })

  it('refuses to build an activation body without an app path', () => {
    expect(() => screenshotPython({ activate: true, appPath: undefined, dir: '/tmp/shots', pngPath: '/tmp/shots/a.png' }))
      .toThrow(/without a Resolve app path/)
  })
})

const python3Available = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('generated Python compiles', () => {
  // Syntax-only (ast.parse, no execution): every body must be valid Python on
  // any machine that has a python3; skipped where python3 is absent.
  it.skipIf(!python3Available)('parses every operation body and the screenshot script', () => {
    const bodies = [
      projectInfoPython(),
      mediaPoolPython('VFX/20260702'),
      timelineItemsPython(1, 10, 900),
      timelineItemsPython(2, undefined, undefined),
      findByTcPython('01:02:03:04'),
      findClipPython('ZY_EP04'),
      seekPython(120, undefined),
      seekPython(undefined, '00:00:04:00'),
      switchTimelinePython(2, undefined),
      switchTimelinePython(undefined, 'Main'),
      placePython({ bin: 'VFX/20260702', clipName: 'shot_010.mov', trackIndex: 2, recordFrame: 500 }),
      deleteItemPython({ trackIndex: 1, startFrame: 500 }),
      audioTimelineItemsPython(1, undefined, 73862),
      renderStatusPython(),
      renderPresetsPython(),
      addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }),
      loadRenderPresetPython({ presetName: 'H.264 Master' }),
      deleteRenderJobPython({ jobId: '4f7b2c31-9c2a-4b1e-8b0d-1f2a3c4d5e6f' }),
      startRenderingPython({ jobIds: ['job-1'] }),
      stopRenderingPython({ jobIds: undefined }),
      addMarkerPython({ frame: 500, color: 'Blue', name: 'review', note: '', durationFrames: undefined }),
    ]
    const dir = mkdtempSync(join(tmpdir(), 'dsh-davinci-py-'))
    try {
      const parse = 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())'
      for (const [index, body] of bodies.entries()) {
        const file = join(dir, `body-${index}.py`)
        writeFileSync(file, pythonScriptOf(body), 'utf8')
        execFileSync('python3', ['-c', parse, file], { stdio: 'pipe' })
      }
      const shot = join(dir, 'shot.py')
      writeFileSync(shot, screenshotPython({ activate: true, appPath: '/Applications/DaVinci Resolve21/DaVinci Resolve.app', dir: '/tmp/shots', pngPath: '/tmp/shots/a.png' }), 'utf8')
      execFileSync('python3', ['-c', parse, shot], { stdio: 'pipe' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
