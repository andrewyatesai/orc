import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAtermPaneBuildQueue } from './aterm-pane-build-queue'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await Promise.resolve()
  }
}

describe('createAtermPaneBuildQueue', () => {
  it('admits up to the limit and hands freed slots to waiters in FIFO order', async () => {
    const queue = createAtermPaneBuildQueue(2)
    const order: number[] = []
    await queue.admit()
    await queue.admit()
    const third = queue.admit().then(() => order.push(3))
    const fourth = queue.admit().then(() => order.push(4))
    await flushMicrotasks()
    expect(order).toEqual([])
    queue.release()
    await third
    expect(order).toEqual([3])
    queue.release()
    await fourth
    expect(order).toEqual([3, 4])
  })

  it('self-admits a waiter past the limit after the fallback deadline', async () => {
    vi.useFakeTimers()
    const queue = createAtermPaneBuildQueue(1)
    await queue.admit()
    let admitted = false
    const waiter = queue.admit().then(() => {
      admitted = true
    })
    await flushMicrotasks()
    expect(admitted).toBe(false)
    // A wedged build must not dam the queue forever.
    vi.advanceTimersByTime(20_000)
    await waiter
    expect(admitted).toBe(true)
    // Both releases stay consistent (no negative counts / stuck slots).
    queue.release()
    queue.release()
    await queue.admit()
  })
})

// These numbers are the whole input to the visible-first-admission go/no-go, so
// a wrong admitIndex or waitMs would produce a wrong decision, not a wrong log.
describe('createAtermPaneBuildQueue admission trace', () => {
  it('marks the first `limit` grants synchronous, in ask order, with no wait', async () => {
    const queue = createAtermPaneBuildQueue(2)
    const first = await queue.admit()
    const second = await queue.admit()
    expect(first).toMatchObject({
      enqueueIndex: 0,
      admitIndex: 0,
      syncGrant: true,
      selfAdmitted: false
    })
    expect(second).toMatchObject({ enqueueIndex: 1, admitIndex: 1, syncGrant: true })
    expect(first.waitMs).toBeLessThanOrEqual(1)
    expect(second.waitMs).toBeLessThanOrEqual(1)
  })

  it('reports a real wait for a pane that had to queue', async () => {
    vi.useFakeTimers()
    const queue = createAtermPaneBuildQueue(1)
    await queue.admit()
    const queued = queue.admit()
    await flushMicrotasks()
    vi.advanceTimersByTime(120)
    queue.release()
    const admission = await queued
    expect(admission).toMatchObject({
      enqueueIndex: 1,
      admitIndex: 1,
      syncGrant: false,
      selfAdmitted: false
    })
    // The wait is the ceiling on what visible-first admission could recover.
    expect(admission.waitMs).toBeGreaterThanOrEqual(120)
  })

  it('flags a self-admission so a grant past the limit cannot read as normal', async () => {
    vi.useFakeTimers()
    const queue = createAtermPaneBuildQueue(1)
    await queue.admit()
    const wedged = queue.admit()
    await flushMicrotasks()
    vi.advanceTimersByTime(20_000)
    const admission = await wedged
    expect(admission).toMatchObject({ syncGrant: false, selfAdmitted: true })
    expect(admission.waitMs).toBeGreaterThanOrEqual(20_000)
  })

  it('counts a pane admitted-then-disposed, because it really did consume a slot', async () => {
    const queue = createAtermPaneBuildQueue(2)
    await queue.admit()
    await queue.admit()
    // The first pane is torn down before building and hands its slot straight on.
    queue.release()
    const third = await queue.admit()
    expect(third.admitIndex).toBe(2)
    expect(queue.snapshot()).toMatchObject({ enqueued: 3, admitted: 3 })
  })

  it('snapshots how many panes had asked by the time one was admitted', async () => {
    const queue = createAtermPaneBuildQueue(2)
    await queue.admit()
    await queue.admit()
    void queue.admit()
    void queue.admit()
    await flushMicrotasks()
    // Answers whether an 8-tab restore enqueues in one commit or in waves.
    expect(queue.snapshot()).toMatchObject({ enqueued: 4, admitted: 2, inFlight: 2, waiting: 2 })
  })
})
