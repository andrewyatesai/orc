/**
 * Which surface each gateable keyboard action belongs to —
 * `docs/reference/app-modes.md` §10.6.
 *
 * **Why this exists at all.** The shortcut dispatcher does not see the chrome
 * booleans. Without this map, a mode that hides the right sidebar still lets
 * `sidebar.sourceControl.toggle` fire, which *writes* `rightSidebarTab` and
 * `rightSidebarOpen` into `PersistedUIState`. That is a mode-caused write to the
 * exact state the design promises is only ever gated at read time — and it is
 * invisible, because the surface it rewrites is hidden.
 *
 * Keyed on action id, never on chord: users can rebind, so a chord-keyed gate
 * would be defeated by the keybindings file.
 *
 * Actions absent from this map are never gated. That is the safe default — a
 * missing entry means a shortcut keeps working, not that it silently dies.
 */

import type { KeybindingActionId } from '../keybindings'
import type { AppSurfaceId } from './app-mode-surfaces'

export const KEYBINDING_ACTION_SURFACES: Partial<Record<KeybindingActionId, AppSurfaceId>> = {
  'sidebar.right.toggle': 'rightSidebar',
  'sidebar.explorer.toggle': 'rightSidebar.explorer',
  'sidebar.sourceControl.toggle': 'rightSidebar.sourceControl',
  'sidebar.checks.toggle': 'rightSidebar.checks',
  'sidebar.ports.toggle': 'rightSidebar.ports',
  'terminal.splitRight': 'splitAffordances',
  'terminal.splitDown': 'splitAffordances',
  'terminal.closePane': 'splitAffordances',
  'terminal.focusNextPane': 'splitAffordances',
  'terminal.focusPreviousPane': 'splitAffordances',
  'terminal.equalizePaneSizes': 'splitAffordances',
  'terminal.expandPane': 'splitAffordances',
  'worktree.history.back': 'worktreeHistoryControls',
  'worktree.history.forward': 'worktreeHistoryControls',
  'floatingTerminal.toggle': 'floatingTerminal',
  'view.tasks': 'view.tasks',
  'tab.newBrowser': 'editorTabs',
  'tab.newMarkdown': 'editorTabs',
  'tab.openMarkdown': 'editorTabs',
  'editor.find': 'editorTabs',
  'editor.replace': 'editorTabs',
  'editor.save': 'editorTabs',
  'editor.markdownPreview': 'editorTabs',
  'editor.toggleWordWrap': 'editorTabs',
  'editor.previousChange': 'diffSurfaces',
  'editor.nextChange': 'diffSurfaces',
  'editor.addReviewNote': 'diffSurfaces',
  'sourceControl.sendReviewNotes': 'rightSidebar.sourceControl',
  'fileExplorer.undo': 'rightSidebar.explorer',
  'fileExplorer.redo': 'rightSidebar.explorer',
  'fileExplorer.copyPath': 'rightSidebar.explorer',
  'fileExplorer.copyRelativePath': 'rightSidebar.explorer',
  'fileExplorer.delete': 'rightSidebar.explorer',
  'app.forceReload': 'devTools'
}

/** The surface an action needs, or null when it is never gated. */
export function surfaceForKeybindingAction(action: string): AppSurfaceId | null {
  return KEYBINDING_ACTION_SURFACES[action as KeybindingActionId] ?? null
}
