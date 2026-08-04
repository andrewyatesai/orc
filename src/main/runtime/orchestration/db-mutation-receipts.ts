import { OrchestrationRemoteAttachmentStore } from './db-remote-attachments'
import { paramsJson } from './orchestration-store-bridge'
import { optRowFromJson, rowFromJson } from './db-row-json'
import type { MutationReceiptRow } from './types'

type MutationReceiptKey = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

export class OrchestrationMutationReceiptStore extends OrchestrationRemoteAttachmentStore {
  beginMutationReceipt(
    params: MutationReceiptKey
  ):
    | { disposition: 'started'; row: MutationReceiptRow }
    | { disposition: 'pending'; row: MutationReceiptRow }
    | { disposition: 'completed'; row: MutationReceiptRow } {
    return rowFromJson<
      | { disposition: 'started'; row: MutationReceiptRow }
      | { disposition: 'pending'; row: MutationReceiptRow }
      | { disposition: 'completed'; row: MutationReceiptRow }
    >(this.store.beginMutationReceipt(paramsJson(params)))
  }

  completeMutationReceipt(params: MutationReceiptKey & { receipt: string }): MutationReceiptRow {
    return rowFromJson<MutationReceiptRow>(this.store.completeMutationReceipt(paramsJson(params)))
  }

  discardPendingMutationReceipt(callerFingerprint: string, requestId: string): void {
    this.store.discardPendingMutationReceipt(callerFingerprint, requestId)
  }

  getMutationReceipt(callerFingerprint: string, requestId: string): MutationReceiptRow | undefined {
    return optRowFromJson<MutationReceiptRow>(
      this.store.getMutationReceipt(callerFingerprint, requestId)
    )
  }
}
