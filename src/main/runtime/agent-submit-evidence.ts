/**
 * §5.2's submit verdict as a pure decision over observed evidence — the "did this
 * prompt actually get submitted?" half of `terminal.submitAgentPrompt`
 * (docs/reference/alab-auto-mode-design.md).
 *
 * The measured spike (§5.2a) killed payload-based attribution: **nothing in a hook
 * payload says which submission it belongs to.** `promptInteractionKey` exists only
 * for the opencode family, `stateStartedAt` deliberately does not advance when
 * consecutive events share a state, `receivedAt` is watermark-inflated on relayed
 * panes, and prompt text is a lossy 200-char preview taken after the paste path
 * rewrote ESC bytes. So attribution is **the exclusive lease**: the first certified
 * submit signal on this pane after the watcher was armed, while automation held the
 * pane exclusively, is this operation's — the ambiguity the payload cannot resolve
 * is one §5.1's coordinator excludes by construction.
 *
 * The two limits that construction does not close, both encoded below:
 *  - **Nesting.** A same-type child agent posts to the same endpoint on the same
 *    pane. Its submit is causally downstream of ours, so first-after-arm still
 *    attributes correctly — but a *second* signal inside the window is not a second
 *    submission and is never read as one (`trailingSignals`, never a second verdict).
 *  - **`launchToken`.** Inherited by children, so it rejects a stale pane's hook and
 *    nothing more; it can never separate a nested agent's submit from the lead's.
 *
 * **Best evidence within the settle budget, not first evidence.** Evidence does not
 * arrive in strength order: Enter's own repaint is tier 3 and lands in a millisecond,
 * while the certifying hook needs a render turn. So weak evidence may never end the
 * wait — while the budget is unspent it reports `'settle-pending'` and the caller
 * keeps watching. Only proof (a certified signal), a condition more watching cannot
 * change (preemption before Enter, revocation after it, a recorded hook drop), or the
 * budget running out may produce a verdict.
 *
 * The verdict is deliberately asymmetric. `'no'` may be retried, `'unknown'` never
 * may (§5.2: unknown "is terminal for automation — no automatic retry, ever; it
 * escalates"), so they are separate arms of a discriminated union and `retry` is
 * typed to the single literal each arm allows — `verdict.retry === 'allowed'`
 * narrows to `'no'` at the call site.
 *
 * **Two preconditions this module cannot check, and the caller owns both:**
 *  - *Silence is evidence only if something was watching.* `evidence: 'none'` is the
 *    one `retry: 'allowed'` that follows from seeing nothing, and only a closed-pane
 *    hook drop is representable here. A shed journal window, hooks off by setting
 *    (§5.3), or an SSH relay loss (§5.5) all arrive as the same silence, and retrying
 *    those double-submits into a live agent. `withholdVerdictForLostEvidence` in
 *    agent-prompt-submit-verification.ts is where that check lives.
 *  - *A per-turn key certifies only if it is new.* Pass `priorPerTurnKey` unless the
 *    caller already filtered arrivals to fresh keys, or the opencode family's reply to
 *    the previous turn certifies this one.
 *
 * Certification honesty: five of §5.2a's seven rows were never run against an
 * installed vendor CLI — only claude and codex were — so they rest on Orca-authored
 * fixtures, which prove Orca's parser accepts a payload, not that the vendor emits
 * one. They certify here on §10's basis and carry `measurement: 'fixture'`; a live
 * probe can only ever demote them.
 *
 * Pure: no Electron, no I/O, injectable clock.
 */

import type { TuiAgent } from '../../shared/types'
import type { LeaseRevokedReport } from './terminal-input-lease-preemption'

export type AgentSubmitCertification = {
  /** Does the agent emit a submit-time signal Orca normalizes and can attribute by lease? */
  submitSignal: 'certified' | 'none'
  /** The per-turn discriminator §5.2a *measured as certifying* — not merely "the payload
   *  carries a key". mimo-code and command-code carry one and are `'none'` here. */
  perTurnKey: 'promptInteractionKey' | 'none'
  /** May a native (title-derived) state transition *alone* certify — §5.2's tier 2? */
  nativeStateTransition: 'certifies' | 'observation-only'
  /** What the row rests on. `'fixture'` rows are provisional: §5.2a ran with only claude
   *  and codex installed, so the rest prove Orca's parser, not the vendor CLI. */
  measurement: 'live-cli' | 'fixture' | 'none'
}

/** claude, codex — measured against an installed CLI, submit hook plus a real,
 *  non-circular title state: droid's "no fallback tier" note only means something
 *  because these agents have one. */
