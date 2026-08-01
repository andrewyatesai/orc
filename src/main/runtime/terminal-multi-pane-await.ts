/**
 * Cursor-based multi-pane await over the terminal event journal — §5.3 of
 * docs/reference/alab-auto-mode-design.md.
 *
 * Why: the runtime caps concurrent long polls at 16, so a manager watching N
 * worker panes cannot hold one `terminal.wait` per pane. One await multiplexes
 * the whole watch set and returns the first matching event across it, together
 * with every pane's resumption cursor — the RPC transport is one-shot, so those
 * cursors are the only thing that makes "nothing is lost between returns" true.
 *
 * Pure module — no Electron, no runtime imports. Journal and liveness injected.
 */

import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import type {
  EventCursor,
  JournalEvent,
  JournalGapReason,
  JournalWatchResult,
  TerminalEventJournal,
  TerminalEventWatch
} from './terminal-event-journal'

/** One await replaces one `terminal.wait` per pane, so the watch set may exceed
 *  the long-poll cap; bound it anyway so a single request cannot pin unbounded
 *  parked readers. */
export const TERMINAL_AWAIT_MAX_PANES = 32
export const TERMINAL_AWAIT_DEFAULT_TIMEOUT_MS = 60_000
export const TERMINAL_AWAIT_MAX_TIMEOUT_MS = 10 * 60_000
/** A pane that exits mid-park stops publishing rather than signalling, so the
 *  park is chunked and liveness rechecked between chunks. */
export const TERMINAL_AWAIT_LIVENESS_POLL_MS = 2_000

export type TerminalAwaitPane = {
  terminal: string
  ptyId: string
  cursor: EventCursor
  /** Set when the caller's cursor was refused at the trust boundary — wrong
   *  runtime, superseded incarnation, or an ordinal this runtime never issued.
   *  The await gaps with this reason instead of forwarding a cursor it does not
   *  believe; `cursor` already holds the position to resume from. */
  resyncReason?: JournalGapReason
}

export type TerminalAwaitCursor = {
  terminal: string
  cursor: EventCursor
}

/** Every outcome carries the full cursor set: the caller re-arms from it, and a
 *  gap or exit on one pane must not cost it the others' positions. */
export type TerminalAwaitResult =
  | {
      outcome: 'event'
      terminal: string
      events: JournalEvent[]
      cursors: TerminalAwaitCursor[]
    }
  | { outcome: 'gap'; terminal: string; reason: JournalGapReason; cursors: TerminalAwaitCursor[] }
  | { outcome: 'exit'; terminal: string; cursors: TerminalAwaitCursor[] }
  | { outcome: 'timeout'; cursors: TerminalAwaitCursor[] }
  /** Named kinds that nothing in this runtime posture can emit. Returned in
   *  place of a park so the caller can tell "nothing happened yet" (timeout)
   *  from "this can never happen here" — the §5.5 no-silent-downgrade rule. */
  | {
      outcome: 'unsupported'
      kinds: string[]
      reason: 'no-side-effect-consumer'
      cursors: TerminalAwaitCursor[]
    }

type PaneRead = {
  pane: TerminalAwaitPane
  nextCursor: EventCursor
  matched: JournalEvent[]
}

function cursorsOf(panes: readonly TerminalAwaitPane[]): TerminalAwaitCursor[] {
  return panes.map((pane) => ({ terminal: pane.terminal, cursor: pane.cursor }))
}

/**
 * One synchronous pass over every pane; returns the winning outcome, or null
 * when nothing matched and the caller should park.
 */
function drainOnce(
  journal: TerminalEventJournal,
  panes: readonly TerminalAwaitPane[],
  matches: ((fact: TerminalSideEffectFact) => boolean) | undefined
): TerminalAwaitResult | null {
  const reads: PaneRead[] = []
  for (const pane of panes) {
    const read = journal.read(pane.ptyId, pane.cursor)
    if (read.kind === 'gap') {
      // Why: a gap is never silent and never deferred — the caller must resync
      // its own state before it consumes anything newer on that pane.
      pane.cursor = read.nextCursor
      return {
        outcome: 'gap',
        terminal: pane.terminal,
        reason: read.reason,
        cursors: cursorsOf(panes)
      }
    }
    const matched = matches ? read.events.filter((event) => matches(event.payload)) : read.events
    reads.push({ pane, nextCursor: read.nextCursor, matched })
  }

  // Oldest matching event wins, so a chatty pane cannot starve a quiet one and
  // the choice never depends on promise-settlement order.
  let winner: PaneRead | null = null
  for (const read of reads) {
    const first = read.matched[0]
    if (first !== undefined && (winner === null || first.at < winner.matched[0]!.at)) {
      winner = read
    }
  }

  for (const read of reads) {
    const first = read.matched[0]
    if (read === winner || first === undefined) {
      // Fully evaluated: delivered (the winner) or filtered out by the predicate.
      read.pane.cursor = read.nextCursor
      continue
    }
    // Consume this pane's filtered prefix but keep its own first match, so the
    // caller's next arm still receives it.
    read.pane.cursor = { ...read.nextCursor, eventSeq: first.eventSeq - 1 }
  }

  return winner === null
    ? null
    : {
        outcome: 'event',
        terminal: winner.pane.terminal,
        events: winner.matched,
        cursors: cursorsOf(panes)
      }
}

