import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }))
vi.mock('@/startup/startup-diagnostics', () => ({
  logRendererStartupDiagnostic: logSpy
}))

// A controllable renderer clock, so a flushed phase can be asserted to carry the
// stamp from WHEN IT HAPPENED rather than from when it was emitted.
let now = 0

beforeEach(() => {
  // Module-level fire-once latches: a fresh module per test.
  vi.resetModules()
  logSpy.mockClear()
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Let the milestone's post-frame resolution microtask run. */
async function settleFrameResolution(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve)
  })
}

const events = (): string[] => logSpy.mock.calls.map(([event]) => event)

describe('markFirstAtermTerminalFramePresented', () => {
  it('emits the first-terminal-frame startup milestone exactly once', async () => {
    const { markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    markFirstAtermTerminalFramePresented()
    markFirstAtermTerminalFramePresented()
    markFirstAtermTerminalFramePresented()
    await settleFrameResolution()
    // The channel prefixes 'renderer-', producing 'renderer-first-terminal-frame'.
    expect(logSpy).toHaveBeenCalledWith('first-terminal-frame')
    expect(events().filter((event) => event === 'first-terminal-frame')).toHaveLength(1)
  })
})

describe('markAtermWarmPhase', () => {
  it('emits each warm phase exactly once, in the order it was reached', async () => {
    const { markAtermWarmPhase } = await import('./aterm-first-terminal-frame-milestone')
    markAtermWarmPhase('warm-start')
    markAtermWarmPhase('wasm-ready')
    markAtermWarmPhase('wasm-ready')
    markAtermWarmPhase('worker-ready')
    markAtermWarmPhase('warm-start')
    expect(events()).toEqual(['aterm-warm-start', 'aterm-wasm-ready', 'aterm-worker-ready'])
  })

  it('latches warm phases independently of the first-frame marker', async () => {
    const { markAtermWarmPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    markFirstAtermTerminalFramePresented()
    markAtermWarmPhase('warm-start')
    expect(events()).toEqual(['first-terminal-frame', 'aterm-warm-start'])
  })
})

describe('markTerminalPaneBootPhase', () => {
  it('emits nothing until a frame names the lane', async () => {
    const { markTerminalPaneBootPhase } = await import('./aterm-first-terminal-frame-milestone')
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    markTerminalPaneBootPhase('layout-replayed', { laneId: 'tab-a' })
    await settleFrameResolution()
    // Buffered, not dropped and not emitted: no pane has painted yet.
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('emits ONLY the presenting tab, with the timestamps the phases actually had', async () => {
    const { markTerminalPaneBootPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    // A multi-tab restore boots both concurrently. The hidden tab wins the race
    // to boot-start — this is exactly the case the old first-wins latch got wrong.
    now = 10
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-hidden' })
    now = 12
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-visible' })
    now = 20
    markTerminalPaneBootPhase('layout-replayed', { laneId: 'tab-hidden' })
    now = 25
    markTerminalPaneBootPhase('layout-replayed', { laneId: 'tab-visible' })
    now = 30
    markTerminalPaneBootPhase('boot-settled', { laneId: 'tab-visible' })

    // The visible tab is the one that paints, so it defines the lane.
    now = 40
    markFirstAtermTerminalFramePresented(() => ({ laneId: 'tab-visible', paneId: 'leaf-1' }))
    await settleFrameResolution()

    expect(events()).toEqual([
      'first-terminal-frame',
      'pane-boot-start',
      'pane-layout-replayed',
      'pane-boot-settled'
    ])
    // The stamps are the visible tab's own, NOT the hidden tab's earlier ones and
    // NOT the flush time — that is the whole point of buffering.
    expect(logSpy).toHaveBeenCalledWith('pane-boot-start', { rendererT: 12 })
    expect(logSpy).toHaveBeenCalledWith('pane-layout-replayed', { rendererT: 25 })
    expect(logSpy).toHaveBeenCalledWith('pane-boot-settled', { rendererT: 30 })
  })

  it('drops a sibling pane inside the winning tab for the pane-exact phases', async () => {
    const { markTerminalPaneBootPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    now = 5
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    // A split: two panes in the same tab both connect their PTY.
    now = 50
    markTerminalPaneBootPhase('pty-connect-start', { laneId: 'tab-a', paneId: 'leaf-sibling' })
    now = 60
    markTerminalPaneBootPhase('pty-connect-start', { laneId: 'tab-a', paneId: 'leaf-winner' })
    now = 70
    markFirstAtermTerminalFramePresented(() => ({ laneId: 'tab-a', paneId: 'leaf-winner' }))
    await settleFrameResolution()

    expect(events()).toEqual(['first-terminal-frame', 'pane-boot-start', 'pane-pty-connect-start'])
    expect(logSpy).toHaveBeenCalledWith('pane-pty-connect-start', { rendererT: 60 })
  })

  it('still emits pty-bound when it lands AFTER the first frame', async () => {
    const { markTerminalPaneBootPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    now = 5
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    now = 40
    markFirstAtermTerminalFramePresented(() => ({ laneId: 'tab-a', paneId: 'leaf-1' }))
    await settleFrameResolution()
    // The engine paints before the daemon binds; the bench derives a NEGATIVE
    // panePtyBoundToFirstTerminalFrame from this and documents it as the useful reading.
    now = 90
    markTerminalPaneBootPhase('pty-bound', { laneId: 'tab-a', paneId: 'leaf-1' })
    expect(logSpy).toHaveBeenCalledWith('pane-pty-bound', { rendererT: 90 })

    // A losing tab stays silent even after resolution.
    logSpy.mockClear()
    markTerminalPaneBootPhase('fit-measured', { laneId: 'tab-other' })
    markTerminalPaneBootPhase('pty-bound', { laneId: 'tab-a', paneId: 'leaf-sibling' })
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('reports an unresolved lane rather than a silently truncated timeline', async () => {
    const { markTerminalPaneBootPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    markTerminalPaneBootPhase('boot-settled', { laneId: 'tab-a' })
    // A pane with no lane painted (a PaneManager built without one).
    markFirstAtermTerminalFramePresented(() => null)
    await settleFrameResolution()
    // "No lane" must be distinguishable from "line lost", and must never be a
    // timeline attributed to some other tab.
    expect(events()).toEqual(['first-terminal-frame', 'pane-boot-lane-unresolved'])
  })

  it('treats a remount as the surviving mount (last stamp wins) before resolution', async () => {
    const { markTerminalPaneBootPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    now = 10
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    now = 33
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    now = 40
    markFirstAtermTerminalFramePresented(() => ({ laneId: 'tab-a', paneId: 'leaf-1' }))
    await settleFrameResolution()
    expect(logSpy).toHaveBeenCalledWith('pane-boot-start', { rendererT: 33 })
  })

  it('swallows a diagnostics-channel throw so the PTY bind chokepoint cannot break', async () => {
    const { markTerminalPaneBootPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    markFirstAtermTerminalFramePresented(() => ({ laneId: 'tab-a', paneId: 'leaf-1' }))
    await settleFrameResolution()
    logSpy.mockClear()
    logSpy.mockImplementationOnce(() => {
      throw new TypeError('startupDiagnostic(...).catch is not a function')
    })
    expect(() =>
      markTerminalPaneBootPhase('pty-bound', { laneId: 'tab-a', paneId: 'leaf-1' })
    ).not.toThrow()
    // Still latched: a failed emit must not turn into a retry on every later pane.
    markTerminalPaneBootPhase('pty-bound', { laneId: 'tab-a', paneId: 'leaf-1' })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('survives an origin getter that throws', async () => {
    const { markTerminalPaneBootPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    expect(() =>
      markFirstAtermTerminalFramePresented(() => {
        throw new Error('pane torn down mid-frame')
      })
    ).not.toThrow()
    await settleFrameResolution()
    expect(events()).toEqual(['first-terminal-frame'])
  })

  it('latches independently of the warm phases and the first-frame marker', async () => {
    const { markAtermWarmPhase, markFirstAtermTerminalFramePresented, markTerminalPaneBootPhase } =
      await import('./aterm-first-terminal-frame-milestone')
    markAtermWarmPhase('worker-ready')
    markTerminalPaneBootPhase('boot-start', { laneId: 'tab-a' })
    markFirstAtermTerminalFramePresented(() => ({ laneId: 'tab-a', paneId: 'leaf-1' }))
    await settleFrameResolution()
    expect(events()).toEqual(['aterm-worker-ready', 'first-terminal-frame', 'pane-boot-start'])
  })
})
