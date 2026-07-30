import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, promoteMock, markerMock, probeMock, identityMock, usernameMock, mockStore } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    promoteMock: vi.fn(),
    markerMock: vi.fn(),
    probeMock: vi.fn(),
    identityMock: vi.fn(),
    usernameMock: vi.fn(),
    mockStore: {
      getRepos: vi
        .fn()
        .mockReturnValue([
          { id: 'repo-1', path: '/repo-1', displayName: 'One', badgeColor: '#000', addedAt: 0 }
        ]),
      getRepo: vi.fn(),
      updateRepo: vi.fn()
    }
  }))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('../repo-folder-git-promotion', () => ({
  promoteFolderReposWithGitRepositories: promoteMock,
  collectFolderReposNeedingGitProbe: markerMock,
  promoteFolderReposFromGitProbe: probeMock
}))

vi.mock('../repo-git-remote-identity-enrichment', () => ({
  enrichMissingRepoGitRemoteIdentities: identityMock
}))

vi.mock('../repo-git-username-enrichment', () => ({
  enrichRepoGitUsernames: usernameMock
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([]),
  BASE_REF_SEARCH_ARGS: ['for-each-ref'],
  filterBaseRefSearchOutput: vi.fn().mockReturnValue([])
}))

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

import { registerRepoHandlers } from './repos'
import {
  runRepoListSideEffectsForStartupSnapshot,
  setRepoListSideEffectsRunner
} from './repo-list-boot-side-effects'

type HandlerMap = Map<string, (_event: unknown, args?: unknown) => unknown>

const sideEffectMocks = [promoteMock, markerMock, probeMock, identityMock, usernameMock] as const
const bootSideEffectMocks = [identityMock, usernameMock] as const

/** Runs the deferred boot git probe, which is scheduled past the renderer's mount. */
const flushDeferredWork = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(5_000)
}

describe('repos:list side effects (issue #8125 promotion + enrichment)', () => {
  const handlers: HandlerMap = new Map()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    setRepoListSideEffectsRunner(null)
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    for (const mock of sideEffectMocks) {
      mock.mockReset()
    }
    markerMock.mockReturnValue([])
    mainWindow.webContents.send.mockReset()

    registerRepoHandlers(mainWindow as never, mockStore as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('still runs promotion + enrichment on repos:list, before returning the rows', () => {
    const rows = handlers.get('repos:list')!(null)

    // repos:list can afford the git spawn, so it keeps the single-call promotion.
    for (const mock of [promoteMock, identityMock, usernameMock]) {
      expect(mock).toHaveBeenCalledExactlyOnceWith(mockStore, {
        onChanged: expect.any(Function)
      })
    }
    expect(markerMock).not.toHaveBeenCalled()
    expect(rows).toBe(mockStore.getRepos())
  })

  it('replays the side effects through the startup-snapshot seam without the git probe', () => {
    // The boot chain performs zero repos:list round-trips; the seam is the only
    // way the snapshot handler can keep the effects at exactly once per boot.
    runRepoListSideEffectsForStartupSnapshot()

    for (const mock of bootSideEffectMocks) {
      expect(mock).toHaveBeenCalledExactlyOnceWith(mockStore, {
        onChanged: expect.any(Function)
      })
    }
    // The spawn-capable single-call promotion never runs on the boot path.
    expect(promoteMock).not.toHaveBeenCalled()
    // Triage takes only the store: it promotes nothing itself (git is the sole
    // classifier), so the repos:changed notifier rides the deferred probe.
    expect(markerMock).toHaveBeenCalledExactlyOnceWith(mockStore)
  })

  it('probes the marker pass leftovers off the boot path and broadcasts repos:changed', async () => {
    const undecided = [{ id: 'repo-1', path: '/repo-1', kind: 'folder' }]
    markerMock.mockReturnValue(undecided)

    runRepoListSideEffectsForStartupSnapshot()
    expect(probeMock).not.toHaveBeenCalled()

    // Still parked while the renderer is mounting: repos:changed has no buffer,
    // so a promotion broadcast before the listener attaches would be lost.
    await vi.advanceTimersByTimeAsync(100)
    expect(probeMock).not.toHaveBeenCalled()

    await flushDeferredWork()
    expect(probeMock).toHaveBeenCalledExactlyOnceWith(mockStore, undecided, {
      onChanged: expect.any(Function)
    })
    // Convergence path for a promotion that missed the snapshot payload.
    const onChanged = (probeMock.mock.calls[0]![2] as { onChanged: () => void }).onChanged
    onChanged()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('does not stack a second probe when a snapshot is re-requested before the first runs', async () => {
    markerMock.mockReturnValue([{ id: 'repo-1', path: '/repo-1', kind: 'folder' }])

    runRepoListSideEffectsForStartupSnapshot()
    runRepoListSideEffectsForStartupSnapshot()
    await flushDeferredWork()

    expect(probeMock).toHaveBeenCalledTimes(1)
    // The marker pass itself still replays per request — it is stat-cheap and idempotent.
    expect(markerMock).toHaveBeenCalledTimes(2)
  })

  it('probes again on a later boot once the previous probe has settled', async () => {
    markerMock.mockReturnValue([{ id: 'repo-1', path: '/repo-1', kind: 'folder' }])

    runRepoListSideEffectsForStartupSnapshot()
    await flushDeferredWork()
    runRepoListSideEffectsForStartupSnapshot()
    await flushDeferredWork()

    // Nothing persists an "already attempted" marker, so a renderer reload (or a
    // boot cut short before the probe ran) re-derives the candidates from disk.
    expect(probeMock).toHaveBeenCalledTimes(2)
  })

  it('skips the deferred probe entirely when the marker pass settled every repo', async () => {
    runRepoListSideEffectsForStartupSnapshot()
    await flushDeferredWork()

    expect(probeMock).not.toHaveBeenCalled()
  })

  it('macOS window re-creation swaps the seam runner instead of stacking a second one', () => {
    const secondWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    }
    registerRepoHandlers(secondWindow as never, mockStore as never)

    runRepoListSideEffectsForStartupSnapshot()

    // No double-promotion: one replay runs each effect exactly once.
    for (const mock of bootSideEffectMocks) {
      expect(mock).toHaveBeenCalledTimes(1)
    }
    // Triage promotes nothing (only git classifies), so the repos:changed
    // notifier rides the deferred probe: assert the SECOND window's seam ran.
    expect(markerMock).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})
