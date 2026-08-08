/**
 * `terminal.submitAgentPrompt` — §5.2 of docs/reference/alab-auto-mode-design.md.
 *
 * Not a wrapper around `sendTerminalAgentPrompt`'s fixed 500 ms + bare `\r`. The
 * phases run in this order and the order is load-bearing:
 *
 *  1. **Lease** the pane through §5.1's coordinator, which validates the pinned
 *     incarnation, then judge the launch profile with
 *     `decideUnattendedAgentDispatch`. A pane a human is driving from a phone is
 *     refused ahead of both: the coordinator arbitrates automated writers, and
 *     they are not one (§5.4). A refusal is a returned result naming its reason —
 *     never a thrown error and never a silent proceed.
 *  2. **Paste** through the existing bracketed-paste write path, re-checking
 *     revocation between chunks (§5.4). A human claim that has only *reserved*
 *     the pane is waited out, not mourned: it may still roll back, and killing a
 *     healthy operation over a phone write that never landed is the failure
 *     two-phase claims exist to prevent. That wait is bounded and abortable — a
 *     claim nobody decides would otherwise hold this pane's lease forever, and
 *     every later writer behind it.
 *  3. **Echo-settle, then anchor.** Anchoring first lets the paste's own echo
 *     "prove" a submission that never happened.
 *  4. **Arm the watches, then press Enter once.** The hook cursor and the
 *     journal cursor are taken while the lease is still held, `armSubmit()` is
 *     the re-check immediately before the keypress, and Enter is pressed exactly
 *     once — a second Enter on a slow link can auto-confirm the *next* prompt
 *     (aterm's own warning), so re-pressing waits on an adapter that certifies
 *     it, and none does.
 *  5. **Verify** through the verdict module and report the result whole.
 *
 * `submitted: 'unknown'` is terminal. Nothing here retries it, and the result
 * says so three ways, because the cost of reading it as a failure is a duplicate
 * prompt in a live agent. Past step 4's keypress nothing may say otherwise: an
 * abort, an expired wait, or any other early return answers `'unknown'`, never a
 * retryable `'no'`. Only a settle budget that actually elapsed on a watched
 * channel can report that nothing was submitted.
 *
 * Authority note (§6.6): the grant that will eventually gate this verb has no
 * issuer yet, so the unattended-dispatch gate is the only authority check here.
 * When grants land they belong in phase 1, beside it.
 *
 * Pure module — no Electron, no PTY I/O; every side effect arrives as a port.
 */

import { randomUUID } from 'node:crypto'
import { decideUnattendedAgentDispatch } from '../../shared/unattended-agent-dispatch'
import type { TuiAgent } from '../../shared/types'
import {
  agentSubmitCertification,
  DEFAULT_SUBMIT_SETTLE_BUDGET_MS,
  type SubmitEvidenceVerdict
} from './agent-submit-evidence'
import {
  abandonedSubmission,
  draftStateAfterEnter,
  preemptedSubmission,
  stoppedSubmission,
  LEASE_REFUSALS,
  type AgentPromptSubmissionIdentity,
  type AgentPromptSubmissionResult
} from './agent-prompt-submission-result'
import {
  settleEchoThenAnchor,
  verifySubmission,
  type AgentStateTransitionWatch,
  type HookEvidenceWindow,
  type SubmitClock
} from './agent-prompt-submit-verification'
import {
  settledWriteAuthority,
  transitionUnderHeldAuthority,
  type AbandonedWriteAuthority,
  type WriteAuthorityOutcome,
  type WriteAuthorityWait
} from './agent-prompt-write-authority'
import type {
  AcquireInputLeaseRequest,
  AcquireInputLeaseResult,
  TerminalInputLease
} from './terminal-input-coordinator'
import type { AutomatedWriter, ConnectionPin } from './terminal-input-lease-preemption'

export type AgentPromptSubmissionTarget = {
  handle: string
  ptyId: string
  /** Hook evidence is keyed by pane; a pane-less PTY simply has no hook channel. */
  paneKey: string | null
  pin: ConnectionPin
  agent: TuiAgent | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  /** Rejects a superseded incarnation's hooks (§5.2a); never separates two submits. */
  launchToken?: string
}

