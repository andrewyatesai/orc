import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { reconcileLandedEchoes, type UnconfirmedSend } from './mobile-native-chat-draft-reconcile'
import { selectGluedPendingIds } from './mobile-native-chat-glued-pending'
import {
  imagePreviewBindings,
  mergeLandedImagePreviews
} from './mobile-native-chat-image-preview-echo'
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
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

// How long an ack-lost send waits for its transcript echo before the UI surfaces
// that delivery remains unconfirmed.
const UNCONFIRMED_SEND_DEADLINE_MS = 20_000

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
  /** Phone-local previews rebound to the authoritative turn that replaced the
   *  optimistic image bubble, keyed by that message id. */
  imagePreviewsByMessageId: Record<string, string[]>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  /** Clear the composer at send time, before the RPC settles. */
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  /** Put the text back after a definite rejection, unless newer edits exist. */
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
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
  // Keyed by pendingKey → { authoritative message id → local preview URIs }.
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
  >({})
  const pendingBySessionRef = useRef(pendingBySession)
  pendingBySessionRef.current = pendingBySession
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

  // Why: over relay the send RPC can take seconds (or lose only its ack), and a
  // composer that waits for settlement to empty reads as "my prompt didn't
  // send". Clear at send time; a definite rejection restores the text below.
  const clearDraftForSend = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    setDrafts((previous) =>
      (previous[origin.draftKey] ?? '').trim() === text.trim()
        ? { ...previous, [origin.draftKey]: '' }
        : previous
    )
  }, [])

  const restoreRejectedDraft = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    // Why: never clobber text the user typed while the rejection was in flight.
    setDrafts((previous) =>
      (previous[origin.draftKey] ?? '') === '' ? { ...previous, [origin.draftKey]: text } : previous
    )
  }, [])

  const acceptSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => {
      // Why: the first prompt can be sent before the provider reports a session
      // id; wait for an id before keying an optimistic echo.
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
  // failure (which baits a duplicate): stay quiet when the transcript echo
  // lands, and surface the uncertainty if the deadline passes without one.
  // The composer was already cleared at send time, so this never touches drafts.
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
  // Reads pending through a ref (never a dep) so a just-accepted bubble is seen
  // without re-arming the effect on the pending change it would itself cause.
  useEffect(() => {
    if (!pendingKey) {
      return
    }
    const current = pendingBySessionRef.current[pendingKey] ?? NO_PENDING_MESSAGES
    if (current.length === 0) {
      return
    }
    // Clear a bubble only when a NEW echo lands after its captured tail; paged-in
    // older identical turns (index <= tail) must not drop it — the real echo may
    // not have arrived yet. One echo is claimed per bubble (duplicate sends each
    // need their own). Same guard as the unconfirmed-send hold. Surviving bubbles
    // keep their baselines advanced past the consumed echoes so a later transcript
    // change can't re-consume one of them (cx2).
    const { landed, survivors, claimedMessageIdsByEntry } = reconcileLandedEchoes(messages, current)
    // Two fast sends can land as ONE glued transcript row that matches neither's
    // whole text, so the claim pass strands both. Retire such a run against the
    // ORIGINAL pending (not `survivors`) so a landed exact match between two
    // candidates still bars them from gluing across it.
    const landedIds = new Set(landed.map((entry) => entry.id))
    const glued = selectGluedPendingIds(messages, current, landedIds)
    if (landed.length === 0 && glued.size === 0) {
      return
    }
    // Hand each landed photo's local URIs to the authoritative turn its echo
    // claimed, so the phone-local image survives the optimistic-bubble teardown.
    const previewBindings = landed.flatMap((entry) =>
      imagePreviewBindings(entry, claimedMessageIdsByEntry.get(entry) ?? [])
    )
    if (previewBindings.length > 0) {
      setImagePreviewsBySession((previous) =>
        mergeLandedImagePreviews(previous, pendingKey, previewBindings)
      )
    }
    setPendingBySession((previous) => {
      const next = glued.size === 0 ? survivors : survivors.filter((item) => !glued.has(item.id))
      if (next.length > 0) {
        return { ...previous, [pendingKey]: next }
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
    imagePreviewsByMessageId: pendingKey
      ? (imagePreviewsBySession[pendingKey] ?? NO_IMAGE_PREVIEWS)
      : NO_IMAGE_PREVIEWS,
    captureSendOrigin,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  }
}
