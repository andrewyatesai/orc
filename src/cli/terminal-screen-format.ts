/**
 * Human-readable rendering for `orca terminal screen`.
 *
 * The plain-text view cannot show colour, so it must not pretend to. What it
 * shows instead is the thing colour is being used FOR: which rows carry styling
 * at all, which one the cursor sits on, and — spelled out per row — the runs
 * that are not plain text. A driver reading this can see "row 7 is the inverse
 * one" without a terminal that renders SGR.
 *
 * `--json` remains the lossless face; this is the orientation face.
 */
import type {
  TerminalScreenResult,
  TerminalScreenRow,
  TerminalScreenRun
} from '../shared/terminal-screen-protocol'
import { sanitizeUntrustedTerminalText } from './terminal-safe-text'

const UNAVAILABLE_DETAIL: Record<string, string> = {
  'no-headless-engine':
    'this pane has no live engine (parked, cold, or not yet hydrated) — not that its screen is blank',
  'engine-unavailable': 'the engine for this pane could not answer',
  'addon-too-old':
    'this build has no screen binding — it cannot read a styled grid at all, on any pane'
}

/** A run worth calling out: it carries attributes, a non-default colour, or a
 *  link. Plain text is already visible in the row itself. */
function isStyled(run: TerminalScreenRun): boolean {
  return (
    (run.attrs !== undefined && run.attrs.length > 0) ||
    run.fg !== undefined ||
    run.bg !== undefined ||
    run.link !== undefined
  )
}

function describeRun(run: TerminalScreenRun): string {
  const parts: string[] = []
  if (run.attrs && run.attrs.length > 0) {
    parts.push(run.attrs.join('+'))
  }
  if (run.fg) {
    parts.push(`fg ${run.fg}`)
  }
  if (run.bg) {
    parts.push(`bg ${run.bg}`)
  }
  if (run.link) {
    parts.push(`link ${sanitizeUntrustedTerminalText(run.link)}`)
  }
  return `col ${run.col}-${run.col + run.cols - 1}  ${parts.join(' ')}  ${sanitizeUntrustedTerminalText(JSON.stringify(run.text))}`
}

function formatRow(row: TerminalScreenRow, cursorRow: number | null): string {
  const text = sanitizeUntrustedTerminalText(row.runs.map((run) => run.text).join(''))
  const marker = row.row === cursorRow ? '>' : ' '
  const head = `${marker}${String(row.row).padStart(3)} | ${text}`
  const styled = row.runs.filter(isStyled).map((run) => `      ${describeRun(run)}`)
  return [head, ...styled].join('\n')
}

/** The sentence a caller must read before trusting the frame as "the screen".
 *  A partial frame that reads as complete is the same failure as an empty one
 *  that reads as a fact, so the truncation claim is made from `rowsTruncated`
 *  alone — never inferred from a short list. */
function scanScope(result: TerminalScreenResult): string {
  let window: string
  if (!result.rowsTruncated) {
    window = `All ${result.gridRows} rows of the visible grid.`
  } else if (result.rows.length === 0) {
    window = `NO rows were served of ${result.gridRows} (row window or the ${result.maxRuns}-run budget) — this says nothing about what is on the screen.`
  } else {
    window = `Rows ${result.firstRow}-${result.firstRow + result.rows.length - 1} of ${result.gridRows} — the rest were not served (row window or the ${result.maxRuns}-run budget).`
  }
  const trimmed = result.trailingBlanksTrimmed
    ? ' Trailing blank columns are trimmed per row; pass --detail full for the padded grid.'
    : ''
  return `Scope: the LIVE visible grid, never history — scrolled-off rows keep their text and lose their colour. ${window}${trimmed}`
}

function formatModes(result: TerminalScreenResult): string {
  const modes = result.modes
  if (!modes) {
    return ''
  }
  const on: string[] = []
  if (modes.alternateScreen) {
    on.push('alt-screen')
  }
  if (modes.applicationCursor) {
    on.push('application-cursor (arrows are ESC O A)')
  }
  if (modes.bracketedPaste) {
    on.push('bracketed-paste')
  }
  if (modes.mouseTracking !== 'none') {
    on.push(`mouse ${modes.mouseTracking}${modes.sgrMouse ? ' sgr' : ''}`)
  }
  if (modes.kittyKeyboardFlags !== 0) {
    on.push(`kitty-keyboard 0x${modes.kittyKeyboardFlags.toString(16)}`)
  }
  if (modes.reverseVideo) {
    on.push('reverse-video (DECSCNM — every colour below is already inverted)')
  }
  return `Input modes: ${on.length > 0 ? on.join(', ') : 'none set (plain cooked keys)'}`
}

export function formatTerminalScreen(result: TerminalScreenResult): string {
  if (!result.available) {
    const reason = result.unavailable ?? 'unknown'
    return `Screen unavailable: ${reason} — ${UNAVAILABLE_DETAIL[reason] ?? 'cause not reported'}.`
  }
  const cursor = result.cursor
  const cursorLine = cursor
    ? `Cursor: row ${cursor.row} col ${cursor.col}, ${cursor.visible ? 'visible' : 'hidden (still positioned)'}, ${cursor.style}`
    : 'Cursor: not reported'
  const header = [
    `Screen ${result.gridCols}x${result.gridRows} (${result.detail}), ${result.runsReturned} styled run(s).`,
    scanScope(result),
    cursorLine,
    formatModes(result)
  ].join('\n')
  const body = result.rows.map((row) => formatRow(row, cursor?.row ?? null)).join('\n')
  return `${header}\n\n${body}`
}
