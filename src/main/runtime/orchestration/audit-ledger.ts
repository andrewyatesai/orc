import type { RustOrchestrationStoreHandle } from '../../daemon/rust-git-addon'
import { listFromJson, rowFromJson } from './db-row-json'
import { generateId } from './row-id'
import type { AuditEventRow } from './types'

/**
 * The durable audit ledger (design §7) — manager actions, rotations, gate
 * resolutions, grant changes and takeovers. Deliberately append-only: the schema
 * trigger aborts UPDATE, so there is no update method to reach for, and a
 * correction is another event.
 *
 * Redaction is the caller's job (§7: length + hash, never raw credentials or
 * submitted text). This shim records what it is handed and does not inspect it.
 */
export class AuditLedgerStore {
  constructor(private store: RustOrchestrationStoreHandle) {}

  append(event: {
    /** Null for events outside any run — grant changes, takeovers. */
    runId?: string | null
    /** `human` | `manager:<handle>` | `service:<name>`. */
    actor: string
    action: string
    targetPaneKey?: string | null
    targetHandle?: string | null
    evidenceRef?: string | null
    detail?: string | null
  }): AuditEventRow {
    return rowFromJson<AuditEventRow>(
      this.store.appendAuditEvent(
        generateId('audit'),
        event.runId ?? null,
        event.actor,
        event.action,
        event.targetPaneKey ?? null,
        event.targetHandle ?? null,
        event.evidenceRef ?? null,
        event.detail ?? null
      )
    )
  }

  /** Newest first, bounded. An omitted `runId` is "no filter", so events recorded
   *  outside a run still list; it is not a request for un-owned rows only. */
  list(filter: { runId?: string; limit?: number; offset?: number } = {}): AuditEventRow[] {
    return listFromJson<AuditEventRow>(
      this.store.listAuditEvents(filter.runId, filter.limit ?? 50, filter.offset ?? 0)
    )
  }
}
