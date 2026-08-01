/**
 * Bounded per-PTY event journal — the publication layer of §5.3 in
 * docs/reference/alab-auto-mode-design.md.
 *
 * Why: runtime RPC is one-shot request/response and server-side waiters are torn
 * down on resolve, so every return destroys the watch and a transition arriving
 * between return and re-arm is lost. Readers resume from an EventCursor instead,
 * and per-PTY retention covers the re-arm window.
 *
 * The ordinal is minted here rather than reusing the PTY byte counter
 * (`outputSequence`): that is a byte count, synthetic and timer-driven facts emit
 * without advancing it, two batches can share one value, and it dies at teardown.
 *
 * Two rules the rest of the module is built out of:
 *
 *  1. **A cursor is a query, never an authority.** Server state — whether a pane
 *     has a journal, which incarnation it holds, what ordinal comes next — is
 *     minted by publishers only. A reader naming a position this journal never
 *     issued is told to resync; it can never seed, skew or stall the ordinal.
 *  2. **Never silent truncation.** Any position that cannot be served from
 *     retention comes back as a `gap` carrying a reason and a resume cursor that
 *     does not immediately gap again.
 *
 * Per-pane history and the cursor-to-result decision live in
 * `terminal-event-journal-record.ts`.
 *
 * Pure module — no Electron, no I/O, no timers. The clock is injectable.
 */

import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import {
  earliestCursorOf,
  headCursorOf,
  readPtyJournal,
  type EventCursor,
  type JournalReadResult,
  type PtyEventSource,
  type PtyJournal
} from './terminal-event-journal-record'

export type {
  EventCursor,
  JournalEvent,
  JournalGapReason,
  JournalReadResult,
  PtyEventSource
} from './terminal-event-journal-record'

/** Events retained per PTY incarnation. Facts are per chunk, not per byte, so
 *  this covers many RPC re-arm windows while staying trivially bounded across
 *  panes — a resumption buffer, not a transcript. */
export const TERMINAL_EVENT_JOURNAL_RETENTION = 256

/** The runtime caps concurrent long polls at 16 and one await parks at most one
 *  reader per pane, so these sit far above legitimate load: they catch a caller
 *  leaking watches, not one that is merely busy. */
export const TERMINAL_EVENT_JOURNAL_MAX_WAITERS_PER_PTY = 64
export const TERMINAL_EVENT_JOURNAL_MAX_WAITERS = 1024

/** Dropped panes whose ordinal high-water mark is remembered, so a PTY that is
 *  re-registered under the same incarnation cannot reissue ordinals a live
 *  cursor already consumed (see `dropPty`). Bounded because a long-lived runtime
 *  churns through panes; a cursor that outlived this many other drops is beyond
 *  what the module can honestly account for. */
export const TERMINAL_EVENT_JOURNAL_DROPPED_PANE_MEMORY = 256

/** `watch()` throws with this message when the parked-reader caps are reached.
 *  Thrown rather than resolved: any immediate resolution turns a caller's
 *  park/re-drain loop into a busy spin, which is the failure this cap exists to
 *  prevent. Callers must release the watches they already opened. */
export const TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR = 'terminal_journal_reader_limit'

/** Cancellation resolves instead of rejecting: an aborted long poll is normal
 *  teardown, and rejecting a promise nobody awaits yet (socket died first) would
 *  surface as an unhandled rejection. */
export type JournalWatchResult<TFact = TerminalSideEffectFact> =
  | JournalReadResult<TFact>
  | { kind: 'cancelled'; nextCursor: EventCursor }

export type TerminalEventWatch<TFact = TerminalSideEffectFact> = {
  readonly result: Promise<JournalWatchResult<TFact>>
  cancel: () => void
}

type Waiter<TFact> = {
  cursor: EventCursor
  settled: boolean
  settle: (outcome: JournalWatchResult<TFact>) => void
}

