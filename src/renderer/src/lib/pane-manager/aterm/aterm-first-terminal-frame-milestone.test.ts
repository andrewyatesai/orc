import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }))
vi.mock('@/startup/startup-diagnostics', () => ({
  logRendererStartupDiagnostic: logSpy
}))

beforeEach(() => {
  // Module-level fire-once latches: a fresh module per test.
  vi.resetModules()
  logSpy.mockClear()
})

describe('markFirstAtermTerminalFramePresented', () => {
  it('emits the first-terminal-frame startup milestone exactly once', async () => {
    const { markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    markFirstAtermTerminalFramePresented()
    markFirstAtermTerminalFramePresented()
    markFirstAtermTerminalFramePresented()
    expect(logSpy).toHaveBeenCalledTimes(1)
    // The channel prefixes 'renderer-', producing 'renderer-first-terminal-frame'.
    expect(logSpy).toHaveBeenCalledWith('first-terminal-frame')
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
    expect(logSpy.mock.calls.map(([event]) => event)).toEqual([
      'aterm-warm-start',
      'aterm-wasm-ready',
      'aterm-worker-ready'
    ])
  })

  it('latches warm phases independently of the first-frame marker', async () => {
    const { markAtermWarmPhase, markFirstAtermTerminalFramePresented } = await import(
      './aterm-first-terminal-frame-milestone'
    )
    markFirstAtermTerminalFramePresented()
    markAtermWarmPhase('warm-start')
    expect(logSpy.mock.calls.map(([event]) => event)).toEqual([
      'first-terminal-frame',
      'aterm-warm-start'
    ])
  })
})

describe('markTerminalPaneBootPhase', () => {
  it('emits each pane-boot stage once, in the order the boot reached it', async () => {
    const { markTerminalPaneBootPhase } = await import('./aterm-first-terminal-frame-milestone')
    markTerminalPaneBootPhase('boot-start')
    markTerminalPaneBootPhase('layout-replayed')
    markTerminalPaneBootPhase('scrollback-restored')
    markTerminalPaneBootPhase('boot-settled')
    markTerminalPaneBootPhase('pty-connect-start')
    markTerminalPaneBootPhase('fit-measured')
    markTerminalPaneBootPhase('pty-bound')
    expect(logSpy.mock.calls.map(([event]) => event)).toEqual([
      'pane-boot-start',
      'pane-layout-replayed',
      'pane-scrollback-restored',
      'pane-boot-settled',
      'pane-pty-connect-start',
      'pane-fit-measured',
      'pane-pty-bound'
    ])
  })

  it('stays silent for every pane after the first — later tabs and splits re-run the same calls', async () => {
    const { markTerminalPaneBootPhase } = await import('./aterm-first-terminal-frame-milestone')
    // First (restored) pane boots.
    markTerminalPaneBootPhase('boot-start')
    markTerminalPaneBootPhase('layout-replayed')
    markTerminalPaneBootPhase('pty-bound')
    logSpy.mockClear()
    // A second tab / user split walks the identical sequence.
    markTerminalPaneBootPhase('boot-start')
    markTerminalPaneBootPhase('layout-replayed')
    markTerminalPaneBootPhase('pty-connect-start')
    markTerminalPaneBootPhase('pty-bound')
    expect(logSpy.mock.calls.map(([event]) => event)).toEqual(['pane-pty-connect-start'])
  })

  it('swallows a diagnostics-channel throw so the PTY bind chokepoint cannot break', async () => {
    const { markTerminalPaneBootPhase } = await import('./aterm-first-terminal-frame-milestone')
    logSpy.mockImplementationOnce(() => {
      throw new TypeError('startupDiagnostic(...).catch is not a function')
    })
    expect(() => markTerminalPaneBootPhase('pty-bound')).not.toThrow()
    // Still latched: a failed emit must not turn into a retry on every later pane.
    markTerminalPaneBootPhase('pty-bound')
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('latches independently of the warm phases and the first-frame marker', async () => {
    const { markAtermWarmPhase, markFirstAtermTerminalFramePresented, markTerminalPaneBootPhase } =
      await import('./aterm-first-terminal-frame-milestone')
    markAtermWarmPhase('worker-ready')
    markTerminalPaneBootPhase('boot-start')
    markFirstAtermTerminalFramePresented()
    expect(logSpy.mock.calls.map(([event]) => event)).toEqual([
      'aterm-worker-ready',
      'pane-boot-start',
      'first-terminal-frame'
    ])
  })
})
