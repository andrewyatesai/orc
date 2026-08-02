import { describe, expect, it } from 'vitest'
import {
  agentSubmitCertification,
  DEFAULT_SUBMIT_SETTLE_BUDGET_MS,
  judgeSubmitEvidence,
  MIN_SUBMIT_SETTLE_BUDGET_MS,
  resolveSettleBudgetMs,
  submitEvidenceAllowsRetry,
  type ObservedSubmitEvidence,
  type SubmitEvidenceObservation,
  type SubmitEvidenceVerdict
} from './agent-submit-evidence'
import {
  describePreemptionOutcome,
  type ConnectionPin,
  type LeaseRevokedReport,
  type LeaseWritePhase
} from './terminal-input-lease-preemption'

const PIN: ConnectionPin = { ptyIncarnationId: 'inc-1', connectionGeneration: 2 }
const ARMED_AT = 1_000
/** At the floor, not below it: a budget the module would clamp anyway would make every
 *  "settled" assertion below quietly measure the clamp instead of the tier under test. */
const SETTLE_BUDGET_MS = MIN_SUBMIT_SETTLE_BUDGET_MS
/** Past the settle budget, so "nothing happened" is allowed to mean 'no'. */
const SETTLED_AT = ARMED_AT + SETTLE_BUDGET_MS

function judge(
  observation: Partial<SubmitEvidenceObservation> = {},
  at = SETTLED_AT
): SubmitEvidenceVerdict {
  return judgeSubmitEvidence(
    { agent: 'claude', armedAt: ARMED_AT, settleBudgetMs: SETTLE_BUDGET_MS, ...observation },
    { now: () => at }
  )
}

function submitSignal(
  at: number,
  detail: Partial<Extract<ObservedSubmitEvidence, { kind: 'submit-signal' }>> = {}
): ObservedSubmitEvidence {
  return { kind: 'submit-signal', at, hookEventName: 'UserPromptSubmit', ...detail }
}

/** Mirrors `verifySubmission`'s loop: re-judge on every poll, stopping at the first
 *  verdict that is not `'settle-pending'`. Evidence becomes visible when its clock
 *  arrives, which is the ordering the ladder has to survive. */
function pollUntilDecided(
  observation: Partial<SubmitEvidenceObservation>,
  timeline: readonly ObservedSubmitEvidence[],
  options: { pollMs?: number; untilAt?: number } = {}
): SubmitEvidenceVerdict {
  const pollMs = options.pollMs ?? 5
  const untilAt = options.untilAt ?? SETTLED_AT + pollMs
  let verdict = judge({ ...observation, observed: [] }, ARMED_AT)
  for (let at = ARMED_AT; at <= untilAt; at += pollMs) {
    verdict = judge({ ...observation, observed: timeline.filter((entry) => entry.at <= at) }, at)
    if (verdict.evidence !== 'settle-pending') {
      return verdict
    }
  }
  return verdict
}

function preemption(phase: LeaseWritePhase, at: number): LeaseRevokedReport {
  return {
    ...describePreemptionOutcome(phase),
    operationId: 'op-1',
    ptyId: 'pty-1',
    writer: 'manager',
    phase,
    cause: 'human-input',
    humanSource: 'desktop',
    pin: PIN,
    at
  }
}

