// @vitest-environment happy-dom
import type { IBufferRange, Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RainOverlaySnapshot, RainOverlayViewport } from './pane-rain-overlay-types'
import {
  RAIN_CELL_BOLD,
  RAIN_CELL_INVERSE,
  RAIN_CELL_OVERLINE,
  RAIN_CELL_STRIKETHROUGH,
  RAIN_CELL_UNDERLINE,
  RAIN_COLOR_PALETTE,
  RAIN_COLOR_RGB
} from './pane-rain-overlay-types'
import { AtermWasmRainOverlayEngine } from './pane-rain-overlay-wasm-engine'
import { createAtermRainOverlayEngineFactory } from './pane-rain-overlay-wasm-factory'
import type { RainQuadRenderer } from './pane-rain-overlay-webgl'
import type {
  AtermEffectsWebModule,
  AtermRainOverlayConstructor
} from './pane-rain-overlay-wasm-types'

const DEFAULT_BG = 1
const WIDE = 2
const UNDERLINE = 4
const STRIKE = 8
const OVERLINE = 16
const SELECTED = 32
const OPAQUE = 0xffffffff
const memory = new WebAssembly.Memory({ initial: 2 })
class FakeBinding {
  static latest: FakeBinding
  rows: number
  cols: number
  syncs: [number, number][] = []
  liveStates: [number, number, number, boolean][] = []
  keystrokes = 0
  altScrolls = 0
  freed = false
  failKeystroke = false
  atlasVersion = 0n
  atlasLength = 0
  quadLength = 0

  constructor(rows: number, cols: number) {
    this.rows = rows
    this.cols = cols
    FakeBinding.latest = this
  }

  free(): void {
    this.freed = true
  }
  resize_staging(rows: number, cols: number): void {
    this.rows = rows
    this.cols = cols
  }
  cell_words = (): number => 4
  cell_flag_default_background = (): number => DEFAULT_BG
  cell_flag_wide_continuation = (): number => WIDE
  cell_flag_underline = (): number => UNDERLINE
  cell_flag_strikethrough = (): number => STRIKE
  cell_flag_overline = (): number => OVERLINE
  cell_flag_selected = (): number => SELECTED
  cell_flag_inline_image = (): number => 64
  opaque_scalar = (): number => OPAQUE
  staging_ptr = (): number => 0
  staging_len_words = (): number => this.rows * this.cols * 4
  set_live_state(row: number, col: number, offset: number, alt: boolean): void {
    this.liveStates.push([row, col, offset, alt])
  }
  set_hidden_cursor_rows(): void {}
  sync_snapshot(revision: number, content: number): number {
    this.syncs.push([revision, content])
    return 2
  }
  advance_effects(): void {}
  emit(): bigint {
    return 1n
  }
  is_active = (): boolean => true
  note_keystroke(): void {
    if (this.failKeystroke) {
      throw new Error('injected note failure')
    }
    this.keystrokes += 1
  }
  note_bell(): void {}
  note_alt_scroll(): void {
    this.altScrolls += 1
  }
  note_exit_status(): void {}
  set_enabled(): void {}
  set_visibility(): void {}
  set_reduced_motion(): void {}
  set_theme(): void {}
  set_rate(): void {}
  set_alpha(): void {}
  set_hue(): void {}
  set_behavior(): void {}
  set_seed(): void {}
  quad_words = (): number => 12
  quads_ptr = (): number => 32_768
  quads_len_words = (): number => this.quadLength
  atlas_ptr = (): number => 40_000
  atlas_len = (): number => this.atlasLength
  atlas_width = (): number => 2
  atlas_height = (): number => 2
  atlas_version = (): bigint => this.atlasVersion
}

type EventHarness = {
  key?: (event: { key: string; domEvent: KeyboardEvent }) => void
  data?: (data: string) => void
  selection?: () => void
  scroll?: () => void
  disposed: number
}

