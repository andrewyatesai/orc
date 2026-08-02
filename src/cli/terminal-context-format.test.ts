// The human-readable face of the honesty contract: a refusal must read as a
// refusal, and a real read must show the tool output the pane collapsed.
import { describe, expect, it } from 'vitest'
import type { TerminalAgentTranscript } from '../shared/agent-transcript-protocol'
import { formatTerminalAgentTranscript } from './terminal-context-format'

function transcript(over: Partial<TerminalAgentTranscript> = {}): TerminalAgentTranscript {
  return {
    schema: 1,
    handle: 'term-1',
    available: true,
    detail: null,
    agent: 'claude',
    sessionId: 'sess-1',
    host: { kind: 'local' },
    path: '/p/sess-1.jsonl',
    turns: [],
    hasMoreBefore: false,
    previousOffset: null,
    limited: false,
    blindSpots: [
      { capability: 'agent-screen-state', reason: 'transcript-lags-pty', detail: 'not a screen' }
    ],
    ...over
  }
}

describe('formatTerminalAgentTranscript', () => {
  it('names the cause, the agent and the host when it could not look', () => {
    const text = formatTerminalAgentTranscript(
      transcript({
        available: false,
        unavailable: 'remote-host',
        detail: 'This pane runs over SSH connection conn-7.',
        host: { kind: 'ssh', connectionId: 'conn-7' },
        path: '/home/u/.claude/projects/p/sess-1.jsonl'
      })
    )
    expect(text).toContain('Agent transcript unavailable: remote-host')
    expect(text).toContain('ssh conn-7')
    expect(text).toContain('reported path: /home/u/.claude/projects/p/sess-1.jsonl')
  })

  it('distinguishes an empty-but-read transcript from a refusal', () => {
    const text = formatTerminalAgentTranscript(transcript())
    expect(text).toContain('This transcript exists and records no turns yet.')
    expect(text).not.toContain('unavailable')
  })

  it('renders the collapsed tool output and the paging hint', () => {
    const text = formatTerminalAgentTranscript(
      transcript({
        turns: [
          {
            id: 'm-1',
            role: 'tool',
            timestamp: 1,
            blocks: [
              { kind: 'tool-result', output: 'line 1\nline 2', isError: false, truncated: false }
            ]
          }
        ],
        hasMoreBefore: true,
        previousOffset: 4096,
        limited: true
      })
    )
    expect(text).toContain('tool: [tool-result]\nline 1\nline 2')
    expect(text).toContain('older: --before 4096')
    expect(text).toContain('limited: bodies trimmed to the character budget')
    expect(text).toContain('not visible here: agent-screen-state (transcript-lags-pty)')
  })

  it('sanitizes untrusted agent text before printing it', () => {
    const text = formatTerminalAgentTranscript(
      transcript({
        turns: [
          {
            id: 'm-1',
            role: 'assistant',
            timestamp: null,
            blocks: [{ kind: 'text', text: 'safe]0;pwned', truncated: false }]
          }
        ]
      })
    )
    expect(text).not.toContain('')
  })
})
