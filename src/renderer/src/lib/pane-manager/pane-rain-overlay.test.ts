// @vitest-environment happy-dom
import type { IBufferCell, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachRainOverlay } from './pane-rain-overlay'
import type {
  RainOverlayEngine,
  RainOverlaySnapshot,
  RainOverlayViewport
} from './pane-rain-overlay-types'

type TerminalEvents = {
  writeParsed: () => void
  resize: () => void
  scroll: () => void
}

type EngineHarness = RainOverlayEngine & {
  visibility: ReturnType<typeof vi.fn<(visible: boolean) => void>>
  resizes: ReturnType<typeof vi.fn<(viewport: RainOverlayViewport) => void>>
  updates: ReturnType<typeof vi.fn<(snapshot: RainOverlaySnapshot) => void>>
  renders: ReturnType<typeof vi.fn<(timestampMs: number) => boolean>>
  teardown: ReturnType<typeof vi.fn<() => void>>
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this)
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this)
  }

  trigger(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    )
  }
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  }
}

function cell(character: string): IBufferCell {
  return {
    getWidth: () => 1,
    getChars: () => character,
    getCode: () => character.codePointAt(0) ?? 0,
    getFgColorMode: () => 0,
    getBgColorMode: () => 0,
    getFgColor: () => 0,
    getBgColor: () => 0,
    isAttributeDefault: () => true,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => false,
    isBgPalette: () => false,
    isFgDefault: () => true,
    isBgDefault: () => true,
    isInverse: () => 0,
    isBold: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInvisible: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
    getUnderlineColor: () => 0,
    getUnderlineColorMode: () => 0,
    isUnderlineColorRGB: () => false,
    isUnderlineColorPalette: () => false,
    isUnderlineColorDefault: () => true,
    getUnderlineStyle: () => 0,
    attributesEquals: () => true
  }
}

function makeTerminal(events: Partial<TerminalEvents>): {
  terminal: Terminal
  screen: HTMLElement
  disposedSubscriptions: ReturnType<typeof vi.fn>[]
} {
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  element.appendChild(screen)
  const cells = ['C', 'o', 'd', 'e', 'x', ' ', 'O', 'K'].map(cell)
  const disposedSubscriptions: ReturnType<typeof vi.fn>[] = []

  const subscribe = (name: keyof TerminalEvents, callback: () => void) => {
    events[name] = callback
    const dispose = vi.fn()
    disposedSubscriptions.push(dispose)
    return { dispose }
  }

  return {
    terminal: {
      cols: 4,
      rows: 2,
      element,
      options: { theme: { foreground: '#eee', background: '#111' } },
      buffer: {
        active: {
          viewportY: 0,
          cursorX: 2,
          cursorY: 1,
          getLine: (row: number) => ({
            getCell: (column: number) => cells[row * 4 + column]
          })
        }
      },
      onWriteParsed: (callback: () => void) => subscribe('writeParsed', callback),
      onResize: (callback: () => void) => subscribe('resize', callback),
      onScroll: (callback: () => void) => subscribe('scroll', callback)
    } as unknown as Terminal,
    screen,
    disposedSubscriptions
  }
}

function makeEngine(): EngineHarness {
  const visibility = vi.fn<(visible: boolean) => void>()
  const resizes = vi.fn<(viewport: RainOverlayViewport) => void>()
  const updates = vi.fn<(snapshot: RainOverlaySnapshot) => void>()
  const renders = vi.fn<(timestampMs: number) => boolean>().mockReturnValue(false)
  const teardown = vi.fn<() => void>()
  return {
    visibility,
    resizes,
    updates,
    renders,
    teardown,
    setVisible: visibility,
    resize: resizes,
    update: updates,
    render: renders,
    dispose: teardown
  }
}

