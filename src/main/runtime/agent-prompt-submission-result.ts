/**
 * What `terminal.submitAgentPrompt` reports — §5.2 step 6 of
 * docs/reference/alab-auto-mode-design.md.
 *
 * Its own module because the RPC verb, the CLI printer and the audit ledger all
 * read this vocabulary while none of them should pull in the state machine. The
 * shape is deliberately over-specified about one thing: `'unknown'` is terminal
 * for automation, so it is distinguishable from `'no'` by three independent
 * fields (`submitted`, `retry`, `escalate`) rather than by a caller's care.
 */

import type { SubmitEvidenceTier, AgentSubmitCertification } from './agent-submit-evidence'
import {
  describePreemptionOutcome,
  type ConnectionPin,
  type DraftState,
  type LeaseRevokedReport,
  type LeaseWritePhase
} from './terminal-input-lease-preemption'

/** How far the machine got. `verify` is the only phase where evidence exists. */
export type AgentPromptSubmissionPhase =
  | 'lease'
  | 'refused'
  | 'paste'
  | 'echo-settle'
  | 'arm'
  | 'verify'

export type AgentPromptSubmissionRefusalCode =
  | 'pty-disposed'
  | 'generation-change'
  | 'cancelled'
  | 'unattended-dispatch'
  | 'paste-failed'
  | 'submit-key-refused'
  /** §6.6: the caller presented no fleet grant, or one that no longer authorizes
   *  this pane. Re-checked immediately before Enter, so this can also mean the
   *  grant was revoked while the prompt was being pasted. */
  | 'grant-required'
  /** A person is driving this pane from a phone — §5.4's human floor outranks
   *  every automated writer, and this verb is one of them. */
  | 'mobile-driver-active'
  /** A two-phase human claim reserved the pane and never committed or rolled back.
   *  The pane was never lost, so this is not a preemption; the operation gave it up
   *  rather than hold the lease against every other writer forever. */
  | 'human-claim-undecided'

export type AgentPromptSubmissionResult = {
  /** The lease's id once one was granted — what a preemption report joins on. */
  operationId: string
  handle: string
  ptyId: string
  phase: AgentPromptSubmissionPhase
  submitted: 'yes' | 'no' | 'unknown'
  evidence: SubmitEvidenceTier | 'not-attempted'
  retry: 'allowed' | 'forbidden'
  /** Set only for `'unknown'`; §5.2 forbids retrying it, ever. */
  escalate: boolean
  /** Enter presses. Always 1 unless an adapter certified re-pressing. */
  attempts: number
  draftState: DraftState
  pin: ConnectionPin
  certification: AgentSubmitCertification
  /** `'lossy'` means silence could not be trusted, which is why `'unknown'` won. */
  evidenceChannel: 'intact' | 'lossy'
  decidedAt: number
  attributedAt?: number
  /** Submit signals after the first — a nested child's turn, not a second submit. */
  trailingSignals: number
  refusal?: { code: AgentPromptSubmissionRefusalCode; reason: string }
  preemption?: LeaseRevokedReport
}

/** Identity every result carries whatever phase it stopped in. */
export type AgentPromptSubmissionIdentity = Pick<
  AgentPromptSubmissionResult,
  'handle' | 'ptyId' | 'pin' | 'certification' | 'trailingSignals' | 'evidenceChannel'
>

/** Why the lease was refused, and whether resending is safe. */
export const LEASE_REFUSALS: Record<
  'generation-change' | 'pty-disposed' | 'cancelled',
  { reason: string; retry: 'allowed' | 'forbidden' }
> = {
  // Nothing was written and the live pin is in the result — re-resolve and go again.
  'generation-change': {
    reason: 'the terminal was replaced by a newer incarnation before the prompt was written',
    retry: 'allowed'
  },
  'pty-disposed': {
    reason: 'the terminal is no longer running',
    retry: 'forbidden'
  },
  cancelled: {
    reason: 'the caller cancelled before the pane was leased',
    retry: 'allowed'
  }
}

/** After Enter the draft's fate follows the verdict: a submitted prompt left the
 *  box, an unsubmitted one is still sitting in it, and `unknown` cannot say. */
export function draftStateAfterEnter(submitted: 'yes' | 'no' | 'unknown'): DraftState {
  if (submitted === 'yes') {
    return 'clean'
  }
  return submitted === 'no' ? 'contaminated' : 'unknown'
}

/** A stop before any evidence could exist: a refused lease, a refused dispatch, or
 *  a write the terminal would not take. Always `'no'` — nothing was ever submitted. */
export function stoppedSubmission(
  identity: AgentPromptSubmissionIdentity,
  phase: AgentPromptSubmissionPhase,
  refusal: { code: AgentPromptSubmissionRefusalCode; reason: string },
  detail: {
    operationId: string
    retry: 'allowed' | 'forbidden'
    draftState: DraftState
    decidedAt: number
  }
): AgentPromptSubmissionResult {
  return {
    ...identity,
    operationId: detail.operationId,
    phase,
    submitted: 'no',
    evidence: 'not-attempted',
    retry: detail.retry,
    escalate: false,
    attempts: 0,
    draftState: detail.draftState,
    decidedAt: detail.decidedAt,
    refusal
  }
}

/**
 * The pane was never lost — this operation gave it up: the bounded wait on a human
 * claim that was never decided ran out, or the caller cancelled during it. There is
 * no preemption report to speak for it, so §5.4's own phase row does, which is the
 * same table a preemption at that phase would have used.
 */
export function abandonedSubmission(
  identity: AgentPromptSubmissionIdentity,
  phase: AgentPromptSubmissionPhase,
  refusal: { code: AgentPromptSubmissionRefusalCode; reason: string },
  detail: { operationId: string; leasePhase: LeaseWritePhase; decidedAt: number }
): AgentPromptSubmissionResult {
  const gaveUp = describePreemptionOutcome(detail.leasePhase)
  return stoppedSubmission(identity, phase, refusal, {
    operationId: detail.operationId,
    // Both fields come from the table, so a half-written draft can never report
    // itself retryable and a landed Enter can never report itself anything at all.
    retry: gaveUp.retry,
    draftState: gaveUp.draftState,
    decidedAt: detail.decidedAt
  })
}

/** §5.4's pre-Enter rows. Enter never landed, so the preemption report — not the
 *  evidence ladder — decides the outcome, contaminated draft included. */
export function preemptedSubmission(
  identity: AgentPromptSubmissionIdentity,
  phase: AgentPromptSubmissionPhase,
  report: LeaseRevokedReport,
  detail: { operationId: string; decidedAt: number }
): AgentPromptSubmissionResult {
  return {
    ...identity,
    operationId: detail.operationId,
    phase,
    submitted: 'no',
    evidence: 'preempted-before-enter',
    retry: report.retry,
    escalate: false,
    attempts: 0,
    draftState: report.draftState,
    decidedAt: detail.decidedAt,
    preemption: report
  }
}
