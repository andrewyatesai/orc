/**
 * Wire types for the agent-visibility context verbs — `terminal.history`,
 * `terminal.blocks`, `terminal.blockText` and `terminal.agentView`.
 *
 * Shared so the runtime (producer) and the CLI (formatter) agree on the honesty
 * fields. Every result names what it could NOT see instead of returning a
 * plausible-looking empty: a driving AI must be able to tell "there is no image
 * here" from "I cannot see images". See docs/reference/alab-agent-visibility.md.
 *
 * Two cursor spaces meet here, deliberately, each matching the verb it composes
 * with:
 *   * `hostRow` (number) — the engine's eviction-stable absolute row, the same
 *     coordinate `terminal.search` returns, so a match row feeds `--from`.
 *   * `cursor` (string) — the retained-transcript position `terminal.read`
 *     pages over, so a block boundary feeds `terminal read --cursor`.
 */
import type { RuntimeTerminalAgentStatusState, RuntimeTerminalState } from './runtime-types'

export const TERMINAL_CONTEXT_SCHEMA_VERSION = 1

/** A channel this runtime cannot serve, named rather than silently omitted
 *  (§9 of the visibility map — the no-silent-downgrade rule `terminal.await`
 *  already follows for unproducible fact kinds). */
export type TerminalContextBlindSpot = {
  capability:
    | 'styles'
    | 'graphics'
    | 'video'
    | 'agent-collapsed-output'
    /** What the pane is painting right now, as opposed to what the agent has
     *  already committed to its transcript — see agent-transcript-protocol.ts. */
    | 'agent-screen-state'
  /** Machine token; stable across releases. */
  reason: string
  /** One sentence naming the cause, for a human reading `--json` output. */
  detail: string
}

export const TERMINAL_SCROLLBACK_STYLES_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'styles',
  reason: 'engine-scrollback-is-text-only',
  detail:
    'The headless engine stores scrolled-off rows as text (set_scrollback_text_only): colour and attributes are dropped on scroll-off, so history rows are plain text.'
}

/** Text-shaped results carry no pixels, and the engine keeps image payloads only
 *  while they are on the visible grid. `terminal.images` closes the first half
 *  of that; nothing can close the second. */
export const TERMINAL_GRAPHICS_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'graphics',
  reason: 'images-not-in-text-rows',
  detail:
    'These rows are plain text: an inline sixel/OSC-1337/Kitty image on them is not represented here. Read terminal.images for what is on the visible grid — and note the engine discards image payloads once a row scrolls off, so an image already in history is unrecoverable.'
}

/** The one image blind spot no accessor can close, stated where `terminal.images`
 *  returns an empty list. */
export const TERMINAL_SCROLLED_OFF_GRAPHICS_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'graphics',
  reason: 'images-dropped-on-scroll-off',
  detail:
    'The headless engine stores scrolled-off rows as text (set_scrollback_text_only), which keeps hyperlink spans and discards inline-image payloads. Only images still on the visible grid are readable, and there is no way to know retroactively that one was there.'
}

export const TERMINAL_VIDEO_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'video',
  reason: 'requires-present-path',
  detail:
    'Frame-sequence capture taps a GPU present path that only aterm-gui owns; Orca serves ordered transitions through terminal.await and the event journal instead.'
}

export const TERMINAL_AGENT_COLLAPSED_OUTPUT_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'agent-collapsed-output',
  reason: 'bytes-never-written',
  detail:
    'When an agent TUI prints "… +N lines" those lines were never written to the PTY, so no terminal surface can expand them; read the agent\'s own transcript or press its expand key instead.'
}

/** Why the window could not be served at all. `available:false` is never an
 *  error — a parked or cold pane simply has no live engine to page. */
export type TerminalHistoryUnavailableReason =
  | 'no-headless-engine'
  | 'engine-unavailable'
  | 'addon-too-old'

