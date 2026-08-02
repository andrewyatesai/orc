/**
 * Human-readable rendering for `orca terminal images`.
 *
 * The whole point of the verb survives or dies in this file: three different
 * situations all produce zero images, and the plain-text view must say which one
 * it is. "No inline images" as a bare sentence would be the exact blind-spot-as-
 * fact failure the JSON shape was designed to prevent.
 */
import type {
  TerminalInlineImage,
  TerminalInlineImagesResult
} from '../shared/terminal-inline-images-protocol'

const UNAVAILABLE_DETAIL: Record<string, string> = {
  'no-headless-engine':
    'this pane has no live engine (parked, cold, or not yet hydrated) — not that it has no images',
  'engine-unavailable': 'the engine for this pane could not answer',
  'addon-too-old':
    'this build has no image binding — it cannot see inline images at all, on any pane'
}

function dimensions(image: TerminalInlineImage): string {
  if (image.pixelWidth === null || image.pixelHeight === null) {
    return `${image.cellCols}x${image.cellRows} cells`
  }
  return `${image.cellCols}x${image.cellRows} cells, ${image.pixelWidth}x${image.pixelHeight}px`
}

function payloadNote(image: TerminalInlineImage): string {
  switch (image.payloadState) {
    case 'included':
      return 'bytes included'
    case 'not-requested':
      return 'metadata only (--bytes for the payload)'
    case 'too-large':
      return 'bytes withheld: over the per-image cap (raise --max-bytes)'
    case 'budget-exhausted':
      return 'bytes withheld: the total budget was spent (raise --max-total-bytes)'
  }
}

function formatImage(image: TerminalInlineImage, index: number): string {
  const clipped = image.clipped
    ? `, clipped (${image.coveredCells} of ${image.cellRows * image.cellCols} cells on screen)`
    : ''
  return [
    `#${index}  at row ${image.row} col ${image.col}  ${image.format}  ${dimensions(image)}${clipped}`,
    `    ${image.byteLength} bytes  fingerprint ${image.fingerprint}  ${payloadNote(image)}`
  ].join('\n')
}

/** The sentence a caller must read before trusting an empty list. */
function scanScope(result: TerminalInlineImagesResult): string {
  const unscannable = result.unscannableHistoryRows
  if (unscannable === null) {
    return 'Scope: the visible grid. History depth is unreadable, so how much scrolled-off content could not be scanned is unknown.'
  }
  if (unscannable === 0) {
    return 'Scope: the visible grid, and nothing has scrolled off this pane yet — so this is the whole picture.'
  }
  return `Scope: the visible grid only. ${unscannable} row(s) have scrolled into history, where the engine keeps text and discards image payloads — an image that was there is unrecoverable.`
}

export function formatTerminalImages(result: TerminalInlineImagesResult): string {
  if (!result.available) {
    const reason = result.unavailable ?? 'unknown'
    return `Images unavailable: ${reason} — ${UNAVAILABLE_DETAIL[reason] ?? 'cause not reported'}.`
  }
  const grid = `grid ${result.gridCols}x${result.gridRows}`
  if (result.images.length === 0) {
    return `No inline images on the visible grid (${grid}).\n${scanScope(result)}`
  }
  const body = result.images.map(formatImage).join('\n')
  const budget = result.bytesRequested
    ? `\n${result.bytesReturned} payload bytes returned (caps: ${result.maxBytesPerImage}/image, ${result.maxTotalBytes} total)`
    : ''
  const capped =
    result.totalPlacements > result.images.length
      ? ` — showing ${result.images.length} of ${result.totalPlacements}, the rest were cut by the per-response cap`
      : ''
  return `${result.images.length} inline image(s) on the visible grid (${grid})${capped}.\n${scanScope(result)}\n\n${body}${budget}`
}
