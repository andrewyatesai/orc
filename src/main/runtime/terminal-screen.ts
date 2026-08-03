/**
 * `terminal.screen` — the styled-grid oracle
 * (docs/reference/alab-agent-visibility.md §2, §8 item 2).
 *
 * Why this verb is the keystone: every other read Orca serves is text, and text
 * cannot answer the question a driver asks before every keystroke — *which item
 * is highlighted right now?* A selection bar is an inverse-video run or a
 * background colour, and `terminal.read` strips both. Without this, pressing a
 * key is pressing it blind.
 *
 * This module owns the wire assembly and the honesty branches; the frame itself
 * is computed in `orca_terminal::styled_frame` over the same `aterm-core` reads
 * `aterm-gui`'s own `screen` verb makes. Pure: the engine is injected, so every
 * budget clamp and every unavailable branch is testable without an addon.
 */
import {
  TERMINAL_SCREEN_IMAGES_NOT_IN_GRID_BLIND_SPOT,
  TERMINAL_SCREEN_NO_STYLED_HISTORY_BLIND_SPOT,
  TERMINAL_SCREEN_SCHEMA_VERSION,
  type TerminalScreenAttribute,
  type TerminalScreenDetail,
  type TerminalScreenModes,
  type TerminalScreenResult,
  type TerminalScreenRow,
  type TerminalScreenRun,
  type TerminalScreenUnavailableReason
} from '../../shared/terminal-screen-protocol'
import type {
  EmulatorStyledFrameRead,
  EmulatorStyledFrameRequest
} from '../daemon/emulator-styled-frame'
import type { RustStyleRun, RustStyledFrame } from '../daemon/rust-terminal-addon'

/** Enough for a fully styled 200x100 pane at two runs per row, and for the
 *  per-word colouring a diff or a syntax-highlighted pager produces on a normal
 *  screen. A frame that needs more is asking for a window, not a default. */
export const TERMINAL_SCREEN_DEFAULT_MAX_RUNS = 4000
/** The ceiling a caller may raise the budget to. A run costs far less than a
 *  cell, but this still crosses a JSON socket. */
export const TERMINAL_SCREEN_MAX_RUNS = 20000

const BLIND_SPOTS = [
  TERMINAL_SCREEN_NO_STYLED_HISTORY_BLIND_SPOT,
  TERMINAL_SCREEN_IMAGES_NOT_IN_GRID_BLIND_SPOT
]

/** The attribute code letters `orca_terminal::SCREEN_ATTR_CODES` emits, expanded
 *  into names. Kept terse on the wire from Rust because most runs carry none;
 *  expanded here because a driver reading JSON should not need a legend. */
const ATTRIBUTE_NAMES: Record<string, TerminalScreenAttribute> = {
  b: 'bold',
  d: 'dim',
  i: 'italic',
  k: 'blink',
  v: 'inverse',
  c: 'conceal',
  s: 'strike',
  o: 'overline',
  u: 'underline',
  U: 'underline-double',
  w: 'underline-curly',
  t: 'underline-dotted',
  a: 'underline-dashed'
}

const MOUSE_TRACKING: Record<string, TerminalScreenModes['mouseTracking']> = {
  none: 'none',
  x10: 'x10',
  normal: 'normal',
  button: 'button',
  any: 'any'
}

export type TerminalScreenSource = {
  read: (request: EmulatorStyledFrameRequest) => EmulatorStyledFrameRead
}

export type TerminalScreenOptions = {
  detail?: TerminalScreenDetail
  fromRow?: number
  rowCount?: number
  maxRuns?: number
}

function positiveInt(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.min(Math.floor(value), ceiling)
}

