import { describe, expect, it, vi } from 'vitest'

const startGitWasm = vi.hoisted(() => vi.fn())
vi.mock('./git-line-stats', () => ({ startGitWasm }))

import { awaitGitWasmReadyForStartupHydration } from './git-wasm-startup-gate'

describe('awaitGitWasmReadyForStartupHydration', () => {
  it('resolves when the wasm compile resolves', async () => {
    startGitWasm.mockResolvedValueOnce(undefined)
    await expect(awaitGitWasmReadyForStartupHydration()).resolves.toBeUndefined()
  })

  it('resolves (degraded mode) when the compile REJECTS — hydration must not divert into recovery', async () => {
    startGitWasm.mockRejectedValueOnce(new Error('compile failed'))
    await expect(awaitGitWasmReadyForStartupHydration()).resolves.toBeUndefined()
  })

  it('resolves via the anti-hang backstop when the compile never settles', async () => {
    vi.useFakeTimers()
    try {
      startGitWasm.mockReturnValueOnce(new Promise(() => {}))
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
})
