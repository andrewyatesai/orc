import type { SetStateAction } from 'react'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { isEditableTarget } from '@/lib/editable-target'
import { getSelectedTextForFileSearch } from '@/lib/file-search-selection'
import { requestFloatingTerminalOpenMaximized } from '@/lib/floating-terminal'
import {
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspacePanelShortcut,
  isFloatingWorkspaceTerminalInputTarget,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut
} from '@/lib/floating-workspace-terminal-actions'
import { requestScrollToCurrentWorkspaceRevealAndRename } from '@/lib/scroll-to-current-workspace-status'
import { shouldShowWorktreeHistoryControls } from '@/lib/titlebar-worktree-history-controls'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import {
  folderRelativePathToIncludeGlob,
  selectedExplorerFolderRelativePath
} from '../components/right-sidebar/file-search-include-pattern'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '../components/sidebar/useWorkspaceBoardPanel'
import { isGitRepoKind } from '../../../shared/repo-kind'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext,
  type PhysicalModifierToken
} from '../../../shared/keybindings'
import { useAppStore } from '../store'
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

export function dispatchAppShortcut(state: AppShortcutState, input: ShortcutDispatchInput): void {
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
    workspaceChromeActive,
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

  // Cmd/Ctrl+Alt+Arrow worktree history — kept before right-sidebar shortcuts because it's navigation, not sidebar reveal.
  if (matchShortcut('worktree.history.back') || matchShortcut('worktree.history.forward')) {
    // Back/Forward is live wherever the titlebar cluster shows (worktree + page visits), but suppressed in Settings.
    if (creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)) {
      return
    }
    input.preventDefault()
    const store = useAppStore.getState()
    if (matchShortcut('worktree.history.back')) {
      store.goBackWorktree()
    } else {
      store.goForwardWorktree()
    }
    return
  }

  // Only short-circuit chords the floating panel itself claims; suppressing others here would silently no-op them when focus is in the panel.
  const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
  if (floatingWorkspaceFocused) {
    if (
      isFloatingWorkspacePanelShortcut(input, shortcutPlatform, null, keybindings, {
        context,
        terminalShortcutPolicy
      })
    ) {
      return
    }
  }

  // Cmd/Ctrl+B — toggle left sidebar
  if (matchShortcut('sidebar.left.toggle')) {
    input.preventDefault()
    notifyTerminalCapture('sidebar.left.toggle')
    actions.toggleSidebar()
    return
  }

  // Toggle the sleeping-workspaces filter without the filters menu (issue #5209); open the sidebar when revealing so they're reachable.
  if (matchShortcut('sidebar.sleepingWorkspaces.toggle')) {
    input.preventDefault()
    notifyTerminalCapture('sidebar.sleepingWorkspaces.toggle')
    const store = useAppStore.getState()
    const nextShowSleeping = !store.showSleepingWorkspaces
    store.setShowSleepingWorkspaces(nextShowSleeping)
    if (nextShowSleeping) {
      store.setSidebarOpen(true)
    }
    return
  }

  // Cmd+R renames the active terminal tab — free here because the browser pane owns its own reload; non-terminal tabs fall through (no inline title editor).
  if (workspaceChromeActive && !floatingWorkspaceFocused && matchShortcut('tab.rename')) {
    const store = useAppStore.getState()
    if (store.activeTabType === 'terminal' && store.activeTabId) {
      input.preventDefault()
      notifyTerminalCapture('tab.rename')
      store.setRenamingTabId(store.activeTabId)
      return
    }
  }

  // Open/reveal the worktree card first so its inline title editor is mounted even when filters or collapse state would hide it.
  if (
    workspaceChromeActive &&
    !floatingWorkspaceFocused &&
    matchShortcut('workspace.rename') &&
    activeWorktreeId
  ) {
    input.preventDefault()
    notifyTerminalCapture('workspace.rename')
    const store = useAppStore.getState()
    store.setSidebarOpen(true)
    requestScrollToCurrentWorkspaceRevealAndRename()
    return
  }

  if (matchShortcut('workspace.openBoard') && activeView !== 'settings') {
    input.preventDefault()
    notifyTerminalCapture('workspace.openBoard')
    const store = useAppStore.getState()
    store.setSidebarOpen(true)
    window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
    return
  }

  // Cmd/Ctrl+N is handled in the main-process before-input-event allowlist (window-shortcut-policy.ts), not here, so it fires even inside editors/browser guests.

  // Full-page navigation surfaces own the whole content area, so don't reveal the right sidebar.
  if (matchShortcut('view.tasks') && activeView !== 'settings') {
    const store = useAppStore.getState()
    if (store.repos.some((repo) => isGitRepoKind(repo))) {
      input.preventDefault()
      notifyTerminalCapture('view.tasks')
      store.openTaskPage()
    }
    return
  }

  if (!canRevealRightSidebar) {
    return
  }

  // Cmd/Ctrl+L — toggle right sidebar
  if (matchShortcut('sidebar.right.toggle')) {
    input.preventDefault()
    notifyTerminalCapture('sidebar.right.toggle')
    actions.toggleRightSidebar()
    return
  }

  // Cmd/Ctrl+Shift+E — toggle right sidebar / explorer tab
  if (matchShortcut('sidebar.explorer.toggle')) {
    input.preventDefault()
    notifyTerminalCapture('sidebar.explorer.toggle')
    actions.showRightSidebarFiles()
    return
  }

  // Cmd/Ctrl+Shift+F — toggle right sidebar / search tab
  if (matchShortcut('sidebar.search.toggle')) {
    input.preventDefault()
    notifyTerminalCapture('sidebar.search.toggle')
    openSearchSidebar(null)
    return
  }

  // Cmd/Ctrl+Shift+G — source control tab; skip when terminal search is open (there it means "find previous"). DOM check because capture-phase order varies.
  if (matchShortcut('sidebar.sourceControl.toggle')) {
    if (document.querySelector('[data-terminal-search-root]')) {
      return
    }
    input.preventDefault()
    notifyTerminalCapture('sidebar.sourceControl.toggle')
    actions.setRightSidebarTab('source-control')
    actions.setRightSidebarOpen(true)
    return
  }

  // Unbound by default; opens the active worktree's Source Control notes send picker. Only consumes the chord when there are unsent notes.
  if (matchShortcut('sourceControl.sendReviewNotes')) {
    if (actions.openDiffNotesSendMenuForActiveWorktree()) {
      input.preventDefault()
      notifyTerminalCapture('sourceControl.sendReviewNotes')
      return
    }
  }

  if (matchShortcut('sidebar.checks.toggle')) {
    input.preventDefault()
    notifyTerminalCapture('sidebar.checks.toggle')
    actions.setRightSidebarTab('checks')
    actions.setRightSidebarOpen(true)
    return
  }

  // Cmd+Shift+I — ports tab (macOS only); Ctrl+Shift+I is the DevTools accelerator on Windows/Linux.
  if (matchShortcut('sidebar.ports.toggle')) {
    input.preventDefault()
    notifyTerminalCapture('sidebar.ports.toggle')
    actions.setRightSidebarTab('ports')
    actions.setRightSidebarOpen(true)
  }
}
