import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

const MIN_PANE_FIT_WIDTH_PX = 48
const MIN_PANE_FIT_HEIGHT_PX = 24
const MIN_PANE_FIT_COLS = 8
const MIN_PANE_FIT_ROWS = 4

export function getProposedDimensions(pane: ManagedPane): { cols: number; rows: number } | null {
  try {
    return pane.fitAddon.proposeDimensions() ?? null
  } catch {
    return null
  }
}

// Why: measure the element the fit actually sizes (the terminal host), not the
// outer .pane — a title/banner can shrink the inner fittable area while the outer
// stays put. Round to whole pixels so sub-pixel jitter never reads as a resize.
export function readFitClientSize(pane: ManagedPane): { width: number; height: number } | null {
  const element = (pane as ManagedPaneInternal).xtermContainer ?? pane.container
  const measure = element?.getBoundingClientRect
  if (typeof measure !== 'function') {
    return null
  }
  const rect = measure.call(element)
  return { width: Math.round(rect.width), height: Math.round(rect.height) }
}

export function recordPaneFitClientSize(pane: ManagedPane): void {
  const size = readFitClientSize(pane)
  if (size && size.width > 0 && size.height > 0) {
    ;(pane as ManagedPaneInternal).lastFitClientSize = size
  }
}

export function hasMeasurableContainerLayout(pane: ManagedPane): boolean {
  const measure = pane.container?.getBoundingClientRect
  if (typeof measure !== 'function') {
    return true
  }
  const rect = measure.call(pane.container)
  return rect.width >= MIN_PANE_FIT_WIDTH_PX && rect.height >= MIN_PANE_FIT_HEIGHT_PX
}

export function canMeasurePaneForFit(pane: ManagedPane): boolean {
  if (!hasMeasurableContainerLayout(pane)) {
    return false
  }
  const dims = getProposedDimensions(pane)
  if (!dims) {
    return false
  }
  // Why: worktree switches can briefly measure a near-zero overlay before
  // fallback positioning lands. Fitting there pins the PTY at ~2 cols.
  return dims.cols >= MIN_PANE_FIT_COLS && dims.rows >= MIN_PANE_FIT_ROWS
}
