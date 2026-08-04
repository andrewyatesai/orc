import { OrchestrationFederationStore } from './db-federation'
import { paramsJson } from './orchestration-store-bridge'
import { optRowFromJson, rowFromJson } from './db-row-json'
import type { RemoteDispatchAttachmentRow, WorkerDispatchState } from './types'

// A positional `unknown[]` crosses napi as a JSON-array string; `undefined`
// means "leave the recorded effects alone", which is not the same as `[]`.
function effectsJson(effects?: unknown[]): string | undefined {
  return effects ? JSON.stringify(effects) : undefined
}

export class OrchestrationRemoteAttachmentStore extends OrchestrationFederationStore {
  createRemoteDispatchAttachment(params: {
    dispatchId: string
    taskId: string
    homePeerFingerprint: string
    protocolVersion: number
    runtimeEpoch: string
    mutationReceipt: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }): RemoteDispatchAttachmentRow {
    return rowFromJson<RemoteDispatchAttachmentRow>(
      this.store.createRemoteDispatchAttachment(paramsJson(params))
    )
  }

  getRemoteDispatchAttachment(dispatchId: string): RemoteDispatchAttachmentRow | undefined {
    return optRowFromJson<RemoteDispatchAttachmentRow>(
      this.store.getRemoteDispatchAttachment(dispatchId)
    )
  }

  findActiveRemoteAttachmentForPane(paneKey: string): RemoteDispatchAttachmentRow | undefined {
    return optRowFromJson<RemoteDispatchAttachmentRow>(
      this.store.findActiveRemoteAttachmentForPane(paneKey)
    )
  }

  recordRemoteAttachmentStage(params: {
    dispatchId: string
    stage: string
    state?: WorkerDispatchState
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
  }): RemoteDispatchAttachmentRow {
    return rowFromJson<RemoteDispatchAttachmentRow>(
      this.store.recordRemoteAttachmentStage(paramsJson(params))
    )
  }

  updateRemoteAttachmentSetupEvidence(params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }): { attachment: RemoteDispatchAttachmentRow; changed: boolean } {
    return rowFromJson<{ attachment: RemoteDispatchAttachmentRow; changed: boolean }>(
      this.store.updateRemoteAttachmentSetupEvidence(paramsJson(params))
    )
  }

  /** Returns the freshly minted `dcap_` plaintext — the store persists only its hash. */
  prepareRemoteAttachmentAuthority(params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
    terminalHandle: string
    setupState: string
    effects: unknown[]
  }): string {
    return this.store.prepareRemoteAttachmentAuthority(paramsJson(params))
  }

  markRemoteAttachmentReady(dispatchId: string, effects?: unknown[]): RemoteDispatchAttachmentRow {
    return rowFromJson<RemoteDispatchAttachmentRow>(
      this.store.markRemoteAttachmentReady(dispatchId, effectsJson(effects))
    )
  }

  failRemoteAttachment(
    dispatchId: string,
    stage: string,
    reason: string,
    unknown: boolean
  ): RemoteDispatchAttachmentRow {
    return rowFromJson<RemoteDispatchAttachmentRow>(
      this.store.failRemoteAttachment(dispatchId, stage, reason, unknown)
    )
  }

  verifyRemoteAttachmentAuthority(params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    return this.store.verifyRemoteAttachmentAuthority(paramsJson(params))
  }

  isRemoteAttachmentProcessCurrent(params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    return this.store.isRemoteAttachmentProcessCurrent(paramsJson(params))
  }

  beginRemoteAttachmentStop(dispatchId: string): RemoteDispatchAttachmentRow {
    return rowFromJson<RemoteDispatchAttachmentRow>(
      this.store.beginRemoteAttachmentStop(dispatchId)
    )
  }

  settleRemoteAttachmentStop(dispatchId: string): RemoteDispatchAttachmentRow {
    return rowFromJson<RemoteDispatchAttachmentRow>(
      this.store.settleRemoteAttachmentStop(dispatchId)
    )
  }

  markRemoteAttachmentStopUnknown(dispatchId: string, reason: string): RemoteDispatchAttachmentRow {
    return rowFromJson<RemoteDispatchAttachmentRow>(
      this.store.markRemoteAttachmentStopUnknown(dispatchId, reason)
    )
  }
}
