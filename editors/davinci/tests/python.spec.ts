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
import { addRenderJobFrom, deleteRenderJobFrom, parseOutput } from '../src/protocol.ts'

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

  it('snapshots the queue id set before the call and resolves the new id by set difference', () => {
    const body = addRenderJobPython({ targetDir: '/tmp/dsh-render-test' })
    expect(body.indexOf('pre_ids = queue_ids()')).toBeLessThan(body.indexOf('project.AddRenderJob(settings)'))
    expect(body).toContain('if i not in baseline and i not in fresh')
    // The stale first-row overwrite this replaced indexed row 0 unconditionally.
    expect(body).not.toContain('jobs[0]')
  })

  it('bounds the enqueue to one sanctioned retry and refuses ambiguous deltas', () => {
    const body = addRenderJobPython({ targetDir: '/tmp/dsh-render-test' })
    expect(body).toContain('while attempts < 2:')
    expect(body).toContain('ERROR ambiguous-job:')
  })

  it('targets only the passed id and keeps the delete path free of any clear-queue fallback', () => {
    const body = deleteRenderJobPython({ jobId: '4f7b2c31-9c2a-4b1e-8b0d-1f2a3c4d5e6f' })
    expect(body).toContain('project.DeleteRenderJob(job_id)')
    expect(body).not.toContain('DeleteAllRenderJobs')
    // done=true prints only after the read-back confirmed the id left the queue.
    expect(body.indexOf('still_queued')).toBeGreaterThan(0)
    expect(body.indexOf("if still_queued:")).toBeLessThan(body.indexOf("print('done=true')"))
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

/**
 * Driver that executes one generated body against a fake `project`/`resolve`
 * pair: queue snapshots are consumed one per `GetRenderJobList` call (a
 * `null` entry means the host returned None, i.e. a failed read), add/delete
 * returns repeat their last scripted value, and every host mutation is
 * recorded so tests can prove what the body actually did.
 */
const FAKE_PROJECT_DRIVER = `
import io
import json
import runpy
import sys

scenario = json.load(open(sys.argv[2], encoding='utf-8'))


class FakeTimeline:
    def __init__(self, name):
        self._name = name

    def GetName(self):
        return self._name


class FakeProject:
    def __init__(self, scenario):
        self.snapshots = list(scenario.get('queue_snapshots') or [])
        self.last_queue = []
        self.add_returns = list(scenario.get('add_returns') or [])
        self.add_raises = bool(scenario.get('add_raises'))
        self.add_calls = []
        self.delete_returns = list(scenario.get('delete_returns') or [])
        self.delete_raises = bool(scenario.get('delete_raises'))
        self.delete_calls = []
        self.timeline = FakeTimeline(scenario.get('timeline_name') or 'EP04_20260129')

    def GetMediaPool(self):
        return None

    def GetCurrentTimeline(self):
        return self.timeline

    def GetRenderJobList(self):
        if self.snapshots:
            self.last_queue = self.snapshots.pop(0)
        if self.last_queue is None:
            return None
        return [dict(row) for row in self.last_queue]

    def AddRenderJob(self, settings):
        self.add_calls.append(dict(settings))
        if self.add_raises:
            raise RuntimeError('AddRenderJob exploded')
        if self.add_returns:
            value = self.add_returns.pop(0)
            self.add_returns.append(value)
            return value
        return ''

    def DeleteRenderJob(self, job_id):
        self.delete_calls.append(job_id)
        if self.delete_raises:
            raise RuntimeError('DeleteRenderJob exploded')
        if self.delete_returns:
            value = self.delete_returns.pop(0)
            self.delete_returns.append(value)
            return value
        return True


project = FakeProject(scenario)
namespace = {'resolve': 'fake-resolve', 'project': project}
buffer = io.StringIO()
real_stdout = sys.stdout
sys.stdout = buffer
try:
    runpy.run_path(sys.argv[1], init_globals=namespace, run_name='dsh_davinci_body')
finally:
    sys.stdout = real_stdout
print(buffer.getvalue(), end='')
print('CALLS ' + json.dumps({'add_calls': project.add_calls, 'delete_calls': project.delete_calls}))
`

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

/** One executed-body outcome: the captured kv output plus the recorded host mutations. */
interface FakeProjectRun {
  readonly output: string
  readonly addCalls: { readonly targetDir: string }[]
  readonly deleteCalls: string[]
}

function runBodyWithFakeProject(body: string, scenario: Record<string, unknown>): FakeProjectRun {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-davinci-behave-'))
  try {
    const bodyFile = join(dir, 'body.py')
    writeFileSync(bodyFile, pythonScriptOf(body), 'utf8')
    const scenarioFile = join(dir, 'scenario.json')
    writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
    const driverFile = join(dir, 'driver.py')
    writeFileSync(driverFile, FAKE_PROJECT_DRIVER, 'utf8')
    const stdout = execFileSync('python3', [driverFile, bodyFile, scenarioFile], { encoding: 'utf8' })
    const lines = stdout.split('\n')
    const callsIndex = lines.findIndex((line) => line.startsWith('CALLS '))
    const callsLine = lines[callsIndex]
    if (callsLine === undefined) throw new Error('fake-project driver reported no CALLS line')
    const calls = JSON.parse(callsLine.slice('CALLS '.length)) as {
      add_calls: { readonly targetDir: string }[]
      delete_calls: string[]
    }
    return { output: lines.slice(0, callsIndex).join('\n'), addCalls: calls.add_calls, deleteCalls: calls.delete_calls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('addRenderJobPython empty-return defense (executed against a fake project)', () => {
  it.skipIf(!python3Available)('resolves an empty return by queue read-back when exactly one new id appears', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [
        [{ JobId: 'job-a', RenderJobName: 'A' }],
        [{ JobId: 'job-a', RenderJobName: 'A' }, { JobId: 'job-new', RenderJobName: 'New' }],
      ],
      add_returns: [''],
    })
    expect(parseOutput(run.output).status).toBe('ok')
    expect(addRenderJobFrom(parseOutput(run.output).fields)).toEqual({
      ok: true,
      data: { jobCount: 2, firstJobName: 'New', jobId: 'job-new', idSource: 'read-back' },
    })
    expect(run.addCalls).toEqual([{ targetDir: '/tmp/dsh-render-test' }])
  })

  it.skipIf(!python3Available)('refuses with ambiguous-job when several new ids appear, without retrying or guessing', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [
        [{ JobId: 'job-a' }],
        [{ JobId: 'job-a' }, { JobId: 'job-n1' }, { JobId: 'job-n2' }],
      ],
      add_returns: [''],
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'ambiguous-job' })
    expect(parsed.message).toContain('job-n1')
    expect(parsed.message).toContain('job-n2')
    expect(run.addCalls).toHaveLength(1)
  })

  it.skipIf(!python3Available)('retries exactly once after a provably empty first attempt, then confirms by read-back', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [
        [{ JobId: 'job-a' }],
        [{ JobId: 'job-a' }],
        [{ JobId: 'job-a' }, { JobId: 'job-new', RenderJobName: 'New' }],
      ],
      add_returns: [''],
    })
    expect(parseOutput(run.output).status).toBe('ok')
    expect(addRenderJobFrom(parseOutput(run.output).fields)).toMatchObject({
      ok: true,
      data: { jobId: 'job-new', idSource: 'read-back' },
    })
    expect(run.addCalls).toHaveLength(2)
  })

  it.skipIf(!python3Available)('gives up after the one sanctioned retry and reports that nothing was queued', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [[{ JobId: 'job-a' }], [{ JobId: 'job-a' }], [{ JobId: 'job-a' }]],
      add_returns: [''],
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed' })
    expect(parsed.message).toContain('never grew')
    expect(run.addCalls).toHaveLength(2)
  })

  it.skipIf(!python3Available)('trusts a direct id return without any retry or read-back requirement', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [[{ JobId: 'job-a' }]],
      add_returns: ['job-9'],
    })
    expect(parseOutput(run.output).status).toBe('ok')
    expect(addRenderJobFrom(parseOutput(run.output).fields)).toEqual({
      ok: true,
      data: { jobCount: 1, firstJobName: 'EP04_20260129', jobId: 'job-9', idSource: 'returned' },
    })
    expect(run.addCalls).toHaveLength(1)
  })

  it.skipIf(!python3Available)('extracts the id from a dict-shaped AddRenderJob return', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [[{ JobId: 'job-a' }]],
      add_returns: [{ JobId: 'job-dict' }],
    })
    expect(parseOutput(run.output).status).toBe('ok')
    expect(addRenderJobFrom(parseOutput(run.output).fields)).toMatchObject({
      ok: true,
      data: { jobId: 'job-dict', idSource: 'returned' },
    })
  })

  it.skipIf(!python3Available)('refuses to enqueue at all when the pre-call queue read fails', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [null],
      add_returns: [''],
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed' })
    expect(parsed.message).toContain('before enqueue')
    expect(run.addCalls).toHaveLength(0)
  })

  it.skipIf(!python3Available)('reports a raising AddRenderJob as an unknown outcome without retrying', () => {
    const run = runBodyWithFakeProject(addRenderJobPython({ targetDir: '/tmp/dsh-render-test' }), {
      queue_snapshots: [[{ JobId: 'job-a' }]],
      add_raises: true,
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed' })
    expect(parsed.message).toContain('unknown')
    expect(run.addCalls).toHaveLength(1)
  })
})

