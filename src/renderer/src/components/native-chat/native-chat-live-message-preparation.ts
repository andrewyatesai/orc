// Prepare an already-assembled transcript for the live render axis exactly once:
// surface skill envelopes, fold image-marker turns, and only re-run the full
// cross-source dedup when the presentation transforms could collide across
// sources. The status-only merge then reuses this array by reference instead of
// re-assembling it on every hook-state frame.

import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../shared/native-chat-command-envelope'
import { normalizeImageTranscriptMessages } from '../../../../shared/native-chat-image-transcript-markers'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import { assembleNativeChatSession } from './native-chat-session-assembler'

export function prepareNativeChatLiveMessages(
  messages: NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  const commandNames = new Set(getVerifiedNativeChatCommands(agent).map((command) => command.name))
  const surfaced = surfaceSkillInvocationUserTurns(messages, commandNames)
  const normalized = normalizeImageTranscriptMessages(surfaced)
  if (!hasMixedSources(normalized)) {
    return normalized
  }
  // A second pass preserves legacy cross-source winners after sorting or presentation transforms.
  return assembleNativeChatSession({
    sources: { transcript: surfaced },
    sessionId: null,
    agent
  }).messages
}

function hasMixedSources(messages: readonly NativeChatMessage[]): boolean {
  const source = messages[0]?.source
  return messages.some((message) => message.source !== source)
}
