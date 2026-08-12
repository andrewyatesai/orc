/**
 * Deduplicates `getForegroundProcess` round-trips per PTY so the exit-confirmation
 * and foreground-agent refresh paths share one in-flight read. A read started
 * before a given title observation is never reused to reason about a title that
 * arrived after it — a stale read could still name the agent that just left.
 */

export type ForegroundProcessReader = {
  getForegroundProcess(ptyId: string): Promise<string | null> | string | null
}

export type PtyForegroundProcessRead<C extends ForegroundProcessReader> = {
  controller: C
  process: string | null
  available: boolean
}

type PtyForegroundProcessReadEntry<C extends ForegroundProcessReader> = {
  controller: C
  startedAfterTitleObservation: number
  promise: Promise<PtyForegroundProcessRead<C>>
}

export type PtyForegroundProcessReadCache<C extends ForegroundProcessReader> = {
  /**
   * Returns a shared read whose start post-dates `afterTitleObservation`, or null
   * when no controller is supplied. A pending read that predates the observation is
   * awaited first, then a fresh read is chained so the caller never trusts stale
   * foreground evidence.
   */
  read: (
    ptyId: string,
    controller: C | null,
    afterTitleObservation?: number
  ) => Promise<PtyForegroundProcessRead<C>> | null
  /** Count of in-flight reads; drains to 0 once every read settles. */
  readonly size: number
}

export function createPtyForegroundProcessReadCache<
  C extends ForegroundProcessReader
>(): PtyForegroundProcessReadCache<C> {
  const reads = new Map<string, PtyForegroundProcessReadEntry<C>>()

  function read(
    ptyId: string,
    controller: C | null,
    afterTitleObservation = 0
  ): Promise<PtyForegroundProcessRead<C>> | null {
    if (!controller) {
      return null
    }
    const unavailable: PtyForegroundProcessRead<C> = {
      controller,
      process: null,
      available: false
    }
    const pending = reads.get(ptyId)
    if (
      pending?.controller === controller &&
      pending.startedAfterTitleObservation >= afterTitleObservation
    ) {
      return pending.promise
    }
    if (pending?.controller === controller) {
      // Why: the in-flight read predates this title observation, so chain a fresh
      // read after it settles rather than trusting foreground evidence from before.
      return pending.promise.then(() => read(ptyId, controller, afterTitleObservation) ?? unavailable)
    }
    let processRead: Promise<string | null>
    try {
      processRead = Promise.resolve(controller.getForegroundProcess(ptyId))
    } catch {
      // Why: a synchronous throw means the probe is unavailable, not that the
      // agent is present; record the miss so a concurrent caller reuses it.
      const failed: PtyForegroundProcessReadEntry<C> = {
        controller,
        startedAfterTitleObservation: afterTitleObservation,
        promise: Promise.resolve(unavailable)
      }
      failed.promise = failed.promise.finally(() => {
        if (reads.get(ptyId) === failed) {
          reads.delete(ptyId)
        }
      })
      reads.set(ptyId, failed)
      return failed.promise
    }
    let entry: PtyForegroundProcessReadEntry<C>
    const promise = processRead
      .then(
        (process): PtyForegroundProcessRead<C> => ({ controller, process, available: true })
      )
      .catch(() => unavailable)
      .finally(() => {
        if (reads.get(ptyId) === entry) {
          reads.delete(ptyId)
        }
      })
    entry = {
      controller,
      startedAfterTitleObservation: afterTitleObservation,
      promise
    }
    reads.set(ptyId, entry)
    return entry.promise
  }

  return {
    read,
    get size(): number {
      return reads.size
    }
  }
}
