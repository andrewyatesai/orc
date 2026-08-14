import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/types'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import { showPreservedBranchBatchToast } from './preserved-branch-batch-toast'

type WorktreeDeleteWithToastOptions = {
  force?: boolean
  onForceDeleted?: (worktreeId: string) => void
  onPreservedBranch?: (branch: PreservedBranchCleanup) => void
  suppressPreservedBranchToast?: boolean
  // Why: batch deletes suppress the per-delete focus handoff to focus one survivor after the batch (see runWorktreeDeletesInParallel).
  focusSuccessorOnDelete?: boolean
}

// Why: a failed delete usually means unresolved changes, so land on the diff panel, not just focus the worktree.
function viewWorktreeDiff(worktreeId: string): void {
  activateAndRevealWorktree(worktreeId)
  const state = useAppStore.getState()
  state.setRightSidebarTab('source-control')
  state.setRightSidebarOpen(true)
}

function isStrictDescendantPath(parentPath: string, childPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(parentPath) !==
      normalizeRuntimePathForComparison(childPath) && isPathInsideOrEqual(parentPath, childPath)
  )
}

export async function runWorktreeDeletesInParallel(
  targets: readonly Pick<Worktree, 'id' | 'displayName' | 'repoId' | 'path'>[],
  options: WorktreeDeleteWithToastOptions = {}
): Promise<string[]> {
  // Why: refresh races can leave duplicate rows, but a destructive command must run once per identity.
  const uniqueTargets = Array.from(new Map(targets.map((target) => [target.id, target])).values())
  // Why: capture the viewed workspace before any delete so we can focus one survivor after the batch settles, not per delete.
  const activeWorktreeIdBefore = useAppStore.getState().activeWorktreeId
  const commitBatchFocus = activeWorktreeIdBefore
    ? prepareActiveWorktreeFocusAfterDelete(activeWorktreeIdBefore)
    : null
  // Why: mark every target deleting up front for immediate in-flight feedback, even though deletes serialize per repo.
  useAppStore.getState().markWorktreesDeleting(uniqueTargets.map((target) => target.id))
  // Why: worktree remove/prune/branch -D race on shared ref locks; group by repoId to serialize per repo (cross-repo stays parallel).
  const groups = new Map<string, (typeof uniqueTargets)[number][]>()
  for (const target of uniqueTargets) {
    const group = groups.get(target.repoId)
    if (group) {
      group.push(target)
    } else {
      groups.set(target.repoId, [target])
    }
  }
  for (const group of groups.values()) {
    // Why: delete nested children first — else the parent delete is rejected while it still contains a registered worktree.
    group.sort((a, b) => b.path.length - a.path.length)
  }
  // Why: a multi-target batch replaces N per-workspace warnings with one review.
  const preservedBranches: PreservedBranchCleanup[] = []
  const aggregatePreservedBranches = uniqueTargets.length > 1
  const groupResults = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const deletedInGroup: string[] = []
      const failedInGroup: (typeof group)[number][] = []
      for (const target of group) {
        if (failedInGroup.some((failed) => isStrictDescendantPath(target.path, failed.path))) {
          useAppStore.getState().clearWorktreeDeleteState(target.id)
          continue
        }
        const deleted = await runWorktreeDeleteWithToast(target.id, target.displayName, {
          ...options,
          focusSuccessorOnDelete: false,
          suppressPreservedBranchToast: aggregatePreservedBranches,
          onPreservedBranch: (branch) => {
            preservedBranches.push(branch)
            options.onPreservedBranch?.(branch)
          }
        })
        if (deleted) {
          deletedInGroup.push(target.id)
        } else {
          // Why: after a descendant delete fails, deleting an ancestor can still remove that child from disk (it lives under the parent).
          failedInGroup.push(target)
        }
      }
      return deletedInGroup
    })
  )
  const deletedSet = new Set(groupResults.flat())
  // Why: focus a survivor once after the batch settles — an intermediate focus could spawn a terminal in a to-be-deleted workspace.
  if (activeWorktreeIdBefore && deletedSet.has(activeWorktreeIdBefore)) {
    commitBatchFocus?.()
  }
  if (aggregatePreservedBranches && preservedBranches.length > 0) {
    const targetOrder = new Map(uniqueTargets.map((target, index) => [target.id, index]))
    preservedBranches.sort(
      (left, right) =>
        (targetOrder.get(left.worktreeId) ?? Number.MAX_SAFE_INTEGER) -
        (targetOrder.get(right.worktreeId) ?? Number.MAX_SAFE_INTEGER)
    )
    showPreservedBranchBatchToast(deletedSet.size, preservedBranches)
  }
  return uniqueTargets.filter((target) => deletedSet.has(target.id)).map((target) => target.id)
}

