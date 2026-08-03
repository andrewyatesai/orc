// The styled visible grid read off the headless engine, split from
// headless-emulator.ts (line budget) like the inline-image and scrollback-search
// bridges beside it.
//
// The four-way outcome is the module's reason to exist. "The screen is blank"
// and "this build cannot read screens" and "this engine is poisoned" would all
// collapse into an empty grid, and a driver that cannot tell them apart will
// happily press keys against a screen it never saw.
import type { RustHeadlessTerminalHandle, RustStyledFrame } from './rust-terminal-addon'

export type EmulatorStyledFrameRequest = {
  detail: 'compact' | 'full'
  fromRow: number
  /** 0 = every row from `fromRow` to the bottom. */
  rowCount: number
  /** 0 = unbounded. Cuts WHOLE rows; the first requested row always survives. */
  maxRuns: number
}

export type EmulatorStyledFrameRead =
  | { outcome: 'frame'; frame: RustStyledFrame }
  /** The addon predates `terminal.screen`: this build cannot read any screen. */
  | { outcome: 'unsupported' }
  /** A live engine exists but could not answer (disposed, or poisoned by an
   *  earlier native panic). */
  | { outcome: 'unreadable' }

export const UNREADABLE_STYLED_FRAME: EmulatorStyledFrameRead = { outcome: 'unreadable' }

export function readEmulatorStyledFrame(
  term: RustHeadlessTerminalHandle,
  request: EmulatorStyledFrameRequest
): EmulatorStyledFrameRead {
  const read = term.styledFrame?.bind(term)
  if (!read) {
    return { outcome: 'unsupported' }
  }
  const frame = read(request.detail, request.fromRow, request.rowCount, request.maxRuns)
  // The addon returns null for a disposed engine rather than a zeroed frame,
  // so a 0x0 "blank screen" can never be fabricated here.
  return frame ? { outcome: 'frame', frame } : UNREADABLE_STYLED_FRAME
}
