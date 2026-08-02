/**
 * Wire assembly for `terminal.blocks` / `terminal.blockText`: turns the ledger's
 * transcript-cursor boundaries into results, and slices a block's output out of
 * the retained transcript the same way `terminal.read --cursor` would.
 *
 * The outcome vocabulary mirrors aterm's `BlockText { Text | Evicted |
 * NotAvailable }` (blocks_api.rs:27) on purpose: a block whose output has aged
 * out of the transcript must say so, never come back silently empty.
 *
 * Pure module: transcript state is injected.
 */
import {
  TERMINAL_AGENT_COLLAPSED_OUTPUT_BLIND_SPOT,
  TERMINAL_CONTEXT_SCHEMA_VERSION,
  TERMINAL_GRAPHICS_BLIND_SPOT,
  type TerminalCommandBlockSummary,
  type TerminalCommandBlockText,
  type TerminalCommandBlocksResult
} from '../../shared/terminal-context-protocol'
import type {
  TerminalCommandBlockRecord,
  TerminalCommandBlockSnapshot
} from './terminal-command-blocks'

/** The retained completed-line transcript for one PTY — the same buffer
 *  `terminal.read` pages, so block cursors and read cursors are one space. */
export type TerminalTranscriptWindow = {
  lines: readonly string[]
  /** Completed lines ever produced; equals `terminal.read`'s latestCursor. */
  linesTotal: number
}

export const TERMINAL_BLOCK_TEXT_DEFAULT_LINES = 500
export const TERMINAL_BLOCK_TEXT_MAX_LINES = 2000
export const TERMINAL_BLOCK_TEXT_MAX_CHARS = 256 * 1024

const BLIND_SPOTS = [TERMINAL_GRAPHICS_BLIND_SPOT, TERMINAL_AGENT_COLLAPSED_OUTPUT_BLIND_SPOT]

export function toBlockSummary(block: TerminalCommandBlockRecord): TerminalCommandBlockSummary {
  return {
    index: block.index,
    command: block.command,
    exitCode: block.exitCode,
    running: block.endCursor === null,
    startCursor: String(block.startCursor),
    endCursor: block.endCursor === null ? null : String(block.endCursor),
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    outputLineCount: block.endCursor === null ? null : block.endCursor - block.startCursor
  }
}

export function buildTerminalCommandBlocksResult(
  snapshot: TerminalCommandBlockSnapshot,
  transcript: TerminalTranscriptWindow | null
): TerminalCommandBlocksResult {
  if (!transcript) {
    return {
      schema: TERMINAL_CONTEXT_SCHEMA_VERSION,
      available: false,
      unavailable: 'no-pty-record',
      blocks: [],
      totalObserved: snapshot.totalObserved,
      evictedCount: snapshot.evictedCount,
      oldestCursor: '0',
      latestCursor: '0',
      shellIntegrationSeen: snapshot.shellIntegrationSeen,
      blindSpots: BLIND_SPOTS
    }
  }
  // Why: after the PTY exits the transcript is wiped but the block records survive, so
  // a naive result declares `latestCursor: 0` while listing blocks that end far past it —
  // internally incoherent, and it invites a caller to fetch text that cannot be read.
  // The blocks are still worth returning (they say WHAT ran); the text is not available.
  const linesReadable = transcript.linesTotal > 0 || snapshot.blocks.length === 0
  return {
    schema: TERMINAL_CONTEXT_SCHEMA_VERSION,
    available: linesReadable,
    ...(linesReadable ? {} : { unavailable: 'transcript-wiped' as const }),
    blocks: snapshot.blocks.map(toBlockSummary),
    totalObserved: snapshot.totalObserved,
    evictedCount: snapshot.evictedCount,
    oldestCursor: String(oldestCursorOf(transcript)),
    latestCursor: String(transcript.linesTotal),
    shellIntegrationSeen: snapshot.shellIntegrationSeen,
    blindSpots: BLIND_SPOTS
  }
}

function oldestCursorOf(transcript: TerminalTranscriptWindow): number {
  return Math.max(0, transcript.linesTotal - transcript.lines.length)
}

function emptyBlockText(
  outcome: TerminalCommandBlockText['outcome'],
  block: TerminalCommandBlockSummary | null
): TerminalCommandBlockText {
  return {
    schema: TERMINAL_CONTEXT_SCHEMA_VERSION,
    outcome,
    block,
    lines: [],
    firstCursor: null,
    nextCursor: null,
    running: block?.running === true,
    truncated: outcome === 'evicted',
    limited: false,
    blindSpots: BLIND_SPOTS
  }
}

export function buildTerminalCommandBlockText(
  block: TerminalCommandBlockRecord | null,
  transcript: TerminalTranscriptWindow | null,
  opts: { limit?: number } = {}
): TerminalCommandBlockText {
  if (!transcript) {
    return emptyBlockText('no-pty-record', block ? toBlockSummary(block) : null)
  }
  if (!block) {
    return emptyBlockText('no-such-block', null)
  }
  const summary = toBlockSummary(block)
  const oldestCursor = oldestCursorOf(transcript)
  // A running block's output ends at the live edge; a finished one at its D.
  const endCursor = block.endCursor ?? transcript.linesTotal
  // Why both bounds: a block that starts at or above the floor is fully
  // readable; only one whose whole range fell below it is gone.
  if (block.startCursor < oldestCursor && endCursor <= oldestCursor) {
    return emptyBlockText('evicted', summary)
  }
  const startCursor = Math.max(block.startCursor, oldestCursor)
  const limit = clampBlockTextLines(opts.limit)
  const available = transcript.lines.slice(
    startCursor - oldestCursor,
    Math.max(startCursor, endCursor) - oldestCursor
  )
  // Why: a wiped transcript (the PTY exited, or the buffer was cleared) leaves the
  // window empty while the block still declares output rows. Falling through would
  // answer "that command printed nothing" — the one reading a driver must never get
  // wrong, because it looks like a fact instead of a blind spot.
  if (available.length === 0 && endCursor > block.startCursor) {
    return emptyBlockText('evicted', summary)
  }
  const bounded = available.slice(0, limit)
  const { lines, limited } = applyBlockTextCharacterBudget(bounded)
  return {
    schema: TERMINAL_CONTEXT_SCHEMA_VERSION,
    outcome: 'text',
    block: summary,
    lines,
    firstCursor: String(startCursor),
    nextCursor: String(startCursor + lines.length),
    running: summary.running,
    // Why separate from `evicted`: part of the block survives, and a caller
    // that cannot tell a clipped head from a complete one will misread output.
    truncated: block.startCursor < oldestCursor,
    limited: limited || bounded.length < available.length,
    blindSpots: BLIND_SPOTS
  }
}

export function clampBlockTextLines(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return TERMINAL_BLOCK_TEXT_DEFAULT_LINES
  }
  return Math.min(Math.floor(requested), TERMINAL_BLOCK_TEXT_MAX_LINES)
}

function applyBlockTextCharacterBudget(source: readonly string[]): {
  lines: string[]
  limited: boolean
} {
  const lines: string[] = []
  let characters = 0
  for (const line of source) {
    if (lines.length > 0 && characters + line.length > TERMINAL_BLOCK_TEXT_MAX_CHARS) {
      return { lines, limited: true }
    }
    lines.push(line)
    characters += line.length
  }
  return { lines, limited: false }
}