function nonNegativeInt(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Expand the code string, dropping letters this build does not know rather
 *  than inventing a name for them — a future addon adding an attribute must not
 *  make this build claim it understood one. */
function toAttributes(codes: string): TerminalScreenAttribute[] {
  const names: TerminalScreenAttribute[] = []
  for (const code of codes) {
    const name = ATTRIBUTE_NAMES[code]
    if (name) {
      names.push(name)
    }
  }
  return names
}

function toWireRun(run: RustStyleRun, defaultFg: string, defaultBg: string): TerminalScreenRun {
  const attrs = toAttributes(run.attrs)
  return {
    col: run.col,
    cols: run.cols,
    text: run.text,
    // Omitted when it matches the frame default: that is most of a screen, and
    // the default is stated once on the result rather than per run.
    ...(run.fg === defaultFg ? {} : { fg: run.fg }),
    ...(run.bg === defaultBg ? {} : { bg: run.bg }),
    ...(attrs.length > 0 ? { attrs } : {}),
    ...(run.hyperlink ? { link: run.hyperlink } : {})
  }
}

function toWireRows(frame: RustStyledFrame): TerminalScreenRow[] {
  return frame.grid.map((row) => ({
    row: row.row,
    runs: row.runs.map((run) => toWireRun(run, frame.defaultFg, frame.defaultBg))
  }))
}

function toWireModes(frame: RustStyledFrame): TerminalScreenModes {
  return {
    alternateScreen: frame.modes.alternateScreen,
    applicationCursor: frame.modes.applicationCursor,
    bracketedPaste: frame.modes.bracketedPaste,
    // An unrecognised token degrades to 'unknown', never to 'none': claiming
    // mouse reporting is off when this build cannot name the mode would tell a
    // driver its clicks are safe to skip encoding.
    mouseTracking: MOUSE_TRACKING[frame.modes.mouseTracking] ?? 'unknown',
    sgrMouse: frame.modes.sgrMouse,
    sgrPixels: frame.modes.sgrPixels,
    mouseEncoding: frame.modes.mouseEncoding ?? 'unknown',
    kittyKeyboardFlags: frame.modes.kittyKeyboardFlags,
    reverseVideo: frame.modes.reverseVideo
  }
}

function unavailable(
  reason: TerminalScreenUnavailableReason,
  request: EmulatorStyledFrameRequest
): TerminalScreenResult {
  return {
    schema: TERMINAL_SCREEN_SCHEMA_VERSION,
    available: false,
    unavailable: reason,
    detail: request.detail,
    rows: [],
    gridRows: null,
    gridCols: null,
    firstRow: request.fromRow,
    // Not "the whole screen fit": nothing was read, so nothing can be claimed
    // about completeness either.
    rowsTruncated: false,
    runsReturned: 0,
    maxRuns: request.maxRuns,
    trailingBlanksTrimmed: false,
    defaultFg: null,
    defaultBg: null,
    cursor: null,
    modes: null,
    contentSeq: null,
    blindSpots: BLIND_SPOTS
  }
}

export function buildTerminalScreenResult(
  source: TerminalScreenSource | null,
  opts: TerminalScreenOptions = {}
): TerminalScreenResult {
  const request: EmulatorStyledFrameRequest = {
    detail: opts.detail === 'full' ? 'full' : 'compact',
    fromRow: nonNegativeInt(opts.fromRow),
    rowCount: nonNegativeInt(opts.rowCount),
    maxRuns: positiveInt(opts.maxRuns, TERMINAL_SCREEN_DEFAULT_MAX_RUNS, TERMINAL_SCREEN_MAX_RUNS)
  }
  if (!source) {
    return unavailable('no-headless-engine', request)
  }
  const read = source.read(request)
  if (read.outcome === 'unsupported') {
    // The distinction the verb turns on: this build has no screen binding,
    // which is not the same claim as "this screen is blank".
    return unavailable('addon-too-old', request)
  }
  if (read.outcome === 'unreadable') {
    return unavailable('engine-unavailable', request)
  }
  const { frame } = read
  return {
    schema: TERMINAL_SCREEN_SCHEMA_VERSION,
    available: true,
    detail: request.detail,
    rows: toWireRows(frame),
    gridRows: frame.rows,
    gridCols: frame.cols,
    firstRow: frame.firstRow,
    rowsTruncated: frame.rowsTruncated,
    runsReturned: frame.runsTotal,
    maxRuns: request.maxRuns,
    trailingBlanksTrimmed: frame.trailingBlanksTrimmed,
    defaultFg: frame.defaultFg,
    defaultBg: frame.defaultBg,
    cursor: frame.cursor,
    modes: toWireModes(frame),
    contentSeq: frame.contentSeq,
    // Ride on every result, including a complete one: a driver weighing a frame
    // has to know that history has no styles and that an image on this very
    // grid is invisible here, whether or not this particular read was cut.
    blindSpots: BLIND_SPOTS
  }
}