describe('agent submit certification table', () => {
  it('certifies only what the §5.2a spike measured', () => {
    expect(agentSubmitCertification('claude')).toEqual({
      submitSignal: 'certified',
      perTurnKey: 'none',
      nativeStateTransition: 'certifies',
      measurement: 'live-cli'
    })
    // Cursor's title is Orca-synthesized, so tier 2 would be circular evidence.
    expect(agentSubmitCertification('cursor').nativeStateTransition).toBe('observation-only')
    // Droid defers entirely to its hook — the row §5.2a calls "no fallback tier".
    expect(agentSubmitCertification('droid')).toMatchObject({
      submitSignal: 'certified',
      nativeStateTransition: 'observation-only'
    })
    expect(agentSubmitCertification('opencode').perTurnKey).toBe('promptInteractionKey')
  })

  it('refuses to certify agents §5.2a never measured, per-turn key or not', () => {
    // §5.2a's prose names a promptInteractionKey for both, but neither is in its measured
    // table or §10's footnote 1 — and the hook observer leaves both uncertified.
    for (const agent of ['mimo-code', 'command-code'] as const) {
      expect(agentSubmitCertification(agent)).toEqual({
        submitSignal: 'none',
        perTurnKey: 'none',
        nativeStateTransition: 'observation-only',
        measurement: 'none'
      })
      expect(
        judge({ agent, observed: [submitSignal(ARMED_AT + 3, { perTurnKey: 'turn-42' })] })
      ).toMatchObject({ submitted: 'unknown', evidence: 'uncertified-submit-signal' })
    }
  })

  it('records which rows a live CLI measured and which rest on Orca fixtures', () => {
    // Only claude (2.1.220) and codex (0.146.0) were installed when the spike ran.
    expect(agentSubmitCertification('claude').measurement).toBe('live-cli')
    expect(agentSubmitCertification('codex').measurement).toBe('live-cli')
    // A fixture proves Orca's parser accepts the payload, not that the vendor CLI emits it.
    for (const agent of ['cursor', 'droid', 'grok', 'opencode', 'gemini'] as const) {
      expect(agentSubmitCertification(agent).measurement).toBe('fixture')
    }
    expect(agentSubmitCertification('aider').measurement).toBe('none')
    expect(agentSubmitCertification(null).measurement).toBe('none')
  })

  it('leaves gemini and unmeasured agents with no certifying path at all', () => {
    for (const agent of ['gemini', 'aider', 'claude-agent-teams'] as const) {
      expect(agentSubmitCertification(agent)).toMatchObject({
        submitSignal: 'none',
        perTurnKey: 'none',
        nativeStateTransition: 'observation-only'
      })
    }
    // A bare shell has no adapter to certify anything.
    expect(agentSubmitCertification(null).submitSignal).toBe('none')
  })

  it('holds `unknown` as gemini ceiling no matter how much evidence arrives', () => {
    const verdict = judge({
      agent: 'gemini',
      observed: [
        submitSignal(ARMED_AT + 5, { hookEventName: 'BeforeAgent' }),
        { kind: 'native-state-transition', at: ARMED_AT + 6 },
        { kind: 'content-change', at: ARMED_AT + 7 }
      ]
    })

    expect(verdict.submitted).toBe('unknown')
    expect(verdict.evidence).toBe('uncertified-submit-signal')
  })
})

describe('tier 1 — certified submit signal', () => {
  it('returns yes for a post-arm signal while automation held the pane exclusively', () => {
    const verdict = judge({ observed: [submitSignal(ARMED_AT + 12)] })

    expect(verdict).toMatchObject({
      submitted: 'yes',
      evidence: 'certified-submit-signal',
      attributedAt: ARMED_AT + 12,
      retry: 'forbidden',
      escalate: false
    })
  })

  it('ignores a signal from before the arm — that hook belongs to the previous turn', () => {
    const verdict = judge({ observed: [submitSignal(ARMED_AT - 1)] })

    expect(verdict.submitted).toBe('no')
    expect(verdict.evidence).toBe('none')
  })

  it('attributes a signal stamped in the arm millisecond rather than risking a retry', () => {
    expect(judge({ observed: [submitSignal(ARMED_AT)] }).submitted).toBe('yes')
  })

  it('requires the per-turn key where the key is the certification', () => {
    const keyed = judge({
      agent: 'opencode',
      observed: [submitSignal(ARMED_AT + 3, { perTurnKey: 'opencode-message-42' })]
    })
    const keyless = judge({ agent: 'opencode', observed: [submitSignal(ARMED_AT + 3)] })
    const blank = judge({
      agent: 'opencode',
      observed: [submitSignal(ARMED_AT + 3, { perTurnKey: '  ' })]
    })

    expect(keyed.submitted).toBe('yes')
    expect(keyless).toMatchObject({ submitted: 'unknown', evidence: 'uncertified-submit-signal' })
    expect(blank.submitted).toBe('unknown')
  })

  it('reads the per-turn key as a discriminator, not a presence flag', () => {
    const observed = [submitSignal(ARMED_AT + 3, { perTurnKey: 'opencode-message-41' })]
    // opencode has no submit event, so the certified arrival is a *message* event: the
    // agent's reply to the previous turn carries the previous turn's key.
    const replay = judge({ agent: 'opencode', priorPerTurnKey: 'opencode-message-41', observed })
    const fresh = judge({
      agent: 'opencode',
      priorPerTurnKey: 'opencode-message-41',
      observed: [submitSignal(ARMED_AT + 3, { perTurnKey: 'opencode-message-42' })]
    })

    expect(replay).toMatchObject({ submitted: 'unknown', evidence: 'uncertified-submit-signal' })
    expect(fresh.submitted).toBe('yes')
  })

  it('reads a second signal in the window as a nested child, never a second submission', () => {
    const child = submitSignal(ARMED_AT + 40, { launchToken: 'token-1' })
    const verdict = judge({
      paneLaunchToken: 'token-1',
      observed: [submitSignal(ARMED_AT + 10, { launchToken: 'token-1' }), child]
    })

    expect(verdict).toMatchObject({
      submitted: 'yes',
      // The lead's, not the child's: a same-type child inherits launchToken and posts to the
      // same endpoint, so only "first after arm" can attribute (§5.2a).
      attributedAt: ARMED_AT + 10,
      trailingSignals: 1
    })
  })

  it('rejects a hook carrying another pane launch token, and accepts one carrying none', () => {
    const stale = judge({
      paneLaunchToken: 'token-1',
      observed: [submitSignal(ARMED_AT + 5, { launchToken: 'token-2' })]
    })
    const tokenless = judge({
      paneLaunchToken: 'token-1',
      observed: [submitSignal(ARMED_AT + 5)]
    })

    expect(stale.submitted).toBe('no')
    expect(stale.trailingSignals).toBe(0)
    // A relayed or older hook script omits the token; absence is not a stale pane.
    expect(tokenless.submitted).toBe('yes')
  })
})