const MEASURED_HOOK_AND_NATIVE_STATE = {
  submitSignal: 'certified',
  perTurnKey: 'none',
  nativeStateTransition: 'certifies',
  measurement: 'live-cli'
} as const

/** Submit hook only — the title state is Orca-synthesized (circular), absent, or collapsed. */
const PROVISIONAL_HOOK_ONLY = {
  submitSignal: 'certified',
  perTurnKey: 'none',
  nativeStateTransition: 'observation-only',
  measurement: 'fixture'
} as const

/** No submit event at all; a *new* per-message key is what makes a message event certifiable. */
const PROVISIONAL_PER_TURN_KEY = {
  submitSignal: 'none',
  perTurnKey: 'promptInteractionKey',
  nativeStateTransition: 'observation-only',
  measurement: 'fixture'
} as const

/** In §5.2a's table and refused certification there: measured, and still `unknown`-only. */
const MEASURED_NOT_CERTIFIABLE = {
  submitSignal: 'none',
  perTurnKey: 'none',
  nativeStateTransition: 'observation-only',
  measurement: 'fixture'
} as const

/** Nothing correlatable: `unknown` is the ceiling. Unmeasured agents fail closed here. */
const NOT_CERTIFIABLE = {
  submitSignal: 'none',
  perTurnKey: 'none',
  nativeStateTransition: 'observation-only',
  measurement: 'none'
} as const

/** §5.2a's measured table. The `satisfies` is the drift guard: a new `TuiAgent` will not
 *  compile until its submit evidence is declared, and the only safe default is
 *  `NOT_CERTIFIABLE` — an uncertified agent can still be driven, it just can never be
 *  told `submitted: 'yes'`. */
const AGENT_SUBMIT_CERTIFICATION = {
  claude: MEASURED_HOOK_AND_NATIVE_STATE,
  codex: MEASURED_HOOK_AND_NATIVE_STATE,
  cursor: PROVISIONAL_HOOK_ONLY,
  droid: PROVISIONAL_HOOK_ONLY,
  grok: PROVISIONAL_HOOK_ONLY,
  opencode: PROVISIONAL_PER_TURN_KEY,
  // §5.2a's prose names a `promptInteractionKey` for both, but neither is in its measured
  // table or §10's footnote 1 — an unmeasured key is a payload field, not a certification,
  // and the hook observer leaves both uncertified too.
  'mimo-code': NOT_CERTIFIABLE,
  'command-code': NOT_CERTIFIABLE,
  // §5.2a: `BeforeAgent` is turn-start and prompt-less. The title state is real and still
  // cannot certify — a turn starting is not a user prompt being submitted.
  gemini: MEASURED_NOT_CERTIFIABLE,
  // Not in the spike's measured set. Claude-compatible hooks (kimi, claude-agent-teams)
  // are not measurement, so they wait for a live probe like everyone else.
  'claude-agent-teams': NOT_CERTIFIABLE,
  openclaude: NOT_CERTIFIABLE,
  autohand: NOT_CERTIFIABLE,
  pi: NOT_CERTIFIABLE,
  omp: NOT_CERTIFIABLE,
  antigravity: NOT_CERTIFIABLE,
  aider: NOT_CERTIFIABLE,
  goose: NOT_CERTIFIABLE,
  amp: NOT_CERTIFIABLE,
  kilo: NOT_CERTIFIABLE,
  kiro: NOT_CERTIFIABLE,
  crush: NOT_CERTIFIABLE,
  aug: NOT_CERTIFIABLE,
  cline: NOT_CERTIFIABLE,
  codebuff: NOT_CERTIFIABLE,
  continue: NOT_CERTIFIABLE,
  kimi: NOT_CERTIFIABLE,
  'mistral-vibe': NOT_CERTIFIABLE,
  'qwen-code': NOT_CERTIFIABLE,
  rovo: NOT_CERTIFIABLE,
  hermes: NOT_CERTIFIABLE,
  openclaw: NOT_CERTIFIABLE,
  copilot: NOT_CERTIFIABLE,
  devin: NOT_CERTIFIABLE,
  ante: NOT_CERTIFIABLE
} satisfies Record<TuiAgent, AgentSubmitCertification>

/** A pane with no identified agent has no adapter to certify anything — and typing into a
 *  bare shell was never part of this ladder. */
export function agentSubmitCertification(
  agent: TuiAgent | null | undefined
): AgentSubmitCertification {
  return agent ? AGENT_SUBMIT_CERTIFICATION[agent] : NOT_CERTIFIABLE
}

