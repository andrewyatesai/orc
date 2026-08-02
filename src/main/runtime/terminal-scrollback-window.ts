/**
 * Windowed reads over the headless engine's scrollback — `terminal.history`
 * (§3 of docs/reference/alab-agent-visibility.md).
 *
 * Why this rather than `terminal.read --cursor`: read pages the retained PTY
 * *transcript*, bounded at 2000 lines / 256 KiB, and a verbose agent burns that
 * in minutes. The engine keeps far more (5000 rows by default) and already
 * exposes random access to it — the same `search_context` primitive that backs
 * `terminal.searchContext` reads an arbitrary row range, so paging needs no new
 * storage and no new engine call.
 *
 * Coordinates are the engine's eviction-stable absolute rows — exactly what
 * `terminal.search` returns — so a match row can be fed straight back as
 * `--from` to read the text around it.
 *
 * Pure module: the engine is injected, so the window arithmetic is testable
 * without an addon.
 */
import {
  TERMINAL_CONTEXT_SCHEMA_VERSION,
  TERMINAL_GRAPHICS_BLIND_SPOT,
  TERMINAL_SCROLLBACK_STYLES_BLIND_SPOT,
  type TerminalHistoryWindow
} from '../../shared/terminal-context-protocol'

export type TerminalScrollbackSource = {
  /** Stable absolute row of retained history index 0; null when the addon
   *  predates the stable-row contract (callers degrade, never throw). */
  originRow: number | null
  /** Retained history rows above the visible grid; null when unavailable. */
  scrollbackRows: number | null
  gridRows: number
  cols: number
  alternateScreen: boolean
  /** Rows `[fromHostRow, fromHostRow + count)`, clamped by the engine to what
   *  it still retains. Null when the engine could not answer. */
  readRows: (fromHostRow: number, count: number) => { lines: string[]; firstHostRow: number } | null
}

/** Structural view of the headless emulator, so this module stays free of
 *  daemon imports and testable with a plain object. */
export type ScrollbackCapableEmulator = {
  getAppliedSize: () => { cols: number; rows: number }
  isAlternateScreen: boolean
  retainedOriginRow: () => number | null
  contextExtents: () => { scrollbackRows: number | null }
  searchContext: (
    hostRow: number,
    before: number,
    after: number
  ) => { lines: string[]; firstHostRow: number } | null
}

/** Adapter over the engine's random-access context primitive: `searchContext`
 *  with `before: 0` IS a row-range read, so paging needs no new binding. */
export function terminalScrollbackSourceFor(
  emulator: ScrollbackCapableEmulator
): TerminalScrollbackSource {
  const size = emulator.getAppliedSize()
  return {
    originRow: emulator.retainedOriginRow(),
    scrollbackRows: emulator.contextExtents().scrollbackRows,
    gridRows: size.rows,
    cols: size.cols,
    alternateScreen: emulator.isAlternateScreen,
    readRows: (fromHostRow, count) =>
      count <= 0
        ? { lines: [], firstHostRow: fromHostRow }
        : emulator.searchContext(fromHostRow, 0, count - 1)
  }
}

export const TERMINAL_HISTORY_DEFAULT_ROWS = 200
export const TERMINAL_HISTORY_MAX_ROWS = 1000
/** Matches the transcript's own character ceiling so neither path can be used
 *  to pull an unbounded payload across the wire. */
export const TERMINAL_HISTORY_MAX_CHARS = 256 * 1024
export const TERMINAL_HISTORY_MAX_ROW_CHARS = 4096

const BLIND_SPOTS = [TERMINAL_SCROLLBACK_STYLES_BLIND_SPOT, TERMINAL_GRAPHICS_BLIND_SPOT]

function unavailable(
  reason: NonNullable<TerminalHistoryWindow['unavailable']>
): TerminalHistoryWindow {
  return {
    schema: TERMINAL_CONTEXT_SCHEMA_VERSION,
    available: false,
    unavailable: reason,
    rows: [],
    firstHostRow: null,
    previousHostRow: null,
    nextHostRow: null,
    oldestHostRow: null,
    latestHostRow: null,
    totalRows: 0,
    hasMoreAbove: false,
    hasMoreBelow: false,
    evicted: false,
    limited: false,
    cols: null,
    alternateScreen: false,
    blindSpots: BLIND_SPOTS
  }
}

/** Clamp rows to the character budget from the OLDEST end, because paging
 *  continues forward from `nextHostRow`; cutting the head instead would strand
 *  rows no cursor can name. */
