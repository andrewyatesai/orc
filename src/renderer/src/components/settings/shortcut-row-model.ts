import { useMemo } from 'react'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getEffectiveKeybindingsForDefinition,
  type KeybindingActionId,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import {
  resolveKeybindingTitle,
  type ResolvedCustomKeybinding
} from '../../../../shared/custom-keybindings'
import type { TuiAgent } from '../../../../shared/types'
import { disabledAgentTabActionIds, groupDefinitions } from './shortcut-groups'
import { hasOwnBindingOverride } from './keybinding-override-edits'
import { getShortcutTerminalStatus } from './shortcut-terminal-status'
import {
  buildShortcutGlobalSearchMatcher,
  matchesShortcutFilter,
  matchesShortcutLocalSearch,
  normalizeShortcutLocalSearchQuery,
  type ShortcutFilter,
  type ShortcutRowsByGroup
} from './ShortcutFilterRail'

export type ShortcutRowModelInputs = {
  platform: NodeJS.Platform
  keybindings: KeybindingOverrides
  customKeybindings: ResolvedCustomKeybinding[]
  disabledTuiAgents: readonly TuiAgent[]
  terminalShortcutPolicy: TerminalShortcutPolicy
  settingsSearchQuery: string
  shortcutQuery: string
  shortcutFilter: ShortcutFilter
}

export type ShortcutRowModelResult = {
  ignoredConflictActionIds: KeybindingActionId[]
  conflictByAction: Map<string, string[]>
  totalShortcutCount: number
  filterCounts: Record<ShortcutFilter, number>
  visibleShortcutGroups: ShortcutRowsByGroup[]
  visibleShortcutCount: number
}

// Derives what the pane renders from store state: grouped rows with conflict
// warnings and terminal badges, plus search/filter visibility and counts.
export function useShortcutRowModel({
  platform,
  keybindings,
  customKeybindings,
  disabledTuiAgents,
  terminalShortcutPolicy,
  settingsSearchQuery,
  shortcutQuery,
  shortcutFilter
}: ShortcutRowModelInputs): ShortcutRowModelResult {
  const groups = useMemo(() => groupDefinitions(disabledTuiAgents), [disabledTuiAgents])
  const ignoredConflictActionIds = useMemo(
    () => disabledAgentTabActionIds(disabledTuiAgents),
    [disabledTuiAgents]
  )
  const conflictByAction = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const conflict of findKeybindingConflicts(
      platform,
      keybindings,
      { ignoredActionIds: ignoredConflictActionIds },
      customKeybindings
    )) {
      const labels = conflict.actionIds
        .map((id) => resolveKeybindingTitle(id, customKeybindings))
        .join(', ')
      for (const actionId of conflict.actionIds) {
        result.set(actionId, [
          ...(result.get(actionId) ?? []),
          `${formatKeybindingList([conflict.binding], platform)} conflicts with ${labels}.`
        ])
      }
    }
    return result
  }, [customKeybindings, ignoredConflictActionIds, keybindings, platform])
  const shortcutGroups = useMemo<ShortcutRowsByGroup[]>(
    () =>
      groups.map((group) => ({
        title: group.title,
        rows: group.items.map((item) => {
          const effective = getEffectiveKeybindingsForDefinition(item, platform, keybindings)
          const modified = hasOwnBindingOverride(keybindings, item.id)
          const warnings = conflictByAction.get(item.id) ?? []
          return {
            item,
            groupTitle: group.title,
            effective,
            modified,
            warnings,
            terminalStatus: getShortcutTerminalStatus(
              item,
              terminalShortcutPolicy,
              effective.length > 0
            )
          }
        })
      })),
    [conflictByAction, groups, keybindings, platform, terminalShortcutPolicy]
  )
  const shortcutSearchQuery = normalizeShortcutLocalSearchQuery(shortcutQuery)
  const shortcutRows = shortcutGroups.flatMap((group) => group.rows)
  const matchesShortcutGlobalSearch = buildShortcutGlobalSearchMatcher(
    shortcutRows,
    settingsSearchQuery
  )
  const matchesShortcutSearch = (row: ShortcutRowsByGroup['rows'][number]): boolean =>
    shortcutSearchQuery !== null &&
    matchesShortcutGlobalSearch(row) &&
    matchesShortcutLocalSearch(row, shortcutSearchQuery, platform)
  const baseVisibleRows = shortcutRows.filter((row) => matchesShortcutSearch(row))
  const filterCounts: Record<ShortcutFilter, number> = {
    all: baseVisibleRows.length,
    modified: baseVisibleRows.filter((row) => row.modified).length,
    unassigned: baseVisibleRows.filter((row) => row.effective.length === 0).length,
    conflicts: baseVisibleRows.filter((row) => row.warnings.length > 0).length
  }
  const visibleShortcutGroups = shortcutGroups
    .map((group) => ({
      title: group.title,
      rows: group.rows.filter(
        (row) => matchesShortcutSearch(row) && matchesShortcutFilter(row, shortcutFilter)
      )
    }))
    .filter((group) => group.rows.length > 0)
  const visibleShortcutCount = visibleShortcutGroups.reduce(
    (sum, group) => sum + group.rows.length,
    0
  )
  return {
    ignoredConflictActionIds,
    conflictByAction,
    totalShortcutCount: shortcutRows.length,
    filterCounts,
    visibleShortcutGroups,
    visibleShortcutCount
  }
}
