// Seam test: proves the stats pipeline is fed by the REAL agent-hook server
// fan-out, exactly as main/index.ts wires it — not a hand-built recorder double.
//
// It drives a live AgentHookServer through its production ingest/clear methods
// and asserts a real StatsCollector counts the session. This is the only place
// that exercises the new `subscribeEnrichedStatus`/`subscribePaneStatusClear`
// path end to end; if that wiring regresses, these fail rather than silently
// counting nothing (the #10201 regression class).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { StatsCollector } from './collector'
import { AgentSessionTransitionRecorder } from './agent-session-transition-recorder'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

vi.mock('../telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn()
}))

const T = 1_700_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const CONN = 'ssh-conn-1'

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-stats-hook-wiring-'))
  vi.useFakeTimers({ now: T })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataDir, { recursive: true, force: true })
})

/** Wire a recorder to a live server the same way main/index.ts does. */
function wireServerToStats(): { server: AgentHookServer; stats: StatsCollector } {
  const server = new AgentHookServer()
  const stats = new StatsCollector()
  const recorder = new AgentSessionTransitionRecorder(stats)
  server.subscribeEnrichedStatus((enriched) => {
    recorder.onStatus(enriched)
  })
  server.subscribePaneStatusClear((clear) => {
    recorder.onCleared(clear)
  })
  return { server, stats }
}

function ingest(server: AgentHookServer, state: 'working' | 'done'): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state, prompt: 'do the thing', agentType: 'claude' }
    },
    CONN
  )
}

describe('stats fed by the real agent-hook server fan-out', () => {
  it('counts one session per working→done turn observed over hooks', () => {
    const { server, stats } = wireServerToStats()

    ingest(server, 'working')
    vi.setSystemTime(T + 90_000)
    ingest(server, 'done')

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(90_000)
  })

  it('closes an open session when the server clears the pane (subscribePaneStatusClear)', () => {
    const { server, stats } = wireServerToStats()

    ingest(server, 'working')
    expect(stats.getSummary().totalAgentsSpawned).toBe(1)

    vi.setSystemTime(T + 30_000)
    server.clearPaneState(PANE)

    // The teardown clear reached the recorder and closed the live session.
    expect(stats.getSummary().totalAgentTimeMs).toBe(30_000)
  })

  it('closes an open session when the pane connection drops (batch clear)', () => {
    const { server, stats } = wireServerToStats()

    ingest(server, 'working')
    vi.setSystemTime(T + 20_000)
    server.clearStatusEntriesForConnection(CONN)

    expect(stats.getSummary().totalAgentTimeMs).toBe(20_000)
  })
})
