// ─── Explicit agent status (reported via native agent hooks → IPC) ──────────
// Why: status comes from hooks (Claude, Codex, etc.) — never inferred from terminal titles;
// a narrow interrupt fallback synthesizes a final `done` when an agent misses its cancellation hook.
//
// Shapes, caps and tables only. The five behavioural exports that lived here —
// parseAgentStatusPayload, normalizeAgentStatusPayload, agentSubagentsEqual,
// hasUnsettledOrUnknownDispatch, isFreshNonDoneAgentStatus — are cut over to the
// Rust `orca_agents::agent_status_types` core and now ship from
// `agent-status-evaluation.ts`, which reads the constants below.

import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AtermRainPulse } from './aterm-rain-signal'

export { AGENT_STATUS_MAX_FIELD_LENGTH } from './agent-status-field-normalization'

export const AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentStatusState = (typeof AGENT_STATUS_STATES)[number]
// Why: agent types aren't a fixed set (custom agents exist); any non-empty string is
// accepted — these well-known names are just a convenience union for pattern-matching.
export type WellKnownAgentType =
  | 'claude'
  | 'openclaude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'amp'
  | 'opencode'
  | 'mimo-code'
  | 'cursor'
  | 'copilot'
  | 'aider'
  | 'pi'
  | 'omp'
  | 'droid'
  | 'command-code'
  | 'grok'
  | 'hermes'
  | 'devin'
  | 'ante'
  | 'unknown'
export type AgentType = WellKnownAgentType | (string & {})

/** A snapshot of a previous agent state, used to render activity blocks.
 *  Why: intentionally narrower than AgentStatusEntry — tool/assistant context is
 *  per-turn, not meaningful on a historical snapshot, and would bloat memory. */
export type AgentStateHistoryEntry = {
  state: AgentStatusState
  prompt: string
  /** When this state was first reported. */
  startedAt: number
  /** True when this `done` was a cancellation (agent hook like Claude `is_interrupt`,
   *  or Orca's guarded fallback). Always falsy for non-`done` states so retention logic can preserve it. */
  interrupted?: boolean
}

/** Maximum number of history entries kept per agent to bound memory. */
export const AGENT_STATE_HISTORY_MAX = 20

/**
 * Dispatch lifecycle, owned here because the renderer's hibernation planner gates
 * on it. `waiting_gate` is a fork state (decision gates) with no upstream twin.
 * src/main/runtime/orchestration/types.ts re-exports this so the two cannot drift.
 */
export type DispatchStatus =
  | 'pending'
  | 'dispatched'
  | 'waiting_gate'
  | 'completed'
  | 'failed'
  | 'circuit_broken'

/** Dispatch states that mean the work is finished and the pane is safe to sleep. */
export const SETTLED_DISPATCH_STATUSES: readonly DispatchStatus[] = [
  'completed',
  'failed',
  'circuit_broken'
]

export type AgentStatusOrchestrationContext = {
  taskId: string
  dispatchId: string
  /** Runtime-authoritative lifecycle state. Hook-only contexts may omit it. */
  dispatchStatus?: DispatchStatus
  taskTitle?: string
  displayName?: string
  parentTerminalHandle?: string
  parentPaneKey?: string
  coordinatorHandle?: string
  orchestrationRunId?: string
}

export type AgentSubagentState = 'working' | 'blocked' | 'waiting' | 'idle'

/** A live in-process child of the pane's provider session. Rendered as an
 *  indented child row with no PTY of its own. */
export type AgentSubagentSnapshot = {
  /** Provider-assigned lifecycle id. */
  id: string
  agentType?: string
  /** Provider model used by this child, when exposed by its lifecycle event. */
  model?: string
  description?: string
  state: AgentSubagentState
  /** Timestamp (ms) when this subagent was first observed. */
  startedAt: number
}

export type AgentStatusEntry = {
  state: AgentStatusState
  /** The user's most recent prompt. Cached across the turn — later tool-use events
   *  omit it, so the last value persists until a new prompt or pane reset. Empty when unknown. */
  prompt: string
  /** Timestamp (ms) of the last status update. */
  updatedAt: number
  /** Timestamp (ms) when the current `state` was first reported.
   *  Why: separate from updatedAt so tool/prompt pings (which reset updatedAt) don't move it. */
  stateStartedAt: number
  agentType?: AgentType
  /** Provider model currently used by this session. */
  model?: string
  /** Composite key: `${tabId}:${leafId}` where leafId is a stable UUID layout leaf. */
  paneKey: string
  /** Runtime terminal handle for matching retained parent rows when the parent
   *  pane key cannot be re-derived after terminal teardown. */
  terminalHandle?: string
  /** Worktree attribution stamped by main when a hook resolves there.
   *  Why: orchestration workers can report before their tab exists in a renderer, so retaining this keeps them attributed instead of dropped. */
  worktreeId?: string
  /** Accepted transport authority for this live row; null means local. */
  connectionId?: string | null
  /** Tab attribution from the hook IPC payload, when available. */
  tabId?: string
  terminalTitle?: string
  /** Rolling log of previous states, capped at AGENT_STATE_HISTORY_MAX. */
  stateHistory: AgentStateHistoryEntry[]
  /** Name of the tool the agent is currently using (e.g. "Edit", "Bash"). */
  toolName?: string
  /** Short preview of the tool input (e.g. file path, command). */
  toolInput?: string
  /** JSON of the AskUserQuestion tool input, captured live; unlike toolInput it's not
   *  truncated (clients render the full card). Cleared once the agent moves on so a stale prompt can't linger. */
  interactivePrompt?: string
  /** Most recent assistant message preview, when the hook carried one. */
  lastAssistantMessage?: string
  /** True when this `done` was reached via interrupt, not normal completion
   *  (agent-reported or Orca's guarded fallback). Undefined otherwise. */
  interrupted?: boolean
  /** True when this `done` means the launched agent CLI never started (#7047). */
  launchFailed?: boolean
  /** Orchestration dispatch context for panes spawned by another agent.
   *  Why: parent/child hierarchy is pane-level state, not worktree lineage — workers often share the coordinator's worktree. */
  orchestration?: AgentStatusOrchestrationContext
  /** Live in-process subagents/teammates of this pane's session. Absent when
   *  none are tracked; the sidebar derives indented child rows from it. */
  subagents?: AgentSubagentSnapshot[]
  /** Provider-owned conversation/session id captured from hook payloads.
   *  Used only for exact CLI resume; Orca terminal ids are not agent-session ids. */
  providerSession?: AgentProviderSessionMetadata
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
}

