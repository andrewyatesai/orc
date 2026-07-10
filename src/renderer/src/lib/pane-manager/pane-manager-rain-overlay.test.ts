// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PaneManager } from './pane-manager'
import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import type { RainOverlayEngineFactory } from './pane-rain-overlay-types'
import { setPaneRainOverlayEngineFactory } from './pane-rain-overlay-lifecycle'

vi.mock('./pane-rain-overlay-lifecycle', () => ({
  attachPaneRainOverlay: vi.fn(),
  detachPaneRainOverlay: vi.fn(),
  setPaneRainOverlayEngineFactory: vi.fn()
}))

type MutableManager = {
  panes: Map<number, ManagedPaneInternal>
  options: PaneManagerOptions
  destroyed: boolean
}

describe('PaneManager.setRainOverlayEngineFactory', () => {
  beforeEach(() => vi.mocked(setPaneRainOverlayEngineFactory).mockReset())

  it('updates all mounted panes and the factory inherited by future panes', () => {
    const options: PaneManagerOptions = {}
    const manager = new PaneManager(document.createElement('div'), options)
    const state = manager as unknown as MutableManager
    const panes = [{ id: 1 } as ManagedPaneInternal, { id: 2 } as ManagedPaneInternal]
    state.panes = new Map(panes.map((pane) => [pane.id, pane]))
    const factory = vi.fn(() => null) as RainOverlayEngineFactory

    manager.setRainOverlayEngineFactory(factory)

    expect(options.createRainOverlayEngine).toBe(factory)
    expect(setPaneRainOverlayEngineFactory).toHaveBeenCalledTimes(2)
    expect(setPaneRainOverlayEngineFactory).toHaveBeenNthCalledWith(1, panes[0], factory)
    expect(setPaneRainOverlayEngineFactory).toHaveBeenNthCalledWith(2, panes[1], factory)

    manager.setRainOverlayEngineFactory(undefined)
    expect(options.createRainOverlayEngine).toBeUndefined()
    expect(setPaneRainOverlayEngineFactory).toHaveBeenNthCalledWith(3, panes[0], undefined)
    expect(setPaneRainOverlayEngineFactory).toHaveBeenNthCalledWith(4, panes[1], undefined)
  })

  it('does nothing after manager destruction', () => {
    const options: PaneManagerOptions = {}
    const manager = new PaneManager(document.createElement('div'), options)
    const state = manager as unknown as MutableManager
    state.destroyed = true

    manager.setRainOverlayEngineFactory(vi.fn(() => null) as RainOverlayEngineFactory)

    expect(options.createRainOverlayEngine).toBeUndefined()
    expect(setPaneRainOverlayEngineFactory).not.toHaveBeenCalled()
  })

  it('invalidates every mounted overlay after an appearance change', () => {
    const manager = new PaneManager(document.createElement('div'), {})
    const state = manager as unknown as MutableManager
    const firstInvalidate = vi.fn()
    const secondInvalidate = vi.fn()
    state.panes = new Map([
      [
        1,
        {
          id: 1,
          rainOverlayController: { invalidate: firstInvalidate }
        } as unknown as ManagedPaneInternal
      ],
      [2, { id: 2, rainOverlayController: null } as ManagedPaneInternal],
      [
        3,
        {
          id: 3,
          rainOverlayController: { invalidate: secondInvalidate }
        } as unknown as ManagedPaneInternal
      ]
    ])

    manager.invalidateRainOverlays()

    expect(firstInvalidate).toHaveBeenCalledOnce()
    expect(secondInvalidate).toHaveBeenCalledOnce()
  })
})
