import { describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  normalizeHookPayload,
  type HookListenerState
} from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '33333333-3333-4333-8333-333333333333'

function claudeEvent(
  state: HookListenerState,
  paneKey: string,
  payload: Record<string, unknown>
): ReturnType<typeof normalizeHookPayload> {
  return normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')
}

// Why: a lead Stop already ends the turn, but a still-working subagent keeps the pane `working`.
// That erases the working->done edge that mints the completion banner. The listener stamps
// `turnCompletedAt` on the gated working row and repeats it on the turn's later all-clear `done`
// so a consumer can announce the turn now and pair (not double-fire) the drain.
describe('Claude lead turn completes while background inventory keeps the pane working', () => {
  it('stamps turnCompletedAt on the gated working Stop and repeats it on the drain all-clear', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('turn-stamp-working', LEAF_ID)

    claudeEvent(state, paneKey, { hook_event_name: 'UserPromptSubmit', prompt: 'do it' })
    claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStart',
      agent_id: 'achild0000000010',
      agent_type: 'reviewer'
    })

    // The lead finished, but the working subagent gates the pane at 'working'.
    const leadStop = claudeEvent(state, paneKey, { hook_event_name: 'Stop' })
    expect(leadStop?.payload.state).toBe('working')
    const stamp = leadStop?.payload.turnCompletedAt
    expect(typeof stamp).toBe('number')
    expect(Number.isFinite(stamp)).toBe(true)
    // The pinned lead state carries the per-turn identity for the eventual all-clear.
    expect(state.claudeLeadStateByPaneKey.get(paneKey)?.turnCompletedAt).toBe(stamp)

    // Draining the last child yields the all-clear `done`; it must repeat the same end time.
    const allClear = claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStop',
      agent_id: 'achild0000000010'
    })
    expect(allClear?.payload.state).toBe('done')
    expect(allClear?.payload.turnCompletedAt).toBe(stamp)
  })

  it('does NOT stamp a genuine lead completion with no background work (guard)', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('turn-stamp-none', LEAF_ID)

    claudeEvent(state, paneKey, { hook_event_name: 'UserPromptSubmit', prompt: 'do it' })
    const leadStop = claudeEvent(state, paneKey, { hook_event_name: 'Stop' })

    // A plain lead Stop with an empty roster genuinely completes; there is no gated working row to stamp.
    expect(leadStop?.payload.state).toBe('done')
    expect(leadStop?.payload.turnCompletedAt).toBeUndefined()
    expect(state.claudeLeadStateByPaneKey.get(paneKey)?.turnCompletedAt).toBeUndefined()
  })

  it('does NOT stamp an interrupted Stop even while a subagent runs (guard)', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('turn-stamp-interrupt', LEAF_ID)

    claudeEvent(state, paneKey, { hook_event_name: 'UserPromptSubmit', prompt: 'do it' })
    claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStart',
      agent_id: 'achild0000000011',
      agent_type: 'reviewer'
    })

    // Still gated 'working' by the child, but Ctrl+C is not a turn the banner should announce.
    const interruptedStop = claudeEvent(state, paneKey, {
      hook_event_name: 'Stop',
      is_interrupt: true
    })
    expect(interruptedStop?.payload.turnCompletedAt).toBeUndefined()
    expect(state.claudeLeadStateByPaneKey.get(paneKey)?.turnCompletedAt).toBeUndefined()
  })
})
