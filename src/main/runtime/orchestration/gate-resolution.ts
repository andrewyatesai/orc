import type { RustOrchestrationStoreHandle } from '../../daemon/rust-git-addon'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import type { DecisionGateRow, DispatchContextRow, GateResolutionOutcome } from './types'

/**
 * The transactional gate surface schema v9 made possible (design §6.2) — CAS
 * resolution plus the `waiting_gate` dispatch parking it depends on.
 *
 * Kept separate from `OrchestrationDb.resolveGate`, which stays exactly what it
 * was: last-writer-wins, with the dispatch already completed. Callers opt into
 * the CAS path; nothing changes underneath the ones that have not.
 */
export class GatePolicyStore {
  constructor(private store: RustOrchestrationStoreHandle) {}

  /**
   * Resolve a gate only if it is still `pending` AND its version matches.
   * Resuming the parked dispatch (rather than requeueing the task) is what stops
   * resolution from redispatching work whose original worker is still holding it.
   *
   * `resolvedAt` is minted here so the stamp stays a JS ISO string like every
   * other completion timestamp this shim owns.
   */
  resolvePending(
    gateId: string,
    expectedVersion: number,
    resolution: string,
    resolvedBy: string,
    resolutionReason?: string
  ): GateResolutionOutcome {
    return rowFromJson<GateResolutionOutcome>(
      this.store.resolvePendingGate(
        gateId,
        expectedVersion,
        resolution,
        resolvedBy,
        resolutionReason ?? null,
        new Date().toISOString()
      )
    )
  }

  /** Park the task's active dispatch on its gate. `undefined` when the task had
   *  no active dispatch to park. */
  parkDispatch(taskId: string): DispatchContextRow | undefined {
    return optRowFromJson<DispatchContextRow>(this.store.parkDispatchWaitingGate(taskId))
  }

  /** Every dispatch parked on a gate — a restarted supervisor's reconciliation
   *  input: a lease held with no live gate behind it is a stranded worker. */
  listParked(): DispatchContextRow[] {
    return listFromJson<DispatchContextRow>(this.store.listDispatchesWaitingGate())
  }

  /** The task's pending gate — how a CAS caller reads the `version` to present.
   *  The one-pending-gate partial unique index is what makes "the" exact. */
  pendingForTask(taskId: string): DecisionGateRow | undefined {
    return optRowFromJson<DecisionGateRow>(this.store.getPendingGateForTask(taskId))
  }
}
