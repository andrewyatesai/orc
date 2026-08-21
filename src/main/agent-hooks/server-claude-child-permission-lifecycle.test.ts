import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-identity'
import { AgentHookServer, _internals } from './server'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const PANE = makePaneKey('tab-child-perm', '11111111-1111-4111-8111-111111111111')

function buildBody(payload: Record<string, unknown>): Record<string, unknown> {
  return { paneKey: PANE, tabId: 'tab-child-perm', worktreeId: 'wt-1', env: 'production', payload }
}

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude child permission lifecycle', () => {
  async function createServer(): Promise<{
    server: AgentHookServer
    postClaudeHook: (payload: Record<string, unknown>) => Promise<Response>
  }> {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    return {
      server,
      postClaudeHook: (payload) =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })
    }
  }

  // Why: a live sibling keeps the pane 'working' when the owner ends, which is the ONLY path where the
  // permission card is still cached as a PermissionRequest and the sticky gate is consulted with a
  // 'working' successor. Draining the last child instead transitions the pane out of 'working' entirely.
  it('drops a child permission when the owning child stops while a sibling keeps working', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      await postClaudeHook({ hook_event_name: 'SubagentStart', agent_id: 'a-sibling' })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'a-blocked',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })

      await postClaudeHook({ hook_event_name: 'SubagentStop', agent_id: 'a-blocked' })

      const status = server.getStatusSnapshot()[0]
      // The owning child ended, so the sticky permission card drops even though the sibling still works.
      expect(status?.state).toBe('working')
      expect(status).toMatchObject({ paneKey: PANE, agentType: 'claude' })
      expect(status?.toolName).toBeUndefined()
      expect(status?.toolInput).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('keeps a child permission sticky when a non-owning child stops', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      await postClaudeHook({ hook_event_name: 'SubagentStart', agent_id: 'a-sibling' })
      await postClaudeHook({ hook_event_name: 'SubagentStart', agent_id: 'a-keepalive' })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'a-blocked',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })

      // A different child ending is not the owner; a-keepalive keeps the pane 'working' so the gate runs.
      await postClaudeHook({ hook_event_name: 'SubagentStop', agent_id: 'a-sibling' })

      // The block belongs to a-blocked, which is still live, so the card stays.
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    } finally {
      server.stop()
    }
  })

  it('drops a teammate permission when the owning teammate idles while a sibling keeps working', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      await postClaudeHook({ hook_event_name: 'SubagentStart', agent_id: 'a-sibling' })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'areviewer-6d3cb5b5',
        agent_type: 'reviewer',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })

      // 'reviewer' name-matches the owning agent id areviewer-*, resolving the block it owns.
      await postClaudeHook({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })

      const status = server.getStatusSnapshot()[0]
      expect(status?.state).toBe('working')
      expect(status).toMatchObject({ paneKey: PANE, agentType: 'claude' })
      expect(status?.toolName).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
