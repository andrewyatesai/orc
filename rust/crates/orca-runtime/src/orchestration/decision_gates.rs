//! Decision gates: opening a gate blocks its task, resolving one unblocks it,
//! and a timeout leaves it blocked for the escalation path.

use super::rows::{row_to_gate, DecisionGate, GATE_COLUMNS};
use super::run_contract::LEGACY_RUN_ID;
use super::sql_fragments::json_string_array;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, params_from_iter, OptionalExtension, ToSql};

impl OrchestrationDb {
    /// Open a decision gate on a task (TS `createGate`): closes the task's active
    /// dispatch and moves the task to `blocked`.
    pub fn create_gate(
        &self,
        id: &str,
        task_id: &str,
        question: &str,
        options: &[&str],
        origin_message_id: Option<&str>,
    ) -> Result<DecisionGate, StoreError> {
        // The gate inherits its task's Run; gate reads filter on it, so falling
        // back to the column default would hide every non-legacy gate.
        let run_id = self.get_task(task_id)?.map_or_else(|| LEGACY_RUN_ID.to_string(), |t| t.run_id);
        self.db.connection().execute(
            "INSERT INTO decision_gates (id, run_id, task_id, question, options, origin_message_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, run_id, task_id, question, json_string_array(options), origin_message_id],
        )?;
        self.complete_active_dispatch_for_task(task_id)?;
        self.db
            .connection()
            .execute("UPDATE tasks SET status = 'blocked' WHERE id = ?1", params![task_id])?;
        self.gate_by_id(id)?
            .ok_or_else(|| StoreError::Message("gate vanished after insert".into()))
    }

    /// Resolve a gate and unblock its task (TS `resolveGate`): a missing gate is a
    /// no-op (`None`); otherwise the gate is `resolved` and the task returns to `ready`.
    pub fn resolve_gate(&self, id: &str, resolution: &str) -> Result<Option<DecisionGate>, StoreError> {
        let Some(gate) = self.gate_by_id(id)? else {
            return Ok(None);
        };
        let conn = self.db.connection();
        conn.execute(
            "UPDATE decision_gates SET status = 'resolved', resolution = ?2, resolved_at = datetime('now') WHERE id = ?1",
            params![id, resolution],
        )?;
        conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?1", params![gate.task_id])?;
        self.gate_by_id(id)
    }

    /// Time a gate out (TS `timeoutGate`): marks it `timeout` + stamps `resolved_at`,
    /// leaving the task blocked.
    pub fn timeout_gate(&self, id: &str) -> Result<Option<DecisionGate>, StoreError> {
        self.db.connection().execute(
            "UPDATE decision_gates SET status = 'timeout', resolved_at = datetime('now') WHERE id = ?1",
            params![id],
        )?;
        self.gate_by_id(id)
    }

    pub fn gate_by_id(&self, id: &str) -> Result<Option<DecisionGate>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!("SELECT {GATE_COLUMNS} FROM decision_gates WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_gate).optional()?)
    }

    /// Gates filtered by task and/or status, oldest first (TS `listGates`).
    pub fn list_gates(&self, task_id: Option<&str>, status: Option<&str>) -> Result<Vec<DecisionGate>, StoreError> {
        let conn = self.db.connection();
        let mut sql = format!("SELECT {GATE_COLUMNS} FROM decision_gates");
        let mut binds: Vec<&dyn ToSql> = Vec::new();
        let mut clauses: Vec<&str> = Vec::new();
        if let Some(task_id) = &task_id {
            clauses.push("task_id = ?");
            binds.push(task_id as &dyn ToSql);
        }
        if let Some(status) = &status {
            clauses.push("status = ?");
            binds.push(status as &dyn ToSql);
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY created_at");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), row_to_gate)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
