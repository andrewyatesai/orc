import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startGitWasm: vi.fn(),
  reportGitWasmUnavailable: vi.fn()
}))

vi.mock('./git-line-stats', () => ({ startGitWasm: mocks.startGitWasm }))
vi.mock('./git-wasm-unavailable-report', () => ({
  reportGitWasmUnavailable: mocks.reportGitWasmUnavailable
}))

import { awaitGitWasmReadyForStartupHydration } from './git-wasm-startup-gate'

beforeEach(() => {
  mocks.startGitWasm.mockReset()
  mocks.reportGitWasmUnavailable.mockReset()
})

describe('awaitGitWasmReadyForStartupHydration', () => {
  it('resolves when the wasm compile resolves', async () => {
    mocks.startGitWasm.mockResolvedValueOnce(undefined)
    await expect(awaitGitWasmReadyForStartupHydration()).resolves.toBeUndefined()
    expect(mocks.reportGitWasmUnavailable).not.toHaveBeenCalled()
  })

  it('resolves (degraded mode) when the compile REJECTS — hydration must not divert into recovery', async () => {
    mocks.startGitWasm.mockRejectedValueOnce(new Error('compile failed'))
    await expect(awaitGitWasmReadyForStartupHydration()).resolves.toBeUndefined()
  })

  it('reports the rejection instead of discarding it', async () => {
    const error = new WebAssembly.CompileError('expected magic word')
    mocks.startGitWasm.mockRejectedValueOnce(error)

    await awaitGitWasmReadyForStartupHydration()

    expect(mocks.reportGitWasmUnavailable).toHaveBeenCalledTimes(1)
    expect(mocks.reportGitWasmUnavailable).toHaveBeenCalledWith(error)
  })

  it('resolves via the anti-hang backstop when the compile never settles', async () => {
    vi.useFakeTimers()
    try {
      mocks.startGitWasm.mockReturnValueOnce(new Promise(() => {}))
      const gate = awaitGitWasmReadyForStartupHydration(10_000)
      let settled = false
      void gate.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(gate).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT report on the timeout backstop — still-pending is not terminal', async () => {
    vi.useFakeTimers()
    try {
      mocks.startGitWasm.mockReturnValueOnce(new Promise(() => {}))
      const gate = awaitGitWasmReadyForStartupHydration(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      await gate

      expect(mocks.reportGitWasmUnavailable).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
