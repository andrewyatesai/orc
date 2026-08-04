//! Mutation receipts: the idempotency ledger keyed by
//! `(caller_fingerprint, request_id)`. A retried RPC replays its recorded result
//! instead of applying the mutation twice, and a caller that changes the payload
//! under the same request id is rejected rather than silently accepted.
//!
//! Ported from the mutation-receipt section of
//! `src/main/runtime/orchestration/db.ts`. Table: `mutation_receipts`.

use super::error::orchestration_err;
use super::rows::{row_to_mutation_receipt, MutationReceipt, MUTATION_RECEIPT_COLUMNS};
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension};

/// Ledger caps from db.ts (`MUTATION_RECEIPT_MAX_ROWS`, `MUTATION_RECEIPT_MAX_AGE_DAYS`).
pub const MUTATION_RECEIPT_MAX_ROWS: i64 = 10_000;
pub const MUTATION_RECEIPT_MAX_AGE_DAYS: i64 = 30;

/// The identity of one caller mutation. Shared with `worker_dispatch` and
/// `remote_attachment`, whose create paths settle a receipt in the same writer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MutationReceiptKey {
    pub caller_fingerprint: String,
    pub request_id: String,
    pub method: String,
    pub payload_hash: String,
}

/// TS `beginMutationReceipt` disposition: `started` claimed the slot, `pending`
/// means another attempt is in flight, `completed` means replay the stored result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationReceiptDisposition {
    Started,
    Pending,
    Completed,
}

/// TS `{ disposition; row }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct MutationReceiptClaim {
    pub disposition: MutationReceiptDisposition,
    pub row: MutationReceipt,
}