function terminalHarness(cols = 5): {
  terminal: Terminal
  events: EventHarness
  active: { type: 'normal' | 'alternate'; baseY: number; viewportY: number }
  setSelection(range: IBufferRange | undefined): void
} {
  const events: EventHarness = { disposed: 0 }
  const active: { type: 'normal' | 'alternate'; baseY: number; viewportY: number } = {
    type: 'normal',
    baseY: 9,
    viewportY: 6
  }
  const alternate = { type: 'alternate' as const, baseY: 0, viewportY: 0 }
  let selection: IBufferRange | undefined
  const subscribe = <T>(
    key: keyof Pick<EventHarness, 'key' | 'data' | 'selection' | 'scroll'>,
    fn: T
  ) => {
    Object.assign(events, { [key]: fn })
    return { dispose: () => (events.disposed += 1) }
  }
  const terminal = {
    rows: 1,
    cols,
    options: {
      drawBoldTextInBrightColors: true,
      theme: {
        foreground: '#d0d0d0',
        background: '#101010',
        red: '#880000',
        brightRed: '#ff3333'
      }
    },
    buffer: { active, normal: active, alternate },
    hasSelection: () => selection !== undefined,
    getSelectionPosition: () => selection,
    onKey: (fn: EventHarness['key']) => subscribe('key', fn),
    onData: (fn: EventHarness['data']) => subscribe('data', fn),
    onSelectionChange: (fn: EventHarness['selection']) => subscribe('selection', fn),
    onScroll: (fn: EventHarness['scroll']) => subscribe('scroll', fn)
  } as unknown as Terminal
  return { terminal, events, active, setSelection: (next) => (selection = next) }
}

function snapshot(
  glyphs: string[],
  widths = new Uint8Array(glyphs.length).fill(1)
): RainOverlaySnapshot {
  return {
    sequence: 1,
    contentSequence: 0,
    cols: glyphs.length,
    rows: 1,
    viewportY: 6,
    cursorX: 2,
    cursorY: 0,
    defaultForeground: '#d0d0d0',
    defaultBackground: '#101010',
    glyphs,
    widths,
    foreground: new Uint32Array(glyphs.length),
    background: new Uint32Array(glyphs.length),
    attributes: new Uint8Array(glyphs.length)
  }
}

function rendererHarness(): RainQuadRenderer & {
  atlas?: Uint8Array
  quads?: Uint32Array
  atlasUploads: number
  disposed: boolean
} {
  return {
    resize: vi.fn(),
    uploadAtlas(bytes) {
      this.atlas = bytes
      this.atlasUploads += 1
    },
    draw(quads) {
      this.quads = quads
    },
    clear: vi.fn(),
    dispose() {
      this.disposed = true
    },
    atlasUploads: 0,
    disposed: false
  }
}

function fakeModule(): AtermEffectsWebModule {
  return {
    memory,
    AtermRainOverlay: FakeBinding as unknown as AtermRainOverlayConstructor
  } satisfies AtermEffectsWebModule
}

function createEngine(terminal: Terminal, renderer: RainQuadRenderer): AtermWasmRainOverlayEngine {
  return new AtermWasmRainOverlayEngine({
    canvas: document.createElement('canvas'),
    paneId: 7,
    terminal,
    wasm: fakeModule(),
    dependencies: { createRenderer: () => renderer, now: () => 10 }
  })
}

const viewport: RainOverlayViewport = {
  cssWidth: 50,
  cssHeight: 20,
  pixelWidth: 100,
  pixelHeight: 40,
  devicePixelRatio: 2,
  cellWidth: 10,
  cellHeight: 20
}

