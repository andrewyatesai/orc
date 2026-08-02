/**
 * Wire types for `terminal.agentTranscript` — the agent's OWN record of the
 * session running in a pane, read from the file the agent CLI writes.
 *
 * Why this verb exists: when an agent TUI renders `… +120 lines`, those lines
 * were never written to the PTY. No terminal surface can expand them because
 * the bytes do not exist in any buffer (docs/reference/alab-agent-visibility.md
 * §5.2). The agent's own transcript has them untruncated and structured, which
 * makes this the only complete answer to "what did that tool actually return".
 *
 * Honesty contract, same as the other context verbs: `available: false` always
 * carries a NAMED reason and a `detail` sentence, so an empty `turns` array
 * never has to mean both "the agent has said nothing" and "I could not look".
 */
import type { NativeChatRole } from './native-chat-types'
import type { TerminalContextBlindSpot } from './terminal-context-protocol'

export const AGENT_TRANSCRIPT_SCHEMA_VERSION = 1

/** Why the transcript could not be read. Each value is a DIFFERENT cause and a
 *  different fix, which is the whole point of naming them. */
export type AgentTranscriptUnavailableReason =
  /** No hook has ever reported a provider session id for this pane. */
  | 'no-agent-session'
  /** The agent is known by name but Orca has no reader for its transcript format. */
  | 'unsupported-agent'
  /** The file lives on a filesystem this Orca host cannot address (SSH, or a
   *  WSL distro whose path could not be bridged). */
  | 'remote-host'
  /** Session known, file not on disk here — usually a session that has not
   *  flushed its first record yet. */
  | 'transcript-not-found'
  /** The file was located but the read itself failed. */
  | 'read-failed'

/** Whose filesystem holds the transcript. A driver must know this before it
 *  goes looking: an SSH pane's transcript is NOT on the Orca host. */
export type AgentTranscriptHost =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string | null }
  | { kind: 'ssh'; connectionId: string }

/** `truncated` marks a body the per-block character cap cut. It is never a
 *  silent clip — a driver raising `limit` or paging knows there is more. */
export type AgentTranscriptBlock =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'tool-call'; name: string; input: string; truncated: boolean }
  /** The collapsed part: full tool output as the agent recorded it. */
  | { kind: 'tool-result'; output: string; isError: boolean; truncated: boolean }
  | { kind: 'image-ref'; ref: string | null; alt: string | null }

export type AgentTranscriptTurn = {
  id: string
  role: NativeChatRole
  /** Epoch ms, or null when the provider recorded none. */
  timestamp: number | null
  blocks: AgentTranscriptBlock[]
}

export type TerminalAgentTranscript = {
  schema: number
  handle: string
  /** True only when the file was both located AND read. */
  available: boolean
  unavailable?: AgentTranscriptUnavailableReason
  /** One sentence naming the exact cause, agent and host included. Null only
   *  when the read succeeded. */
  detail: string | null
  /** The agent Orca believes owns this pane, by its own name — populated even
   *  for `unsupported-agent`, so a driver learns WHICH agent it cannot read. */
  agent: string | null
  sessionId: string | null
  /** Null when the pane's host could not be determined — the transcript lives on
   *  whichever host ran the agent, so an unknown host means nothing was read. */
  host: AgentTranscriptHost | null
  /** On a successful read, the file Orca opened (a bridged WSL pane reports the
   *  UNC form it was reachable by). On a `remote-host` refusal, the path the
   *  agent reported — valid on ITS host, not this one. Null when unknown. */
  path: string | null
  /** Oldest first, so the newest turn is last — reading order, matching the
   *  other context verbs. */
  turns: AgentTranscriptTurn[]
  /** Older turns exist before this window. */
  hasMoreBefore: boolean
  /** Byte offset of the oldest returned turn; feed back as `before` to page
   *  one window older. Null when nothing was returned. */
  previousOffset: number | null
  /** A character budget trimmed block bodies in this window. Turns themselves
   *  are never dropped — that would invalidate `previousOffset`. Individual
   *  blocks carry their own `truncated` flag. */
  limited: boolean
  blindSpots: TerminalContextBlindSpot[]
}

/** The transcript is not the screen. It holds what the agent has already
 *  flushed, which is both more (untruncated tool output) and less (nothing the
 *  TUI is only drawing right now) than the pane shows. */
export const AGENT_TRANSCRIPT_SCREEN_STATE_BLIND_SPOT: TerminalContextBlindSpot = {
  capability: 'agent-screen-state',
  reason: 'transcript-lags-pty',
  detail:
    'A transcript records what the agent already wrote to disk: an in-flight turn, a pending permission prompt, and anything the TUI only painted on screen are absent. Use terminal.agentView for what the pane shows right now.'
}
