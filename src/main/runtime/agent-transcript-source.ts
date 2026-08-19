/**
 * Resolve a pane to the agent transcript file that belongs to it — or to a
 * NAMED refusal (`terminal.agentTranscript`, visibility map §5.2).
 *
 * The join key is the provider session id the agent's hook reports, which Orca
 * already captures for resume (`extractAgentProviderSession`). The agent kind
 * and the session id are taken from the SAME hook row so they cannot disagree
 * about which conversation is being read.
 *
 * Pure module: every pane fact is injected, including the host platform, so the
 * Windows/WSL path bridge is testable from any OS.
 */
import type {
  AgentTranscriptHost,
  AgentTranscriptUnavailableReason
} from '../../shared/agent-transcript-protocol'
import {
  resolveNativeChatTranscriptAgent,
  type NativeChatTranscriptAgent
} from '../../shared/native-chat-agent-support'
import { toWindowsWslPath } from '../../shared/wsl-unc-paths'

/** The subset of an agent hook row this resolution needs. */
export type AgentTranscriptHookRow = {
  agentType?: string
  providerSession?: { id: string; transcriptPath?: string }
  receivedAt: number
}

export type AgentTranscriptPaneFacts = {
  /** Hook rows Orca holds for this pane, any order. */
  hookRows: readonly AgentTranscriptHookRow[]
  /** Agent named by the pane's launch/foreground record. Used only to NAME the
   *  agent in a refusal when no hook row carried a session. */
  paneAgent: string | null
  host: AgentTranscriptHost
  /** True when the Orca host can address `\\wsl.localhost\<distro>` shares. */
  canBridgeWslPaths: boolean
}

export type AgentTranscriptSource =
  | {
      readable: true
      /** Which decoder reads this format. */
      agent: NativeChatTranscriptAgent
      /** The agent's own name, which may be a Claude-format alias (openclaude). */
      agentName: string
      sessionId: string
      /** An exact file to read, bypassing session-id search. Set for WSL panes,
       *  whose POSIX path had to be rebased onto the distro's UNC share. */
      filePath: string | null
      /** Hook-reported path to prefer over the id search when it exists. */
      transcriptPathHint: string | null
      host: AgentTranscriptHost
    }
  | {
      readable: false
      unavailable: AgentTranscriptUnavailableReason
      detail: string
      agentName: string | null
      sessionId: string | null
      /** Where the file is, when the agent told us — the useful half of a
       *  remote-host refusal. */
      reportedPath: string | null
      host: AgentTranscriptHost
    }

/** Newest hook row that carries a provider session. Unbounded by staleness on
 *  purpose: a session id is durable identity, not live state, and an idle agent
 *  still has a transcript worth reading. */
export function selectAgentTranscriptSessionRow(
  rows: readonly AgentTranscriptHookRow[]
): AgentTranscriptHookRow | null {
  let newest: AgentTranscriptHookRow | null = null
  for (const row of rows) {
    if (row.providerSession?.id && (!newest || row.receivedAt > newest.receivedAt)) {
      newest = row
    }
  }
  return newest
}

function hostLabel(host: AgentTranscriptHost): string {
  if (host.kind === 'ssh') {
    return `SSH connection ${host.connectionId}`
  }
  if (host.kind === 'wsl') {
    return host.distro ? `WSL distro ${host.distro}` : 'an unidentified WSL distro'
  }
  return 'this host'
}

export function resolveAgentTranscriptSource(
  facts: AgentTranscriptPaneFacts
): AgentTranscriptSource {
  const row = selectAgentTranscriptSessionRow(facts.hookRows)
  const agentName = row?.agentType?.trim() || facts.paneAgent?.trim() || null
  const sessionId = row?.providerSession?.id ?? null
  const reportedPath = row?.providerSession?.transcriptPath?.trim() || null
  const refuse = (
    unavailable: AgentTranscriptUnavailableReason,
    detail: string
  ): AgentTranscriptSource => ({
    readable: false,
    unavailable,
    detail,
    agentName,
    sessionId,
    reportedPath,
    host: facts.host
  })

  if (facts.host.kind === 'ssh') {
    return refuse(
      'remote-host',
      `This pane runs over ${hostLabel(facts.host)}, so its agent transcript is a file on that host, not on the Orca host.${reportedPath ? ` The agent reports it at ${reportedPath} there.` : ''} Read it from a pane on that host.`
    )
  }
  if (!sessionId) {
    return refuse(
      'no-agent-session',
      agentName
        ? `No agent hook has reported a provider session id for this pane, so Orca cannot name ${agentName}'s transcript. This is a missing join key, not an empty conversation.`
        : 'No agent hook has reported a provider session id for this pane, so Orca does not know which agent (if any) owns it or where its transcript is.'
    )
  }
  const agent = resolveNativeChatTranscriptAgent(agentName)
  if (!agent) {
    return refuse(
      'unsupported-agent',
      `Orca has no transcript reader for ${agentName ?? 'this agent'}. Readers exist for claude, openclaude, codex and grok; other agents write formats this verb cannot decode.`
    )
  }
  if (facts.host.kind === 'wsl') {
    return resolveWslSource({
      facts,
      agent,
      agentName: agentName ?? agent,
      sessionId,
      reportedPath
    })
  }
  return {
    readable: true,
    agent,
    agentName: agentName ?? agent,
    sessionId,
    filePath: null,
    transcriptPathHint: reportedPath,
    host: facts.host
  }
}

/** A WSL pane's agent writes POSIX paths the Windows host cannot stat, and its
 *  home is a different tree than the one a session-id search would walk — so a
 *  bridged exact path is the only honest read. Without one, refuse by name
 *  rather than search the wrong home and report "not found". */
function resolveWslSource(args: {
  facts: AgentTranscriptPaneFacts
  agent: NativeChatTranscriptAgent
  agentName: string
  sessionId: string
  reportedPath: string | null
}): AgentTranscriptSource {
  const { facts, reportedPath } = args
  const distro = facts.host.kind === 'wsl' ? facts.host.distro : null
  const refuseWsl = (detail: string): AgentTranscriptSource => ({
    readable: false,
    unavailable: 'remote-host',
    detail,
    agentName: args.agentName,
    sessionId: args.sessionId,
    reportedPath,
    host: facts.host
  })
  if (!distro || !facts.canBridgeWslPaths) {
    return refuseWsl(
      `This pane runs inside ${hostLabel(facts.host)}; its transcript lives in that distro's filesystem and Orca could not bridge a path to it from this host.`
    )
  }
  if (!reportedPath) {
    return refuseWsl(
      `This pane runs inside ${hostLabel(facts.host)}. Its agent reported session ${args.sessionId} but no transcript path, and the distro's home is not the home a session-id search would walk — so the file cannot be located from the Windows side.`
    )
  }
  return {
    readable: true,
    agent: args.agent,
    agentName: args.agentName,
    sessionId: args.sessionId,
    filePath: reportedPath.startsWith('/') ? toWindowsWslPath(reportedPath, distro) : reportedPath,
    transcriptPathHint: null,
    host: facts.host
  }
}