export type TerminalHistoryWindow = {
  schema: number
  available: boolean
  unavailable?: TerminalHistoryUnavailableReason
  /** Plain text rows, oldest first. */
  rows: string[]
  /** Stable host row of `rows[0]`, or null when nothing was returned. */
  firstHostRow: number | null
  /** Feed as `--from` to page one window OLDER; null at the retained floor. */
  previousHostRow: number | null
  /** Feed as `--from` to page one window NEWER; null at the live edge. */
  nextHostRow: number | null
  /** Oldest row the engine still retains. */
  oldestHostRow: number | null
  /** Newest addressable row — the last row of the visible grid, not of history. */
  latestHostRow: number | null
  /** Retained history rows plus the visible grid rows. */
  totalRows: number
  /** Rows above this window that are still retained. */
  hasMoreAbove: boolean
  /** Rows below this window (up to and including the visible grid). */
  hasMoreBelow: boolean
  /** The requested `from` was below the retained floor and got clamped up. */
  evicted: boolean
  /** The byte budget cut rows the window would otherwise have carried. */
  limited: boolean
  cols: number | null
  alternateScreen: boolean
  blindSpots: TerminalContextBlindSpot[]
}

/** One OSC-133 shell command block. Boundaries are retained-transcript cursors,
 *  so `terminal read --cursor <startCursor> --limit N` replays the same text. */
export type TerminalCommandBlockSummary = {
  /** Monotone per PTY; never reused, so it survives ledger eviction. */
  index: number
  /** From OSC 633;E when the shell hooks emitted it, else null. */
  command: string | null
  exitCode: number | null
  running: boolean
  startCursor: string
  endCursor: string | null
  startedAt: number
  endedAt: number | null
  /** Completed output lines, or null while the block is still running. */
  outputLineCount: number | null
}

export type TerminalCommandBlocksResult = {
  schema: number
  available: boolean
  /** Set when the pane has no live transcript record to anchor cursors in. */
  /** Why the block TEXT cannot be read. `transcript-wiped` still returns the block
   *  list — a driver learns WHAT ran even when the output is gone. */
  unavailable?: 'no-pty-record' | 'transcript-wiped'
  /** Newest last, matching reading order. */
  blocks: TerminalCommandBlockSummary[]
  /** Blocks observed since this PTY started, including evicted ones. */
  totalObserved: number
  /** Blocks the ledger cap dropped; their text may still be in the transcript. */
  evictedCount: number
  /** Transcript floor: cursors below this can no longer be read back. */
  oldestCursor: string
  latestCursor: string
  /** True once any OSC-133 command start has been seen on this pane. False
   *  means either no command has run yet or the shell emits no OSC 133 —
   *  the two are indistinguishable from the byte stream, and an agent CLI is
   *  ONE block for its whole session. */
  shellIntegrationSeen: boolean
  blindSpots: TerminalContextBlindSpot[]
}

/** Mirrors aterm's `BlockText { Text | Evicted | NotAvailable }`: never a
 *  silently-empty answer. */
export type TerminalCommandBlockTextOutcome = 'text' | 'evicted' | 'no-such-block' | 'no-pty-record'

export type TerminalCommandBlockText = {
  schema: number
  outcome: TerminalCommandBlockTextOutcome
  block: TerminalCommandBlockSummary | null
  lines: string[]
  firstCursor: string | null
  nextCursor: string | null
  /** The block is still running: `lines` is what has landed so far. */
  running: boolean
  /** Older output of this block aged out of the retained transcript. */
  truncated: boolean
  /** The row/byte budget cut the tail of this block's output. */
  limited: boolean
  blindSpots: TerminalContextBlindSpot[]
}

export type TerminalAgentViewScreen = {
  available: boolean
  /** Visible grid rows as plain text, top row first. */
  rows: string[]
  cols: number | null
  rowCount: number | null
  cursor: { row: number; col: number } | null
  alternateScreen: boolean
}

export type TerminalAgentViewHistory = {
  available: boolean
  oldestHostRow: number | null
  latestHostRow: number | null
  /** Retained history rows above the visible grid. */
  scrollbackRows: number
  /** There is retained history above the visible grid to page into. */
  hasMoreAbove: boolean
}

/** One round trip that answers "what would a human see if they looked at this
 *  pane right now": the screen, the agent's state, the last command block, and
 *  whether there is more above. */
export type TerminalAgentView = {
  schema: number
  handle: string
  status: RuntimeTerminalState
  screen: TerminalAgentViewScreen
  agent: {
    isRunningAgent: boolean
    status: RuntimeTerminalAgentStatusState
  }
  lastBlock: TerminalCommandBlockSummary | null
  history: TerminalAgentViewHistory
  /** Transcript position a follow-up `terminal read --cursor` should resume at. */
  latestCursor: string | null
  blindSpots: TerminalContextBlindSpot[]
}