describe('tier 2 — native state transition', () => {
  it('returns yes only where the table certifies the transition', () => {
    const observed: ObservedSubmitEvidence[] = [
      { kind: 'native-state-transition', at: ARMED_AT + 20 }
    ]

    expect(judge({ agent: 'claude', observed })).toMatchObject({
      submitted: 'yes',
      evidence: 'native-state-transition',
      attributedAt: ARMED_AT + 20
    })
    expect(judge({ agent: 'codex', observed }).submitted).toBe('yes')
    for (const agent of ['cursor', 'droid', 'grok', 'opencode', 'gemini'] as const) {
      expect(judge({ agent, observed })).toMatchObject({
        submitted: 'unknown',
        evidence: 'native-state-transition',
        escalate: true
      })
    }
  })

  it('ignores a transition that landed after a human took the pane back', () => {
    const verdict = judge({
      leaseRevocation: preemption('submitted', ARMED_AT + 10),
      observed: [{ kind: 'native-state-transition', at: ARMED_AT + 30 }]
    })

    expect(verdict).toMatchObject({ submitted: 'unknown', evidence: 'lease-revoked-after-enter' })
  })
})

describe('tier 3 — content change', () => {
  it('never returns yes, even for an agent certified at every other tier', () => {
    const verdict = judge({
      agent: 'claude',
      observed: [{ kind: 'content-change', at: ARMED_AT + 8 }]
    })

    expect(verdict).toMatchObject({
      submitted: 'unknown',
      evidence: 'content-change',
      retry: 'forbidden',
      escalate: true
    })
  })
})

