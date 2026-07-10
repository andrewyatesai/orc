import type { IBufferRange, Terminal } from '@xterm/xterm'

import type { RainColorPalette } from './pane-rain-overlay-colors'
import {
  RAIN_CELL_BOLD,
  RAIN_CELL_INVERSE,
  RAIN_CELL_INVISIBLE,
  RAIN_CELL_OVERLINE,
  RAIN_CELL_STRIKETHROUGH,
  RAIN_CELL_UNDERLINE
} from './pane-rain-overlay-types'
import type { RainOverlaySnapshot } from './pane-rain-overlay-types'
import type { AtermRainOverlayBinding } from './pane-rain-overlay-wasm-types'
import { ATERM_RAIN_CELL_WORDS } from './pane-rain-overlay-wasm-types'

export type AtermRainCellAbi = {
  readonly defaultBackground: number
  readonly wide: number
  readonly underline: number
  readonly strikethrough: number
  readonly overline: number
  readonly selected: number
  readonly opaqueScalar: number
}

export function readAtermRainCellAbi(binding: AtermRainOverlayBinding): AtermRainCellAbi {
  if (binding.cell_words() !== ATERM_RAIN_CELL_WORDS) {
    throw new Error(`aterm rain cell ABI is ${binding.cell_words()} words, expected 4`)
  }
  return {
    defaultBackground: binding.cell_flag_default_background(),
    wide: binding.cell_flag_wide_continuation(),
    underline: binding.cell_flag_underline(),
    strikethrough: binding.cell_flag_strikethrough(),
    overline: binding.cell_flag_overline(),
    selected: binding.cell_flag_selected(),
    opaqueScalar: binding.opaque_scalar()
  }
}

function comparePosition(x: number, y: number, otherX: number, otherY: number): number {
  return y === otherY ? x - otherX : y - otherY
}

function selectionContains(selection: IBufferRange | undefined, x: number, y: number): boolean {
  if (!selection) {
    return false
  }
  let start = selection.start
  let end = selection.end
  if (comparePosition(start.x, start.y, end.x, end.y) > 0) {
    const swap = start
    start = end
    end = swap
  }
  return comparePosition(x, y, start.x, start.y) >= 0 && comparePosition(x, y, end.x, end.y) < 0
}

function singleScalar(glyph: string, opaqueScalar: number): number {
  const scalar = glyph.codePointAt(0)
  if (scalar === undefined) {
    return 0
  }
  const scalarLength = scalar > 0xffff ? 2 : 1
  return glyph.length === scalarLength ? scalar : opaqueScalar
}

/** Packs directly into wasm staging while retaining only one fixed-width comparison buffer. */
export class RainOverlayCellPacker {
  changed = false
  contentCredit = 0
  private previous = new Uint32Array()
  private initialized = false

  pack(
    snapshot: RainOverlaySnapshot,
    terminal: Terminal,
    staging: Uint32Array,
    colors: RainColorPalette,
    abi: AtermRainCellAbi,
    countContent: boolean
  ): void {
    const expectedWords = snapshot.rows * snapshot.cols * ATERM_RAIN_CELL_WORDS
    if (staging.length !== expectedWords) {
      throw new Error(`aterm staging has ${staging.length} words, expected ${expectedWords}`)
    }
    const expectedCells = snapshot.rows * snapshot.cols
    if (
      snapshot.glyphs.length !== expectedCells ||
      snapshot.widths.length !== expectedCells ||
      snapshot.foreground.length !== expectedCells ||
      snapshot.background.length !== expectedCells ||
      snapshot.attributes.length !== expectedCells
    ) {
      throw new Error('xterm rain snapshot arrays do not match its viewport')
    }
    const resized = this.previous.length !== expectedWords
    if (resized) {
      this.previous = new Uint32Array(expectedWords)
      this.initialized = false
    }
    this.changed = resized
    this.contentCredit = 0
    const selection = terminal.hasSelection() ? terminal.getSelectionPosition() : undefined
    const boldBright = terminal.options.drawBoldTextInBrightColors !== false

    for (let index = 0; index < snapshot.glyphs.length; index += 1) {
      const attributes = snapshot.attributes[index] ?? 0
      const width = snapshot.widths[index] ?? 1
      const column = index % snapshot.cols
      const wide = width !== 1 || (column > 0 && snapshot.widths[index - 1]! > 1)
      let scalar = singleScalar(snapshot.glyphs[index] ?? '', abi.opaqueScalar)
      if (wide || (attributes & RAIN_CELL_INVISIBLE) !== 0) {
        scalar = abi.opaqueScalar
      }

      const useBright = boldBright && (attributes & RAIN_CELL_BOLD) !== 0
      let foreground = colors.resolve(snapshot.foreground[index] ?? 0, true, useBright)
      let background = colors.resolve(snapshot.background[index] ?? 0, false, false)
      const inverse = (attributes & RAIN_CELL_INVERSE) !== 0
      if (inverse) {
        const swap = foreground
        foreground = background
        background = swap
      }

      let flags = 0
      // Inverse paints the semantic foreground in the background plane, so it
      // is never the terminal's semantic default background even when RGBs match.
      const semanticDefaultBackground = !inverse && (snapshot.background[index] ?? 0) === 0
      if (semanticDefaultBackground) {
        flags |= abi.defaultBackground
      }
      if (wide) {
        flags |= abi.wide
      }
      if ((attributes & RAIN_CELL_UNDERLINE) !== 0) {
        flags |= abi.underline
      }
      if ((attributes & RAIN_CELL_STRIKETHROUGH) !== 0) {
        flags |= abi.strikethrough
      }
      if ((attributes & RAIN_CELL_OVERLINE) !== 0) {
        flags |= abi.overline
      }
      const row = Math.floor(index / snapshot.cols)
      const col = column
      // xterm 6.1 returns zero-based, end-exclusive buffer coordinates here.
      if (selectionContains(selection, col, snapshot.viewportY + row)) {
        flags |= abi.selected
      }

      const offset = index * ATERM_RAIN_CELL_WORDS
      const priorFlags = this.previous[offset + 3] ?? 0
      const contentChanged =
        scalar !== this.previous[offset] ||
        foreground !== this.previous[offset + 1] ||
        background !== this.previous[offset + 2] ||
        (flags & ~abi.selected) !== (priorFlags & ~abi.selected)
      const cellChanged = contentChanged || flags !== priorFlags
      if (this.initialized && countContent && contentChanged && this.contentCredit < 32) {
        this.contentCredit += 1
      }
      this.changed ||= cellChanged
      staging[offset] = this.previous[offset] = scalar
      staging[offset + 1] = this.previous[offset + 1] = foreground
      staging[offset + 2] = this.previous[offset + 2] = background
      staging[offset + 3] = this.previous[offset + 3] = flags
    }
    this.initialized = true
  }
}
