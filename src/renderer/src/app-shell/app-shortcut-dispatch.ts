import type { SetStateAction } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { isEditableTarget } from '@/lib/editable-target'
import { getSelectedTextForFileSearch } from '@/lib/file-search-selection'
import { requestFloatingTerminalOpenMaximized } from '@/lib/floating-terminal'
import {
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspaceTerminalInputTarget,
  matchFloatingWorkspacePanelChord,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut
} from '@/lib/floating-workspace-terminal-actions'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { findPluginCommandForKeybinding } from '@/lib/plugin-command-keybindings'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import {
  folderRelativePathToIncludeGlob,
  selectedExplorerFolderRelativePath
} from '../components/right-sidebar/file-search-include-pattern'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../../../shared/plugins/plugin-command-actions'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext,
  type KeybindingMatchOptions,
  type PhysicalModifierToken
} from '../../../shared/keybindings'
import type { ActivePluginCommand } from '../store/plugin-panels'
import { useAppStore } from '../store'
import { createAppCommandHandlers } from './app-command-handlers'
import { shortcutPlatform } from './renderer-window-chrome'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export type AppShortcutActions = Pick<
  AppStoreState,
  | 'showRightSidebarSearch'
  | 'showRightSidebarFiles'
  | 'toggleSidebar'
  | 'toggleRightSidebar'
  | 'setRightSidebarTab'
  | 'setRightSidebarOpen'
  | 'openDiffNotesSendMenuForActiveWorktree'
>

// Live shortcut inputs, re-read on every key event so one long-lived listener sees current state.
export type AppShortcutState = {
  activeView: AppStoreState['activeView']
  activeWorktreeId: string | null
  actions: AppShortcutActions
  floatingTerminalEnabled: boolean
  floatingTerminalOpen: boolean
  floatingVisibleTabCount: number
  keybindings: AppStoreState['keybindings']
  terminalShortcutPolicy: NonNullable<AppStoreState['settings']>['terminalShortcutPolicy']
  setFloatingTerminalOpenWithFocus: (nextOpen: SetStateAction<boolean>) => void
  workspaceChromeActive: boolean
  creationLayoutActive: boolean
}

// Abstraction over a real KeyboardEvent and a synthetic double-tap gesture so one dispatch path serves both; KeybindingInput-compatible.
export type ShortcutDispatchInput = {
  key?: string
  code?: string
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  doubleTapModifier?: PhysicalModifierToken
  target: EventTarget | null
  defaultPrevented: boolean
  preventDefault: () => void
}

export function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}

