import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import type { FolderWorkspacePathStatusCacheEntry } from './repos'
import { createTestStore } from './store-test-helpers'

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Group 1',
  parentPath: '/parent',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const folderWorkspace: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Folder 1',
  folderPath: '/parent/folder-1',
  linkedTask: {
    provider: 'github',
    type: 'issue',
    number: 7,
    title: 'Issue 7',
    url: 'https://example.test/7'
  },
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const secondFolderWorkspace: FolderWorkspace = {
  ...folderWorkspace,
  id: 'folder-2',
  name: 'Folder 2',
  folderPath: '/parent/folder-2',
  linkedTask: null,
  sortOrder: 1
}

const repo: Repo = {
  id: 'repo-1',
  path: '/repo-1',
  displayName: 'Repo 1',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}

const localGroup: ProjectGroup = { ...projectGroup, executionHostId: 'local' }

const cachedPathStatuses: Record<string, FolderWorkspacePathStatusCacheEntry> = {
  'local:folder-workspace:folder-1': {
    status: { path: '/parent/folder-1', exists: false, reason: 'missing' },
    checkedAt: Date.now(),
    requestSnapshot: 'snapshot'
  }
}

const projectGroupsList = vi.fn()
const folderWorkspacesList = vi.fn()
const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const runtimeEnvironmentsList = vi.fn()

// Why: catalogs arrive over IPC, so every fetch must hand back freshly allocated objects.
function clone<T>(value: T): T {
  return structuredClone(value)
}

beforeEach(() => {
  projectGroupsList.mockReset()
  folderWorkspacesList.mockReset()
  reposList.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  runtimeEnvironmentsList.mockReset()
  projectGroupsList.mockImplementation(async () => [clone(projectGroup)])
  folderWorkspacesList.mockImplementation(async () => [clone(folderWorkspace)])
  reposList.mockImplementation(async () => [clone(repo)])
  projectsList.mockImplementation(async () => [])
  listHostSetups.mockImplementation(async () => [])
  runtimeEnvironmentsList.mockImplementation(async () => [])

  vi.stubGlobal('window', {
    api: {
      projectGroups: { list: projectGroupsList },
      folderWorkspaces: { list: folderWorkspacesList },
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups },
      runtimeEnvironments: { list: runtimeEnvironmentsList }
    },
    dispatchEvent: vi.fn()
  })
})

describe('catalog merge referential stability', () => {
  it('keeps the same projectGroups array when a refetch changes nothing', async () => {
    const store = createTestStore()

    await store.getState().fetchProjectGroups()
    const first = store.getState().projectGroups
    expect(first).toEqual([localGroup])

    await store.getState().fetchProjectGroups()

    expect(store.getState().projectGroups).toBe(first)
  })

  it('keeps the same folderWorkspaces array (and entries) when a refetch changes nothing', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup] })

    await store.getState().fetchFolderWorkspaces()
    const first = store.getState().folderWorkspaces
    expect(first).toHaveLength(1)
    const firstEntry = first[0]

    await store.getState().fetchFolderWorkspaces()

    expect(store.getState().folderWorkspaces).toBe(first)
    expect(store.getState().folderWorkspaces[0]).toBe(firstEntry)
  })

  it('replaces changed project groups while keeping unchanged ones referentially stable', async () => {
    const store = createTestStore()

    await store.getState().fetchProjectGroups()
    const first = store.getState().projectGroups

    projectGroupsList.mockImplementation(async () => [clone({ ...projectGroup, name: 'Renamed' })])
    await store.getState().fetchProjectGroups()

    const merged = store.getState().projectGroups
    expect(merged).not.toBe(first)
    expect(merged).toEqual([{ ...localGroup, name: 'Renamed' }])
  })

  it('appends new all-host folder workspaces without disturbing existing order', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup] })

    await store.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
    const firstEntry = store.getState().folderWorkspaces[0]

    folderWorkspacesList.mockImplementation(async () => [
      clone(secondFolderWorkspace),
      clone(folderWorkspace)
    ])
    await store.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })

    const merged = store.getState().folderWorkspaces
    expect(merged.map((workspace) => workspace.id)).toEqual(['folder-1', 'folder-2'])
    // Unchanged entries keep their reference even when the array changes.
    expect(merged[0]).toBe(firstEntry)
  })

  it('treats a nested linkedTask change as a change', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup] })

    await store.getState().fetchFolderWorkspaces()
    const first = store.getState().folderWorkspaces

    folderWorkspacesList.mockImplementation(async () => [
      clone({
        ...folderWorkspace,
        linkedTask: { ...folderWorkspace.linkedTask!, title: 'Issue 7 renamed' }
      })
    ])
    await store.getState().fetchFolderWorkspaces()

    expect(store.getState().folderWorkspaces).not.toBe(first)
    expect(store.getState().folderWorkspaces[0]?.linkedTask?.title).toBe('Issue 7 renamed')
  })
})

// The sidebar burst that refills this cache only runs when these arrays change reference, so a
// no-op fetch must not wipe it — otherwise stale-folder rows silently fail open forever.
describe('folder path status cache retention across catalog fetches', () => {
  it('keeps cached path statuses when a project-group refetch changes nothing', async () => {
    const store = createTestStore()
    await store.getState().fetchProjectGroups()
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    await store.getState().fetchProjectGroups()

    expect(store.getState().folderWorkspacePathStatuses).toBe(cachedPathStatuses)
  })

  it('clears cached path statuses when the project-group catalog changes', async () => {
    const store = createTestStore()
    await store.getState().fetchProjectGroups()
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    projectGroupsList.mockImplementation(async () => [clone({ ...projectGroup, name: 'Renamed' })])
    await store.getState().fetchProjectGroups()

    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })

  it('keeps cached path statuses when an all-host project-group refetch changes nothing', async () => {
    const store = createTestStore()
    await store.getState().fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    await store.getState().fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().folderWorkspacePathStatuses).toBe(cachedPathStatuses)
  })

  it('keeps cached path statuses when a folder-workspace refetch changes nothing', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup] })
    await store.getState().fetchFolderWorkspaces()
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    await store.getState().fetchFolderWorkspaces()

    expect(store.getState().folderWorkspacePathStatuses).toBe(cachedPathStatuses)
  })

  it('keeps cached path statuses when an all-host folder-workspace refetch changes nothing', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup] })
    await store.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    await store.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().folderWorkspacePathStatuses).toBe(cachedPathStatuses)
  })

  it('clears cached path statuses when a folder workspace path changes', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup] })
    await store.getState().fetchFolderWorkspaces()
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    folderWorkspacesList.mockImplementation(async () => [
      clone({ ...folderWorkspace, folderPath: '/parent/folder-1-renamed' })
    ])
    await store.getState().fetchFolderWorkspaces()

    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })

  it('keeps cached path statuses when a repo refetch changes nothing', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    await store.getState().fetchRepos()

    expect(store.getState().folderWorkspacePathStatuses).toBe(cachedPathStatuses)
  })

  it('keeps cached path statuses when an all-host repo refetch changes nothing', async () => {
    const store = createTestStore()
    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().folderWorkspacePathStatuses).toBe(cachedPathStatuses)
  })

  it('clears cached path statuses when the repo catalog changes', async () => {
    const store = createTestStore()
    await store.getState().fetchRepos()
    store.setState({ folderWorkspacePathStatuses: cachedPathStatuses })

    reposList.mockImplementation(async () => [clone({ ...repo, path: '/repo-1-moved' })])
    await store.getState().fetchRepos()

    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })
})
