import { parseAppSshPtyId } from '../../shared/ssh-pty-id'

/** Minimal live-PTY routing facts the never-attached predicate consults. */
type LocalPtyRouting = { connectionId: string | null; connected: boolean }

export type SubscriberDrivenDaemonAttachDeps = {
  /** The pty controller's attach, or undefined when no controller/attach is wired. */
  getAttach: () => ((ptyId: string) => Promise<boolean>) | undefined
  /** True once the session has ingested a byte (a headless emulator exists). */
  hasHeadlessState: (ptyId: string) => boolean
  /** True while a provider snapshot reconcile is in flight — a spawn-path attach already ran. */
  isProviderSnapshotPreferred: (ptyId: string) => boolean
  /** True while a spawn registration is pending for this id this generation. */
  isRegistrationPending: (ptyId: string) => boolean
  /** Routing facts for a known PTY, or undefined when the id is unknown. */
  getLocalPtyRouting: (ptyId: string) => LocalPtyRouting | undefined
}

/**
 * Attaches never-activated local daemon sessions so their output streams to
 * main. The daemon only emits data for sessions this app has attached, so a
 * daemon-backed terminal whose tab was never opened in the host UI renders
 * blank on paired clients and reads empty while the PTY is alive. The first
 * remote view subscriber of such a session drives a main-side attach here, and
 * the read path consults the same predicate for its provider-tail fallback.
 */
export class SubscriberDrivenDaemonAttach {
  // Sticky per-PTY attach promise: dedupes concurrent first-subscribes, keeps
  // later subscribes no-ops, cleared per lifecycle generation and on failure.
  private attachesByPtyId = new Map<string, Promise<boolean>>()
  // Sessions a local spawn already published this generation: their provider
  // stream is already attached, so they are neither subscriber-attached nor
  // read-fallback eligible (a replacement under a reused id starts clean).
  private spawnPublishedPtys = new Set<string>()

  constructor(private readonly deps: SubscriberDrivenDaemonAttachDeps) {}

  markSpawnPublished(ptyId: string): void {
    this.spawnPublishedPtys.add(ptyId)
  }

  /** Clear per-generation state so a respawn under the same id re-attaches. */
  forgetGeneration(ptyId: string): void {
    this.attachesByPtyId.delete(ptyId)
    this.spawnPublishedPtys.delete(ptyId)
  }

  /** A live local daemon session main knows about but has never ingested a byte
   *  from — no pane ever attached it, so the daemon is not emitting. */
  isKnownUnattachedLocalDaemonPty(ptyId: string): boolean {
    if (this.deps.hasHeadlessState(ptyId) || this.deps.isProviderSnapshotPreferred(ptyId)) {
      return false
    }
    // A spawn published (or admission pending) this generation already attaches
    // the provider stream; a replacement under a reused id must not read as the
    // discovered never-attached session it replaced.
    if (this.spawnPublishedPtys.has(ptyId) || this.deps.isRegistrationPending(ptyId)) {
      return false
    }
    // SSH panes have their own lease/reattach machinery.
    if (parseAppSshPtyId(ptyId)) {
      return false
    }
    const routing = this.deps.getLocalPtyRouting(ptyId)
    return routing !== undefined && routing.connectionId === null && routing.connected
  }

  /** First remote view subscriber of a never-attached local daemon session:
   *  attach so output starts flowing. Attach-only, no resize/mount/focus,
   *  headless-safe, deduped; a failed attempt is dropped so a later subscriber
   *  retries once a daemon adapter can prove the session. */
  ensureAttach(ptyId: string): void {
    const attach = this.deps.getAttach()
    if (!attach || this.attachesByPtyId.has(ptyId) || !this.isKnownUnattachedLocalDaemonPty(ptyId)) {
      return
    }
    // Async wrapper: a synchronous controller throw must not break subscribe.
    const attempt = (async () => attach(ptyId))().catch(() => false)
    this.attachesByPtyId.set(ptyId, attempt)
    void attempt.then((attached) => {
      // An unprovable session must not be pinned as attached.
      if (!attached && this.attachesByPtyId.get(ptyId) === attempt) {
        this.attachesByPtyId.delete(ptyId)
      }
    })
  }
}
