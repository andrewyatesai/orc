import type { RustOrchestrationStoreHandle } from '../../daemon/rust-git-addon'
import { optRowFromJson, rowFromJson } from './db-row-json'
import { restoreCodedError } from './orchestration-error'
import type { MutationReceiptRow } from './types'

/** The idempotency identity of one caller mutation. `payloadHash` is a
 *  fingerprint of the canonicalized params (see orchestration-idempotency.ts). */
export type MutationReceiptKey = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

export type MutationReceiptClaim = {
  /** `started` claimed the slot (execute now), `pending` means another attempt
   *  is in flight, `completed` means replay `row.receipt` instead of executing. */
  disposition: 'started' | 'pending' | 'completed'
  row: MutationReceiptRow
}

/**
 * Mutation receipts (schema v11) — the durable idempotency ledger. A retried
 * mutating RPC (same `callerFingerprint` + `requestId`) applies ONCE: `begin`
 * records intent; a duplicate `begin` with a matching payload replays the stored
 * receipt; a mismatched payload for the same key is a coded conflict; `complete`
 * stores the receipt; `discard` rolls back a pending row on failure so the caller
 * may retry cleanly.
 *
 * Coded store failures (request_mismatch, mutation_ledger_full) arrive as a JSON
 * envelope in Error.message; `coded()` restores them to OrchestrationError so
 * callers branch on `.code`.
 */
export class MutationReceiptStore {
  constructor(private store: RustOrchestrationStoreHandle) {}

  private coded<T>(call: () => T): T {
    try {
      return call()
    } catch (error) {
      throw restoreCodedError(error)
    }
  }

  /** Claims the slot. A mismatched method/payload for an existing key throws
   *  `request_mismatch`; a ledger full of unresolved work throws
   *  `mutation_ledger_full`. */
  begin(key: MutationReceiptKey): MutationReceiptClaim {
    return this.coded(() =>
      rowFromJson<MutationReceiptClaim>(
        this.store.beginMutationReceipt(
          key.callerFingerprint,
          key.requestId,
          key.method,
          key.payloadHash
        )
      )
    )
  }

  /** Records the serialized result for replay. Throws `request_mismatch` if the
   *  slot no longer matches its pending operation. */
  complete(key: MutationReceiptKey, receipt: string): MutationReceiptRow {
    return this.coded(() =>
      rowFromJson<MutationReceiptRow>(
        this.store.completeMutationReceipt(
          key.callerFingerprint,
          key.requestId,
          key.method,
          key.payloadHash,
          receipt
        )
      )
    )
  }

  /** Releases a pending slot so the caller may retry; a completed receipt is a
   *  no-op, as is an unknown key. */
  discardPending(callerFingerprint: string, requestId: string): void {
    this.store.discardPendingMutationReceipt(callerFingerprint, requestId)
  }

  get(callerFingerprint: string, requestId: string): MutationReceiptRow | undefined {
    return optRowFromJson<MutationReceiptRow>(
      this.store.getMutationReceipt(callerFingerprint, requestId)
    )
  }
}
