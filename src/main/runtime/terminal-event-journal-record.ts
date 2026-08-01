/**
 * One pane's retained event log and the cursor arithmetic over it — the data
 * half of `terminal-event-journal.ts` (§5.3/§3a of
 * docs/reference/alab-auto-mode-design.md). The journal class owns the registry
 * of records, parked readers and lifecycle; this module owns the single
 * question "what does this pane's history say about this cursor".
 *
 * Split out because both halves are load-bearing enough to read on their own,
 * not to dodge a line budget.
 */

import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'

/** §3a identity: what a reader has already seen on one pane incarnation. No
 *  ptyId — the caller addresses the pane, and ptyIncarnationId is what pins the
 *  respawn generation so a stale cursor cannot read another incarnation. */
export type EventCursor = {
  runtimeId: string
  ptyIncarnationId: string
  eventSeq: number
}

export type PtyEventSource = {
  runtimeId: string
  ptyId: string
  ptyIncarnationId: string
}

export type JournalEvent<TFact = TerminalSideEffectFact> = {
  ptyId: string
  eventSeq: number
  at: number
  payload: TFact
}

export type JournalGapReason =
  | 'evicted'
  | 'incarnation-changed'
  | 'pty-dropped'
  /** The cursor names a position this journal never issued — ahead of head, or
   *  not a well-formed ordinal at all. Resume at the returned head. */
  | 'cursor-out-of-range'

export type JournalReadResult<TFact = TerminalSideEffectFact> =
  | { kind: 'events'; events: JournalEvent<TFact>[]; nextCursor: EventCursor }
  /** Never silent truncation: the reader resyncs its own state, then resumes at
   *  nextCursor — a position this journal really issued, so the follow-up read
   *  returns everything left rather than gapping a second time. */
  | { kind: 'gap'; reason: JournalGapReason; nextCursor: EventCursor }

export type PtyJournal<TFact> = {
  runtimeId: string
  ptyIncarnationId: string
  events: JournalEvent<TFact>[]
  nextSeq: number
  /** Tombstone: retention released, ordinal remembered. */
  dropped: boolean
}

export function headCursorOf<TFact>(journal: PtyJournal<TFact>): EventCursor {
  return {
    runtimeId: journal.runtimeId,
    ptyIncarnationId: journal.ptyIncarnationId,
    eventSeq: journal.nextSeq - 1
  }
}

export function earliestCursorOf<TFact>(journal: PtyJournal<TFact>): EventCursor {
  const oldest = journal.events[0]
  return {
    runtimeId: journal.runtimeId,
    ptyIncarnationId: journal.ptyIncarnationId,
    eventSeq: (oldest?.eventSeq ?? journal.nextSeq) - 1
  }
}

/** Every reader of a pane shares one retained array, so each read hands out its
 *  own copy — one consumer editing a payload must not rewrite what the others
 *  read. structuredClone is exact for facts: they already cross Electron IPC. */
function copyForReader<TFact>(event: JournalEvent<TFact>): JournalEvent<TFact> {
  return { ...event, payload: structuredClone(event.payload) }
}

/**
 * Everything newer than `cursor`, or the gap that says why it cannot be served.
 * Identity is checked before the ordinal: an ordinal only means something within
 * the incarnation that minted it.
 */
export function readPtyJournal<TFact>(
  journal: PtyJournal<TFact>,
  cursor: EventCursor
): JournalReadResult<TFact> {
  if (
    cursor.runtimeId !== journal.runtimeId ||
    cursor.ptyIncarnationId !== journal.ptyIncarnationId
  ) {
    return { kind: 'gap', reason: 'incarnation-changed', nextCursor: earliestCursorOf(journal) }
  }
  const headSeq = journal.nextSeq - 1
  if (!Number.isSafeInteger(cursor.eventSeq) || cursor.eventSeq < 0 || cursor.eventSeq > headSeq) {
    // The reader claims a position this journal never issued. Serving it would
    // let the cursor define the stream (at MAX_SAFE_INTEGER the ordinal stops
    // advancing at all); resync at the head the journal actually minted.
    return { kind: 'gap', reason: 'cursor-out-of-range', nextCursor: headCursorOf(journal) }
  }
  if (journal.dropped) {
    // A tombstone serves gaps, never events: retention is gone, so only a reader
    // that was already at head lost nothing.
    return cursor.eventSeq === headSeq
      ? { kind: 'events', events: [], nextCursor: cursor }
      : { kind: 'gap', reason: 'pty-dropped', nextCursor: headCursorOf(journal) }
  }
  const oldest = journal.events[0]
  if (oldest !== undefined && cursor.eventSeq + 1 < oldest.eventSeq) {
    return { kind: 'gap', reason: 'evicted', nextCursor: earliestCursorOf(journal) }
  }
  const events = journal.events
    .filter((event) => event.eventSeq > cursor.eventSeq)
    .map((event) => copyForReader(event))
  // A cursor exactly at head parks unchanged until the stream catches up.
  const nextCursor = events.length === 0 ? cursor : headCursorOf(journal)
  return { kind: 'events', events, nextCursor }
}
