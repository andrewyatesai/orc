import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

// Why: a pane hidden with `display: none` can never become measurable, so fit
// retries against it spin the rAF loop forever; treat it as a terminal signal
// to stop instead of arming another frame.
export function isManagedPaneDisplayNone(pane: ManagedPane): boolean {
  const element = (pane as ManagedPaneInternal).xtermContainer ?? pane.container
  const view = element?.ownerDocument?.defaultView
  if (!element || !view) {
    return false
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (view.getComputedStyle(current).display === 'none') {
      return true
    }
  }
  return false
}
