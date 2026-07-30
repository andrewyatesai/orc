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

  it('latches phases independently of the first-frame marker', async () => {
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
