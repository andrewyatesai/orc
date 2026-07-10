import type { ManagedPaneInternal } from './pane-manager-types'
import { attachRainOverlay } from './pane-rain-overlay'
import type { RainOverlayEngineFactory } from './pane-rain-overlay-types'

export function attachPaneRainOverlay(pane: ManagedPaneInternal): void {
  if (!pane.rainOverlayEngineFactory || pane.rainOverlayController) {
    return
  }
  pane.rainOverlayController = attachRainOverlay({
    paneId: pane.id,
    terminal: pane.terminal,
    xtermContainer: pane.xtermContainer,
    createEngine: pane.rainOverlayEngineFactory,
    initiallySuspended: pane.webglAttachmentDeferred
  })
}

export function detachPaneRainOverlay(pane: ManagedPaneInternal): void {
  pane.rainOverlayController?.dispose()
  pane.rainOverlayController = null
}

export function setPaneRainOverlayEngineFactory(
  pane: ManagedPaneInternal,
  factory: RainOverlayEngineFactory | undefined
): void {
  if (pane.rainOverlayEngineFactory === factory) {
    attachPaneRainOverlay(pane)
    return
  }
  detachPaneRainOverlay(pane)
  pane.rainOverlayEngineFactory = factory
  attachPaneRainOverlay(pane)
}
