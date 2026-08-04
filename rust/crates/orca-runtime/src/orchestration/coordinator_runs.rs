//! Coordinator runs — the scheduler loop's own lifecycle record. Distinct from
//! the `runs` table (`runs`), which scopes the orchestration graph itself.

use super::rows::{row_to_coordinator, CoordinatorRun, COORDINATOR_RUN_COLUMNS};
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension};

impl OrchestrationDb {
    pub fn create_coordinator_run(
        &self,
        id: &str,
        spec: &str,
        coordinator_handle: &str,
        poll_interval_ms: Option<i64>,
    ) -> Result<CoordinatorRun, StoreError> {
        self.db.connection().execute(
            "INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, poll_interval_ms)
             VALUES (?1, ?2, 'running', ?3, ?4)",
            params![id, spec, coordinator_handle, poll_interval_ms.unwrap_or(2000)],
        )?;
        self.coordinator_run_by_id(id)?
            .ok_or_else(|| StoreError::Message("coordinator run vanished after insert".into()))
    }

    pub fn coordinator_run_by_id(&self, id: &str) -> Result<Option<CoordinatorRun>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!("SELECT {COORDINATOR_RUN_COLUMNS} FROM coordinator_runs WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_coordinator).optional()?)
    }

    /// Update status (TS `updateCoordinatorRun`); the caller passes the
    /// `new Date().toISOString()` stamp for terminal states, COALESCE'd so a
    /// non-terminal transition preserves any prior `completed_at`.
    pub fn update_coordinator_run(
        &self,
        id: &str,
        status: &str,
        completed_at: Option<&str>,
    ) -> Result<Option<CoordinatorRun>, StoreError> {
        self.db.connection().execute(
            "UPDATE coordinator_runs SET status = ?2, completed_at = COALESCE(?3, completed_at) WHERE id = ?1",
            params![id, status, completed_at],
        )?;
        self.coordinator_run_by_id(id)
    }

    /// The most recent still-running coordinator, if any (TS `getActiveCoordinatorRun`).
    pub fn active_coordinator_run(&self) -> Result<Option<CoordinatorRun>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COORDINATOR_RUN_COLUMNS} FROM coordinator_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
        ))?;
        Ok(stmt.query_row([], row_to_coordinator).optional()?)
    }

    /// Every still-running coordinator, newest first (TS `getActiveCoordinatorRuns`).
    /// Multiple orchestrators may run concurrently in one workspace (issue #4389),
    /// so lifecycle gating must see all of them, not just the latest.
    pub fn active_coordinator_runs(&self) -> Result<Vec<CoordinatorRun>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COORDINATOR_RUN_COLUMNS} FROM coordinator_runs WHERE status = 'running' ORDER BY created_at DESC, rowid DESC"
        ))?;
        let rows = stmt.query_map([], row_to_coordinator)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
