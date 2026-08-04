import { OrchestrationDispatchCapabilityStore } from './db-dispatch-capabilities'
import { generateId, paramsJson } from './orchestration-store-bridge'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import type {
  DispatchContextRow,
  LegacyWorkerTerminalRecoveryRow,
  WorkerDispatchRow,
  WorkerDispatchState,
  WorkerReportOutcome,
  WorkerReportSettlement
} from './types'

// A positional `unknown[]` crosses napi as a JSON-array string; `undefined`
// means "leave the recorded effects alone", which is not the same as `[]`.
function effectsJson(effects?: unknown[]): string | undefined {
  return effects ? JSON.stringify(effects) : undefined
}

export class OrchestrationWorkerDispatchStore extends OrchestrationDispatchCapabilityStore {
  createStartingWorkerDispatch(params: {
    taskId: string
    startOptions: unknown
    launchTokenHash?: string
    retryOf?: string
    runtimeEpoch?: string
    federation?: {
      environmentId: string
      environmentName: string
      peerFingerprint: string
      protocolVersion: number
    }
    mutationReceipt?: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }): { dispatch: DispatchContextRow; worker: WorkerDispatchRow } {
    return rowFromJson<{ dispatch: DispatchContextRow; worker: WorkerDispatchRow }>(
      this.store.createStartingWorkerDispatch(
        paramsJson({
          ...params,
          dispatchId: generateId('ctx'),
          // The column holds the already-serialized options, as the TS twin wrote them.
          startOptions: JSON.stringify(params.startOptions)
        })
      )
    )
  }

  recordWorkerStage(params: {
    dispatchId: string
    stage: string
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
    state?: WorkerDispatchState
  }): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(this.store.recordWorkerStage(paramsJson(params)))
  }

  updateWorkerSetupEvidence(params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }): { worker: WorkerDispatchRow; changed: boolean } {
    return rowFromJson<{ worker: WorkerDispatchRow; changed: boolean }>(
      this.store.updateWorkerSetupEvidence(paramsJson(params))
    )
  }

  /** Returns the freshly minted `dcap_` plaintext — hand it to the launcher once. */
  prepareStartingWorkerAuthority(params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    launchTokenHash?: string
    worktreeId: string
    effects: unknown[]
    setupState: string
  }): string {
    return this.store.prepareStartingWorkerAuthority(paramsJson(params))
  }

  markWorkerDispatchReady(dispatchId: string, effects?: unknown[]): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(
      this.store.markWorkerDispatchReady(dispatchId, effectsJson(effects))
    )
  }

  failWorkerStart(dispatchId: string, stage: string, reason: string): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(this.store.failWorkerStart(dispatchId, stage, reason))
  }

  markWorkerStartUnknown(dispatchId: string, stage: string, reason: string): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(
      this.store.markWorkerStartUnknown(dispatchId, stage, reason)
    )
  }

  getWorkerDispatch(dispatchId: string): WorkerDispatchRow | undefined {
    return optRowFromJson<WorkerDispatchRow>(this.store.getWorkerDispatch(dispatchId))
  }

  listLegacyWorkerTerminalRecoveryRows(): LegacyWorkerTerminalRecoveryRow[] {
    return listFromJson<LegacyWorkerTerminalRecoveryRow>(
      this.store.listLegacyWorkerTerminalRecoveryRows()
    )
  }

  reconcileMissingWorkerTerminal(dispatchId: string, reason: string): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(
      this.store.reconcileMissingWorkerTerminal(dispatchId, reason)
    )
  }

  beginWorkerStop(dispatchId: string):
    | { disposition: 'stopping'; worker: WorkerDispatchRow; dispatch: DispatchContextRow }
    | {
        disposition: 'already_settled'
        worker: WorkerDispatchRow
        dispatch: DispatchContextRow
      } {
    return rowFromJson<
      | { disposition: 'stopping'; worker: WorkerDispatchRow; dispatch: DispatchContextRow }
      | {
          disposition: 'already_settled'
          worker: WorkerDispatchRow
          dispatch: DispatchContextRow
        }
    >(this.store.beginWorkerStop(dispatchId))
  }

  settleWorkerStop(dispatchId: string): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(this.store.settleWorkerStop(dispatchId))
  }

  // Deliberate divergence from the deleted TS twin: an unknown dispatch id raises
  // the coded `dispatch_not_found` error instead of returning `undefined`, which
  // every caller then dereferenced. Let it propagate.
  markWorkerStopUnknown(dispatchId: string, reason: string): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(this.store.markWorkerStopUnknown(dispatchId, reason))
  }

  abandonWorkerDispatch(dispatchId: string): {
    disposition: 'abandoned' | 'already_abandoned' | 'stale'
    worker: WorkerDispatchRow
  } {
    return rowFromJson<{
      disposition: 'abandoned' | 'already_abandoned' | 'stale'
      worker: WorkerDispatchRow
    }>(this.store.abandonWorkerDispatch(dispatchId))
  }

  settleWorkerReport(params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }): WorkerReportSettlement {
    return rowFromJson<WorkerReportSettlement>(this.store.settleWorkerReport(paramsJson(params)))
  }
}
