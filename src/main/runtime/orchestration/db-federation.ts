import { OrchestrationWorkerDispatchStore } from './db-worker-dispatches'
import { paramsJson } from './orchestration-store-bridge'
import { exposeMessageTimestamps } from './db-message-timestamp'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import type {
  FederatedDispatchRow,
  FederationRelayDirection,
  FederationRelayItemRow,
  MessagePriority,
  MessageRow,
  MessageType,
  WorkerDispatchRow,
  WorkerReportOutcome
} from './types'

export class OrchestrationFederationStore extends OrchestrationWorkerDispatchStore {
  getFederatedDispatch(dispatchId: string): FederatedDispatchRow | undefined {
    return optRowFromJson<FederatedDispatchRow>(this.store.getFederatedDispatch(dispatchId))
  }

  listActiveFederatedDispatches(runId?: string): FederatedDispatchRow[] {
    return listFromJson<FederatedDispatchRow>(this.store.listActiveFederatedDispatches(runId))
  }

  updateFederatedDispatchResources(params: {
    dispatchId: string
    remoteRuntimeEpoch: string
    worktreeId: string
    terminalHandle: string
  }): FederatedDispatchRow {
    return rowFromJson<FederatedDispatchRow>(
      this.store.updateFederatedDispatchResources(paramsJson(params))
    )
  }

  reconcileFederatedWorkerStart(params: {
    dispatchId: string
    state: 'ready' | 'failed' | 'stopped' | 'start_unknown'
    stage: string
    lastError?: string | null
    worktreeId?: string | null
    terminalHandle?: string | null
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
  }): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(
      this.store.reconcileFederatedWorkerStart(paramsJson(params))
    )
  }

  reconcileFederatedWorkerStop(dispatchId: string): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(this.store.reconcileFederatedWorkerStop(dispatchId))
  }

  resumeFederatedWorkerForTerminalRelay(dispatchId: string): WorkerDispatchRow {
    return rowFromJson<WorkerDispatchRow>(
      this.store.resumeFederatedWorkerForTerminalRelay(dispatchId)
    )
  }

  setFederatedHomeImportSequence(dispatchId: string, sequence: number): void {
    this.store.setFederatedHomeImportSequence(dispatchId, sequence)
  }

  setRemoteWorkerImportSequence(dispatchId: string, sequence: number): void {
    this.store.setRemoteWorkerImportSequence(dispatchId, sequence)
  }

  // Why no id here: the store mints the `relay_<hex>` when `messageId` is absent,
  // matching the TS `params.messageId ?? generateId('relay')`.
  enqueueFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    kind: string
    payload: string
    messageId?: string
    settleRemoteOutcome?: WorkerReportOutcome
    remoteQuestion?: true
  }): FederationRelayItemRow {
    return rowFromJson<FederationRelayItemRow>(
      this.store.enqueueFederationRelay(paramsJson(params))
    )
  }

  listFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    afterSequence: number
    limit?: number
  }): FederationRelayItemRow[] {
    return listFromJson<FederationRelayItemRow>(this.store.listFederationRelay(paramsJson(params)))
  }

  listPendingFederationRelay(
    dispatchId: string,
    direction: FederationRelayDirection,
    limit = 50
  ): FederationRelayItemRow[] {
    return listFromJson<FederationRelayItemRow>(
      this.store.listPendingFederationRelay(dispatchId, direction, limit)
    )
  }

  acknowledgeFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    throughSequence: number
  }): void {
    this.store.acknowledgeFederationRelay(paramsJson(params))
  }

  importFederatedRelayItem(params: {
    dispatchId: string
    sequence: number
    message: {
      id: string
      runId: string
      from: string
      to: string
      subject: string
      body: string
      type: MessageType
      priority: MessagePriority
      threadId?: string
      payload?: string
    }
    lifecycle:
      | { kind: 'none' }
      | { kind: 'heartbeat'; at: string }
      | {
          kind: 'worker_report'
          taskId: string
          outcome: WorkerReportOutcome
          result: string
        }
      | { kind: 'rejected'; code: string; reason: string }
  }): { message: MessageRow; duplicate: boolean } {
    const imported = rowFromJson<{ message: MessageRow; duplicate: boolean }>(
      this.store.importFederatedRelayItem(paramsJson(params))
    )
    return { ...imported, message: exposeMessageTimestamps(imported.message) }
  }
}
