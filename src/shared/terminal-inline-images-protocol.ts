/**
 * Wire types for `terminal.images` — the inline images a pane actually emitted,
 * structurally (docs/reference/alab-agent-visibility.md §6).
 *
 * These are the ORIGINAL bytes the program wrote (the PNG from an iTerm2
 * OSC-1337 `File=`, the engine-decoded RGBA8 raster from a sixel), not a
 * re-render of the pane. The engine has retained them all along; only an
 * accessor was missing.
 *
 * The honesty contract this file exists to encode: a driver must always be able
 * to separate three answers that an empty list would blur into one.
 *
 *   1. "Nothing on this pane."  available, images empty, unscannableHistoryRows 0.
 *   2. "It scrolled away."      available, images empty, unscannableHistoryRows > 0.
 *   3. "I cannot see images."   available:false with `unavailable`.
 *
 * (2) is unavoidable and is declared rather than hidden: the headless engine
 * runs with `set_scrollback_text_only(true)`, so a row that scrolls off keeps
 * its text and hyperlink spans and LOSES its image refs. There is no retroactive
 * way to know an image was there. What this result can honestly report is the
 * SIZE of the region it could not scan, which is what `unscannableHistoryRows`
 * is for — a caller seeing `images: []` next to a non-zero value knows its empty
 * answer proves only "not on screen right now".
 */
import type { TerminalContextBlindSpot } from './terminal-context-protocol'

export const TERMINAL_INLINE_IMAGES_SCHEMA_VERSION = 1

/** Why images could not be read at all. Never an error — a parked or cold pane
 *  simply has no live engine, and an old addon has no binding. */
export type TerminalInlineImagesUnavailableReason =
  | 'no-headless-engine'
  | 'engine-unavailable'
  | 'addon-too-old'

/** Source encoding of the retained payload, as the engine recorded it.
 *  `rgba8` is packed 4-bytes-per-pixel, row-major over `pixelWidth` — the sixel
 *  path, decoded in-engine because sixel has no container format. */
export type TerminalInlineImageFormat = 'png' | 'rgba8' | 'unknown'

/** What happened to one placement's bytes. `too-large` and `budget-exhausted`
 *  are refusals with a stated cause, not empty results. */
export type TerminalInlineImagePayloadState =
  | 'included'
  | 'not-requested'
  | 'too-large'
  | 'budget-exhausted'

export type TerminalInlineImage = {
  /** Top-left of the covered bounding box, in visible-grid coordinates. */
  row: number
  col: number
  /** The FULL footprint as placed, in cells. */
  cellRows: number
  cellCols: number
  /** Cells of that footprint on the visible grid right now. */
  coveredCells: number
  /** Part of the placement is off-grid; the retrievable bytes are still whole. */
  clipped: boolean
  format: TerminalInlineImageFormat
  /** Source raster size — `rgba8` only. Null for container formats, whose
   *  headers this path deliberately does not parse. */
  pixelWidth: number | null
  pixelHeight: number | null
  /** Retained payload size, reported whether or not the bytes came back — so a
   *  caller denied the bytes still knows exactly what it was denied. */
  byteLength: number
  /** Kitty `z=`: negative draws behind the cell's text. */
  zIndex: number
  /** FNV-1a 64 over the payload, hex. An identity hint so a polling caller can
   *  tell "same picture as last read" without moving bytes. Not a checksum. */
  fingerprint: string
  payloadState: TerminalInlineImagePayloadState
  /** Standard base64 of the exact emitted bytes; null unless `included`. */
  base64: string | null
}

export type TerminalInlineImagesResult = {
  schema: number
  available: boolean
  unavailable?: TerminalInlineImagesUnavailableReason
  /** One entry per placement, reading order. Empty is only ever "none on the
   *  visible grid now" — read it against `unscannableHistoryRows`. */
  images: TerminalInlineImage[]
  /** Placements found on the grid, before the per-response cap. Greater than
   *  `images.length` means the list was cut — reported rather than silently
   *  short, so a caller never mistakes the cap for the whole picture. */
  totalPlacements: number
  /** Visible grid the coordinates are in. Null when unreadable. */
  gridRows: number | null
  gridCols: number | null
  /** Retained history rows this call CANNOT scan, because the engine drops image
   *  refs on scroll-off. Greater than zero means an empty `images` proves only
   *  that nothing is on screen — an image may have existed and be unrecoverable.
   *  Null when the engine could not report its depth. */
  unscannableHistoryRows: number | null
  /** Bytes were asked for. False means every `not-requested` is a choice the
   *  caller made, not a limit it hit. */
  bytesRequested: boolean
  /** The budgets actually applied after clamping, so a caller that asked for
   *  more learns it was clamped instead of guessing from the results. */
  maxBytesPerImage: number
  maxTotalBytes: number
  /** Payload bytes returned in this response (before base64 expansion). */
  bytesReturned: number
  blindSpots: TerminalContextBlindSpot[]
}

/** On the alternate screen the visible grid is the ALT grid, whose rows have no
 *  scrollback, while the engine's retained history belongs to the main screen.
 *  A full-screen TUI — every coding agent — lives here, so an empty image list on
 *  an alt-screen pane says nothing about what the agent has drawn. */
export const TERMINAL_ALT_SCREEN_GRAPHICS_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'graphics',
  reason: 'alt-screen-history-not-scannable',
  detail:
    'This pane is on the alternate screen, so only the alt grid was scanned; the retained scrollback belongs to the main screen and was not searched. An empty list here does not mean the agent has drawn no images.'
}
