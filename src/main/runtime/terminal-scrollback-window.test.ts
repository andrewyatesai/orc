import { describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_HISTORY_DEFAULT_ROWS,
  TERMINAL_HISTORY_MAX_ROWS,
  buildTerminalHistoryWindow,
  terminalScrollbackSourceFor,
  type TerminalScrollbackSource
} from './terminal-scrollback-window'

/** Engine stand-in: `origin + index` addressing over a flat row array, exactly
 *  the contract `search_context` answers with. */
function fakeEngine(opts: {
  origin: number
  history: string[]
  grid: string[]
  cols?: number
}): TerminalScrollbackSource {
  const all = [...opts.history, ...opts.grid]
  return {
    originRow: opts.origin,
    scrollbackRows: opts.history.length,
    gridRows: opts.grid.length,
    cols: opts.cols ?? 80,
    alternateScreen: false,
    readRows: (fromHostRow, count) => {
      const start = Math.max(0, fromHostRow - opts.origin)
      return {
        lines: all.slice(start, start + count),
        firstHostRow: opts.origin + start
      }
    }
  }
}

const rows = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`)

describe('terminal history window', () => {
  it('names the reason when there is no engine instead of returning an empty window', () => {
    const result = buildTerminalHistoryWindow(null)
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('no-headless-engine')
    expect(result.rows).toEqual([])
  })

  it('reports an addon that cannot answer stable rows rather than guessing', () => {
    const engine = fakeEngine({ origin: 0, history: ['a'], grid: ['b'] })
    expect(buildTerminalHistoryWindow({ ...engine, originRow: null }).unavailable).toBe(
      'addon-too-old'
    )
    expect(buildTerminalHistoryWindow({ ...engine, scrollbackRows: null }).unavailable).toBe(
      'addon-too-old'
    )
  })

  it('defaults to the newest window, which includes the visible grid', () => {
    const engine = fakeEngine({
      origin: 1000,
      history: rows('h', 10),
      grid: rows('g', 4)
    })
    const result = buildTerminalHistoryWindow(engine, { count: 6 })
    expect(result.rows).toEqual(['h8', 'h9', 'g0', 'g1', 'g2', 'g3'])
    expect(result.firstHostRow).toBe(1008)
    expect(result.latestHostRow).toBe(1013)
    expect(result.nextHostRow).toBeNull()
    expect(result.previousHostRow).toBe(1002)
    expect(result.hasMoreAbove).toBe(true)
    expect(result.hasMoreBelow).toBe(false)
  })

  it('walks backward and forward through the same rows without losing its place', () => {
    const engine = fakeEngine({
      origin: 500,
      history: rows('h', 20),
      grid: rows('g', 2)
    })
    const first = buildTerminalHistoryWindow(engine, { count: 5 })
    const older = buildTerminalHistoryWindow(engine, {
      from: first.previousHostRow!,
      count: 5
    })
    const backToFirst = buildTerminalHistoryWindow(engine, {
      from: older.nextHostRow!,
      count: 5
    })
    expect(older.rows).toEqual(['h12', 'h13', 'h14', 'h15', 'h16'])
    expect(backToFirst.rows).toEqual(first.rows)
    expect(backToFirst.firstHostRow).toBe(first.firstHostRow)
  })

  it('stops paging up at the retained floor', () => {
    const engine = fakeEngine({
      origin: 300,
      history: rows('h', 3),
      grid: rows('g', 1)
    })
    const result = buildTerminalHistoryWindow(engine, { from: 300, count: 2 })
    expect(result.firstHostRow).toBe(300)
    expect(result.previousHostRow).toBeNull()
    expect(result.hasMoreAbove).toBe(false)
    expect(result.nextHostRow).toBe(302)
  })

  it('clamps a request below the floor and says the rows were evicted', () => {
    const engine = fakeEngine({
      origin: 900,
      history: rows('h', 4),
      grid: rows('g', 1)
    })
    const result = buildTerminalHistoryWindow(engine, { from: 100, count: 3 })
    expect(result.firstHostRow).toBe(900)
    expect(result.rows).toEqual(['h0', 'h1', 'h2'])
    expect(result.evicted).toBe(true)
  })

  it('answers past the live edge with a cursor to walk back from', () => {
    const engine = fakeEngine({
      origin: 0,
      history: rows('h', 5),
      grid: rows('g', 1)
    })
    const result = buildTerminalHistoryWindow(engine, { from: 999, count: 4 })
    expect(result.rows).toEqual([])
    expect(result.nextHostRow).toBeNull()
    expect(result.previousHostRow).toBe(2)
    expect(result.evicted).toBe(false)
  })

  it('treats an engine that returned nothing for a live range as eviction, not blank', () => {
    const engine = fakeEngine({ origin: 0, history: rows('h', 5), grid: [] })
    const raced: TerminalScrollbackSource = {
      ...engine,
      readRows: () => ({ lines: [], firstHostRow: 0 })
    }
    const result = buildTerminalHistoryWindow(raced, { from: 0, count: 3 })
    expect(result.rows).toEqual([])
    expect(result.evicted).toBe(true)
  })

  it('reports an engine that could not answer at all', () => {
    const engine = fakeEngine({ origin: 0, history: rows('h', 5), grid: [] })
    const result = buildTerminalHistoryWindow({ ...engine, readRows: () => null }, { count: 2 })
    expect(result.available).toBe(false)
    expect(result.unavailable).toBe('engine-unavailable')
  })

  it('handles a pane with no rows at all', () => {
    const engine = fakeEngine({ origin: 42, history: [], grid: [] })
    const result = buildTerminalHistoryWindow(engine)
    expect(result.available).toBe(true)
    expect(result.totalRows).toBe(0)
    expect(result.latestHostRow).toBeNull()
    expect(result.hasMoreAbove).toBe(false)
  })

  it('clamps the requested row count and falls back to the default', () => {
    const engine = fakeEngine({
      origin: 0,
      history: rows('h', 5000),
      grid: []
    })
    expect(buildTerminalHistoryWindow(engine, { count: 99_999 }).rows).toHaveLength(
      TERMINAL_HISTORY_MAX_ROWS
    )
    expect(buildTerminalHistoryWindow(engine, { count: 0 }).rows).toHaveLength(
      TERMINAL_HISTORY_DEFAULT_ROWS
    )
  })

  it('trims to the byte budget and says it did', () => {
    const wide = Array.from({ length: 200 }, () => 'x'.repeat(4000))
    const engine = fakeEngine({ origin: 0, history: wide, grid: [] })
    const result = buildTerminalHistoryWindow(engine, { from: 0, count: 200 })
    expect(result.limited).toBe(true)
    expect(result.rows.length).toBeLessThan(200)
    // The window still resumes cleanly from where it stopped.
    expect(result.nextHostRow).toBe(result.rows.length)
  })

  it('always names the channels it cannot serve', () => {
    const engine = fakeEngine({ origin: 0, history: ['a'], grid: [] })
    const capabilities = buildTerminalHistoryWindow(engine).blindSpots.map(
      (spot) => spot.capability
    )
    expect(capabilities).toContain('styles')
    expect(capabilities).toContain('graphics')
  })
})

describe('terminalScrollbackSourceFor', () => {
  it('reads a row range through the engine context primitive', () => {
    const searchContext = vi.fn().mockReturnValue({ lines: ['a', 'b'], firstHostRow: 40 })
    const source = terminalScrollbackSourceFor({
      getAppliedSize: () => ({ cols: 120, rows: 24 }),
      isAlternateScreen: true,
      retainedOriginRow: () => 40,
      contextExtents: () => ({ scrollbackRows: 900 }),
      searchContext
    })
    expect(source).toMatchObject({
      originRow: 40,
      scrollbackRows: 900,
      gridRows: 24,
      cols: 120
    })
    expect(source.readRows(40, 2)).toEqual({
      lines: ['a', 'b'],
      firstHostRow: 40
    })
    // before:0 makes the search-context primitive a forward row-range read.
    expect(searchContext).toHaveBeenCalledWith(40, 0, 1)
  })

  it('never asks the engine for a negative row count', () => {
    const searchContext = vi.fn()
    const source = terminalScrollbackSourceFor({
      getAppliedSize: () => ({ cols: 80, rows: 24 }),
      isAlternateScreen: false,
      retainedOriginRow: () => 0,
      contextExtents: () => ({ scrollbackRows: 0 }),
      searchContext
    })
    expect(source.readRows(7, 0)).toEqual({ lines: [], firstHostRow: 7 })
    expect(searchContext).not.toHaveBeenCalled()
  })
})

describe('an empty window still hands back a way to walk', () => {
  // Reporting "there is more above and below" while returning no cursor for either
  // is a dead end: the caller knows it is missing history and cannot reach it.
  it('gives resume cursors when the requested range holds no rows', () => {
    const engine = fakeEngine({ origin: 100, history: rows('h', 40), grid: rows('g', 10) })
    // Ask for a range the engine cannot fill, so rows come back empty.
    const result = buildTerminalHistoryWindow(
      { ...engine, readRows: () => ({ lines: [], firstHostRow: 120 }) },
      { from: 120, count: 10 }
    )

    expect(result.rows).toEqual([])
    // Whatever it claims about more content, it must offer a cursor in that direction.
    if (result.hasMoreAbove) {
      expect(result.previousHostRow).not.toBeNull()
    }
    if (result.hasMoreBelow) {
      expect(result.nextHostRow).not.toBeNull()
    }
  })
})
