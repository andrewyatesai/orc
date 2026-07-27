import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizedUserText, type UnconfirmedSend } from './mobile-native-chat-draft-reconcile'
import { isImageSourceUserTurn } from './mobile-native-chat-image-transcript-markers'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'

export type MobileNativeChatPendingMessage = {
  id: string
  text: string
  normalizedText: string
  /** Local preview URIs of images ridden along on the send, rendered as thumbnails
   *  on the echo bubble so the sent photo shows before the transcript catches up. */
  images?: string[]
  // The transcript tail at send time; only echoes after it can clear this bubble.
  baselineTailMessageId: string | null
}
export type MobileNativeChatSendOrigin = {
  draftKey: string
  pendingKey: string | null
  normalizedText: string
  baselineTailMessageId: string | null
}

const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []

// How long an ack-lost send waits for its transcript echo before the UI surfaces
// that delivery remains unconfirmed.
const UNCONFIRMED_SEND_DEADLINE_MS = 20_000

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
function reconcileLandedEchoes<
  T extends { normalizedText: string; baselineTailMessageId: string | null; images?: string[] }
>(messages: readonly NativeChatMessage[], entries: readonly T[]): { landed: T[]; survivors: T[] } {
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

export function useMobileNativeChatDrafts(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
}): {
  composerText: string
  setComposerText: Dispatch<SetStateAction<string>>
  pending: MobileNativeChatPendingMessage[]
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
} {
  const { hostId, worktreeId, tabId, sessionId, messages } = args
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const pendingKey = draftKey && sessionId ? `${draftKey}\0${sessionId}` : null
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const pendingCounterRef = useRef(0)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeDraftKeyRef = useRef(draftKey)
  activeDraftKeyRef.current = draftKey
  const activePendingKeyRef = useRef(pendingKey)
  activePendingKeyRef.current = pendingKey
  const mountedRef = useRef(false)

  const setComposerText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      if (!draftKey) {
        return
      }
      setDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        return next === current ? previous : { ...previous, [draftKey]: next }
      })
    },
    [draftKey]
  )

  const captureSendOrigin = useCallback(
    (text: string) => {
      if (!draftKey) {
        return null
      }
      const normalizedText = text.trim()
      const currentMessages = messagesRef.current
      return {
        draftKey,
        pendingKey,
        normalizedText,
        baselineTailMessageId: currentMessages[currentMessages.length - 1]?.id ?? null
      }
    },
    [draftKey, pendingKey]
  )

  const acceptSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => {
      // Why: an RPC may settle after a tab switch; mutate only the tab that
      // originated the send, without erasing edits typed after it began.
      setDrafts((previous) =>
        (previous[origin.draftKey] ?? '').trim() === text.trim()
          ? { ...previous, [origin.draftKey]: '' }
          : previous
      )
      // Why: the first prompt can be sent before the provider reports a session
      // id; clear its draft, but wait for an id before keying an optimistic echo.
      if (!origin.pendingKey) {
        return
      }
      const pendingKey = origin.pendingKey
      pendingCounterRef.current += 1
      const pendingId = `pending-${pendingCounterRef.current}`
      setPendingBySession((previous) => {
        const current = previous[pendingKey] ?? NO_PENDING_MESSAGES
        const pending: MobileNativeChatPendingMessage = {
          id: pendingId,
          text,
          normalizedText: origin.normalizedText,
          baselineTailMessageId: origin.baselineTailMessageId,
          ...(images && images.length > 0 ? { images } : {})
        }
        return { ...previous, [pendingKey]: [...current, pending] }
      })
    },
    []
  )

  // Why: a relay drop mid-send loses only the ack in the common case — the
  // desktop already delivered the message. Hold the send instead of claiming
  // failure (which baits a duplicate): clear the draft when the transcript echo
  // lands, and surface the uncertainty if the deadline passes without one.
  const unconfirmedRef = useRef<UnconfirmedSend[]>([])
  const holdUnconfirmedSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, onUnconfirmed: () => void) => {
      if (!mountedRef.current) {
        return
      }
      const isActiveTranscript =
        activeDraftKeyRef.current === origin.draftKey &&
        (origin.pendingKey === null || activePendingKeyRef.current === origin.pendingKey)
      const entry: UnconfirmedSend = {
        draftKey: origin.draftKey,
        pendingKey: origin.pendingKey,
        text,
        normalizedText: origin.normalizedText,
        baselineTailMessageId: origin.baselineTailMessageId,
        deadline: null
      }
      // Why: the transcript event can beat the lost RPC acknowledgement.
      if (
        isActiveTranscript &&
        reconcileLandedEchoes(messagesRef.current, [entry]).landed.length > 0
      ) {
        setDrafts((previous) =>
          (previous[origin.draftKey] ?? '').trim() === text.trim()
            ? { ...previous, [origin.draftKey]: '' }
            : previous
        )
        return
      }
      entry.deadline = setTimeout(() => {
        unconfirmedRef.current = unconfirmedRef.current.filter((held) => held !== entry)
        onUnconfirmed()
      }, UNCONFIRMED_SEND_DEADLINE_MS)
      unconfirmedRef.current = [...unconfirmedRef.current, entry]
    },
    []
  )

  useEffect(() => {
    if (!draftKey || unconfirmedRef.current.length === 0) {
      return
    }
    const relevantSet = new Set(
      unconfirmedRef.current.filter(
        (entry) =>
          entry.draftKey === draftKey &&
          (entry.pendingKey === null || entry.pendingKey === pendingKey)
      )
    )
    const { landed, survivors } = reconcileLandedEchoes(messages, [...relevantSet])
    if (landed.length === 0) {
      return
    }
    // Keep untouched entries as-is; replace the relevant slice with its survivors,
    // whose baselines are advanced past this pass's consumed echoes (cx2).
    unconfirmedRef.current = [
      ...unconfirmedRef.current.filter((entry) => !relevantSet.has(entry)),
      ...survivors
    ]
    for (const entry of landed) {
      if (entry.deadline !== null) {
        clearTimeout(entry.deadline)
      }
      // Same guard as acceptSend: never erase edits typed after the send began.
      setDrafts((previous) =>
        (previous[entry.draftKey] ?? '').trim() === entry.text.trim()
          ? { ...previous, [entry.draftKey]: '' }
          : previous
      )
    }
  }, [messages, draftKey, pendingKey])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of unconfirmedRef.current) {
        if (entry.deadline !== null) {
          clearTimeout(entry.deadline)
        }
      }
      unconfirmedRef.current = []
    }
  }, [])

  const pending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  // Why: trigger only on a transcript change (like the unconfirmed-send hold), not
  // on `pending`. Reconciling survivors against the same window would let a second
  // effect run re-consume an echo already claimed by a bubble removed in the first.
  useEffect(() => {
    if (!pendingKey) {
      return
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? NO_PENDING_MESSAGES
      if (current.length === 0) {
        return previous
      }
      // Clear a bubble only when a NEW echo lands after its captured tail; paged-in
      // older identical turns (index <= tail) must not drop it — the real echo may
      // not have arrived yet. One echo is claimed per bubble (duplicate sends each
      // need their own). Same guard as the unconfirmed-send hold. Surviving bubbles
      // keep their baselines advanced past the consumed echoes so a later transcript
      // change can't re-consume one of them (cx2).
      const { landed, survivors } = reconcileLandedEchoes(messages, current)
      if (landed.length === 0) {
        return previous
      }
      if (survivors.length > 0) {
        return { ...previous, [pendingKey]: survivors }
      }
      const remaining = { ...previous }
      delete remaining[pendingKey]
      return remaining
    })
  }, [messages, pendingKey])

  return {
    composerText: draftKey ? (drafts[draftKey] ?? '') : '',
    setComposerText,
    pending,
    captureSendOrigin,
    acceptSend,
    holdUnconfirmedSend
  }
}
