//! Transactional gate resolution (design §6.2) and the `waiting_gate` dispatch
//! parking it depends on. Kept apart from the legacy `resolve_gate`, which stays
//! byte-for-byte what it was: last-writer-wins, dispatch already closed. Callers
//! opt into the CAS path; nothing silently changes under them.

use super::{row_to_dispatch, row_to_gate, DecisionGate, DispatchContext, OrchestrationDb, DISPATCH_COLUMNS};
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

/// Why an enum rather than `Option<DecisionGate>`: a loser must be able to tell
/// "someone else already resolved this" from "no such gate", because only the
/// former means the answer it wanted is already committed and readable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum GateResolutionOutcome {
    Resolved { gate: DecisionGate, resumed_dispatch_id: Option<String> },
    /// The CAS lost: the gate is no longer `pending`, or its version moved. The
    /// committed row rides along so the loser can read the winner's result.
    VersionConflict { gate: DecisionGate },
    NotFound,
}

impl OrchestrationDb {
    /// CAS-resolve a pending gate: succeeds only while the row is still `pending`
    /// AND its `version` matches, bumps the version, and resumes the dispatch the
    /// gate parked (§6.2 — the worker keeps its lease instead of being requeued).
    ///
    /// `resolved_at` is the caller's ISO stamp (the shim owns wall-clock strings).
    pub fn resolve_pending_gate(
        &self,
        id: &str,
        expected_version: i64,
        resolution: &str,
        resolved_by: &str,
        resolution_reason: Option<&str>,
        resolved_at: &str,
    ) -> Result<GateResolutionOutcome, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        let attempted = self.cas_resolve(id, expected_version, resolution, resolved_by, resolution_reason, resolved_at);
        match attempted.and_then(|outcome| self.db.exec("COMMIT").map(|()| outcome)) {
            Ok(outcome) => Ok(outcome),
            Err(err) => {
                self.db.exec("ROLLBACK")?;
                Err(err)
            }
        }
    }

    fn cas_resolve(
        &self,
        id: &str,
        expected_version: i64,
        resolution: &str,
        resolved_by: &str,
        resolution_reason: Option<&str>,
        resolved_at: &str,
    ) -> Result<GateResolutionOutcome, StoreError> {
        let updated = self.db.connection().execute(
            "UPDATE decision_gates
                SET status = 'resolved', resolution = ?3, resolved_by = ?4,
                    resolution_reason = ?5, resolved_at = ?6, version = version + 1
              WHERE id = ?1 AND status = 'pending' AND version = ?2",
            params![id, expected_version, resolution, resolved_by, resolution_reason, resolved_at],
        )?;
        let Some(gate) = self.gate_by_id(id)? else {
            return Ok(GateResolutionOutcome::NotFound);
        };
        if updated == 0 {
            return Ok(GateResolutionOutcome::VersionConflict { gate });
        }
        let resumed = self.resume_parked_dispatch(&gate.task_id)?;
        // A resumed worker still holds the task, so the task returns to
        // `dispatched`; with nothing parked the task is free for redispatch.
        let task_status = if resumed.is_some() { "dispatched" } else { "ready" };
        self.db
            .connection()
            .execute("UPDATE tasks SET status = ?2 WHERE id = ?1", params![gate.task_id, task_status])?;
        Ok(GateResolutionOutcome::Resolved { gate, resumed_dispatch_id: resumed })
    }

    /// Park the task's active dispatch on a gate instead of completing it, so the
    /// assignee keeps its lease. Returns the parked dispatch, or `None` when the
    /// task had no active one.
    pub fn park_dispatch_waiting_gate(&self, task_id: &str) -> Result<Option<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let active: Option<String> = conn
            .query_row(
                "SELECT id FROM dispatch_contexts WHERE task_id = ?1 AND status IN ('pending','dispatched') ORDER BY rowid DESC LIMIT 1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(id) = active else {
            return Ok(None);
        };
        conn.execute("UPDATE dispatch_contexts SET status = 'waiting_gate' WHERE id = ?1", params![id])?;
        self.dispatch_context_by_id(&id)
    }

    fn resume_parked_dispatch(&self, task_id: &str) -> Result<Option<String>, StoreError> {
        let conn = self.db.connection();
        let parked: Option<String> = conn
            .query_row(
                "SELECT id FROM dispatch_contexts WHERE task_id = ?1 AND status = 'waiting_gate' ORDER BY rowid DESC LIMIT 1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = &parked {
            conn.execute("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?1", params![id])?;
        }
        Ok(parked)
    }

    /// Every dispatch parked on a gate, oldest first — what a restarted supervisor
    /// reads to find workers holding a lease with no live gate behind it.
    pub fn list_dispatches_waiting_gate(&self) -> Result<Vec<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts WHERE status = 'waiting_gate' ORDER BY rowid"
        ))?;
        let rows = stmt.query_map([], row_to_dispatch)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The task's still-pending gate, if any — the CAS caller's way to read the
    /// `version` it must present. `idx_gates_one_pending_per_task` makes "the" exact.
    pub fn pending_gate_for_task(&self, task_id: &str) -> Result<Option<DecisionGate>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM decision_gates WHERE task_id = ?1 AND status = 'pending' ORDER BY rowid DESC LIMIT 1",
            super::GATE_COLUMNS
        ))?;
        Ok(stmt.query_row([task_id], row_to_gate).optional()?)
    }
}
