import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { requestFloatingTerminalOpenMaximized } from '@/lib/floating-terminal'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { requestScrollToCurrentWorkspaceRevealAndRename } from '@/lib/scroll-to-current-workspace-status'
import { shouldShowWorktreeHistoryControls } from '@/lib/titlebar-worktree-history-controls'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { KeybindingActionId, KeybindingContext } from '../../../shared/keybindings'
import { OPEN_WORKSPACE_BOARD_EVENT } from '../components/sidebar/useWorkspaceBoardPanel'
import { useAppStore } from '../store'
import type { AppShortcutState, ShortcutDispatchInput } from './app-shortcut-dispatch'
import { shortcutPlatform } from './renderer-window-chrome'

/**
 * Built-in actions a plugin may alias or a plugin palette may invoke, as one
 * handler map so key dispatch and programmatic dispatch share the same guards.
 * Each handler returns whether it claimed the action.
 *
 * Why the optional `input`: programmatic dispatch has no key event to
 * preventDefault and no terminal-capture notice to show.
 */
export function createAppCommandHandlers(
  state: AppShortcutState,
  input?: ShortcutDispatchInput,
  keybindingContext: KeybindingContext = 'app'
): Map<KeybindingActionId, () => boolean> {
  const {
    activeView,
    activeWorktreeId,
    actions,
    floatingTerminalEnabled,
    floatingTerminalOpen,
    keybindings,
    terminalShortcutPolicy,
    setFloatingTerminalOpenWithFocus,
    workspaceChromeActive,
    creationLayoutActive
  } = state
  const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
  const canRevealRightSidebar = !creationLayoutActive && canShowRightSidebarForView(activeView)

  const claim = (actionId: KeybindingActionId, run: () => void): boolean => {
    input?.preventDefault()
    if (
      input &&
      keybindingContext === 'terminal' &&
      (terminalShortcutPolicy ?? 'orca-first') === 'orca-first'
    ) {
      showTerminalShortcutCaptureNotification({ actionId, platform: shortcutPlatform, keybindings })
    }
    run()
    return true
  }

  return new Map<KeybindingActionId, () => boolean>([
    [
      'worktree.history.back',
      () =>
        creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)
          ? false
          : claim('worktree.history.back', () => useAppStore.getState().goBackWorktree())
    ],
    [
      'worktree.history.forward',
      () =>
        creationLayoutActive || !shouldShowWorktreeHistoryControls(activeView)
          ? false
          : claim('worktree.history.forward', () => useAppStore.getState().goForwardWorktree())
    ],
    ['sidebar.left.toggle', () => claim('sidebar.left.toggle', () => actions.toggleSidebar())],
    [
      'sidebar.sleepingWorkspaces.toggle',
      () =>
        // Toggling the filter without the filters menu (issue #5209); open the sidebar when revealing so they're reachable.
        claim('sidebar.sleepingWorkspaces.toggle', () => {
          const store = useAppStore.getState()
          const nextShowSleeping = !store.showSleepingWorkspaces
          store.setShowSleepingWorkspaces(nextShowSleeping)
          if (nextShowSleeping) {
            store.setSidebarOpen(true)
          }
        })
    ],
    [
      'floatingWorkspace.maximize',
      () =>
        floatingTerminalOpen || !floatingTerminalEnabled
          ? false
          : claim('floatingWorkspace.maximize', () => {
              requestFloatingTerminalOpenMaximized()
              setFloatingTerminalOpenWithFocus(true)
            })
    ],
    [
      'tab.rename',
      () => {
        // Cmd+R renames the active terminal tab; non-terminal tabs have no inline title editor.
        const store = useAppStore.getState()
        const activeTabId = store.activeTabId
        if (
          !workspaceChromeActive ||
          floatingWorkspaceFocused ||
          store.activeTabType !== 'terminal' ||
          !activeTabId
        ) {
          return false
        }
        return claim('tab.rename', () => store.setRenamingTabId(activeTabId))
      }
    ],
    [
      'workspace.rename',
      () =>
        !workspaceChromeActive || floatingWorkspaceFocused || !activeWorktreeId
          ? false
          : // Open/reveal the worktree card first so its inline title editor is mounted even when filters or collapse state would hide it.
            claim('workspace.rename', () => {
              useAppStore.getState().setSidebarOpen(true)
              requestScrollToCurrentWorkspaceRevealAndRename()
            })
    ],
    [
      'workspace.openBoard',
      () =>
        activeView === 'settings'
          ? false
          : claim('workspace.openBoard', () => {
              useAppStore.getState().setSidebarOpen(true)
              window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_BOARD_EVENT))
            })
    ],
    [
      'view.tasks',
      () => {
        const store = useAppStore.getState()
        return activeView === 'settings' || !store.repos.some((repo) => isGitRepoKind(repo))
          ? false
          : claim('view.tasks', () => store.openTaskPage())
      }
    ],
    [
      'sidebar.right.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.right.toggle', () => actions.toggleRightSidebar())
          : false
    ],
    [
      'sidebar.explorer.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.explorer.toggle', () => actions.showRightSidebarFiles())
          : false
    ],
    [
      'sidebar.search.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.search.toggle', () => actions.showRightSidebarSearch())
          : false
    ],
    [
      'sidebar.sourceControl.toggle',
      () =>
        // Skip while terminal search is open — there the chord means "find previous". DOM check because capture-phase order varies.
        !canRevealRightSidebar || document.querySelector('[data-terminal-search-root]')
          ? false
          : claim('sidebar.sourceControl.toggle', () => {
              actions.setRightSidebarTab('source-control')
              actions.setRightSidebarOpen(true)
            })
    ],
    [
      'sidebar.checks.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.checks.toggle', () => {
              actions.setRightSidebarTab('checks')
              actions.setRightSidebarOpen(true)
            })
          : false
    ],
    [
      'sidebar.ports.toggle',
      () =>
        canRevealRightSidebar
          ? claim('sidebar.ports.toggle', () => {
              actions.setRightSidebarTab('ports')
              actions.setRightSidebarOpen(true)
            })
          : false
    ]
  ])
}