function applyCharacterBudget(lines: string[]): {
  rows: string[]
  limited: boolean
} {
  const rows: string[] = []
  let characters = 0
  for (const line of lines) {
    const row =
      line.length > TERMINAL_HISTORY_MAX_ROW_CHARS
        ? line.slice(0, TERMINAL_HISTORY_MAX_ROW_CHARS)
        : line
    if (rows.length > 0 && characters + row.length > TERMINAL_HISTORY_MAX_CHARS) {
      return { rows, limited: true }
    }
    rows.push(row)
    characters += row.length
  }
  return { rows, limited: rows.length < lines.length }
}

export function clampHistoryRowCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return TERMINAL_HISTORY_DEFAULT_ROWS
  }
  return Math.min(Math.floor(requested), TERMINAL_HISTORY_MAX_ROWS)
}

export function buildTerminalHistoryWindow(
  source: TerminalScrollbackSource | null,
  opts: { from?: number; count?: number } = {}
): TerminalHistoryWindow {
  if (!source) {
    return unavailable('no-headless-engine')
  }
  if (source.originRow === null || source.scrollbackRows === null) {
    return unavailable('addon-too-old')
  }
  const count = clampHistoryRowCount(opts.count)
  // Why the grid is included: absolute rows span history THEN the visible grid,
  // the same scope `terminal.search` covers, so an un-cursored history read is
  // also the fastest way to see what is on screen right now.
  const totalRows = source.scrollbackRows + source.gridRows
  const oldestHostRow = source.originRow
  const latestHostRow = source.originRow + Math.max(0, totalRows - 1)
  const base = {
    schema: TERMINAL_CONTEXT_SCHEMA_VERSION,
    available: true,
    oldestHostRow,
    latestHostRow: totalRows === 0 ? null : latestHostRow,
    totalRows,
    cols: source.cols,
    alternateScreen: source.alternateScreen,
    blindSpots: BLIND_SPOTS
  }
  if (totalRows === 0) {
    return {
      ...base,
      rows: [],
      firstHostRow: null,
      previousHostRow: null,
      nextHostRow: null,
      hasMoreAbove: false,
      hasMoreBelow: false,
      evicted: false,
      limited: false
    }
  }

  const requestedFrom = opts.from ?? latestHostRow + 1 - count
  if (requestedFrom > latestHostRow) {
    // Past the live edge: nothing to return, but the caller still gets a cursor
    // to walk back with instead of an empty result it cannot resume from.
    return {
      ...base,
      rows: [],
      firstHostRow: null,
      previousHostRow: Math.max(oldestHostRow, latestHostRow + 1 - count),
      nextHostRow: null,
      hasMoreAbove: true,
      hasMoreBelow: false,
      evicted: false,
      limited: false
    }
  }
  const from = Math.max(oldestHostRow, requestedFrom)
  const window = source.readRows(from, Math.min(count, latestHostRow - from + 1))
  if (!window) {
    return unavailable('engine-unavailable')
  }
  const { rows, limited } = applyCharacterBudget(window.lines)
  const firstHostRow = rows.length > 0 ? window.firstHostRow : null
  const lastHostRow = firstHostRow === null ? null : firstHostRow + rows.length - 1
  return {
    ...base,
    rows,
    firstHostRow,
    // Why the empty case still carries cursors: reporting "more above and below" with
    // no way to reach either is a dead end — the caller knows it is missing something
    // and cannot walk to it. Anchor the resume points on the range it asked for.
    previousHostRow:
      firstHostRow !== null
        ? firstHostRow > oldestHostRow
          ? Math.max(oldestHostRow, firstHostRow - count)
          : null
        : from > oldestHostRow
          ? Math.max(oldestHostRow, from - count)
          : null,
    nextHostRow:
      lastHostRow !== null
        ? lastHostRow < latestHostRow
          ? lastHostRow + 1
          : null
        : from + count <= latestHostRow
          ? from + count
          : null,
    hasMoreAbove: firstHostRow === null ? from > oldestHostRow : firstHostRow > oldestHostRow,
    hasMoreBelow:
      lastHostRow === null ? from + count <= latestHostRow : lastHostRow < latestHostRow,
    // Why the empty-window arm counts as eviction: the caller named a row the
    // engine no longer retains, and reporting `rows: []` alone would read as
    // "this range is blank" rather than "this range is gone".
    evicted: requestedFrom < oldestHostRow || rows.length === 0,
    limited
  }
}
