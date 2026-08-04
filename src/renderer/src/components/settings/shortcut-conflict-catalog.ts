import { useCallback, useMemo } from 'react'
import {
  findKeybindingConflictsForDefinitions,
  formatKeybindingList,
  isKeybindingActionId,
  isPluginKeybindingActionId,
  type CustomKeybindingActionId,
  type KeybindingActionId,
  type KeybindingConflict,
  type KeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import {
  resolveKeybindingTitle,
  type CustomKeybinding
} from '../../../../shared/custom-keybindings'
import type { TuiAgent } from '../../../../shared/types'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { buildShortcutDefinitionCatalog } from './shortcut-definition-catalog'
import type { ShortcutGroup } from './shortcut-groups'

// Why: a plugin-command title lives only in the catalog and a custom-shortcut title only in the
// user's entries, so neither the static registry nor the catalog alone can name every collider.
function conflictActionTitle(
  id: KeybindingActionId | CustomKeybindingActionId,
  definitionsByAction: ReadonlyMap<KeybindingActionId, KeybindingDefinition>,
  customKeybindings: readonly CustomKeybinding[]
): string {
  return (
    (isKeybindingActionId(id) ? definitionsByAction.get(id)?.title : undefined) ??
    resolveKeybindingTitle(id, customKeybindings)
  )
}

export type ShortcutConflictCatalog = {
  groups: ShortcutGroup[]
  definitions: KeybindingDefinition[]
  definitionsByAction: Map<KeybindingActionId, KeybindingDefinition>
  /** Conflict messages keyed by built-in, plugin, or custom action id. */
  conflictByAction: Map<string, string[]>
  /** Message for the collision `overrides` would create for `actionId`, or null when it is clear. */
  describeBlockingConflict: (
    actionId: KeybindingActionId,
    overrides: KeybindingOverrides
  ) => string | null
}

/**
 * The Settings shortcut grid's definition + conflict view. Built-in definitions, plugin commands,
 * and user custom shortcuts all compete for the same chords, so they must be detected in one pass —
 * `buildShortcutDefinitionCatalog` alone cannot see the custom entries.
 */
export function useShortcutConflictCatalog(options: {
  disabledTuiAgents: readonly TuiAgent[]
  pluginCommands: readonly ActivePluginCommand[]
  keybindings: KeybindingOverrides
  customKeybindings: readonly CustomKeybinding[]
  platform: NodeJS.Platform
}): ShortcutConflictCatalog {
  const { disabledTuiAgents, pluginCommands, keybindings, customKeybindings, platform } = options
  const { groups, definitions, definitionsByAction, ignoredConflictActionIds } = useMemo(
    () =>
      buildShortcutDefinitionCatalog({
        disabledTuiAgents,
        pluginCommands,
        keybindings,
        platform
      }),
    [disabledTuiAgents, keybindings, pluginCommands, platform]
  )
  // Why: plugin defaults are external additions to Orca's conflict-free registry, so their
  // collisions surface before the user customizes anything.
  const relevantActionIds = useMemo(
    () => definitions.map((definition) => definition.id).filter(isPluginKeybindingActionId),
    [definitions]
  )

  const findConflicts = useCallback(
    (overrides: KeybindingOverrides): KeybindingConflict[] =>
      findKeybindingConflictsForDefinitions(
        definitions,
        platform,
        overrides,
        { ignoredActionIds: ignoredConflictActionIds, relevantActionIds },
        customKeybindings
      ),
    [customKeybindings, definitions, ignoredConflictActionIds, platform, relevantActionIds]
  )

  const conflictByAction = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const conflict of findConflicts(keybindings)) {
      const labels = conflict.actionIds
        .map((id) => conflictActionTitle(id, definitionsByAction, customKeybindings))
        .join(', ')
      for (const actionId of conflict.actionIds) {
        result.set(actionId, [
          ...(result.get(actionId) ?? []),
          `${formatKeybindingList([conflict.binding], platform)} conflicts with ${labels}.`
        ])
      }
    }
    return result
  }, [customKeybindings, definitionsByAction, findConflicts, keybindings, platform])

  const describeBlockingConflict = (
    actionId: KeybindingActionId,
    overrides: KeybindingOverrides
  ): string | null => {
    const blocking = findConflicts(overrides).find((conflict) =>
      conflict.actionIds.includes(actionId)
    )
    if (!blocking) {
      return null
    }
    const labels = blocking.actionIds
      .filter((id) => id !== actionId)
      .map((id) => conflictActionTitle(id, definitionsByAction, customKeybindings))
      .join(', ')
    return `${formatKeybindingList([blocking.binding], platform)} conflicts with ${labels}.`
  }

  return { groups, definitions, definitionsByAction, conflictByAction, describeBlockingConflict }
}
