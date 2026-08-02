/**
 * `terminal.images` — the inline images a pane emitted, structurally
 * (docs/reference/alab-agent-visibility.md §6).
 *
 * Why this is worth a verb: everything else a driver can read from a pane is
 * text. A program that draws a plot, a QR code or a screenshot inline puts
 * NOTHING in the text rows, so every text-shaped verb reports an accurate,
 * complete, and entirely misleading blank. The engine has held those payloads
 * all along, one `Arc<ImageData>` per placement.
 *
 * Two design decisions worth stating, because both look like limitations and are
 * not:
 *
 * * **Metadata by default.** A single placement can be megabytes and this
 *   crosses a JSON-RPC socket. A caller sees position, footprint, format, size
 *   and identity for free, and asks for bytes when it has decided which image it
 *   wants.
 * * **Oversized payloads are withheld whole.** Never truncated. Half a PNG is
 *   not a smaller PNG; returning a prefix would trade a clear refusal for a
 *   decode failure at the caller.
 *
 * Pure module: the engine is injected, so the budget arithmetic and every
 * honesty branch are testable without an addon.
 */
import {
  TERMINAL_ALT_SCREEN_GRAPHICS_BLIND_SPOT,
  TERMINAL_INLINE_IMAGES_SCHEMA_VERSION,
  type TerminalInlineImage,
  type TerminalInlineImageFormat,
  type TerminalInlineImagePayloadState,
  type TerminalInlineImagesResult,
  type TerminalInlineImagesUnavailableReason
} from '../../shared/terminal-inline-images-protocol'
import { TERMINAL_SCROLLED_OFF_GRAPHICS_BLIND_SPOT } from '../../shared/terminal-context-protocol'
import type {
  EmulatorInlineImageRead,
  EmulatorInlineImageRequest
} from '../daemon/emulator-inline-images'
import type { RustInlineImage } from '../daemon/rust-terminal-addon'

/** Enough for a plot or a screenshot; small enough that a caller who asked for
 *  "the images" without thinking does not move a megabyte per placement. */
export const TERMINAL_IMAGES_DEFAULT_MAX_BYTES_PER_IMAGE = 256 * 1024
/** The engine accepts payloads up to 16 MiB; base64 inflates by 4/3, so the
 *  ceiling here is what one response may reasonably carry, not what it holds. */
export const TERMINAL_IMAGES_MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024
export const TERMINAL_IMAGES_DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024
export const TERMINAL_IMAGES_MAX_TOTAL_BYTES = 8 * 1024 * 1024
/** A pane could in principle carry hundreds of placements; the list is bounded
 *  so metadata alone cannot make an unbounded response. */
export const TERMINAL_IMAGES_MAX_PLACEMENTS = 128

const BLIND_SPOTS = [TERMINAL_SCROLLED_OFF_GRAPHICS_BLIND_SPOT]

export type TerminalInlineImagesSource = {
  gridRows: number
  gridCols: number
  /** The alt grid has no scrollback of its own and the retained history belongs to
   *  the main screen, so an empty result here is a narrower claim. */
  alternateScreen: boolean
  /** Retained history rows — the region images cannot be read from. Null when
   *  the engine could not report its depth. */
  scrollbackRows: number | null
  read: (request: EmulatorInlineImageRequest) => EmulatorInlineImageRead
}

export type TerminalInlineImagesOptions = {
  includeBytes?: boolean
  maxBytesPerImage?: number
  maxTotalBytes?: number
}

function clampBudget(requested: number | undefined, fallback: number, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return fallback
  }
  return Math.min(Math.floor(requested), ceiling)
}

const FORMATS: Record<string, TerminalInlineImageFormat> = {
  png: 'png',
  rgba8: 'rgba8',
  unknown: 'unknown'
}

const PAYLOAD_STATES: Record<string, TerminalInlineImagePayloadState> = {
  included: 'included',
  'not-requested': 'not-requested',
  'too-large': 'too-large',
  'budget-exhausted': 'budget-exhausted'
}

/** Narrow the addon's plain strings. An unrecognised token degrades to the
 *  honest end of each vocabulary rather than being asserted through: a future
 *  addon adding a format must not make this build claim it decoded one. */
