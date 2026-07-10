import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagedPaneInternal } from './pane-manager-types'
import type { RainOverlayController, RainOverlayEngineFactory } from './pane-rain-overlay-types'
import {
  attachPaneRainOverlay,
  setPaneRainOverlayEngineFactory
} from './pane-rain-overlay-lifecycle'
import { attachRainOverlay } from './pane-rain-overlay'

vi.mock('./pane-rain-overlay', () => ({ attachRainOverlay: vi.fn() }))

function controller(): RainOverlayController & {
  dispose: ReturnType<typeof vi.fn<() => void>>
} {
  return {
    ready: Promise.resolve(true),
    setSuspended: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn<() => void>()
  }
}

function pane(): ManagedPaneInternal {
  return {
    id: 4,
    terminal: {} as never,
    xtermContainer: {} as never,
    webglAttachmentDeferred: false,
    rainOverlayController: null,
    rainOverlayEngineFactory: undefined
  } as unknown as ManagedPaneInternal
}

describe('pane rain overlay lifecycle', () => {
  beforeEach(() => vi.mocked(attachRainOverlay).mockReset())

  it('attaches once, replaces safely, and detaches synchronously', () => {
    const target = pane()
    const firstController = controller()
    const secondController = controller()
    const firstFactory = vi.fn(() => null) as RainOverlayEngineFactory
    const secondFactory = vi.fn(() => null) as RainOverlayEngineFactory
    vi.mocked(attachRainOverlay)
      .mockReturnValueOnce(firstController)
      .mockReturnValueOnce(secondController)

    setPaneRainOverlayEngineFactory(target, firstFactory)
    expect(attachRainOverlay).toHaveBeenCalledWith({
      paneId: 4,
      terminal: target.terminal,
      xtermContainer: target.xtermContainer,
      createEngine: firstFactory,
      initiallySuspended: false
    })
    setPaneRainOverlayEngineFactory(target, firstFactory)
    expect(attachRainOverlay).toHaveBeenCalledOnce()

    setPaneRainOverlayEngineFactory(target, secondFactory)
    expect(firstController.dispose).toHaveBeenCalledOnce()
    expect(target.rainOverlayController).toBe(secondController)
    expect(attachRainOverlay).toHaveBeenCalledTimes(2)

    setPaneRainOverlayEngineFactory(target, undefined)
    expect(secondController.dispose).toHaveBeenCalledOnce()
    expect(target.rainOverlayController).toBeNull()
    expect(target.rainOverlayEngineFactory).toBeUndefined()
  })

  it('attaches a factory recorded before the terminal opens', () => {
    const target = pane()
    const existingController = controller()
    target.rainOverlayEngineFactory = vi.fn(() => null) as RainOverlayEngineFactory
    vi.mocked(attachRainOverlay).mockReturnValue(existingController)

    attachPaneRainOverlay(target)

    expect(target.rainOverlayController).toBe(existingController)
    expect(attachRainOverlay).toHaveBeenCalledOnce()
  })
})
