/**
 * §5.2's submit primitive, driven against the real input coordinator, the real
 * hook observer and the real event journal — only the PTY and the clock are
 * fakes. The fakes stop at the bytes because the phase ordering is the thing
 * under test, and a mocked lease would test nothing.
 */
import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AGENT_PROMPT_SUBMIT } from '../../shared/agent-prompt-injection'
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import type { SuppressedClosedPaneHookRecord } from '../agent-hooks/closed-pane-hook-suppression'
import {
  AgentSubmitHookObserver,
  type AgentHookEvidenceSource,
  type ObservedAgentHookEvent
} from '../agent-hooks/agent-submit-hook-observer'
import {
  submitAgentPrompt,
  type AgentPromptSubmissionPorts,
  type AgentPromptSubmissionRequest,
  type AgentPromptSubmissionTarget
} from './agent-prompt-submission'
import type { AgentPromptSubmissionResult } from './agent-prompt-submission-result'
import type { AgentStateTransitionWatch, SubmitClock } from './agent-prompt-submit-verification'
import { createTerminalInputCoordinator } from './terminal-input-coordinator'
import type { ConnectionPin } from './terminal-input-lease-preemption'

type TuiAgent = NonNullable<AgentPromptSubmissionTarget['agent']>

const PTY_ID = 'pty-1'
const HANDLE = 'term_1'
const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const PIN: ConnectionPin = { ptyIncarnationId: 'inc-1', connectionGeneration: 1 }
const SETTLE_BUDGET_MS = 400

type FakeClock = SubmitClock & {
  at: () => number
  advance: (ms: number) => void
  /** Evidence that lands *later*, which is the whole difficulty: Enter's repaint is
   *  immediate and the certifying hook needs a render turn. A fixture that delivers
   *  everything inside `pressSubmitKey` cannot express that ordering at all. */
  after: (delayMs: number, run: () => void) => void
}

function fakeClock(): FakeClock {
  let now = 1_000
  const scheduled: { at: number; run: () => void }[] = []
  const advance = (ms: number): void => {
    now += ms
    for (;;) {
      const due = scheduled
        .filter((entry) => entry.at <= now)
        .sort((left, right) => left.at - right.at)[0]
      if (!due) {
        return
      }
      scheduled.splice(scheduled.indexOf(due), 1)
      due.run()
    }
  }
  return {
    now: () => now,
    // Advancing inside sleep keeps every loop deterministic and timer-free.
    sleep: async (ms: number) => {
      advance(ms)
    },
    at: () => now,
    advance,
    after: (delayMs: number, run: () => void) => {
      scheduled.push({ at: now + delayMs, run })
    }
  }
}

class FakeHookSource implements AgentHookEvidenceSource {
  readonly listeners = new Set<(payload: ObservedAgentHookEvent) => void>()
  readonly suppression = new Map<string, SuppressedClosedPaneHookRecord>()