const NOOP_CANCEL = (): void => {}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TerminalEventJournal ${label} must be a positive integer, got ${value}`)
  }
  return value
}

export class TerminalEventJournal<TFact = TerminalSideEffectFact> {
  /** Publisher-owned state. Only `publish`/`beginIncarnation` create entries — a
   *  read-path call must never allocate one, or an unknown ptyId would leak a
   *  record and let its cursor dictate the pane's ordinal. */
  private readonly journals = new Map<string, PtyJournal<TFact>>()
  /** Parked readers, keyed by ptyId and independent of the journals map so a
   *  reader can park on a pane that has not published yet. The entry is removed
   *  as soon as the last waiter leaves. */
  private readonly waitersByPtyId = new Map<string, Waiter<TFact>[]>()
  /** Insertion-ordered tombstone window; the oldest is evicted first. */
  private readonly droppedPtyIds = new Set<string>()
  private parkedTotal = 0
  private readonly retention: number
  private readonly maxWaitersPerPty: number
  private readonly maxWaiters: number
  private readonly droppedPaneMemory: number
  private readonly now: () => number

  constructor(options?: {
    retentionPerPty?: number
    maxWaitersPerPty?: number
    maxWaiters?: number
    droppedPaneMemory?: number
    now?: () => number
  }) {
    this.now = options?.now ?? Date.now
    this.retention = requirePositiveInteger(
      options?.retentionPerPty ?? TERMINAL_EVENT_JOURNAL_RETENTION,
      'retention'
    )
    this.maxWaitersPerPty = requirePositiveInteger(
      options?.maxWaitersPerPty ?? TERMINAL_EVENT_JOURNAL_MAX_WAITERS_PER_PTY,
      'maxWaitersPerPty'
    )
    this.maxWaiters = requirePositiveInteger(
      options?.maxWaiters ?? TERMINAL_EVENT_JOURNAL_MAX_WAITERS,
      'maxWaiters'
    )
    this.droppedPaneMemory = requirePositiveInteger(
      options?.droppedPaneMemory ?? TERMINAL_EVENT_JOURNAL_DROPPED_PANE_MEMORY,
      'droppedPaneMemory'
    )
  }

  /** Rotates the pane's journal when the PTY respawned; cursors from the old
   *  incarnation gap from here on. Returns the head cursor of the incarnation. */
  beginIncarnation(source: PtyEventSource): EventCursor {
    return headCursorOf(this.openJournal(source))
  }

  publish(source: PtyEventSource, payload: TFact): EventCursor {
    return this.publishBatch(source, [payload])
  }

  /** One wake per batch, so a chunk's facts reach a reader together. */
  publishBatch(source: PtyEventSource, payloads: readonly TFact[]): EventCursor {
    const journal = this.openJournal(source)
    if (payloads.length === 0) {
      return headCursorOf(journal)
    }
    for (const payload of payloads) {
      journal.events.push({
        ptyId: source.ptyId,
        eventSeq: journal.nextSeq,
        at: this.now(),
        payload
      })
      journal.nextSeq += 1
    }
    if (journal.events.length > this.retention) {
      journal.events.splice(0, journal.events.length - this.retention)
    }
    // Append before waking: a woken reader re-reads from its own cursor, so an
    // event published during the fan-out can never land behind it.
    this.wake(source.ptyId)
    return headCursorOf(journal)
  }

  /** Synchronous, non-parking read of everything newer than `cursor`. */
  read(ptyId: string, cursor: EventCursor): JournalReadResult<TFact> {
    const journal = this.journals.get(ptyId)
    if (journal === undefined) {
      // Unknown pane: it may simply not have published yet, so report "nothing
      // newer" and let the caller park rather than churn on a gap.
      return { kind: 'events', events: [], nextCursor: cursor }
    }
    return readPtyJournal(journal, cursor)
  }

  /**
   * Atomic replay-then-park: the retained read and the park happen in this one
   * synchronous call, so no publish can slip between "check" and "park".
   *
   * Throws `TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR` when the caps are hit.
   */
  watch(
    ptyId: string,
    cursor: EventCursor,
    options?: { signal?: AbortSignal }
  ): TerminalEventWatch<TFact> {
    const signal = options?.signal
    if (signal?.aborted === true) {
      const cancelled: JournalWatchResult<TFact> = { kind: 'cancelled', nextCursor: cursor }
      return { result: Promise.resolve(cancelled), cancel: NOOP_CANCEL }
    }
    const replay = this.read(ptyId, cursor)
    if (replay.kind === 'gap' || replay.events.length > 0) {
      return { result: Promise.resolve(replay), cancel: NOOP_CANCEL }
    }
    this.assertParkCapacity(ptyId)
    const waiter: Waiter<TFact> = { cursor, settled: false, settle: NOOP_CANCEL }
    const cancel = (): void => {
      if (waiter.settled) {
        return
      }
      waiter.settled = true
      this.removeWaiter(ptyId, waiter)
      waiter.settle({ kind: 'cancelled', nextCursor: cursor })
    }
    const result = new Promise<JournalWatchResult<TFact>>((resolve) => {
      waiter.settle = (outcome): void => {
        signal?.removeEventListener('abort', cancel)
        resolve(outcome)
      }
    })
    signal?.addEventListener('abort', cancel, { once: true })
    this.parkWaiter(ptyId, waiter)
    return { result, cancel }
  }

  /** Cursor pointing at the newest retained event ("tell me what happens next").
   *  Undefined for a pane this journal is not publishing, dropped included. */
  headCursor(ptyId: string): EventCursor | undefined {
    const journal = this.liveJournal(ptyId)
    return journal === undefined ? undefined : headCursorOf(journal)
  }

  /** Cursor pointing just before the oldest retained event ("replay what is left"). */
  earliestCursor(ptyId: string): EventCursor | undefined {
    const journal = this.liveJournal(ptyId)
    return journal === undefined ? undefined : earliestCursorOf(journal)
  }

  /**
   * PTY teardown: retention is released and parked readers are told, so a long
   * poll on a dead pane frees its slot instead of hanging.
   *
   * The drop is sticky. The record survives as a tombstone holding the ordinal
   * high-water mark, so a PTY re-registered under the *same* incarnation resumes
   * above it instead of reissuing ordinals a surviving cursor already consumed —
   * that cursor then gaps rather than silently under-reading. A respawn under a
   * new incarnation still restarts the ordinal: there the incarnation id, not
   * the ordinal, is what invalidates the old cursor.
   */
  dropPty(ptyId: string): void {
    const journal = this.journals.get(ptyId)
    // Resume at the pane's own head: a reader re-arming there parks (and learns
    // the pane is gone from liveness) instead of gapping on every single arm.
    const nextCursor = journal === undefined ? undefined : headCursorOf(journal)
    for (const waiter of this.takeWaiters(ptyId)) {
      if (waiter.settled) {
        continue
      }
      waiter.settled = true
      waiter.settle({
        kind: 'gap',
        reason: 'pty-dropped',
        nextCursor: nextCursor ?? waiter.cursor
      })
    }
    if (journal === undefined) {
      return
    }
    journal.events = []
    journal.dropped = true
    this.droppedPtyIds.delete(ptyId)
    this.droppedPtyIds.add(ptyId)
    for (const oldest of this.droppedPtyIds) {
      if (this.droppedPtyIds.size <= this.droppedPaneMemory) {
        break
      }
      this.droppedPtyIds.delete(oldest)
      this.journals.delete(oldest)
    }
  }

  pendingReaderCount(ptyId?: string): number {
    if (ptyId !== undefined) {
      return this.waitersByPtyId.get(ptyId)?.length ?? 0
    }
    return this.parkedTotal
  }

  private liveJournal(ptyId: string): PtyJournal<TFact> | undefined {
    const journal = this.journals.get(ptyId)
    return journal?.dropped === false ? journal : undefined
  }

  private openJournal(source: PtyEventSource): PtyJournal<TFact> {
    const existing = this.journals.get(source.ptyId)
    if (existing === undefined) {
      const created: PtyJournal<TFact> = {
        runtimeId: source.runtimeId,
        ptyIncarnationId: source.ptyIncarnationId,
        events: [],
        nextSeq: 1,
        dropped: false
      }
      this.journals.set(source.ptyId, created)
      return created
    }
    const sameIncarnation =
      existing.runtimeId === source.runtimeId &&
      existing.ptyIncarnationId === source.ptyIncarnationId
    if (sameIncarnation && !existing.dropped) {
      return existing
    }
    if (!sameIncarnation) {
      // Respawn: the ordinal is per incarnation, so history and seq both restart
      // and every parked reader wakes into an incarnation-changed gap.
      existing.runtimeId = source.runtimeId
      existing.ptyIncarnationId = source.ptyIncarnationId
      existing.nextSeq = 1
    }
    // Resumed under the same incarnation (a reconnect after the record was
    // pruned) keeps `nextSeq`: reusing an ordinal is silent loss, gapping is not.
    existing.events = []
    existing.dropped = false
    this.droppedPtyIds.delete(source.ptyId)
    this.wake(source.ptyId)
    return existing
  }

  private assertParkCapacity(ptyId: string): void {
    const parked = this.waitersByPtyId.get(ptyId)?.length ?? 0
    if (parked >= this.maxWaitersPerPty || this.parkedTotal >= this.maxWaiters) {
      throw new Error(TERMINAL_EVENT_JOURNAL_READER_LIMIT_ERROR)
    }
  }

  private parkWaiter(ptyId: string, waiter: Waiter<TFact>): void {
    const parked = this.waitersByPtyId.get(ptyId)
    if (parked === undefined) {
      this.waitersByPtyId.set(ptyId, [waiter])
    } else {
      parked.push(waiter)
    }
    this.parkedTotal += 1
  }

  private removeWaiter(ptyId: string, waiter: Waiter<TFact>): void {
    const parked = this.waitersByPtyId.get(ptyId)
    const index = parked?.indexOf(waiter) ?? -1
    if (parked === undefined || index === -1) {
      return
    }
    parked.splice(index, 1)
    this.parkedTotal -= 1
    if (parked.length === 0) {
      this.waitersByPtyId.delete(ptyId)
    }
  }

  private takeWaiters(ptyId: string): Waiter<TFact>[] {
    const parked = this.waitersByPtyId.get(ptyId)
    if (parked === undefined) {
      return []
    }
    this.waitersByPtyId.delete(ptyId)
    this.parkedTotal -= parked.length
    return parked
  }

  private wake(ptyId: string): void {
    for (const waiter of this.takeWaiters(ptyId)) {
      if (waiter.settled) {
        continue
      }
      const outcome = this.read(ptyId, waiter.cursor)
      if (outcome.kind === 'events' && outcome.events.length === 0) {
        this.parkWaiter(ptyId, waiter)
        continue
      }
      waiter.settled = true
      waiter.settle(outcome)
    }
  }
}
