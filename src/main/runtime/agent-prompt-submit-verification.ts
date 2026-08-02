/**
 * §5.2 steps 3 and 5 of docs/reference/alab-auto-mode-design.md: settle the paste
 * echo and *then* anchor, and afterwards read the armed watches until the verdict
 * module can answer honestly.
 *
 * The ordering is the whole point. aterm's control_session.rs:982 learned it the
 * hard way: an anchor captured before the paste is satisfied by the paste's own
 * echo, so an Enter that never registered still looks like "the display moved"
 * — which turns a retryable `'no'` into a permanent `'unknown'`. The anchor is
 * therefore taken after the echo goes quiet, and never before.
 *
 * The verdict itself belongs to agent-submit-evidence.ts. This module only feeds
 * it, plus one thing that module cannot know: whether the evidence channel was
 * intact. Silence means `'no'` only if something was actually watching.
 *
 * Pure module — no Electron, no PTY I/O, injected clock.
 */

import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import type { SubmitEvidenceWindow } from '../agent-hooks/agent-submit-hook-observer'
import {
  agentSubmitCertification,
  judgeSubmitEvidence,
  type ObservedSubmitEvidence,
  type SubmitEvidenceObservation,
  type SubmitEvidenceVerdict,
  type SuppressedHookObservation
} from './agent-submit-evidence'
import type { LeaseRevokedReport } from './terminal-input-lease-preemption'

/** Quiet needed before the paste echo counts as finished. */
export const AGENT_PROMPT_ECHO_QUIET_MS = 150

/** Ceiling on echo-settle: a TUI with a spinner or a clock never goes quiet, and
 *  anchoring on a moving display beats never pressing Enter. */
export const AGENT_PROMPT_ECHO_SETTLE_MAX_MS = 1_500

/** How often the settle and verify loops re-read their probes. */
export const AGENT_PROMPT_SUBMIT_POLL_MS = 50

