import type { CoordinatorRun, OrchestrationDb } from './db'

/**
 * Fail every durably-`running` coordinator row at process start.
 *
 * Why: the live-coordinator registry is an in-memory Map, so a crash, quit or update
 * leaves rows marked `running` with no loop behind them. They were reaped only lazily —
 * on the next `run` or `run-stop` for the same handle — so a fleet view would report a
 * mission as running indefinitely after any restart. That is a lie the supervisor acts on.
 *
 * Safe to call unconditionally at first-DB-open: no coordinator can be live in a process
 * that has not finished starting, so every active row is by definition stranded.
 */
export function failStrandedCoordinatorRuns(db: OrchestrationDb): CoordinatorRun[] {
  let stranded: CoordinatorRun[]
  try {
    stranded = db.getActiveCoordinatorRuns()
  } catch (err) {
    // Why swallow: this runs during lazy DB construction. A reap failure must not take
    // down orchestration entirely — the stale rows stay, which is today's behavior.
    console.warn('[orchestration] could not scan for stranded coordinator runs:', err)
    return []
  }
  const failed: CoordinatorRun[] = []
  for (const run of stranded) {
    try {
      db.updateCoordinatorRun(run.id, 'failed')
      failed.push(run)
    } catch (err) {
      console.warn(`[orchestration] could not fail stranded coordinator run ${run.id}:`, err)
    }
  }
  if (failed.length > 0) {
    console.warn(
      `[orchestration] failed ${failed.length} coordinator run(s) stranded by a restart: ${failed
        .map((run) => `${run.id}:${run.coordinator_handle}`)
        .join(', ')}`
    )
  }
  return failed
}
