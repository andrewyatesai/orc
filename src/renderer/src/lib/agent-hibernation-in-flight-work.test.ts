import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, DispatchStatus } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  planAgentHibernationCandidates,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'

/**
 * Why: the v1.4.165 merge dropped two eligibility gates from getEligiblePane —
 * the live-subagent check and hasUnsettledOrUnknownDispatch. Without them the
 * planner sleeps a pane whose dispatched work is still in flight, killing it
 * silently. Each case below plants one in-flight condition and asserts the
 * planner refuses to sleep the pane.
 */

const NOW = 2_000_000
const OLD = NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
const LEAF = '11111111-1111-4111-8111-111111111111'

function tab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF]: 'pty-1' }
  }
}

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'make it so',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey: `tab-1:${LEAF}`,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  } as AgentStatusEntry
}

function planFor(agentEntry: AgentStatusEntry): string[] {
  const snapshot: AgentHibernationPlannerSnapshot = {
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    },
    activeWorktreeId: 'wt-active',
    foregroundTerminalTabIds: [],
    tabsByWorktree: { 'wt-bg': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    mobileLockedPtyIds: [],
    agentStatusByPaneKey: { [agentEntry.paneKey]: agentEntry },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    now: NOW
  }
  return planAgentHibernationCandidates(snapshot).map((candidate) => candidate.paneKey)
}

const orchestration = (dispatchStatus?: DispatchStatus) => ({
  taskId: 'task-1',
  dispatchId: 'dispatch-1',
  ...(dispatchStatus ? { dispatchStatus } : {})
})

describe('hibernation never sleeps in-flight work', () => {
  it('sleeps an idle done pane with nothing in flight (the control)', () => {
    expect(planFor(entry())).toEqual([`tab-1:${LEAF}`])
  })

  it('refuses to sleep a pane with a live subagent', () => {
    const withSubagent = entry({
      subagents: [{ id: 'sub-1', state: 'working', startedAt: OLD }]
    })
    expect(planFor(withSubagent)).toEqual([])
  })

  for (const status of ['pending', 'dispatched', 'waiting_gate'] as const) {
    it(`refuses to sleep a pane whose dispatch is ${status}`, () => {
      expect(planFor(entry({ orchestration: orchestration(status) }))).toEqual([])
    })
  }

  // Why: a hook-only context carries no runtime status. Treating "unknown" as
  // settled is exactly the mistake that loses work, so it must stay ineligible.
  it('refuses to sleep a pane whose dispatch status is unknown', () => {
    expect(planFor(entry({ orchestration: orchestration() }))).toEqual([])
  })

  for (const status of ['completed', 'failed', 'circuit_broken'] as const) {
    it(`still sleeps a pane whose dispatch is ${status}`, () => {
      expect(planFor(entry({ orchestration: orchestration(status) }))).toEqual([`tab-1:${LEAF}`])
    })
  }

  // Why: waiting_gate is a fork-only state; upstream's literal list would have
  // silently treated it as settled and slept a pane blocked on a decision gate.
  it('treats the fork-only waiting_gate state as unsettled', () => {
    expect(planFor(entry({ orchestration: orchestration('waiting_gate') }))).toEqual([])
  })
})
