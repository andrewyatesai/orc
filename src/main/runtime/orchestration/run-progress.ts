import type { TaskRow } from './types'

/**
 * Split task counters for one coordinator run (design §8.3, app-modes §8.3).
 *
 * Why never a fraction: `checkConvergence` counts `failed` toward "all done", so
 * a single `8/8` would launder two failures into a success. Every terminal state
 * gets its own slot and the caller decides what is alarming.
 */
export type RunTaskCounters = {
  completed: number
  failed: number
  blocked: number
  dispatched: number
  /** `ready` and `pending` merged: both mean "not started", and which one it is
   *  is dependency bookkeeping a supervisor cannot act on. */
  readyOrPending: number
  total: number
}

/**
 * Why the rows must already be run-scoped: the reverted first attempt attached
 * one workspace-wide counter object to every row, so a run that finished last
 * week reported today's numbers. Pass `listTasks({ runId })` output, never the
 * unfiltered list.
 */
export function countRunTasks(tasks: readonly Pick<TaskRow, 'status'>[]): RunTaskCounters {
  const counters: RunTaskCounters = {
    completed: 0,
    failed: 0,
    blocked: 0,
    dispatched: 0,
    readyOrPending: 0,
    total: tasks.length
  }
  for (const task of tasks) {
    switch (task.status) {
      case 'completed':
        counters.completed += 1
        break
      case 'failed':
        counters.failed += 1
        break
      case 'blocked':
        counters.blocked += 1
        break
      case 'dispatched':
        counters.dispatched += 1
        break
      case 'ready':
      case 'pending':
        counters.readyOrPending += 1
        break
    }
  }
  return counters
}
