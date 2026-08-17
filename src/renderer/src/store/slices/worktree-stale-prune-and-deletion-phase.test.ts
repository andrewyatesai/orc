import { describe, expect, it } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { DetectedWorktreeListResult, WorkspaceKey } from '../../../../shared/types'

const STALE = 'repo1::/stale'
const LIVE = 'repo1::/live'

function authoritative(worktreeIds: string[]): DetectedWorktreeListResult {
  return {
    repoId: 'repo1',
    authoritative: true,
    source: 'git',
    worktrees: worktreeIds.map(
      (id) =>
        ({
          ...makeWorktree({ id, repoId: 'repo1', hostId: 'local' }),
          ownership: 'orca-managed',
          selectedCheckout: true,
          visible: true
        }) as DetectedWorktreeListResult['worktrees'][number]
    )
  }
}

describe('pruneLastVisitedTimestamps stale workspace-key cleanup', () => {
  it('clears the derived workspace key alongside the stale active worktree', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: LIVE, repoId: 'repo1' })] },
      detectedWorktreesByRepo: { repo1: authoritative([LIVE]) },
      lastVisitedAtByWorktreeId: { [STALE]: 1, [LIVE]: 2 },
      activeWorktreeId: STALE,
      activeWorkspaceKey: worktreeWorkspaceKey(STALE)
    })

    store.getState().pruneLastVisitedTimestamps()

    const s = store.getState()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeWorkspaceKey).toBeNull()
    expect(s.lastVisitedAtByWorktreeId[STALE]).toBeUndefined()
  })

  it('preserves a workspace key pointing at a different live worktree', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: LIVE, repoId: 'repo1' })] },
      detectedWorktreesByRepo: { repo1: authoritative([LIVE]) },
      lastVisitedAtByWorktreeId: { [STALE]: 1 },
      // The stale worktree is the active id, but the workspace key still points at a live one.
      activeWorktreeId: STALE,
      activeWorkspaceKey: worktreeWorkspaceKey(LIVE)
    })

    store.getState().pruneLastVisitedTimestamps()

    const s = store.getState()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeWorkspaceKey).toBe(worktreeWorkspaceKey(LIVE))
  })

  it('clears a legacy unprefixed active workspace key', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: LIVE, repoId: 'repo1' })] },
      detectedWorktreesByRepo: { repo1: authoritative([LIVE]) },
      lastVisitedAtByWorktreeId: { [STALE]: 1 },
      activeWorktreeId: STALE,
      // Sessions predating the `worktree:` prefix stored the bare id as the key.
      activeWorkspaceKey: STALE as WorkspaceKey
    })

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().activeWorkspaceKey).toBeNull()
  })

  it('treats an empty worktreesByRepo list as unhydrated and defers the prune', () => {
    const store = createTestStore()
    seedStore(store, {
      // Empty list, no authoritative detected result => not yet hydrated, keep the pointer.
      worktreesByRepo: { repo1: [] },
      lastVisitedAtByWorktreeId: { [STALE]: 1 },
      activeWorktreeId: STALE,
      activeWorkspaceKey: worktreeWorkspaceKey(STALE)
    })

    store.getState().pruneLastVisitedTimestamps()

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(STALE)
    expect(s.activeWorkspaceKey).toBe(worktreeWorkspaceKey(STALE))
    expect(s.lastVisitedAtByWorktreeId[STALE]).toBe(1)
  })
})

describe('markWorktreesDeleting phase-aware promotion', () => {
  it('promotes a queued row to deleting', () => {
    const store = createTestStore()
    seedStore(store, {
      deleteStateByWorktreeId: {
        [STALE]: {
          isDeleting: true,
          phase: 'queued',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })

    store.getState().markWorktreesDeleting([STALE])

    expect(store.getState().deleteStateByWorktreeId[STALE].phase).toBe('deleting')
  })

  it('leaves an already-deleting row untouched', () => {
    const store = createTestStore()
    const before = {
      isDeleting: true,
      phase: 'deleting' as const,
      error: null,
      canForceDelete: false,
      forceDeleteReason: null
    }
    seedStore(store, { deleteStateByWorktreeId: { [STALE]: before } })

    store.getState().markWorktreesDeleting([STALE])

    expect(store.getState().deleteStateByWorktreeId[STALE]).toBe(before)
  })
})