describe('dropped hooks and preemption', () => {
  it('answers unknown, never no, when Orca dropped a hook after the arm', () => {
    const verdict = judge({ suppressedHook: { lastSuppressedAt: ARMED_AT + 4, count: 1 } })

    // Identical inputs without the ledger entry are a clean 'no' — the whole reason the
    // ledger exists (§5.2a: the HTTP handler drops and answers 204 regardless).
    expect(judge({}).submitted).toBe('no')
    expect(verdict).toMatchObject({
      submitted: 'unknown',
      evidence: 'suppressed-hook',
      retry: 'forbidden',
      escalate: true
    })
  })

  it('lets a drop recorded before the arm stand out of the way', () => {
    const verdict = judge({ suppressedHook: { lastSuppressedAt: ARMED_AT - 1, count: 3 } })

    expect(verdict.submitted).toBe('no')
  })

  it('answers unknown, never no, when the lease was revoked after Enter', () => {
    const verdict = judge({ leaseRevocation: preemption('submitted', ARMED_AT + 15) })

    expect(verdict).toMatchObject({
      submitted: 'unknown',
      evidence: 'lease-revoked-after-enter',
      retry: 'forbidden',
      escalate: true
    })
  })

  it('still certifies a signal that arrived before the revocation', () => {
    const verdict = judge({
      leaseRevocation: preemption('submitted', ARMED_AT + 15),
      observed: [submitSignal(ARMED_AT + 14)]
    })

    expect(verdict).toMatchObject({ submitted: 'yes', evidence: 'certified-submit-signal' })
  })

  it('refuses to attribute a signal that arrived once the human owned the keyboard', () => {
    const verdict = judge({
      leaseRevocation: preemption('submitted', ARMED_AT + 15),
      observed: [submitSignal(ARMED_AT + 16)]
    })

    // It could be the human's own submit; exclusivity is the only attribution Orca has.
    expect(verdict).toMatchObject({ submitted: 'unknown', evidence: 'lease-revoked-after-enter' })
  })

  it('reports §5.4 pre-Enter preemption as no, carrying the report own retry verdict', () => {
    const clean = judge({ leaseRevocation: preemption('acquired', ARMED_AT + 2) })
    const contaminated = judge({ leaseRevocation: preemption('pasted', ARMED_AT + 2) })

    expect(clean).toMatchObject({
      submitted: 'no',
      evidence: 'preempted-before-enter',
      retry: 'allowed'
    })
    // A contaminated draft would double-paste, so 'no' is not automatically retryable.
    expect(contaminated).toMatchObject({ submitted: 'no', retry: 'forbidden' })
  })
})

describe('the settle budget', () => {
  it('says no only after the budget elapsed under an unbroken exclusive hold', () => {
    expect(judge({}, SETTLED_AT)).toMatchObject({
      submitted: 'no',
      evidence: 'none',
      retry: 'allowed',
      escalate: false
    })
  })

  it('keeps watching rather than minting a premature no', () => {
    const verdict = judge({}, SETTLED_AT - 1)

    expect(verdict).toMatchObject({
      submitted: 'unknown',
      evidence: 'settle-pending',
      retry: 'forbidden'
    })
  })

  it('stamps the verdict from the injected clock', () => {
    expect(judge({}, 9_999).decidedAt).toBe(9_999)
  })

  // The only verdict that licenses a resend is silence, and silence is evidence only if a
  // certifying channel had time to answer. A caller-chosen budget below the floor would
  // otherwise mint `no` + retry one poll after Enter — a duplicate into a live agent.
  it('floors a caller-chosen budget too short for any channel to answer', () => {
    const impatient = { settleBudgetMs: 1 }

    expect(judge(impatient, ARMED_AT + 5)).toMatchObject({
      submitted: 'unknown',
      evidence: 'settle-pending',
      retry: 'forbidden'
    })
    expect(judge(impatient, ARMED_AT + MIN_SUBMIT_SETTLE_BUDGET_MS)).toMatchObject({
      submitted: 'no',
      retry: 'allowed'
    })
  })

  it('resolves the budget it will actually judge against', () => {
    expect(resolveSettleBudgetMs(1)).toBe(MIN_SUBMIT_SETTLE_BUDGET_MS)
    expect(resolveSettleBudgetMs(undefined)).toBe(DEFAULT_SUBMIT_SETTLE_BUDGET_MS)
    expect(resolveSettleBudgetMs(30_000)).toBe(30_000)
  })
})

