/**
 * §5.4's between-phases seam: what an automated writer does while a human claim has
 * *reserved* the pane without deciding it.
 *
 * A mobile input floor is two-phase — it may still roll back — so a suspended lease
 * has lost nothing yet, and killing a healthy operation over a phone write that never
 * landed is the failure two-phase claims exist to prevent. So the writer rides it out.
 *
 * Riding it out is not waiting forever. The suspended writer still holds the pane's
 * lease, so a claim nobody ever commits or rolls back does not merely stall this
 * operation: it strands every later automated writer behind a lease that will never be
 * released. The wait is therefore bounded, and the caller's abort ends it early —
 * both arms reported as `abandoned`, which is this operation giving the pane up, not
 * the pane being taken from it.
 *
 * Pure module — injected clock, no I/O.
 */

import type { SubmitClock } from './agent-prompt-submit-verification'
import type { TerminalInputLease } from './terminal-input-coordinator'
import type { LeaseRevokedReport } from './terminal-input-lease-preemption'

/** Long enough for a phone write's relay round trip to commit or roll back; short
 *  enough that a claim nobody ever decides cannot hold the pane indefinitely. */
export const SUSPENDED_CLAIM_WAIT_MS = 5_000

/** Re-read cadence for the wait. Event-driven wake-up is not available here: the
 *  lease's own await has no deadline, and racing it against one leaves the loser
 *  running against an injected clock. */
export const WRITE_AUTHORITY_POLL_MS = 50

export type WriteAuthorityWait = {
  clock: SubmitClock
  signal?: AbortSignal
  timeoutMs?: number
  pollMs?: number
}

export type AbandonedWriteAuthority = {
  kind: 'abandoned'
  code: 'cancelled' | 'human-claim-undecided'
  reason: string
}

/** `revoked` is §5.4's preemption — the pane was taken. `abandoned` is the bounded
 *  arm — nothing was taken, this operation stopped waiting for it. */
export type WriteAuthorityOutcome =
  | { kind: 'held' }
  | { kind: 'revoked'; report: LeaseRevokedReport }
  | AbandonedWriteAuthority

const ABANDONED_REASON = {
  cancelled: 'the caller cancelled while a human input claim held the pane',
  'human-claim-undecided':
    'a human input claim reserved the pane and neither committed nor rolled back'
} as const

function abandoned(code: AbandonedWriteAuthority['code']): AbandonedWriteAuthority {
  return { kind: 'abandoned', code, reason: ABANDONED_REASON[code] }
}

/**
 * Resolves once the pane's fate is decided: authority is the writer's again, it is
 * gone for good, or the wait ran out. A revocation always wins over a deadline — the
 * report is what §5.4 owes the caller, and it stays true however long it took.
 */
export async function settledWriteAuthority(
  lease: TerminalInputLease,
  wait: WriteAuthorityWait
): Promise<WriteAuthorityOutcome> {
  const startedAt = wait.clock.now()
  const timeoutMs = wait.timeoutMs ?? SUSPENDED_CLAIM_WAIT_MS
  for (;;) {
    const revoked = lease.checkRevoked()
    if (revoked) {
      return { kind: 'revoked', report: revoked }
    }
    if (lease.writeAuthority() !== 'suspended') {
      return { kind: 'held' }
    }
    if (wait.signal?.aborted === true) {
      return abandoned('cancelled')
    }
    if (wait.clock.now() - startedAt >= timeoutMs) {
      return abandoned('human-claim-undecided')
    }
    await wait.clock.sleep(wait.pollMs ?? WRITE_AUTHORITY_POLL_MS)
  }
}

/**
 * Every phase transition, taken only while authority is actually the writer's.
 * The lease *throws* on a suspended transition, which would escape as an exception
 * and lose the §5.4 report entirely. Looping matters because a second claim can
 * arrive while the first is being decided; the transition itself runs in the same
 * synchronous step as the check that cleared it.
 */
export async function transitionUnderHeldAuthority(
  lease: TerminalInputLease,
  wait: WriteAuthorityWait,
  transition: () => LeaseRevokedReport | null
): Promise<WriteAuthorityOutcome> {
  for (;;) {
    const settled = await settledWriteAuthority(lease, wait)
    if (settled.kind !== 'held') {
      return settled
    }
    if (lease.writeAuthority() !== 'suspended') {
      const report = transition()
      return report ? { kind: 'revoked', report } : { kind: 'held' }
    }
  }
}
