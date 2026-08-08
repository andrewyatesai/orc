/**
 * Mode-aware shell chrome — `docs/reference/app-modes.md` §5.3 step 1 and §5.4.
 *
 * Pure, so the whole mode/chrome interaction is testable without React. Every
 * decision here is a RENDER-TIME gate: nothing in this module writes persisted
 * state, which is the invariant that makes a `Classic → mode → Classic` round
 * trip lossless (§1).
 *
 * `canShowRightSidebarForView` deliberately stays mode-free and is NOT consulted
 * here: it has five call sites and gates PR/check DATA FETCHING, so threading
 * mode into it would suspend a data feed as a side effect of a visibility flag.
 * Right-sidebar mode gating lives only at the render site below.
 */

import { isSurfaceEnabled } from '../../../shared/app-mode/app-mode-capability'
import { surfaceForKeybindingAction } from '../../../shared/app-mode/keybinding-action-surfaces'

export type AppShellChromeInput = {
  mode: unknown
  /** The user's persisted preference. Gated for display, never overwritten. */
  statusBarVisible: boolean
  rightSidebarOpen: boolean
  showTabBar: boolean
  showSplitAffordances: boolean
  showWorktreeHistoryControls: boolean
  showTitlebarTabs: boolean
}

export type AppShellChrome = {
  showStatusBar: boolean
  showRightSidebar: boolean
  showTabBar: boolean
  showSplitAffordances: boolean
  showWorktreeHistoryControls: boolean
  showTitlebarTabs: boolean
  /** `TabGroupPanel` renders its tab bar and wires split-drag unconditionally;
   *  this is the single derived prop that turns both off together. */
  tabsLocked: boolean
}

/**
 * Every field is `persisted && modeAllows`. Composed in that order on purpose:
 * the user's preference is read first and the mode can only ever subtract, so a
 * mode can never turn a surface ON that the user turned off.
 */
export function resolveAppShellChrome(input: AppShellChromeInput): AppShellChrome {
  const allows = (surface: Parameters<typeof isSurfaceEnabled>[1]): boolean =>
    isSurfaceEnabled(input.mode, surface)
  const showTabBar = input.showTabBar && allows('tabBar')
  const showSplitAffordances = input.showSplitAffordances && allows('splitAffordances')
  return {
    showStatusBar: input.statusBarVisible && allows('statusBar'),
    showRightSidebar: input.rightSidebarOpen && allows('rightSidebar'),
    showTabBar,
    showSplitAffordances,
    showWorktreeHistoryControls:
      input.showWorktreeHistoryControls && allows('worktreeHistoryControls'),
    showTitlebarTabs: input.showTitlebarTabs && allows('titlebarTabs'),
    tabsLocked: !showTabBar || !showSplitAffordances
  }
}

/**
 * §10.6: the seam the surface table cannot see. The shortcut dispatcher does not
 * carry the chrome booleans, so without this a mode that hides the right sidebar
 * still lets `sidebar.sourceControl.toggle` fire — and that handler WRITES
 * `rightSidebarTab`/`rightSidebarOpen` into persisted UI state. A mode-caused
 * write to state the design promises is only ever gated at read time, invisible
 * because the surface it rewrites is hidden.
 *
 * Consulted once, before any store mutation. Actions with no mapped surface are
 * never gated — a missing entry keeps a shortcut working rather than silently
 * killing it.
 */
export function isKeybindingActionAllowed(mode: unknown, action: string): boolean {
  const surface = surfaceForKeybindingAction(action)
  return surface === null || isSurfaceEnabled(mode, surface)
}