describe('attachRainOverlay', () => {
  let focused = true
  let visibilityState: DocumentVisibilityState = 'visible'
  let nextFrameId = 1
  let frames = new Map<number, FrameRequestCallback>()

  beforeEach(() => {
    focused = true
    visibilityState = 'visible'
    frames = new Map()
    nextFrameId = 1
    MockResizeObserver.instances = []
    MockIntersectionObserver.instances = []
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  function flushFrame(timestampMs = 16): void {
    const scheduled = Array.from(frames.values())
    frames.clear()
    for (const callback of scheduled) {
      callback(timestampMs)
    }
  }

  function mountTerminal(): {
    host: HTMLElement
    events: Partial<TerminalEvents>
    terminal: Terminal
    screen: HTMLElement
    disposedSubscriptions: ReturnType<typeof vi.fn>[]
  } {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const events: Partial<TerminalEvents> = {}
    const terminalHarness = makeTerminal(events)
    host.appendChild(terminalHarness.terminal.element!)
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 440, 220))
    vi.spyOn(terminalHarness.screen, 'getBoundingClientRect').mockReturnValue(
      rect(20, 30, 400, 200)
    )
    return { host, events, ...terminalHarness }
  }

  it('coalesces parsed writes into one authoritative visible-grid frame', async () => {
    const harness = mountTerminal()
    const engine = makeEngine()
    const controller = attachRainOverlay({
      paneId: 9,
      terminal: harness.terminal,
      xtermContainer: harness.host,
      createEngine: ({ canvas, paneId }) => {
        expect(canvas.className).toBe('aterm-rain-overlay')
        expect(canvas.style.pointerEvents).toBe('none')
        expect(paneId).toBe(9)
        return engine
      }
    })

    await expect(controller.ready).resolves.toBe(true)
    expect(frames.size).toBe(1)
    for (let count = 0; count < 40; count += 1) {
      harness.events.writeParsed?.()
    }
    expect(frames.size).toBe(1)

    flushFrame(25)

    expect(engine.resizes).toHaveBeenCalledOnce()
    expect(engine.resizes).toHaveBeenCalledWith(
      expect.objectContaining({ pixelWidth: 800, pixelHeight: 400, cellWidth: 100 })
    )
    expect(engine.updates).toHaveBeenCalledOnce()
    const snapshot = engine.updates.mock.calls[0]?.[0]
    expect(snapshot?.glyphs.join('')).toBe('Codex OK')
    expect(snapshot?.contentSequence).toBe(40)
    expect(engine.renders).toHaveBeenCalledWith(25)
    expect(frames.size).toBe(0)

    controller.dispose()
  })

  it('keeps at most one animation frame and gates blur, visibility, suspend, and resize', async () => {
    const harness = mountTerminal()
    const engine = makeEngine()
    engine.renders.mockReturnValue(true)
    const controller = attachRainOverlay({
      paneId: 1,
      terminal: harness.terminal,
      xtermContainer: harness.host,
      createEngine: () => engine
    })
    await controller.ready

    flushFrame()
    expect(frames.size).toBe(1)
    harness.events.writeParsed?.()
    harness.events.writeParsed?.()
    MockResizeObserver.instances[0]?.trigger()
    MockResizeObserver.instances[0]?.trigger()
    expect(frames.size).toBe(1)

    focused = false
    window.dispatchEvent(new Event('blur'))
    expect(frames.size).toBe(0)
    expect(engine.visibility).toHaveBeenLastCalledWith(false)

    focused = true
    window.dispatchEvent(new Event('focus'))
    expect(frames.size).toBe(1)
    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)

    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(1)
    controller.setSuspended(true)
    expect(frames.size).toBe(0)
    controller.setSuspended(false)
    await vi.waitFor(() => expect(frames.size).toBe(1))

    MockIntersectionObserver.instances[0]?.trigger(false)
    expect(frames.size).toBe(0)
    MockIntersectionObserver.instances[0]?.trigger(true)
    expect(frames.size).toBe(1)
    controller.dispose()
  })

  it('defers engine construction while suspended and recreates its canvas on resume', async () => {
    const harness = mountTerminal()
    const firstEngine = makeEngine()
    const secondEngine = makeEngine()
    const factory = vi.fn().mockReturnValueOnce(firstEngine).mockReturnValueOnce(secondEngine)
    const controller = attachRainOverlay({
      paneId: 7,
      terminal: harness.terminal,
      xtermContainer: harness.host,
      createEngine: factory,
      initiallySuspended: true
    })
    const initialCanvas = harness.host.querySelector('canvas')

    expect(factory).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)

    controller.setSuspended(false)
    await expect(controller.ready).resolves.toBe(true)
    expect(factory).toHaveBeenCalledOnce()
    expect(factory.mock.calls[0]?.[0].canvas).toBe(initialCanvas)
    expect(frames.size).toBe(1)

    controller.setSuspended(true)
    const resumedCanvas = harness.host.querySelector('canvas')
    expect(firstEngine.visibility).toHaveBeenLastCalledWith(false)
    expect(firstEngine.teardown).toHaveBeenCalledOnce()
    expect(resumedCanvas).not.toBe(initialCanvas)
    expect(frames.size).toBe(0)

    controller.setSuspended(false)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    expect(factory.mock.calls[1]?.[0].canvas).toBe(resumedCanvas)
    expect(frames.size).toBe(1)

    controller.dispose()
    expect(secondEngine.teardown).toHaveBeenCalledOnce()
  })

  it('disposes a stale async engine generation without attaching it after resume', async () => {
    const harness = mountTerminal()
    const staleEngine = makeEngine()
    const currentEngine = makeEngine()
    const pending: ((engine: RainOverlayEngine) => void)[] = []
    const canvases: HTMLCanvasElement[] = []
    const controller = attachRainOverlay({
      paneId: 8,
      terminal: harness.terminal,
      xtermContainer: harness.host,
      createEngine: ({ canvas }) => {
        canvases.push(canvas)
        return new Promise((resolve) => pending.push(resolve))
      }
    })

    expect(pending).toHaveLength(1)
    controller.setSuspended(true)
    controller.setSuspended(false)
    expect(pending).toHaveLength(2)
    expect(canvases[1]).not.toBe(canvases[0])

    pending[0]?.(staleEngine)
    await vi.waitFor(() => expect(staleEngine.teardown).toHaveBeenCalledOnce())
    expect(frames.size).toBe(0)

    pending[1]?.(currentEngine)
    await expect(controller.ready).resolves.toBe(true)
    expect(currentEngine.teardown).not.toHaveBeenCalled()
    expect(frames.size).toBe(1)

    controller.dispose()
    expect(currentEngine.teardown).toHaveBeenCalledOnce()
  })

  it('removes all optional resources on dispose and stays absent without an engine', async () => {
    const unavailable = mountTerminal()
    const unavailableController = attachRainOverlay({
      paneId: 1,
      terminal: unavailable.terminal,
      xtermContainer: unavailable.host,
      createEngine: () => null
    })
    await expect(unavailableController.ready).resolves.toBe(false)
    expect(unavailable.host.querySelector('canvas')).toBeNull()
    expect(unavailable.disposedSubscriptions).toHaveLength(0)

    const harness = mountTerminal()
    const engine = makeEngine()
    const controller = attachRainOverlay({
      paneId: 2,
      terminal: harness.terminal,
      xtermContainer: harness.host,
      createEngine: () => engine
    })
    await controller.ready
    controller.dispose()

    expect(frames.size).toBe(0)
    expect(harness.host.querySelector('canvas')).toBeNull()
    expect(harness.disposedSubscriptions).toHaveLength(3)
    for (const dispose of harness.disposedSubscriptions) {
      expect(dispose).toHaveBeenCalledOnce()
    }
    expect(MockResizeObserver.instances.at(-1)?.disconnect).toHaveBeenCalledOnce()
    expect(MockIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalledOnce()
    expect(engine.teardown).toHaveBeenCalledOnce()
  })

  it('disposes an engine that resolves after its pane has already closed', async () => {
    const harness = mountTerminal()
    const engine = makeEngine()
    let resolveEngine: ((engine: RainOverlayEngine) => void) | undefined
    const controller = attachRainOverlay({
      paneId: 3,
      terminal: harness.terminal,
      xtermContainer: harness.host,
      createEngine: () =>
        new Promise((resolve) => {
          resolveEngine = resolve
        })
    })

    controller.dispose()
    resolveEngine?.(engine)
    await expect(controller.ready).resolves.toBe(false)
    expect(engine.teardown).toHaveBeenCalledOnce()
    expect(harness.disposedSubscriptions).toHaveLength(0)
  })
})
