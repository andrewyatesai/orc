import { useEffect, useRef } from 'react'
import {
  createNativeChatTranscriptRetention,
  encodeNativeChatTranscriptIdentity
} from '../../../../shared/native-chat-transcript-retention'
import {
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'

/** Keeps one committed conversation visible while its exact source rebinds
 *  (owner flip, manual reconnect) instead of blanking to a spinner until the
 *  fresh read lands. Retention is keyed by the full source identity, so it can
 *  never serve one pane/owner/session's transcript under another's. */
export function useNativeChatRetainedSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const session = useNativeChatLiveSession(args)
  const identity = encodeNativeChatTranscriptIdentity([
    args.paneKey,
    args.runtimeEnvironmentId ?? null,
    args.agent,
    args.sessionId,
    args.transcriptPath ?? null
  ])
  const activeIdentityRef = useRef(identity)
  const retentionRef = useRef(createNativeChatTranscriptRetention())
  // The inner hook clears a commit after the identity changes, so treat its read
  // as loading until this render's identity is the one it settled against.
  const sessionMatchesIdentity = activeIdentityRef.current === identity
  const readPhase = sessionMatchesIdentity ? session.readPhase : 'loading'

  useEffect(() => {
    activeIdentityRef.current = identity
  }, [identity])
  useEffect(() => {
    if (sessionMatchesIdentity && args.sessionId !== null && session.readPhase === 'ready') {
      retentionRef.current.capture(identity, session.messages)
    }
  }, [args.sessionId, identity, session.messages, session.readPhase, sessionMatchesIdentity])

  // Fork: a settled read (ready or error) keeps its own list, matching base
  // behaviour where a read error still shows the prior transcript; only a
  // re-loading read is unsettled and falls back to the retained conversation.
  const messages = retentionRef.current.visible({
    identity,
    messages: session.messages,
    settled: readPhase !== 'loading',
    loading: readPhase === 'loading'
  })
  if (messages === session.messages && readPhase === session.readPhase) {
    return session
  }
  return {
    ...session,
    messages,
    readPhase,
    ...(sessionMatchesIdentity ? {} : { status: 'loading' as const, error: undefined })
  }
}
