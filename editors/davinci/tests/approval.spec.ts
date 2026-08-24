import { describe, expect, it, vi } from 'vitest'
import { requireWriteApproval, type WriteApprover } from '../src/tools.ts'

const signal = new AbortController().signal
const exec = { name: 'resolve_place_clip', agent: { tag: 'agent' }, callId: 'call-1', signal }

function approverReturning(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') {
  const request = vi.fn(async () => outcome)
  return { approver: { request } as WriteApprover<object, string>, request }
}

describe('requireWriteApproval', () => {
  it('fails closed without a composed approval service', async () => {
    await expect(requireWriteApproval({ approval: undefined, exec, reason: 'r' }))
      .rejects.toThrow(/no approval channel is available/)
  })

  it('fails closed for an agent-less execution', async () => {
    const { approver } = approverReturning('allowed-once')
    await expect(requireWriteApproval({ approval: approver, exec: { name: 'resolve_delete_item', callId: 'call-2', signal }, reason: 'r' }))
      .rejects.toThrow(/no approval channel is available/)
  })

  it('throws distinct model-readable messages for every non-grant outcome', async () => {
    await expect(requireWriteApproval({ approval: approverReturning('rejected').approver, exec, reason: 'r' }))
      .rejects.toThrow(/was rejected by the user; nothing was changed/)
    await expect(requireWriteApproval({ approval: approverReturning('cancelled').approver, exec, reason: 'r' }))
      .rejects.toThrow(/was cancelled before the user answered/)
    await expect(requireWriteApproval({ approval: approverReturning('unavailable').approver, exec, reason: 'r' }))
      .rejects.toThrow(/got no approval answer/)
  })

  it('resolves on the one-shot grant and forwards identity and reason', async () => {
    const { approver, request } = approverReturning('allowed-once')
    await expect(requireWriteApproval({ approval: approver, exec, reason: 'place shot_010 at frame 500' }))
      .resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith({
      agent: exec.agent,
      toolName: 'resolve_place_clip',
      callId: 'call-1',
      reason: 'place shot_010 at frame 500',
      signal,
    })
  })
})
