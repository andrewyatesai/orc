/**
 * Overlap a `git status` scan with the independent conflict-marker I/O so the two
 * reads run concurrently instead of one-after-the-other. A status poll pays for a
 * process/stream spawn plus a couple of `.git/*` file probes; serialized, the
 * probes stall the whole poll behind the spawn (or vice-versa). Kicking the status
 * scan off first and awaiting the marker I/O second hides one latency behind the
 * other (#13529).
 *
 * The non-obvious part is rejection ownership: the scan is started before the
 * caller awaits the conflict detector, so a fast scan failure would reject with no
 * handler attached yet — an unhandled rejection — if the settlement weren't
 * captured immediately. `Promise.allSettled` takes that ownership up front; the
 * returned thunk replays the original failure (or value) once the caller reaches
 * it, so each call site keeps its own fail-soft / abort handling around the scan.
 */
export function overlapStatusWithConflictDetection<T>(
  startStatus: () => Promise<T>
): () => Promise<T> {
  // Own the scan's rejection the instant it starts, before any conflict await.
  const settlement = Promise.allSettled([startStatus()])
  return async () => {
    const [result] = await settlement
    if (result.status === 'rejected') {
      throw result.reason
    }
    return result.value
  }
}
