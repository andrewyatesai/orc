import { describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { disposePane } from './pane-lifecycle'

// Records the teardown call order so the pre-dispose selection drop is provable.
function makePane(events: string[]): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      clearSelection: vi.fn(() => {
        events.push('clearSelection')
      }),
      dispose: vi.fn(() => {
        events.push('dispose')
      })
    } as never,
    container: { removeEventListener: vi.fn() } as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    fitAddon: { dispose: vi.fn() } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: { dispose: vi.fn() } as never,
    serializeAddon: { dispose: vi.fn() } as never,
    panePointerDownHandler: vi.fn(),
    paneMouseEnterHandler: vi.fn(),
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('disposePane selection cleanup', () => {
  it('clears the engine selection before disposing the surface', () => {
    // Why: a recovery remount replaces the surface; a stale selection left on the
    // old engine would otherwise survive into the fresh pane (upstream #13677).
    const events: string[] = []
    const pane = makePane(events)

    disposePane(pane, new Map([[pane.id, pane]]))

    expect(pane.terminal.clearSelection).toHaveBeenCalledTimes(1)
    expect(events.indexOf('clearSelection')).toBeLessThan(events.indexOf('dispose'))
  })
})
