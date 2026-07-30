import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/types'

const { statSyncMock, isGitRepoMock } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
  isGitRepoMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>() // eslint-disable-line @typescript-eslint/consistent-type-imports -- importOriginal requires inline import()
  return { ...actual, statSync: statSyncMock }
})

vi.mock('./git/repo', () => ({
  isGitRepo: isGitRepoMock
}))

import {
  promoteFolderReposFromGitProbe,
  collectFolderReposNeedingGitProbe,
  promoteFolderReposWithGitRepositories
} from './repo-folder-git-promotion'
import {
  runRepoListSideEffectsForStartupSnapshot,
  setRepoListSideEffectsRunner
} from './ipc/repo-list-boot-side-effects'

const NOTES = '/projects/notes'

/** Entry kind per path; anything absent throws ENOENT like the real statSync. */
function mockFilesystem(entries: Record<string, 'file' | 'dir'>): void {
  statSyncMock.mockImplementation((path: string) => {
    const kind = entries[String(path)]
    if (!kind) {
      throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' })
    }
    return { isFile: () => kind === 'file', isDirectory: () => kind === 'dir' }
  })
}

/** The layout `git init` leaves behind: a `.git` dir with HEAD, objects, refs. */
function initializedGitWorkTree(repoPath: string): Record<string, 'file' | 'dir'> {
  const gitDir = join(repoPath, '.git')
  return {
    [gitDir]: 'dir',
    [join(gitDir, 'HEAD')]: 'file',
    [join(gitDir, 'objects')]: 'dir',
    [join(gitDir, 'refs')]: 'dir'
  }
}

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: NOTES,
    displayName: 'notes',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'folder',
    ...overrides
  } as Repo
}

