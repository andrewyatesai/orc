/**
 * The write lease itself: its phase state machine and the single place a
 * revocation is stamped. Arbitration between writers lives in
 * terminal-input-coordinator.ts; a lease only knows what this one operation is
 * still allowed to do.
 *
 * Write authority has three live states, not two, because the human paths it
 * yields to are themselves two-phase (`beginMobileInputFloor` reserves, then
 * commits or rolls back): a reserved claim *suspends* authority, and only a
 * committed one revokes it. Suspension is the seam that lets a rejected phone
 * write leave a healthy operation alive.
 */
import {
  describePreemptionOutcome,
  TerminalInputLeaseRevokedError,
  TerminalInputLeaseSuspendedError,
  type AutomatedWriter,
  type ConnectionPin,
  type HumanInputSource,
  type LeaseRevocationCause,
  type LeaseRevokedReport,
  type LeaseWritePhase
} from './terminal-input-lease-preemption'

/** 'suspended' is recoverable; 'revoked' and 'released' are terminal. */
export type LeaseWriteAuthority = 'held' | 'suspended' | 'revoked' | 'released'

export type TerminalInputLease = {
  readonly operationId: string
  readonly ptyId: string
  readonly pin: ConnectionPin
  readonly writer: AutomatedWriter
  /** Aborts the moment write authority ends — revoked *or* released — so
   *  echo-settle waits race it and always unwind. Use checkRevoked() to ask
   *  whether the operation was preempted; this signal does not distinguish. */
  readonly revoked: AbortSignal
  phase(): LeaseWritePhase
  writeAuthority(): LeaseWriteAuthority
  /** The seam §5.4 requires between paste chunks; null means keep writing.
   *  Reports revocation only — a suspended lease has not lost anything yet. */
  checkRevoked(): LeaseRevokedReport | null
  /** The async seam: resolves null while authority is (or becomes) the writer's
   *  again, or the report once it is gone. Awaiting this is how a writer rides
   *  out a human claim that may still roll back. */
  awaitWriteAuthority(): Promise<LeaseRevokedReport | null>
  /** Throwing form of checkRevoked for callers already in a try/catch pipeline;
   *  also throws while suspended, since writing then would interleave bytes. */
  assertStillHeld(): void
  beginPaste(): LeaseRevokedReport | null
  completePaste(): LeaseRevokedReport | null
  /** The pre-Enter linearization point: latches 'submitted' iff still held, so a
   *  racing human claim cannot land on the wrong row of the §5.4 table. Press
   *  Enter only when this returns null. */
  armSubmit(): LeaseRevokedReport | null
  /** Acknowledges the writer has stopped (or the read-only watcher finished) and
   *  releases the pane to the next automated writer. */
  release(): void
}

type LeaseSuspension = {
  source: HumanInputSource
  resolved: Promise<LeaseRevokedReport | null>
  settle: (outcome: LeaseRevokedReport | null) => void
}

export type InputLeaseRecord = {
  operationId: string
  ptyId: string
  writer: AutomatedWriter
  pin: ConnectionPin
  phase: LeaseWritePhase
  report: LeaseRevokedReport | null
  released: boolean
  controller: AbortController
  /** Set while a human claim holds the pane provisionally. */
  suspension: LeaseSuspension | null
}

export type InputLeaseRevocation = {
  cause: LeaseRevocationCause
  at: number
  humanSource?: HumanInputSource
  supersededBy?: ConnectionPin
}

export function createInputLeaseRecord(identity: {
  operationId: string
  ptyId: string
  writer: AutomatedWriter
  pin: ConnectionPin
}): InputLeaseRecord {
  return {
    ...identity,
    phase: 'acquired',
    report: null,
    released: false,
    controller: new AbortController(),
    suspension: null
  }
}

/** Withdraws write authority without deciding the operation's fate. No-op once
 *  the lease is revoked, released, or already suspended by an earlier claim. */
export function suspendInputLease(record: InputLeaseRecord, source: HumanInputSource): void {
  if (record.report || record.released || record.suspension) {
    return
  }
  let settle: (outcome: LeaseRevokedReport | null) => void = () => {}
  const resolved = new Promise<LeaseRevokedReport | null>((resolve) => {
    settle = resolve
  })
  record.suspension = { source, resolved, settle }
}

/** Hands authority back after a claim that never landed. */
export function resumeInputLease(record: InputLeaseRecord): void {
  const suspension = record.suspension
  if (!suspension) {
    return
  }
  record.suspension = null
  suspension.settle(null)
}

/** Stamps the phase-accurate report once; a second cause never overwrites the
 *  first, because the first is the one the operation actually lost to. */
export function revokeInputLease(
  record: InputLeaseRecord,
  revocation: InputLeaseRevocation
): LeaseRevokedReport | null {
  if (record.report) {
    return null
  }
  const { cause, at, ...detail } = revocation
  record.report = {
    ...describePreemptionOutcome(record.phase),
    operationId: record.operationId,
    ptyId: record.ptyId,
    writer: record.writer,
    phase: record.phase,
    cause,
    pin: record.pin,
    at,
    ...detail
  }
  record.controller.abort()
  const suspension = record.suspension
  record.suspension = null
  suspension?.settle(record.report)
  return record.report
}

export function inputLeaseWriteAuthority(record: InputLeaseRecord): LeaseWriteAuthority {
  if (record.report) {
    return 'revoked'
  }
  if (record.released) {
    return 'released'
  }
  return record.suspension ? 'suspended' : 'held'
}

export function createInputLeaseHandle(
  record: InputLeaseRecord,
  onRelease: () => void
): TerminalInputLease {
  const refuseUnlessHeld = (): void => {
    if (record.released) {
      throw new Error('Terminal input lease already released')
    }
    if (record.suspension) {
      throw new TerminalInputLeaseSuspendedError(record.operationId, record.suspension.source)
    }
  }
  const transition = (next: LeaseWritePhase): LeaseRevokedReport | null => {
    refuseUnlessHeld()
    if (record.report) {
      return record.report
    }
    record.phase = next
    return null
  }
  return {
    operationId: record.operationId,
    ptyId: record.ptyId,
    pin: record.pin,
    writer: record.writer,
    revoked: record.controller.signal,
    phase: () => record.phase,
    writeAuthority: () => inputLeaseWriteAuthority(record),
    checkRevoked: () => record.report,
    awaitWriteAuthority: async () => record.report ?? (await (record.suspension?.resolved ?? null)),
    assertStillHeld: () => {
      if (record.report) {
        throw new TerminalInputLeaseRevokedError(record.report)
      }
      refuseUnlessHeld()
    },
    beginPaste: () => transition('pasting'),
    completePaste: () => transition('pasted'),
    armSubmit: () => transition('submitted'),
    release: () => {
      if (record.released) {
        return
      }
      record.released = true
      // Why: waits composed on `revoked` must unwind on the normal path too, and
      // a suspended claim's rollback has nothing left to hand back.
      record.controller.abort()
      resumeInputLease(record)
      onRelease()
    }
  }
}
