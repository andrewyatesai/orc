import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { buildTerminalTabColdParkCandidates } from './terminal-tab-park-candidates'
import { createTerminalTabActivationOrder } from './terminal-tab-activation-order'
import {
  TERMINAL_TAB_HOT_RETAIN_MS,
  selectColdParkedTerminalTabs
} from './terminal-hidden-view-parking'

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `wt-1@@session-${id}`,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

// Why: split groups keep two tabs visible at once, so leaving the worktree ties
// their hidden time. This drives the real activation-order → builder → policy
// path and proves the last-focused tab survives the UUID-order coin flip.
describe('buildTerminalTabColdParkCandidates activation ranking', () => {
  it('keeps the last-focused split tab warm when a view switch ties every tab', () => {
    const terminalTabs = [makeTab('tab-a'), makeTab('tab-b')]
    const assignments = new Map([
      ['tab-a', { groupId: 'group-1', isActiveInGroup: true }],
      ['tab-b', { groupId: 'group-2', isActiveInGroup: true }]
    ])
    const hiddenSinceByTabId = new Map<string, number>()
    const activationOrder = createTerminalTabActivationOrder()
    const shared = {
      terminalTabs,
      assignments,
      portalTabIds: new Set<string>(),
      shouldMeasureHiddenWorktree: false,
      hiddenSinceByTabId,
      activationOrder
    }

    // Focus group-1's tab, then group-2's tab, while both stay mounted.
    buildTerminalTabColdParkCandidates({
      ...shared,
      isWorktreeActive: true,
      activeTerminalTabId: 'tab-a',
      nowMs: 1_000
    })
    buildTerminalTabColdParkCandidates({
      ...shared,
      isWorktreeActive: true,
      activeTerminalTabId: 'tab-b',
      nowMs: 2_000
    })
    // Leave the worktree: both tabs hide in one pass with the same hidden time.
    const hiddenPassMs = 3_000
    const candidates = buildTerminalTabColdParkCandidates({
      ...shared,
      isWorktreeActive: false,
      activeTerminalTabId: 'tab-b',
      nowMs: hiddenPassMs
    })

    expect(candidates.map((candidate) => candidate.hiddenSinceMs)).toEqual([
      hiddenPassMs,
      hiddenPassMs
    ])
    expect(candidates.find((candidate) => candidate.id === 'tab-a')?.lastActivatedSeq).toBe(0)
    expect(candidates.find((candidate) => candidate.id === 'tab-b')?.lastActivatedSeq).toBe(1)

    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: candidates,
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs: hiddenPassMs + TERMINAL_TAB_HOT_RETAIN_MS + 1,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set(['tab-a']))
  })
})
