/**
 * Wire types for `terminal.screen` — the styled visible grid, the cursor, and
 * the modes that change what input MEANS
 * (docs/reference/alab-agent-visibility.md §2, §8 item 2).
 *
 * Every other verb hands back text. `terminal.read` returns a normalized
 * transcript with all SGR stripped, so a driver can see what a pane says and
 * never which row is selected, highlighted, focused, or under the cursor —
 * which makes every keystroke-driven interaction a guess. This is the read that
 * is not text.
 *
 * Three shapes here are deliberate and worth reading before using the type:
 *
 * 1. **Colours are RESOLVED.** `fg`/`bg` are `#rrggbb` as the engine rendered
 *    them: palette lookup, bold-to-bright, dim, inverse and screen-wide DECSCNM
 *    already applied. That is what a viewer sees. The raw SGR bits that caused
 *    it ride alongside in `attrs`, so "this row is the selection because it is
 *    inverse" is answerable too.
 * 2. **Cells are coalesced into runs.** A styled grid is far larger than the
 *    text it carries; adjacent cells agreeing on colour, attributes and
 *    hyperlink fold into one run with its column, its column WIDTH and its
 *    text. `cols` exceeds the grapheme count of `text` wherever a wide glyph
 *    sits, because its continuation column has no text of its own.
 * 3. **Absence is always attributable.** `available:false` names why nothing
 *    could be read; a served frame that was cut says so in `rowsTruncated`;
 *    and the two things this seam structurally cannot show — styled history and
 *    inline images — are declared on every response, full or empty.
 */
import type { TerminalContextBlindSpot } from './terminal-context-protocol'

export const TERMINAL_SCREEN_SCHEMA_VERSION = 1

/** Why the screen could not be read at all. Never an error — a parked or cold
 *  pane simply has no live engine, and an old addon has no binding. */
export type TerminalScreenUnavailableReason =
  | 'no-headless-engine'
  | 'engine-unavailable'
  | 'addon-too-old'

/** How much of each row was served. `compact` drops the trailing run of
 *  default-styled blanks and does not probe hyperlinks; `full` pads every row to
 *  the grid width and attaches OSC-8 targets. */
export type TerminalScreenDetail = 'compact' | 'full'

/** Raw SGR bits, named. Present only when non-empty. The underline variants are
 *  distinct because a curly underline is a diagnostic squiggle and a straight
 *  one is emphasis — collapsing them would lose the distinction an editor pane
 *  is drawing. */
export type TerminalScreenAttribute =
  | 'bold'
  | 'dim'
  | 'italic'
  | 'blink'
  | 'inverse'
  | 'conceal'
  | 'strike'
  | 'overline'
  | 'underline'
  | 'underline-double'
  | 'underline-curly'
  | 'underline-dotted'
  | 'underline-dashed'

export type TerminalScreenRun = {
  /** First column, 0-based from the left edge of the grid. */
  col: number
  /** Columns spanned. Greater than the grapheme count of `text` wherever a wide
   *  (CJK / emoji) glyph occupies two columns. */
  cols: number
  text: string
  /** Resolved foreground, `#rrggbb`. Omitted when it equals `defaultFg` — the
   *  common case, and the one that costs the most to repeat. */
  fg?: string
  /** Resolved background, `#rrggbb`. Omitted when it equals `defaultBg`. */
  bg?: string
  /** Omitted when the run carries no SGR attributes. */
  attrs?: TerminalScreenAttribute[]
  /** OSC-8 target. Only ever present at `detail: 'full'`, which is the only
   *  read that probes for it — its absence in a compact frame means "not
   *  asked", not "no link". */
  link?: string
}

export type TerminalScreenRow = {
  /** Index in the visible grid, 0-based from the top. Carried explicitly so a
   *  windowed or truncated frame stays addressable. */
  row: number
  runs: TerminalScreenRun[]
}

export type TerminalScreenCursor = {
  row: number
  col: number
  /** DECTCEM. A hidden cursor still has a position — a full-screen TUI hides it
   *  while repainting, so `false` is not "there is no cursor". */
  visible: boolean
  /** DECSCUSR shape, the engine-only `hollow-block` / `bolt`, or `unknown` for
   *  a shape this build does not name. */
  style: string
}