export function dispatchAppShortcut(
  state: AppShortcutState,
  input: ShortcutDispatchInput,
  // Why a separate argument: plugin commands live in their own store, so the keyboard hook reads
  // them rather than threading them through the App-owned shortcut state.
  pluginCommands: readonly ActivePluginCommand[]
): void {
  const {
    activeView,
    activeWorktreeId,
    actions,
    floatingTerminalEnabled,
    floatingTerminalOpen,
    floatingVisibleTabCount,
    keybindings,
    terminalShortcutPolicy,
    setFloatingTerminalOpenWithFocus,
    creationLayoutActive
  } = state

  // Child handlers (e.g. terminal search) share this window capture phase and fire first; bail if they already preventDefault'd so both don't act.
  if (input.defaultPrevented) {
    return
  }
  // The Settings shortcut recorder captures existing shortcuts, so global handlers must not fire while its button has focus.
  if (
    input.target instanceof Element &&
    input.target.closest('[data-shortcut-recorder-active]') !== null
  ) {
    return
  }
  const context = getKeybindingContext(input.target)

  // Note: some shortcuts are also intercepted in createMainWindow.ts before-input-event (for browser-guest focus); the renderer keeps handlers for local focus.

  const matchShortcut = (actionId: KeybindingActionId): boolean =>
    keybindingMatchesAction(actionId, input, shortcutPlatform, keybindings, {
      context,
      terminalShortcutPolicy
    })
  const notifyTerminalCapture = (actionId: KeybindingActionId): void => {
    if (context !== 'terminal' || (terminalShortcutPolicy ?? 'orca-first') !== 'orca-first') {
      return
    }
    showTerminalShortcutCaptureNotification({
      actionId,
      platform: shortcutPlatform,
      keybindings
    })
  }

  const canRevealRightSidebar = !creationLayoutActive && canShowRightSidebarForView(activeView)

  const openSearchSidebar = (query: string | null): void => {
    actions.showRightSidebarSearch(query ? { query } : undefined)
  }

  // In a terminal, Cmd/Ctrl+Shift+F means "search all terminals" (the federated
  // palette, FEDERATED-SEARCH-DESIGN §1); everywhere else the chord keeps the
  // sidebar file search below. Checked first so the terminal claim wins.
  if (context === 'terminal' && matchShortcut('terminal.searchAllPanes')) {
    input.preventDefault()
    useAppStore.getState().openModal('federated-search')
    return
  }

  if (matchShortcut('sidebar.search.toggle') && canRevealRightSidebar) {
    // With a folder selected in the explorer, Cmd/Ctrl+Shift+F means "Find in Folder" — seed the include pattern with it, not a text search.
    const selectedFolderRelativePath =
      document.activeElement instanceof Element
        ? selectedExplorerFolderRelativePath(document.activeElement)
        : null
    if (selectedFolderRelativePath !== null && activeWorktreeId) {
      input.preventDefault()
      notifyTerminalCapture('sidebar.search.toggle')
      actions.showRightSidebarSearch({
        includePattern: folderRelativePathToIncludeGlob(selectedFolderRelativePath)
      })
      return
    }

    const selectedText = getSelectedTextForFileSearch()
    if (selectedText) {
      input.preventDefault()
      notifyTerminalCapture('sidebar.search.toggle')
      openSearchSidebar(selectedText)
      return
    }
  }

  // An empty floating workspace has no tab to close, so Cmd/Ctrl+W hides the overlay before other surfaces act.
  if (
    keybindingMatchesAction('tab.close', input, shortcutPlatform, keybindings, {
      context: 'app'
    }) &&
    shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
      floatingTerminalOpen,
      floatingVisibleTabCount
    })
  ) {
    input.preventDefault()
    setFloatingTerminalOpenWithFocus(false)
    return
  }

  // Floating panel closed → its keydown handler is gone, so honor the maximize chord here by opening it pre-maximized (no-op while it's open).
  if (
    !floatingTerminalOpen &&
    matchShortcut('floatingWorkspace.maximize') &&
    floatingTerminalEnabled
  ) {
    input.preventDefault()
    requestFloatingTerminalOpenMaximized()
    setFloatingTerminalOpenWithFocus(true)
    return
  }

  // Skip editable surfaces so TipTap's Cmd+B bold works; this renderer-side fallback covers the blur→press IPC race (docs/markdown-cmd-b-bold-design.md).
  if (isEditableTarget(input.target)) {
    return
  }

  // Let floating-terminal SSH/tmux control chords reach the terminal (xterm's helper textarea isn't a generic editable target).
  if (isFloatingWorkspaceTerminalInputTarget(input.target)) {
    return
  }

  // Only short-circuit chords the floating panel itself claims; suppressing others here would silently no-op them when focus is in the panel.
  if (isFloatingWorkspacePanelFocused()) {
    const floatingMatchOptions: KeybindingMatchOptions = { context, terminalShortcutPolicy }
    if (
      matchFloatingWorkspacePanelChord(
        input,
        shortcutPlatform,
        null,
        keybindings,
        floatingMatchOptions
      ) !== null
    ) {
      return
    }
  }

  // Plugin chords are user-reviewed instructional content. They win over built-in defaults only in
  // app focus; terminal/editor/browser handlers retain their own shortcut authority.
  if (context === 'app') {
    const pluginCommand = findPluginCommandForKeybinding(
      pluginCommands,
      input,
      shortcutPlatform,
      keybindings,
      Boolean(activeWorktreeId)
    )
    if (pluginCommand) {
      input.preventDefault()
      void executePluginCommand(pluginCommand, 'plugin-keybinding').catch(() => {
        toast.error(translate('auto.App.pluginCommandFailed', 'Could not run the plugin command.'))
      })
      return
    }
  }

  // Built-in actions run through the same handler map plugin aliases dispatch into, so a chord and
  // an alias can never diverge. Order follows the alias list (navigation before sidebar reveal).
  const handlers = createAppCommandHandlers(state, input, context)
  for (const actionId of PLUGIN_COMMAND_ALIAS_ACTION_IDS) {
    if (matchShortcut(actionId) && handlers.get(actionId)?.()) {
      return
    }
  }

  // Unbound by default, so it runs after the built-in alias handlers above; only consumes the chord when there are unsent notes.
  if (canRevealRightSidebar && matchShortcut('sourceControl.sendReviewNotes')) {
    if (actions.openDiffNotesSendMenuForActiveWorktree()) {
      input.preventDefault()
      notifyTerminalCapture('sourceControl.sendReviewNotes')
    }
  }
}