/** One thing the verify phase saw on the pane. The kinds are §5.2's ladder. */
export type ObservedSubmitEvidence =
  | {
      kind: 'submit-signal'
      /** Hook arrival time, and it must be the *observer's* clock. A relayed pane's payload
       *  `receivedAt` is watermark-inflated — `max(now, watermark + 1)`, so only ever later —
       *  and the window has no upper edge without a revocation, so inflation can only drag a
       *  pre-arm hook forward *into* the window: toward a false `yes`, not away from one. */
      at: number
      /** Normalized event name (`UserPromptSubmit`, `beforeSubmitPrompt`, …). Audit only:
       *  the caller has already filtered to its agent's submit event. */
      hookEventName?: string
      /** Per-message key; opencode family only. Absent or blank leaves the signal uncertified. */
      perTurnKey?: string
      /** Pane/incarnation discriminator, inherited by child agents (§5.2a). */
      launchToken?: string
    }
  | {
      kind: 'native-state-transition'
      /** A non-working→working transition from the fact journal. A working→working repeat
       *  is not a transition and must not be reported here. */
      at: number
    }
  | {
      kind: 'content-change'
      /** Display change past §5.2 step 3's post-echo anchor. Can be a repaint, a stale
       *  spinner, or a terminal query reply, so it is observation only. */
      at: number
    }

/** `SuppressedClosedPaneHookRecord`-shaped, from `getSuppressedHookRecord(paneKey)`. Kept
 *  structural so this module stays free of the hook server. */
export type SuppressedHookObservation = {
  lastSuppressedAt: number
  count?: number
}

export type SubmitEvidenceObservation = {
  /** Agent occupying the pane, from `getTerminalAgentLaunchProfile`; null for a bare shell. */
  agent: TuiAgent | null | undefined
  /** Clock at `armSubmit()` — the attribution boundary Enter was pressed behind. */
  armedAt: number
  /** `lease.checkRevoked()`; null while automation held the pane exclusively throughout. */
  leaseRevocation?: LeaseRevokedReport | null
  observed?: readonly ObservedSubmitEvidence[]
  /** `getSuppressedHookRecord(paneKey)`: a hook Orca dropped is not a hook that never came. */
  suppressedHook?: SuppressedHookObservation | null
  /** How long the verifier watches before "nothing happened" may mean `'no'`. */
  settleBudgetMs?: number
  /** No further evidence can arrive (the caller abandoned the watch), so judge on what is
   *  here rather than reporting `settle-pending`. Distinct from a short budget on purpose:
   *  a budget is time a channel still has, and shortening it to force an answer is the
   *  resend path `MIN_SUBMIT_SETTLE_BUDGET_MS` closes. This says the watching ENDED — the
   *  caller must still refuse to license a resend past the keypress. */
  stopWatching?: boolean
  /** Last per-turn key seen on this pane before the arm. The opencode family certifies on a
   *  *new* key; without a baseline the agent's reply to the previous turn certifies this one.
   *  Omit only when the caller already filtered arrivals to fresh keys. */
  priorPerTurnKey?: string
  /** Rejects a superseded pane's hook. Never used to separate concurrent submits. */
  paneLaunchToken?: string
}

export type SubmitEvidenceTier =
  /** Tier 1: a certified submit signal, post-arm, under exclusive automated hold. */
  | 'certified-submit-signal'
  /** A submit-shaped signal this agent's row does not certify (gemini's `BeforeAgent`, an
   *  opencode message with no per-turn key). Evidence that something happened, not proof. */
  | 'uncertified-submit-signal'
  /** Tier 2: native state transition — `'yes'` only where the table certifies it. */
  | 'native-state-transition'
  /** Tier 3: content change past the anchor. Never `'yes'`. */
  | 'content-change'
  /** Orca dropped a hook for this pane after the arm; "no hook arrived" is not available. */
  | 'suppressed-hook'
  /** §5.4's after-Enter row: write authority gone, watcher read-only, `'no'` unavailable. */
  | 'lease-revoked-after-enter'
  /** §5.4's pre-Enter rows: Enter never landed, so there is nothing to verify. */
  | 'preempted-before-enter'
  /** The budget has not elapsed and nothing conclusive has landed — keep watching. Weak
   *  evidence may already be present; it is not allowed to end the wait, because the tier
   *  that certifies routinely arrives after the tier that cannot. */
  | 'settle-pending'
  /** The budget elapsed under exclusive hold with no evidence and no drop recorded. */
  | 'none'

