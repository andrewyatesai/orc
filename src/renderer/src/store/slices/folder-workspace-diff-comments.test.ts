import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createDiffCommentsSlice } from './diffComments'

const folderWorkspacesUpdate = vi.fn()

globalThis.window = {
  api: {
    folderWorkspaces: { update: folderWorkspacesUpdate }
  }
} as never

function createTestStore() {
  return create<AppState>()((...args) => {
    const slice = createDiffCommentsSlice(...args)
    return {
      ...slice,
      settings: null,
      activeWorktreeId: null,
      folderWorkspaces: [],
      projectGroups: [],
      runtimeEnvironments: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      worktreesByRepo: {}
    } as unknown as AppState
  })
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    folderPath: '/workspace',
    diffComments: [],
    ...overrides
  } as FolderWorkspace
}

function seedLocalFolderWorkspace(store: ReturnType<typeof createTestStore>): FolderWorkspace {
  const folderWorkspace = makeFolderWorkspace()
  const projectGroup = {
    id: folderWorkspace.projectGroupId,
    parentPath: '/workspace',
    executionHostId: 'local'
  } as ProjectGroup
  store.setState({
    activeWorktreeId: folderWorkspaceKey(folderWorkspace.id),
    projectGroups: [projectGroup],
    folderWorkspaces: [folderWorkspace]
  })
  return folderWorkspace
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('folder workspace diff comments', () => {
  it('adds and persists a review note', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => ({
      ...folderWorkspace,
      ...updates
    }))

    const saved = await store.getState().addDiffComment({
      worktreeId: folderWorkspaceKey(folderWorkspace.id),
      filePath: 'README.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'folder note',
      side: 'modified'
    })

    expect(saved).toEqual(expect.objectContaining({ body: 'folder note' }))
    expect(store.getState().getDiffComments(folderWorkspaceKey(folderWorkspace.id))).toEqual([
      expect.objectContaining({ body: 'folder note' })
    ])
    expect(folderWorkspacesUpdate).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { diffComments: [expect.objectContaining({ body: 'folder note' })] }
    })
  })

  it('preserves a second note while the first write is in flight', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    let releaseFirstWrite: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => {
      if (folderWorkspacesUpdate.mock.calls.length === 1) {
        await firstWrite
      }
      return { ...folderWorkspace, ...updates }
    })

    const addFirst = store.getState().addDiffComment({
      worktreeId: folderWorkspaceKey(folderWorkspace.id),
      filePath: 'README.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'first note',
      side: 'modified'
    })
    await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1))
    const addSecond = store.getState().addDiffComment({
      worktreeId: folderWorkspaceKey(folderWorkspace.id),
      filePath: 'README.md',
      source: 'markdown',
      lineNumber: 2,
      body: 'second note',
      side: 'modified'
    })
    releaseFirstWrite?.()

    await Promise.all([addFirst, addSecond])
    expect(store.getState().getDiffComments(folderWorkspaceKey(folderWorkspace.id))).toEqual([
      expect.objectContaining({ body: 'first note' }),
      expect.objectContaining({ body: 'second note' })
    ])
    expect(folderWorkspacesUpdate).toHaveBeenLastCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: {
        diffComments: [
          expect.objectContaining({ body: 'first note' }),
          expect.objectContaining({ body: 'second note' })
        ]
      }
    })
  })

  it('rolls back the optimistic note when the runtime strips the field', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    // Why: an older paired runtime drops diffComments; persist must treat that as a failed write.
    folderWorkspacesUpdate.mockImplementation(async () => ({
      ...folderWorkspace,
      diffComments: undefined
    }))

    const saved = await store.getState().addDiffComment({
      worktreeId: folderWorkspaceKey(folderWorkspace.id),
      filePath: 'README.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'folder note',
      side: 'modified'
    })

    expect(saved).toBeNull()
    expect(store.getState().getDiffComments(folderWorkspaceKey(folderWorkspace.id))).toEqual([])
  })
})
