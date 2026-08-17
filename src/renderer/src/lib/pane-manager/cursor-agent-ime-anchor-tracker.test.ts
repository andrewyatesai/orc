import { describe, expect, it } from 'vitest'
import type { IBuffer, IBufferCell, IBufferLine } from './aterm/terminal-types'
import { createCursorAgentImeAnchorTracker } from './cursor-agent-ime-anchor-tracker'

function makeLine(text: string, cols = 80): IBufferLine {
  const cells = Array.from(text).map((char) => ({ chars: char, width: 1 }))
  while (cells.length < cols) {
    cells.push({ chars: '', width: 1 })
  }
  return {
    isWrapped: false,
    length: cells.length,
    getCell: (column: number) => {
      const cell = cells[column]
      return cell
        ? ({ getWidth: () => cell.width, getChars: () => cell.chars } as IBufferCell)
        : undefined
    },
    translateToString: (trimRight = false, startColumn = 0, endColumn = cells.length) => {
      let result = ''
      for (let column = startColumn; column < endColumn; column++) {
        const cell = cells[column]
        if (!cell || cell.width === 0) {
          continue
        }
        result += cell.chars || ' '
      }
      return trimRight ? result.replace(/\s+$/, '') : result
    }
  } as IBufferLine
}

function makeBuffer(lines: string[]): IBuffer {
  const bufferLines = lines.map((line) => makeLine(line))
  return {
    type: 'normal' as const,
    baseY: 0,
    cursorX: 0,
    cursorY: 0,
    getLine: (row: number) => bufferLines[row]
  } as IBuffer
}

const withHeader = makeBuffer(['', '  Cursor Agent', '', '  → hello', ''])
const headerScrolledAway = makeBuffer(['transcript', '', '  → hello', '', ''])

describe('createCursorAgentImeAnchorTracker', () => {
  it('latches "known" so typed follow-ups anchor after the header scrolls away', () => {
    const resolve = createCursorAgentImeAnchorTracker()

    expect(resolve({ buffer: withHeader, rows: 5, cols: 80, cursorX: 0, cursorY: 4 })).toEqual({
      row: 3,
      column: 9
    })
    // Header is gone, but the pane was already recognized: typed input still anchors.
    expect(
      resolve({ buffer: headerScrolledAway, rows: 5, cols: 80, cursorX: 0, cursorY: 4 })
    ).toEqual({ row: 2, column: 9 })
  })

  it('does not anchor typed input on a fresh tracker that never saw the header', () => {
    const resolve = createCursorAgentImeAnchorTracker()

    expect(
      resolve({ buffer: headerScrolledAway, rows: 5, cols: 80, cursorX: 0, cursorY: 4 })
    ).toBeNull()
  })
})
