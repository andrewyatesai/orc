/**
 * The runtime adapter for §5.2's submit primitive: the ports it hands the state
 * machine have to reach the real PTY, the real journal and the real coordinator.
 * The state machine's own phase ordering is covered by
 * agent-prompt-submission.test.ts; these pin the wiring it runs on.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  AGENT_PROMPT_SUBMIT
} from '../../shared/agent-prompt-injection'
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import type { SuppressedClosedPaneHookRecord } from '../agent-hooks/closed-pane-hook-suppression'
import type {
  AgentHookEvidenceSource,
  ObservedAgentHookEvent
} from '../agent-hooks/agent-submit-hook-observer'

const PTY_ID = 'pty-submit-1'
/** App-form SSH pty id (`ssh:<connection>@@<relay pty>`) — what `isSshOwnedPtyId` reads. */
const SSH_PTY_ID = 'ssh:host-1@@pty-9'
const HANDLE = 'h-submit-1'
const PANE_KEY = makePaneKey('tab-submit-1', '11111111-1111-4111-8111-111111111111')
const MOBILE_CLIENT = 'phone-1'
/** Small on purpose: the verify loop polls a real clock, so the whole case is
 *  the echo-settle floor plus this. */
const SETTLE_BUDGET_MS = 120

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean }
  ) => { launchAgent: string | null; paneKey?: string | null; connectionId?: string | null }
  handleByPtyId: Map<string, string>
  mobileSubscribers: Map<string, Map<string, unknown>>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

/** The hook server's evidence surface, without the loopback HTTP server. */
class FakeHookSource implements AgentHookEvidenceSource {
  private readonly listeners = new Set<(payload: ObservedAgentHookEvent) => void>()

