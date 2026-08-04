//! The raw state dump the parity harness canonicalizes. Tests and tooling only —
//! never a production read path.
//!
//! Open gap: this dumps only the five pre-sync tables, so the 13 tables the
//! v1.4.165 domains added are not state-compared. Widening it means growing
//! `tools/parity/dispatch/orchestration-store.ts` and the parity corpus in
//! lockstep — a corpus change, not a fidelity fix.

use super::rows::{
    row_to_coordinator, row_to_dispatch, row_to_gate, row_to_message, row_to_task,
    COORDINATOR_RUN_COLUMNS, DISPATCH_COLUMNS, GATE_COLUMNS, MESSAGE_COLUMNS, TASK_COLUMNS,
};
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::Row as SqlRow;

impl OrchestrationDb {
    fn all<T>(&self, sql: &str, f: fn(&SqlRow<'_>) -> rusqlite::Result<T>) -> Result<Vec<T>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], f)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every row of every table (raw full rows, insertion order) as JSON — the
    /// state-dump seam the parity harness canonicalizes. Not a production path.
    pub fn dump_all_rows(&self) -> Result<serde_json::Value, StoreError> {
        let messages = self.all(&format!("SELECT {MESSAGE_COLUMNS} FROM messages ORDER BY rowid"), row_to_message)?;
        let tasks = self.all(&format!("SELECT {TASK_COLUMNS} FROM tasks ORDER BY rowid"), row_to_task)?;
        let dispatch_contexts =
            self.all(&format!("SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts ORDER BY rowid"), row_to_dispatch)?;
        let decision_gates =
            self.all(&format!("SELECT {GATE_COLUMNS} FROM decision_gates ORDER BY rowid"), row_to_gate)?;
        let coordinator_runs =
            self.all(&format!("SELECT {COORDINATOR_RUN_COLUMNS} FROM coordinator_runs ORDER BY rowid"), row_to_coordinator)?;
        Ok(serde_json::json!({
            "messages": messages,
            "tasks": tasks,
            "dispatch_contexts": dispatch_contexts,
            "decision_gates": decision_gates,
            "coordinator_runs": coordinator_runs,
        }))
    }
}
