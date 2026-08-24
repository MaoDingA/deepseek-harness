import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverFuscript, FuscriptDavinci } from '../src/provider.ts'
import { classifySpawnError } from '../src/service.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeApplicationsDir(installs: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-davinci-discover-'))
  dirs.push(dir)
  for (const name of installs) {
    const fuscript = join(dir, name, 'DaVinci Resolve.app', 'Contents', 'Libraries', 'Fusion', 'fuscript')
    mkdirSync(dirname(fuscript), { recursive: true })
    writeFileSync(fuscript, '')
  }
  return dir
}

describe('discoverFuscript', () => {
  it('prefers the highest numbered install', () => {
    const dir = fakeApplicationsDir(['DaVinci Resolve19', 'DaVinci Resolve20'])
    expect(discoverFuscript(dir)).toBe(
      join(dir, 'DaVinci Resolve20', 'DaVinci Resolve.app', 'Contents', 'Libraries', 'Fusion', 'fuscript'),
    )
  })

  it('falls back to an unnumbered install behind numbered ones', () => {
    const dir = fakeApplicationsDir(['DaVinci Resolve', 'DaVinci Resolve18'])
    expect(discoverFuscript(dir)).toContain('DaVinci Resolve18')
  })

  it('uses an unnumbered install when it is the only one', () => {
    const dir = fakeApplicationsDir(['DaVinci Resolve'])
    expect(discoverFuscript(dir)).toContain(join('DaVinci Resolve', 'DaVinci Resolve.app'))
  })

  it('ignores unrelated folders and returns undefined when nothing matches', () => {
    const dir = fakeApplicationsDir(['Final Cut Pro'])
    expect(discoverFuscript(dir)).toBeUndefined()
    expect(discoverFuscript(join(dir, 'does-not-exist'))).toBeUndefined()
  })
})

describe('FuscriptDavinci.resolve', () => {
  it('keeps an explicit fuscriptPath and applies timeout defaults and caps', () => {
    const ctx = new Context()
    const service = new FuscriptDavinci(ctx, { fuscriptPath: '/x/fuscript' })
    expect(service.resolve({})).toEqual({ fuscriptPath: '/x/fuscript', timeoutMs: 30_000 })
    expect(service.resolve({ timeoutMs: 999_000 })).toEqual({ fuscriptPath: '/x/fuscript', timeoutMs: 120_000 })
    expect(service.resolve({ timeoutMs: 45_000 })).toEqual({ fuscriptPath: '/x/fuscript', timeoutMs: 45_000 })
    expect(service.resolve({ timeoutMs: 1 })).toEqual({ fuscriptPath: '/x/fuscript', timeoutMs: 1_000 })
  })

  it('honors configured default and cap over the built-in ones', () => {
    const ctx = new Context()
    const service = new FuscriptDavinci(ctx, {
      fuscriptPath: '/x/fuscript',
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 6_000,
    })
    expect(service.resolve({}).timeoutMs).toBe(5_000)
    expect(service.resolve({ timeoutMs: 9_000 }).timeoutMs).toBe(6_000)
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