impl OrchestrationDb {
    /// TS `beginMutationReceipt` — claims the `(caller, request)` slot. A
    /// mismatched `payload_hash` for an existing key must fail, not overwrite.
    pub fn begin_mutation_receipt(
        &self,
        key: &MutationReceiptKey,
    ) -> Result<MutationReceiptClaim, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        // Why: COMMIT sits inside the fallible path (as in the TS try block), so a
        // failed COMMIT rolls back too and never leaves a half-claimed slot.
        let claimed = self
            .begin_mutation_receipt_in_transaction(key)
            .and_then(|claim| self.db.exec("COMMIT").map(|()| claim));
        match claimed {
            Ok(claim) => Ok(claim),
            Err(error) => {
                self.db.exec("ROLLBACK")?;
                Err(error)
            }
        }
    }

    fn begin_mutation_receipt_in_transaction(
        &self,
        key: &MutationReceiptKey,
    ) -> Result<MutationReceiptClaim, StoreError> {
        if let Some(existing) = self.get_mutation_receipt(&key.caller_fingerprint, &key.request_id)?
        {
            if existing.method != key.method || existing.payload_hash != key.payload_hash {
                return orchestration_err(
                    "request_mismatch",
                    format!(
                        "Mutation request {} was already used with different input.",
                        key.request_id
                    ),
                );
            }
            let disposition = match existing.state.as_str() {
                "pending" => MutationReceiptDisposition::Pending,
                "completed" => MutationReceiptDisposition::Completed,
                // Unreachable while the table's CHECK constraint holds; surfaced
                // rather than guessed a disposition the caller would act on.
                other => {
                    return Err(StoreError::Message(format!(
                        "mutation receipt {} has unknown state {other}",
                        key.request_id
                    )))
                }
            };
            return Ok(MutationReceiptClaim { disposition, row: existing });
        }
        self.ensure_mutation_receipt_capacity()?;
        self.db.connection().execute(
            "INSERT INTO mutation_receipts (
               caller_fingerprint, request_id, method, payload_hash, state
             ) VALUES (?1, ?2, ?3, ?4, 'pending')",
            params![key.caller_fingerprint, key.request_id, key.method, key.payload_hash],
        )?;
        let row = self
            .get_mutation_receipt(&key.caller_fingerprint, &key.request_id)?
            .ok_or_else(|| StoreError::Message("mutation receipt vanished after insert".into()))?;
        Ok(MutationReceiptClaim { disposition: MutationReceiptDisposition::Started, row })
    }

    /// TS `completeMutationReceipt` — stores the serialized result for replay.
    pub fn complete_mutation_receipt(
        &self,
        key: &MutationReceiptKey,
        receipt: &str,
    ) -> Result<MutationReceipt, StoreError> {
        let changes = self.db.connection().execute(
            "UPDATE mutation_receipts
             SET state = 'completed', receipt = ?1, updated_at = datetime('now')
             WHERE caller_fingerprint = ?2 AND request_id = ?3 AND method = ?4
               AND payload_hash = ?5",
            params![
                receipt,
                key.caller_fingerprint,
                key.request_id,
                key.method,
                key.payload_hash
            ],
        )?;
        let row = self.get_mutation_receipt(&key.caller_fingerprint, &key.request_id)?;
        match row {
            Some(row) if changes == 1 => Ok(row),
            _ => orchestration_err(
                "request_mismatch",
                format!(
                    "Mutation request {} no longer matches its pending operation.",
                    key.request_id
                ),
            ),
        }
    }

    /// TS `discardPendingMutationReceipt` — releases a slot whose mutation threw,
    /// so the caller may retry. A completed receipt is left alone.
    pub fn discard_pending_mutation_receipt(
        &self,
        caller_fingerprint: &str,
        request_id: &str,
    ) -> Result<(), StoreError> {
        self.db.connection().execute(
            "DELETE FROM mutation_receipts
             WHERE caller_fingerprint = ?1 AND request_id = ?2 AND state = 'pending'",
            params![caller_fingerprint, request_id],
        )?;
        Ok(())
    }

    /// TS `getMutationReceipt`.
    pub fn get_mutation_receipt(
        &self,
        caller_fingerprint: &str,
        request_id: &str,
    ) -> Result<Option<MutationReceipt>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {MUTATION_RECEIPT_COLUMNS} FROM mutation_receipts
             WHERE caller_fingerprint = ?1 AND request_id = ?2"
        ))?;
        Ok(stmt
            .query_row(params![caller_fingerprint, request_id], row_to_mutation_receipt)
            .optional()?)
    }

    /// TS private `ensureMutationReceiptCapacity` — trims the ledger (aged-out
    /// completed rows, then the oldest completed rows) and refuses to admit a new
    /// receipt when what remains is all unresolved.
    ///
    /// Why `pub(crate)`: the worker-dispatch and remote-attachment create paths
    /// insert their own receipt inline and must run the same admission check.
    pub(crate) fn ensure_mutation_receipt_capacity(&self) -> Result<(), StoreError> {
        let conn = self.db.connection();
        conn.execute(
            "DELETE FROM mutation_receipts
             WHERE state = 'completed'
               AND updated_at < datetime('now', ?1)",
            params![format!("-{MUTATION_RECEIPT_MAX_AGE_DAYS} days")],
        )?;

        let count: i64 = conn
            .query_row("SELECT COUNT(*) AS count FROM mutation_receipts", [], |row| row.get(0))?;
        let completed_to_remove = count - MUTATION_RECEIPT_MAX_ROWS + 1;
        if completed_to_remove > 0 {
            conn.execute(
                "DELETE FROM mutation_receipts
                 WHERE rowid IN (
                   SELECT rowid FROM mutation_receipts
                   WHERE state = 'completed'
                   ORDER BY updated_at ASC, rowid ASC
                   LIMIT ?1
                 )",
                params![completed_to_remove],
            )?;
        }

        let retained: i64 = conn
            .query_row("SELECT COUNT(*) AS count FROM mutation_receipts", [], |row| row.get(0))?;
        if retained >= MUTATION_RECEIPT_MAX_ROWS {
            return orchestration_err(
                "mutation_ledger_full",
                "The durable mutation ledger is full of unresolved operations. Resolve or inspect them before starting another mutation.",
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::error::ORCHESTRATION_ERROR_MARKER;

    fn key(request_id: &str, payload_hash: &str) -> MutationReceiptKey {
        MutationReceiptKey {
            caller_fingerprint: "peer-a".to_string(),
            request_id: request_id.to_string(),
            method: "startWorker".to_string(),
            payload_hash: payload_hash.to_string(),
        }
    }

    /// Assert the failure travels as a coded orchestration error with `code`.
    fn assert_coded(error: StoreError, code: &str) -> serde_json::Value {
        let StoreError::Message(text) = error else {
            panic!("expected a coded message error, got {error:?}");
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed[ORCHESTRATION_ERROR_MARKER], serde_json::json!(true));
        assert_eq!(parsed["code"], code);
        parsed
    }

    fn receipt_count(db: &OrchestrationDb) -> i64 {
        db.connection()
            .query_row("SELECT COUNT(*) FROM mutation_receipts", [], |row| row.get(0))
            .unwrap()
    }

    /// Bulk-load `n` receipts in one statement — the capacity tests need ledgers
    /// at the 10 000-row boundary and per-row inserts are needlessly slow.
    fn seed_receipts(db: &OrchestrationDb, prefix: &str, n: i64, state: &str) {
        db.connection()
            .execute(
                &format!(
                    "WITH RECURSIVE seq(i) AS (
                       SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?1
                     )
                     INSERT INTO mutation_receipts (
                       caller_fingerprint, request_id, method, payload_hash, state, updated_at
                     )
                     SELECT 'peer-a', '{prefix}' || i, 'startWorker', 'hash', '{state}',
                            datetime('now', '-' || i || ' seconds')
                     FROM seq"
                ),
                params![n],
            )
            .unwrap();
    }

    #[test]
    fn begin_claims_then_replays_the_same_request() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        let k = key("req-1", "hash-1");

        let started = db.begin_mutation_receipt(&k).unwrap();
        assert_eq!(started.disposition, MutationReceiptDisposition::Started);
        assert_eq!(started.row.state, "pending");
        assert_eq!(started.row.method, "startWorker");
        assert_eq!(started.row.payload_hash, "hash-1");
        assert_eq!(started.row.receipt, None);
        assert!(!started.row.created_at.is_empty());

        // A retry while the mutation is in flight reports `pending`, not a second claim.
        let retried = db.begin_mutation_receipt(&k).unwrap();
        assert_eq!(retried.disposition, MutationReceiptDisposition::Pending);
        assert_eq!(receipt_count(&db), 1);

        let stored_receipt = r#"{"accepted":{"dispatchId":"ctx_1"}}"#;
        let completed = db.complete_mutation_receipt(&k, stored_receipt).unwrap();
        assert_eq!(completed.state, "completed");
        assert_eq!(completed.receipt.as_deref(), Some(stored_receipt));

        // A retry after completion replays the stored result.
        let replayed = db.begin_mutation_receipt(&k).unwrap();
        assert_eq!(replayed.disposition, MutationReceiptDisposition::Completed);
        assert_eq!(replayed.row.receipt.as_deref(), Some(stored_receipt));
        assert_eq!(receipt_count(&db), 1);
    }

    #[test]
    fn begin_rejects_a_reused_request_id_with_different_input() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.begin_mutation_receipt(&key("req-1", "hash-1")).unwrap();

        let payload_drift = db.begin_mutation_receipt(&key("req-1", "hash-2")).unwrap_err();
        let parsed = assert_coded(payload_drift, "request_mismatch");
        assert_eq!(
            parsed["message"],
            "Mutation request req-1 was already used with different input."
        );

        let mut method_drift = key("req-1", "hash-1");
        method_drift.method = "stopWorker".to_string();
        assert_coded(db.begin_mutation_receipt(&method_drift).unwrap_err(), "request_mismatch");

        // The rejection rolled its transaction back and left the original claim intact.
        assert_eq!(receipt_count(&db), 1);
        let stored = db.get_mutation_receipt("peer-a", "req-1").unwrap().unwrap();
        assert_eq!(stored.payload_hash, "hash-1");
        assert_eq!(stored.method, "startWorker");
        // And the writer is usable again — no transaction was left open.
        assert_eq!(
            db.begin_mutation_receipt(&key("req-2", "hash-2")).unwrap().disposition,
            MutationReceiptDisposition::Started
        );
    }

    #[test]
    fn complete_requires_the_matching_method_and_payload() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.begin_mutation_receipt(&key("req-1", "hash-1")).unwrap();

        let drifted = db.complete_mutation_receipt(&key("req-1", "hash-2"), "{}").unwrap_err();
        let parsed = assert_coded(drifted, "request_mismatch");
        assert_eq!(
            parsed["message"],
            "Mutation request req-1 no longer matches its pending operation."
        );
        // The failed complete left the slot pending and unrecorded.
        let stored = db.get_mutation_receipt("peer-a", "req-1").unwrap().unwrap();
        assert_eq!(stored.state, "pending");
        assert_eq!(stored.receipt, None);

        // No row at all is the same rejection (changes == 0 and no row).
        assert_coded(
            db.complete_mutation_receipt(&key("req-missing", "hash-1"), "{}").unwrap_err(),
            "request_mismatch",
        );
        assert!(db.get_mutation_receipt("peer-a", "req-missing").unwrap().is_none());
    }

    #[test]
    fn complete_is_idempotent_and_restamps_updated_at() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        let k = key("req-1", "hash-1");
        db.begin_mutation_receipt(&k).unwrap();
        db.complete_mutation_receipt(&k, r#"{"v":1}"#).unwrap();
        // TS does not gate the UPDATE on state = 'pending', so a re-complete wins.
        let again = db.complete_mutation_receipt(&k, r#"{"v":2}"#).unwrap();
        assert_eq!(again.state, "completed");
        assert_eq!(again.receipt.as_deref(), Some(r#"{"v":2}"#));
    }

    #[test]
    fn discard_releases_only_a_pending_slot() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        let k = key("req-1", "hash-1");
        db.begin_mutation_receipt(&k).unwrap();

        db.discard_pending_mutation_receipt("peer-a", "req-1").unwrap();
        assert!(db.get_mutation_receipt("peer-a", "req-1").unwrap().is_none());

        // The freed slot may be reclaimed, even with different input.
        let reclaimed = db.begin_mutation_receipt(&key("req-1", "hash-9")).unwrap();
        assert_eq!(reclaimed.disposition, MutationReceiptDisposition::Started);

        // A completed receipt is never discarded — replay must survive.
        db.complete_mutation_receipt(&key("req-1", "hash-9"), "{}").unwrap();
        db.discard_pending_mutation_receipt("peer-a", "req-1").unwrap();
        assert_eq!(
            db.get_mutation_receipt("peer-a", "req-1").unwrap().unwrap().state,
            "completed"
        );
        // Discarding an unknown request is a silent no-op.
        db.discard_pending_mutation_receipt("peer-a", "nope").unwrap();
    }

    #[test]
    fn get_returns_none_for_an_unknown_key() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.begin_mutation_receipt(&key("req-1", "hash-1")).unwrap();
        assert!(db.get_mutation_receipt("peer-b", "req-1").unwrap().is_none());
        assert!(db.get_mutation_receipt("peer-a", "req-2").unwrap().is_none());
    }

    #[test]
    fn capacity_drops_aged_out_completed_receipts_only() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.connection()
            .execute(
                "INSERT INTO mutation_receipts (
                   caller_fingerprint, request_id, method, payload_hash, state, updated_at
                 ) VALUES
                   ('peer-a', 'old-done', 'm', 'h', 'completed', datetime('now', '-31 days')),
                   ('peer-a', 'old-pending', 'm', 'h', 'pending', datetime('now', '-31 days')),
                   ('peer-a', 'fresh-done', 'm', 'h', 'completed', datetime('now', '-1 days'))",
                [],
            )
            .unwrap();

        db.begin_mutation_receipt(&key("req-1", "hash-1")).unwrap();

        assert!(db.get_mutation_receipt("peer-a", "old-done").unwrap().is_none());
        // Unresolved work is never trimmed by age — only completed rows are.
        assert!(db.get_mutation_receipt("peer-a", "old-pending").unwrap().is_some());
        assert!(db.get_mutation_receipt("peer-a", "fresh-done").unwrap().is_some());
    }

    #[test]
    fn capacity_evicts_the_oldest_completed_row_at_the_row_cap() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        // `-i seconds` makes request id `done-N` the Nth-oldest, so `done-10000` is
        // the single eviction candidate.
        seed_receipts(&db, "done-", MUTATION_RECEIPT_MAX_ROWS, "completed");
        assert_eq!(receipt_count(&db), MUTATION_RECEIPT_MAX_ROWS);

        db.begin_mutation_receipt(&key("req-1", "hash-1")).unwrap();

        assert!(db.get_mutation_receipt("peer-a", "done-10000").unwrap().is_none());
        assert!(db.get_mutation_receipt("peer-a", "done-9999").unwrap().is_some());
        assert_eq!(receipt_count(&db), MUTATION_RECEIPT_MAX_ROWS);
    }

    #[test]
    fn capacity_refuses_a_ledger_full_of_unresolved_receipts() {
        let db = OrchestrationDb::open_in_memory().unwrap();
        seed_receipts(&db, "pending-", MUTATION_RECEIPT_MAX_ROWS, "pending");

        let error = db.begin_mutation_receipt(&key("req-1", "hash-1")).unwrap_err();
        let parsed = assert_coded(error, "mutation_ledger_full");
        assert_eq!(
            parsed["message"],
            "The durable mutation ledger is full of unresolved operations. Resolve or inspect them before starting another mutation."
        );
        // Rolled back: nothing admitted, nothing evicted.
        assert_eq!(receipt_count(&db), MUTATION_RECEIPT_MAX_ROWS);
        assert!(db.get_mutation_receipt("peer-a", "req-1").unwrap().is_none());

        // Resolving one unresolved receipt makes room again.
        db.discard_pending_mutation_receipt("peer-a", "pending-1").unwrap();
        assert_eq!(
            db.begin_mutation_receipt(&key("req-1", "hash-1")).unwrap().disposition,
            MutationReceiptDisposition::Started
        );
    }
}
