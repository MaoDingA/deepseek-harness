import { describe, expect, it } from 'vitest'
import { addRenderJobText } from '../src/tools.ts'
import type { DavinciRenderJobInfo } from '../src/types.ts'

describe('addRenderJobText id source marker', () => {
  it('marks a read-back-resolved id with 读回确认', () => {
    const info: DavinciRenderJobInfo = { jobCount: 2, firstJobName: 'New', jobId: 'job-new', idSource: 'read-back' }
    expect(addRenderJobText(info)).toContain('job_id=job-new (读回确认)')
    expect(addRenderJobText(info)).toContain('queued_jobs=2')
  })

  it('renders a host-returned id without the read-back marker', () => {
    const info: DavinciRenderJobInfo = { jobCount: 1, firstJobName: undefined, jobId: 'job-9', idSource: 'returned' }
    const text = addRenderJobText(info)
    expect(text).toContain('job_id=job-9')
    expect(text).not.toContain('读回确认')
  })

  it('omits the id line entirely when no id could be established', () => {
    const info: DavinciRenderJobInfo = { jobCount: 1, firstJobName: undefined, jobId: undefined, idSource: 'returned' }
    expect(addRenderJobText(info)).not.toContain('job_id=')
  })
})