describe('deleteRenderJobPython targeted delete (executed against a fake project)', () => {
  it.skipIf(!python3Available)('deletes the passed id and confirms by read-back that it left the queue', () => {
    const run = runBodyWithFakeProject(deleteRenderJobPython({ jobId: 'job-a' }), {
      queue_snapshots: [
        [{ JobId: 'job-a', RenderJobName: 'A' }, { JobId: 'job-b', RenderJobName: 'B' }],
        [{ JobId: 'job-b', RenderJobName: 'B' }],
      ],
    })
    expect(parseOutput(run.output).status).toBe('ok')
    expect(deleteRenderJobFrom(parseOutput(run.output).fields)).toEqual({
      ok: true,
      data: { done: true, jobId: 'job-a', jobCountAfter: 1 },
    })
    expect(run.deleteCalls).toEqual(['job-a'])
  })

  it.skipIf(!python3Available)('refuses job-not-found for a missing target and never calls the host delete', () => {
    const run = runBodyWithFakeProject(deleteRenderJobPython({ jobId: 'job-x' }), {
      queue_snapshots: [[{ JobId: 'job-a' }, { JobId: 'job-b' }]],
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'job-not-found' })
    expect(parsed.message).toContain('job-x')
    expect(run.deleteCalls).toHaveLength(0)
  })

  it.skipIf(!python3Available)('refuses job-not-found on an empty queue', () => {
    const run = runBodyWithFakeProject(deleteRenderJobPython({ jobId: 'job-a' }), {
      queue_snapshots: [[]],
    })
    expect(parseOutput(run.output)).toMatchObject({ status: 'error', code: 'job-not-found' })
    expect(run.deleteCalls).toHaveLength(0)
  })

  it.skipIf(!python3Available)('refuses job-not-found on an empty id before touching the queue', () => {
    const run = runBodyWithFakeProject(deleteRenderJobPython({ jobId: '' }), {
      queue_snapshots: [[{ JobId: 'job-a' }]],
    })
    expect(parseOutput(run.output)).toMatchObject({ status: 'error', code: 'job-not-found' })
    expect(run.deleteCalls).toHaveLength(0)
  })

  it.skipIf(!python3Available)('fails loud when the delete reports success but the target is still queued', () => {
    const run = runBodyWithFakeProject(deleteRenderJobPython({ jobId: 'job-a' }), {
      queue_snapshots: [
        [{ JobId: 'job-a' }, { JobId: 'job-b' }],
        [{ JobId: 'job-a' }, { JobId: 'job-b' }],
      ],
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed' })
    expect(parsed.message).toContain('still queued')
    // exactly one delete of exactly the target: no re-delete, no widening
    expect(run.deleteCalls).toEqual(['job-a'])
  })

  it.skipIf(!python3Available)('reports a raising delete as an unknown outcome, still targeting only the passed id', () => {
    const run = runBodyWithFakeProject(deleteRenderJobPython({ jobId: 'job-a' }), {
      queue_snapshots: [[{ JobId: 'job-a' }, { JobId: 'job-b' }]],
      delete_raises: true,
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed' })
    expect(parsed.message).toContain('unknown')
    expect(run.deleteCalls).toEqual(['job-a'])
  })

  it.skipIf(!python3Available)('fails loud when the post-delete read-back cannot be read', () => {
    const run = runBodyWithFakeProject(deleteRenderJobPython({ jobId: 'job-a' }), {
      queue_snapshots: [[{ JobId: 'job-a' }], null],
    })
    const parsed = parseOutput(run.output)
    expect(parsed).toMatchObject({ status: 'error', code: 'api-failed' })
    expect(parsed.message).toContain('read-back failed')
    expect(run.deleteCalls).toEqual(['job-a'])
  })
})
