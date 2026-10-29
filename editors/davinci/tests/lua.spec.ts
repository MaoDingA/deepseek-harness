import { describe, expect, it } from 'vitest'
import { addRenderJobLua, renderStatusLua, startRenderingLua, stopRenderingLua } from '../src/lua.ts'

describe('render control Lua body generation', () => {
  it('emits a valid empty Lua table for an empty job id list', () => {
    for (const body of [startRenderingLua({ jobIds: [] }), stopRenderingLua({ jobIds: [] })]) {
      expect(body).toContain('local jids = {}')
      expect(body).not.toMatch(/local jids = \[/)
    }
  })

  it('emits a valid Lua table literal for explicit job ids', () => {
    for (const body of [
      startRenderingLua({ jobIds: ['job-1', 'job-2'] }),
      stopRenderingLua({ jobIds: ['job-1', 'job-2'] }),
    ]) {
      expect(body).toContain('local jids = { "job-1", "job-2" }')
      expect(body).not.toMatch(/local jids = \[/)
    }
  })

  it('resolves the added job id by queue delta, not by list order', () => {
    const body = addRenderJobLua({ targetDir: '/tmp/dsh-render-test' })
    expect(body).toContain('preIds')
    expect(body).toContain('not preIds[tostring(rid)]')
    // The stale first-row overwrite this replaced read `jobs[1]` unconditionally.
    expect(body).not.toContain('jobs[1]')
  })
})

describe('renderStatusLua fail-loud reads', () => {
  it('marks pcall-failed render-engine reads as read-failed instead of zero', () => {
    const body = renderStatusLua()
    expect(body).toContain('job_count=read-failed')
    expect(body).toContain('is_rendering=read-failed')
    expect(body).toContain('cur_format=read-failed')
    expect(body).toContain('cur_codec_count=read-failed')
    // The silent-swallow shapes this replaced.
    expect(body).not.toMatch(/okJobs and jobs and #jobs or 0/)
    expect(body).not.toMatch(/tostring\(okRender and rendering == true\)/)
  })
})