export type SubmitClock = {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export type AgentStateTransitionWatch = {
  /** Cumulative and idempotent — the verify loop calls it on every poll.
   *  `lost` means journal retention or an incarnation change ate the window. */
  transitionsSinceArm(): { at: readonly number[]; lost: boolean }
}

export type HookEvidenceWindow = {
  /** Idempotent read of `AgentSubmitHookObserver.since(cursor)`. */
  read(): SubmitEvidenceWindow
}

export type ArmedSubmitWatchers = {
  /** Null when nothing can produce hook evidence here — hooks off, no evidence
   *  source wired, or a pane with no pane key. */
  hooks: HookEvidenceWindow | null
  transitions: AgentStateTransitionWatch
  /** Output position captured *after* the echo settled (§5.2 step 3). */
  anchorBytes: number
  sampleOutputBytes: () => number
}

export type CollectedSubmitEvidence = {
  observed: ObservedSubmitEvidence[]
  suppressedHook: SuppressedHookObservation | null
  /** The channel lost (or never had) evidence it was supposed to carry. */
  lossy: boolean
}

/**
 * Waits for the paste echo to quiesce, then samples the anchor.
 *
 * The floor is not padding: Codex and Claude need a render turn after the
 * bracketed-paste terminator before Enter reads as *submit* instead of paste
 * content, and echo can fall quiet before that turn lands. Same gap the proven
 * `writeTerminalAgentPrompt` path uses, now a floor rather than the whole wait.
 */
export async function settleEchoThenAnchor(
  sampleOutputBytes: () => number,
  clock: SubmitClock,
  options: {
    quietMs?: number
    maxMs?: number
    floorMs?: number
    pollMs?: number
    /** Cuts the wait short when the pane is already lost — a revoked lease has
     *  nothing left to anchor for. */
    stop?: () => boolean
  } = {}
): Promise<number> {
  const quietMs = options.quietMs ?? AGENT_PROMPT_ECHO_QUIET_MS
  const maxMs = options.maxMs ?? AGENT_PROMPT_ECHO_SETTLE_MAX_MS
  const floorMs = options.floorMs ?? AGENT_PROMPT_SUBMIT_DELAY_MS
  const pollMs = options.pollMs ?? AGENT_PROMPT_SUBMIT_POLL_MS
  const startedAt = clock.now()
  let bytes = sampleOutputBytes()
  let lastChangeAt = startedAt
  for (;;) {
    const at = clock.now()
    if (at - startedAt >= maxMs || options.stop?.() === true) {
      break
    }
    if (at - startedAt >= floorMs && at - lastChangeAt >= quietMs) {
      break
    }
    await clock.sleep(pollMs)
    const next = sampleOutputBytes()
    if (next !== bytes) {
      bytes = next
      lastChangeAt = clock.now()
    }
  }
  // Sampled last, deliberately: this is the anchor, and it must sit after every
  // byte the paste echoed.
  return sampleOutputBytes()
}

/**
 * Whether this agent's *only* certifying channel runs through the hook window.
 * Two rows qualify and they fail identically without it: the certified submit
 * hook, and the opencode family's per-turn key — which arrives on a hook event
 * too, so a null window makes both indistinguishable from an agent that simply
 * never submitted. Only that distinction licenses a second Enter (§5.2).
 */
export function submitCertificationNeedsHookWindow(
  agent: SubmitEvidenceObservation['agent']
): boolean {
  const certification = agentSubmitCertification(agent)
  return certification.submitSignal === 'certified' || certification.perTurnKey !== 'none'
}

/** Reads every armed watch into the verdict module's vocabulary. */
export function collectSubmitEvidence(
  watchers: ArmedSubmitWatchers,
  at: number,
  needsHookWindow: boolean
): CollectedSubmitEvidence {
  const observed: ObservedSubmitEvidence[] = []
  const window = watchers.hooks?.read()
  for (const arrival of window?.certified ?? []) {
    observed.push({
      kind: 'submit-signal',
      at: arrival.at,
      ...(arrival.hookEventName ? { hookEventName: arrival.hookEventName } : {}),
      ...(arrival.promptInteractionKey ? { perTurnKey: arrival.promptInteractionKey } : {}),
      ...(arrival.launchToken ? { launchToken: arrival.launchToken } : {})
    })
  }
  // Why tier 3 and not a submit-signal: the verdict module certifies a submit-signal
  // from the agent's row alone, so passing an arrival the observer declined to
  // certify would launder it into `'yes'`. An uncertified turn boundary is exactly
  // what tier 3 means — something moved, and it is not proof.
  for (const arrival of window?.observed ?? []) {
    observed.push({ kind: 'content-change', at: arrival.at })
  }
  const transitions = watchers.transitions.transitionsSinceArm()
  for (const transitionAt of transitions.at) {
    observed.push({ kind: 'native-state-transition', at: transitionAt })
  }
  if (watchers.sampleOutputBytes() !== watchers.anchorBytes) {
    observed.push({ kind: 'content-change', at })
  }
  return {
    observed,
    suppressedHook:
      window?.dropped && window.drop
        ? {
            lastSuppressedAt: window.drop.lastSuppressedAt,
            count: window.drop.count
          }
        : null,
    lossy:
      transitions.lost ||
      window?.truncated === true ||
      window?.dropped === true ||
      // An agent whose certification only ever arrives here cannot be told apart
      // from one whose evidence never came, and only one of those may retry.
      (watchers.hooks === null && needsHookWindow)
  }
}

/**
 * Silence is evidence only when something was watching. A gapped journal, a shed
 * hook window, or a pane with no hook channel makes `'no'` a licence to submit
 * the same prompt twice into a live agent — so it degrades to `'unknown'`, which
 * §5.2 forbids retrying.
 */
export function withholdVerdictForLostEvidence(
  verdict: SubmitEvidenceVerdict,
  lossy: boolean
): SubmitEvidenceVerdict {
  if (!lossy || verdict.submitted !== 'no' || verdict.evidence !== 'none') {
    return verdict
  }
  return {
    ...verdict,
    submitted: 'unknown',
    retry: 'forbidden',
    escalate: true
  }
}

/**
 * Abandoning the watch is not evidence about the world. By the time this runs Enter
 * has landed, so a caller that stops listening leaves exactly one honest answer:
 * `'unknown'`, which §5.2 forbids retrying. `'no'` here would report that an agent
 * never received a prompt it may already be running — and `retry: 'allowed'` on top
 * of that is a licence to type the same instruction into it twice.
 */
export function withholdVerdictForAbandonedWatch(
  verdict: SubmitEvidenceVerdict
): SubmitEvidenceVerdict {
  if (verdict.submitted !== 'no') {
    return verdict
  }
  return {
    ...verdict,
    submitted: 'unknown',
    retry: 'forbidden',
    escalate: true
  }
}

export type SubmitVerificationOutcome = {
  verdict: SubmitEvidenceVerdict
  lossy: boolean
}

/**
 * Best evidence within the settle budget, never first evidence. Evidence does
 * not arrive in strength order — Enter's own repaint is tier 3 and lands in a
 * millisecond, the certifying hook needs a render turn — so `'settle-pending'`
 * is the verdict module saying "keep watching", and treating it as an answer is
 * what makes `submitted: 'yes'` unreachable in production. The loop therefore
 * ends only on proof, on a condition more watching cannot change, or on the
 * budget running out.
 *
 * An aborted caller stops the poll and can never reach a retryable verdict. Enter
 * has already landed, so the answer is the strongest evidence in hand at that
 * instant — judged with the budget treated as spent, so the internal "keep watching"
 * tier is never printed as the reason a submit was unprovable — and a `'no'` there
 * degrades to `'unknown'`, because giving up on watching says nothing about whether
 * the agent got the prompt. Only a budget that actually elapsed under a watched
 * channel may answer `'no'`.
 */
export async function verifySubmission(args: {
  observation: Omit<SubmitEvidenceObservation, 'observed' | 'suppressedHook' | 'leaseRevocation'>
  watchers: ArmedSubmitWatchers
  clock: SubmitClock
  leaseRevocation: () => LeaseRevokedReport | null
  signal?: AbortSignal
  pollMs?: number
}): Promise<SubmitVerificationOutcome> {
  const needsHookWindow = submitCertificationNeedsHookWindow(args.observation.agent)
  const pollMs = args.pollMs ?? AGENT_PROMPT_SUBMIT_POLL_MS
  for (;;) {
    const at = args.clock.now()
    const collected = collectSubmitEvidence(args.watchers, at, needsHookWindow)
    const judge = (stopWatching?: boolean): SubmitEvidenceVerdict =>
      judgeSubmitEvidence(
        {
          ...args.observation,
          ...(stopWatching === true ? { stopWatching: true } : {}),
          observed: collected.observed,
          suppressedHook: collected.suppressedHook,
          leaseRevocation: args.leaseRevocation()
        },
        { now: args.clock.now }
      )
    const verdict = judge()
    if (verdict.evidence !== 'settle-pending') {
      return {
        verdict: withholdVerdictForLostEvidence(verdict, collected.lossy),
        lossy: collected.lossy
      }
    }
    if (args.signal?.aborted === true) {
      const abandoned = withholdVerdictForAbandonedWatch(judge(true))
      return {
        verdict: withholdVerdictForLostEvidence(abandoned, collected.lossy),
        lossy: collected.lossy
      }
    }
    await args.clock.sleep(pollMs)
  }
}
