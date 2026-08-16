// Why: locks the evidence contract the §5.2a submit verifier reads — a certified arrival must be
// recorded as it lands (never re-derived from a poll), and a cumulative drop ledger must not read
// as a fresh drop on a reused pane.
import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-identity'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import { agentSubmitCertification } from '../runtime/agent-submit-evidence'
import { AgentHookServer } from './server'
import type { SuppressedClosedPaneHookRecord } from './closed-pane-hook-suppression'
import {
  AgentSubmitHookObserver,
  agentTypeCertifiesSubmit,
  type AgentHookEvidenceSource,
  type ObservedAgentHookEvent
} from './agent-submit-hook-observer'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const OTHER_PANE = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')

type HookEventOverrides = {
  paneKey?: string
  agentType?: AgentType
  hookEventName?: string
  hasExplicitPrompt?: boolean
  promptInteractionKey?: string
  launchToken?: string
  state?: AgentStatusState
  isReplay?: boolean
  providerSessionOnly?: boolean
}

function hookEvent(overrides: HookEventOverrides = {}): ObservedAgentHookEvent {
  const { agentType = 'claude', state = 'working', ...rest } = overrides
  return {
    paneKey: PANE,
    connectionId: null,
    receivedAt: 0,
    stateStartedAt: 0,
    ...rest,
    payload: { state, prompt: 'do the thing', agentType }
  }
}

class FakeEvidenceSource implements AgentHookEvidenceSource {
  readonly listeners = new Set<(payload: ObservedAgentHookEvent) => void>()
  readonly suppression = new Map<string, SuppressedClosedPaneHookRecord>()
  unsubscribeCount = 0

  subscribeEnrichedStatus(listener: (payload: ObservedAgentHookEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.unsubscribeCount++
      this.listeners.delete(listener)
    }
  }

  getSuppressedHookRecord(paneKey: string): SuppressedClosedPaneHookRecord | undefined {
    return this.suppression.get(paneKey)
  }

  emit(overrides?: HookEventOverrides): void {
    for (const listener of this.listeners) {
      listener(hookEvent(overrides))
    }
  }
}

/** The opencode family's shape: no submit event, a per-message key that repeats across the
 *  parts of one user message. */
function messagePart(key: string, overrides: HookEventOverrides = {}): HookEventOverrides {
  return {
    agentType: 'opencode',
    hookEventName: 'MessagePart',
    promptInteractionKey: key,
    hasExplicitPrompt: true,
    ...overrides
  }
}

function startedObserver(options?: { maxPanes?: number; maxArrivalsPerPane?: number }): {
  source: FakeEvidenceSource
  observer: AgentSubmitHookObserver
  tick: (ms?: number) => void
} {
  const source = new FakeEvidenceSource()
  let clock = 1_000
  const observer = new AgentSubmitHookObserver(source, { now: () => clock, ...options })
  observer.start()
  return { source, observer, tick: (ms = 1) => void (clock += ms) }
}

