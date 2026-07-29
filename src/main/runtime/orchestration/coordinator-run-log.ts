/**
 * Bounded per-run capture of the coordinator's diagnostic stream.
 *
 * Why this exists: `Coordinator`'s `onLog` defaulted to a no-op and the only production
 * construction site passed none, so the 10-minute stale-heartbeat warning — the codebase's
 * only hang detector — plus circuit-breaker retries, terminal-creation failures (which are
 * followed by a bare `return`, so a mission can stall silently forever), lifecycle
 * rejections and "Stuck: N tasks blocked" were all generated and discarded.
 *
 * Bounded because a long mission emits steadily and this is a diagnostic tail, not an
 * audit log: the durable record is the DB.
 */
export const COORDINATOR_RUN_LOG_LIMIT = 500

export type CoordinatorRunLogEntry = {
  /** Milliseconds since epoch, supplied by the caller so this module stays deterministic. */
  at: number
  message: string
}

export class CoordinatorRunLog {
  private readonly entries: CoordinatorRunLogEntry[] = []
  private droppedCount = 0

  constructor(private readonly limit: number = COORDINATOR_RUN_LOG_LIMIT) {}

  append(message: string, at: number): void {
    this.entries.push({ at, message })
    if (this.entries.length > this.limit) {
      // Why count drops: a truncated tail that silently loses its head reads as "nothing
      // happened before this", which is exactly the wrong impression while debugging a hang.
      this.droppedCount += this.entries.length - this.limit
      this.entries.splice(0, this.entries.length - this.limit)
    }
  }

  /** Oldest-first, newest last — the order a human reads a log in. */
  list(): CoordinatorRunLogEntry[] {
    return [...this.entries]
  }

  get dropped(): number {
    return this.droppedCount
  }

  get size(): number {
    return this.entries.length
  }
}

/** Run-id-keyed registry. Cleared when a run's coordinator is discarded. */
export class CoordinatorRunLogRegistry {
  private readonly logs = new Map<string, CoordinatorRunLog>()

  forRun(runId: string): CoordinatorRunLog {
    const existing = this.logs.get(runId)
    if (existing) {
      return existing
    }
    const created = new CoordinatorRunLog()
    this.logs.set(runId, created)
    return created
  }

  peek(runId: string): CoordinatorRunLog | undefined {
    return this.logs.get(runId)
  }

  delete(runId: string): void {
    this.logs.delete(runId)
  }
}
