import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  isImageSourceUserTurn,
  stripImagePromptMarker
} from './mobile-native-chat-image-transcript-markers'

/** An ack-lost ('unknown' outcome) send held until its transcript echo lands or
 *  the deadline surfaces the uncertainty. */
export type UnconfirmedSend = {
  draftKey: string
  pendingKey: string | null
  text: string
  normalizedText: string
  baselineTailMessageId: string | null
  deadline: ReturnType<typeof setTimeout> | null
}

export function normalizedUserText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const text = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  // Claude echoes a captioned image send as `[Image #1] caption` — the sent
  // text must still match its echo, so strip the marker before comparing.
  const stripped = stripImagePromptMarker(text).trim()
  return stripped || null
}

export function countUserTextOccurrences(
  messages: readonly NativeChatMessage[],
  text: string
): number {
  let count = 0
  for (const message of messages) {
    if (normalizedUserText(message) === text) {
      count++
    }
  }
  return count
}

/** Number of `[Image: source: …]` echo turns strictly after `tailId` (or the
 *  whole transcript when the tail was paginated out). An image-only send has no
 *  caption to match, so it reconciles by ordinal against this count — counting
 *  only image echoes keeps an unrelated text send's echo from clearing it. */
export function countImageSourceTurnsAfter(
  messages: readonly NativeChatMessage[],
  tailId: string | null
): number {
  const tailIndex = tailId ? messages.findIndex((message) => message.id === tailId) : -1
  let count = 0
  for (let i = tailIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message && isImageSourceUserTurn(message)) {
      count++
    }
  }
  return count
}

export function findLandedUnconfirmedSends(
  messages: readonly NativeChatMessage[],
  entries: readonly UnconfirmedSend[]
): UnconfirmedSend[] {
  // Why: pagination prepends old equal text; only unclaimed matches after each
  // captured tail prove new echoes. User turns are keyed by text; an image echo
  // (`[Image: source: …]` or no text) keys under '' so an empty-text send can
  // claim it.
  const messageIndexById = new Map<string, number>()
  const userMessagesByText = new Map<string, Array<{ id: string; index: number }>>()
  for (const [index, message] of messages.entries()) {
    messageIndexById.set(message.id, index)
    if (message.role !== 'user') {
      continue
    }
    const key = isImageSourceUserTurn(message) ? '' : (normalizedUserText(message) ?? '')
    const current = userMessagesByText.get(key) ?? []
    current.push({ id: message.id, index })
    userMessagesByText.set(key, current)
  }

  const claimedMessageIds = new Set<string>()
  const landed: UnconfirmedSend[] = []
  for (const entry of entries) {
    const tailIndex = entry.baselineTailMessageId
      ? messageIndexById.get(entry.baselineTailMessageId)
      : -1
    if (tailIndex === undefined) {
      continue
    }
    const echo = userMessagesByText
      .get(entry.normalizedText)
      ?.find((message) => message.index > tailIndex && !claimedMessageIds.has(message.id))
    if (echo) {
      claimedMessageIds.add(echo.id)
      landed.push(entry)
    }
  }
  return landed
}

// Match each entry to a NEW transcript echo: one whose index is after the entry's
// captured tail (prepended history has index <= tail) and not already claimed by
// another entry. Shared by the unconfirmed-send hold and the optimistic-pending
// clear so paged-in identical turns can never satisfy either path.
//
// Returns the landed entries, the survivors with their baselines advanced past
// every echo this pass consumed, and — for each landed entry — the message id(s)
// its echo claimed (used to rebind ridden-along image previews). Persisting the
// claim in the survivor's baseline is what stops a later transcript change (e.g. an
// assistant append) from recomputing claims fresh and re-matching an already-
// consumed echo to a surviving duplicate before that survivor's own echo lands
// (cx2). A survivor is a duplicate whose own echo has not arrived yet, so it can
// never match anything at or below the max consumed index; advancing only-forward
// loses no legitimate future match.
export function reconcileLandedEchoes<
  T extends { normalizedText: string; baselineTailMessageId: string | null; images?: string[] }
>(
  messages: readonly NativeChatMessage[],
  entries: readonly T[]
): { landed: T[]; survivors: T[]; claimedMessageIdsByEntry: Map<T, string[]> } {
  const messageIndexById = new Map<string, number>()
  const userMessagesByText = new Map<string, Array<{ id: string; index: number }>>()
  for (const [index, message] of messages.entries()) {
    messageIndexById.set(message.id, index)
    if (message.role !== 'user') {
      continue
    }
    // `[Image: source: …]` turns — and any other text-less user turn — key by ''
    // so an image-only send, which has no caption to match, claims one of those
    // and never an unrelated text echo.
    const key = isImageSourceUserTurn(message) ? '' : (normalizedUserText(message) ?? '')
    const current = userMessagesByText.get(key) ?? []
    current.push({ id: message.id, index })
    userMessagesByText.set(key, current)
  }

  const tailIndexOf = (entry: T): number | undefined =>
    entry.baselineTailMessageId ? messageIndexById.get(entry.baselineTailMessageId) : -1

  const claimedMessageIds = new Set<string>()
  const claimedMessageIdsByEntry = new Map<T, string[]>()
  const landed: T[] = []
  const nonLanded: T[] = []
  let maxConsumedIndex = -1
  const claimEchoes = (key: string, tailIndex: number, limit: number): string[] => {
    const claimedIds: string[] = []
    for (const message of userMessagesByText.get(key) ?? []) {
      if (claimedIds.length >= limit) {
        break
      }
      if (message.index > tailIndex && !claimedMessageIds.has(message.id)) {
        claimedMessageIds.add(message.id)
        maxConsumedIndex = Math.max(maxConsumedIndex, message.index)
        claimedIds.push(message.id)
      }
    }
    return claimedIds
  }
  for (const entry of entries) {
    const tailIndex = tailIndexOf(entry)
    // Baseline message paged out of the transcript: can't validate an echo, so hold.
    if (tailIndex === undefined) {
      nonLanded.push(entry)
      continue
    }
    // An image-only send reserves one echo turn per ridden-along image, so a later
    // photo send cannot mistake this send's second image for its own echo.
    const claimedIds =
      entry.normalizedText === ''
        ? claimEchoes('', tailIndex, entry.images?.length || 1)
        : claimEchoes(entry.normalizedText, tailIndex, 1)
    if (claimedIds.length > 0) {
      landed.push(entry)
      claimedMessageIdsByEntry.set(entry, claimedIds)
    } else {
      nonLanded.push(entry)
    }
  }

  const consumedBaselineId = maxConsumedIndex >= 0 ? messages[maxConsumedIndex].id : null
  const survivors =
    consumedBaselineId === null
      ? nonLanded
      : nonLanded.map((entry) => {
          const tailIndex = tailIndexOf(entry)
          // Advance only-forward: never regress a survivor whose baseline already sits
          // past this pass's consumed echoes (its echo is further ahead still).
          return tailIndex !== undefined && tailIndex < maxConsumedIndex
            ? { ...entry, baselineTailMessageId: consumedBaselineId }
            : entry
        })
  return { landed, survivors, claimedMessageIdsByEntry }
}