export type AgentPromptSubmissionRequest = {
  target: AgentPromptSubmissionTarget
  prompt: string
  writer: AutomatedWriter
  /** The stored agent permission preset — `decideUnattendedAgentDispatch`'s input. */
  permissionPreset: unknown
  settleBudgetMs?: number
  signal?: AbortSignal
}

export type AgentPromptSubmissionPorts = {
  acquireLease(request: AcquireInputLeaseRequest): Promise<AcquireInputLeaseResult>
  /** True while a human is driving this pane from a phone. §5.4 classifies this
   *  verb as automation, so it must yield the pane exactly as `terminal.send`
   *  does rather than paste into a keyboard someone else is holding. */
  humanDriverHoldsPane?(ptyId: string): boolean
  /** The existing bracketed-paste write path. `beforeChunk` runs before every
   *  chunk and may throw to abort mid-paste — §5.4's between-chunks seam. Async
   *  so a chunk boundary can ride out a human claim that may still roll back. */
  pastePrompt(ptyId: string, prompt: string, beforeChunk: () => Promise<void>): Promise<void>
  /** One Enter. `false` means the PTY refused the byte, so Enter never landed. */
  pressSubmitKey(ptyId: string): boolean
  /** Monotonic output byte counter: the echo-settle probe and the content anchor. */
  sampleOutputBytes(ptyId: string): number
  armAgentStateWatch(ptyId: string): AgentStateTransitionWatch
  /** Null when nothing here can produce hook evidence for this pane. */
  armHookWindow(paneKey: string, launchToken?: string): HookEvidenceWindow | null
  clock: SubmitClock
  createOperationId?: () => string
  /** §5.2's "only when the provider adapter declares it safe". Default: never. */
  allowsSubmitRepress?: (agent: TuiAgent | null) => boolean
  /**
   * §6.6's grant check, already bound to the caller's presented grant and this
   * target. Absent means no enforcement — that is the renderer/human path, which
   * §6.6 excepts explicitly because a person at the keyboard needs no grant to
   * type into their own terminal.
   *
   * Called twice: once before any bytes are written, and again immediately
   * before Enter, because a grant revoked mid-paste must stop the Enter.
   */
  checkGrant?: () => { allowed: boolean; reason: string }
}

/** Enter presses per operation once an adapter certifies re-pressing; today none does. */
export const MAX_SUBMIT_ATTEMPTS = 2

const HUMAN_DRIVER_REFUSAL_REASON = 'a person is driving this terminal from a phone'

/** No measured adapter certifies a second Enter as safe — §5.2a's table has no such
 *  column — and a wrong guess auto-confirms whatever prompt the agent shows next. */
