// Exercises the REAL napi addon end to end: real SGR sequences written to a
// real engine must come back out as styled runs whose colours are the ones a
// viewer would see, and whose attribute bits say why.
//
// A synthetic frame would prove the marshalling and nothing else. The point of
// this file is that the engine path — parse, resolve colours, coalesce runs,
// cross napi — actually works on bytes a program would really emit, and that the
// keystone question ("which row is highlighted?") is answerable from the result.
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { buildTerminalScreenResult } from '../runtime/terminal-screen'
import type { EmulatorStyledFrameRequest } from './emulator-styled-frame'

const COMPACT: EmulatorStyledFrameRequest = {
  detail: 'compact',
  fromRow: 0,
  rowCount: 0,
  maxRuns: 0
}

function emulator(opts: { cols?: number; rows?: number } = {}): HeadlessEmulator {
  return new HeadlessEmulator({ cols: opts.cols ?? 40, rows: opts.rows ?? 6, scrollback: 1000 })
}

function frameOf(term: HeadlessEmulator, request: EmulatorStyledFrameRequest = COMPACT) {
  const read = term.styledFrame(request)
  if (read.outcome !== 'frame') {
    throw new Error(`expected a frame, got ${read.outcome}`)
  }
  return read.frame
}

describe('HeadlessEmulator.styledFrame', () => {
  it('coalesces a plain row into one run and trims the blank tail', () => {
    const term = emulator()
    term.writeSync('hello')
    const frame = frameOf(term)
    expect({ rows: frame.rows, cols: frame.cols }).toEqual({ rows: 6, cols: 40 })
    expect(frame.grid[0].runs).toHaveLength(1)
    expect(frame.grid[0].runs[0]).toMatchObject({ col: 0, cols: 5, text: 'hello' })
    expect(frame.grid[0].runs[0].fg).toMatch(/^#[0-9a-f]{6}$/)
    expect(frame.grid[1].runs).toEqual([])
    term.dispose()
  })

  it('reports an inverse highlight as BOTH swapped colours and the raw bit', () => {
    const term = emulator()
    term.writeSync('plain\r\n\x1b[7mpicked\x1b[0m')
    const frame = frameOf(term)
    const plain = frame.grid[0].runs[0]
    const picked = frame.grid[1].runs[0]
    expect(picked.attrs).toContain('v')
    // What a viewer sees, resolved by the engine — the answer to "which row is
    // selected" for a driver that reasons about pixels rather than SGR.
    expect(picked.fg).toBe(plain.bg)
    expect(picked.bg).toBe(plain.fg)
    term.dispose()
  })

  it('resolves a truecolor run to the exact hex a viewer would see', () => {
    const term = emulator()
    term.writeSync('ab\x1b[38;2;255;0;0m\x1b[48;2;0;0;255mCD\x1b[0m')
    const runs = frameOf(term).grid[0].runs
    expect(runs).toHaveLength(2)
    expect(runs[1]).toMatchObject({ col: 2, text: 'CD', fg: '#ff0000', bg: '#0000ff' })
    term.dispose()
  })

  it('carries the cursor position, visibility and shape', () => {
    const term = emulator()
    term.writeSync('\x1b[3;7H\x1b[5 q')
    expect(frameOf(term).cursor).toEqual({
      row: 2,
      col: 6,
      visible: true,
      style: 'blinking-bar'
    })
    term.writeSync('\x1b[?25l')
    const hidden = frameOf(term).cursor
    // A hidden cursor still has a position: a TUI hides it while repainting.
    expect(hidden).toMatchObject({ visible: false, row: 2, col: 6 })
    term.dispose()
  })

  it('reports the modes that change what a keystroke means', () => {
    const term = emulator()
    term.writeSync('\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[>1u')
    const modes = frameOf(term).modes
    expect(modes).toMatchObject({
      alternateScreen: true,
      applicationCursor: true,
      bracketedPaste: true,
      mouseTracking: 'any',
      sgrMouse: true,
      kittyKeyboardFlags: 1
    })
    term.dispose()
  })

  it('pads every row to the grid width at full detail and attaches OSC-8 targets', () => {
    const term = emulator({ cols: 20, rows: 3 })
    term.writeSync('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')
    const frame = frameOf(term, { ...COMPACT, detail: 'full' })
    for (const row of frame.grid) {
      expect(row.runs.reduce((total, run) => total + run.cols, 0)).toBe(20)
    }
    const linked = frame.grid[0].runs.find((run) => run.hyperlink)
    expect(linked?.text).toBe('link')
    expect(linked?.hyperlink).toBe('https://example.com')
    term.dispose()
  })

  it('cuts whole rows against the run budget and says the frame is partial', () => {
    const term = emulator({ rows: 6 })
    for (let i = 0; i < 6; i += 1) {
      term.writeSync('\x1b[31ma\x1b[32mb\x1b[33mc\x1b[0m\r\n')
    }
    const frame = frameOf(term, { ...COMPACT, maxRuns: 4 })
    expect(frame.grid).toHaveLength(1)
    // Never a partial row: a half-served row would misreport its content.
    expect(frame.grid[0].runs).toHaveLength(3)
    expect(frame.rowsTruncated).toBe(true)
    term.dispose()
  })

  it('answers unreadable, not a blank screen, once the engine is disposed', () => {
    const term = emulator()
    term.writeSync('content')
    term.dispose()
    expect(term.styledFrame(COMPACT)).toEqual({ outcome: 'unreadable' })
  })
})

/** The whole main-process stack on one real screen: engine -> napi -> emulator ->
 *  the runtime's result builder, i.e. exactly what `terminal.screen` returns.
 *  Each layer is unit-tested on its own; this is the one that would catch them
 *  disagreeing. (The CLI face is covered in src/cli — a different tsconfig
 *  project, so it cannot be imported here.) */
describe('a real styled screen through every layer of terminal.screen', () => {
  it('answers "which row is highlighted" from a menu a TUI would actually draw', () => {
    const term = emulator({ cols: 30, rows: 5 })
    term.writeSync('  Alpha\r\n')
    term.writeSync('\x1b[7m> Bravo\x1b[0m\r\n')
    term.writeSync('  Charlie')
    const result = buildTerminalScreenResult({
      read: (request) => term.styledFrame(request)
    })

    expect(result.available).toBe(true)
    const highlighted = result.rows.filter((row) =>
      row.runs.some((run) => run.attrs?.includes('inverse'))
    )
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0].row).toBe(1)
    expect(highlighted[0].runs[0].text).toBe('> Bravo')
    // The colour swap is on the wire too, for a driver that reasons in pixels.
    expect(highlighted[0].runs[0].bg).toBe(result.defaultFg)
    expect(result.rowsTruncated).toBe(false)
    term.dispose()
  })

  it('names both structural blind spots on a complete frame', () => {
    const term = emulator()
    term.writeSync('anything')
    const result = buildTerminalScreenResult({ read: (request) => term.styledFrame(request) })
    expect(result.blindSpots.map((spot) => spot.reason)).toEqual([
      'styled-grid-is-visible-only',
      'images-not-in-styled-cells'
    ])
    term.dispose()
  })

  it('keeps serving the live screen after rows have scrolled into plain-text history', () => {
    const term = emulator({ rows: 3 })
    for (let i = 0; i < 10; i += 1) {
      term.writeSync(`\x1b[36mline${i}\x1b[0m\r\n`)
    }
    const result = buildTerminalScreenResult({ read: (request) => term.styledFrame(request) })
    expect(term.contextExtents().scrollbackRows).toBeGreaterThan(0)
    // The frame is the live grid; the scrolled-off cyan is gone from the engine
    // entirely, which is exactly what the styled-history blind spot declares.
    expect(result.rows[0].runs[0].text).toBe('line8')
    expect(result.rows[0].runs[0].fg).toBeDefined()
    term.dispose()
  })
})