describe('AgentSubmitHookObserver arrivals', () => {
  it('certifies a post-cursor claude UserPromptSubmit and ignores the pre-cursor one', () => {
    const { source, observer, tick } = startedObserver()
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    tick()
    const cursor = observer.mark(PANE)
    tick()
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })

    const window = observer.since(cursor)
    expect(window.certified).toHaveLength(1)
    expect(window.certified[0]).toMatchObject({
      paneKey: PANE,
      tier: 'certified',
      agentType: 'claude',
      hookEventName: 'UserPromptSubmit',
      hasExplicitPrompt: true
    })
    expect(window.observed).toEqual([])
    expect(window.dropped).toBe(false)
    expect(window.truncated).toBe(false)
  })

  it('keeps a second in-window arrival separate rather than merging it — a child turn is not a second submit', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })

    const { certified } = observer.since(cursor)
    expect(certified).toHaveLength(2)
    expect(certified[0]!.sequence).toBeLessThan(certified[1]!.sequence)
  })

  it('answers a bare instant origin when the caller has no cursor', () => {
    const { source, observer, tick } = startedObserver()
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    tick(5)
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })

    expect(observer.since({ paneKey: PANE, instant: 1_005 }).certified).toHaveLength(1)
  })

  it('scopes evidence to the queried pane', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit({ paneKey: OTHER_PANE, hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })

    expect(observer.since(cursor).certified).toEqual([])
  })

  it('demotes a prompt-less claude UserPromptSubmit to observed instead of certifying it', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit({ hookEventName: 'UserPromptSubmit' })

    const window = observer.since(cursor)
    expect(window.certified).toEqual([])
    expect(window.observed).toHaveLength(1)
    expect(window.observed[0]!.tier).toBe('observed')
  })

  it("records gemini's prompt-less BeforeAgent as observed only (§5.2a: unknown, never yes)", () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit({ agentType: 'gemini', hookEventName: 'BeforeAgent' })

    const window = observer.since(cursor)
    expect(window.certified).toEqual([])
    expect(window.observed).toHaveLength(1)
    expect(agentTypeCertifiesSubmit('gemini')).toBe(false)
    expect(agentTypeCertifiesSubmit('claude')).toBe(true)
    expect(agentTypeCertifiesSubmit(undefined)).toBe(false)
  })

  it('matches an event name across casing and separators', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit({ agentType: 'grok', hookEventName: 'user_prompt_submit' })
    source.emit({ agentType: 'cursor', hookEventName: 'beforeSubmitPrompt' })

    expect(observer.since(cursor).certified).toHaveLength(2)
  })

  it('certifies a new opencode promptInteractionKey but not a redelivery of the same key', () => {
    const { source, observer } = startedObserver()
    const first = observer.mark(PANE)
    source.emit(messagePart('opencode-message-1'))
    const second = observer.mark(PANE)
    source.emit(messagePart('opencode-message-1'))

    expect(observer.since(first).certified).toHaveLength(1)
    expect(observer.since(second).certified).toEqual([])
    expect(observer.since(second).observed).toHaveLength(1)
  })

  it('reads certification from the verdict module rather than a second copy of §5.2a', () => {
    // Why a Record: a new AgentHookSource fails to compile here until its row is cross-checked,
    // which is the guard the duplicated table could not have.
    const hookSources: Record<AgentHookSource, true> = {
      claude: true,
      codex: true,
      cursor: true,
      droid: true,
      grok: true,
      opencode: true,
      'mimo-code': true,
      'command-code': true,
      gemini: true,
      hermes: true,
      pi: true,
      omp: true,
      kimi: true,
      copilot: true,
      devin: true,
      amp: true,
      antigravity: true
    }
    for (const source of Object.keys(hookSources) as AgentHookSource[]) {
      const certification = agentSubmitCertification(source)
      expect([source, agentTypeCertifiesSubmit(source)]).toEqual([
        source,
        certification.submitSignal === 'certified' || certification.perTurnKey !== 'none'
      ])
    }
  })

  it('follows the verdict module on mimo-code and command-code, the rows the copies split on', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit(messagePart('mimo-code-message-1', { agentType: 'mimo-code' }))
    source.emit(messagePart('command-code-1', { agentType: 'command-code', paneKey: OTHER_PANE }))

    // Why not `yes`: §5.2a's table measures a per-turn key for opencode only, so these two
    // carry a key that certifies nothing — and the observer no longer holds its own opinion.
    expect(agentSubmitCertification('mimo-code').perTurnKey).toBe('none')
    expect(observer.since(cursor)).toMatchObject({
      certified: [],
      observed: [{ tier: 'observed' }]
    })
    expect(observer.since({ ...cursor, paneKey: OTHER_PANE }).certified).toEqual([])
  })

  it('refuses a redelivered per-turn key after forgetPane dropped the pane baseline', () => {
    const { source, observer } = startedObserver()
    source.emit(messagePart('opencode-message-1'))
    // Why this order: the docstring invites the verifier to release a pane after each
    // operation, and the next operation's cursor must not inherit an empty key history.
    observer.forgetPane(PANE)
    const cursor = observer.mark(PANE)
    source.emit(messagePart('opencode-message-1'))

    const window = observer.since(cursor)
    expect(window.certified).toEqual([])
    expect(window.observed).toHaveLength(1)
  })

  it('refuses a redelivered per-turn key when eviction drops the pane after the mark', () => {
    const { source, observer } = startedObserver({ maxPanes: 1 })
    source.emit(messagePart('opencode-message-1'))
    const cursor = observer.mark(PANE)
    source.emit(messagePart('opencode-message-2', { paneKey: OTHER_PANE }))
    source.emit(messagePart('opencode-message-1'))

    const window = observer.since(cursor)
    expect(window.certified).toEqual([])
    expect(window.truncated).toBe(true)
  })

  it('refuses a redelivered per-turn key after a key-less arrival re-tracked the forgotten pane', () => {
    const { source, observer } = startedObserver()
    source.emit(messagePart('opencode-message-1'))
    observer.forgetPane(PANE)
    // Why key-less: an opencode hook that carries prompt text but no key re-tracks the pane with
    // no baseline of its own, and the next discard must not overwrite the one the ledger holds.
    source.emit({ agentType: 'opencode', hookEventName: 'SessionStart', hasExplicitPrompt: true })
    observer.forgetPane(PANE)
    const cursor = observer.mark(PANE)
    source.emit(messagePart('opencode-message-1'))

    expect(cursor.lastPromptInteractionKey).toBe('opencode-message-1')
    expect(observer.since(cursor).certified).toEqual([])
    expect(observer.since(cursor).observed).toHaveLength(1)
  })

  it('carries the evicted pane baseline through a key-less re-track and a later discard', () => {
    const { source, observer } = startedObserver({ maxPanes: 2 })
    source.emit(messagePart('opencode-message-1'))
    for (const paneKey of ['pane-a', 'pane-b']) {
      source.emit(messagePart(`key-${paneKey}`, { paneKey }))
    }
    // Why no forgetPane for the first discard: the LRU reaches this on its own, and production
    // wires no forgetPane caller at all.
    source.emit({ agentType: 'opencode', hookEventName: 'SessionStart', hasExplicitPrompt: true })
    observer.forgetPane(PANE)
    const cursor = observer.mark(PANE)
    source.emit(messagePart('opencode-message-1'))

    expect(cursor.lastPromptInteractionKey).toBe('opencode-message-1')
    expect(observer.since(cursor).certified).toEqual([])
  })

  it('refuses every unbaselined per-turn key once the ledger sheds a record that named one', () => {
    const { source, observer } = startedObserver({ maxPanes: 1 })
    source.emit(messagePart('opencode-message-1'))
    // Why two panes: the first evicts PANE, the second sheds the ledger record holding its key —
    // and a baseline that vanishes silently is a redelivery certified as a fresh submit.
    for (const paneKey of ['pane-a', 'pane-b']) {
      source.emit(messagePart(`key-${paneKey}`, { paneKey }))
    }
    const blind = observer.mark(PANE)
    source.emit(messagePart('opencode-message-1'))

    expect(blind.lastPromptInteractionKey).toBeUndefined()
    expect(blind.perTurnKeyHistoryLost).toBe(true)
    const window = observer.since(blind)
    expect(window.certified).toEqual([])
    // Why not a plain empty window: refusing to certify is a window this observer could not read,
    // and an unqualified empty is what the caller turns into `submitted: 'no'`.
    expect(window.truncated).toBe(true)
  })

  it('keeps a pane first seen after the shed certifiable — it cannot be the shed pane', () => {
    const { source, observer } = startedObserver({ maxPanes: 1 })
    source.emit(messagePart('opencode-message-1'))
    for (const paneKey of ['pane-a', 'pane-b']) {
      source.emit(messagePart(`key-${paneKey}`, { paneKey }))
    }

    // A pane whose very first arrival lands after the shed cannot be a redelivery of it, so
    // blinding it would refuse a real first submit forever.
    const fresh = 'tab-fresh:leaf-fresh'
    source.emit(messagePart('opencode-fresh-1', { paneKey: fresh }))
    const cursor = observer.mark(fresh)
    source.emit(messagePart('opencode-fresh-2', { paneKey: fresh }))

    expect(cursor.perTurnKeyHistoryLost).toBeUndefined()
    const window = observer.since(cursor)
    expect(window.certified).toHaveLength(1)
    expect(window.truncated).toBe(false)
  })

  it('keeps the per-turn baseline across stop()/start() instead of blinding every pane', () => {
    const { source, observer } = startedObserver()
    source.emit(messagePart('opencode-message-1'))
    observer.stop()
    observer.start()
    const cursor = observer.mark(PANE)
    source.emit(messagePart('opencode-message-1'))

    // Why: the baseline is what refuses the redelivery, and the restart must not pay for it by
    // blinding panes whose history nothing ever discarded.
    expect(cursor.lastPromptInteractionKey).toBe('opencode-message-1')
    expect(cursor.perTurnKeyHistoryLost).toBeUndefined()
    expect(observer.since(cursor).certified).toEqual([])

    const other = observer.mark(OTHER_PANE)
    source.emit(messagePart('opencode-message-2', { paneKey: OTHER_PANE }))

    expect(other.perTurnKeyHistoryLost).toBeUndefined()
    expect(observer.since(other).certified).toHaveLength(1)
  })

  it('ignores a relay cache replay and a provider-session-only refresh', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true, isReplay: true })
    source.emit({
      hookEventName: 'UserPromptSubmit',
      hasExplicitPrompt: true,
      providerSessionOnly: true
    })

    expect(observer.since(cursor)).toMatchObject({ certified: [], observed: [] })
  })

  it('excludes an arrival stamped by another PTY incarnation', () => {
    const { source, observer } = startedObserver()
    const cursor = { ...observer.mark(PANE), launchToken: 'launch-live' }
    source.emit({
      hookEventName: 'UserPromptSubmit',
      hasExplicitPrompt: true,
      launchToken: 'launch-stale'
    })
    source.emit({
      hookEventName: 'UserPromptSubmit',
      hasExplicitPrompt: true,
      launchToken: 'launch-live'
    })

    const window = observer.since(cursor)
    expect(window.certified).toHaveLength(1)
    expect(window.certified[0]!.launchToken).toBe('launch-live')
    expect(window.staleLaunchTokenCount).toBe(1)
  })
})

