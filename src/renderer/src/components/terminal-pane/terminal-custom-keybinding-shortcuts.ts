/**
 * Custom (user-configured) terminal keybinding resolution.
 *
 * Split from terminal-shortcut-policy.ts so the platform byte-rewrite ladder
 * stays inside the module line budget; precedence is unchanged — customs sit
 * between the configurable built-in ladder and the hardcoded byte rewrites.
 */
import {
  matchCustomKeybinding,
  type ResolvedCustomKeybinding
} from '../../../../shared/custom-keybindings'
import {
  keybindingChordHasNoNonShiftModifiers,
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import { isTerminalPaneCloseChord } from './terminal-shortcut-policy'
import type { TerminalShortcutAction, TerminalShortcutEvent } from './terminal-shortcut-policy'

// Why: the repeat-precedence guard for custom entries must mirror the !repeat ladder in
// resolveTerminalShortcutAction — keep this list in sync with the keybindingMatchesAction calls
// there. The pane-close row is not here: it is an OR over terminal.closePane and a terminal-scoped
// tab.close, so it goes through the shared isTerminalPaneCloseChord predicate below.
const REPEAT_GATED_TERMINAL_ACTION_IDS: readonly KeybindingActionId[] = [
  'terminal.copySelection',
  'terminal.search',
  'terminal.clear',
  'terminal.focusPreviousPane',
  'terminal.focusNextPane',
  'terminal.equalizePaneSizes',
  'terminal.expandPane',
  'terminal.setTitle',
  'terminal.clearPaneTitle',
  'terminal.splitRight',
  'terminal.splitDown',
  'terminal.composeBox'
]

/**
 * Resolves a user-configured terminal keybinding, or null when none applies.
 *
 * Hard IME gate: never match mid-composition — candidate-window keystrokes stay untouched.
 */
export function resolveCustomTerminalKeybindingAction(
  event: TerminalShortcutEvent,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined,
  customKeybindings: readonly ResolvedCustomKeybinding[] | undefined,
  // Why: gates the tab.close pane-close alias exactly as the ladder does; the default mirrors
  // resolveTerminalShortcutAction's own policy default so an unthreaded caller stays consistent.
  terminalShortcutPolicy: TerminalShortcutPolicy = 'orca-first'
): TerminalShortcutAction | null {
  if (event.isComposing === true || event.key === 'Process' || !customKeybindings?.length) {
    return null
  }
  const custom = matchCustomKeybinding(customKeybindings, event, platform)
  if (custom === null) {
    return null
  }
  // Why: repeats skip the !repeat ladder in the policy, so a held built-in chord would otherwise
  // fall through to a same-chord custom entry; write-time conflict blocking is only defense #1.
  const shadowedByBuiltIn =
    REPEAT_GATED_TERMINAL_ACTION_IDS.some((actionId) =>
      keybindingMatchesAction(actionId, event, platform, keybindings)
    ) ||
    // Why: only repeats need the ladder's pane-close alias replayed — on a first press the ladder
    // already decided, so re-deciding here could shadow a custom the ladder deliberately let through.
    (event.repeat === true &&
      isTerminalPaneCloseChord(event, platform, keybindings, undefined, {
        context: 'terminal',
        terminalShortcutPolicy
      }))
  if (shadowedByBuiltIn) {
    return null
  }
  if (custom.entry.action.type === 'runQuickCommand') {
    // Why: command-like customs are once-per-press; swallowing repeats keeps a held chord
    // from falling through to the byte rewrites or reaching the engine encoder.
    return event.repeat
      ? { type: 'consumeKey' }
      : { type: 'runQuickCommand', quickCommandId: custom.entry.action.quickCommandId }
  }
  if (custom.entry.decodedText !== undefined) {
    // sendText fires on key repeat — it substitutes for typing, so a held remapped key auto-repeats.
    return {
      type: 'sendInput',
      data: custom.entry.decodedText,
      suppressTextInsertion: keybindingChordHasNoNonShiftModifiers(custom.binding)
    }
  }
  return null
}