  subscribeEnrichedStatus(listener: (payload: ObservedAgentHookEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSuppressedHookRecord(paneKey: string): SuppressedClosedPaneHookRecord | undefined {
    return this.suppression.get(paneKey)
  }

  emitSubmit(overrides: { agentType?: AgentType; state?: AgentStatusState } = {}): void {
    const { agentType = 'claude', state = 'working' } = overrides
    for (const listener of this.listeners) {
      listener({
        paneKey: PANE,
        connectionId: null,
        receivedAt: 0,
        stateStartedAt: 0,
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        payload: { state, prompt: 'do the thing', agentType }
      })
    }
  }
}

type Harness = {
  clock: FakeClock
  hooks: FakeHookSource
  observer: AgentSubmitHookObserver
  writes: string[]
  /** Bytes the pane has echoed; the anchor probe reads this counter. */
  outputBytes: number
  transitions: number[]
  journalLost: boolean
  submitAccepted: boolean
  onPasteChunk?: () => void
  /** The last synchronous step before `armSubmit()` — §5.4's tightest race. */
  onArmWatches?: () => void
  onSubmitKey?: () => void
  run: (overrides?: Partial<AgentPromptSubmissionRequest>) => Promise<AgentPromptSubmissionResult>
  coordinator: ReturnType<typeof createTerminalInputCoordinator>
}

function harness(
  options: {
    agent?: TuiAgent | null
    paneKey?: string | null
    withHooks?: boolean
    launchToken?: string
    allowsSubmitRepress?: boolean
    humanDriver?: boolean
    checkGrant?: () => { allowed: boolean; reason: string }
  } = {}
): Harness {
  const clock = fakeClock()
  const hooks = new FakeHookSource()
  const observer = new AgentSubmitHookObserver(hooks, { now: clock.now })
  observer.start()
  const coordinator = createTerminalInputCoordinator({ now: clock.now })
  coordinator.notePtyPin(PTY_ID, PIN)

  const state: Harness = {
    clock,
    hooks,
    observer,
    coordinator,
    writes: [],
    outputBytes: 0,
    transitions: [],
    journalLost: false,
    submitAccepted: true,
    run: async () => {
      throw new Error('unreachable')
    }
  }

  const ports: AgentPromptSubmissionPorts = {
    acquireLease: (request) => coordinator.acquire(request),
    // Two chunks, because §5.4's re-check seam is *between* them and a one-shot
    // fake never exercises it.
    pastePrompt: async (_ptyId, prompt, beforeChunk) => {
      const split = Math.ceil(prompt.length / 2)
      for (const chunk of [prompt.slice(0, split), prompt.slice(split)]) {
        await beforeChunk()
        state.writes.push(chunk)
        // Real panes echo what was pasted; that echo is what a pre-paste anchor
        // would mistake for proof.
        state.outputBytes += chunk.length
        state.onPasteChunk?.()
      }
    },
    pressSubmitKey: () => {
      state.onSubmitKey?.()
      if (!state.submitAccepted) {
        return false
      }
      state.writes.push(AGENT_PROMPT_SUBMIT)
      return true
    },
    sampleOutputBytes: () => state.outputBytes,
    ...(options.humanDriver ? { humanDriverHoldsPane: () => true } : {}),
    armAgentStateWatch: (): AgentStateTransitionWatch => {
      state.onArmWatches?.()
      return {
        transitionsSinceArm: () => ({ at: state.transitions, lost: state.journalLost })
      }
    },
    armHookWindow: (paneKey, launchToken) => {
      if (options.withHooks === false) {
        return null
      }
      const cursor = { ...observer.mark(paneKey), ...(launchToken ? { launchToken } : {}) }
      return { read: () => observer.since(cursor) }
    },
    clock,
    ...(options.allowsSubmitRepress ? { allowsSubmitRepress: () => true } : {}),
    ...(options.checkGrant ? { checkGrant: options.checkGrant } : {})
  }

  const target: AgentPromptSubmissionTarget = {
    handle: HANDLE,
    ptyId: PTY_ID,
    paneKey: options.paneKey === undefined ? PANE : options.paneKey,
    pin: PIN,
    agent: options.agent === undefined ? 'claude' : options.agent,
    ...(options.launchToken ? { launchToken: options.launchToken } : {})
  }

  state.run = (overrides = {}) =>
    submitAgentPrompt(
      {
        target,
        prompt: 'run the tests',
        writer: 'manager',
        permissionPreset: 'default',
        settleBudgetMs: SETTLE_BUDGET_MS,
        ...overrides
      },
      ports
    )
  return state
}

describe('submitAgentPrompt — the happy path', () => {
  it('pastes, then presses Enter exactly once, and certifies on the post-arm hook', async () => {
    const test = harness()
    test.onSubmitKey = () => test.hooks.emitSubmit()

    const result = await test.run()

    expect(result.submitted).toBe('yes')
    expect(result.evidence).toBe('certified-submit-signal')
    expect(result.phase).toBe('verify')
    expect(result.attempts).toBe(1)
    expect(result.draftState).toBe('clean')
    expect(result.retry).toBe('forbidden')
    expect(result.escalate).toBe(false)
    expect(result.evidenceChannel).toBe('intact')
    expect(test.writes.filter((write) => write === AGENT_PROMPT_SUBMIT)).toHaveLength(1)
  })

  it('releases the pane, so the next automated writer is not locked out', async () => {
    const test = harness()
    test.onSubmitKey = () => test.hooks.emitSubmit()
    await test.run()
    expect(test.coordinator.inspect(PTY_ID).holder).toBeNull()
  })

  it('certifies on a hook that lands a render turn after Enter’s own repaint', async () => {
    // The production ordering, and the one every synchronous fixture hides: the
    // display moves within a frame of Enter while the hook needs a script round
    // trip. Answering on the first tier to produce anything reports
    // content-change -> unknown -> escalate, which is terminal for automation.
    const test = harness({ agent: 'claude' })
    test.onSubmitKey = () => {
      test.clock.after(20, () => {
        test.outputBytes += 32
      })
      test.clock.after(100, () => test.hooks.emitSubmit())
    }

    const result = await test.run()

    expect(result.submitted).toBe('yes')
    expect(result.evidence).toBe('certified-submit-signal')
    expect(result.escalate).toBe(false)
  })

  it('reports a nested child agent’s later hook as trailing, never a second submit', async () => {
    const test = harness()
    test.onSubmitKey = () => {
      test.hooks.emitSubmit()
      test.hooks.emitSubmit()
    }
    const result = await test.run()
    expect(result.submitted).toBe('yes')
    expect(result.trailingSignals).toBe(1)
  })
})

describe('submitAgentPrompt — echo-settle before the anchor (§5.2 step 3)', () => {
  it('returns a retryable no when the paste echoed but Enter changed nothing', async () => {
    // The load-bearing assertion: the anchor is taken AFTER the echo, so the
    // echo cannot stand in for evidence. Anchor before the paste and this same
    // case reports content-change -> 'unknown' -> escalate, and the prompt can
    // never be retried even though it demonstrably never went anywhere.
    const test = harness({ agent: null })

    const result = await test.run()

    expect(result.submitted).toBe('no')
    expect(result.evidence).toBe('none')
    expect(result.retry).toBe('allowed')
    expect(result.escalate).toBe(false)
    expect(result.draftState).toBe('contaminated')
  })

  it('reports content past the anchor as observation only, never as yes', async () => {
    const test = harness({ agent: null })
    test.onSubmitKey = () => {
      test.outputBytes += 32
    }

    const result = await test.run()

    expect(result.submitted).toBe('unknown')
    expect(result.evidence).toBe('content-change')
    expect(result.retry).toBe('forbidden')
    expect(result.escalate).toBe(true)
  })
})

describe('submitAgentPrompt — the evidence ladder', () => {
  it('accepts a native state transition only where §5.2a certifies it', async () => {
    const certified = harness({ agent: 'claude', withHooks: false })
    certified.onSubmitKey = () => certified.transitions.push(certified.clock.at())
    expect(await certified.run()).toMatchObject({
      submitted: 'yes',
      evidence: 'native-state-transition'
    })

    const uncertified = harness({ agent: 'gemini', withHooks: false })
    uncertified.onSubmitKey = () => uncertified.transitions.push(uncertified.clock.at())
    expect(await uncertified.run()).toMatchObject({
      submitted: 'unknown',
      evidence: 'native-state-transition',
      escalate: true
    })
  })

  it('reports a dropped hook as unknown, not as "nothing arrived"', async () => {
    const test = harness()
    test.onSubmitKey = () => {
      test.hooks.suppression.set(PANE, {
        count: 1,
        lastSuppressedAt: test.clock.at(),
        lastIngest: 'http'
      })
    }

    const result = await test.run()

    expect(result.submitted).toBe('unknown')
    expect(result.evidence).toBe('suppressed-hook')
    expect(result.retry).toBe('forbidden')
  })

  it('withholds no when the journal gapped and nothing else was seen', async () => {
    const test = harness({ withHooks: false, agent: 'gemini' })
    test.journalLost = true

    const result = await test.run()

    expect(result.submitted).toBe('unknown')
    expect(result.evidenceChannel).toBe('lossy')
    expect(result.retry).toBe('forbidden')
  })

  it('withholds no for a certified agent with no hook channel at all', async () => {
    const test = harness({ agent: 'claude', withHooks: false })

    const result = await test.run()

    expect(result.submitted).toBe('unknown')
    expect(result.evidenceChannel).toBe('lossy')
    expect(result.escalate).toBe(true)
  })

  it('withholds no for an agent whose only certification travels on the hook window', async () => {
    // opencode has no submit event at all: a *new* per-turn key on a hook payload
    // is the whole certification, so a missing hook window is not silence — it is
    // blindness, and answering `no` licenses a resend into a live agent.
    const test = harness({ agent: 'opencode', withHooks: false })

    const result = await test.run()

    expect(result.submitted).toBe('unknown')
    expect(result.evidenceChannel).toBe('lossy')
    expect(result.retry).toBe('forbidden')
    expect(result.escalate).toBe(true)
  })

  it('still answers no for a bare shell, where no hook was ever possible', async () => {
    const test = harness({ agent: null, withHooks: false, paneKey: null })
    expect(await test.run()).toMatchObject({
      submitted: 'no',
      evidenceChannel: 'intact',
      retry: 'allowed'
    })
  })

  it('never lets the internal keep-watching tier escape to an aborted caller', async () => {
    const test = harness({ agent: 'claude' })
    const abort = new AbortController()
    test.onSubmitKey = () => {
      test.outputBytes += 32
      abort.abort()
    }

    const result = await test.run({ signal: abort.signal })

    // 'settle-pending' means "keep watching"; printing it as the reason a submit
    // could not be proved states something about the world that it does not say.
    expect(result.evidence).toBe('content-change')
    expect(result.submitted).toBe('unknown')
    expect(result.retry).toBe('forbidden')
  })

  it('never licenses a resend to a caller that aborted after Enter landed', async () => {
    // The regression this pins: abort is not evidence of non-submission. Enter is
    // out, the certifying hook is a render turn behind it, and the caller stops
    // listening in between — on an intact channel, so nothing else withholds the
    // verdict. Answering 'no'/'allowed' here types the same instruction into an
    // agent that is already running it.
    const test = harness({ agent: 'claude' })
    const abort = new AbortController()
    test.onSubmitKey = () => {
      test.clock.after(400, () => test.hooks.emitSubmit())
      abort.abort()
    }

    const result = await test.run({ signal: abort.signal })

    expect(result.evidence).toBe('none')
    expect(result.submitted).toBe('unknown')
    expect(result.retry).toBe('forbidden')
    expect(result.escalate).toBe(true)
    expect(result.evidenceChannel).toBe('intact')
    expect(result.draftState).toBe('unknown')
  })
})

describe('submitAgentPrompt — refusals are results, not exceptions', () => {
  it('refuses an unverifiable Safe-preset worker and names the fix', async () => {
    const test = harness({ agent: 'claude' })

    const result = await test.run({ permissionPreset: 'safe' })

    expect(result.submitted).toBe('no')
    expect(result.phase).toBe('refused')
    expect(result.refusal?.code).toBe('unattended-dispatch')
    expect(result.refusal?.reason).toContain('no OS sandbox')
    expect(result.evidence).toBe('not-attempted')
    expect(test.writes).toEqual([])
  })

  it('refuses a pane the coordinator has no live pin for', async () => {
    const test = harness()
    test.coordinator.disposePty(PTY_ID)

    const result = await test.run()

    expect(result.phase).toBe('lease')
    expect(result.refusal?.code).toBe('pty-disposed')
    expect(result.retry).toBe('forbidden')
  })

  it('refuses a superseded incarnation and allows a retry against the new pin', async () => {
    const test = harness()
    const live: ConnectionPin = { ptyIncarnationId: 'inc-2', connectionGeneration: 2 }
    test.coordinator.notePtyPin(PTY_ID, live)

    const result = await test.run()

    expect(result.refusal?.code).toBe('generation-change')
    expect(result.retry).toBe('allowed')
    // The refusal's whole promise: re-resolve and go again. Reporting the pin that
    // was already dead gives the caller nothing to go again against.
    expect(result.pin).toEqual(live)
    expect(test.writes).toEqual([])
  })

  it('refuses a pane a person is driving from a phone, without writing a byte', async () => {
    const test = harness({ humanDriver: true })

    const result = await test.run()

    expect(result.phase).toBe('refused')
    expect(result.refusal?.code).toBe('mobile-driver-active')
    expect(result.submitted).toBe('no')
    // Nothing was written, so the draft is clean and a later attempt is safe.
    expect(result.retry).toBe('allowed')
    expect(result.draftState).toBe('clean')
    expect(test.writes).toEqual([])
  })

  it('never reports a submit when the terminal refused the Enter byte', async () => {
    const test = harness()
    test.submitAccepted = false

    const result = await test.run()

    expect(result.submitted).toBe('no')
    expect(result.phase).toBe('arm')
    expect(result.refusal?.code).toBe('submit-key-refused')
    // The prompt is sitting in the agent's box: resending would double-paste.
    expect(result.draftState).toBe('contaminated')
    expect(result.retry).toBe('forbidden')
  })

  it('reports a paste that the terminal rejected as contaminated, not retryable', async () => {
    const test = harness()
    test.onPasteChunk = () => {
      throw new Error('terminal_not_writable')
    }

    const result = await test.run()

    expect(result.phase).toBe('paste')
    expect(result.refusal).toMatchObject({ code: 'paste-failed', reason: 'terminal_not_writable' })
    expect(result.draftState).toBe('contaminated')
    expect(result.retry).toBe('forbidden')
  })
})

describe('submitAgentPrompt — §5.4 human preemption', () => {
  it('mid-paste: no submit, contaminated draft, no retry', async () => {
    const test = harness()
    test.onPasteChunk = () => {
      test.coordinator.claimHumanInput(PTY_ID, 'desktop')
    }

    const result = await test.run()

    expect(result.submitted).toBe('no')
    expect(result.phase).toBe('paste')
    expect(result.evidence).toBe('preempted-before-enter')
    expect(result.draftState).toBe('contaminated')
    expect(result.retry).toBe('forbidden')
    expect(result.preemption?.cause).toBe('human-input')
  })

  it('after Enter: the watcher keeps reading and the result is never "preempted"', async () => {
    const test = harness()
    test.onSubmitKey = () => {
      test.hooks.emitSubmit()
      // A hook sharing the revocation's millisecond is outside the exclusive
      // hold by construction, so the human arrives strictly afterwards.
      test.clock.advance(1)
      test.coordinator.claimHumanInput(PTY_ID, 'mobile')
    }

    const result = await test.run()

    expect(result.submitted).toBe('yes')
    expect(result.evidence).toBe('certified-submit-signal')
    expect(result.preemption?.phase).toBe('submitted')
    expect(result.preemption?.submitted).toBe('unresolved')
  })

  it('rides out a phone claim that arrives between paste chunks and later rolls back', async () => {
    const test = harness()
    let claimed = false
    test.onPasteChunk = () => {
      if (claimed) {
        return
      }
      claimed = true
      const claim = test.coordinator.beginHumanInputFloor(PTY_ID, 'mobile')
      // The phone's write is rejected, so the reservation never lands — and a claim
      // that never landed must leave a healthy operation healthy.
      void Promise.resolve().then(() => claim.rollback())
    }
    test.onSubmitKey = () => test.hooks.emitSubmit()

    const result = await test.run()

    expect(result.submitted).toBe('yes')
    expect(result.refusal).toBeUndefined()
  })

  it('rides out a phone claim that arrives in the last step before Enter', async () => {
    const test = harness()
    test.onArmWatches = () => {
      const claim = test.coordinator.beginHumanInputFloor(PTY_ID, 'mobile')
      void Promise.resolve().then(() => claim.rollback())
    }
    test.onSubmitKey = () => test.hooks.emitSubmit()

    // Without the wait this throws TerminalInputLeaseSuspendedError straight out of
    // submitAgentPrompt, losing the §5.4 report the caller is owed.
    const result = await test.run()

    expect(result.submitted).toBe('yes')
    expect(result.evidence).toBe('certified-submit-signal')
  })

  it('reports a committed phone claim before Enter as preemption, not a failed paste', async () => {
    const test = harness()
    test.onArmWatches = () => {
      const claim = test.coordinator.beginHumanInputFloor(PTY_ID, 'mobile')
      void Promise.resolve().then(() => claim.commit())
    }

    const result = await test.run()

    expect(result.submitted).toBe('no')
    expect(result.evidence).toBe('preempted-before-enter')
    expect(result.preemption?.cause).toBe('human-input-floor')
    expect(result.preemption?.humanSource).toBe('mobile')
    expect(result.draftState).toBe('contaminated')
    expect(test.writes.filter((write) => write === AGENT_PROMPT_SUBMIT)).toHaveLength(0)
  })

  it('gives up on a phone claim that is never decided, instead of holding the pane', async () => {
    // A reserved floor that neither commits nor rolls back — the phone went out of
    // range mid-write. Riding it out forever wedges this operation *and* keeps the
    // lease, so every later automated writer queues behind a submit that can never
    // finish. The claim itself still owns the pane; this operation just stops
    // waiting on it.
    const test = harness()
    test.onArmWatches = () => {
      test.coordinator.beginHumanInputFloor(PTY_ID, 'mobile')
    }

    const result = await test.run()

    expect(result.phase).toBe('arm')
    expect(result.refusal?.code).toBe('human-claim-undecided')
    expect(result.submitted).toBe('no')
    // Pasted but not submitted: §5.4's row for this phase, so no resend.
    expect(result.draftState).toBe('contaminated')
    expect(result.retry).toBe('forbidden')
    expect(test.writes.filter((write) => write === AGENT_PROMPT_SUBMIT)).toHaveLength(0)
    expect(test.coordinator.inspect(PTY_ID).holder).toBeNull()
  })

  it('lets an aborting caller out of a wait on an undecided phone claim', async () => {
    const test = harness()
    const abort = new AbortController()
    test.onPasteChunk = () => {
      test.coordinator.beginHumanInputFloor(PTY_ID, 'mobile')
      abort.abort()
    }

    const result = await test.run({ signal: abort.signal })

    expect(result.refusal?.code).toBe('cancelled')
    expect(result.phase).toBe('paste')
    expect(result.retry).toBe('forbidden')
    expect(test.coordinator.inspect(PTY_ID).holder).toBeNull()
  })

  it('after Enter with no evidence: unknown, and never a retry', async () => {
    const test = harness()
    test.onSubmitKey = () => {
      test.coordinator.claimHumanInput(PTY_ID, 'desktop')
    }

    const result = await test.run()

    expect(result.submitted).toBe('unknown')
    expect(result.evidence).toBe('lease-revoked-after-enter')
    expect(result.retry).toBe('forbidden')
    expect(result.draftState).toBe('unknown')
  })
})

describe('submitAgentPrompt — pressing Enter twice', () => {
  it('never re-presses by default, even when nothing at all happened', async () => {
    const test = harness({ agent: null })
    const result = await test.run()
    expect(result.submitted).toBe('no')
    expect(result.attempts).toBe(1)
    expect(test.writes.filter((write) => write === AGENT_PROMPT_SUBMIT)).toHaveLength(1)
  })

  it('re-presses once, and only once, when an adapter certifies it', async () => {
    const test = harness({ agent: null, allowsSubmitRepress: true })
    const result = await test.run()
    expect(result.attempts).toBe(2)
    expect(test.writes.filter((write) => write === AGENT_PROMPT_SUBMIT)).toHaveLength(2)
  })

  it('gives the second Enter its own settle window, not the first one’s leftovers', async () => {
    const test = harness({ agent: null, allowsSubmitRepress: true })
    let presses = 0
    test.onSubmitKey = () => {
      presses += 1
      if (presses === 2) {
        test.clock.after(100, () => {
          test.outputBytes += 32
        })
      }
    }

    const result = await test.run()

    // The budget is a *watching* window. Measured from the first arm it is already
    // spent by the re-press, so the second Enter would be judged on a poll that
    // could not have seen anything — and a 'no' there licenses a third send.
    expect(result.attempts).toBe(2)
    expect(result.submitted).toBe('unknown')
    expect(result.evidence).toBe('content-change')
  })
})

describe('fleet grant enforcement (§6.6)', () => {
  const denied = { allowed: false, reason: 'no fleet grant presented' }

  it('refuses an ungranted caller before a single byte is written', async () => {
    const test = harness({ checkGrant: () => denied })

    const result = await test.run()

    expect(result.phase).toBe('refused')
    expect(result.refusal?.code).toBe('grant-required')
    expect(result.submitted).toBe('no')
    // The whole point of checking before the paste: nothing reached the pane, so
    // the draft is clean and the human's terminal is untouched.
    expect(test.writes).toEqual([])
    expect(result.draftState).toBe('clean')
  })

  it('does not press Enter when the grant is revoked mid-paste', async () => {
    let allowed = true
    const test = harness({
      checkGrant: () => (allowed ? { allowed: true, reason: '' } : denied)
    })
    // Revoked after the prompt is on screen but before the arm — the window the
    // start-of-operation check alone cannot see.
    test.onPasteChunk = () => {
      allowed = false
    }

    const result = await test.run()

    expect(result.refusal?.code).toBe('grant-required')
    expect(test.writes).not.toContain(AGENT_PROMPT_SUBMIT)
    // Bytes did land, and Orca cannot un-type them.
    expect(result.draftState).toBe('contaminated')
  })

  it('lets a granted caller through unchanged', async () => {
    const test = harness({ checkGrant: () => ({ allowed: true, reason: '' }) })

    const result = await test.run()

    expect(result.refusal).toBeUndefined()
    expect(test.writes).toContain(AGENT_PROMPT_SUBMIT)
  })
})
