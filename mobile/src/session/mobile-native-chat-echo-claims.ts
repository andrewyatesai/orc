import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizedUserText } from './mobile-native-chat-draft-reconcile'
import { isImageSourceUserTurn } from './mobile-native-chat-image-transcript-markers'

/** A send awaiting its transcript echo — an optimistic pending bubble or an
 *  ack-lost unconfirmed hold. Both reconcile through the same claim pass. */
export type MobileNativeChatEchoClaimant = {
  normalizedText: string
  baselineTailMessageId: string | null
  images?: string[]
}

// Match each entry to a NEW transcript echo: one whose index is after the entry's
// captured tail (prepended history has index <= tail) and not already claimed by
// another entry. Shared by the unconfirmed-send hold and the optimistic-pending
// clear so paged-in identical turns can never satisfy either path.
//
// Returns the landed entries and the survivors with their baselines advanced past
// every echo this pass consumed. Persisting the claim in the survivor's baseline is
// what stops a later transcript change (e.g. an assistant append) from recomputing
// claims fresh and re-matching an already-consumed echo to a surviving duplicate
// before that survivor's own echo lands (cx2). A survivor is a duplicate whose own
// echo has not arrived yet, so it can never match anything at or below the max
// consumed index; advancing only-forward loses no legitimate future match.
export function reconcileLandedEchoes<T extends MobileNativeChatEchoClaimant>(
  messages: readonly NativeChatMessage[],
  entries: readonly T[]
): { landed: T[]; survivors: T[] } {
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
  const landed: T[] = []
  const nonLanded: T[] = []
  let maxConsumedIndex = -1
  const claimEchoes = (key: string, tailIndex: number, limit: number): number => {
    let claims = 0
    for (const message of userMessagesByText.get(key) ?? []) {
      if (claims >= limit) {
        break
      }
      if (message.index > tailIndex && !claimedMessageIds.has(message.id)) {
        claimedMessageIds.add(message.id)
        maxConsumedIndex = Math.max(maxConsumedIndex, message.index)
        claims++
      }
    }
    return claims
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
    const claimed =
      entry.normalizedText === ''
        ? claimEchoes('', tailIndex, entry.images?.length || 1)
        : claimEchoes(entry.normalizedText, tailIndex, 1)
    if (claimed > 0) {
      landed.push(entry)
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
  return { landed, survivors }
}
