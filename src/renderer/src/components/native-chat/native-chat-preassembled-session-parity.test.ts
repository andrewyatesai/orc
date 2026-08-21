import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../shared/native-chat-command-envelope'
import {
  createIncrementalAssembler,
  reset as resetAssembler
} from './native-chat-incremental-assembler'
import { prepareNativeChatLiveMessages } from './native-chat-live-message-preparation'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { assembleNativeChatSession } from './native-chat-session-assembler'

const CLAUDE_COMMANDS = new Set(
  getVerifiedNativeChatCommands('claude').map((command) => command.name)
)

function message(id: string, overrides: Partial<NativeChatMessage> = {}): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

// The seam: the direct prepared array must deep-equal the legacy per-frame
// re-assembly it replaces, so dropping the second assembleNativeChatSession pass
// is behavior-preserving. Both arms feed the same incremental-assembler output.
function expectLegacyMessageParity(transcript: NativeChatMessage[]): NativeChatMessage[] {
  const assembled = resetAssembler(createIncrementalAssembler(), transcript)
  const surfaced = surfaceSkillInvocationUserTurns(assembled, CLAUDE_COMMANDS)
  const direct = prepareNativeChatLiveMessages(assembled, 'claude')
  const legacy = assembleNativeChatSession({
    sources: { transcript: surfaced },
    sessionId: 'session-1',
    agent: 'claude'
  }).messages
  expect(direct).toEqual(legacy)
  return direct
}

describe('preassembled native-chat live sessions', () => {
  it('keeps the direct array for an ordinary single-source history', () => {
    const messages = [message('user', { role: 'user', blocks: [{ type: 'text', text: 'hello' }] })]

    expect(prepareNativeChatLiveMessages(messages, 'claude')).toBe(messages)
  })

  it('folds a paired image-source/prompt turn like the legacy rebuild', () => {
    const transcript = [
      message('image-source', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }],
        timestamp: 1
      }),
      message('image-prompt', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image #1] describe this' }],
        timestamp: 2
      })
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'describe this' }
    ])
  })

  it('re-dedupes surfaced skill envelopes that collide across sources', () => {
    const skill = (id: string, plugin: string, source: 'transcript' | 'scrape') =>
      message(id, {
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `<command-name>/${plugin}:review</command-name>\n<command-args>focus</command-args>`
          }
        ],
        timestamp: source === 'scrape' ? 1 : 2,
        source
      })
    const transcript = [
      skill('scrape-skill', 'plugin-a', 'scrape'),
      skill('skill', 'plugin-b', 'transcript')
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'skill', source: 'transcript' })
    expect(out[0]?.blocks).toEqual([{ type: 'text', text: '/review focus' }])
  })

  it('re-dedupes unchanged mixed-source histories after the first pass reorders them', () => {
    const transcript = [
      message('scrape-1', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 3,
        source: 'scrape'
      }),
      message('scrape-2', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 2,
        source: 'scrape'
      }),
      message('transcript', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 1
      })
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out.map((entry) => entry.id)).toEqual(['transcript'])
  })

  it('infers live status from statusTailMessage, not the prepared tail', () => {
    // The prepared tail is a user turn (no prose recovery) while the pre-dedup
    // assembler tail is an assistant turn that post-dates the hook — the override
    // must read the raw tail and settle the dropped working hook to 'ready'.
    const preparedTail = message('prepared-user', {
      role: 'user',
      blocks: [{ type: 'text', text: 'q' }],
      timestamp: 20
    })
    const rawAssistantTail = message('raw-assistant', { role: 'assistant', timestamp: 20 })

    const session = mergeNativeChatLiveSession({
      messages: [preparedTail],
      sessionId: 'session-1',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 10,
      statusTailMessage: rawAssistantTail
    })

    expect(session.status).toBe('ready')
  })

  it('falls back to the prepared tail when no statusTailMessage is provided', () => {
    const assistantTail = message('a', { role: 'assistant', timestamp: 20 })

    const session = mergeNativeChatLiveSession({
      messages: [assistantTail],
      sessionId: 'session-1',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 10
    })

    expect(session.status).toBe('ready')
  })

  it('preserves the preassembled array reference through every status-precedence path', () => {
    const messages = [message('answer', { timestamp: 10 })]
    const base = { messages, sessionId: 'session-1', agent: 'claude' as const }
    const sessions = [
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        loading: true,
        transcriptLifecycle: { state: 'working', turnId: 'turn-1', timestamp: 9 }
      }),
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        stateStartedAt: 9,
        transcriptLifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 10 },
        hookHasWorkingSubagents: true
      }),
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        stateStartedAt: 9,
        transcriptLifecycle: { state: 'interrupted', turnId: 'turn-1', timestamp: 10 },
        hookHasWorkingSubagents: true
      }),
      mergeNativeChatLiveSession({ ...base, hookState: null, loading: true }),
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        loading: true,
        error: 'unreadable'
      })
    ]

    // A known session held on 'loading' outranks a bare live 'working' in this
    // fork; the array reference must survive every branch regardless.
    expect(sessions.map((session) => session.status)).toEqual([
      'loading',
      'working',
      'ready',
      'loading',
      'error'
    ])
    for (const session of sessions) {
      expect(session.messages).toBe(messages)
    }
    expect(sessions.at(-1)?.error).toBe('unreadable')
  })

  it('matches the legacy rebuild across deterministic randomized transcripts', () => {
    for (let seed = 1; seed <= 512; seed += 1) {
      expectLegacyMessageParity(randomTranscript(seed))
    }
  })
})

function randomTranscript(seed: number): NativeChatMessage[] {
  const random = mulberry32(seed)
  const count = 1 + Math.floor(random() * 48)
  const messages: NativeChatMessage[] = []
  for (let index = 0; index < count; index += 1) {
    const priorIndex = index > 0 ? Math.floor(random() * index) : index
    const idIndex = index > 0 && random() < 0.12 ? priorIndex : index
    const timestamp = random() < 0.18 ? null : Math.floor(random() * 24)
    const kind = Math.floor(random() * 7)
    const entry = randomMessage(seed, index, idIndex, timestamp, kind)
    if (random() < 0.2) {
      entry.turnId = `turn-${seed}-${index}`
    }
    messages.push(entry)
  }
  return messages
}

function randomMessage(
  seed: number,
  index: number,
  idIndex: number,
  timestamp: number | null,
  kind: number
): NativeChatMessage {
  const id = `message-${seed}-${idIndex}`
  const source = (seed + index) % 4 === 0 ? ('scrape' as const) : ('transcript' as const)
  const base = { id, timestamp, source }
  switch (kind) {
    case 0:
      return { ...base, role: 'user', blocks: [{ type: 'text', text: ` prompt  ${index % 5} ` }] }
    case 1:
      return { ...base, role: 'assistant', blocks: [{ type: 'text', text: `answer ${index}` }] }
    case 2:
      return {
        ...base,
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'read', input: { path: `${index}.txt` } }]
      }
    case 3:
      return {
        ...base,
        role: 'tool',
        blocks: [{ type: 'tool-result', output: `result ${index}`, isError: index % 5 === 0 }]
      }
    case 4:
      return {
        ...base,
        role: 'user',
        blocks: [{ type: 'text', text: `[Image: source: /tmp/${seed}-${index}.png]` }]
      }
    case 5:
      return {
        ...base,
        role: 'user',
        blocks: [{ type: 'text', text: `[Image #1] inspect ${index}` }]
      }
    default:
      return {
        ...base,
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `<command-name>/plugin:skill-${index % 3}</command-name>\n<command-args>arg ${index}</command-args>`
          }
        ]
      }
  }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
