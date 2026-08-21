import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'

export const DEGRADED_DAEMON_RECOVERY_RETRY_MS = 30_000

// Owns which target fresh (unmapped) PTYs spawn on while the daemon is degraded:
// the in-process fallback until a health re-probe proves the preserved daemon can
// spawn again, then the daemon itself (so new terminals regain persistence).
export class DegradedDaemonFreshSpawnRouter {
  private target: IPtyProvider
  private recovery: Promise<boolean> | null = null
  private retryAfterMs = 0

  constructor(
    private readonly current: IPtyProvider,
    private readonly fallback: IPtyProvider,
    private readonly sessionProviders: Map<string, IPtyProvider>,
    private readonly probeCurrent: (() => Promise<boolean>) | null
  ) {
    this.target = fallback
  }

  get routesToFallback(): true | undefined {
    return this.target === this.fallback ? true : undefined
  }

  supportsGitGuardHost(sessionId?: string): boolean {
    const provider = (sessionId ? this.sessionProviders.get(sessionId) : undefined) ?? this.target
    return provider.supportsGitCredentialGuardHost?.(sessionId) === true
  }

  canProvideSnapshot(sessionId: string): boolean {
    return (
      this.sessionProviders.get(sessionId)?.canProvideAuthoritativeBufferSnapshot?.(sessionId) ===
      true
    )
  }

  async recover(): Promise<boolean> {
    if (this.target === this.current) {
      return true
    }
    if (!this.probeCurrent || Date.now() < this.retryAfterMs) {
      return false
    }
    if (this.recovery) {
      return this.recovery
    }
    const recovery = this.probeCurrent()
      .catch(() => false)
      .then((healthy) => {
        if (healthy) {
          this.target = this.current
          console.info('[daemon] PTY spawn health recovered; fresh terminals are daemon-backed')
        } else {
          this.retryAfterMs = Date.now() + DEGRADED_DAEMON_RECOVERY_RETRY_MS
        }
        return healthy
      })
      .finally(() => {
        if (this.recovery === recovery) {
          this.recovery = null
        }
      })
    this.recovery = recovery
    return recovery
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const mapped = opts.sessionId ? this.sessionProviders.get(opts.sessionId) : undefined
    const target = mapped ?? this.target
    const result = await target.spawn(opts)
    // Skip mapping a spawn that already exited: onExit fired synchronously and cleared it.
    if (!result.exitedBeforeSpawnReply) {
      this.sessionProviders.set(result.id, target)
    }
    return result
  }
}
