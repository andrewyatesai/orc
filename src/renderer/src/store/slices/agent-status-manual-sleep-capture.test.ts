import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const NOW = 1_800_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  return {
    state: 'working',
    prompt: 'finish the task',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    ...overrides
  }
}

function seedTabs(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
    }
  } as Partial<AppState>)
}

function makeSleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: `sleeping-${paneKey}` },
    prompt: 'old prompt',
    state: 'working',
    capturedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
    updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
    origin: 'live',
    ...overrides
  }
}

describe('manual sleep agent session capture', () => {
  it('captures every resumable pane, normalizing interrupted and updatedAt and keeping state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:fresh': makeAgentEntry({ paneKey: 'tab-1:fresh' }),
        'tab-1:stale': makeAgentEntry({
          paneKey: 'tab-1:stale',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        }),
        'tab-1:done': makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' }),
        'tab-1:interrupted': makeAgentEntry({
          paneKey: 'tab-1:interrupted',
          state: 'done',
          interrupted: true
        }),
        'tab-1:post-input': makeAgentEntry({
          paneKey: 'tab-1:post-input',
          updatedAt: NOW - 1_000
        })
      },
      lastTerminalInputAtByPaneKey: { 'tab-1:post-input': NOW }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const records = store.getState().sleepingAgentSessionsByPaneKey
    // Why: a done, interrupted, typed-into or stale pane must keep its only --resume handle,
    // so every resumable row is captured now — not just the fresh active ones (#11598).
    expect(Object.keys(records).sort()).toEqual([
      'tab-1:done',
      'tab-1:fresh',
      'tab-1:interrupted',
      'tab-1:post-input',
      'tab-1:stale'
    ])
    // updatedAt is normalized to capture time so a slept row never trips the wake staleness discard.
    expect(records['tab-1:stale']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working',
      updatedAt: NOW
    })
    // The record carries resume identity, not the dead turn's interrupt flag.
    expect(records['tab-1:interrupted']?.interrupted).toBeUndefined()
    // A finished pane keeps its passive state and wakes lazily in place, not as a duplicate tab.
    expect(records['tab-1:interrupted']).toMatchObject({
      state: 'done',
      restoreOnTabOpenOnly: true
    })
    expect(records['tab-1:done']).toMatchObject({ state: 'done', restoreOnTabOpenOnly: true })
    expect(records['tab-1:fresh']?.restoreOnTabOpenOnly).toBeUndefined()
  })

  it('preserves retained completed sessions as intentional sleep records', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    const entry = makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' })
    const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1' })
    store.setState({
      retainedAgentsByPaneKey: {
        'tab-1:done': {
          entry,
          tab,
          worktreeId: 'wt-1',
          agentType: 'codex',
          startedAt: entry.stateStartedAt
        }
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:done']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      providerSession: { key: 'session_id', id: 'session-tab-1:done' }
    })
  })

  it('replaces a provisional live record with a fresh durable capture of its row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:stale': makeAgentEntry({
          paneKey: 'tab-1:stale',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:stale': makeSleepingRecord({ paneKey: 'tab-1:stale' })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    // Why: the stale row is re-captured (updatedAt normalized), so the provisional live checkpoint
    // is replaced by a durable worktree-sleep record rather than deleted with nothing written back.
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:stale']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working',
      updatedAt: NOW
    })
  })

  it('keeps a durable slept record a repeat sleep cannot re-derive', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    // A done pane stays passive with no live status row, so a second sleep finds nothing to rebuild
    // it from — its only --resume handle must survive the wipe anyway (#11598).
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        'tab-1:done': makeSleepingRecord({
          paneKey: 'tab-1:done',
          state: 'done',
          origin: 'worktree-sleep',
          restoreOnTabOpenOnly: true
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:done']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      restoreOnTabOpenOnly: true
    })
  })

  it('does not promote Pi identity without an authoritative transcript', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': makeSleepingRecord({
          agent: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session-1' }
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('captures every resumable pane when terminal shutdown captures sleeping records', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:fresh': makeAgentEntry({ paneKey: 'tab-1:fresh' }),
        'tab-1:done': makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' })
      }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(Object.keys(records).sort()).toEqual(['tab-1:done', 'tab-1:fresh'])
    expect(records['tab-1:fresh']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working'
    })
    // The finished pane keeps its passive record and resumes lazily when its tab is opened.
    expect(records['tab-1:done']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      restoreOnTabOpenOnly: true
    })
  })

  it('re-captures a stale row over its provisional record during terminal shutdown capture', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      ptyIdsByTabId: { 'tab-1': [] },
      agentStatusByPaneKey: {
        'tab-1:stale': makeAgentEntry({
          paneKey: 'tab-1:stale',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:stale': makeSleepingRecord({ paneKey: 'tab-1:stale' })
      }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:stale']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working',
      updatedAt: NOW
    })
  })
})
