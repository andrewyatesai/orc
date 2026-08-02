/**
 * Read the transcript file a resolved pane points at, and turn every failure
 * into a named refusal rather than an empty turn list.
 *
 * Reuses the native-chat readers Orca already ships: the same session-file
 * resolver the chat view uses, and the same bounded tail reader (it walks
 * backward from EOF in 64 KiB chunks and stops after `limit` records, so a
 * multi-gigabyte session costs one window).
 *
 * The readers are injectable so the refusal mapping is testable without a
 * filesystem, and they load on first use: this module hangs off the runtime,
 * and a static import would pull the native-chat filesystem graph into every
 * consumer of it.
 */
import type { TerminalAgentTranscript } from '../../shared/agent-transcript-protocol'
// Type-only: erased at build, so the native-chat filesystem graph is not pulled
// into every static consumer of the runtime — it loads on first read instead.
import type { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type { readNativeChatTranscriptTail } from '../native-chat/transcript-tail-reader'
import type { AgentTranscriptSource } from './agent-transcript-source'
import {
  boundAgentTranscriptTurnCount,
  buildTerminalAgentTranscript,
  buildUnavailableAgentTranscript
} from './terminal-agent-transcript'

export type ReadableAgentTranscriptSource = Extract<AgentTranscriptSource, { readable: true }>

export type AgentTranscriptReaders = {
  resolvePath: typeof resolveSessionFilePath
  readTail: typeof readNativeChatTranscriptTail
}

async function loadAgentTranscriptReaders(): Promise<AgentTranscriptReaders> {
  const [resolver, reader] = await Promise.all([
    import('../native-chat/session-file-resolver'),
    import('../native-chat/transcript-tail-reader')
  ])
  return {
    resolvePath: resolver.resolveSessionFilePath,
    readTail: reader.readNativeChatTranscriptTail
  }
}

export async function readAgentTranscriptForSource(args: {
  handle: string
  source: ReadableAgentTranscriptSource
  limit?: number
  before?: number
  readers?: AgentTranscriptReaders
}): Promise<TerminalAgentTranscript> {
  const { handle, source } = args
  const { resolvePath, readTail } = args.readers ?? (await loadAgentTranscriptReaders())
  const refuse = (
    unavailable: 'transcript-not-found' | 'read-failed',
    detail: string,
    path: string | null
  ): TerminalAgentTranscript =>
    buildUnavailableAgentTranscript({
      handle,
      unavailable,
      detail,
      agent: source.agentName,
      sessionId: source.sessionId,
      host: source.host,
      path
    })

  const filePath =
    source.filePath ??
    (await resolvePath(
      source.agent,
      source.sessionId,
      source.transcriptPathHint ? { transcriptPath: source.transcriptPathHint } : {}
    ))
  if (!filePath) {
    return refuse(
      'transcript-not-found',
      `No transcript file for ${source.agentName} session ${source.sessionId} exists on this host yet. A session that has not flushed its first record looks exactly like this — retry rather than concluding the agent said nothing.`,
      null
    )
  }
  const result = await readTail({
    agent: source.agent,
    sessionId: source.sessionId,
    filePath,
    limit: boundAgentTranscriptTurnCount(args.limit),
    ...(args.before !== undefined ? { beforeOffset: args.before } : {})
  })
  if ('error' in result) {
    return result.notFound
      ? refuse(
          'transcript-not-found',
          `${source.agentName} session ${source.sessionId} names ${filePath}, but that file is not there: ${result.error}`,
          filePath
        )
      : refuse('read-failed', `Could not read ${filePath}: ${result.error}`, filePath)
  }
  return buildTerminalAgentTranscript({
    handle,
    agent: source.agentName,
    sessionId: source.sessionId,
    host: source.host,
    path: filePath,
    messages: result.messages,
    hasMoreBefore: result.hasMore,
    previousOffset: result.beforeOffset
  })
}
