/**
 * STA-4343 fail-closed guard: workspace cleanup must never issue a destructive
 * removeWorktree against a host other than the one whose row was confirmed.
 *
 * Two hosts can expose cleanup candidates with the SAME `repoId::path` identity
 * (the scan composes `worktreeId` from `repo.id` + `::` + the workspace path with
 * no host component), while selection, confirmation and preflight all key on
 * `worktreeId` alone and removal routing prefers the active workspace's host.
 *
 * Rig: the real `removeWorkspaceCleanupCandidates` store action + the real
 * preflight + the real guard modules run; the only double is `removeWorktree`
 * (the destructive boundary), so a refusal is proven by `removeWorktree` never
 * firing, and the single-host control proves the same rig still deletes. The
 * git-wasm classifier is initialized so candidates reach the guard as queueable.
 */
import '@/lib/git-wasm/init-git-wasm-for-test'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  createCleanupTestStore,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'
import { makeWorktree } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/shared/workspace/path'
const WORKTREE_PATH = '/shared/workspace/path'
const FIRST_WORKTREE_ID = 'repo1::/first/very-long-workspace/path'
const FIRST_WORKTREE_PATH = '/first/very-long-workspace/path'
const HOST_A: ExecutionHostId = 'local'
const HOST_B: ExecutionHostId = 'ssh:ssh-1'
const HOST_COLLISION_MESSAGE = 'Error: this workspace exists on multiple hosts at the same path'
const HOST_UNRESOLVED_MESSAGE =
  'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'

function hostCandidate(
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return makeCandidate({
    worktreeId: WORKTREE_ID,
    path: WORKTREE_PATH,
    displayName: 'shared-workspace',
    ...overrides
  })
}

/** Scan mock scoped to a worktreeId, mirroring the real per-row cleanup scan. */
function scanReturning(candidates: readonly WorkspaceCleanupCandidate[]): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (args?: { worktreeId?: string }) =>
      ({
        scannedAt: NOW,
        candidates: args?.worktreeId
          ? candidates.filter((candidate) => candidate.worktreeId === args.worktreeId)
          : [...candidates],
        errors: []
      }) satisfies WorkspaceCleanupScanResult
  )
}

describe('STA-4343 guard: cleanup refuses a removal it cannot attribute to one host', () => {
  it('refuses a colliding id owned by two hosts and issues no removeWorktree', async () => {
    const hostA = hostCandidate({ executionHostId: HOST_A, fingerprint: 'fp-a' })
    const hostB = hostCandidate({
      executionHostId: HOST_B,
      connectionId: 'ssh-1',
      fingerprint: 'fp-b'
    })
    installWorkspaceCleanupApi(scanReturning([hostA, hostB]))
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    const result = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [hostB] })

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.removedIds).toEqual([])
    expect(result.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_COLLISION_MESSAGE }
    ])
  })

  it('refuses a row whose confirmed host is absent from the refreshed scan', async () => {
    const hostA = hostCandidate({ executionHostId: HOST_A })
    const confirmedHostB = hostCandidate({ executionHostId: HOST_B, connectionId: 'ssh-1' })
    installWorkspaceCleanupApi(scanReturning([hostA]))
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    const result = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [confirmedHostB] })

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_UNRESOLVED_MESSAGE }
    ])
  })

  it('refuses a row that carries no host evidence at all', async () => {
    const unqualified = hostCandidate({ executionHostId: undefined, connectionId: null })
    installWorkspaceCleanupApi(scanReturning([unqualified]))
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    const result = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [unqualified] })

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_UNRESOLVED_MESSAGE }
    ])
  })

  it('rechecks the route at the removal boundary after an earlier removal changes ownership', async () => {
    const firstCandidate = makeCandidate({
      worktreeId: FIRST_WORKTREE_ID,
      path: FIRST_WORKTREE_PATH,
      displayName: 'first-workspace',
      executionHostId: HOST_A,
      fingerprint: 'fp-first'
    })
    const secondCandidate = hostCandidate({ executionHostId: HOST_A, fingerprint: 'fp-second' })
    installWorkspaceCleanupApi(scanReturning([firstCandidate, secondCandidate]))

    const store = createCleanupTestStore()
    // Both rows preflight against host A, so both pass the batched host check.
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: FIRST_WORKTREE_ID,
            repoId: 'repo1',
            path: FIRST_WORKTREE_PATH,
            hostId: HOST_A
          }),
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: WORKTREE_PATH, hostId: HOST_A })
        ]
      }
    } as Partial<AppState>)
    const removeWorktree = vi.fn(async (worktreeId: string) => {
      // Removing the first row re-homes the second id onto host B before its turn.
      if (worktreeId === FIRST_WORKTREE_ID) {
        store.setState({
          worktreesByRepo: {
            repo1: [
              makeWorktree({
                id: WORKTREE_ID,
                repoId: 'repo1',
                path: WORKTREE_PATH,
                hostId: HOST_B
              })
            ]
          }
        } as Partial<AppState>)
      }
      return { ok: true as const }
    })
    store.setState({ removeWorktree } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorkspaceCleanupCandidates([FIRST_WORKTREE_ID, WORKTREE_ID], {
        approvedCandidates: [firstCandidate, secondCandidate]
      })

    expect(removeWorktree).toHaveBeenCalledTimes(1)
    expect(removeWorktree).toHaveBeenCalledWith(FIRST_WORKTREE_ID, false, {
      suppressPreservedBranchToast: true
    })
    expect(result.removedIds).toEqual([FIRST_WORKTREE_ID])
    expect(result.failures).toEqual([
      { worktreeId: WORKTREE_ID, displayName: 'shared-workspace', message: HOST_UNRESOLVED_MESSAGE }
    ])
  })
})

describe('STA-4343 guard: ordinary single-host cleanup still deletes', () => {
  it('deletes a confirmed local workspace whose route matches the confirmed host', async () => {
    const hostA = hostCandidate({ executionHostId: HOST_A })
    installWorkspaceCleanupApi(scanReturning([hostA]))
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    // Route resolves to host A, exercising the routeHostId === confirmedHostId branch.
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: WORKTREE_PATH, hostId: HOST_A })
        ]
      }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [hostA] })

    expect(result.failures).toEqual([])
    expect(result.removedIds).toEqual([WORKTREE_ID])
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE_ID, false, {
      suppressPreservedBranchToast: true
    })
  })

  it('deletes a confirmed SSH workspace', async () => {
    const hostB = hostCandidate({ executionHostId: HOST_B, connectionId: 'ssh-1' })
    installWorkspaceCleanupApi(scanReturning([hostB]))
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    const result = await store
      .getState()
      .removeWorkspaceCleanupCandidates([WORKTREE_ID], { approvedCandidates: [hostB] })

    expect(result.failures).toEqual([])
    expect(result.removedIds).toEqual([WORKTREE_ID])
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE_ID, false, {
      suppressPreservedBranchToast: true
    })
  })
})
