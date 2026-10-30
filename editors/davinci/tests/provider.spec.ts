import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { discoverResolveMcp, McpDavinci } from '../src/provider.ts'
import { classifySpawnError } from '../src/service.ts'

const discoveryDirs: string[] = []

afterEach(() => {
  for (const dir of discoveryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.FAKE_MODE
})

function fakeApplicationsDir(installs: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-davinci-discover-'))
  discoveryDirs.push(dir)
  for (const name of installs) {
    const binary = join(dir, name, 'DaVinci Resolve.app', 'Contents', 'Applications', 'ResolveMCP')
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, '')
  }
  return dir
}

describe('discoverResolveMcp', () => {
  it('prefers the highest numbered install', () => {
    const dir = fakeApplicationsDir(['DaVinci Resolve19', 'DaVinci Resolve20'])
    expect(discoverResolveMcp(dir)).toBe(
      join(dir, 'DaVinci Resolve20', 'DaVinci Resolve.app', 'Contents', 'Applications', 'ResolveMCP'),
    )
  })

  it('falls back to an unnumbered install behind numbered ones', () => {
    const dir = fakeApplicationsDir(['DaVinci Resolve', 'DaVinci Resolve18'])
    expect(discoverResolveMcp(dir)).toContain('DaVinci Resolve18')
  })

  it('uses an unnumbered install when it is the only one', () => {
    const dir = fakeApplicationsDir(['DaVinci Resolve'])
    expect(discoverResolveMcp(dir)).toContain(join('DaVinci Resolve', 'DaVinci Resolve.app'))
  })

  it('ignores unrelated folders and returns undefined when nothing matches', () => {
    const dir = fakeApplicationsDir(['Final Cut Pro'])
    expect(discoverResolveMcp(dir)).toBeUndefined()
    expect(discoverResolveMcp(join(dir, 'does-not-exist'))).toBeUndefined()
  })
})

describe('McpDavinci.resolve', () => {
  it('keeps explicit paths and applies timeout defaults and caps', () => {
    const ctx = new Context()
    const service = new McpDavinci(ctx, { mcpServerPath: '/x/server/index.js', resolveMcpPath: '/x/ResolveMCP' })
    expect(service.resolve({})).toEqual({
      mcpServerPath: '/x/server/index.js',
      resolveMcpPath: '/x/ResolveMCP',
      timeoutMs: 30_000,
    })
    expect(service.resolve({ timeoutMs: 999_000 }).timeoutMs).toBe(60_000)
    expect(service.resolve({ timeoutMs: 45_000 }).timeoutMs).toBe(45_000)
    expect(service.resolve({ timeoutMs: 1 }).timeoutMs).toBe(1_000)
  })

  it('honors configured default and cap over the built-in ones', () => {
    const ctx = new Context()
    const service = new McpDavinci(ctx, {
      mcpServerPath: '/x/server/index.js',
      resolveMcpPath: '/x/ResolveMCP',
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 6_000,
    })
    expect(service.resolve({}).timeoutMs).toBe(5_000)
    expect(service.resolve({ timeoutMs: 9_000 }).timeoutMs).toBe(6_000)
  })

  it('fails loud on the first call when no ResolveMCP binary can be discovered', () => {
    const ctx = new Context()
    const service = new McpDavinci(ctx, {
      mcpServerPath: '/nonexistent/server/index.js',
      resolveMcpPath: '/nonexistent/ResolveMCP',
    })
    expect(service.resolve({})).toMatchObject({ mcpServerPath: '/nonexistent/server/index.js' })
    const undiscovered = new McpDavinci(new Context(), {
      mcpServerPath: '/nonexistent/server/index.js',
      applicationsDir: '/nonexistent-applications',
    })
    expect(() => undiscovered.resolve({})).toThrow(/no ResolveMCP binary found under \/nonexistent-applications[\s\S]*set the resolveMcpPath config/)
  })
})

