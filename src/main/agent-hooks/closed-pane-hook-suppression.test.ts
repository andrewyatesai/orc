// Why: locks the observability contract for closed-pane drops — a suppressed hook must stay
// suppressed and still answer 204, but must no longer vanish without a trace.
import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'
import {
  ClosedPaneHookSuppressionLog,
  SUPPRESSED_CLOSED_PANE_HOOKS_MAX
} from './closed-pane-hook-suppression'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const LIVE_PANE = makePaneKey('tab-live', '22222222-2222-4222-8222-222222222222')
const RELAY_PANE = makePaneKey('tab-relay', '33333333-3333-4333-8333-333333333333')

describe('ClosedPaneHookSuppressionLog', () => {
  it('counts repeats per pane and keeps the newest context', () => {
    const log = new ClosedPaneHookSuppressionLog()
    log.record(PANE, { ingest: 'http', source: 'claude', hookEventName: 'Stop' }, 1_000)
    log.record(PANE, { ingest: 'relay', hookEventName: '  UserPromptSubmit  ' }, 2_000)

    expect(log.get(PANE)).toEqual({
      count: 2,
      lastSuppressedAt: 2_000,
      lastIngest: 'relay',
      lastHookEventName: 'UserPromptSubmit'
    })
  })

  it('hands back a copy so a poller cannot mutate the ledger', () => {
    const log = new ClosedPaneHookSuppressionLog()
    log.record(PANE, { ingest: 'terminal' }, 1_000)
    const record = log.get(PANE)!
    record.count = 99

    expect(log.get(PANE)?.count).toBe(1)
  })

  it('bounds itself at the closed-set maximum, evicting the least recently suppressed pane', () => {
    const log = new ClosedPaneHookSuppressionLog()
    for (let i = 0; i <= SUPPRESSED_CLOSED_PANE_HOOKS_MAX; i++) {
      log.record(`pane-${i}`, { ingest: 'http' }, 1_000 + i)
    }

    expect(log.snapshot()).toHaveLength(SUPPRESSED_CLOSED_PANE_HOOKS_MAX)
    expect(log.get('pane-0')).toBeUndefined()
    expect(log.get(`pane-${SUPPRESSED_CLOSED_PANE_HOOKS_MAX}`)).toMatchObject({ count: 1 })
  })

  it('refreshes eviction recency on a repeat so a hot pane is not shed first', () => {
    const log = new ClosedPaneHookSuppressionLog()
    for (let i = 0; i < SUPPRESSED_CLOSED_PANE_HOOKS_MAX; i++) {
      log.record(`pane-${i}`, { ingest: 'http' }, 1_000 + i)
    }
    log.record('pane-0', { ingest: 'http' }, 9_000)
    log.record('overflow', { ingest: 'http' }, 9_001)

    expect(log.get('pane-0')).toMatchObject({ count: 2 })
    expect(log.get('pane-1')).toBeUndefined()
  })
})

describe('AgentHookServer closed-pane hook suppression', () => {
  it('still drops a closed pane HTTP hook and still answers 204, but records the drop', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (paneKey: string, prompt: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify({
            paneKey,
            tabId: paneKey.split(':', 1)[0],
            worktreeId: 'wt-1',
            env: 'production',
            payload: { hook_event_name: 'UserPromptSubmit', prompt }
          })
        })

      await expect(postHook(PANE, 'before close')).resolves.toMatchObject({ status: 204 })
      expect(server.getSuppressedHookRecord(PANE)).toBeUndefined()

      server.dropStatusEntriesByTabPrefix('tab-1')
      await expect(postHook(PANE, 'after close')).resolves.toMatchObject({ status: 204 })

      expect(server.getStatusSnapshot()).toEqual([])
      expect(server.getSuppressedHookRecord(PANE)).toMatchObject({
        count: 1,
        lastIngest: 'http',
        lastSource: 'claude',
        lastHookEventName: 'UserPromptSubmit'
      })
      expect(server.getSuppressedHookRecord(PANE)?.lastSuppressedAt).toBeGreaterThan(0)

      // Why: a live pane's hook must not land in the ledger, else "dropped" loses all meaning.
      await expect(postHook(LIVE_PANE, 'live')).resolves.toMatchObject({ status: 204 })
      expect(server.getSuppressedHookRecord(LIVE_PANE)).toBeUndefined()
      expect(server.getSuppressedHookSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, count: 1 })
      ])
    } finally {
      server.stop()
    }
  })

  it('records a relay drop with its ingest path', () => {
    const server = new AgentHookServer()
    server.dropStatusEntriesByTabPrefix('tab-relay')

    server.ingestRemote(
      {
        paneKey: RELAY_PANE,
        tabId: 'tab-relay',
        worktreeId: 'wt-1',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'late relay', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getSuppressedHookRecord(RELAY_PANE)).toMatchObject({
      count: 1,
      lastIngest: 'relay',
      lastHookEventName: 'UserPromptSubmit'
    })
  })

  it('does not record a terminal OSC status drop — it is not a hook arrival', () => {
    const server = new AgentHookServer()
    server.dropStatusEntriesByTabPrefix('tab-1')

    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'late terminal' }
    })

    // Still suppressed from status…
    expect(server.getStatusSnapshot()).toEqual([])
    // …but absent from the ledger, so a repainting TUI cannot bury the hook it shadows.
    expect(server.getSuppressedHookRecord(PANE)).toBeUndefined()
  })

  it('clears the ledger on stop, matching the closed-set lifecycle', async () => {
    const server = new AgentHookServer()
    try {
      await server.start({ env: 'production' })
      server.dropStatusEntriesByTabPrefix('tab-relay')
      server.ingestRemote(
        {
          paneKey: RELAY_PANE,
          tabId: 'tab-relay',
          worktreeId: 'wt-1',
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'late', agentType: 'claude' }
        },
        'conn-1'
      )
      expect(server.getSuppressedHookSnapshot()).toHaveLength(1)
    } finally {
      server.stop()
    }

    expect(server.getSuppressedHookSnapshot()).toEqual([])
  })
})
