import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initGitWasm: vi.fn(),
  setOrcaDispatchBinding: vi.fn()
}))

// Mock the generated bindings so the init rejection can be driven deterministically
// without touching the real 1.4 MB artifact.
vi.mock('./orca_git_wasm.js', () => ({
  default: mocks.initGitWasm,
  computeLineStats: vi.fn(),
  initSync: vi.fn(),
  orcaDispatch: vi.fn()
}))
vi.mock('./orca_git_wasm_bg.wasm?url', () => ({ default: 'orca_git_wasm_bg.wasm' }))
vi.mock('../../../../shared/orca-dispatch-seam', () => ({
  setOrcaDispatchBinding: mocks.setOrcaDispatchBinding
}))

import type * as GitLineStats from './git-line-stats'
import type * as GitWasmAvailability from './git-wasm-availability'

type GitLineStatsModule = typeof GitLineStats
type GitWasmAvailabilityModule = typeof GitWasmAvailability

/** `startPromise` is module-level and deliberately never re-armed, so each case
 *  needs a fresh registry — and the availability leaf must come from that same
 *  registry or it would read a different module instance's state. */
async function loadGitWasmModules(): Promise<{
  loader: GitLineStatsModule
  availability: GitWasmAvailabilityModule
}> {
  vi.resetModules()
  return {
    loader: await import('./git-line-stats'),
    availability: await import('./git-wasm-availability')
  }
}

const unhandled: unknown[] = []
function captureUnhandled(reason: unknown): void {
  unhandled.push(reason)
}

beforeEach(() => {
  mocks.initGitWasm.mockReset()
  mocks.setOrcaDispatchBinding.mockReset()
  unhandled.length = 0
  process.on('unhandledRejection', captureUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', captureUnhandled)
})

describe('startGitWasm failure path', () => {
  it('flips the core to the terminal unavailable state instead of leaving it pending forever', async () => {
    const error = new WebAssembly.CompileError('expected magic word 00 61 73 6d')
    mocks.initGitWasm.mockRejectedValue(error)
    const { loader, availability } = await loadGitWasmModules()

    expect(availability.getGitWasmAvailability()).toBe('pending')
    await expect(loader.startGitWasm()).rejects.toBe(error)

    expect(availability.getGitWasmAvailability()).toBe('unavailable')
    expect(availability.isGitWasmUnavailable()).toBe(true)
    expect(availability.isGitWasmReady()).toBe(false)
    expect(availability.getGitWasmLoadError()).toBe(error)
  })

  it('leaves computeLineStats on its null fallback rather than calling into a dead core', async () => {
    mocks.initGitWasm.mockRejectedValue(new Error('boom'))
    const { loader } = await loadGitWasmModules()
    await expect(loader.startGitWasm()).rejects.toThrow('boom')

    expect(loader.computeLineStats('a\n', 'b\n', 'modified')).toBeNull()
  })

  it('never binds the shared dispatch seam when init fails', async () => {
    mocks.initGitWasm.mockRejectedValue(new Error('boom'))
    const { loader } = await loadGitWasmModules()
    await expect(loader.startGitWasm()).rejects.toThrow('boom')

    expect(mocks.setOrcaDispatchBinding).not.toHaveBeenCalled()
  })

  it('does not retry: the rejection is memoized and init runs exactly once', async () => {
    mocks.initGitWasm.mockRejectedValue(new Error('boom'))
    const { loader } = await loadGitWasmModules()

    const first = loader.startGitWasm()
    await expect(first).rejects.toThrow('boom')
    const second = loader.startGitWasm()
    await expect(second).rejects.toThrow('boom')

    expect(second).toBe(first)
    expect(mocks.initGitWasm).toHaveBeenCalledTimes(1)
  })

  it('does not raise an unhandledRejection for the fire-and-forget `void startGitWasm()` boot call', async () => {
    mocks.initGitWasm.mockRejectedValue(new Error('boom'))
    const { loader } = await loadGitWasmModules()

    void loader.startGitWasm()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setImmediate(resolve))

    expect(unhandled).toEqual([])
  })

  it('binds the seam and flips to ready on the success path (regression guard for the reorder)', async () => {
    mocks.initGitWasm.mockResolvedValue(undefined)
    const { loader, availability } = await loadGitWasmModules()

    await expect(loader.startGitWasm()).resolves.toBeUndefined()

    expect(availability.isGitWasmReady()).toBe(true)
    expect(availability.isGitWasmUnavailable()).toBe(false)
    expect(mocks.setOrcaDispatchBinding).toHaveBeenCalledTimes(1)
  })
})
