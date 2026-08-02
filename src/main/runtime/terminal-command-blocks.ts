/**
 * Per-PTY OSC-133 command-block ledger — the shell-level half of "expanding
 * collapsed portions" (§5.1 of docs/reference/alab-agent-visibility.md).
 *
 * Why main-side and not the engine: aterm-core models blocks completely
 * (`blocks_api.rs`) but nothing crosses the napi boundary, and the engine's
 * block rows are grid rows, while the coordinate a caller can actually re-read
 * is the retained-transcript position `terminal.read --cursor` pages over.
 * Recording boundaries in transcript cursors makes `terminal.blockText` and
 * `terminal.read` the same text by construction rather than by coincidence.
 *
 * Honesty limit, stated up front: an agent CLI is ONE block. `claude` is
 * launched once, so 133;C fires once and 133;D when it exits. Blocks are a
 * shell-pane feature and move nothing for a pane already inside an agent TUI.
 *
 * Pure module: no runtime imports, no Electron.
 */
import {
  createTerminalCommandMarkerScanner,
  type TerminalChunkTranscriptFrame,
  type TerminalCommandMarkerScanner
} from './terminal-command-block-markers'

/** Bounded like the event journal: a long-lived shell pane must not grow an
 *  unbounded ledger, and a driver only ever asks about recent commands. */
export const MAX_RETAINED_COMMAND_BLOCKS = 128

export type TerminalCommandBlockRecord = {
  index: number
  command: string | null
  exitCode: number | null
  startCursor: number
  endCursor: number | null
  startedAt: number
  endedAt: number | null
}

export type TerminalCommandBlockSnapshot = {
  blocks: TerminalCommandBlockRecord[]
  totalObserved: number
  evictedCount: number
  shellIntegrationSeen: boolean
}

type PtyBlockState = {
  scanner: TerminalCommandMarkerScanner
  pendingCommand: string | null
  open: TerminalCommandBlockRecord | null
  blocks: TerminalCommandBlockRecord[]
  totalObserved: number
  evictedCount: number
}

function emptyState(): PtyBlockState {
  return {
    scanner: createTerminalCommandMarkerScanner(),
    pendingCommand: null,
    open: null,
    blocks: [],
    totalObserved: 0,
    evictedCount: 0
  }
}

export class TerminalCommandBlockLedger {
  private byPty = new Map<string, PtyBlockState>()

  /** Feed one raw PTY chunk with the transcript counters that framed it.
   *  Cheap on the overwhelming majority of chunks — one `indexOf` and out. */
  ingest(ptyId: string, data: string, frame: TerminalChunkTranscriptFrame & { at: number }): void {
    const existing = this.byPty.get(ptyId)
    // Why ESC and not the full `\x1b]` introducer: a chunk can END on the ESC,
    // and the scanner's carry is what stitches it to the next chunk — so state
    // has to exist by then. Pure-text panes still allocate nothing.
    if (!existing && !data.includes('\x1b')) {
      return
    }
    const state = existing ?? emptyState()
    if (!existing) {
      this.byPty.set(ptyId, state)
    }
    for (const marker of state.scanner.scan(data, frame)) {
      this.applyMarker(state, marker, frame.at)
    }
  }

  private applyMarker(
    state: PtyBlockState,
    marker: ReturnType<TerminalCommandMarkerScanner['scan']>[number],
    at: number
  ): void {
    if (marker.kind === 'command-line') {
      state.pendingCommand = marker.command
      return
    }
    if (marker.kind === 'command-start') {
      // Why close first: a shell that skips D — or a command killed by a
      // respawned prompt — must not leave the previous block open, silently
      // swallowing the next command's output into it.
      this.closeOpenBlock(state, marker.cursor, null, at)
      const block: TerminalCommandBlockRecord = {
        index: state.totalObserved,
        command: state.pendingCommand,
        exitCode: null,
        startCursor: marker.cursor,
        endCursor: null,
        startedAt: at,
        endedAt: null
      }
      state.open = block
      state.pendingCommand = null
      state.totalObserved += 1
      this.retain(state, block)
      return
    }
    // A prompt with no preceding D means the command ended without an exit
    // report; close it anyway so its output range stays bounded honestly.
    this.closeOpenBlock(
      state,
      marker.cursor,
      marker.kind === 'command-end' ? marker.exitCode : null,
      at
    )
  }

  private closeOpenBlock(
    state: PtyBlockState,
    cursor: number,
    exitCode: number | null,
    at: number
  ): void {
    const open = state.open
    if (!open) {
      return
    }
    open.endCursor = Math.max(open.startCursor, cursor)
    open.exitCode = exitCode
    open.endedAt = at
    state.open = null
  }

  private retain(state: PtyBlockState, block: TerminalCommandBlockRecord): void {
    state.blocks.push(block)
    if (state.blocks.length > MAX_RETAINED_COMMAND_BLOCKS) {
      const dropped = state.blocks.length - MAX_RETAINED_COMMAND_BLOCKS
      state.evictedCount += dropped
      state.blocks = state.blocks.slice(dropped)
    }
  }

  snapshot(ptyId: string, limit?: number): TerminalCommandBlockSnapshot {
    const state = this.byPty.get(ptyId)
    if (!state) {
      return {
        blocks: [],
        totalObserved: 0,
        evictedCount: 0,
        shellIntegrationSeen: false
      }
    }
    const bounded =
      limit !== undefined && limit > 0 && limit < state.blocks.length
        ? state.blocks.slice(state.blocks.length - limit)
        : state.blocks
    return {
      blocks: bounded.map((block) => ({ ...block })),
      totalObserved: state.totalObserved,
      evictedCount: state.evictedCount,
      // Why derived from totalObserved and not from carry state: a pane that
      // has seen a command start is proof of an instrumented shell; the absence
      // of one is NOT proof of the opposite, which is why callers get the flag
      // rather than a synthesized "no shell integration" verdict.
      shellIntegrationSeen: state.totalObserved > 0
    }
  }

  /** Newest retained block, running or finished, or null when none. */
  last(ptyId: string): TerminalCommandBlockRecord | null {
    const blocks = this.byPty.get(ptyId)?.blocks
    const block = blocks?.at(-1)
    return block ? { ...block } : null
  }

  get(ptyId: string, index: number): TerminalCommandBlockRecord | null {
    const block = this.byPty.get(ptyId)?.blocks.find((entry) => entry.index === index)
    return block ? { ...block } : null
  }

  dropPty(ptyId: string): void {
    this.byPty.delete(ptyId)
  }
}

// Why module state (pattern of terminal-host-row-anchor.ts): the ingest site in
// the runtime and the RPC read path must share one ledger without threading it
// through the service constructor.
let ledger = new TerminalCommandBlockLedger()

export function terminalCommandBlockLedger(): TerminalCommandBlockLedger {
  return ledger
}

export function resetTerminalCommandBlockLedgerForTest(): void {
  ledger = new TerminalCommandBlockLedger()
}