/** What every verdict reports regardless of outcome. */
export type SubmitEvidenceFindings = {
  evidence: SubmitEvidenceTier
  /** Injected clock at the moment the verdict was taken; the audit ledger's timestamp. */
  decidedAt: number
  /** Timestamp of the evidence that certified this verdict, when one did. */
  attributedAt?: number
  /** Attributable submit signals beyond the first — a same-type child's, never a second
   *  submission (§5.2a nesting). */
  trailingSignals: number
  /** The row this verdict was judged against, so the audit event can carry it. */
  certification: AgentSubmitCertification
}

/**
 * `'unknown'` is structurally distinguishable from `'no'` in three independent ways —
 * the `submitted` discriminant, `retry`, and `escalate` — because the cost of confusing
 * them is a duplicate submission into a live agent.
 */
export type SubmitEvidenceVerdict =
  | (SubmitEvidenceFindings & { submitted: 'yes'; retry: 'forbidden'; escalate: false })
  | (SubmitEvidenceFindings & {
      submitted: 'no'
      /** `'forbidden'` where §5.4 says so anyway: a contaminated draft would double-paste. */
      retry: 'allowed' | 'forbidden'
      escalate: false
    })
  | (SubmitEvidenceFindings & { submitted: 'unknown'; retry: 'forbidden'; escalate: true })

/** Four render turns past `AGENT_PROMPT_SUBMIT_DELAY_MS` (500 ms): long enough that a
 *  hook round-trip on a relayed pane is not read as silence. */
export const DEFAULT_SUBMIT_SETTLE_BUDGET_MS = 2_000

/** Why a floor and not just a ceiling: `evidence: 'none'` is the ONLY verdict that
 *  licenses a resend, and it is honest only if a certifying channel had time to answer.
 *  A budget shorter than the submit delay itself turns silence into "did not send" one
 *  poll after Enter — a duplicate instruction typed into a live agent. The floor is the
 *  clamp; callers may ask for less and are given this. */
export const MIN_SUBMIT_SETTLE_BUDGET_MS = 750

/** The budget a verdict is actually judged against: never below the floor, whatever the
 *  caller asked for. Exported so a caller can poll on the same budget it will be judged by. */
export function resolveSettleBudgetMs(requested: number | undefined): number {
  const budget = requested ?? DEFAULT_SUBMIT_SETTLE_BUDGET_MS
  return Number.isFinite(budget) ? Math.max(budget, MIN_SUBMIT_SETTLE_BUDGET_MS) : budget
}

type ObservedSubmitSignal = Extract<ObservedSubmitEvidence, { kind: 'submit-signal' }>

/** Exclusivity is the entire attribution argument: once a human owns the keyboard a hook on
 *  this pane may be theirs, so evidence from that instant on is no longer ours. */
function exclusiveHoldEndsAt(revocation: LeaseRevokedReport | null): number {
  return revocation ? revocation.at : Number.POSITIVE_INFINITY
}

/** `>= armedAt` on purpose: hook timestamps are millisecond-granular, and discarding a real
 *  hook yields `'no'` — the one answer a caller may act on by submitting again. */
function attributableEvidence<Kind extends ObservedSubmitEvidence['kind']>(
  observation: SubmitEvidenceObservation,
  kind: Kind,
  exclusiveUntil: number
): Extract<ObservedSubmitEvidence, { kind: Kind }>[] {
  const attributable = (observation.observed ?? []).filter(
    (entry): entry is Extract<ObservedSubmitEvidence, { kind: Kind }> =>
      entry.kind === kind && entry.at >= observation.armedAt && entry.at < exclusiveUntil
  )
  return attributable.sort((left, right) => left.at - right.at)
}

/** Only a *mismatch* rejects: a hook that omits the token (relay, older hook script) is not
 *  evidence of a stale pane, and children inherit it so a match proves nothing about which
 *  agent submitted. */
function fromThisPane(
  observation: SubmitEvidenceObservation,
  signal: ObservedSubmitSignal
): boolean {
  return (
    observation.paneLaunchToken === undefined ||
    signal.launchToken === undefined ||
    observation.paneLaunchToken === signal.launchToken
  )
}

/** The opencode family has no submit event, so a *new* per-message key is the certification —
 *  the key is a turn discriminator, not a "something arrived" flag, and its certified arrival
 *  is a message event, which the agent also emits while answering the previous turn. Every
 *  other certified agent certifies on the submit hook itself (§5.2a). */
function signalCertifies(
  observation: SubmitEvidenceObservation,
  certification: AgentSubmitCertification,
  signal: ObservedSubmitSignal
): boolean {
  if (certification.perTurnKey !== 'none') {
    const key = (signal.perTurnKey ?? '').trim()
    return key.length > 0 && key !== observation.priorPerTurnKey?.trim()
  }
  return certification.submitSignal === 'certified'
}

