import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  conventionQuestions,
  conventionsPath,
  defaultConventions,
  formatBackupName,
  loadConventions,
  mergeConventions,
  missingConventionFields,
  normalizeConventions,
  readConventions,
  stripWorkingSuffix,
  workingTimelineName,
  writeConventions,
} from '../src/conventions.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-davinci-conventions-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('project conventions defaults and questions', () => {
  it('starts with conform and timeline defaults but asks for VFX and output', () => {
    const conventions = defaultConventions('FEATURE')
    expect(conventions.conform).toMatchObject({
      targetTrack: 1,
      audio: 'ignore',
      multiSegment: true,
      sourceMatch: 'source-tc',
      handles: 0,
    })
    expect(conventions.timelinePolicy).toMatchObject({
      workingSuffix: '_待审',
      backupSuffixFormat: '__OLD_YYYYMMDD_HHmm',
      disableOriginal: true,
      keepCopy: true,
      review: 'zh',
    })
    const missing = missingConventionFields(conventions)
    expect(missing).toContain('frameRate')
    expect(missing).toContain('conform.workprintPattern')
    expect(missing).toContain('vfx.bin')
    expect(missing).toContain('vfx.targetTrack')
    expect(missing).toContain('output.preset')
    expect(missing).toContain('output.directory')
    expect(missing).not.toContain('conform.targetTrack')
    const questions = conventionQuestions(missing)
    expect(questions.find((entry) => entry.field === 'vfx.bin')?.question).toContain('bin')
    expect(questions).toHaveLength(missing.length)
  })

  it('merges partial answers without changing defaults or immutable identity', () => {
    const base = defaultConventions('FEATURE')
    const merged = mergeConventions(base, {
      frameRate: 24,
      dropFrame: false,
      conform: { workprintPattern: 'WP_*' },
      vfx: { bin: 'VFX', targetTrack: 2, markerColor: 'Blue', anchor: 'record-tc', handles: 2, namePattern: '{shot}' },
      output: { preset: 'H.264 Master', format: 'mov', codec: 'H.264', directory: '/out', namePattern: '{reel}' },
      notes: 'IO feature',
    })
    expect(merged.project).toBe('FEATURE')
    expect(merged.version).toBe(1)
    expect(merged.conform.targetTrack).toBe(1)
    expect(merged.conform.workprintPattern).toBe('WP_*')
    expect(merged.vfx.bin).toBe('VFX')
    expect(merged.output.directory).toBe('/out')
    expect(missingConventionFields(merged)).not.toContain('vfx.bin')
    expect(missingConventionFields(merged)).not.toContain('output.preset')
    expect(base.vfx.bin).toBeUndefined()
  })

  it('rejects invalid values instead of storing them', () => {
    const base = defaultConventions('FEATURE')
    expect(() => mergeConventions(base, { frameRate: 0 })).toThrow(/frameRate/)
    expect(() => mergeConventions(base, { vfx: { markerColor: 'Chartreuse' } })).toThrow(/markerColor/)
    expect(() => mergeConventions(base, { conform: { targetTrack: 0 } })).toThrow(/targetTrack/)
    expect(() => mergeConventions(base, { timelinePolicy: { workingSuffix: '' } })).toThrow(/workingSuffix/)
  })
})

describe('project conventions storage', () => {
  it('returns undefined when the project has no document yet', () => {
    expect(readConventions(temporaryDirectory(), 'FEATURE')).toBeUndefined()
  })

  it('writes atomically, reads back, and preserves remaining answers', () => {
    const directory = temporaryDirectory()
    const merged = mergeConventions(defaultConventions('FEATURE'), {
      frameRate: 24,
      vfx: { bin: 'VFX' },
    })
    const path = writeConventions(directory, merged)
    expect(path).toBe(conventionsPath(directory, 'FEATURE'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1,
      project: 'FEATURE',
      frameRate: 24,
      vfx: { bin: 'VFX' },
    })
    const loaded = loadConventions(directory, 'FEATURE')
    expect(loaded.path).toBe(path)
    expect(loaded.conventions.vfx.bin).toBe('VFX')
    expect(loaded.conventions.conform.audio).toBe('ignore')
  })

  it('refuses a document that belongs to another project', () => {
    const directory = temporaryDirectory()
    const path = conventionsPath(directory, 'FEATURE')
    writeConventions(directory, defaultConventions('OTHER'))
    writeFileSync(path, JSON.stringify({ ...defaultConventions('OTHER'), project: 'OTHER' }))
    expect(() => readConventions(directory, 'FEATURE')).toThrow(/belong to "OTHER"/)
  })

  it('sanitizes path separators and refuses traversal-only names', () => {
    const directory = temporaryDirectory()
    expect(conventionsPath(directory, 'A/B:C')).toBe(join(directory, 'A_B_C.json'))
    expect(() => conventionsPath(directory, '..')).toThrow(/cannot be used/)
    const stored = writeConventions(directory, defaultConventions('A/B'))
    expect(stored).toBe(join(directory, 'A_B.json'))
  })

  it('normalizes a partial stored document over the defaults', () => {
    const conventions = normalizeConventions('FEATURE', {
      version: 1,
      project: 'FEATURE',
      conform: { workprintPattern: 'WP_*' },
    })
    expect(conventions.conform.targetTrack).toBe(1)
    expect(conventions.conform.workprintPattern).toBe('WP_*')
    expect(conventions.timelinePolicy.workingSuffix).toBe('_待审')
  })
})

describe('timeline working-copy naming', () => {
  it('formats the timestamped backup suffix with local time', () => {
    const policy = defaultConventions('FEATURE').timelinePolicy
    const date = new Date(2026, 10, 9, 18, 23, 45)
    expect(formatBackupName('第一本', policy, date)).toBe('第一本__OLD_20261109_1823')
  })

  it('builds and strips the review suffix', () => {
    expect(workingTimelineName('第一本', '_待审')).toBe('第一本_待审')
    expect(stripWorkingSuffix('第一本_待审', '_待审')).toBe('第一本')
    expect(stripWorkingSuffix('第一本', '_待审')).toBeUndefined()
  })
})
