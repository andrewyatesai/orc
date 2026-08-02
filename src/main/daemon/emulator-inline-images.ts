// Inline-image placements read off the headless engine's VISIBLE grid, split
// from headless-emulator.ts (line budget) like the scrollback-search and
// context-extents bridges beside it.
//
// The three-way outcome is the point of the module: a driver must be able to
// separate "no images on this grid" from "this addon has no image binding" from
// "this engine is poisoned". Collapsing any of those into an empty array would
// hand back a blind spot dressed as a fact.
import type { RustHeadlessTerminalHandle, RustInlineImage } from './rust-terminal-addon'

export type EmulatorInlineImageRequest = {
  includeBytes: boolean
  maxBytesPerImage: number
  maxTotalBytes: number
}

export type EmulatorInlineImageRead =
  | { outcome: 'images'; images: RustInlineImage[] }
  /** The addon predates `terminal.images`: this build cannot see images at all. */
  | { outcome: 'unsupported' }
  /** A live engine exists but could not answer (disposed, or poisoned by an
   *  earlier native panic). */
  | { outcome: 'unreadable' }

export const UNREADABLE_INLINE_IMAGES: EmulatorInlineImageRead = { outcome: 'unreadable' }

export function readEmulatorInlineImages(
  term: RustHeadlessTerminalHandle,
  request: EmulatorInlineImageRequest
): EmulatorInlineImageRead {
  const read = term.inlineImages?.bind(term)
  if (!read) {
    return { outcome: 'unsupported' }
  }
  return {
    outcome: 'images',
    images: read(request.includeBytes, request.maxBytesPerImage, request.maxTotalBytes)
  }
}