export type MigrationUnsupportedPtyEntry = {
  ptyId: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  /** Registry-backed UUID pane proof, when available. */
  paneKey?: string
  reason: 'legacy-numeric-pane-key'
  source: 'local' | 'ssh'
  updatedAt: number
}

// ─── Agent status payload shape (what hook receivers send via IPC) ──────────
// Hook integrations provide only normalized state fields; the renderer fills the rest (updatedAt, paneKey, …) on IPC receipt.

export type AgentStatusPayload = {
  state: AgentStatusState
  prompt?: string
  agentType?: AgentType
  model?: string
  toolName?: string
  toolInput?: string
  /** JSON string of the AskUserQuestion tool input, captured live. See the
   *  AgentStatusEntry field for semantics. Not truncated like toolInput. */
  interactivePrompt?: string
  lastAssistantMessage?: string
  interrupted?: boolean
  /** True when this `done` means the agent CLI never started (immediate exit
   *  126/127 before any recognition, #7047). Undefined otherwise. */
  launchFailed?: boolean
  /** Live in-process children of the reporting session. See AgentStatusEntry. */
  subagents?: AgentSubagentSnapshot[]
}

/**
 * Result of `parseAgentStatusPayload`: prompt is always a string (empty when omitted) so
 * consumers needn't nullish-coalesce; tool/assistant fields stay optional to distinguish
 * absence ("no new info") from an explicit empty string.
 */
export type ParsedAgentStatusPayload = Omit<AgentStatusPayload, 'prompt'> & { prompt: string }

/**
 * Wire shape for agent-status IPC. Both `agentStatus:set` and `agentStatus:getSnapshot`
 * produce this shape so renderer call sites share a single `setAgentStatus` path.
 */
export type AgentStatusIpcPayload = ParsedAgentStatusPayload & {
  paneKey: string
  launchToken?: string
  terminalHandle?: string
  tabId?: string
  worktreeId?: string
  /** Identifies the SSH connection the event arrived on, or null for local.
   *  Only the remote-ingest path (`ingestRemote`) can stamp it; the HTTP path always sets null. See docs/design/agent-status-over-ssh.md §5. */
  connectionId: string | null
  /** Timestamp (ms) when the hook server received this latest status event. */
  receivedAt: number
  /** Timestamp (ms) when the current state first appeared for this pane. */
  stateStartedAt: number
  /** Raw agent hook event name (e.g. UserPromptSubmit, PreToolUse, Stop).
   *  Why: lets the renderer's completion coordinator tell a real user-initiated
   *  turn from background plugin churn (e.g. Claude-Mem's post-turn memory
   *  writes) so it doesn't re-arm a duplicate completion notification. */
  hookEventName?: string
  /** True when this hook event carried prompt text directly rather than reusing
   *  the listener's cached prompt — the main-process new-turn signal. */
  hasExplicitPrompt?: boolean
  orchestration?: AgentStatusOrchestrationContext
  providerSession?: AgentProviderSessionMetadata
  /** Resume identity update only; the status-shaped fields are transport placeholders. */
  providerSessionOnly?: boolean
  /** Payload-free observable-work choreography for aterm Matrix Rain. */
  rainPulse?: AtermRainPulse
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
}

/** Wire shape for ordinary pane teardown or a stamped SSH disconnect batch. */
export type AgentStatusClearIpcPayload =
  | { paneKey: string }
  | {
      transient: true
      connectionId: string
      clearedAt: number
    }

/** Maximum character length for the toolName field. */
export const AGENT_STATUS_TOOL_NAME_MAX_LENGTH = 60
/** Maximum character length for the toolInput preview. */
export const AGENT_STATUS_TOOL_INPUT_MAX_LENGTH = 160
/** Maximum character length for the lastAssistantMessage preview.
 *  Why: 8 KB fits a multi-paragraph summary while bounding per-pane cache against a buggy/malicious agent spamming huge strings. */
export const AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH = 8000
/** Maximum character length for the interactivePrompt field.
 *  Why: holds full AskUserQuestion JSON — truncating to a preview like toolInput would corrupt it and drop options; capped to still bound cache growth. */
export const AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH = 16000
/**
 * Freshness threshold for explicit agent status: retained past this so WorktreeCard's
 * sidebar dot can decay "working" back to "active" when the hook stream goes silent.
 */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

/** Maximum character length for the agentType label. Truncated on parse. */
export const AGENT_TYPE_MAX_LENGTH = 40
export const AGENT_MODEL_MAX_LENGTH = 120

/** Maximum subagent child rows carried per status entry. Bounds per-pane cache
 *  and IPC fanout against a runaway spawner. */
export const AGENT_STATUS_MAX_SUBAGENTS = 32
export const AGENT_STATUS_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 4096,
  nestingDepth: 16
} as const
/** Maximum character length for a subagent's provider-assigned id. */
export const AGENT_SUBAGENT_ID_MAX_LENGTH = 64
