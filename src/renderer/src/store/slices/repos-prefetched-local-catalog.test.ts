import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  FolderWorkspace,
  Project,
  ProjectHostSetup,
  ProjectGroup,
  Repo
} from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/srv/repo',
  displayName: 'Remote',
  badgeColor: '#000',
  addedAt: 1
}

const localProject: Project = {
  id: 'local-project',
  displayName: 'Local project',
  badgeColor: '#000',
  sourceRepoIds: ['local-repo'],
  createdAt: 1,
  updatedAt: 1
}

const localProjectHostSetup: ProjectHostSetup = {
  id: 'local-setup',
  projectId: 'local-project',
  hostId: 'local',
  repoId: 'local-repo',
  path: '/local',
  displayName: 'Local setup',
  setupState: 'setting-up',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}

const localProjectGroup: ProjectGroup = {
  id: 'local-group',
  name: 'Local group',
  parentPath: '/local',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const localFolderWorkspace: FolderWorkspace = {
  id: 'local-folder',
  projectGroupId: 'local-group',
  name: 'Local folder',
  folderPath: '/local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const projectGroupsList = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset().mockResolvedValue([localRepo])
  projectsList.mockReset().mockResolvedValue([localProject])
  listHostSetups.mockReset().mockResolvedValue([localProjectHostSetup])
  projectGroupsList.mockReset().mockResolvedValue([localProjectGroup])
  folderWorkspacesList.mockReset().mockResolvedValue([localFolderWorkspace])
  runtimeEnvironmentsList.mockReset().mockResolvedValue([{ id: 'env-1', name: 'lobster' }])
  runtimeEnvironmentTransportCall
    .mockReset()
    .mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repo-list',
          ok: true,
          result: { repos: [remoteRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return (
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-other',
          ok: true,
          result: { projects: [], setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      )
    })

  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups: listHostSetups },
      projectGroups: { list: projectGroupsList },
      folderWorkspaces: { list: folderWorkspacesList },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      }
    },
    dispatchEvent: vi.fn()
  })
})

// The startup snapshot carries the local catalog rows; the boot chain hands
// them to the all-host fetchers as prefetchedLocal instead of round-tripping
// repos:list / projects:list / projectHostSetups:list / projectGroups:list /
// folderWorkspaces:list. repos:list's promotion/enrichment side effects run
// main-side in the snapshot handler (see repos-list-side-effects.test.ts).
describe('snapshot-prefetched local catalog hydration', () => {
  it('hydrates with zero catalog round-trips, byte-identical to the live channels', async () => {
    // Baseline: the snapshot-absent fallback path through the live channels.
    const liveStore = createTestStore()
    await liveStore.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await liveStore.getState().fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
    await liveStore.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })

    reposList.mockClear()
    projectsList.mockClear()
    listHostSetups.mockClear()
    projectGroupsList.mockClear()
    folderWorkspacesList.mockClear()

    // The snapshot path: identical store rows arrive prefetched instead.
    const snapshotStore = createTestStore()
    await snapshotStore.getState().fetchReposForAllHosts({
      remoteHosts: 'skip',
      prefetchedLocal: {
        repos: [localRepo],
        projects: [localProject],
        projectHostSetups: [localProjectHostSetup]
      }
    })
    await snapshotStore.getState().fetchProjectGroupsForAllHosts({
      remoteHosts: 'skip',
      prefetchedLocal: [localProjectGroup]
    })
    await snapshotStore.getState().fetchFolderWorkspacesForAllHosts({
      remoteHosts: 'skip',
      prefetchedLocal: [localFolderWorkspace]
    })

    expect(reposList).not.toHaveBeenCalled()
    expect(projectsList).not.toHaveBeenCalled()
    expect(listHostSetups).not.toHaveBeenCalled()
    expect(projectGroupsList).not.toHaveBeenCalled()
    expect(folderWorkspacesList).not.toHaveBeenCalled()
    expect(runtimeEnvironmentsList).not.toHaveBeenCalled()
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()

    // Both boots must land on the same hydrated state (the fallback stays byte-identical).
    expect(snapshotStore.getState().repos).toEqual(liveStore.getState().repos)
    expect(snapshotStore.getState().projects).toEqual(liveStore.getState().projects)
    expect(snapshotStore.getState().projectHostSetups).toEqual(
      liveStore.getState().projectHostSetups
    )
    expect(snapshotStore.getState().projectGroups).toEqual(liveStore.getState().projectGroups)
    expect(snapshotStore.getState().folderWorkspaces).toEqual(liveStore.getState().folderWorkspaces)
  })

  it('keeps the deferred remote refresh on the live channels after a prefetched boot', async () => {
    const store = createTestStore()
    await store.getState().fetchReposForAllHosts({
      remoteHosts: 'skip',
      prefetchedLocal: {
        repos: [localRepo],
        projects: [localProject],
        projectHostSetups: [localProjectHostSetup]
      }
    })
    expect(reposList).not.toHaveBeenCalled()

    // The post-hydration refresh passes no prefetched rows, so it round-trips again.
    await store.getState().fetchReposForAllHosts()

    expect(reposList).toHaveBeenCalledTimes(1)
    expect(
      store
        .getState()
        .repos.map((repo) => `${repo.id}:${repo.executionHostId}`)
        .sort()
    ).toEqual(['local-repo:local', 'remote-repo:runtime:env-1'])
  })
})
