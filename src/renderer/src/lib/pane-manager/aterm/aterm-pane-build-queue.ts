// Session restore opens many panes in one tick, and CONCURRENT engine builds
// contend (wasm compile + font parse + GL acquire) — stretching every pane's
// first frame toward the worker's 15s deadline (see aterm-worker-loader).
// Admit a few builds at a time so the first panes paint fast and the rest
// follow; queued panes are never blank (their container carries the theme
// background from createPaneDOM) and their facades keep buffering PTY output.
export const MAX_CONCURRENT_PANE_BUILDS = 2
// Safety valve: a wedged build (hung asset fetch) must not dam the queue for
// every later pane — a waiter self-admits past the limit after this long.
const PANE_BUILD_ADMIT_FALLBACK_MS = 20_000

/** What one pane learned about its own wait for a build slot. Exists to answer
 *  a single decision question: was the pane that painted the first frame among
 *  the first MAX_CONCURRENT_PANE_BUILDS admissions, and if not, how long did it
 *  wait? Visible-first admission is only worth building if that wait is real. */
export type AtermPaneBuildAdmission = {
  /** 0-based position in the order panes ASKED for a slot. */
  enqueueIndex: number
  /** 0-based position in the order panes GOT one. */
  admitIndex: number
  waitMs: number
  /** Granted without ever queueing — one of the first `limit` slots. */
  syncGrant: boolean
  /** Took the fallback past the limit because a build ahead of it wedged; it is
   *  a grant, but not one the limit authorized, so it must not read as normal. */
  selfAdmitted: boolean
}

/** An admission plus what became of the build it gated. */
export type AtermPaneBuildQueueTrace = AtermPaneBuildAdmission & {
  buildMs: number
  /** The pane was created under a suspended manager — it built while hidden. */
  suspendedAtBuild: boolean
  /** How many panes had asked for a slot by the time this one was admitted. */
  enqueuedAtAdmit: number
}

export type AtermPaneBuildQueue = {
  admit: () => Promise<AtermPaneBuildAdmission>
  release: () => void
  snapshot: () => { enqueued: number; admitted: number; inFlight: number; waiting: number }
}

/** FIFO admission gate for pane engine builds (factory exported for tests). */
export function createAtermPaneBuildQueue(limit: number): AtermPaneBuildQueue {
  let inFlight = 0
  let enqueued = 0
  let admitted = 0
  const waiting: (() => void)[] = []
  const grant = (
    enqueueIndex: number,
    askedAt: number,
    syncGrant: boolean,
    selfAdmitted: boolean
  ): AtermPaneBuildAdmission => ({
    enqueueIndex,
    admitIndex: admitted++,
    waitMs: Math.round(performance.now() - askedAt),
    syncGrant,
    selfAdmitted
  })
  return {
    admit: (): Promise<AtermPaneBuildAdmission> => {
      const enqueueIndex = enqueued++
      const askedAt = performance.now()
      if (inFlight < limit) {
        inFlight++
        return Promise.resolve(grant(enqueueIndex, askedAt, true, false))
      }
      return new Promise((resolve) => {
        const entry = (): void => {
          clearTimeout(fallback)
          resolve(grant(enqueueIndex, askedAt, false, false))
        }
        const fallback = setTimeout(() => {
          const index = waiting.indexOf(entry)
          if (index >= 0) {
            // Self-admit past the limit rather than wait on a wedged build; the
            // matching release() keeps the count consistent either way.
            waiting.splice(index, 1)
            inFlight++
            resolve(grant(enqueueIndex, askedAt, false, true))
          }
        }, PANE_BUILD_ADMIT_FALLBACK_MS)
        waiting.push(entry)
      })
    },
    release: (): void => {
      const next = waiting.shift()
      if (next) {
        // Hand the slot straight to the next queued build; inFlight unchanged.
        next()
        return
      }
      inFlight = Math.max(0, inFlight - 1)
    },
    snapshot: () => ({ enqueued, admitted, inFlight, waiting: waiting.length })
  }
}