function makeStore(repos: Repo[]) {
  const byId = new Map(repos.map((repo) => [repo.id, repo]))
  return {
    getRepos: () => [...byId.values()],
    getRepo: (id: string) => byId.get(id),
    updateRepo: vi.fn((id: string, updates: Partial<Repo>) => {
      const current = byId.get(id)
      if (!current) {
        return null
      }
      const updated = { ...current, ...updates }
      byId.set(id, updated)
      return updated
    })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  statSyncMock.mockReset()
  mockFilesystem({})
  isGitRepoMock.mockReset().mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('collectFolderReposNeedingGitProbe (spawn-free triage)', () => {
  it('hands a git-init tree to the probe WITHOUT spawning git or promoting on its own', () => {
    mockFilesystem(initializedGitWorkTree(NOTES))
    const store = makeStore([makeRepo({})])

    const needGitProbe = collectFolderReposNeedingGitProbe(store)

    // Only git decides what a marker means: a local stat-based rule would
    // promote rows `git rev-parse` rejects. Triage defers, never promotes.
    expect(needGitProbe).toEqual([expect.objectContaining({ id: 'repo-1', path: NOTES })])
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(isGitRepoMock).not.toHaveBeenCalled()
  })

  it('touches nothing while no .git entry exists', () => {
    const store = makeStore([makeRepo({})])

    expect(collectFolderReposNeedingGitProbe(store)).toEqual([])
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('defers a .git directory that lacks git metadata', () => {
    mockFilesystem({ [join(NOTES, '.git')]: 'dir' })
    const store = makeStore([makeRepo({})])

    expect(collectFolderReposNeedingGitProbe(store)).toEqual([
      expect.objectContaining({ id: 'repo-1' })
    ])
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('defers a .git pointer file (linked worktree / submodule)', () => {
    mockFilesystem({ [join(NOTES, '.git')]: 'file' })
    const store = makeStore([makeRepo({})])

    expect(collectFolderReposNeedingGitProbe(store)).toHaveLength(1)
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('defers a linked-worktree admin dir (HEAD + commondir) to git as well', () => {
    const gitDir = join(NOTES, '.git')
    mockFilesystem({
      [gitDir]: 'dir',
      [join(gitDir, 'HEAD')]: 'file',
      [join(gitDir, 'commondir')]: 'file'
    })
    const store = makeStore([makeRepo({})])

    expect(collectFolderReposNeedingGitProbe(store)).toHaveLength(1)
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it('never scans git-kind or SSH-connected repos', () => {
    mockFilesystem(initializedGitWorkTree(NOTES))
    const store = makeStore([
      makeRepo({ id: 'git-repo', kind: 'git' }),
      makeRepo({ id: 'ssh-folder', connectionId: 'conn-1' })
    ])

    expect(collectFolderReposNeedingGitProbe(store)).toEqual([])
    expect(statSyncMock).not.toHaveBeenCalled()
  })
})

describe('promoteFolderReposFromGitProbe (spawn-capable half)', () => {
  it('promotes a candidate the git probe confirms', () => {
    isGitRepoMock.mockReturnValue(true)
    const store = makeStore([makeRepo({})])
    const onChanged = vi.fn()

    promoteFolderReposFromGitProbe(store, [makeRepo({})], { onChanged })

    expect(isGitRepoMock).toHaveBeenCalledWith(NOTES)
    expect(store.updateRepo).toHaveBeenCalledWith('repo-1', {
      kind: 'git',
      externalWorktreeVisibility: 'hide'
    })
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('leaves a .git entry that is not a real repository unpromoted', () => {
    isGitRepoMock.mockReturnValue(false)
    const store = makeStore([makeRepo({})])
    const onChanged = vi.fn()

    promoteFolderReposFromGitProbe(store, [makeRepo({})], { onChanged })

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('does not promote twice when a repos:list already promoted the candidate', () => {
    isGitRepoMock.mockReturnValue(true)
    // The live row is already git-kind — exactly the state a repos:list running
    // right after boot leaves behind while the deferred probe is still queued.
    const store = makeStore([makeRepo({ kind: 'git' })])
    const onChanged = vi.fn()

    promoteFolderReposFromGitProbe(store, [makeRepo({})], { onChanged })

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    // The stale-row check runs before the spawn, so the redundant probe is skipped too.
    expect(isGitRepoMock).not.toHaveBeenCalled()
  })

  it('ignores a candidate whose row was removed while the probe was queued', () => {
    isGitRepoMock.mockReturnValue(true)
    const store = makeStore([])
    const onChanged = vi.fn()

    promoteFolderReposFromGitProbe(store, [makeRepo({})], { onChanged })

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('promoteFolderReposWithGitRepositories (both halves, for repos:list)', () => {
  it('promotes every git-confirmed repo with a single change notification', () => {
    mockFilesystem({
      ...initializedGitWorkTree('/projects/marker'),
      [join('/projects/probe', '.git')]: 'dir'
    })
    isGitRepoMock.mockReturnValue(true)
    const store = makeStore([
      makeRepo({ id: 'marker', path: '/projects/marker' }),
      makeRepo({ id: 'probe', path: '/projects/probe' })
    ])
    const onChanged = vi.fn()

    promoteFolderReposWithGitRepositories(store, { onChanged })

    expect(store.updateRepo).toHaveBeenCalledWith(
      'marker',
      expect.objectContaining({ kind: 'git' })
    )
    expect(store.updateRepo).toHaveBeenCalledWith('probe', expect.objectContaining({ kind: 'git' }))
    // Every marker goes to git — it is the only classifier.
    expect(isGitRepoMock.mock.calls.map((call) => call[0] as string).sort()).toEqual([
      '/projects/marker',
      '/projects/probe'
    ])
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('notifies once for a git-init tree the probe confirms', () => {
    mockFilesystem(initializedGitWorkTree(NOTES))
    isGitRepoMock.mockReturnValue(true)
    const store = makeStore([makeRepo({})])
    const onChanged = vi.fn()

    promoteFolderReposWithGitRepositories(store, { onChanged })

    expect(store.updateRepo).toHaveBeenCalledWith('repo-1', expect.objectContaining({ kind: 'git' }))
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('does NOT promote when git rejects the marker', () => {
    mockFilesystem(initializedGitWorkTree(NOTES))
    isGitRepoMock.mockReturnValue(false)
    const store = makeStore([makeRepo({})])
    const onChanged = vi.fn()

    promoteFolderReposWithGitRepositories(store, { onChanged })

    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('boot seam convergence with the real promotion module', () => {
  /** Mirrors the wiring registerRepoHandlers installs, with the store and the
   *  repos:changed broadcast faked. */
  function installSeam(store: ReturnType<typeof makeStore>, reposChanged: () => void): void {
    setRepoListSideEffectsRunner(() => {
      const needGitProbe = collectFolderReposNeedingGitProbe(store)
      return needGitProbe.length > 0
        ? () => promoteFolderReposFromGitProbe(store, needGitProbe, { onChanged: reposChanged })
        : null
    })
  }

  afterEach(() => {
    setRepoListSideEffectsRunner(null)
  })

  it('never spawns git on the boot path, even for a git-init tree', () => {
    mockFilesystem(initializedGitWorkTree(NOTES))
    isGitRepoMock.mockReturnValue(true)
    const store = makeStore([makeRepo({})])
    const reposChanged = vi.fn()
    installSeam(store, reposChanged)

    runRepoListSideEffectsForStartupSnapshot()

    // The snapshot handler reads store.getRepos() right after this returns:
    // the row is still folder-kind, and no git subprocess ran.
    expect(store.getRepos()[0]!.kind).toBe('folder')
    expect(isGitRepoMock).not.toHaveBeenCalled()
    expect(reposChanged).not.toHaveBeenCalled()
  })

  it('defers an ambiguous marker and converges through repos:changed', async () => {
    // A `.git` directory git alone can classify: the boot path must not wait on it.
    mockFilesystem({ [join(NOTES, '.git')]: 'dir' })
    isGitRepoMock.mockReturnValue(true)
    const store = makeStore([makeRepo({})])
    const reposChanged = vi.fn()
    installSeam(store, reposChanged)

    runRepoListSideEffectsForStartupSnapshot()
    expect(store.getRepos()[0]!.kind).toBe('folder')
    expect(isGitRepoMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getRepos()[0]!.kind).toBe('git')
    // The renderer's repos:changed handler re-lists and picks the promoted row up.
    expect(reposChanged).toHaveBeenCalledOnce()

    store.updateRepo.mockClear()
    reposChanged.mockClear()
    promoteFolderReposWithGitRepositories(store, { onChanged: reposChanged })
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(reposChanged).not.toHaveBeenCalled()
  })

  it('lets a repos:list that overtakes the queued probe win without promoting twice', async () => {
    mockFilesystem({ [join(NOTES, '.git')]: 'dir' })
    isGitRepoMock.mockReturnValue(true)
    const store = makeStore([makeRepo({})])
    const reposChanged = vi.fn()
    installSeam(store, reposChanged)

    runRepoListSideEffectsForStartupSnapshot()
    // A non-boot repos:list right after boot, while the probe is still queued.
    promoteFolderReposWithGitRepositories(store, { onChanged: reposChanged })
    expect(store.updateRepo).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.updateRepo).toHaveBeenCalledOnce()
    expect(reposChanged).toHaveBeenCalledOnce()
    expect(store.getRepos()[0]!.kind).toBe('git')
  })
})