export function agentAllowsSubmitRepress(_agent: TuiAgent | null): boolean {
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function submitAgentPrompt(
  request: AgentPromptSubmissionRequest,
  ports: AgentPromptSubmissionPorts
): Promise<AgentPromptSubmissionResult> {
  const { target } = request
  const identity: AgentPromptSubmissionIdentity = {
    handle: target.handle,
    ptyId: target.ptyId,
    pin: target.pin,
    certification: agentSubmitCertification(target.agent),
    trailingSignals: 0,
    evidenceChannel: 'intact'
  }
  // Before the lease, not after: the coordinator arbitrates automated writers,
  // and a phone human is not one — nothing here may take a pane they are driving.
  if (ports.humanDriverHoldsPane?.(target.ptyId) === true) {
    return stoppedSubmission(
      identity,
      'refused',
      { code: 'mobile-driver-active', reason: HUMAN_DRIVER_REFUSAL_REASON },
      {
        operationId: (ports.createOperationId ?? randomUUID)(),
        // Nothing was written, so the draft is clean and a later attempt — once
        // the human has put the phone down — is safe.
        retry: 'allowed',
        draftState: 'clean',
        decidedAt: ports.clock.now()
      }
    )
  }
  const acquired = await ports.acquireLease({
    ptyId: target.ptyId,
    pin: target.pin,
    writer: request.writer,
    ...(request.signal ? { signal: request.signal } : {})
  })
  if (!acquired.ok) {
    const refused = LEASE_REFUSALS[acquired.reason]
    return stoppedSubmission(
      // `generation-change` promises the live pin so the caller can re-resolve
      // and go again; the requested pin is the one that is already dead.
      acquired.currentPin ? { ...identity, pin: acquired.currentPin } : identity,
      'lease',
      { code: acquired.reason, reason: refused.reason },
      {
        operationId: (ports.createOperationId ?? randomUUID)(),
        retry: refused.retry,
        draftState: 'clean',
        decidedAt: ports.clock.now()
      }
    )
  }
  try {
    return await runLeasedSubmission(request, ports, acquired.lease, identity)
  } finally {
    acquired.lease.release()
  }
}

async function runLeasedSubmission(
  request: AgentPromptSubmissionRequest,
  ports: AgentPromptSubmissionPorts,
  lease: TerminalInputLease,
  identity: AgentPromptSubmissionIdentity
): Promise<AgentPromptSubmissionResult> {
  const { target } = request
  const operationId = lease.operationId
  const wait: WriteAuthorityWait = {
    clock: ports.clock,
    ...(request.signal ? { signal: request.signal } : {})
  }
  const stopped = (
    phase: 'refused' | 'paste' | 'arm',
    code: 'unattended-dispatch' | 'paste-failed' | 'submit-key-refused' | 'grant-required',
    reason: string,
    draftState: 'clean' | 'contaminated'
  ): AgentPromptSubmissionResult =>
    stoppedSubmission(
      identity,
      phase,
      { code, reason },
      {
        operationId,
        // Every stop here is either a deterministic policy answer or a half-written
        // draft; neither gets safer by sending the same prompt again.
        retry: 'forbidden',
        draftState,
        decidedAt: ports.clock.now()
      }
    )
  /** A phase that could not be taken: the pane was preempted, or the wait for a human
   *  claim nobody decided was given up on. Both stop before Enter. */
  const interrupted = (
    phase: 'paste' | 'echo-settle' | 'arm',
    outcome: Exclude<WriteAuthorityOutcome, { kind: 'held' }>
  ): AgentPromptSubmissionResult =>
    outcome.kind === 'revoked'
      ? preemptedSubmission(identity, phase, outcome.report, {
          operationId,
          decidedAt: ports.clock.now()
        })
      : abandonedSubmission(
          identity,
          phase,
          { code: outcome.code, reason: outcome.reason },
          { operationId, leasePhase: lease.phase(), decidedAt: ports.clock.now() }
        )

  // Authority before posture: an ungranted caller is refused before Orca even
  // considers whether the target's launch is safe to drive, so a missing grant
  // never reads as a permission-preset problem.
  const granted = ports.checkGrant?.()
  if (granted && !granted.allowed) {
    return stopped('refused', 'grant-required', granted.reason, 'clean')
  }

  const dispatch = decideUnattendedAgentDispatch({
    preset: request.permissionPreset,
    agent: target.agent,
    agentArgs: target.agentArgs ?? null,
    agentEnv: target.agentEnv ?? null
  })
  if (dispatch.refuse) {
    return stopped('refused', 'unattended-dispatch', dispatch.reason, 'clean')
  }

  const beforePaste = await transitionUnderHeldAuthority(lease, wait, () => lease.beginPaste())
  if (beforePaste.kind !== 'held') {
    return interrupted('paste', beforePaste)
  }
  let abandonedMidPaste: AbandonedWriteAuthority | null = null
  try {
    await ports.pastePrompt(target.ptyId, request.prompt, async () => {
      // A reserved-but-undecided phone claim is not a lost pane: wait it out, and
      // only a real revocation aborts the paste.
      const settled = await settledWriteAuthority(lease, wait)
      if (settled.kind === 'abandoned') {
        // The paste path's only abort seam is a throw, and the lease is still
        // suspended here, so assertStillHeld below is the throw.
        abandonedMidPaste = settled
      }
      lease.assertStillHeld()
    })
  } catch (error) {
    // Revocation first, as in the wait itself: a pane that was actually taken owes
    // the caller §5.4's report, whatever this operation had already decided.
    const revoked = lease.checkRevoked()
    if (revoked) {
      return interrupted('paste', { kind: 'revoked', report: revoked })
    }
    const gaveUp: AbandonedWriteAuthority | null = abandonedMidPaste
    if (gaveUp) {
      return interrupted('paste', gaveUp)
    }
    // Why contaminated rather than clean: the write path can fail after some
    // chunks landed, and a generic TUI draft cannot be rolled back (§5.4).
    return stopped('paste', 'paste-failed', errorMessage(error), 'contaminated')
  }
  const pasted = await transitionUnderHeldAuthority(lease, wait, () => lease.completePaste())
  if (pasted.kind !== 'held') {
    return interrupted('paste', pasted)
  }

  const anchorBytes = await settleEchoThenAnchor(
    () => ports.sampleOutputBytes(target.ptyId),
    ports.clock,
    { stop: () => lease.checkRevoked() !== null }
  )
  const settled = await settledWriteAuthority(lease, wait)
  if (settled.kind !== 'held') {
    return interrupted('echo-settle', settled)
  }

  // Armed before Enter and under the still-held lease: §5.2a's attribution is
  // "the first certified signal after the arm, while automation held the pane".
  const hooks = target.paneKey ? ports.armHookWindow(target.paneKey, target.launchToken) : null
  const transitions = ports.armAgentStateWatch(target.ptyId)
  const armed = await transitionUnderHeldAuthority(lease, wait, () => lease.armSubmit())
  if (armed.kind !== 'held') {
    return interrupted('arm', armed)
  }
  // §6.6: re-checked here, not only at the start. A grant revoked while the
  // prompt was pasting must stop the Enter — the draft is contaminated either
  // way, but an un-pressed Enter is the difference between a stranded draft and
  // a turn the human never authorized.
  const stillGranted = ports.checkGrant?.()
  if (stillGranted && !stillGranted.allowed) {
    return stopped('arm', 'grant-required', stillGranted.reason, 'contaminated')
  }
  const armedAt = ports.clock.now()
  if (!ports.pressSubmitKey(target.ptyId)) {
    return stopped(
      'arm',
      'submit-key-refused',
      'the terminal refused the submit key',
      'contaminated'
    )
  }

  const watchers = {
    hooks,
    transitions,
    anchorBytes,
    sampleOutputBytes: () => ports.sampleOutputBytes(target.ptyId)
  }
  const budgetMs = request.settleBudgetMs ?? DEFAULT_SUBMIT_SETTLE_BUDGET_MS
  // Attribution still starts at the first arm — a second Enter does not disown the
  // first one's evidence — but the budget is a *watching* window, so it is measured
  // from the keypress being watched. Without this a re-press is judged on the
  // already-spent budget and gets no settle time at all.
  const verify = async (): Promise<{
    verdict: SubmitEvidenceVerdict
    lossy: boolean
  }> =>
    verifySubmission({
      observation: {
        agent: target.agent,
        armedAt,
        settleBudgetMs: ports.clock.now() - armedAt + budgetMs,
        ...(target.launchToken ? { paneLaunchToken: target.launchToken } : {})
      },
      watchers,
      clock: ports.clock,
      leaseRevocation: () => lease.checkRevoked(),
      ...(request.signal ? { signal: request.signal } : {})
    })

  let outcome = await verify()
  let attempts = 1
  const allowsRepress = ports.allowsSubmitRepress ?? agentAllowsSubmitRepress
  // Only "nothing at all happened" is a candidate for a second Enter, and only an
  // adapter that certifies re-pressing may take it.
  while (
    attempts < MAX_SUBMIT_ATTEMPTS &&
    outcome.verdict.submitted === 'no' &&
    outcome.verdict.evidence === 'none' &&
    allowsRepress(target.agent) &&
    lease.checkRevoked() === null
  ) {
    if (!ports.pressSubmitKey(target.ptyId)) {
      break
    }
    attempts += 1
    outcome = await verify()
  }

  const { verdict } = outcome
  // §5.4's after-Enter row: write authority may be gone, but the watcher ran
  // read-only to a verdict, so the result is never reported as 'preempted'.
  const revokedAfterEnter = lease.checkRevoked()
  return {
    ...identity,
    operationId,
    phase: 'verify',
    submitted: verdict.submitted,
    evidence: verdict.evidence,
    retry: verdict.retry,
    escalate: verdict.escalate,
    attempts,
    draftState: draftStateAfterEnter(verdict.submitted),
    evidenceChannel: outcome.lossy ? 'lossy' : 'intact',
    decidedAt: verdict.decidedAt,
    ...(verdict.attributedAt !== undefined ? { attributedAt: verdict.attributedAt } : {}),
    trailingSignals: verdict.trailingSignals,
    certification: verdict.certification,
    ...(revokedAfterEnter ? { preemption: revokedAfterEnter } : {})
  }
}