describe('AtermWasmRainOverlayEngine', () => {
  beforeEach(() => new Uint8Array(memory.buffer).fill(0))

  it('packs literal, wide, attributed, explicit-background, and selected cells', () => {
    const harness = terminalHarness()
    harness.setSelection({ start: { x: 4, y: 6 }, end: { x: 5, y: 6 } })
    const engine = createEngine(harness.terminal, rendererHarness())
    const frame = snapshot(['A', '猫', '', 'e\u0301', 'X'], new Uint8Array([1, 2, 0, 1, 1]))
    frame.foreground[0] = RAIN_COLOR_PALETTE | 1
    frame.background[1] = RAIN_COLOR_RGB | 0x101010
    frame.attributes[0] = RAIN_CELL_BOLD | RAIN_CELL_UNDERLINE
    frame.attributes[3] = RAIN_CELL_STRIKETHROUGH | RAIN_CELL_OVERLINE
    frame.attributes[4] = RAIN_CELL_INVERSE
    engine.update(frame)

    const words = new Uint32Array(memory.buffer, 0, 20)
    expect(Array.from(words.slice(0, 4))).toEqual([65, 0xff3333, 0x101010, DEFAULT_BG | UNDERLINE])
    expect(words[4]).toBe(OPAQUE)
    expect(words[7] & (WIDE | DEFAULT_BG)).toBe(WIDE)
    expect(words[8]).toBe(OPAQUE)
    expect(words[11] & WIDE).toBe(WIDE)
    expect(words[12]).toBe(OPAQUE)
    expect(words[15] & (STRIKE | OVERLINE)).toBe(STRIKE | OVERLINE)
    expect(words[19] & SELECTED).toBe(SELECTED)
    expect(words[19] & DEFAULT_BG).toBe(0)
    engine.dispose()
  })

  it('credits actual changed cells, deduplicates onKey/onData, and passes live TUI state', () => {
    const harness = terminalHarness(4)
    const engine = createEngine(harness.terminal, rendererHarness())
    engine.update(snapshot(['a', 'a', 'a', 'a']))
    harness.events.key?.({ key: 'b', domEvent: new KeyboardEvent('keydown') })
    harness.events.data?.('b')
    engine.update(snapshot(['b', 'a', 'a', 'a']))
    engine.update(snapshot(['c', 'd', 'e', 'f']))

    expect(FakeBinding.latest.keystrokes).toBe(1)
    expect(FakeBinding.latest.syncs.map((entry) => entry[1])).toEqual([0, 1, 5])
    expect(FakeBinding.latest.liveStates.at(-1)).toEqual([0, 2, 3, false])
    harness.setSelection({ start: { x: 0, y: 6 }, end: { x: 1, y: 6 } })
    engine.update(snapshot(['c', 'd', 'e', 'f']))
    expect(FakeBinding.latest.syncs.at(-1)?.[1]).toBe(5)
    harness.active.type = 'alternate'
    harness.events.scroll?.()
    engine.update(snapshot(['c', 'd', 'e', 'f']))
    expect(FakeBinding.latest.altScrolls).toBe(1)
    expect(FakeBinding.latest.liveStates.at(-1)).toEqual([0, 2, 3, true])
    engine.dispose()
  })

  it('borrows packed output, caches the atlas upload, and disposes every owned resource', () => {
    const harness = terminalHarness(1)
    const renderer = rendererHarness()
    const engine = createEngine(harness.terminal, renderer)
    new Uint32Array(memory.buffer, 32_768, 12).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 0xabcdef, 200, 0])
    new Uint8Array(memory.buffer, 40_000, 16).fill(255)
    FakeBinding.latest.quadLength = 12
    FakeBinding.latest.atlasLength = 16
    FakeBinding.latest.atlasVersion = 1n
    engine.setVisible(true)
    engine.resize(viewport)
    engine.update(snapshot(['R']))
    expect(engine.render(16)).toBe(true)
    expect(engine.render(32)).toBe(true)

    expect(renderer.quads?.buffer).toBe(memory.buffer)
    expect(renderer.quads?.[9]).toBe(0xabcdef)
    expect(renderer.atlas?.buffer).toBe(memory.buffer)
    expect(renderer.atlasUploads).toBe(1)
    engine.dispose()
    expect(harness.events.disposed).toBe(4)
    expect(renderer.disposed).toBe(true)
    expect(FakeBinding.latest.freed).toBe(true)
  })

  it('fails closed when an asynchronous terminal input hook rejects the optional effect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const harness = terminalHarness(1)
    const renderer = rendererHarness()
    createEngine(harness.terminal, renderer)
    FakeBinding.latest.failKeystroke = true

    expect(() => harness.events.data?.('paste')).not.toThrow()
    expect(harness.events.disposed).toBe(4)
    expect(renderer.disposed).toBe(true)
    expect(FakeBinding.latest.freed).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('loads an injected generated module once for multiple pane engines', async () => {
    const load = vi.fn(() => fakeModule())
    const factory = createAtermRainOverlayEngineFactory(load, {
      createRenderer: () => rendererHarness()
    })
    const first = terminalHarness(1)
    const second = terminalHarness(1)
    const engineA = await factory({
      canvas: document.createElement('canvas'),
      paneId: 1,
      terminal: first.terminal
    })
    const engineB = await factory({
      canvas: document.createElement('canvas'),
      paneId: 2,
      terminal: second.terminal
    })

    expect(load).toHaveBeenCalledOnce()
    engineA?.dispose()
    engineB?.dispose()
  })
})
