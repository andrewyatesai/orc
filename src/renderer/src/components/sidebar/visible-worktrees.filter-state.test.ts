import { describe, expect, it } from 'vitest'
import { computeClearFilterActions, sidebarHasActiveFilters } from './sidebar-filter-state'

type FilterState = Parameters<typeof sidebarHasActiveFilters>[0]

function filterState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    workspaceHostScope: 'all',
    ...overrides
  }
}

describe('sidebarHasActiveFilters', () => {
  it('returns false when no filters are active', () => {
    expect(sidebarHasActiveFilters(filterState())).toBe(false)
  })

  it('returns true when only hideDefaultBranchWorkspace is active', () => {
    // Why: regression guard for the empty-sidebar escape hatch. If hide is
    // omitted from the filter union, a user whose only worktree is the
    // default-branch row sees "No workspaces found" with no way back.
    expect(sidebarHasActiveFilters(filterState({ hideDefaultBranchWorkspace: true }))).toBe(true)
  })

  it('returns true when only automation-created workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideAutomationGeneratedWorkspaces: true }))).toBe(
      true
    )
  })

  it('returns true when only CLI-created workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideCliCreatedWorkspaces: true }))).toBe(true)
  })

  it('returns true when only detached-HEAD workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideDetachedHeadWorkspaces: true }))).toBe(true)
  })

  it('returns true when sleeping workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ showSleepingWorkspaces: false }))).toBe(true)
  })

  it('returns true when only filterRepoIds is non-empty', () => {
    expect(sidebarHasActiveFilters(filterState({ filterRepoIds: ['repo1'] }))).toBe(true)
  })

  it('returns true when only host visibility is narrowed', () => {
    expect(sidebarHasActiveFilters(filterState({ visibleWorkspaceHostIds: ['local'] }))).toBe(true)
  })
})

describe('computeClearFilterActions', () => {
  it('returns no-op actions when nothing is set', () => {
    expect(computeClearFilterActions(filterState())).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideDefaultBranchWorkspace for reset when it is the sole filter', () => {
    // Why: verifies the empty-sidebar escape hatch actually clears the hide
    // flag. A regression here would leave users stuck on "No workspaces found"
    // because the only active filter would never clear.
    expect(computeClearFilterActions(filterState({ hideDefaultBranchWorkspace: true }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: true,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideAutomationGeneratedWorkspaces for reset when it is the sole filter', () => {
    expect(
      computeClearFilterActions(filterState({ hideAutomationGeneratedWorkspaces: true }))
    ).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: true,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideCliCreatedWorkspaces for reset when it is the sole filter', () => {
    expect(computeClearFilterActions(filterState({ hideCliCreatedWorkspaces: true }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: true,
      resetHideDetachedHeadWorkspaces: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideDetachedHeadWorkspaces for reset when it is the sole filter', () => {
    expect(computeClearFilterActions(filterState({ hideDetachedHeadWorkspaces: true }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: true,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('does not flag hideDefaultBranchWorkspace when it is already off', () => {
    // Why: avoids issuing a pointless IPC write on every Clear Filters click
    // in the common case where hide was never on.
    const actions = computeClearFilterActions(
      filterState({
        filterRepoIds: ['repo1']
      })
    )
    expect(actions.resetHideDefaultBranchWorkspace).toBe(false)
    expect(actions.resetShowSleepingWorkspaces).toBe(false)
    expect(actions.resetFilterRepoIds).toBe(true)
  })

  it('flags legacy single-host scope for reset even without visible host ids', () => {
    expect(computeClearFilterActions(filterState({ workspaceHostScope: 'ssh:host-1' }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetVisibleWorkspaceHostIds: true
    })
  })

  it('flags every active filter simultaneously', () => {
    expect(
      computeClearFilterActions(
        filterState({
          showSleepingWorkspaces: false,
          filterRepoIds: ['repo1', 'repo2'],
          hideDefaultBranchWorkspace: true,
          hideAutomationGeneratedWorkspaces: true,
          visibleWorkspaceHostIds: ['local']
        })
      )
    ).toEqual({
      resetShowSleepingWorkspaces: true,
      resetFilterRepoIds: true,
      resetHideDefaultBranchWorkspace: true,
      resetHideAutomationGeneratedWorkspaces: true,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetVisibleWorkspaceHostIds: true
    })
  })
})