function toWireImage(image: RustInlineImage): TerminalInlineImage {
  const payloadState = PAYLOAD_STATES[image.payloadState] ?? 'not-requested'
  const footprint = image.cellRows * image.cellCols
  return {
    row: image.row,
    col: image.col,
    cellRows: image.cellRows,
    cellCols: image.cellCols,
    coveredCells: image.coveredCells,
    clipped: image.coveredCells < footprint,
    format: FORMATS[image.format] ?? 'unknown',
    pixelWidth: image.pixelWidth ?? null,
    pixelHeight: image.pixelHeight ?? null,
    byteLength: image.byteLen,
    zIndex: image.zIndex,
    fingerprint: image.fingerprint,
    payloadState,
    base64: payloadState === 'included' ? (image.base64 ?? null) : null
  }
}

function unavailable(
  reason: TerminalInlineImagesUnavailableReason,
  budgets: { includeBytes: boolean; maxBytesPerImage: number; maxTotalBytes: number }
): TerminalInlineImagesResult {
  return {
    schema: TERMINAL_INLINE_IMAGES_SCHEMA_VERSION,
    available: false,
    unavailable: reason,
    images: [],
    totalPlacements: 0,
    gridRows: null,
    gridCols: null,
    unscannableHistoryRows: null,
    bytesRequested: budgets.includeBytes,
    maxBytesPerImage: budgets.maxBytesPerImage,
    maxTotalBytes: budgets.maxTotalBytes,
    bytesReturned: 0,
    blindSpots: BLIND_SPOTS
  }
}

export function buildTerminalInlineImagesResult(
  source: TerminalInlineImagesSource | null,
  opts: TerminalInlineImagesOptions = {}
): TerminalInlineImagesResult {
  const request: EmulatorInlineImageRequest = {
    includeBytes: opts.includeBytes === true,
    maxBytesPerImage: clampBudget(
      opts.maxBytesPerImage,
      TERMINAL_IMAGES_DEFAULT_MAX_BYTES_PER_IMAGE,
      TERMINAL_IMAGES_MAX_BYTES_PER_IMAGE
    ),
    maxTotalBytes: clampBudget(
      opts.maxTotalBytes,
      TERMINAL_IMAGES_DEFAULT_MAX_TOTAL_BYTES,
      TERMINAL_IMAGES_MAX_TOTAL_BYTES
    )
  }
  if (!source) {
    return unavailable('no-headless-engine', request)
  }
  const read = source.read(request)
  if (read.outcome === 'unsupported') {
    // The distinction the whole verb turns on: this build has no image binding,
    // which is not the same claim as "this pane has no images".
    return unavailable('addon-too-old', request)
  }
  if (read.outcome === 'unreadable') {
    return unavailable('engine-unavailable', request)
  }
  const images = read.images.slice(0, TERMINAL_IMAGES_MAX_PLACEMENTS).map(toWireImage)
  return {
    schema: TERMINAL_INLINE_IMAGES_SCHEMA_VERSION,
    available: true,
    images,
    // The cap must be visible: a short list that looks complete is the same
    // failure as an empty one that looks like a fact.
    totalPlacements: read.images.length,
    gridRows: source.gridRows,
    gridCols: source.gridCols,
    // Why this rides on every result, including a full one: it is the size of
    // the region that CANNOT be scanned, so a caller can weigh any answer —
    // empty or not — against how much history it did not get to look at.
    // On the alt screen the retained rows belong to the OTHER screen, so
    // reporting them here would answer a question the caller did not ask; null
    // is the honest "unknown", and the alt-screen blind spot says why.
    unscannableHistoryRows: source.alternateScreen ? null : source.scrollbackRows,
    bytesRequested: request.includeBytes,
    maxBytesPerImage: request.maxBytesPerImage,
    maxTotalBytes: request.maxTotalBytes,
    bytesReturned: images.reduce(
      (total, image) => (image.payloadState === 'included' ? total + image.byteLength : total),
      0
    ),
    blindSpots: source.alternateScreen
      ? [...BLIND_SPOTS, TERMINAL_ALT_SCREEN_GRAPHICS_BLIND_SPOT]
      : BLIND_SPOTS
  }
}