describe('AgentSubmitHookObserver drop ledger', () => {
  it('does not read a stale cumulative record as a fresh drop on a reused pane', () => {
    const { source, observer, tick } = startedObserver()
    // Why: the ledger survives pane reuse — a drop from the pane's previous life must stay in the past.
    source.suppression.set(PANE, { count: 3, lastSuppressedAt: 500, lastIngest: 'http' })
    tick()
    const cursor = observer.mark(PANE)

    const window = observer.since(cursor)
    expect(window.dropped).toBe(false)
    expect(window.drop).toMatchObject({ count: 3 })
  })

  it('reports a drop recorded after the cursor', () => {
    const { source, observer, tick } = startedObserver()
    source.suppression.set(PANE, { count: 3, lastSuppressedAt: 500, lastIngest: 'http' })
    const cursor = observer.mark(PANE)
    tick()
    source.suppression.set(PANE, {
      count: 4,
      lastSuppressedAt: 1_001,
      lastIngest: 'http',
      lastHookEventName: 'UserPromptSubmit'
    })

    const window = observer.since(cursor)
    expect(window.dropped).toBe(true)
    expect(window.drop).toMatchObject({ count: 4, lastHookEventName: 'UserPromptSubmit' })
    expect(window.certified).toEqual([])
  })

  it('catches a drop the timestamp alone would miss, via the count baseline', () => {
    const { source, observer } = startedObserver()
    source.suppression.set(PANE, { count: 1, lastSuppressedAt: 500, lastIngest: 'http' })
    const cursor = observer.mark(PANE)
    // Why: a coarse or rewound clock can leave lastSuppressedAt behind the cursor; the count cannot lie.
    source.suppression.set(PANE, { count: 2, lastSuppressedAt: 500, lastIngest: 'http' })

    expect(observer.since(cursor).dropped).toBe(true)
  })

  it('treats an evicted-then-re-recorded ledger entry as a drop', () => {
    const { source, observer } = startedObserver()
    source.suppression.set(PANE, { count: 5, lastSuppressedAt: 500, lastIngest: 'http' })
    const cursor = observer.mark(PANE)
    source.suppression.set(PANE, { count: 1, lastSuppressedAt: 500, lastIngest: 'relay' })

    expect(observer.since(cursor).dropped).toBe(true)
  })

  it('reports no drop when the ledger has never seen the pane', () => {
    const { observer } = startedObserver()

    const window = observer.since(observer.mark(PANE))
    expect(window.dropped).toBe(false)
    expect(window.drop).toBeUndefined()
  })

  it('measures a marked cursor against the ledger’s own stamps, not the injected clock', () => {
    const { source, observer } = startedObserver()
    // Why: ClosedPaneHookSuppressionLog stamps with Date.now(), and a test (or any caller with
    // an injected clock) is on a different scale entirely — comparing the two is a coin flip.
    source.suppression.set(PANE, { count: 2, lastSuppressedAt: Date.now(), lastIngest: 'http' })
    const cursor = observer.mark(PANE)

    expect(cursor.suppressedAt).toBeGreaterThan(1_000)
    expect(observer.since(cursor).dropped).toBe(false)
  })

  it('still reports a drop the count cannot see when the ledger re-recorded at the same count', () => {
    const { source, observer } = startedObserver()
    source.suppression.set(PANE, { count: 1, lastSuppressedAt: 400, lastIngest: 'http' })
    const cursor = observer.mark(PANE)
    // Why: eviction restarts the count at 1, so only the ledger's own timestamp separates this
    // fresh drop from the baseline.
    source.suppression.set(PANE, { count: 1, lastSuppressedAt: 401, lastIngest: 'relay' })

    expect(observer.since(cursor).dropped).toBe(true)
  })
})