  subscribeEnrichedStatus(listener: (payload: ObservedAgentHookEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSuppressedHookRecord(): SuppressedClosedPaneHookRecord | undefined {
    return undefined
  }

  emitSubmit(paneKey: string, agentType: AgentType = 'claude'): void {
    const state: AgentStatusState = 'working'
    for (const listener of this.listeners) {
      listener({
        paneKey,
        connectionId: null,
        receivedAt: 0,
        stateStartedAt: 0,
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        payload: { state, prompt: 'run the tests', agentType }
      })
    }
  }
}

function headlessRuntime(settings?: { agentStatusHooksEnabled: boolean }): OrcaRuntimeService {
  // Only `getSettings` is reached on the submit path (permission preset, §5.3's hook
  // gate), so a store stub that answers it is the whole dependency.
  const runtime = new OrcaRuntimeService(
    settings ? ({ getSettings: () => settings } as never) : null
  )
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  return runtime
}

function livePane(
  runtime: OrcaRuntimeService,
  agent: string | null,
  options: { paneKey?: string; ptyId?: string; connectionId?: string } = {}
): void {
  const ptyId = options.ptyId ?? PTY_ID
  const pty = internals(runtime).recordPtyWorktree(ptyId, 'wt-1', { connected: true })
  pty.launchAgent = agent
  if (options.paneKey) {
    // Hook evidence is keyed by pane; without one the submit has no hook channel.
    pty.paneKey = options.paneKey
  }
  if (options.connectionId) {
    pty.connectionId = options.connectionId
  }
  internals(runtime).handleByPtyId.set(ptyId, HANDLE)
  runtime.onPtySpawned(ptyId, undefined, { awaitsRegistration: false })
}

/** Records writes and lets a case answer the pane's echo/title on the Enter byte. */
function recordingController(
  runtime: OrcaRuntimeService,
  onSubmitKey?: () => void,
  onPasteWrite?: () => void
): { writes: string[] } {
  const writes: string[] = []
  let sequence = 1
  runtime.setPtyController({
    write: (ptyId: string, data: string) => {
      writes.push(data)
      if (data === AGENT_PROMPT_SUBMIT) {
        onSubmitKey?.()
      } else {
        // A real pane echoes the paste; the anchor must be taken after it.
        runtime.onPtyData(ptyId, data, sequence++)
        onPasteWrite?.()
      }
      return true
    }
  } as unknown as Parameters<OrcaRuntimeService['setPtyController']>[0])
  return { writes }
}

describe('OrcaRuntimeService.submitAgentPrompt', () => {
  it('writes the bracketed paste, then exactly one Enter', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, null)
    const { writes } = recordingController(runtime)

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(writes.join('')).toBe(
      `${AGENT_PROMPT_BRACKETED_PASTE_START}run the tests${AGENT_PROMPT_BRACKETED_PASTE_END}${AGENT_PROMPT_SUBMIT}`
    )
    expect(writes.filter((write) => write === AGENT_PROMPT_SUBMIT)).toHaveLength(1)
    expect(result.handle).toBe(HANDLE)
    expect(result.attempts).toBe(1)
  })

  it('certifies on a journal agent-working transition for an agent §5.2a certifies', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, 'claude')
    let sequence = 1_000
    recordingController(runtime, () => {
      runtime.onPtyData(PTY_ID, '\x1b]0;Claude working\x07', sequence++)
    })

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.submitted).toBe('yes')
    expect(result.evidence).toBe('native-state-transition')
    expect(result.draftState).toBe('clean')
  })

  it('returns unknown rather than no when a certified agent has no hook channel', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, 'claude')
    recordingController(runtime)

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.submitted).toBe('unknown')
    expect(result.evidenceChannel).toBe('lossy')
    expect(result.retry).toBe('forbidden')
    expect(result.escalate).toBe(true)
  })

  it('refuses a handle this runtime cannot write to, without touching the PTY', async () => {
    const runtime = headlessRuntime()
    const { writes } = recordingController(runtime)

    await expect(runtime.submitAgentPrompt('h-missing', 'hello')).rejects.toThrow()
    expect(writes).toEqual([])
  })

  it('certifies on a hook that reaches the wired observer after the display moved', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, 'claude', { paneKey: PANE_KEY })
    const hooks = new FakeHookSource()
    runtime.setAgentSubmitHookEvidence(hooks)
    let sequence = 2_000
    recordingController(runtime, () => {
      // Enter's own repaint lands first; the hook script needs a round trip.
      runtime.onPtyData(PTY_ID, 'spinner', sequence++)
      setTimeout(() => hooks.emitSubmit(PANE_KEY), 10)
    })

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.submitted).toBe('yes')
    expect(result.evidence).toBe('certified-submit-signal')
    expect(result.evidenceChannel).toBe('intact')
  })

  it('refuses a pane a phone is driving instead of pasting into it', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, 'claude')
    const { writes } = recordingController(runtime)
    runtime.markMobileActor(PTY_ID, MOBILE_CLIENT)

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.phase).toBe('refused')
    expect(result.refusal?.code).toBe('mobile-driver-active')
    expect(writes).toEqual([])
  })

  it('preempts the held lease when a phone claims the input floor mid-paste', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, 'claude')
    internals(runtime).mobileSubscribers.set(PTY_ID, new Map([[MOBILE_CLIENT, {}]]))
    recordingController(runtime, undefined, () => {
      const claim = runtime.beginMobileInputFloor(PTY_ID, MOBILE_CLIENT)
      // The floor is what revokes; mobileTookFloor's layout work is not under test.
      void claim?.commit().catch(() => {})
    })

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.submitted).toBe('no')
    expect(result.evidence).toBe('preempted-before-enter')
    expect(result.preemption?.cause).toBe('human-input-floor')
    expect(result.preemption?.humanSource).toBe('mobile')
  })

  it('revokes the lease when the provider generation resets under the paste', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, 'claude')
    recordingController(runtime, undefined, () => {
      // A daemon respawn behind the same ptyId: the bytes after this land in a
      // different process, so the lease must not survive it.
      runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
    })

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.submitted).toBe('no')
    expect(result.evidence).toBe('preempted-before-enter')
    expect(result.preemption?.cause).toBe('generation-change')
  })

  it('revokes the lease when an SSH relay drops the pane mid-paste', async () => {
    // §5.5 relay loss: the surface is deliberately kept addressable through the
    // reconnect grace, but the process behind it is gone and onPtyExit has already
    // moved the lifecycle generation the lease is pinned to. A lease that survives
    // that keeps typing at a pin no longer valid, and its verifier's echo anchor was
    // deleted by the same block with nothing to explain the silence.
    const runtime = headlessRuntime()
    livePane(runtime, 'claude', { ptyId: SSH_PTY_ID, connectionId: 'host-1' })
    recordingController(runtime, undefined, () => {
      runtime.onPtyExit(SSH_PTY_ID, -1)
    })

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.submitted).toBe('no')
    expect(result.evidence).toBe('preempted-before-enter')
    expect(result.preemption?.cause).toBe('pty-disposed')
  })

  it('reports unknown, not no, when the agent-status-hooks setting is off', async () => {
    // §5.3: with hooks off tier 1 does not exist. The observer stays subscribed to a
    // tap nothing posts to, so its window reads as empty rather than absent — and an
    // empty window is what would let claude's hook-only silence answer `'no'`.
    const runtime = headlessRuntime({ agentStatusHooksEnabled: false })
    livePane(runtime, 'claude', { paneKey: PANE_KEY })
    runtime.setAgentSubmitHookEvidence(new FakeHookSource())
    recordingController(runtime)

    const result = await runtime.submitAgentPrompt(HANDLE, 'run the tests', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(result.submitted).toBe('unknown')
    expect(result.evidenceChannel).toBe('lossy')
    expect(result.retry).toBe('forbidden')
    expect(result.escalate).toBe(true)
  })

  it('hands the pane back to the next automated writer when it is done', async () => {
    const runtime = headlessRuntime()
    livePane(runtime, null)
    recordingController(runtime)

    await runtime.submitAgentPrompt(HANDLE, 'run the tests', { settleBudgetMs: SETTLE_BUDGET_MS })
    const second = await runtime.submitAgentPrompt(HANDLE, 'again', {
      settleBudgetMs: SETTLE_BUDGET_MS
    })

    expect(second.phase).toBe('verify')
    expect(second.refusal).toBeUndefined()
  })
})
