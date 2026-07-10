import type { IBufferCell, Terminal } from '@xterm/xterm'

import {
  RAIN_CELL_BOLD,
  RAIN_CELL_DIM,
  RAIN_CELL_INVERSE,
  RAIN_CELL_INVISIBLE,
  RAIN_CELL_ITALIC,
  RAIN_CELL_OVERLINE,
  RAIN_CELL_STRIKETHROUGH,
  RAIN_CELL_UNDERLINE,
  RAIN_COLOR_DEFAULT,
  RAIN_COLOR_PALETTE,
  RAIN_COLOR_RGB
} from './pane-rain-overlay-types'
import type { RainOverlaySnapshot } from './pane-rain-overlay-types'

type MutableSnapshot = {
  -readonly [Key in keyof Omit<RainOverlaySnapshot, 'glyphs'>]: RainOverlaySnapshot[Key]
} & { glyphs: string[] }

function encodeForeground(cell: IBufferCell): number {
  if (cell.isFgRGB()) {
    return RAIN_COLOR_RGB | cell.getFgColor()
  }
  if (cell.isFgPalette()) {
    return RAIN_COLOR_PALETTE | cell.getFgColor()
  }
  return RAIN_COLOR_DEFAULT
}

function encodeBackground(cell: IBufferCell): number {
  if (cell.isBgRGB()) {
    return RAIN_COLOR_RGB | cell.getBgColor()
  }
  if (cell.isBgPalette()) {
    return RAIN_COLOR_PALETTE | cell.getBgColor()
  }
  return RAIN_COLOR_DEFAULT
}

function encodeAttributes(cell: IBufferCell): number {
  let attributes = 0
  if (cell.isBold()) {
    attributes |= RAIN_CELL_BOLD
  }
  if (cell.isDim()) {
    attributes |= RAIN_CELL_DIM
  }
  if (cell.isItalic()) {
    attributes |= RAIN_CELL_ITALIC
  }
  if (cell.isUnderline()) {
    attributes |= RAIN_CELL_UNDERLINE
  }
  if (cell.isInverse()) {
    attributes |= RAIN_CELL_INVERSE
  }
  if (cell.isInvisible()) {
    attributes |= RAIN_CELL_INVISIBLE
  }
  if (cell.isStrikethrough()) {
    attributes |= RAIN_CELL_STRIKETHROUGH
  }
  if (cell.isOverline()) {
    attributes |= RAIN_CELL_OVERLINE
  }
  return attributes
}

export class RainOverlaySnapshotCollector {
  private snapshot: MutableSnapshot = {
    sequence: 0,
    contentSequence: 0,
    cols: 0,
    rows: 0,
    viewportY: 0,
    cursorX: 0,
    cursorY: 0,
    defaultForeground: null,
    defaultBackground: null,
    glyphs: [],
    widths: new Uint8Array(),
    foreground: new Uint32Array(),
    background: new Uint32Array(),
    attributes: new Uint8Array()
  }

  capture(terminal: Terminal, contentSequence: number): RainOverlaySnapshot {
    const cols = terminal.cols
    const rows = terminal.rows
    const cellCount = cols * rows
    this.ensureCapacity(cellCount)

    const buffer = terminal.buffer.active
    const viewportY = buffer.viewportY
    let scratchCell: IBufferCell | undefined

    for (let row = 0; row < rows; row += 1) {
      const line = buffer.getLine(viewportY + row)
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col
        const cell = line?.getCell(col, scratchCell)
        if (!cell) {
          this.clearCell(index)
          continue
        }
        scratchCell = cell
        this.snapshot.glyphs[index] = cell.getChars()
        this.snapshot.widths[index] = cell.getWidth()
        this.snapshot.foreground[index] = encodeForeground(cell)
        this.snapshot.background[index] = encodeBackground(cell)
        this.snapshot.attributes[index] = encodeAttributes(cell)
      }
    }

    this.snapshot.sequence += 1
    this.snapshot.contentSequence = contentSequence
    this.snapshot.cols = cols
    this.snapshot.rows = rows
    this.snapshot.viewportY = viewportY
    this.snapshot.cursorX = buffer.cursorX
    this.snapshot.cursorY = buffer.cursorY
    this.snapshot.defaultForeground = terminal.options.theme?.foreground ?? null
    this.snapshot.defaultBackground = terminal.options.theme?.background ?? null
    return this.snapshot
  }

  private ensureCapacity(cellCount: number): void {
    if (this.snapshot.widths.length === cellCount) {
      return
    }
    this.snapshot.glyphs = Array.from({ length: cellCount }, () => '')
    this.snapshot.widths = new Uint8Array(cellCount)
    this.snapshot.foreground = new Uint32Array(cellCount)
    this.snapshot.background = new Uint32Array(cellCount)
    this.snapshot.attributes = new Uint8Array(cellCount)
  }

  private clearCell(index: number): void {
    this.snapshot.glyphs[index] = ''
    this.snapshot.widths[index] = 1
    this.snapshot.foreground[index] = RAIN_COLOR_DEFAULT
    this.snapshot.background[index] = RAIN_COLOR_DEFAULT
    this.snapshot.attributes[index] = 0
  }
}
