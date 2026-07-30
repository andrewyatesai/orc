import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartupSnapshot } from '../../shared/startup-snapshot'
import { STARTUP_SNAPSHOT_CHANNEL } from '../../shared/startup-snapshot'
import type { Store } from '../persistence'
import {
  registerStartupSnapshotHandler,
  setTrustedStartupSnapshotWebContentsId
} from './startup-snapshot'
import { setRepoListSideEffectsRunner } from './repo-list-boot-side-effects'

const { handlers, listProfilesMock, listEnvironmentsMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
  listProfilesMock: vi.fn(),
  listEnvironmentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/user-data') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: listProfilesMock }
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

function createFakeStore(overrides: Partial<Record<keyof Store, unknown>> = {}): Store {
  return {
    getSettings: vi.fn(() => ({ theme: 'dark' })),
    getUI: vi.fn(() => ({ sidebarOpen: true })),
    getOnboarding: vi.fn(() => ({ completed: true })),
    getRepos: vi.fn(() => [
      { id: 'r1', connectionId: null, executionHostId: 'runtime:env-repo' },
      { id: 'r2', connectionId: null, executionHostId: null }
    ]),
    getProjects: vi.fn(() => [{ id: 'p1' }]),
    getProjectHostSetups: vi.fn(() => [{ id: 'phs1' }]),
    getProjectGroups: vi.fn(() => [{ id: 'g1' }]),
    getFolderWorkspaces: vi.fn(() => [{ id: 'fw1' }]),
    getWorkspaceSession: vi.fn((hostId?: string | null) => ({
      partition: hostId ?? 'local'
    })),
    ...overrides
  } as unknown as Store
}

function invokeSnapshot(senderId = 7): StartupSnapshot {
  const handler = handlers.get(STARTUP_SNAPSHOT_CHANNEL)
  if (!handler) {
    throw new Error('startup snapshot handler not registered')
  }
  return handler({ sender: { id: senderId } }) as StartupSnapshot
}

beforeEach(() => {
  handlers.clear()
  listProfilesMock.mockReset().mockReturnValue([{ id: 'profile-1' }])
  listEnvironmentsMock.mockReset().mockReturnValue([{ id: 'env-1', name: 'Env', endpoints: [] }])
  setTrustedStartupSnapshotWebContentsId(null)
  setRepoListSideEffectsRunner(null)
})

describe('registerStartupSnapshotHandler', () => {
  it('returns every boot read in one payload, with session partitions for saved and repo-derived runtime hosts', () => {
    const store = createFakeStore()
    registerStartupSnapshotHandler(store, {
      getSnapshot: () => ({ overrides: {} })
    } as never)

    const snapshot = invokeSnapshot()
    expect(snapshot.settings).toEqual({ theme: 'dark' })
    expect(snapshot.ui).toEqual({ sidebarOpen: true })
    expect(snapshot.keybindings).toEqual({ overrides: {} })
    expect(snapshot.onboarding).toEqual({ completed: true })
    expect(snapshot.repos).toHaveLength(2)
    expect(snapshot.projects).toEqual([{ id: 'p1' }])
    expect(snapshot.projectHostSetups).toEqual([{ id: 'phs1' }])
    expect(snapshot.projectGroups).toEqual([{ id: 'g1' }])
    expect(snapshot.folderWorkspaces).toEqual([{ id: 'fw1' }])
    expect(snapshot.runtimeEnvironments).toEqual([{ id: 'env-1', name: 'Env', endpoints: [] }])
    expect(snapshot.sessionPartitionsByHostId).toEqual({
      local: { partition: 'local' },
      'runtime:env-repo': { partition: 'runtime:env-repo' },
      'runtime:env-1': { partition: 'runtime:env-1' }
    })
  })

  it('omits keybindings when no service is wired', () => {
    registerStartupSnapshotHandler(createFakeStore())
    expect(invokeSnapshot().keybindings).toBeUndefined()
  })

  it('skips an unreadable session partition instead of failing the snapshot', () => {
    const store = createFakeStore({
      getWorkspaceSession: vi.fn((hostId?: string | null) => {
        if (hostId === 'runtime:env-1') {
          throw new Error('corrupt partition')
        }
        return { partition: hostId ?? 'local' }
      })
    })
    registerStartupSnapshotHandler(store)
    const snapshot = invokeSnapshot()
    expect(snapshot.sessionPartitionsByHostId?.local).toEqual({ partition: 'local' })
    expect(snapshot.sessionPartitionsByHostId?.['runtime:env-1']).toBeUndefined()
  })

  it('fails soft when runtime environment listing throws', () => {
    listEnvironmentsMock.mockImplementation(() => {
      throw new Error('corrupt store')
    })
    registerStartupSnapshotHandler(createFakeStore())
    const snapshot = invokeSnapshot()
    expect(snapshot.runtimeEnvironments).toEqual([])
    expect(snapshot.sessionPartitionsByHostId?.local).toEqual({ partition: 'local' })
  })

  it('hands browser session profiles only to the trusted renderer', () => {
    registerStartupSnapshotHandler(createFakeStore())
    expect(invokeSnapshot(7).browserSessionProfiles).toBeUndefined()

    setTrustedStartupSnapshotWebContentsId(7)
    expect(invokeSnapshot(7).browserSessionProfiles).toEqual([{ id: 'profile-1' }])
    expect(invokeSnapshot(8).browserSessionProfiles).toBeUndefined()
  })

  // The boot chain no longer calls repos:list, so the snapshot must replay its
  // promotion/enrichment side effects (issue #8125) — exactly once per request,
  // before repos are captured, so promotions land in the payload.
  it('replays the repos:list side effects exactly once, before repos are read', () => {
    const store = createFakeStore()
    const promotedRepo = { id: 'r1', connectionId: null, executionHostId: null, kind: 'git' }
    const runner = vi.fn(() => {
      // Simulates the #8125 folder→git promotion mutating the store mid-request.
      ;(store.getRepos as ReturnType<typeof vi.fn>).mockReturnValue([promotedRepo])
    })
    setRepoListSideEffectsRunner(runner)
    registerStartupSnapshotHandler(store)

    const snapshot = invokeSnapshot()
    expect(runner).toHaveBeenCalledTimes(1)
    // No promotion lost: the payload carries the post-promotion rows.
    expect(snapshot.repos).toEqual([promotedRepo])
  })

  it('serves the snapshot even when repo handlers have not installed the side-effect runner', () => {
    registerStartupSnapshotHandler(createFakeStore())
    expect(invokeSnapshot().repos).toHaveLength(2)
  })
})
