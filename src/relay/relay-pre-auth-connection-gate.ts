// Deadline and fd budget for peers that have reached the relay socket but have
// not yet proved they hold the secret.

import type { Socket } from 'node:net'
import { relayLogLine } from './relay-diagnostic-log'

// Why 10s: measured on a real unix socket with real client processes, the
// daemon-side window from `connection` to a resolved handshake is p50 0.5ms /
// max 1.4ms idle, and max 1.3ms with 24 spinners on 18 cores. No SSH round trip
// lives inside it — `--connect` reads its credential off stdin *before* it dials
// and the pane CLI reads its own from the environment — so this is a local
// scheduling budget, not a link budget. 10s is ~7000x the worst sample (room for
// a swapping remote) and matches CONNECT_AUTH_TIMEOUT_MS, the other pre-auth
// deadline on the same path.
export const PRE_AUTH_HANDSHAKE_TIMEOUT_MS = 10_000

// Why 64: real pre-auth concurrency is one reconnecting bridge plus per-pane
// `orca` invocations, each unauthenticated for ~1ms, so overlap is rare and 64 is
// far above any honest burst — while still capping what an anonymous peer can
// pin. Authenticated clients leave this count on handshake (relay-handshake.ts), so
// a host with many panes is not throttled by a control aimed at peers that proved
// nothing — and a burst that does reach the cap sheds silent peers, not the panes.
export const MAX_PRE_AUTH_CONNECTIONS = 64

// Why: a peer that makes the relay log once per connection can scroll the
// size-capped log clean of its own earlier tracks, so batch the noise and keep a
// running total instead.
const DROP_LOG_INTERVAL_MS = 5_000

/**
 * Bounds sockets that connected but never finished the handshake.
 *
 * Shedding is keyed on SILENCE, not age. Refusing the newest outright would let a
 * peer that fills the cap lock the host's own reconnect out for a whole deadline —
 * but shedding the longest-waiting is wrong too: under a legitimate burst, every
 * pane dialing at once after a reconnect, the oldest is simply first in line, and
 * killing it makes room for another correct handshake at the cost of one. A peer
 * that has sent no bytes is the shape a flood takes, so those go first.
 */
export class PreAuthConnectionGate {
  readonly limit: number
  readonly timeoutMs: number
  // Insertion-ordered: the first key is the longest-waiting unauthenticated peer.
  private readonly pending = new Map<Socket, NodeJS.Timeout>()
  // Pending peers that have sent at least one byte — mid-handshake, not a flood.
  private readonly spoke = new WeakSet<Socket>()
  private dropped = 0
  private lastDropLogAt = 0

  constructor(options: { limit?: number; timeoutMs?: number } = {}) {
    this.limit = options.limit ?? MAX_PRE_AUTH_CONNECTIONS
    this.timeoutMs = options.timeoutMs ?? PRE_AUTH_HANDSHAKE_TIMEOUT_MS
  }

  /** Marks `sock` as mid-handshake, so the cap sheds silent peers ahead of it. */
  noteSpoke(sock: Socket): void {
    this.spoke.add(sock)
  }

  /** The longest-waiting pending peer that has sent nothing, if any. */
  private oldestSilent(): Socket | undefined {
    for (const sock of this.pending.keys()) {
      if (!this.spoke.has(sock)) {
        return sock
      }
    }
    return undefined
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Sockets dropped for never authenticating — the trace a flood cannot scroll away. */
  get droppedCount(): number {
    return this.dropped
  }

  /** Arms the handshake deadline for `sock`, shedding SILENT pre-auth sockets over the cap. */
  track(sock: Socket): void {
    // Why silence and not age: under a legitimate burst — every pane dialing after a
    // reconnect — the longest-waiting socket is simply first in line, and shedding it
    // kills a correct handshake to make room for another. A peer that has sent no
    // bytes at all is the shape a flood takes, so shed those first, oldest among them.
    // With every pending peer mid-handshake there is nothing safe to shed, so the cap
    // refuses the NEWCOMER — it can retry; a shed peer is already in flight and cannot.
    while (this.pending.size >= this.limit) {
      const silent = this.oldestSilent()
      if (silent === undefined) {
        this.noteDropped(`at the ${this.limit}-connection cap with every peer mid-handshake`)
        sock.destroy()
        return
      }
      this.release(silent)
      this.noteDropped(`at the ${this.limit}-connection cap`)
      silent.destroy()
    }

    const deadline = setTimeout(() => {
      this.release(sock)
      this.noteDropped(`no handshake within ${this.timeoutMs}ms`)
      sock.destroy()
    }, this.timeoutMs)
    // Why: a pre-auth deadline is not a reason to hold a draining relay open.
    deadline.unref()
    this.pending.set(sock, deadline)
    // Why: a peer that hangs up early frees its slot now, not at the deadline.
    sock.once('close', () => this.release(sock))
  }

  private noteDropped(reason: string): void {
    this.dropped++
    const now = Date.now()
    if (now - this.lastDropLogAt < DROP_LOG_INTERVAL_MS) {
      return
    }
    this.lastDropLogAt = now
    relayLogLine(
      `[relay] Dropped ${this.dropped} unauthenticated socket(s) so far; latest: ${reason}`
    )
  }

  /** Drops `sock` from the pre-auth budget — it authenticated, closed, or was shed. */
  release(sock: Socket): void {
    const deadline = this.pending.get(sock)
    if (deadline === undefined) {
      return
    }
    clearTimeout(deadline)
    this.pending.delete(sock)
  }
}
