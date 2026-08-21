import { describe, expect, it, vi } from 'vitest'
import { overlapStatusWithConflictDetection } from './git-status-conflict-overlap'

describe('overlapStatusWithConflictDetection', () => {
  it('starts the status thunk synchronously, before the caller awaits anything', () => {
    const startStatus = vi.fn(async () => 'status')
    // The whole point of the overlap: the scan is in flight the instant this returns,
    // so the caller can await the independent conflict marker I/O next.
    overlapStatusWithConflictDetection(startStatus)
    expect(startStatus).toHaveBeenCalledTimes(1)
  })

  it('replays the resolved status value from the returned settle thunk', async () => {
    const settle = overlapStatusWithConflictDetection(async () => 'ok')
    await expect(settle()).resolves.toBe('ok')
  })

  it('replays the original status rejection so the caller keeps its own error handling', async () => {
    const failure = new Error('status failed')
    const settle = overlapStatusWithConflictDetection(async () => {
      throw failure
    })
    await expect(settle()).rejects.toBe(failure)
  })

  it('owns a fast status rejection up front, then still replays it on settle', async () => {
    const failure = new Error('fast status failure')
    const settle = overlapStatusWithConflictDetection(async () => {
      throw failure
    })
    // Let the rejected scan promise settle across macrotasks with no settle() call
    // yet: allSettled must already hold the rejection, or vitest would flag an
    // unhandled rejection here. The replay below proves it was captured, not lost.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(settle()).rejects.toBe(failure)
  })
})
