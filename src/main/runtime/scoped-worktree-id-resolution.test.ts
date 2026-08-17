import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-local'
const REPO_PATH = '/home/me/dev/app'
const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`

function makeMeta(overrides: Record<string, unknown> = {}) {
  return {
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    instanceId: 'main-instance',
    ...overrides
  }
}

/** Fleet of `repoCount` local git repos: index 0 is `repo-local`, the rest are `repo-local-<i>`. */
function makeStore({ repoCount = 1 }: { repoCount?: number } = {}) {
  const repos = Array.from({ length: repoCount }, (_, index) => ({
    id: index === 0 ? REPO_ID : `${REPO_ID}-${index}`,
    path: index === 0 ? REPO_PATH : `${REPO_PATH}-${index}`,
    displayName: 'app',
    badgeColor: 'blue',
    addedAt: 1
  }))
  const metaById: Record<string, ReturnType<typeof makeMeta>> = {}
  for (const repo of repos) {
    metaById[`${repo.id}::${repo.path}`] = makeMeta({ instanceId: `${repo.id}-main` })
  }
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...(metaById[id] ?? makeMeta()), ...meta } as never
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined as never,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  return store
}

function resolve(runtime: OrcaRuntimeService, selector: string): Promise<{ id: string }> {
  return (
    runtime as unknown as { resolveWorktreeSelector: (s: string) => Promise<{ id: string }> }
  ).resolveWorktreeSelector(selector)
}

function scannedRepoPaths(): string[] {
  return listWorktreesStrictMock.mock.calls.map((call) => call[0] as string)
}

describe('scoped explicit worktree-id resolution', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    listWorktreesStrictMock.mockReset()
    // Every repo has `main` checked out plus one feature worktree, so branch:main is fleet-ambiguous.
    listWorktreesStrictMock.mockImplementation(async (repoPath: string) => [
      { path: repoPath, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      {
        path: `${repoPath}-feature`,
        head: 'def',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })

  it('scans only the owning repo for an id: selector on a cold cache', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)

    const resolved = await resolve(runtime, `id:${MAIN_WORKTREE_ID}`)

    expect(resolved.id).toBe(MAIN_WORKTREE_ID)
    expect(scannedRepoPaths()).toEqual([REPO_PATH])
  })

  it('scopes an id: selector to whichever repo it names, not the first', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)

    const otherId = `${REPO_ID}-3::${REPO_PATH}-3`
    const resolved = await resolve(runtime, `id:${otherId}`)

    expect(resolved.id).toBe(otherId)
    expect(scannedRepoPaths()).toEqual([`${REPO_PATH}-3`])
  })

  it('keeps cross-repo selectors on the fleet path so ambiguity still throws', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)

    // `main` is checked out in every repo, so a branch selector must refuse rather than pick one.
    await expect(resolve(runtime, 'branch:main')).rejects.toThrow('selector_ambiguous')
    expect(new Set(scannedRepoPaths()).size).toBe(10)
  })

  it('falls back to the fleet path when the id names no registered repo', async () => {
    const runtime = new OrcaRuntimeService(makeStore({ repoCount: 10 }) as never)

    await expect(resolve(runtime, 'id:missing-repo::/nowhere')).rejects.toThrow('selector_not_found')
    expect(new Set(scannedRepoPaths()).size).toBe(10)
  })
})
