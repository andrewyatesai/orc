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

/** One pending gate, as the queue needs it: keyed by TASK, not by run. */
export type FleetGate = {
  id: string
  task_id: string | null
  run_id: string | null
  question: string | null
  status: string
  created_at: string | null
}

export type FleetSnapshot = {
  runs: FleetRun[]
  gates: FleetGate[]
  /** null until the first SUCCESSFUL response. An error must never present as
   *  "loaded and empty", which reads as "all clear". */
  loadedAt: number | null
  error: string | null
}

const POLL_INTERVAL_MS = 2_000

let snapshot: FleetSnapshot = { runs: [], gates: [], loadedAt: null, error: null }
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
    // Gates come from gateList, not from runList's per-run COUNT: the queue is
    // one row per TASK, and a count cannot be decomposed back into tasks.
    const [runList, gateList] = await Promise.all([
      callRuntime<{ runs: FleetRun[] }>('orchestration.runList', { limit: 50 }),
      callRuntime<{ gates: FleetGate[] }>('orchestration.gateList', { status: 'pending' })
    ])
    emit({
      runs: runList?.runs ?? [],
      gates: gateList?.gates ?? [],
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
  snapshot = { runs: [], gates: [], loadedAt: null, error: null }
}
