import type { Terminal } from '@xterm/xterm'

export const RAIN_COLOR_DEFAULT = 0
export const RAIN_COLOR_PALETTE = 0x01000000
export const RAIN_COLOR_RGB = 0x02000000
export const RAIN_COLOR_MODE_MASK = 0xff000000
export const RAIN_COLOR_VALUE_MASK = 0x00ffffff

export const RAIN_CELL_BOLD = 1 << 0
export const RAIN_CELL_DIM = 1 << 1
export const RAIN_CELL_ITALIC = 1 << 2
export const RAIN_CELL_UNDERLINE = 1 << 3
export const RAIN_CELL_INVERSE = 1 << 4
export const RAIN_CELL_INVISIBLE = 1 << 5
export const RAIN_CELL_STRIKETHROUGH = 1 << 6
export const RAIN_CELL_OVERLINE = 1 << 7

/**
 * A borrowed view of xterm's visible grid. Engines must consume it during
 * update(); its storage is reused after the next parsed terminal frame.
 */
export type RainOverlaySnapshot = {
  readonly sequence: number
  readonly contentSequence: number
  readonly cols: number
  readonly rows: number
  readonly viewportY: number
  readonly cursorX: number
  readonly cursorY: number
  readonly defaultForeground: string | null
  readonly defaultBackground: string | null
  readonly glyphs: readonly string[]
  readonly widths: Uint8Array
  /** Values use RAIN_COLOR_* mode bits plus a palette index or 0xRRGGBB. */
  readonly foreground: Uint32Array
  readonly background: Uint32Array
  readonly attributes: Uint8Array
}

export type RainOverlayViewport = {
  readonly cssWidth: number
  readonly cssHeight: number
  readonly pixelWidth: number
  readonly pixelHeight: number
  readonly devicePixelRatio: number
  readonly cellWidth: number
  readonly cellHeight: number
}

export type RainOverlayEngine = {
  setVisible(visible: boolean): void
  resize(viewport: RainOverlayViewport): void
  update(snapshot: RainOverlaySnapshot): void
  /** Return true only while another animation frame is required. */
  render(timestampMs: number): boolean
  dispose(): void
}

export type RainOverlayEngineFactory = (args: {
  readonly canvas: HTMLCanvasElement
  readonly paneId: number
  readonly terminal: Terminal
}) => RainOverlayEngine | null | Promise<RainOverlayEngine | null>

export type RainOverlayController = {
  readonly ready: Promise<boolean>
  setSuspended(suspended: boolean): void
  invalidate(): void
  dispose(): void
}
