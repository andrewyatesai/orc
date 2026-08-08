/**
 * ONE poll for the whole ALab console — `docs/reference/app-modes.md` §12.
 *
 * Deliberately shared rather than per-pane. The runtime caps concurrent long
 * polls (`LONG_POLL_CAP` 16, with `ask` sub-capped at 8) and refuses the excess
 * with `runtime_busy`. Six panes each polling on their own would compete with
 * the fleet's own workers for that budget — and BEHAVIOR RULE #1 forbids a
 * worker's only fallback when its question is refused. The console must never
 * be the reason a worker cannot ask.
 *
 * Visibility-gated for the same reason: a hidden ALab window polling at 2am is
 * spending budget nobody is reading.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Mirrors `orchestration.runList`'s row; see rpc/methods/orchestration-gates.ts. */
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

export type FleetPollState = {
  runs: FleetRun[]
  /** null until the first response; distinguishes "loading" from "no runs". */
  loadedAt: number | null
  error: string | null
  refresh: () => void
}

const POLL_INTERVAL_MS = 2_000

type RunListResponse = { runs: FleetRun[] }

export function useFleetOrchestrationPoll(): FleetPollState {
  const [runs, setRuns] = useState<FleetRun[]>([])
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const poll = useCallback(async (): Promise<void> => {
    // A slow runtime must not stack requests; skipping a tick is always safer
    // than queueing one, because the next tick carries the same information.
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    try {
      const response = await window.api.runtime.call({
        method: 'orchestration.runList',
        params: { limit: 50 }
      })
      if (!response.ok) {
        throw new Error(response.error?.message ?? 'orchestration.runList failed')
      }
      setRuns((response.result as RunListResponse | undefined)?.runs ?? [])
      setError(null)
      setLoadedAt(Date.now())
    } catch (err) {
      // Surfaced, never swallowed: a console that silently shows stale rows is
      // worse than one that says it lost contact.
      setError(err instanceof Error ? err.message : String(err))
      setLoadedAt(Date.now())
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null) {
        return
      }
      void poll()
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    }
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        start()
      } else {
        stop()
      }
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [poll])

  return { runs, loadedAt, error, refresh: () => void poll() }
}
