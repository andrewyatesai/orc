import type { Tab, TabGroup } from '../../../../shared/types'

export type TerminalOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

export function buildTerminalOverlayAssignments(
  groups: readonly TabGroup[],
  unifiedTabs: readonly Tab[]
): Map<string, TerminalOverlayAssignment> {
  const activeTabByGroupId = new Map(groups.map((group) => [group.id, group.activeTabId]))
  const assignments = new Map<string, TerminalOverlayAssignment>()
  for (const tab of unifiedTabs) {
    if (tab.contentType === 'terminal') {
      assignments.set(tab.entityId, {
        groupId: tab.groupId,
        isActiveInGroup: activeTabByGroupId.get(tab.groupId) === tab.id
      })
    }
  }
  return assignments
}

// Why: the tab active in the active group is the hidden->visible edge the
// cold-park policy ranks by, so same-pass hidden ties break on activation
// order instead of random UUID.
export function selectActiveTerminalTabInGroup(
  activeGroupId: string | undefined,
  assignments: ReadonlyMap<string, TerminalOverlayAssignment>
): string | null {
  if (!activeGroupId) {
    return null
  }
  for (const [terminalTabId, assignment] of assignments) {
    if (assignment.groupId === activeGroupId && assignment.isActiveInGroup) {
      return terminalTabId
    }
  }
  return null
}
