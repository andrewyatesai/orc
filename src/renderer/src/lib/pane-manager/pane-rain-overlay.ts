import type { Terminal } from '@xterm/xterm'

import { attachRainOverlayHostEvents } from './pane-rain-overlay-host-events'
import { RainOverlaySnapshotCollector } from './pane-rain-overlay-snapshot'
import type {
  RainOverlayController,
  RainOverlayEngine,
  RainOverlayEngineFactory
} from './pane-rain-overlay-types'
import {
  createRainOverlayCanvas,
  rainOverlayGeometryEquals,
  readRainOverlayGeometry
} from './pane-rain-overlay-geometry'
import type { RainOverlayGeometry } from './pane-rain-overlay-geometry'

type AttachRainOverlayOptions = {
  readonly paneId: number
  readonly terminal: Terminal
  readonly xtermContainer: HTMLElement
  readonly createEngine: RainOverlayEngineFactory
  readonly initiallySuspended?: boolean
}

export function attachRainOverlay(options: AttachRainOverlayOptions): RainOverlayController {
  const { paneId, terminal, xtermContainer, createEngine } = options
  let canvas = createRainOverlayCanvas()
  xtermContainer.appendChild(canvas)

  const collector = new RainOverlaySnapshotCollector()
  let engine: RainOverlayEngine | null = null
  let disposed = false
  let suspended = options.initiallySuspended === true
  let intersecting = true
  let windowFocused = document.hasFocus()
  let frameId: number | null = null
  let contentSequence = 0
  let snapshotDirty = true
  let geometryDirty = true
  let geometry: RainOverlayGeometry | null = null
  let engineVisible: boolean | null = null
  let disposeHostEvents: (() => void) | null = null
  let started = false
  let engineGeneration = 0
  let creationGeneration: number | null = null
  let readySettled = false
  let resolveReady!: (ready: boolean) => void
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve
  })

  const settleReady = (value: boolean): void => {
    if (readySettled) {
      return
    }
    readySettled = true
    resolveReady(value)
  }

  const cancelFrame = (): void => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
      frameId = null
    }
  }

  const releaseEngine = (): void => {
    const releasedEngine = engine
    engine = null
    engineVisible = null
    canvas.hidden = true
    if (!releasedEngine) {
      return
    }
    try {
      releasedEngine.setVisible(false)
    } catch {
      // Continue releasing the GPU context after an optional visibility failure.
    }
    try {
      releasedEngine.dispose()
    } catch {
      // Optional art teardown cannot interrupt terminal rendering suspension.
    }
  }

  const replaceCanvas = (): void => {
    canvas.remove()
    canvas = createRainOverlayCanvas()
    xtermContainer.appendChild(canvas)
    geometry = null
    geometryDirty = true
  }

  const shouldRun = (): boolean =>
    !disposed &&
    !suspended &&
    intersecting &&
    windowFocused &&
    document.visibilityState !== 'hidden' &&
    xtermContainer.isConnected

  const disposeListeners = (): void => {
    disposeHostEvents?.()
    disposeHostEvents = null
  }

  const failClosed = (error: unknown): void => {
    if (disposed) {
      return
    }
    console.warn('[terminal] aterm rain overlay disabled after engine failure', error)
    disposed = true
    engineGeneration += 1
    cancelFrame()
    disposeListeners()
    releaseEngine()
    canvas.remove()
    settleReady(false)
  }

  const setEngineVisible = (visible: boolean): boolean => {
    if (!engine || engineVisible === visible) {
      canvas.hidden = !visible
      return true
    }
    try {
      engine.setVisible(visible)
      engineVisible = visible
      canvas.hidden = !visible
      return true
    } catch (error) {
      failClosed(error)
      return false
    }
  }

  const updateGate = (): boolean => {
    const visible = shouldRun()
    if (!visible) {
      cancelFrame()
    }
    return setEngineVisible(visible) && visible
  }

  const syncGeometry = (): boolean => {
    const next = readRainOverlayGeometry(terminal, xtermContainer)
    geometryDirty = false
    if (!next) {
      geometry = null
      setEngineVisible(false)
      return false
    }
    if (rainOverlayGeometryEquals(geometry, next)) {
      return true
    }
    geometry = next
    canvas.style.left = `${next.left}px`
    canvas.style.top = `${next.top}px`
    canvas.style.width = `${next.cssWidth}px`
    canvas.style.height = `${next.cssHeight}px`
    canvas.width = next.pixelWidth
    canvas.height = next.pixelHeight
    try {
      engine?.resize(next)
      return true
    } catch (error) {
      failClosed(error)
      return false
    }
  }

  const scheduleFrame = (): void => {
    if (frameId !== null || !engine || !updateGate()) {
      return
    }
    frameId = requestAnimationFrame(renderFrame)
  }

  const renderFrame = (timestampMs: number): void => {
    frameId = null
    if (!engine || !updateGate()) {
      return
    }
    if ((geometryDirty || !geometry) && !syncGeometry()) {
      return
    }
    try {
      if (snapshotDirty) {
        snapshotDirty = false
        engine.update(collector.capture(terminal, contentSequence))
      }
      if (engine.render(timestampMs)) {
        scheduleFrame()
      }
    } catch (error) {
      failClosed(error)
    }
  }

  const invalidateSnapshot = (): void => {
    snapshotDirty = true
    scheduleFrame()
  }

  const invalidateGeometry = (): void => {
    geometryDirty = true
    snapshotDirty = true
    scheduleFrame()
  }

  const start = (): void => {
    if (started) {
      return
    }
    started = true
    disposeHostEvents = attachRainOverlayHostEvents({
      terminal,
      xtermContainer,
      onWriteParsed: () => {
        contentSequence = (contentSequence + 1) >>> 0
        invalidateSnapshot()
      },
      onSnapshotChange: invalidateSnapshot,
      onGeometryChange: invalidateGeometry,
      onVisibilityChange: (focused) => {
        windowFocused = focused
        return focused ? invalidateSnapshot() : updateGate()
      },
      onIntersectionChange: (visible) => {
        intersecting = visible
        return visible ? invalidateGeometry() : updateGate()
      }
    })
    scheduleFrame()
  }

  const ensureEngine = (): void => {
    if (disposed || suspended || engine || creationGeneration === engineGeneration) {
      return
    }
    const generation = engineGeneration
    const creationCanvas = canvas
    creationGeneration = generation
    let factoryResult: ReturnType<RainOverlayEngineFactory>
    try {
      factoryResult = createEngine({ canvas: creationCanvas, paneId, terminal })
    } catch (error) {
      creationGeneration = null
      failClosed(error)
      return
    }

    void Promise.resolve(factoryResult)
      .then((createdEngine) => {
        if (creationGeneration === generation) {
          creationGeneration = null
        }
        if (!createdEngine) {
          if (!disposed && !suspended && generation === engineGeneration) {
            disposed = true
            disposeListeners()
            canvas.remove()
            settleReady(false)
          }
          return
        }
        if (disposed || suspended || generation !== engineGeneration || creationCanvas !== canvas) {
          createdEngine.dispose()
          return
        }
        engine = createdEngine
        start()
        scheduleFrame()
        settleReady(true)
      })
      .catch((error: unknown) => {
        if (creationGeneration === generation) {
          creationGeneration = null
        }
        if (disposed || suspended || generation !== engineGeneration || creationCanvas !== canvas) {
          return
        }
        failClosed(error)
      })
  }

  ensureEngine()

  return {
    ready,
    setSuspended(nextSuspended) {
      if (disposed || suspended === nextSuspended) {
        return
      }
      suspended = nextSuspended
      engineGeneration += 1
      if (suspended) {
        const shouldReplaceCanvas = engine !== null || creationGeneration !== null
        cancelFrame()
        releaseEngine()
        if (shouldReplaceCanvas) {
          replaceCanvas()
        }
      } else {
        snapshotDirty = true
        invalidateGeometry()
        ensureEngine()
      }
    },
    invalidate: invalidateSnapshot,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      engineGeneration += 1
      cancelFrame()
      disposeListeners()
      releaseEngine()
      canvas.remove()
      settleReady(false)
    }
  }
}
