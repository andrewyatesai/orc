import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createAtermWorkerPrewarm,
  shouldSkipAtermEnginePrewarm,
  type AtermWorkerPrewarmDeps,
  type AtermWorkerPrewarmHold
} from './aterm-worker-prewarm'

type Harness = {
  prewarm: ReturnType<typeof createAtermWorkerPrewarm>
  runScheduled: () => void
  cancelSchedule: Mock<() => void>
  acquire: Mock<() => Promise<AtermWorkerPrewarmHold>>
  resolveAcquire: (hold: AtermWorkerPrewarmHold) => Promise<void>
  rejectAcquire: (err: Error) => Promise<void>
  scheduleCalls: () => number
}

const HOLD_MS = 90_000

function makeHarness(): Harness {
  let scheduled: (() => void) | null = null
  let scheduleCount = 0
  const cancelSchedule = vi.fn<() => void>()
  let settle!: { resolve: (hold: AtermWorkerPrewarmHold) => void; reject: (err: Error) => void }
  const acquire = vi.fn(
    () =>
      new Promise<AtermWorkerPrewarmHold>((resolve, reject) => {
        settle = { resolve, reject }
      })
  )
  const deps: AtermWorkerPrewarmDeps = {
    acquire,
    schedule: (run) => {
      scheduleCount++
      scheduled = run
      return cancelSchedule
    },
    holdMs: HOLD_MS
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
    }
  }
  return {
    prewarm: createAtermWorkerPrewarm(deps),
    runScheduled: () => scheduled?.(),
    cancelSchedule,
    acquire,
    resolveAcquire: async (hold) => {
      settle.resolve(hold)
      await flush()
    },
    rejectAcquire: async (err) => {
      settle.reject(err)
      await flush()
    },
    scheduleCalls: () => scheduleCount
  }
}

function makeHold(): AtermWorkerPrewarmHold & { release: Mock<() => void> } {
  return { release: vi.fn<() => void>() }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createAtermWorkerPrewarm', () => {
  it('arms once, acquires at idle, and releases the hold after the deadline', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.prewarm.arm()
    h.prewarm.arm()
    expect(h.scheduleCalls()).toBe(1)

    h.runScheduled()
    expect(h.acquire).toHaveBeenCalledTimes(1)
    const hold = makeHold()
    await h.resolveAcquire(hold)
    expect(hold.release).not.toHaveBeenCalled()

    // Memory-over-warmth: the hold is strictly bounded.
    vi.advanceTimersByTime(HOLD_MS)
    expect(hold.release).toHaveBeenCalledTimes(1)
  })

  it('cancels the idle schedule when a real pane arrives first', () => {
    const h = makeHarness()
    h.prewarm.arm()
    h.prewarm.notePaneAcquired()
    expect(h.cancelSchedule).toHaveBeenCalledTimes(1)
    // Even a late-fired schedule must not spawn a worker after demand took over.
    h.runScheduled()
    expect(h.acquire).not.toHaveBeenCalled()
  })

  it('releases immediately when a real pane arrives mid-acquire', async () => {
    const h = makeHarness()
    h.prewarm.arm()
    h.runScheduled()
    h.prewarm.notePaneAcquired()
    const hold = makeHold()
    await h.resolveAcquire(hold)
    expect(hold.release).toHaveBeenCalledTimes(1)
  })

  it('releases the live hold when a real pane arrives, and only once', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.prewarm.arm()
    h.runScheduled()
    const hold = makeHold()
    await h.resolveAcquire(hold)

    h.prewarm.notePaneAcquired()
    expect(hold.release).toHaveBeenCalledTimes(1)
    // The deadline timer was cleared — no double release later.
    vi.advanceTimersByTime(HOLD_MS)
    expect(hold.release).toHaveBeenCalledTimes(1)
  })

  it('swallows acquire failures (prewarm is best-effort)', async () => {
    const h = makeHarness()
    h.prewarm.arm()
    h.runScheduled()
    await h.rejectAcquire(new Error('fonts failed'))
    // No throw, no unhandled rejection: the real pane open surfaces errors.
    expect(h.acquire).toHaveBeenCalledTimes(1)
  })
})

describe('warmNow (session-restore immediate warm)', () => {
  it('acquires immediately and still releases the bounded hold when no pane ever mounts', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.prewarm.warmNow()
    expect(h.acquire).toHaveBeenCalledTimes(1)
    const hold = makeHold()
    await h.resolveAcquire(hold)
    // Memory-over-warmth survives the restore warm: no leaked worker slot.
    vi.advanceTimersByTime(HOLD_MS)
    expect(hold.release).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending idle attempt, and a late-fired schedule cannot double-acquire', () => {
    const h = makeHarness()
    h.prewarm.arm()
    h.prewarm.warmNow()
    expect(h.cancelSchedule).toHaveBeenCalledTimes(1)
    h.runScheduled()
    expect(h.acquire).toHaveBeenCalledTimes(1)
  })

  it('is idempotent (a second warmNow cannot leak a second slot)', () => {
    const h = makeHarness()
    h.prewarm.warmNow()
    h.prewarm.warmNow()
    expect(h.acquire).toHaveBeenCalledTimes(1)
  })

  it('does not re-acquire after the idle prewarm already warmed', async () => {
    const h = makeHarness()
    h.prewarm.arm()
    h.runScheduled()
    await h.resolveAcquire(makeHold())
    h.prewarm.warmNow()
    expect(h.acquire).toHaveBeenCalledTimes(1)
  })

  it('releases its hold exactly once when a real pane takes over', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.prewarm.warmNow()
    const hold = makeHold()
    await h.resolveAcquire(hold)
    h.prewarm.notePaneAcquired()
    expect(hold.release).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOLD_MS)
    expect(hold.release).toHaveBeenCalledTimes(1)
  })

  it('is a no-op once a real pane owns the worker', () => {
    const h = makeHarness()
    h.prewarm.notePaneAcquired()
    h.prewarm.warmNow()
    expect(h.acquire).not.toHaveBeenCalled()
  })

  it('releases immediately when a real pane arrives mid-acquire', async () => {
    const h = makeHarness()
    h.prewarm.warmNow()
    h.prewarm.notePaneAcquired()
    const hold = makeHold()
    await h.resolveAcquire(hold)
    expect(hold.release).toHaveBeenCalledTimes(1)
  })
})

describe('shouldSkipAtermEnginePrewarm', () => {
  const productionEnv = {
    hasWindow: true,
    hasWorker: true,
    mode: 'production',
    e2eExposeStore: false
  }

  it('allows the warm in a production renderer', () => {
    expect(shouldSkipAtermEnginePrewarm(productionEnv)).toBe(false)
  })

  it('skips under e2e exposeStore (specs assert on lazy worker creation)', () => {
    expect(shouldSkipAtermEnginePrewarm({ ...productionEnv, e2eExposeStore: true })).toBe(true)
  })

  it('skips under unit tests', () => {
    expect(shouldSkipAtermEnginePrewarm({ ...productionEnv, mode: 'test' })).toBe(true)
  })

  it('skips without window or Worker', () => {
    expect(shouldSkipAtermEnginePrewarm({ ...productionEnv, hasWindow: false })).toBe(true)
    expect(shouldSkipAtermEnginePrewarm({ ...productionEnv, hasWorker: false })).toBe(true)
  })
})