/** Minimal stand-in for the davinci-mcp stdio server, driven by FAKE_MODE. */
const FAKE_SERVER = `import { createInterface } from 'node:readline'

const mode = process.env.FAKE_MODE ?? 'success'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'noise after initialize' } })
    return
  }
  if (request.method !== 'tools/call') return
  if (mode === 'rpc-error') {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'ResolveMCP binary exited (code=1, signal=null)' } })
    return
  }
  if (mode === 'exit') process.exit(1)
  if (mode === 'hang') return
  if (mode === 'is-error') {
    send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'Error: DaVinci Resolve Studio is not installed. Install it from https://www.blackmagicdesign.com/products/davinciresolve' }], isError: true } })
    return
  }
  let inner
  if (mode === 'timeout') {
    inner = { error: 'Script timed out after 2s. Avoid long iterations; fetch only what you need.' }
  } else if (mode === 'traceback') {
    inner = { error: "Traceback (most recent call last):\\n  File \\"<script>\\", line 1, in <module>\\n    import os\\n  File \\"<string>\\", line 49, in _sandbox_hook\\n    raise PermissionError(f'import not allowed: {args[0]}')\\nPermissionError: import not allowed: os\\n" }
  } else if (mode === 'render-add') {
    inner = { output: 'ok=true\\njob_id=job-new\\nid_source=read-back\\njob_count=2\\nfirst_job_name=New\\n' }
  } else if (mode === 'render-ambiguous') {
    inner = { output: 'ERROR ambiguous-job: 2 new jobs appeared while AddRenderJob returned no id; candidates: job-n1, job-n2. No id is reported, nothing further is enqueued, and nothing is deleted - read resolve_render_status and disambiguate.\\n' }
  } else if (mode === 'render-delete') {
    inner = { output: 'done=true\\njob_id=job-a\\njob_count_after=1\\n' }
  } else {
    inner = { output: 'resolve_version=21.1.1.10\\nproject_name=probe\\ntimeline_count=1\\ntimeline_1=Main\\ncurrent_timeline=Main\\ncurrent_start=0\\ncurrent_end=2500\\nvideo_tracks=1\\naudio_tracks=2\\n' }
  }
  send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(inner) }] } })
  if (mode === 'exit-after-reply') process.exit(0)
})
`

let fakeServerPath: string
let fakeServerDir: string

beforeAll(() => {
  fakeServerDir = mkdtempSync(join(tmpdir(), 'dsh-davinci-fake-mcp-'))
  fakeServerPath = join(fakeServerDir, 'server.mjs')
  writeFileSync(fakeServerPath, FAKE_SERVER, 'utf8')
})

afterAll(() => {
  rmSync(fakeServerDir, { recursive: true, force: true })
})

function serviceWithFakeServer(): McpDavinci {
  return new McpDavinci(new Context(), { mcpServerPath: fakeServerPath, resolveMcpPath: '/fake/ResolveMCP' })
}

