/**
 * `terminal.agentView` — one round trip that answers "what would a human see if
 * they looked at this pane right now": the visible screen, the agent's state,
 * the last command block, and whether there is history above.
 *
 * Why one verb instead of four: a manager AI orienting on a worker pane
 * otherwise pays four round trips (read + agentStatus + blocks + history) and
 * stitches together four *different* instants. This composes them from one
 * settled read of the same pane.
 *
 * What it is NOT: a lossless screen. The rows are the engine's plain-text grid
 * snapshot — no colour, no attributes, no inline images — so the result names
 * those blind spots rather than letting a caller assume it saw everything.
 *
 * Pure module: every part is injected.
 */
import {
  TERMINAL_AGENT_COLLAPSED_OUTPUT_BLIND_SPOT,
  TERMINAL_CONTEXT_SCHEMA_VERSION,
  TERMINAL_GRAPHICS_BLIND_SPOT,
  TERMINAL_SCROLLBACK_STYLES_BLIND_SPOT,
  TERMINAL_VIDEO_BLIND_SPOT,
  type TerminalAgentView
} from '../../shared/terminal-context-protocol'
import type {
  RuntimeTerminalAgentStatusState,
  RuntimeTerminalState
} from '../../shared/runtime-types'
import { toBlockSummary, type TerminalTranscriptWindow } from './terminal-command-block-reads'
import type { TerminalCommandBlockRecord } from './terminal-command-blocks'

/** Bounded because a very tall pane still has to fit a single response
 *  alongside the rest of the view. */
export const TERMINAL_AGENT_VIEW_MAX_SCREEN_ROWS = 200
export const TERMINAL_AGENT_VIEW_MAX_ROW_CHARS = 2048

export type TerminalAgentViewScreenParts = {
  rows: string[]
  cols: number
  rowCount: number
  cursor: { row: number; col: number } | null
  alternateScreen: boolean
}

export type TerminalAgentViewParts = {
  handle: string
  status: RuntimeTerminalState
  /** Null when the pane has no live headless engine (parked, cold, or remote
   *  without a hydrated emulator) — reported, never faked from the transcript. */
  screen: TerminalAgentViewScreenParts | null
  agent: { isRunningAgent: boolean; status: RuntimeTerminalAgentStatusState }
  lastBlock: TerminalCommandBlockRecord | null
  scrollback: {
    originRow: number | null
    scrollbackRows: number | null
  } | null
  transcript: TerminalTranscriptWindow | null
}

const BLIND_SPOTS = [
  TERMINAL_SCROLLBACK_STYLES_BLIND_SPOT,
  TERMINAL_GRAPHICS_BLIND_SPOT,
  TERMINAL_VIDEO_BLIND_SPOT,
  TERMINAL_AGENT_COLLAPSED_OUTPUT_BLIND_SPOT
]

function boundScreenRows(rows: string[]): string[] {
  // Why the tail and not the head: the newest rows are where an agent's prompt,
  // spinner and question live — the part a driver has to act on.
  const bounded =
    rows.length > TERMINAL_AGENT_VIEW_MAX_SCREEN_ROWS
      ? rows.slice(rows.length - TERMINAL_AGENT_VIEW_MAX_SCREEN_ROWS)
      : rows
  return bounded.map((row) =>
    row.length > TERMINAL_AGENT_VIEW_MAX_ROW_CHARS
      ? row.slice(0, TERMINAL_AGENT_VIEW_MAX_ROW_CHARS)
      : row
  )
}

export function buildTerminalAgentView(parts: TerminalAgentViewParts): TerminalAgentView {
  const screen = parts.screen
  const scrollbackRows = parts.scrollback?.scrollbackRows ?? null
  const originRow = parts.scrollback?.originRow ?? null
  const gridRows = screen?.rowCount ?? 0
  const historyAvailable = originRow !== null && scrollbackRows !== null
  return {
    schema: TERMINAL_CONTEXT_SCHEMA_VERSION,
    handle: parts.handle,
    status: parts.status,
    screen: screen
      ? {
          available: true,
          rows: boundScreenRows(screen.rows),
          cols: screen.cols,
          rowCount: screen.rowCount,
          cursor: screen.cursor,
          alternateScreen: screen.alternateScreen
        }
      : {
          available: false,
          rows: [],
          cols: null,
          rowCount: null,
          cursor: null,
          alternateScreen: false
        },
    agent: parts.agent,
    lastBlock: parts.lastBlock ? toBlockSummary(parts.lastBlock) : null,
    history: {
      available: historyAvailable,
      oldestHostRow: historyAvailable ? originRow : null,
      // The newest addressable row is the last row of the grid, not of history.
      latestHostRow:
        historyAvailable && scrollbackRows + gridRows > 0
          ? originRow + scrollbackRows + gridRows - 1
          : null,
      scrollbackRows: scrollbackRows ?? 0,
      hasMoreAbove: (scrollbackRows ?? 0) > 0
    },
    latestCursor: parts.transcript ? String(parts.transcript.linesTotal) : null,
    blindSpots: BLIND_SPOTS
  }
}
