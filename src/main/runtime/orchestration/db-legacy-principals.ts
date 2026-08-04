import { OrchestrationMutationReceiptStore } from './db-mutation-receipts'
import { generateId, paramsJson } from './orchestration-store-bridge'
import { optionalMessageRowFromJson } from './db-message-timestamp'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import type {
  DispatchContextRow,
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow,
  MessageRow
} from './types'

export class OrchestrationLegacyPrincipalStore extends OrchestrationMutationReceiptStore {
  getLegacyAdoption(): LegacyAdoptionRow | undefined {
    return optRowFromJson<LegacyAdoptionRow>(this.store.getLegacyAdoption())
  }

  commitLegacyCompatibilityPrincipal(params: {
    runId: string
    dispatchId?: string
    role: LegacyPrincipalRole
    hostScope: string
    terminalHandle: string
    paneKey: string
    launchTokenHash: string
    processIncarnation?: string
  }): { principal: LegacyCompatibilityPrincipalRow; duplicate: boolean } {
    return rowFromJson<{ principal: LegacyCompatibilityPrincipalRow; duplicate: boolean }>(
      this.store.commitLegacyCompatibilityPrincipal(
        paramsJson({ ...params, id: generateId('legacy_principal') })
      )
    )
  }

  getLegacyCompatibilityPrincipal(id: string): LegacyCompatibilityPrincipalRow | undefined {
    return optRowFromJson<LegacyCompatibilityPrincipalRow>(
      this.store.getLegacyCompatibilityPrincipal(id)
    )
  }

  listLegacyCompatibilityPrincipals(runId: string): LegacyCompatibilityPrincipalRow[] {
    return listFromJson<LegacyCompatibilityPrincipalRow>(
      this.store.listLegacyCompatibilityPrincipals(runId)
    )
  }

  getLegacyCoordinatorPrincipal(runId: string): LegacyCompatibilityPrincipalRow | undefined {
    return optRowFromJson<LegacyCompatibilityPrincipalRow>(
      this.store.getLegacyCoordinatorPrincipal(runId)
    )
  }

  setLegacyCompatibilityPrincipalStatus(
    id: string,
    status: 'settled' | 'revoked'
  ): LegacyCompatibilityPrincipalRow | undefined {
    return optRowFromJson<LegacyCompatibilityPrincipalRow>(
      this.store.setLegacyCompatibilityPrincipalStatus(id, status)
    )
  }

  isLegacyCoordinatorHandle(runId: string, terminalHandle: string): boolean {
    return this.store.isLegacyCoordinatorHandle(runId, terminalHandle)
  }

  getLegacyOperationReceipt(
    principalId: string,
    operationKey: string
  ): LegacyOperationReceiptRow | undefined {
    return optRowFromJson<LegacyOperationReceiptRow>(
      this.store.getLegacyOperationReceipt(principalId, operationKey)
    )
  }

  resolveLegacyCompatibilityPrincipalByIdentity(params: {
    runId: string
    role: LegacyPrincipalRole
    terminalHandle?: string
    paneKey?: string
  }): LegacyCompatibilityPrincipalRow | undefined {
    return optRowFromJson<LegacyCompatibilityPrincipalRow>(
      this.store.resolveLegacyCompatibilityPrincipalByIdentity(paramsJson(params))
    )
  }

  resolveLegacyCoordinatorCandidate(params: {
    runId: string
    terminalHandle?: string
    paneKey?: string
  }): { terminalHandle: string; paneKey: string } | undefined {
    return optRowFromJson<{ terminalHandle: string; paneKey: string }>(
      this.store.resolveLegacyCoordinatorCandidate(paramsJson(params))
    )
  }

  // Why the wrapper: the store returns the bare DispatchContextRow (the more
  // useful Rust shape); db.ts's contract is `{ dispatch }`.
  resolveLegacyWorkerCandidate(params: {
    runId?: string
    terminalHandle?: string
    paneKey?: string
    dispatchId?: string
    taskId?: string
  }): { dispatch: DispatchContextRow } | undefined {
    const dispatch = optRowFromJson<DispatchContextRow>(
      this.store.resolveLegacyWorkerCandidate(paramsJson(params))
    )
    return dispatch ? { dispatch } : undefined
  }

  findLegacyWorkerCompletion(params: {
    principalId: string
    taskId: string
    recipientHandle: string
    subject: string
    body: string
    payload: string | null
  }): MessageRow | undefined {
    return optionalMessageRowFromJson(this.store.findLegacyWorkerCompletion(paramsJson(params)))
  }
}