/** Not bounded by the exclusive hold: a hook dropped at any point after the arm means the
 *  verifier is blind, whoever owned the keyboard by then. */
function hookDroppedAfterArm(observation: SubmitEvidenceObservation): boolean {
  const record = observation.suppressedHook
  return record != null && record.lastSuppressedAt >= observation.armedAt
}

/**
 * The §5.2 ladder, evaluated once against everything observed so far. Meant to be called
 * repeatedly while the budget runs: until it elapses, anything short of proof or an
 * unchangeable condition answers `'settle-pending'`, so an early call can never mint a
 * premature `'no'` *or* a premature `'unknown'`.
 */
export function judgeSubmitEvidence(
  observation: SubmitEvidenceObservation,
  options: { now?: () => number } = {}
): SubmitEvidenceVerdict {
  const decidedAt = (options.now ?? Date.now)()
  const certification = agentSubmitCertification(observation.agent)
  const revocation = observation.leaseRevocation ?? null
  const exclusiveUntil = exclusiveHoldEndsAt(revocation)
  const signals = attributableEvidence(observation, 'submit-signal', exclusiveUntil).filter(
    (signal) => fromThisPane(observation, signal)
  )
  const [attributed] = signals
  const base = {
    decidedAt,
    trailingSignals: Math.max(0, signals.length - 1),
    certification
  }
  const unknown = (evidence: SubmitEvidenceTier): SubmitEvidenceVerdict => ({
    ...base,
    evidence,
    submitted: 'unknown',
    retry: 'forbidden',
    escalate: true
  })

  // §5.4's pre-Enter rows own their outcome outright — no Enter was pressed, so no evidence
  // could belong to this operation and the report's own retry verdict stands.
  if (revocation?.submitted === 'no') {
    return {
      ...base,
      evidence: 'preempted-before-enter',
      submitted: 'no',
      retry: revocation.retry,
      escalate: false
    }
  }
  if (attributed && signalCertifies(observation, certification, attributed)) {
    return {
      ...base,
      evidence: 'certified-submit-signal',
      submitted: 'yes',
      attributedAt: attributed.at,
      retry: 'forbidden',
      escalate: false
    }
  }
  const [transition] = attributableEvidence(observation, 'native-state-transition', exclusiveUntil)
  if (transition && certification.nativeStateTransition === 'certifies') {
    return {
      ...base,
      evidence: 'native-state-transition',
      submitted: 'yes',
      attributedAt: transition.at,
      retry: 'forbidden',
      escalate: false
    }
  }
  // Above the budget guard because attribution already stopped at the revocation: no later
  // evidence could be this operation's, so watching longer cannot change the answer.
  if (revocation) {
    return unknown('lease-revoked-after-enter')
  }
  // Also unchangeable: the ingest path drops every hook for a pane in its closed set and the
  // set is cleared only at server stop (§5.2a), so no later hook for this pane can arrive.
  // And it names the actual cause — a submit discarded with a 204 looks exactly like one that
  // never happened.
  if (hookDroppedAfterArm(observation)) {
    return unknown('suppressed-hook')
  }
  // The budget guard sits above every weak tier on purpose. Evidence does not arrive in
  // strength order — Enter's own repaint is tier 3 and lands in a millisecond, the certifying
  // hook needs a render turn — so a ladder that answered on the first tier to produce anything
  // would answer `unknown` before tier 1 could ever arrive, making `'yes'` unreachable.
  if (
    observation.stopWatching !== true &&
    decidedAt - observation.armedAt < resolveSettleBudgetMs(observation.settleBudgetMs)
  ) {
    return unknown('settle-pending')
  }
  // Budget spent: report the strongest thing seen, weakest tier last.
  if (attributed) {
    return unknown('uncertified-submit-signal')
  }
  if (transition) {
    return unknown('native-state-transition')
  }
  if (attributableEvidence(observation, 'content-change', exclusiveUntil).length > 0) {
    return unknown('content-change')
  }
  return { ...base, evidence: 'none', submitted: 'no', retry: 'allowed', escalate: false }
}

/** The only safe way to ask "may I try again?": it narrows to the `'no'` arm, so an
 *  `'unknown'` can never reach a retry path by accident. */
export function submitEvidenceAllowsRetry(
  verdict: SubmitEvidenceVerdict
): verdict is SubmitEvidenceVerdict & { submitted: 'no'; retry: 'allowed' } {
  return verdict.retry === 'allowed'
}
