// The blind-spot contract for transcript resolution: every path that cannot be
// read is refused BY NAME, and the refusal still carries whatever identity Orca
// managed to resolve.
import { describe, expect, it } from 'vitest'
import {
  resolveAgentTranscriptSource,
  selectAgentTranscriptSessionRow,
  type AgentTranscriptPaneFacts
} from './agent-transcript-source'

function facts(over: Partial<AgentTranscriptPaneFacts> = {}): AgentTranscriptPaneFacts {
  return {
    hookRows: [
      {
        agentType: 'claude',
        providerSession: {
          id: 'sess-1',
          transcriptPath: '/home/u/.claude/projects/p/sess-1.jsonl'
        },
        receivedAt: 100
      }
    ],
    paneAgent: 'claude',
    host: { kind: 'local' },
    canBridgeWslPaths: false,
    ...over
  }
}

describe('selectAgentTranscriptSessionRow', () => {
  it('takes the newest row carrying a session, ignoring session-less rows', () => {
    const row = selectAgentTranscriptSessionRow([
      { agentType: 'claude', providerSession: { id: 'old' }, receivedAt: 1 },
      { agentType: 'claude', receivedAt: 9_999 },
      { agentType: 'claude', providerSession: { id: 'new' }, receivedAt: 5 }
    ])
    expect(row?.providerSession?.id).toBe('new')
  })

  it('is not bounded by staleness — an idle agent still has a transcript', () => {
    const row = selectAgentTranscriptSessionRow([
      { agentType: 'claude', providerSession: { id: 'ancient' }, receivedAt: 0 }
    ])
    expect(row?.providerSession?.id).toBe('ancient')
  })
})

describe('resolveAgentTranscriptSource', () => {
  it('resolves a local claude pane to a readable source with the hook path as a hint', () => {
    const source = resolveAgentTranscriptSource(facts())
    expect(source).toMatchObject({
      readable: true,
      agent: 'claude',
      sessionId: 'sess-1',
      filePath: null,
      transcriptPathHint: '/home/u/.claude/projects/p/sess-1.jsonl'
    })
  })

  it('reads openclaude with the claude decoder while keeping its own name', () => {
    const source = resolveAgentTranscriptSource(
      facts({
        hookRows: [{ agentType: 'openclaude', providerSession: { id: 'sess-2' }, receivedAt: 1 }],
        paneAgent: 'openclaude'
      })
    )
    expect(source).toMatchObject({ readable: true, agent: 'claude', agentName: 'openclaude' })
  })

  it('refuses an SSH pane by name and says where the file actually is', () => {
    const source = resolveAgentTranscriptSource(
      facts({ host: { kind: 'ssh', connectionId: 'conn-7' } })
    )
    expect(source).toMatchObject({ readable: false, unavailable: 'remote-host' })
    expect(source.readable).toBe(false)
    if (!source.readable) {
      expect(source.detail).toContain('conn-7')
      expect(source.detail).toContain('/home/u/.claude/projects/p/sess-1.jsonl')
      // The refusal still hands back identity, so a driver can go get it.
      expect(source.sessionId).toBe('sess-1')
      expect(source.reportedPath).toBe('/home/u/.claude/projects/p/sess-1.jsonl')
    }
  })

  it('refuses a pane with no reported session as a missing join key, not silence', () => {
    const source = resolveAgentTranscriptSource(facts({ hookRows: [], paneAgent: 'claude' }))
    expect(source).toMatchObject({ readable: false, unavailable: 'no-agent-session' })
    if (!source.readable) {
      expect(source.detail).toContain('claude')
      expect(source.detail).toContain('not an empty conversation')
    }
  })

  it('names the agent Orca cannot decode rather than returning nothing', () => {
    const source = resolveAgentTranscriptSource(
      facts({
        hookRows: [{ agentType: 'gemini', providerSession: { id: 'g-1' }, receivedAt: 1 }],
        paneAgent: 'gemini'
      })
    )
    expect(source).toMatchObject({
      readable: false,
      unavailable: 'unsupported-agent',
      agentName: 'gemini',
      sessionId: 'g-1'
    })
  })

  it('bridges a WSL pane onto the distro UNC share when the agent reported a path', () => {
    const source = resolveAgentTranscriptSource(
      facts({ host: { kind: 'wsl', distro: 'Ubuntu' }, canBridgeWslPaths: true })
    )
    expect(source).toMatchObject({
      readable: true,
      filePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude\\projects\\p\\sess-1.jsonl',
      transcriptPathHint: null
    })
  })

  it('refuses a WSL pane with no reported path instead of searching the Windows home', () => {
    const source = resolveAgentTranscriptSource(
      facts({
        host: { kind: 'wsl', distro: 'Ubuntu' },
        canBridgeWslPaths: true,
        hookRows: [{ agentType: 'claude', providerSession: { id: 'sess-1' }, receivedAt: 1 }]
      })
    )
    expect(source).toMatchObject({ readable: false, unavailable: 'remote-host' })
    if (!source.readable) {
      expect(source.detail).toContain('Ubuntu')
    }
  })

  it('refuses a WSL pane when the host cannot bridge distro paths at all', () => {
    const source = resolveAgentTranscriptSource(
      facts({ host: { kind: 'wsl', distro: 'Ubuntu' }, canBridgeWslPaths: false })
    )
    expect(source).toMatchObject({ readable: false, unavailable: 'remote-host' })
  })

  it('prefers the hook row agent over the pane launch agent when they disagree', () => {
    const source = resolveAgentTranscriptSource(
      facts({
        hookRows: [{ agentType: 'codex', providerSession: { id: 'c-1' }, receivedAt: 3 }],
        paneAgent: 'claude'
      })
    )
    expect(source).toMatchObject({ readable: true, agent: 'codex', agentName: 'codex' })
  })
})
