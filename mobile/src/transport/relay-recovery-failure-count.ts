// The consecutive relay recovery-dial failure streak, published to a reporter so
// a continuous outage projects into the logical client's reconnect attempt.
export class RelayRecoveryFailureCount {
  private count = 0
  private reporter: ((count: number) => void) | null = null

  constructor(private readonly stableConnectionMs: number) {}

  current(): number {
    return this.count
  }

  reportTo(reporter: (count: number) => void): void {
    this.reporter = reporter
    reporter(this.count)
  }

  record(resetFirst: boolean): number {
    this.update((resetFirst ? 0 : this.count) + 1)
    return this.count
  }

  // Why: elapsed time inside a slow failed dial is not recovery — only an
  // authenticated relay that survived the stability window resets the streak.
  recordAfterConnection(connectedAt: number | null, now: number): number {
    return this.record(connectedAt != null && now - connectedAt >= this.stableConnectionMs)
  }

  reset(): void {
    this.update(0)
  }

  private update(count: number): void {
    if (this.count === count) {
      return
    }
    this.count = count
    this.reporter?.(count)
  }
}
