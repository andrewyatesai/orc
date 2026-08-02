/**
 * Project an agent's decoded transcript records into the bounded shape
 * `terminal.agentTranscript` returns.
 *
 * Bounds are the point: these files grow without limit, and one tool result can
 * be megabytes. The reader takes a tail of `limit` records; this module then
 * spends a fixed character budget newest-first, so the turns nearest the live
 * edge keep their bodies and older ones lose theirs. Turns are never dropped —
 * dropping them would invalidate `previousOffset` and break backward paging.
 *
 * Pure module: decoded records in, wire shape out.
 */
import {
  AGENT_TRANSCRIPT_SCHEMA_VERSION,
  AGENT_TRANSCRIPT_SCREEN_STATE_BLIND_SPOT,
  type AgentTranscriptBlock,
  type AgentTranscriptHost,
  type AgentTranscriptTurn,
  type AgentTranscriptUnavailableReason,
  type TerminalAgentTranscript
} from '../../shared/agent-transcript-protocol'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'

export const TERMINAL_AGENT_TRANSCRIPT_DEFAULT_TURNS = 20
export const TERMINAL_AGENT_TRANSCRIPT_MAX_TURNS = 200
/** Whole-window budget, matching the 256 KiB ceiling `terminal.read` pages. */
export const TERMINAL_AGENT_TRANSCRIPT_MAX_CHARS = 256 * 1024
/** Per-body ceiling so one giant tool result cannot starve every other turn. */
export const TERMINAL_AGENT_TRANSCRIPT_MAX_BLOCK_CHARS = 32 * 1024

export function boundAgentTranscriptTurnCount(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return TERMINAL_AGENT_TRANSCRIPT_DEFAULT_TURNS
  }
  return Math.max(1, Math.min(Math.floor(limit), TERMINAL_AGENT_TRANSCRIPT_MAX_TURNS))
}

export type AgentTranscriptReadParts = {
  handle: string
  agent: string
  sessionId: string
  host: AgentTranscriptHost
  path: string
  /** Oldest first, as the tail reader returns them. */
  messages: readonly NativeChatMessage[]
  hasMoreBefore: boolean
  previousOffset: number | null
}

export type AgentTranscriptRefusalParts = {
  handle: string
  unavailable: AgentTranscriptUnavailableReason
  detail: string
  agent: string | null
  sessionId: string | null
  /** Null when the pane's host is unknown — nothing was read anywhere. */
  host: AgentTranscriptHost | null
  path: string | null
}

type CharBudget = { remaining: number; cut: boolean }

/** Serialize a tool call's arguments. They are already JSON-derived, so the
 *  only realistic failure is size, which the budget handles. */
function toolInputText(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}

function spend(text: string, budget: CharBudget): { text: string; truncated: boolean } {
  const cap = Math.max(0, Math.min(budget.remaining, TERMINAL_AGENT_TRANSCRIPT_MAX_BLOCK_CHARS))
  if (text.length <= cap) {
    budget.remaining -= text.length
    return { text, truncated: false }
  }
  budget.remaining -= cap
  budget.cut = true
  return { text: text.slice(0, cap), truncated: true }
}

function projectBlock(block: NativeChatBlock, budget: CharBudget): AgentTranscriptBlock {
  if (block.type === 'text') {
    const { text, truncated } = spend(block.text, budget)
    return { kind: 'text', text, truncated }
  }
  if (block.type === 'tool-call') {
    const { text, truncated } = spend(toolInputText(block.input), budget)
    return { kind: 'tool-call', name: block.name, input: text, truncated }
  }
  if (block.type === 'tool-result') {
    const { text, truncated } = spend(block.output, budget)
    return { kind: 'tool-result', output: text, isError: block.isError === true, truncated }
  }
  return { kind: 'image-ref', ref: block.path ?? block.url ?? null, alt: block.alt ?? null }
}

/** Newest-first spending, then restored to reading order. The tail is what a
 *  driver acts on, so it must be the part that keeps its bodies. */
function projectTurns(
  messages: readonly NativeChatMessage[],
  budget: CharBudget
): AgentTranscriptTurn[] {
  const newestFirst: AgentTranscriptTurn[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    newestFirst.push({
      id: message.id,
      role: message.role,
      timestamp: message.timestamp,
      blocks: message.blocks.map((block) => projectBlock(block, budget))
    })
  }
  return newestFirst.toReversed()
}

export function buildTerminalAgentTranscript(
  parts: AgentTranscriptReadParts
): TerminalAgentTranscript {
  const budget: CharBudget = { remaining: TERMINAL_AGENT_TRANSCRIPT_MAX_CHARS, cut: false }
  const turns = projectTurns(parts.messages, budget)
  return {
    schema: AGENT_TRANSCRIPT_SCHEMA_VERSION,
    handle: parts.handle,
    available: true,
    detail: null,
    agent: parts.agent,
    sessionId: parts.sessionId,
    host: parts.host,
    path: parts.path,
    turns,
    hasMoreBefore: parts.hasMoreBefore,
    previousOffset: turns.length > 0 ? parts.previousOffset : null,
    limited: budget.cut,
    blindSpots: [AGENT_TRANSCRIPT_SCREEN_STATE_BLIND_SPOT]
  }
}

/** A refusal is a first-class result, not an error: it names the cause and
 *  still reports whatever identity Orca did resolve. */
export function buildUnavailableAgentTranscript(
  parts: AgentTranscriptRefusalParts
): TerminalAgentTranscript {
  return {
    schema: AGENT_TRANSCRIPT_SCHEMA_VERSION,
    handle: parts.handle,
    available: false,
    unavailable: parts.unavailable,
    detail: parts.detail,
    agent: parts.agent,
    sessionId: parts.sessionId,
    host: parts.host,
    path: parts.path,
    turns: [],
    hasMoreBefore: false,
    previousOffset: null,
    limited: false,
    blindSpots: [AGENT_TRANSCRIPT_SCREEN_STATE_BLIND_SPOT]
  }
}
