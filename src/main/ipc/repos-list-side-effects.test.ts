import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, promoteMock, identityMock, usernameMock, mockStore } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  promoteMock: vi.fn(),
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
  promoteFolderReposWithGitRepositories: promoteMock
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

const sideEffectMocks = [promoteMock, identityMock, usernameMock] as const

describe('repos:list side effects (issue #8125 promotion + enrichment)', () => {
  const handlers: HandlerMap = new Map()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    setRepoListSideEffectsRunner(null)
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    for (const mock of sideEffectMocks) {
      mock.mockReset()
    }
    mainWindow.webContents.send.mockReset()

    registerRepoHandlers(mainWindow as never, mockStore as never)
  })

  it('still runs promotion + enrichment on repos:list, before returning the rows', () => {
    const rows = handlers.get('repos:list')!(null)

    for (const mock of sideEffectMocks) {
      expect(mock).toHaveBeenCalledExactlyOnceWith(mockStore, {
        onChanged: expect.any(Function)
      })
    }
    expect(rows).toBe(mockStore.getRepos())
  })

  it('replays the identical side-effect path through the startup-snapshot seam', () => {
    // The boot chain performs zero repos:list round-trips; the seam is the only
    // way the snapshot handler can keep the effects at exactly once per boot.
    runRepoListSideEffectsForStartupSnapshot()

    for (const mock of sideEffectMocks) {
      expect(mock).toHaveBeenCalledExactlyOnceWith(mockStore, {
        onChanged: expect.any(Function)
      })
    }
    // The onChanged wired into the seam is repos:list's: it notifies the main window.
    const onChanged = (promoteMock.mock.calls[0]![1] as { onChanged: () => void }).onChanged
    onChanged()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('macOS window re-creation swaps the seam runner instead of stacking a second one', () => {
    const secondWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    }
    registerRepoHandlers(secondWindow as never, mockStore as never)

    runRepoListSideEffectsForStartupSnapshot()

    // No double-promotion: one replay runs each effect exactly once.
    for (const mock of sideEffectMocks) {
      expect(mock).toHaveBeenCalledTimes(1)
    }
    const onChanged = (promoteMock.mock.calls[0]![1] as { onChanged: () => void }).onChanged
    onChanged()
    expect(secondWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})
