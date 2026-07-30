import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }))
vi.mock('@/startup/startup-diagnostics', () => ({
  logRendererStartupDiagnostic: logSpy
}))

describe('markFirstAtermTerminalFramePresented', () => {
  beforeEach(() => {
    // Module-level fire-once latch: a fresh module per test.
    vi.resetModules()
    logSpy.mockClear()
  })

  it('emits the first-terminal-frame startup milestone exactly once', async () => {
    const { markFirstAtermTerminalFramePresented } =
      await import('./aterm-first-terminal-frame-milestone')
    markFirstAtermTerminalFramePresented()
    markFirstAtermTerminalFramePresented()
    markFirstAtermTerminalFramePresented()
    expect(logSpy).toHaveBeenCalledTimes(1)
    // The channel prefixes 'renderer-', producing 'renderer-first-terminal-frame'.
    expect(logSpy).toHaveBeenCalledWith('first-terminal-frame')
  })
})
