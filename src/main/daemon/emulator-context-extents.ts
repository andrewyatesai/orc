// Engine extents a windowed context read needs — retained history depth and the
// visible cursor — split from headless-emulator.ts (line budget), like the
// scrollback-search bridge next to it. One engine hop for both, because
// `terminal.agentView` reports them together and a second hop could observe a
// different settled state.
import type { RustHeadlessTerminalHandle } from './rust-terminal-addon'

export type EmulatorContextExtents = {
  /** Retained history rows above the visible grid; null when unreadable. */
  scrollbackRows: number | null
  /** Zero-based visible-grid cursor; null when unreadable. */
  cursor: { row: number; col: number } | null
}

/** The degraded answer: "could not read", explicitly distinct from an empty
 *  scrollback or a home-position cursor. */
export const UNREADABLE_CONTEXT_EXTENTS: EmulatorContextExtents = {
  scrollbackRows: null,
  cursor: null
}

export function readEmulatorContextExtents(
  term: RustHeadlessTerminalHandle
): EmulatorContextExtents {
  const [row, col] = term.cursor()
  return {
    scrollbackRows: term.scrollbackLen(),
    cursor: { row: row ?? 0, col: col ?? 0 }
  }
}
