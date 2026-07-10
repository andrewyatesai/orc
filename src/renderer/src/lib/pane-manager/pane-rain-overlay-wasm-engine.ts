import type { IDisposable, Terminal } from '@xterm/xterm'

import { RainOverlayCellPacker, readAtermRainCellAbi } from './pane-rain-overlay-cell-pack'
import type { AtermRainCellAbi } from './pane-rain-overlay-cell-pack'
import { RainColorPalette } from './pane-rain-overlay-colors'
import type {
  RainOverlayEngine,
  RainOverlaySnapshot,
  RainOverlayViewport
} from './pane-rain-overlay-types'
import { WebGlRainQuadRenderer } from './pane-rain-overlay-webgl'
import type { RainQuadRenderer } from './pane-rain-overlay-webgl'
import type { AtermEffectsWebModule, AtermRainOverlayBinding } from './pane-rain-overlay-wasm-types'
import { ATERM_RAIN_MAX_QUADS, ATERM_RAIN_QUAD_WORDS } from './pane-rain-overlay-wasm-types'
import { borrowWasmU32, borrowWasmU8 } from './pane-rain-overlay-wasm-memory'

const EMPTY_ROWS = new Uint16Array()
const VISIBILITY_FOCUSED = 0
const VISIBILITY_HIDDEN = 2

export type AtermWasmRainEngineDependencies = {
  readonly createRenderer?: (canvas: HTMLCanvasElement) => RainQuadRenderer
  readonly now?: () => number
}

type EngineOptions = {
  readonly canvas: HTMLCanvasElement
  readonly paneId: number
  readonly terminal: Terminal
  readonly wasm: AtermEffectsWebModule
  readonly dependencies?: AtermWasmRainEngineDependencies
}

function seedForPane(paneId: number): [number, number] {
  const low = Math.imul(paneId ^ 0xa7e2_11d3, 0x9e37_79b1) >>> 0
  const high = Math.imul(low ^ 0x85eb_ca6b, 0xc2b2_ae35) >>> 0
  return [low, high]
}

/** High-throughput adapter from Orca's authoritative xterm grid into aterm WASM. */
export class AtermWasmRainOverlayEngine implements RainOverlayEngine {
  private readonly binding: AtermRainOverlayBinding
  private readonly abi: AtermRainCellAbi
  private renderer!: RainQuadRenderer
  private readonly colors = new RainColorPalette()
  private readonly packer = new RainOverlayCellPacker()
  private readonly terminalDisposables: IDisposable[] = []
  private readonly now: () => number
  private motionQuery: MediaQueryList | null = null
  private viewport: RainOverlayViewport | null = null
  private cellWidth = 0
  private cellHeight = 0
  private lastSnapshot: RainOverlaySnapshot | null = null
  private rows: number
  private cols: number
  private revision = 0
  private contentSequence = 0
  private lastTimestampMs: number | null = null
  private atlasVersion: bigint | number | null = null
  private pendingKeyData: string | null = null
  private pendingKeyTime = 0
  private selectionDirty = false
  private visible = false
  private disposed = false