describe('McpDavinci stdio exchange', () => {
  it('reads project info from a fresh exchange, skipping notification noise', async () => {
    const result = await serviceWithFakeServer().projectInfo()
    expect(result).toEqual({
      ok: true,
      data: {
        resolveVersion: '21.1.1.10',
        projectName: 'probe',
        timelines: ['Main'],
        currentTimeline: 'Main',
        currentStartFrame: 0,
        currentEndFrame: 2500,
        videoTracks: 1,
        audioTracks: 2,
      },
    })
  })

  it('survives a server that exits right after answering', async () => {
    process.env.FAKE_MODE = 'exit-after-reply'
    const result = await serviceWithFakeServer().projectInfo()
    expect(result.ok).toBe(true)
  })

  it('maps an inner script timeout to the timeout code with the sandbox verbatim text', async () => {
    process.env.FAKE_MODE = 'timeout'
    const result = await serviceWithFakeServer().projectInfo()
    expect(result).toMatchObject({
      ok: false,
      code: 'timeout',
      message: 'Script timed out after 2s. Avoid long iterations; fetch only what you need.',
    })
  })

  it('maps an inner traceback (sandbox import refusal) to api-failed with the exception line', async () => {
    process.env.FAKE_MODE = 'traceback'
    const result = await serviceWithFakeServer().projectInfo()
    expect(result).toMatchObject({
      ok: false,
      code: 'api-failed',
      message: 'PermissionError: import not allowed: os',
    })
  })

  it('runs the add-render-job read-back confirmation through the real stdio transport', async () => {
    process.env.FAKE_MODE = 'render-add'
    const result = await serviceWithFakeServer().addRenderJob({ targetDir: '/tmp/dsh-render-test' })
    expect(result).toEqual({
      ok: true,
      data: { jobCount: 2, firstJobName: 'New', jobId: 'job-new', idSource: 'read-back' },
    })
  })

  it('maps the ambiguous-job refusal through the real stdio transport', async () => {
    process.env.FAKE_MODE = 'render-ambiguous'
    const result = await serviceWithFakeServer().addRenderJob({ targetDir: '/tmp/dsh-render-test' })
    expect(result).toMatchObject({ ok: false, code: 'ambiguous-job' })
    if (!result.ok) expect(result.message).toContain('job-n1, job-n2')
  })

  it('runs the delete-render-job read-back confirmation through the real stdio transport', async () => {
    process.env.FAKE_MODE = 'render-delete'
    const result = await serviceWithFakeServer().deleteRenderJob({ jobId: 'job-a' })
    expect(result).toEqual({ ok: true, data: { done: true, jobId: 'job-a', jobCountAfter: 1 } })
  })

  it('maps a JSON-RPC error reply (binary init failure) to spawn-failed', async () => {
    process.env.FAKE_MODE = 'rpc-error'
    const result = await serviceWithFakeServer().projectInfo()
    expect(result).toMatchObject({
      ok: false,
      code: 'spawn-failed',
      message: 'davinci MCP run_script request failed: ResolveMCP binary exited (code=1, signal=null)',
    })
  })

  it('maps a server crash before the reply to spawn-failed', async () => {
    process.env.FAKE_MODE = 'exit'
    const result = await serviceWithFakeServer().projectInfo()
    expect(result).toMatchObject({
      ok: false,
      code: 'spawn-failed',
    })
    if (!result.ok) expect(result.message).toContain('exited before answering')
  })

  it('fails loud on a non-inner-JSON reply (the wrapper isError path)', async () => {
    process.env.FAKE_MODE = 'is-error'
    const result = await serviceWithFakeServer().projectInfo()
    expect(result).toMatchObject({ ok: false, code: 'spawn-failed' })
    if (!result.ok) {
      expect(result.message).toContain('was not inner JSON')
      expect(result.message).toContain('DaVinci Resolve Studio is not installed')
    }
  })

  it('kills a hung exchange at the wall clock and reports timeout', { timeout: 20_000 }, async () => {
    process.env.FAKE_MODE = 'hang'
    const result = await serviceWithFakeServer().projectInfo({ timeoutMs: 1_000 })
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
    if (!result.ok) {
      expect(result.message).toContain('did not complete within 6000ms')
      expect(result.message).toContain('check the app window and retry')
    }
  })

  it('aborts a hung exchange through the caller signal as a timeout', { timeout: 20_000 }, async () => {
    process.env.FAKE_MODE = 'hang'
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const result = await serviceWithFakeServer().projectInfo({ signal: controller.signal, timeoutMs: 1_000 })
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
    if (!result.ok) expect(result.message).toContain('aborted by the caller')
  })
})

describe('classifySpawnError', () => {
  it('maps killed processes, aborts, and ETIMEDOUT to timeout', () => {
    expect(classifySpawnError(Object.assign(new Error('killed'), { killed: true })).code).toBe('timeout')
    expect(classifySpawnError(Object.assign(new Error('aborted'), { name: 'AbortError' })).code).toBe('timeout')
    expect(classifySpawnError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })).code).toBe('timeout')
  })

  it('maps everything else, including ENOENT, to spawn-failed', () => {
    expect(classifySpawnError(Object.assign(new Error('spawn /x ENOENT'), { code: 'ENOENT' })))
      .toMatchObject({ code: 'spawn-failed', message: 'spawn /x ENOENT' })
    expect(classifySpawnError('boom')).toMatchObject({ code: 'spawn-failed', message: 'boom' })
  })
})
