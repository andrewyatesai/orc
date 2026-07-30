import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartupSnapshot } from '../../../shared/startup-snapshot'
import type { WorkspaceSessionState } from '../../../shared/types'
import {
  createBootSessionApi,
  primeStartupSnapshot,
  resetStartupSnapshotForTest
} from './app-startup-snapshot'

function installWindowApi(api: Record<string, unknown>): void {
  // @ts-expect-error test window mock
  globalThis.window = { api }
}

function sessionState(marker: string): WorkspaceSessionState {
  return { activeWorktreeIdsOnShutdown: [marker] } as unknown as WorkspaceSessionState
}

beforeEach(() => {
  resetStartupSnapshotForTest()
})

describe('primeStartupSnapshot (batched channel)', () => {
  it('fetches once and shares the promise across re-entrant boots (StrictMode double-mount)', async () => {
    const payload: StartupSnapshot = { onboarding: { completed: true } as never }
    const getSnapshot = vi.fn().mockResolvedValue(payload)
    installWindowApi({ startup: { getSnapshot } })

    const first = primeStartupSnapshot()
    const second = primeStartupSnapshot()
    expect(second).toBe(first)
    await expect(first).resolves.toBe(payload)
    // A second adopting run (StrictMode remount) must not re-fetch.
    await expect(primeStartupSnapshot()).resolves.toBe(payload)
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('resolves null on batched failure so hydration falls back to individual channels', async () => {
    installWindowApi({ startup: { getSnapshot: vi.fn().mockRejectedValue(new Error('boom')) } })
    await expect(primeStartupSnapshot()).resolves.toBeNull()
  })
})

describe('primeStartupSnapshot (individual-channel fallback)', () => {
  function installFallbackApi(overrides: Record<string, unknown> = {}): {
    sessionGet: ReturnType<typeof vi.fn>
  } {
    const sessionGet = vi.fn((hostId?: string) =>
      Promise.resolve(hostId === undefined ? sessionState('local') : sessionState(hostId))
    )
    installWindowApi({
      settings: { get: vi.fn().mockResolvedValue({ theme: 'dark' }) },
      ui: { get: vi.fn().mockResolvedValue({ sidebarOpen: true }) },
      keybindings: { get: vi.fn().mockResolvedValue({ overrides: {} }) },
      onboarding: { get: vi.fn().mockResolvedValue({ completed: false }) },
      runtimeEnvironments: {
        list: vi.fn().mockResolvedValue([{ id: 'env-1', name: 'Env', endpoints: [] }])
      },
      session: { get: sessionGet },
      ...overrides
    })
    return { sessionGet }
  }

  it('assembles every boot piece, including runtime-host session partitions', async () => {
    const { sessionGet } = installFallbackApi()
    const snapshot = await primeStartupSnapshot()
    expect(snapshot?.settings).toEqual({ theme: 'dark' })
    expect(snapshot?.ui).toEqual({ sidebarOpen: true })
    expect(snapshot?.keybindings).toEqual({ overrides: {} })
    expect(snapshot?.onboarding).toEqual({ completed: false })
    expect(snapshot?.runtimeEnvironments).toEqual([{ id: 'env-1', name: 'Env', endpoints: [] }])
    expect(snapshot?.sessionPartitionsByHostId?.local).toEqual(sessionState('local'))
    expect(snapshot?.sessionPartitionsByHostId?.['runtime:env-1']).toEqual(
      sessionState('runtime:env-1')
    )
    expect(sessionGet).toHaveBeenCalledTimes(2)
  })

  it('leaves a failed piece undefined without dropping the others', async () => {
    installFallbackApi({ settings: { get: vi.fn().mockRejectedValue(new Error('nope')) } })
    const snapshot = await primeStartupSnapshot()
    expect(snapshot?.settings).toBeUndefined()
    expect(snapshot?.ui).toEqual({ sidebarOpen: true })
    expect(snapshot?.sessionPartitionsByHostId?.local).toEqual(sessionState('local'))
  })

  it('tolerates a missing keybindings api (web serve)', async () => {
    installFallbackApi({ keybindings: undefined })
    const snapshot = await primeStartupSnapshot()
    expect(snapshot?.keybindings).toBeUndefined()
    expect(snapshot?.ui).toEqual({ sidebarOpen: true })
  })
})

describe('createBootSessionApi', () => {
  const live = { get: vi.fn((hostId?: string) => Promise.resolve(sessionState(`live:${hostId}`))) }

  beforeEach(() => {
    live.get.mockClear()
  })

  it('serves snapshot partitions without a live round-trip', async () => {
    const api = createBootSessionApi(live, {
      local: sessionState('snap-local'),
      'runtime:env-1': sessionState('snap-runtime')
    })
    await expect(api.get()).resolves.toEqual(sessionState('snap-local'))
    await expect(api.get('runtime:env-1')).resolves.toEqual(sessionState('snap-runtime'))
    expect(live.get).not.toHaveBeenCalled()
  })

  it('falls back to live session:get for hosts the snapshot missed', async () => {
    const api = createBootSessionApi(live, { local: sessionState('snap-local') })
    await expect(api.get('runtime:env-2')).resolves.toEqual(sessionState('live:runtime:env-2'))
    expect(live.get).toHaveBeenCalledWith('runtime:env-2')
  })

  it('is the live api when no snapshot partitions exist', () => {
    expect(createBootSessionApi(live, undefined)).toBe(live)
  })
})
