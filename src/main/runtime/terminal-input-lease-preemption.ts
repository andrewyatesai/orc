/**
 * §5.4's preemption vocabulary: what an automated write lease is pinned to, the
 * phase it was in when a human (or a generation change) took the pane back, and
 * the outcome that phase forces. Split out of terminal-input-coordinator.ts so
 * the table stays readable next to the design doc it encodes.
 */

/** What an operation is pinned to; either field moving means the bytes would
 *  land in a different terminal than the one that was leased. */
export type ConnectionPin = {
  ptyIncarnationId: string
  connectionGeneration: number
}

export type AutomatedWriter =
  | 'manager'
  | 'coordinator-dispatch'
  | 'message-delivery'
  | 'query-reply'

/** Mobile is a human path, not an automated writer (§5.1) — and it already
 *  outranks the desktop human through the existing input floor. */
export type HumanInputSource = 'desktop' | 'mobile'

export type LeaseWritePhase = 'acquired' | 'pasting' | 'pasted' | 'submitted'

export type DraftState = 'clean' | 'contaminated' | 'unknown'

export type LeaseRevocationCause =
  | 'human-input'
  | 'human-input-floor'
  | 'generation-change'
  | 'pty-disposed'

export type PreemptionOutcome = {
  /** 'unresolved' means Enter already landed: the read-only watcher resolves it
   *  to 'yes' or 'unknown' (§5.4) — never 'preempted'. */
  submitted: 'no' | 'unresolved'
  draftState: DraftState
  watcher: 'stopped' | 'read-only'
  /** Only a clean pre-paste abort is safe to repeat; a contaminated draft would
   *  double-paste and a landed Enter falls under §5.2's no-retry rule. */
  retry: 'allowed' | 'forbidden'
}

/** The §5.4 table, and the reason the lease tracks phase at all: a paste into an
 *  unknown TUI cannot be rolled back, so contamination is reported, never hidden. */
export function describePreemptionOutcome(phase: LeaseWritePhase): PreemptionOutcome {
  switch (phase) {
    case 'acquired':
      return {
        submitted: 'no',
        draftState: 'clean',
        watcher: 'stopped',
        retry: 'allowed'
      }
    case 'pasting':
    case 'pasted':
      return {
        submitted: 'no',
        draftState: 'contaminated',
        watcher: 'stopped',
        retry: 'forbidden'
      }
    case 'submitted':
      return {
        submitted: 'unresolved',
        draftState: 'unknown',
        watcher: 'read-only',
        retry: 'forbidden'
      }
  }
}

export type LeaseRevokedReport = PreemptionOutcome & {
  operationId: string
  ptyId: string
  writer: AutomatedWriter
  /** Phase at the instant write authority was revoked. */
  phase: LeaseWritePhase
  cause: LeaseRevocationCause
  humanSource?: HumanInputSource
  supersededBy?: ConnectionPin
  pin: ConnectionPin
  at: number
}

export class TerminalInputLeaseRevokedError extends Error {
  readonly report: LeaseRevokedReport

  constructor(report: LeaseRevokedReport) {
    super(`Terminal input lease revoked (${report.cause}) at phase ${report.phase}`)
    this.name = 'TerminalInputLeaseRevokedError'
    this.report = report
  }
}

/** Thrown when a writer acts while a human claim holds the pane provisionally.
 *  Recoverable, unlike revocation: the claim may still roll back. */
export class TerminalInputLeaseSuspendedError extends Error {
  readonly operationId: string
  readonly humanSource: HumanInputSource

  constructor(operationId: string, humanSource: HumanInputSource) {
    super(`Terminal input lease suspended by a ${humanSource} input claim`)
    this.name = 'TerminalInputLeaseSuspendedError'
    this.operationId = operationId
    this.humanSource = humanSource
  }
}

/** Did this write path stop because a human took the pane, rather than because the
 *  terminal refused a byte? The two demand opposite close-out behavior: a refused
 *  write still owns the keyboard, a preempted one does not. */
export function isTerminalInputPreemption(error: unknown): boolean {
  return (
    error instanceof TerminalInputLeaseRevokedError ||
    error instanceof TerminalInputLeaseSuspendedError
  )
}

export function connectionPinsEqual(a: ConnectionPin, b: ConnectionPin): boolean {
  return (
    a.ptyIncarnationId === b.ptyIncarnationId && a.connectionGeneration === b.connectionGeneration
  )
}

/** `connectionGeneration` only counts up, so a lower one is a reordered event
 *  from a superseded connection — adopting it would revoke the live holder and
 *  report a generation change that ran backwards. */
export function connectionPinRewinds(current: ConnectionPin, next: ConnectionPin): boolean {
  return next.connectionGeneration < current.connectionGeneration
}