/**
 * Shared delete-with-toast flow for both DeleteWorktreeDialog (confirm) and
 * WorktreeContextMenu (skip-confirm), so both entry points behave identically.
 *
 * A renderer-layer helper (not a store action) to keep UI concerns out of the store slice.
 */
export function runWorktreeDeleteWithToast(
  worktreeId: string,
  worktreeName: string,
  options: WorktreeDeleteWithToastOptions = {}
): Promise<boolean> {
  const removeWorktree = useAppStore.getState().removeWorktree
  const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
  const focusSuccessor = options.focusSuccessorOnDelete !== false

  const removal = options.suppressPreservedBranchToast
    ? removeWorktree(worktreeId, options.force === true, { suppressPreservedBranchToast: true })
    : removeWorktree(worktreeId, options.force === true)
  return removal
    .then((result) => {
      if (result.ok) {
        if (result.preservedBranch) {
          options.onPreservedBranch?.({
            worktreeId,
            branchName: result.preservedBranch.branchName,
            expectedHead: result.preservedBranch.head,
            ...(result.preservedBranch.hostId ? { hostId: result.preservedBranch.hostId } : {}),
            ...(result.preservedBranch.runtimeEnvironmentId
              ? { runtimeEnvironmentId: result.preservedBranch.runtimeEnvironmentId }
              : {})
          })
        }
        // Why: keep the user on a live workspace instead of the Landing screen when they delete the one they were viewing.
        if (focusSuccessor) {
          commitFocus()
        }
        return true
      }
      const state = useAppStore.getState().deleteStateByWorktreeId[worktreeId]
      const canForceDelete = state?.canForceDelete ?? false
      const hasKnownChanges =
        (useAppStore.getState().gitStatusByWorktree[worktreeId]?.length ?? 0) > 0
      showDeleteWorktreeFailureToast({
        error: result.error,
        canForceDelete,
        forceDeleteReason: state?.forceDeleteReason ?? null,
        lockReason: state?.lockReason ?? null,
        hasKnownChanges,
        onViewChanges: () => viewWorktreeDiff(worktreeId),
        onForceDelete: () => {
          // Why: recapture at click time — the user may have navigated away while the toast was open, so focus only hands off if still viewed.
          const commitForceFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
          // Why (#11960): the user clicked Force Delete on a failure toast, so this
          // retry may waive the PTY-stop proof the first attempt could not satisfy.
          const forceRemoval = useAppStore
            .getState()
            .removeWorktree(worktreeId, true, { allowUnverifiedPtyStop: true })
          forceRemoval
            .then((forceResult) => {
              if (!forceResult.ok) {
                toast.error(
                  translate(
                    'auto.components.sidebar.delete.worktree.flow.4f3876c0f5',
                    'Force delete failed'
                  ),
                  {
                    description: forceResult.error,
                    action: {
                      label: translate(
                        'auto.components.sidebar.delete.worktree.flow.7488ed8711',
                        'View'
                      ),
                      onClick: () => viewWorktreeDiff(worktreeId)
                    }
                  }
                )
                return
              }
              commitForceFocus()
              options.onForceDeleted?.(worktreeId)
            })
            .catch((err: unknown) => {
              toast.error(
                translate(
                  'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
                  'Failed to delete workspace'
                ),
                {
                  description: err instanceof Error ? err.message : String(err),
                  action: {
                    label: translate(
                      'auto.components.sidebar.delete.worktree.flow.7488ed8711',
                      'View'
                    ),
                    onClick: () => viewWorktreeDiff(worktreeId)
                  }
                }
              )
            })
        },
        worktreeId,
        worktreeName
      })
      return false
    })
    .catch((err: unknown) => {
      toast.error(
        translate(
          'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
          'Failed to delete workspace'
        ),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return false
    })
}