describe('the ladder reports the best evidence in the budget, never the first', () => {
  // Evidence does not arrive in strength order. Enter's own repaint is tier 3 and lands in
  // a millisecond; the certifying hook needs a render turn. A ladder that answers on the
  // first tier to produce anything therefore never reaches tier 1 in the real wiring.
  it('keeps watching while only tier-3 evidence has landed', () => {
    const verdict = judge(
      { observed: [{ kind: 'content-change', at: ARMED_AT + 5 }] },
      ARMED_AT + 6
    )

    expect(verdict).toMatchObject({
      submitted: 'unknown',
      evidence: 'settle-pending',
      retry: 'forbidden'
    })
  })

  it('keeps watching while only an uncertified tier-2 transition has landed', () => {
    const verdict = judge(
      { agent: 'cursor', observed: [{ kind: 'native-state-transition', at: ARMED_AT + 9 }] },
      ARMED_AT + 10
    )

    expect(verdict.evidence).toBe('settle-pending')
  })

  it('keeps watching while only an uncertified submit signal has landed', () => {
    const verdict = judge(
      { agent: 'opencode', observed: [submitSignal(ARMED_AT + 4)] },
      ARMED_AT + 5
    )

    expect(verdict.evidence).toBe('settle-pending')
  })

  it('returns the certified yes when tiers 3 and 2 arrive first and tier 1 arrives later', () => {
    const verdict = pollUntilDecided({ agent: 'cursor' }, [
      { kind: 'content-change', at: ARMED_AT + 5 },
      { kind: 'native-state-transition', at: ARMED_AT + 9 },
      submitSignal(ARMED_AT + 150)
    ])

    expect(verdict).toMatchObject({
      submitted: 'yes',
      evidence: 'certified-submit-signal',
      attributedAt: ARMED_AT + 150
    })
  })

  it('returns the certified tier-2 yes when a repaint beat the transition to the pane', () => {
    // claude's title state is real and non-circular, so tier 2 may certify — and a repaint
    // that lands 115 ms earlier still must not answer for it.
    const verdict = pollUntilDecided({ agent: 'claude' }, [
      { kind: 'content-change', at: ARMED_AT + 5 },
      { kind: 'native-state-transition', at: ARMED_AT + 120 }
    ])

    expect(verdict).toMatchObject({
      submitted: 'yes',
      evidence: 'native-state-transition',
      attributedAt: ARMED_AT + 120
    })
  })

  it('still reports the strongest weak tier once the budget elapses', () => {
    const weak: ObservedSubmitEvidence[] = [
      { kind: 'content-change', at: ARMED_AT + 5 },
      { kind: 'native-state-transition', at: ARMED_AT + 9 }
    ]

    expect(pollUntilDecided({ agent: 'cursor' }, weak)).toMatchObject({
      submitted: 'unknown',
      evidence: 'native-state-transition',
      escalate: true
    })
    expect(
      pollUntilDecided({ agent: 'cursor' }, [{ kind: 'content-change', at: ARMED_AT + 5 }]).evidence
    ).toBe('content-change')
    expect(
      pollUntilDecided({ agent: 'opencode' }, [submitSignal(ARMED_AT + 5), ...weak]).evidence
    ).toBe('uncertified-submit-signal')
  })

  it('ends the wait early only for proof or a condition more watching cannot change', () => {
    const inBudget = ARMED_AT + 2

    expect(judge({ observed: [submitSignal(ARMED_AT + 1)] }, inBudget).submitted).toBe('yes')
    // A drop means the pane is in the ingest path's closed set, which is cleared only at
    // server stop (§5.2a) — no later hook for this pane can arrive.
    expect(judge({ suppressedHook: { lastSuppressedAt: ARMED_AT + 1 } }, inBudget)).toMatchObject({
      submitted: 'unknown',
      evidence: 'suppressed-hook'
    })
    // Attribution stops at the revocation, so nothing later could be this operation's.
    expect(
      judge({ leaseRevocation: preemption('submitted', ARMED_AT + 1) }, inBudget)
    ).toMatchObject({ submitted: 'unknown', evidence: 'lease-revoked-after-enter' })
    expect(
      judge({ leaseRevocation: preemption('acquired', ARMED_AT + 1) }, inBudget)
    ).toMatchObject({ submitted: 'no', evidence: 'preempted-before-enter' })
  })
})

describe('unknown is structurally distinguishable from no', () => {
  it('narrows to the no arm through retry alone, so unknown cannot reach a retry path', () => {
    const verdicts = [
      judge({}),
      judge({ observed: [submitSignal(ARMED_AT + 1)] }),
      judge({ suppressedHook: { lastSuppressedAt: ARMED_AT + 1 } }),
      judge({ leaseRevocation: preemption('submitted', ARMED_AT + 1) }),
      judge({ leaseRevocation: preemption('pasted', ARMED_AT + 1) })
    ]

    for (const verdict of verdicts) {
      if (verdict.retry === 'allowed') {
        // Compile-time proof: only the 'no' arm carries retry:'allowed'.
        const submitted: 'no' = verdict.submitted
        expect(submitted).toBe('no')
      }
      expect(submitEvidenceAllowsRetry(verdict)).toBe(
        verdict.submitted === 'no' && verdict.retry === 'allowed'
      )
      expect(verdict.escalate).toBe(verdict.submitted === 'unknown')
      if (verdict.submitted === 'unknown') {
        expect(submitEvidenceAllowsRetry(verdict)).toBe(false)
      }
    }
  })
})
