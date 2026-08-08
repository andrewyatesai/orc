/**
 * ONE poll for the whole ALab console — `docs/reference/app-modes.md` §12.
 *
 * **A module singleton, not a per-component hook.** The first version of this
 * file claimed to be "one shared poll" while being an ordinary hook: three
 * consumers meant three intervals, three `inFlight` guards that only deduped
 * within themselves, and three `orchestration.runList` calls every two seconds.
 * The comment was the only thing that was shared.
 *
 * That matters beyond waste. The runtime caps concurrent long polls
 * (`LONG_POLL_CAP` 16, `ask` sub-capped at 8) and refuses the excess with
 * `runtime_busy`. A console competing with the fleet's own workers for that
 * budget can be the reason a worker's question is refused — and BEHAVIOR RULE #1
 * forbids that worker's only fallback.
 *
 * Independent pollers also let panels disagree: MissionStrip could show live
 * missions while FleetBoard, whose own request had failed, said "no agents are
 * running". One store means one truth and one error.
 */

import { useSyncExternalStore } from 'react'

export type FleetRunTaskCounters = {
  completed: number
  failed: number
  blocked: number
  dispatched: number
  readyOrPending: number
  total: number
}

export type FleetRun = {
  id: string
  coordinator_handle: string | null
  status: string
  spec: string | null
  created_at: string | null
  /** The in-memory registry is the only witness that a durable `running` row
   *  still has a loop behind it — a restart leaves rows that say otherwise. */
  live: boolean
  tasks: FleetRunTaskCounters
  pendingGates: number
}

/** One §8.3 exception, already classified and task-keyed by the runtime. */
export type FleetException = {
  taskId: string
  kind: string
  summary: string
  workerHandle: string | null
  attempts: number
  at: string
}

export type FleetDispatch = {
  id: string
  task_id: string
  assignee_handle: string | null
  status: string
  failure_count: number
  last_failure: string | null
  last_heartbeat_at: string | null
  dispatched_at: string | null
}

export type FleetTask = {
  id: string
  task_title: string | null
  display_name: string | null
  spec: string
  status: string
  result: string | null
  run_id: string | null
}

export type FleetReconciliation = {
  taskId: string
  verdict: string
  summary: string
}

export type FleetSnapshot = {
  runs: FleetRun[]
  exceptions: FleetException[]
  dispatches: FleetDispatch[]
  tasks: FleetTask[]
  reconciliations: FleetReconciliation[]
  /** null until the first SUCCESSFUL response. An error must never present as
   *  "loaded and empty", which reads as "all clear". */
  loadedAt: number | null
  error: string | null
}

const POLL_INTERVAL_MS = 2_000

let snapshot: FleetSnapshot = {
  runs: [],
  exceptions: [],
  dispatches: [],
  tasks: [],
  reconciliations: [],
  loadedAt: null,
  error: null
}
const subscribers = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false
let visibilityBound = false

function emit(next: FleetSnapshot): void {
  snapshot = next
  for (const notify of subscribers) {
    notify()
  }
}

async function callRuntime<T>(method: string, params: unknown): Promise<T> {
  const response = await window.api.runtime.call({ method, params })
  if (!response.ok) {
    throw new Error(response.error?.message ?? `${method} failed`)
  }
  return response.result as T
}

async function poll(): Promise<void> {
  if (inFlight) {
    return
  }
  inFlight = true
  try {
    // ONE call. The six exception sources are classified server-side, where the
    // rows actually live — six renderer queries per tick would multiply the
    // console's share of a long-poll budget the fleet's own workers need, and
    // would let the panels render six snapshots taken at six different instants.
    const result = await callRuntime<{
      runs: FleetRun[]
      exceptions: FleetException[]
      dispatches: FleetDispatch[]
      tasks: FleetTask[]
      reconciliations: FleetReconciliation[]
    }>('alab.consoleSnapshot', { limit: 50 })
    emit({
      runs: result?.runs ?? [],
      exceptions: result?.exceptions ?? [],
      dispatches: result?.dispatches ?? [],
      tasks: result?.tasks ?? [],
      reconciliations: result?.reconciliations ?? [],
      loadedAt: Date.now(),
      error: null
    })
  } catch (err) {
    // loadedAt is NOT advanced: a failed poll must not let a panel render its
    // reassuring empty state.
    emit({
      ...snapshot,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    inFlight = false
  }
}

function start(): void {
  if (timer !== null) {
    return
  }
  void poll()
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function syncToVisibility(): void {
  // A hidden ALab window polling at 2am spends budget nobody is reading.
  if (subscribers.size > 0 && document.visibilityState === 'visible') {
    start()
  } else {
    stop()
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  if (!visibilityBound) {
    document.addEventListener('visibilitychange', syncToVisibility)
    visibilityBound = true
  }
  syncToVisibility()
  return () => {
    subscribers.delete(notify)
    syncToVisibility()
  }
}

/** Every ALab panel reads the same snapshot, so they can never disagree. */
export function useFleetSnapshot(): FleetSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  )
}

/** Test seam: reset module state between cases. */
export function __resetFleetPollForTests(): void {
  stop()
  subscribers.clear()
  inFlight = false
  snapshot = {
    runs: [],
    exceptions: [],
    dispatches: [],
    tasks: [],
    reconciliations: [],
    loadedAt: null,
    error: null
  }
}