type PaneWake = { pane: TerminalAwaitPane; result: JournalWatchResult }

/** Parks on every pane at once until any wakes, the signal aborts, or the
 *  chunk deadline passes. Returns what the journal actually said (null on the
 *  deadline), and always releases every parked reader on the way out. */
async function parkUntilWake(
  journal: TerminalEventJournal,
  panes: readonly TerminalAwaitPane[],
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<PaneWake | null> {
  const watches: { pane: TerminalAwaitPane; watch: TerminalEventWatch }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (const pane of panes) {
      // Why opened one at a time inside the try: watch() throws at the journal's
      // reader cap, and the watches already opened must still be released.
      watches.push({ pane, watch: journal.watch(pane.ptyId, pane.cursor, { signal }) })
    }
    const chunkDeadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    return await Promise.race([
      ...watches.map(async ({ pane, watch }) => ({ pane, result: await watch.result })),
      chunkDeadline
    ])
  } finally {
    clearTimeout(timer)
    // Why: the long-poll slot is per request, not per pane — every parked
    // reader must be released on the way out or the journal leaks them.
    for (const { watch } of watches) {
      watch.cancel()
    }
  }
}

/**
 * Long-poll for the first matching journal event across `panes`. Rejects with
 * `request_aborted` when the caller's socket dies, matching `terminal.wait`.
 */
export async function awaitFirstTerminalEvent(options: {
  journal: TerminalEventJournal
  panes: readonly TerminalAwaitPane[]
  matches?: (fact: TerminalSideEffectFact) => boolean
  isPaneLive: (ptyId: string) => boolean
  /** The named kinds nothing can currently produce, re-asked every pass. */
  unproducibleKinds?: () => readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}): Promise<TerminalAwaitResult> {
  // Cursors advance locally across park cycles; the caller's input is not mutated.
  const panes: TerminalAwaitPane[] = options.panes.map((pane) => ({ ...pane }))
  const deadline = Date.now() + options.timeoutMs

  const refused = panes.find((pane) => pane.resyncReason !== undefined)
  if (refused?.resyncReason !== undefined) {
    // Why first: a cursor the boundary refused was never a position in this
    // stream, so nothing may be read against it — the caller resyncs instead.
    return {
      outcome: 'gap',
      terminal: refused.terminal,
      reason: refused.resyncReason,
      cursors: cursorsOf(panes)
    }
  }

  for (;;) {
    if (options.signal?.aborted === true) {
      throw new Error('request_aborted')
    }
    // Why re-asked every pass and not just on entry: the renderer window can
    // close mid-poll, and a watcher of a consumer-gated kind must be told its
    // predicate stopped being producible rather than silently never matching.
    const unproducible = options.unproducibleKinds?.() ?? []
    if (unproducible.length > 0) {
      return {
        outcome: 'unsupported',
        kinds: [...unproducible],
        reason: 'no-side-effect-consumer',
        cursors: cursorsOf(panes)
      }
    }
    const drained = drainOnce(options.journal, panes, options.matches)
    if (drained) {
      return drained
    }
    // Why: a dead pane's fact stream simply stops, so without this the reader
    // parks out its whole timeout waiting for events that can never come.
    const dead = panes.find((pane) => !options.isPaneLive(pane.ptyId))
    if (dead) {
      return { outcome: 'exit', terminal: dead.terminal, cursors: cursorsOf(panes) }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return { outcome: 'timeout', cursors: cursorsOf(panes) }
    }
    const woken = await parkUntilWake(
      options.journal,
      panes,
      Math.min(remainingMs, TERMINAL_AWAIT_LIVENESS_POLL_MS),
      options.signal
    )
    if (woken?.result.kind === 'gap') {
      // Why surfaced from the wake rather than the next drain: the journal only
      // states `pty-dropped` once, to the reader it settles. Re-reading a
      // dropped pane cannot recover the reason, so it would resurface as `exit`.
      woken.pane.cursor = woken.result.nextCursor
      return {
        outcome: 'gap',
        terminal: woken.pane.terminal,
        reason: woken.result.reason,
        cursors: cursorsOf(panes)
      }
    }
  }
}
