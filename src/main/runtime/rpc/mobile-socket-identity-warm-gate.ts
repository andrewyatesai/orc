/**
 * Gates the first frame of a mobile socket on the desktop's E2EE secret.
 *
 * Two refusals live here and they are not interchangeable. "Nothing can ever decrypt this" is
 * close 4001, which the phone reads as *pairing revoked* — it spends its three-strike retry budget
 * in ~1.5s and latches auth-failed. "Not warm yet" is a wait, and saying 4001 to it turns every
 * restart of an already-paired desktop into a manual re-pair. The listener binds before the warm
 * lands (deliberately — discovery must not be hostage to the keychain), so that window is real.
 */
import type { WebSocket } from 'ws'

export type MobileSocketPayload = string | Uint8Array<ArrayBufferLike>

export type MobileSocketIdentityWarmResult =
  | { ok: true; serverSecretKey: Uint8Array }
  /** `retryable`: a sealed identity exists and may open on a later attempt, so do not say 4001. */
  | { ok: false; retryable: boolean }

const KEY_UNAVAILABLE_CLOSE_CODE = 4001
/** Not 4001, on purpose: 4002 is the code the E2EE channel already uses for "retry, don't re-pair". */
const KEY_RETRY_CLOSE_CODE = 4002
/** The pre-auth conversation is one hello; a peer must not buy unbounded memory during the warm. */
const MAX_FRAMES_AWAITING_WARM = 8

type WarmQueue = { frames: MobileSocketPayload[]; refused: boolean }

export type MobileSocketIdentityWarmOptions = {
  /**
   * Warm-only, and that is a security boundary: this runs on the FIRST inbound frame, before
   * E2EEChannel has validated any device token, on a listener bound to 0.0.0.0 with no
   * pre-upgrade auth. If an unauthenticated peer could make it reach the OS keychain, one byte
   * would wedge the runtime's main thread — and even a bounded child would be a spawn per frame.
   */
  getWarmServerSecretKey: () => Uint8Array | null
  /**
   * Awaits an attempt the DESKTOP owns — one already in flight, or its own cooldown-gated retry of
   * a transient failure. Returns null when nothing is coming, and never starts unbounded work, so
   * a peer can neither trigger the first keychain call nor raise the spawn rate.
   */
  awaitServerSecretKeyWarm?: () => Promise<MobileSocketIdentityWarmResult> | null
  /**
   * True while a sealed identity exists that a later attempt may still open. Consulted only when
   * there is no attempt to await — which is the common case, because the desktop's re-warm sits on
   * a cooldown between attempts. Refusing 4001 through that gap is what latches a paired phone.
   */
  isIdentityRetryable?: () => boolean
}

export class MobileSocketIdentityWarmGate {
  private readonly getWarmServerSecretKey: MobileSocketIdentityWarmOptions['getWarmServerSecretKey']
  private readonly awaitServerSecretKeyWarm: MobileSocketIdentityWarmOptions['awaitServerSecretKeyWarm']
  private readonly isIdentityRetryable: MobileSocketIdentityWarmOptions['isIdentityRetryable']
  private readonly framesAwaitingWarm = new Map<WebSocket, WarmQueue>()

  constructor(options: MobileSocketIdentityWarmOptions) {
    this.getWarmServerSecretKey = options.getWarmServerSecretKey
    this.awaitServerSecretKeyWarm = options.awaitServerSecretKeyWarm
    this.isIdentityRetryable = options.isIdentityRetryable
  }

  /**
   * The secret to open a channel with right now, or null when this frame needs nothing further from
   * the caller: it was refused, or queued behind an in-flight warm and will be replayed via `onWarm`
   * (in arrival order, so the handshake still sees hello first).
   */
  admit(
    ws: WebSocket,
    frame: MobileSocketPayload,
    onWarm: (serverSecretKey: Uint8Array, frames: readonly MobileSocketPayload[]) => void
  ): Uint8Array | null {
    const queue = this.framesAwaitingWarm.get(ws)
    if (queue) {
      if (queue.refused) {
        return null
      }
      if (queue.frames.length >= MAX_FRAMES_AWAITING_WARM) {
        // Refused once and remembered: a peer that ignores the close must not re-arm the queue.
        queue.refused = true
        queue.frames.length = 0
        ws.close(KEY_RETRY_CLOSE_CODE, 'e2ee_warm_backlog')
        return null
      }
      queue.frames.push(frame)
      return null
    }

    const warm = this.readWarmServerSecretKey()
    if (warm) {
      return warm
    }
    const attempt = this.awaitDesktopWarmAttempt()
    if (!attempt) {
      // Why: without the desktop secret no frame can be decrypted — fail closed rather than
      // accept an unauthenticated socket, and without touching the keychain to find out.
      // Which refusal matters: most connections land between re-warm attempts, and calling that
      // gap 4001 spends the phone's retry budget on a pairing that is perfectly valid.
      this.refuseUnwarmed(ws)
      return null
    }
    this.framesAwaitingWarm.set(ws, { frames: [frame], refused: false })
    void attempt.then(
      (result) => this.settle(ws, result, onWarm),
      // An unexplained failure is not evidence the pairing is gone, so it must not answer 4001.
      () => this.settle(ws, { ok: false, retryable: true }, onWarm)
    )
    return null
  }

  /** The socket is gone; drop its queue so a late warm resolves onto nothing. */
  forget(ws: WebSocket): void {
    this.framesAwaitingWarm.delete(ws)
  }

  private settle(
    ws: WebSocket,
    result: MobileSocketIdentityWarmResult,
    onWarm: (serverSecretKey: Uint8Array, frames: readonly MobileSocketPayload[]) => void
  ): void {
    const queue = this.framesAwaitingWarm.get(ws)
    if (!queue) {
      return
    }
    this.framesAwaitingWarm.delete(ws)
    if (queue.refused) {
      return
    }
    if (result.ok) {
      onWarm(result.serverSecretKey, queue.frames)
      return
    }
    console.error('[mobile] E2EE identity did not warm; refusing connection')
    closeUnwarmed(ws, result.retryable)
  }

  /** No attempt to join, so the standing of the stored identity decides which refusal is true. */
  private refuseUnwarmed(ws: WebSocket): void {
    let retryable = false
    try {
      retryable = this.isIdentityRetryable?.() === true
    } catch (error) {
      console.error('[mobile] E2EE identity standing lookup failed:', error)
    }
    console.error(
      retryable
        ? '[mobile] E2EE identity is sealed and not yet unsealed; asking the peer to retry'
        : '[mobile] E2EE identity is not warm; refusing connection'
    )
    closeUnwarmed(ws, retryable)
  }

  private readWarmServerSecretKey(): Uint8Array | null {
    try {
      return this.getWarmServerSecretKey()
    } catch (error) {
      console.error('[mobile] E2EE identity lookup failed; refusing connection:', error)
      return null
    }
  }

  private awaitDesktopWarmAttempt(): Promise<MobileSocketIdentityWarmResult> | null {
    try {
      return this.awaitServerSecretKeyWarm?.() ?? null
    } catch (error) {
      console.error('[mobile] E2EE identity warm lookup failed; refusing connection:', error)
      return null
    }
  }
}

function closeUnwarmed(ws: WebSocket, retryable: boolean): void {
  ws.close(
    retryable ? KEY_RETRY_CLOSE_CODE : KEY_UNAVAILABLE_CLOSE_CODE,
    retryable ? 'e2ee_key_unsealable' : 'e2ee_key_unavailable'
  )
}