  constructor(private readonly options: EngineOptions) {
    const { canvas, paneId, terminal, wasm, dependencies } = options
    this.now = dependencies?.now ?? (() => performance.now())
    this.colors.update(terminal.options.theme)
    const [seedLow, seedHigh] = seedForPane(paneId)
    this.binding = new wasm.AtermRainOverlay(
      terminal.rows,
      terminal.cols,
      this.colors.background,
      this.colors.foreground,
      seedLow,
      seedHigh
    )
    this.rows = terminal.rows
    this.cols = terminal.cols
    try {
      this.renderer = (
        dependencies?.createRenderer ?? ((target) => new WebGlRainQuadRenderer(target))
      )(canvas)
      this.abi = readAtermRainCellAbi(this.binding)
      if (this.binding.quad_words() !== ATERM_RAIN_QUAD_WORDS) {
        throw new Error(`aterm rain quad ABI is ${this.binding.quad_words()} words, expected 12`)
      }
      // Literal output remains enabled in alternate-screen Codex/Claude sessions.
      this.binding.set_behavior(false, true, true, true)
      this.motionQuery =
        typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion)') : null
      this.binding.set_reduced_motion(this.motionQuery?.matches === true)
      this.installListeners()
    } catch (error) {
      this.teardown()
      throw error
    }
  }

  setVisible(visible: boolean): void {
    this.assertAlive()
    if (visible === this.visible) {
      return
    }
    this.visible = visible
    this.binding.set_visibility(visible ? VISIBILITY_FOCUSED : VISIBILITY_HIDDEN)
    if (!visible) {
      this.lastTimestampMs = null
      this.renderer.clear()
    }
  }

  resize(viewport: RainOverlayViewport): void {
    this.assertAlive()
    const cellWidth = Math.round(viewport.cellWidth * viewport.devicePixelRatio)
    const cellHeight = Math.round(viewport.cellHeight * viewport.devicePixelRatio)
    if (cellWidth <= 0 || cellHeight <= 0 || cellWidth > 0xffff || cellHeight > 0xffff) {
      throw new Error(`aterm rain cell geometry ${cellWidth}x${cellHeight} is invalid`)
    }
    this.viewport = viewport
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
    this.renderer.resize()
  }

  update(snapshot: RainOverlaySnapshot): void {
    this.assertAlive()
    const resized = snapshot.rows !== this.rows || snapshot.cols !== this.cols
    if (resized) {
      this.binding.resize_staging(snapshot.rows, snapshot.cols)
      this.rows = snapshot.rows
      this.cols = snapshot.cols
    }
    const themeChanged = this.colors.update(this.options.terminal.options.theme)
    if (themeChanged) {
      this.binding.set_theme(this.colors.background, this.colors.foreground)
    }
    const staging = borrowWasmU32(
      this.options.wasm.memory,
      this.binding.staging_ptr(),
      this.binding.staging_len_words()
    )
    this.packer.pack(
      snapshot,
      this.options.terminal,
      staging,
      this.colors,
      this.abi,
      !resized && !themeChanged
    )
    if (this.packer.changed) {
      this.revision = (this.revision + 1) >>> 0
    }
    this.contentSequence = (this.contentSequence + this.packer.contentCredit) >>> 0

    const buffer = this.options.terminal.buffer.active
    const displayOffset = Math.max(0, (buffer.baseY ?? snapshot.viewportY) - snapshot.viewportY)
    const isAltScreen =
      buffer.type === 'alternate' || buffer === this.options.terminal.buffer.alternate
    this.binding.set_live_state(snapshot.cursorY, snapshot.cursorX, displayOffset, isAltScreen)
    this.binding.set_hidden_cursor_rows(EMPTY_ROWS)
    this.binding.sync_snapshot(this.revision, this.contentSequence)
    this.lastSnapshot = snapshot
    this.selectionDirty = false
  }

  render(timestampMs: number): boolean {
    if (this.disposed || !this.visible || !this.viewport) {
      return false
    }
    if (this.selectionDirty && this.lastSnapshot) {
      this.update(this.lastSnapshot)
    }
    if (this.lastTimestampMs !== null) {
      const delta = Math.max(0, Math.min(250, timestampMs - this.lastTimestampMs))
      this.binding.advance_effects(delta)
    }
    this.lastTimestampMs = timestampMs
    this.binding.emit(this.cellWidth, this.cellHeight)

    const version = this.binding.atlas_version()
    if (version !== this.atlasVersion) {
      const bytes = this.binding.atlas_len()
      if (bytes > 0) {
        const atlas = borrowWasmU8(this.options.wasm.memory, this.binding.atlas_ptr(), bytes)
        this.renderer.uploadAtlas(atlas, this.binding.atlas_width(), this.binding.atlas_height())
      }
      this.atlasVersion = version
    }
    const words = this.binding.quads_len_words()
    if (words > ATERM_RAIN_MAX_QUADS * ATERM_RAIN_QUAD_WORDS) {
      throw new Error(`aterm emitted ${words} rain quad words above its ABI bound`)
    }
    const quads = borrowWasmU32(this.options.wasm.memory, this.binding.quads_ptr(), words)
    this.renderer.draw(quads)
    return this.binding.is_active()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.teardown()
  }

  private installListeners(): void {
    const terminal = this.options.terminal
    this.terminalDisposables.push(
      terminal.onKey(({ key, domEvent }) => {
        this.pendingKeyData = key
        this.pendingKeyTime = this.now()
        this.safeNote(() => this.binding.note_keystroke())
        if (
          terminal.buffer.active.type === 'alternate' &&
          (domEvent.key === 'PageUp' || domEvent.key === 'PageDown')
        ) {
          this.safeNote(() => this.binding.note_alt_scroll())
        }
      })
    )
    this.terminalDisposables.push(
      terminal.onData((data) => {
        const duplicate = data === this.pendingKeyData && this.now() - this.pendingKeyTime < 50
        this.pendingKeyData = null
        if (!duplicate) {
          this.safeNote(() => this.binding.note_keystroke())
        }
      })
    )
    this.terminalDisposables.push(
      terminal.onSelectionChange(() => {
        this.selectionDirty = true
      })
    )
    this.terminalDisposables.push(
      terminal.onScroll(() => {
        if (terminal.buffer.active.type === 'alternate') {
          this.safeNote(() => this.binding.note_alt_scroll())
        }
      })
    )
    this.motionQuery?.addEventListener('change', this.handleMotionChange)
  }

  private readonly handleMotionChange = (event: MediaQueryListEvent): void => {
    this.safeNote(() => this.binding.set_reduced_motion(event.matches))
  }

  private safeNote(note: () => void): void {
    if (this.disposed) {
      return
    }
    try {
      note()
    } catch (error) {
      console.warn('[terminal] aterm rain input hook failed closed', error)
      this.options.canvas.hidden = true
      this.dispose()
    }
  }

  private teardown(): void {
    for (const disposable of this.terminalDisposables.splice(0)) {
      try {
        disposable.dispose()
      } catch {
        // Optional art teardown cannot interrupt terminal input or pane disposal.
      }
    }
    try {
      this.motionQuery?.removeEventListener('change', this.handleMotionChange)
    } catch {
      // Continue releasing the remaining engine-owned resources.
    }
    this.lastSnapshot = null
    try {
      this.renderer?.dispose()
    } catch {
      // Continue into wasm release even if the graphics driver rejects teardown.
    }
    try {
      this.binding.free()
    } catch {
      // A broken optional binding must not escape into xterm's event path.
    }
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error('aterm rain overlay is disposed')
    }
  }
}
