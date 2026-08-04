import { OrchestrationGateStore } from './db-decision-gates'
import { generateId } from './orchestration-store-bridge'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import type { DispatchContextRow } from './types'

export class OrchestrationDispatchContextStore extends OrchestrationGateStore {
  createDispatchContext(
    taskId: string,
    assigneeHandle: string,
    // Why: pane key is the remint-stable identity behind the handle — lets worker_done ownership survive handle reissue.
    assigneePaneKey?: string,
    launchTokenHash?: string
  ): DispatchContextRow {
    // The store throws the same guard-path messages the TS twin did
    // (`Task not found: …`, `… is <status>; only ready …`, `Terminal … already
    // has an active dispatch (… for task …)`) — consumers match on `.message`.
    const row = rowFromJson<DispatchContextRow>(
      this.store.createDispatchContext(
        taskId,
        assigneeHandle,
        generateId('ctx'),
        assigneePaneKey ?? null,
        launchTokenHash ?? null
      )
    )
    this.hasAnyDispatchContextsCache = true
    return row
  }

  getDispatchContext(taskId: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getDispatchContext(taskId))
  }

  getDispatchContextById(dispatchId: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getDispatchContextById(dispatchId))
  }

  getActiveDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getActiveDispatchForTerminal(handle))
  }

  getActiveDispatchForIdentity(handle: string, paneKey?: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(
      this.store.getActiveDispatchForIdentity(handle, paneKey)
    )
  }

  getLatestDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.getLatestDispatchForTerminal(handle))
  }

  /**
   * Cheap "are there any dispatch rows at all" probe. When false, no terminal
   * can have an active or recent-completed dispatch, so orchestration-context
   * builders can skip their per-terminal query fan-out entirely (#9694). Cached
   * after the first probe; createDispatchContext marks it true, resets clear it.
   */
  hasAnyDispatchContexts(): boolean {
    return (this.hasAnyDispatchContextsCache ??= this.store.hasAnyDispatchContexts())
  }

  completeDispatch(ctxId: string): void {
    this.store.completeDispatch(ctxId)
  }

  completeActiveDispatchForTask(taskId: string): void {
    this.store.completeActiveDispatchForTask(taskId)
  }

  failActiveDispatchForTask(taskId: string, error: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.failActiveDispatchForTask(taskId, error))
  }

  failDispatch(ctxId: string, error: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.failDispatch(ctxId, error))
  }

  // Why: only bump status='dispatched' — a zombie heartbeat from a finished dispatch would mask a hung retry from the stale detector (§5.3.4).
  recordHeartbeat(dispatchId: string, at: string): void {
    this.store.recordHeartbeat(dispatchId, at)
  }

  // Why: the Rust get_stale_dispatches carries the full #8452/#8514 fix
  // (status='dispatched' + dispatched_at grace + datetime()-wrapped comparison so
  // space-format columns and ISO-Z thresholds compare correctly).
  getStaleDispatches(thresholdIso: string): DispatchContextRow[] {
    return listFromJson<DispatchContextRow>(this.store.getStaleDispatches(thresholdIso))
  }

  // Backdate a dispatch's `dispatched_at` / `last_heartbeat_at` — the seam the
  // stale-dispatch tests use to reach into the grace window without sleeping.
  setDispatchTimestamps(
    dispatchId: string,
    dispatchedAt?: string | null,
    lastHeartbeatAt?: string | null
  ): void {
    this.store.setDispatchTimestamps(dispatchId, dispatchedAt ?? null, lastHeartbeatAt ?? null)
  }
}