describe('AgentSubmitHookObserver bounds and lifecycle', () => {
  it('bounds arrivals per pane and admits the loss instead of reporting an empty window', () => {
    const { source, observer } = startedObserver({ maxArrivalsPerPane: 2 })
    const cursor = observer.mark(PANE)
    for (let i = 0; i < 4; i++) {
      source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    }

    const window = observer.since(cursor)
    expect(window.certified).toHaveLength(2)
    expect(window.truncated).toBe(true)
    // Why: a cursor taken after the shed lost nothing, so it must not inherit the warning.
    expect(observer.since(observer.mark(PANE)).truncated).toBe(false)
  })

  it('bounds tracked panes and marks a cursor whose pane was evicted as truncated', () => {
    const { source, observer } = startedObserver({ maxPanes: 2 })
    const cursor = observer.mark(PANE)
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    for (const paneKey of ['pane-a', 'pane-b']) {
      source.emit({ paneKey, hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    }

    expect(observer.trackedPaneCount).toBe(2)
    const window = observer.since(cursor)
    expect(window.certified).toEqual([])
    expect(window.truncated).toBe(true)
  })

  it('keeps reporting an eviction whose own record the discard ledger has since shed', () => {
    const { source, observer } = startedObserver({ maxPanes: 1 })
    const cursor = observer.mark(PANE)
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    // Why two more panes: the first evicts PANE, the second sheds the record naming PANE — and
    // a warning that its own LRU can drop is a false `no` waiting for enough churn.
    for (const paneKey of ['pane-a', 'pane-b']) {
      source.emit({ paneKey, hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    }

    const window = observer.since(cursor)
    expect(window.certified).toEqual([])
    expect(window.truncated).toBe(true)
  })

  it('keeps the eviction warning after the pane is tracked again', () => {
    const { source, observer } = startedObserver({ maxPanes: 2 })
    const cursor = observer.mark(PANE)
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    for (const paneKey of [OTHER_PANE, 'pane-c']) {
      source.emit({ paneKey, hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    }
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })

    // Why: the pane is live again, but this cursor still spans the gap the eviction left.
    expect(observer.since(cursor).truncated).toBe(true)
    expect(observer.since(observer.mark(PANE)).truncated).toBe(false)
  })

  it('does not track a pane whose hooks carry no submit evidence', () => {
    const { source, observer } = startedObserver()
    source.emit({ hookEventName: 'PreToolUse' })
    source.emit({ hookEventName: 'Stop', state: 'done' })

    expect(observer.trackedPaneCount).toBe(0)
  })

  it('unsubscribes exactly once on stop and stops recording', () => {
    const { source, observer } = startedObserver()
    observer.start()
    const cursor = observer.mark(PANE)
    observer.stop()
    observer.stop()
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })

    expect(source.listeners.size).toBe(0)
    expect(source.unsubscribeCount).toBe(1)
    expect(observer.since(cursor).certified).toEqual([])
  })

  it('marks a cursor that spans a stop/restart as truncated, never as silence', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    observer.stop()
    observer.start()
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })

    // Why: nothing was recorded while unsubscribed, so an empty window here is not a 'no'.
    expect(observer.since(cursor).truncated).toBe(true)
    expect(observer.since(observer.mark(PANE)).truncated).toBe(false)
  })

  it('forgets a pane on request and reports the release as a loss, not as silence', () => {
    const { source, observer } = startedObserver()
    const cursor = observer.mark(PANE)
    source.emit({ hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    observer.forgetPane(PANE)

    expect(observer.trackedPaneCount).toBe(0)
    const window = observer.since(cursor)
    expect(window.certified).toEqual([])
    // Why: this cursor's evidence was thrown away, and an unqualified empty window is read as
    // `submitted: 'no'` — a licence to press Enter a second time.
    expect(window.truncated).toBe(true)
  })

  it('reports a window read while nothing is subscribed as blind, never as silence', () => {
    const source = new FakeEvidenceSource()
    const observer = new AgentSubmitHookObserver(source, { now: () => 1_000 })

    // Never started: no listener, so no arrival could ever have been recorded.
    expect(observer.since(observer.mark(PANE))).toMatchObject({
      certified: [],
      dropped: false,
      truncated: true
    })

    observer.start()
    observer.stop()
    // A cursor taken entirely after the cut spans nothing — but nothing is watching either.
    expect(observer.since(observer.mark(PANE)).truncated).toBe(true)

    observer.start()
    expect(observer.since(observer.mark(PANE)).truncated).toBe(false)
  })
})

describe('AgentSubmitHookObserver against the real hook server', () => {
  it('keeps a submit that the last-status snapshot has already collapsed', () => {
    const server = new AgentHookServer()
    // Why: compile-time proof the observer composes with the real server tap.
    const observer = new AgentSubmitHookObserver(server satisfies AgentHookEvidenceSource)
    observer.start()
    try {
      const cursor = observer.mark(PANE)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          hookEventName: 'UserPromptSubmit',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'do the thing', agentType: 'claude' }
        },
        'conn-1'
      )
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          hookEventName: 'Stop',
          payload: { state: 'done', prompt: 'do the thing', agentType: 'claude' }
        },
        'conn-1'
      )

      // The poll-shaped view has already lost the submit…
      expect(server.getStatusSnapshot()).toMatchObject([{ state: 'done' }])
      // …while the observer still holds it, because it recorded the transition as it arrived.
      const window = observer.since(cursor)
      expect(window.certified).toHaveLength(1)
      expect(window.certified[0]).toMatchObject({
        hookEventName: 'UserPromptSubmit',
        agentType: 'claude',
        state: 'working'
      })
      expect(window.dropped).toBe(false)
    } finally {
      observer.stop()
      server.stop()
    }
  })

  it('reports a suppressed closed-pane hook as a drop, not as silence', () => {
    const server = new AgentHookServer()
    const observer = new AgentSubmitHookObserver(server)
    observer.start()
    try {
      const cursor = observer.mark(PANE)
      server.dropStatusEntriesByTabPrefix('tab-1')
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          hookEventName: 'UserPromptSubmit',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'do the thing', agentType: 'claude' }
        },
        'conn-1'
      )

      const window = observer.since(cursor)
      expect(window.certified).toEqual([])
      expect(window.dropped).toBe(true)
      expect(window.drop).toMatchObject({ count: 1, lastHookEventName: 'UserPromptSubmit' })
    } finally {
      observer.stop()
      server.stop()
    }
  })
})