/** The modes a driver must read before writing a single byte: they change what
 *  the bytes MEAN. An arrow key is `ESC [ A` or `ESC O A` on `applicationCursor`
 *  alone, and pasted text needs bracketing markers exactly when the app asked. */
export type TerminalScreenModes = {
  alternateScreen: boolean
  /** DECCKM. */
  applicationCursor: boolean
  /** DECSET 2004. */
  bracketedPaste: boolean
  mouseTracking: 'none' | 'x10' | 'normal' | 'button' | 'any' | 'unknown'
  sgrMouse: boolean
  sgrPixels: boolean
  /** Coordinate encoding by name — `x10` | `utf8` | `sgr` | `urxvt` | `sgr-pixel`,
   *  or `unknown` for one this build does not recognise. The booleans above cannot
   *  distinguish X10 from UTF-8 (1005) or URXVT (1015): all three report false for
   *  every SGR flag, and a click encoded for the wrong one lands on another cell. */
  mouseEncoding: string
  /** Kitty keyboard protocol flags; 0 = inactive. Non-zero re-encodes every
   *  key, not only the exotic ones. */
  kittyKeyboardFlags: number
  /** DECSCNM, already folded into every colour in this frame. */
  reverseVideo: boolean
}

export type TerminalScreenResult = {
  schema: number
  available: boolean
  unavailable?: TerminalScreenUnavailableReason
  detail: TerminalScreenDetail
  /** Rows served, top-first. Empty with `available:true` means the grid itself
   *  is blank — read it against `rowsTruncated`. */
  rows: TerminalScreenRow[]
  /** Full grid height, independent of how many rows came back. Null when
   *  unreadable. */
  gridRows: number | null
  gridCols: number | null
  /** Grid index of `rows[0]`, so a windowed frame stays addressable. */
  firstRow: number
  /** Rows were withheld — by an explicit window or by the run budget. Rows are
   *  cut WHOLE, so no returned row is ever a partial line. */
  rowsTruncated: boolean
  /** Runs emitted across every returned row, against `maxRuns`. */
  runsReturned: number
  /** The budget actually applied after clamping, so a caller that asked for more
   *  learns it was clamped instead of inferring it from a short answer. */
  maxRuns: number
  /** Trailing default-blank tails were dropped (always at `detail: 'compact'`).
   *  A caller rebuilding a matrix must pad rows out to `gridCols`. */
  trailingBlanksTrimmed: boolean
  /** The terminal's live default colours with DECSCNM applied — the value a run
   *  has when `fg`/`bg` is omitted. */
  defaultFg: string | null
  defaultBg: string | null
  cursor: TerminalScreenCursor | null
  modes: TerminalScreenModes | null
  /** Grid content generation. Equal across two reads means the CELLS did not
   *  change; it does NOT cover cursor movement or a DECSCNM flip, both of which
   *  are reported above. Null when unreadable. */
  contentSeq: number | null
  blindSpots: TerminalContextBlindSpot[]
}

/** The frame is the LIVE screen. Rows that scrolled off keep their text and lose
 *  their colour (`set_scrollback_text_only`), so there is no styled history to
 *  page into — `terminal.history` serves those rows as plain text and this verb
 *  cannot dress them back up. */
export const TERMINAL_SCREEN_NO_STYLED_HISTORY_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'styles',
  reason: 'styled-grid-is-visible-only',
  detail:
    'This frame is the visible grid only. The engine stores scrolled-off rows as text and discards their colour, so no styled view of history exists — page it with terminal.history, as plain text.'
}

/** A cell covered by an inline image reports the TEXT under the image, because
 *  that is all a cell holds. Nothing in a styled grid says "a picture is drawn
 *  here"; `terminal.images` is the verb that does. */
export const TERMINAL_SCREEN_IMAGES_NOT_IN_GRID_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'graphics',
  reason: 'images-not-in-styled-cells',
  detail:
    'Inline sixel/OSC-1337/Kitty images are not represented in these cells: a cell covered by an image still reports its own text and colour. Read terminal.images for the placements and payloads on this same grid.'
}
