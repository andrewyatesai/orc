import type { Worktree } from '../../../../shared/types'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

/**
 * Whether a worktree represents the repo's default-branch row that the
 * "Hide Default Branch Workspace" setting targets. Folder-mode projects are
 * main worktrees with branch === '' and are intentionally preserved.
 *
 * Why a shared helper: this predicate gates visibility in both the sidebar
 * pipeline (computeVisibleWorktreeIds) and the Cmd+J jump palette. Keeping
 * the definition in one place prevents the two surfaces from drifting.
 */
export function isDefaultBranchWorkspace(worktree: Worktree): boolean {
  return worktree.isMainWorktree && worktree.branch.trim() !== ''
}

export function isAutomationGeneratedWorkspace(worktree: Worktree): boolean {
  return worktree.automationProvenance?.kind === 'created-by-automation'
}

export function isCliCreatedWorkspace(worktree: Worktree): boolean {
  return worktree.cliProvenance?.kind === 'created-by-cli'
}

/**
 * Whether a worktree sits on a detached HEAD (a commit, not a branch).
 *
 * Why the head check: folder workspaces and SSH-synthesized rows carry both an
 * empty branch and an empty head, so branch-emptiness alone would sweep them
 * into this filter. Requiring a real head keeps the predicate to genuine
 * detached-HEAD checkouts, matching what DetachedHeadBadge renders on the card.
 */
export function isDetachedHeadWorkspace(worktree: Worktree): boolean {
  return getWorktreeGitIdentityDisplay(worktree)?.kind === 'detached'
}

/** Inputs describing sidebar filter settings that the Clear Filters path owns. */
export type SidebarFilterState = {
  showSleepingWorkspaces: boolean
  filterRepoIds: readonly string[]
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  workspaceHostScope?: ExecutionHostScope
}

/**
 * Whether at least one sidebar filter is active — drives the "Clear Filters"
 * escape hatch in the empty-state message. Kept pure so it can be unit-tested
 * alongside the sorting pipeline.
 *
 * Why include hideDefaultBranchWorkspace here: without it, a user whose only
 * worktree is the default-branch row and who toggles hide-on would see the
 * "No workspaces found" message with no in-sidebar recovery path.
 */
export function sidebarHasActiveFilters(state: SidebarFilterState): boolean {
  return (
    state.showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES ||
    state.filterRepoIds.length > 0 ||
    state.hideDefaultBranchWorkspace ||
    state.hideAutomationGeneratedWorkspaces ||
    state.hideCliCreatedWorkspaces ||
    state.hideDetachedHeadWorkspaces ||
    state.visibleWorkspaceHostIds != null ||
    (state.workspaceHostScope != null && state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE)
  )
}

/** Describes which mutators the Clear Filters button must invoke, separated
 *  from the mutators themselves so the decision logic is testable. */
export type ClearFilterActions = {
  resetShowSleepingWorkspaces: boolean
  resetFilterRepoIds: boolean
  resetHideDefaultBranchWorkspace: boolean
  resetHideAutomationGeneratedWorkspaces: boolean
  resetHideCliCreatedWorkspaces: boolean
  resetHideDetachedHeadWorkspaces: boolean
  resetVisibleWorkspaceHostIds: boolean
}

/**
 * Determines which sidebar filters the Clear Filters button needs to reset.
 * Returning an explicit action plan (rather than just calling the setters)
 * keeps the pure decision separate from the impure mutations, so tests can
 * verify the logic without mounting the component.
 *
 * Why reset only the ones that are set: keeps Clear Filters from churning
 * UI state (and the debounced ui.set write-back) on every click when the
 * flag was already off.
 */
export function computeClearFilterActions(state: SidebarFilterState): ClearFilterActions {
  return {
    resetShowSleepingWorkspaces: state.showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES,
    resetFilterRepoIds: state.filterRepoIds.length > 0,
    resetHideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    resetHideAutomationGeneratedWorkspaces: state.hideAutomationGeneratedWorkspaces,
    resetHideCliCreatedWorkspaces: state.hideCliCreatedWorkspaces,
    resetHideDetachedHeadWorkspaces: state.hideDetachedHeadWorkspaces,
    resetVisibleWorkspaceHostIds:
      state.visibleWorkspaceHostIds != null ||
      (state.workspaceHostScope != null && state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE)
  }
}
