import { describe, expect, it } from 'vitest'

import {
  canAcceptClaudeCompactTransition,
  normalizeClaudePromptId,
  resolveCachedClaudeCompactOwnership,
  type AgentHookEventPayload
} from './agent-hook-listener'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import { normalizeAgentStatusPayload, type ParsedAgentStatusPayload } from './agent-status-types'

const SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: 'sess-abc' }
const OTHER_SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: 'sess-xyz' }
const TURN_PROMPT_ID = '11111111-1111-4111-8111-111111111111'
const COMPACT_PROMPT_ID = '22222222-2222-4222-8222-222222222222'

function payload(overrides: Partial<ParsedAgentStatusPayload> = {}): ParsedAgentStatusPayload {
  const parsed = normalizeAgentStatusPayload({
    state: 'working',
    prompt: 'ship it',
    agentType: 'claude',
    ...overrides
  })
  if (!parsed) {
    throw new Error('failed to build test payload')
  }
  return parsed
}

function claudeRow(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'tab-1:leaf',
    source: 'claude',
    connectionId: null,
    providerSession: SESSION,
    payload: payload(),
    ...overrides
  }
}

describe('normalizeClaudePromptId', () => {
  it('accepts a canonical UUID and lowercases it', () => {
    expect(normalizeClaudePromptId('11111111-1111-4111-8111-111111111111')).toBe(TURN_PROMPT_ID)
    expect(normalizeClaudePromptId('  22222222-2222-4222-8222-222222222222  ')).toBe(
      COMPACT_PROMPT_ID
    )
  })

  it('rejects non-UUID values', () => {
    expect(normalizeClaudePromptId('not-a-uuid')).toBeUndefined()
    expect(normalizeClaudePromptId(42)).toBeUndefined()
    expect(normalizeClaudePromptId(undefined)).toBeUndefined()
  })
})

describe('canAcceptClaudeCompactTransition', () => {
  const previous = claudeRow({ providerPromptId: TURN_PROMPT_ID })

  it('accepts a manual PreCompact anchored to a prior Claude turn', () => {
    expect(
      canAcceptClaudeCompactTransition(previous, {
        source: 'claude',
        connectionId: null,
        hookEventName: 'PreCompact',
        providerPromptId: COMPACT_PROMPT_ID,
        compactTrigger: 'manual',
        providerSession: SESSION
      })
    ).toBe(true)
  })

  it('rejects a compact with no prior anchored turn', () => {
    expect(
      canAcceptClaudeCompactTransition(undefined, {
        source: 'claude',
        connectionId: null,
        hookEventName: 'PreCompact',
        providerPromptId: COMPACT_PROMPT_ID,
        compactTrigger: 'manual',
        providerSession: SESSION
      })
    ).toBe(false)
  })

  it('allows an unanchored PreCompact only when the option is set (relay first hop)', () => {
    expect(
      canAcceptClaudeCompactTransition(
        undefined,
        {
          source: 'claude',
          connectionId: null,
          hookEventName: 'PreCompact',
          providerPromptId: COMPACT_PROMPT_ID,
          compactTrigger: 'manual',
          providerSession: SESSION
        },
        { allowUnanchoredPreCompact: true }
      )
    ).toBe(true)
  })

  it('rejects a compact whose session or connection differs from the current row', () => {
    expect(
      canAcceptClaudeCompactTransition(previous, {
        source: 'claude',
        connectionId: null,
        hookEventName: 'PreCompact',
        providerPromptId: COMPACT_PROMPT_ID,
        compactTrigger: 'manual',
        providerSession: OTHER_SESSION
      })
    ).toBe(false)
    expect(
      canAcceptClaudeCompactTransition(previous, {
        source: 'claude',
        connectionId: 'conn-1',
        hookEventName: 'PreCompact',
        providerPromptId: COMPACT_PROMPT_ID,
        compactTrigger: 'manual',
        providerSession: SESSION
      })
    ).toBe(false)
  })

  it('retires a manual PostCompact only when it names its own PreCompact generation', () => {
    const afterPre = claudeRow({
      hookEventName: 'PreCompact',
      compactTrigger: 'manual',
      providerPromptId: COMPACT_PROMPT_ID
    })
    expect(
      canAcceptClaudeCompactTransition(afterPre, {
        source: 'claude',
        connectionId: null,
        hookEventName: 'PostCompact',
        providerPromptId: COMPACT_PROMPT_ID,
        compactTrigger: 'manual',
        providerSession: SESSION
      })
    ).toBe(true)
    expect(
      canAcceptClaudeCompactTransition(afterPre, {
        source: 'claude',
        connectionId: null,
        hookEventName: 'PostCompact',
        providerPromptId: TURN_PROMPT_ID,
        compactTrigger: 'manual',
        providerSession: SESSION
      })
    ).toBe(false)
  })
})

describe('resolveCachedClaudeCompactOwnership', () => {
  it('keeps the started prompt label on a PreCompact working row', () => {
    const previous = claudeRow({ providerPromptId: TURN_PROMPT_ID, payload: payload() })
    const incoming = claudeRow({
      hookEventName: 'PreCompact',
      compactTrigger: 'manual',
      providerPromptId: COMPACT_PROMPT_ID,
      payload: payload({ prompt: '' })
    })
    expect(resolveCachedClaudeCompactOwnership(previous, incoming).payload.prompt).toBe('ship it')
  })

  it('clears the compact marker once PostCompact lands', () => {
    const incoming = claudeRow({
      hookEventName: 'PostCompact',
      compactTrigger: 'manual',
      providerPromptId: COMPACT_PROMPT_ID,
      payload: payload({ state: 'done' })
    })
    expect(resolveCachedClaudeCompactOwnership(undefined, incoming).compactTrigger).toBeUndefined()
  })

  it('lets a mid-compact tool event inherit the live generation while its prompt matches', () => {
    const previous = claudeRow({
      hookEventName: 'PreCompact',
      compactTrigger: 'manual',
      providerPromptId: COMPACT_PROMPT_ID
    })
    const incoming = claudeRow({
      hookEventName: 'PostToolUse',
      providerPromptId: COMPACT_PROMPT_ID
    })
    expect(resolveCachedClaudeCompactOwnership(previous, incoming).compactTrigger).toBe('manual')
  })
})
