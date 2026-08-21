import { describe, expect, it } from 'vitest'
import { agentEntryCompletionAt, type AgentCompletionSource } from './agent-completion-time'

function source(overrides: Partial<AgentCompletionSource> = {}): AgentCompletionSource {
  return { state: 'done', stateStartedAt: 2_000, ...overrides }
}

describe('agentEntryCompletionAt', () => {
  it('times a non-interrupted done from its stateStartedAt', () => {
    expect(agentEntryCompletionAt(source({ stateStartedAt: 2_000 }))).toBe(2_000)
  })

  it('returns null for an interrupted done', () => {
    expect(agentEntryCompletionAt(source({ interrupted: true }))).toBeNull()
  })

  it('returns null for any non-done state', () => {
    expect(agentEntryCompletionAt(source({ state: 'working' }))).toBeNull()
    expect(agentEntryCompletionAt(source({ state: 'blocked' }))).toBeNull()
  })

  it('treats a non-finite stateStartedAt as no completion', () => {
    expect(agentEntryCompletionAt(source({ stateStartedAt: Number.NaN }))).toBeNull()
    expect(agentEntryCompletionAt(source({ stateStartedAt: Number.POSITIVE_INFINITY }))).toBeNull()
  })
})
