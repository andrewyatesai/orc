import { OrchestrationMessageStore } from './db-messages'
import { generateId, paramsJson, typesFilter } from './orchestration-store-bridge'
import { exposeDeliveryTimestamps, exposeRunTimestamps } from './db-row-timestamp-exposure'
import { exposeMessageTimestamps, messageListFromJson } from './db-message-timestamp'
import { rowFromJson } from './db-row-json'
import type { DeliveryRow, MessageRow, MessageType, RunRow } from './types'

export type RunListPage = {
  runs: RunRow[]
  nextCursor: string | null
}

type RunDelivery = { delivery: DeliveryRow; messages: MessageRow[]; replayed: boolean }

function exposeRunDelivery(delivery: RunDelivery): RunDelivery {
  return {
    ...delivery,
    delivery: exposeDeliveryTimestamps(delivery.delivery),
    messages: delivery.messages.map(exposeMessageTimestamps)
  }
}

export class OrchestrationRunStore extends OrchestrationMessageStore {
  createRun(params: {
    objective: string
    coordinatorHandle: string
    coordinatorPaneKey: string
  }): RunRow {
    return exposeRunTimestamps(
      rowFromJson<RunRow>(this.store.createRun(paramsJson({ ...params, id: generateId('run') })))
    )
  }

  bindRun(params: {
    runId: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    takeoverLegacy?: boolean
    legacyCoordinatorAuthority?: {
      runId: string
      principalId: string | null
      terminalHandle: string
      paneKey: string
      consumerGeneration: number
    }
  }): RunRow | undefined {
    const json = this.store.bindRun(paramsJson(params))
    return json === null ? undefined : exposeRunTimestamps(rowFromJson<RunRow>(json))
  }

  getRun(id: string): RunRow | undefined {
    const json = this.store.getRun(id)
    return json === null ? undefined : exposeRunTimestamps(rowFromJson<RunRow>(json))
  }

  // Why the cursor is passed straight through: it encodes the RAW SQLite
  // `created_at` the keyset binds, so rebuilding one from an already-exposed
  // RFC3339 timestamp would silently skip or repeat rows.
  listRuns(params: { limit?: number; cursor?: string } = {}): RunListPage {
    const page = rowFromJson<RunListPage>(this.store.listRuns(paramsJson(params)))
    return { runs: page.runs.map(exposeRunTimestamps), nextCursor: page.nextCursor }
  }

  getCurrentRunForPane(paneKey: string): RunRow | undefined {
    const json = this.store.getCurrentRunForPane(paneKey)
    return json === null ? undefined : exposeRunTimestamps(rowFromJson<RunRow>(json))
  }

  getOrCreateRunDelivery(params: {
    runId: string
    consumerGeneration: number
    limit?: number
    wakeTypes?: MessageType[]
  }): RunDelivery | undefined {
    // The `delivery_<hex>` is consumed only when this call actually cuts a new
    // delivery; a replay or an empty mailbox discards it.
    const json = this.store.getOrCreateRunDelivery(
      paramsJson({ ...params, deliveryId: generateId('delivery') })
    )
    return json === null ? undefined : exposeRunDelivery(rowFromJson<RunDelivery>(json))
  }

  acknowledgeRunDelivery(params: {
    runId: string
    consumerGeneration: number
    deliveryId: string
  }): { delivery: DeliveryRow; duplicate: boolean } {
    const ack = rowFromJson<{ delivery: DeliveryRow; duplicate: boolean }>(
      this.store.acknowledgeRunDelivery(paramsJson(params))
    )
    return { ...ack, delivery: exposeDeliveryTimestamps(ack.delivery) }
  }

  hasPendingCurrentDelivery(runId: string): boolean {
    return this.store.hasPendingCurrentDelivery(runId)
  }

  getRunMailboxHistory(runId: string, limit = 100, types?: MessageType[]): MessageRow[] {
    return messageListFromJson(this.store.getRunMailboxHistory(runId, limit, typesFilter(types)))
  }
}
