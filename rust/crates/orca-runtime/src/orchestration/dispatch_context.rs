//! Dispatch contexts: assigning a ready task to a terminal, the pane-identity
//! conflict lock, completion/failure with the circuit breaker, and heartbeat
//! liveness. Capability minting on these same rows lives in `capability`.

use super::pane_key::is_equivalent_pane_key;
use super::rows::{row_to_dispatch, DispatchContext, DISPATCH_COLUMNS};
use super::run_contract::CURRENT_CONTRACT_VERSION;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension};

impl OrchestrationDb {
    /// Dispatch `task_id` (which must be `ready`) to `assignee_handle` (TS
    /// `createDispatchContext`). Refuses if the assignee already has an active
    /// dispatch; carries the failure count forward; marks the task `dispatched`.
    /// The row inherits the task's Run and is stamped with the current contract,
    /// so capability minting (which rejects a stale contract) works on it.
    #[allow(clippy::too_many_arguments)]
    pub fn create_dispatch_context(
        &self,
        task_id: &str,
        assignee_handle: &str,
        id: &str,
        assignee_pane_key: Option<&str>,
        launch_token_hash: Option<&str>,
    ) -> Result<DispatchContext, StoreError> {
        let task = self
            .get_task(task_id)?
            .ok_or_else(|| StoreError::Message(format!("Task not found: {task_id}")))?;
        if task.status != "ready" {
            return Err(StoreError::Message(format!(
                "Task {task_id} is {}; only ready tasks can be dispatched",
                task.status
            )));
        }
        let conn = self.db.connection();
        // Handle match covers legacy rows without pane keys.
        let mut conflict: Option<(String, String)> = conn
            .query_row(
                "SELECT id, task_id FROM dispatch_contexts WHERE assignee_handle = ?1 AND status IN ('pending','dispatched') LIMIT 1",
                [assignee_handle],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        // Pane-identity match: when both the new assignee and an active row carry
        // usable pane keys, also lock on equivalent pane identity (remint-stable
        // leaf) so a reminted handle can't open a second dispatch on the same pane.
        if conflict.is_none() {
            if let Some(pane_key) = assignee_pane_key {
                let mut stmt = conn.prepare(
                    "SELECT id, task_id, assignee_pane_key FROM dispatch_contexts WHERE assignee_pane_key IS NOT NULL AND status IN ('pending','dispatched')",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
                })?;
                for row in rows {
                    let (id, tid, existing_key) = row?;
                    if existing_key.as_deref().is_some_and(|k| is_equivalent_pane_key(k, pane_key)) {
                        conflict = Some((id, tid));
                        break;
                    }
                }
            }
        }
        if let Some((existing_id, existing_task)) = conflict {
            return Err(StoreError::Message(format!(
                "Terminal {assignee_handle} already has an active dispatch ({existing_id} for task {existing_task})"
            )));
        }
        let prior_failures: i64 = conn.query_row(
            "SELECT COALESCE(MAX(failure_count), 0) FROM dispatch_contexts WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO dispatch_contexts (
               id, run_id, task_id, contract_version, launch_token_hash,
               assignee_handle, assignee_pane_key, status, failure_count, dispatched_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'dispatched', ?8, datetime('now'))",
            params![
                id,
                task.run_id,
                task_id,
                CURRENT_CONTRACT_VERSION,
                launch_token_hash,
                assignee_handle,
                assignee_pane_key,
                prior_failures
            ],
        )?;
        conn.execute("UPDATE tasks SET status = 'dispatched' WHERE id = ?1", params![task_id])?;
        self.dispatch_context_by_id(id)?
            .ok_or_else(|| StoreError::Message("dispatch context vanished after insert".into()))
    }

    /// TS `hasAnyDispatchContexts` — the uncached probe. The TS twin memoises the
    /// answer on the store instance; that memo (and its reset invalidation) stays
    /// caller-side so this method has no hidden state to keep coherent.
    pub fn has_any_dispatch_contexts(&self) -> Result<bool, StoreError> {
        let found: Option<i64> = self
            .db
            .connection()
            .query_row("SELECT 1 FROM dispatch_contexts LIMIT 1", [], |row| row.get(0))
            .optional()?;
        Ok(found.is_some())
    }

    pub fn dispatch_context_by_id(&self, id: &str) -> Result<Option<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!("SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_dispatch).optional()?)
    }

    /// The newest dispatch for a task (TS `getDispatchContext`, rowid DESC).
    pub fn get_dispatch_context(&self, task_id: &str) -> Result<Option<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 1"
        ))?;
        Ok(stmt.query_row([task_id], row_to_dispatch).optional()?)
    }

    /// The active (pending/dispatched) dispatch for a terminal (TS `getActiveDispatchForTerminal`).
    pub fn get_active_dispatch_for_terminal(&self, handle: &str) -> Result<Option<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts WHERE assignee_handle = ?1 AND status IN ('pending','dispatched') LIMIT 1"
        ))?;
        Ok(stmt.query_row([handle], row_to_dispatch).optional()?)
    }

    /// The newest dispatch for a terminal regardless of status (TS `getLatestDispatchForTerminal`).
    pub fn get_latest_dispatch_for_terminal(&self, handle: &str) -> Result<Option<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts WHERE assignee_handle = ?1 ORDER BY rowid DESC LIMIT 1"
        ))?;
        Ok(stmt.query_row([handle], row_to_dispatch).optional()?)
    }

    pub fn complete_dispatch(&self, id: &str) -> Result<usize, StoreError> {
        Ok(self.db.connection().execute(
            "UPDATE dispatch_contexts SET status = 'completed', completed_at = datetime('now') WHERE id = ?1",
            params![id],
        )?)
    }

    // db.ts `completeActiveDispatchForTask`: close the newest still-open dispatch
    // for a task (used when the task completes or is gated).
    pub fn complete_active_dispatch_for_task(&self, task_id: &str) -> Result<(), StoreError> {
        let active: Option<String> = self
            .db
            .connection()
            .query_row(
                "SELECT id FROM dispatch_contexts WHERE task_id = ?1 AND status IN ('pending','dispatched') ORDER BY rowid DESC LIMIT 1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = active {
            self.complete_dispatch(&id)?;
        }
        Ok(())
    }

    /// Fail the newest active dispatch for a task, if any (TS `failActiveDispatchForTask`).
    pub fn fail_active_dispatch_for_task(&self, task_id: &str, error: &str) -> Result<Option<DispatchContext>, StoreError> {
        let active: Option<String> = self
            .db
            .connection()
            .query_row(
                "SELECT id FROM dispatch_contexts WHERE task_id = ?1 AND status IN ('pending','dispatched') ORDER BY rowid DESC LIMIT 1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        match active {
            Some(id) => self.fail_dispatch(&id, error),
            None => Ok(None),
        }
    }

    /// Record a dispatch failure (TS `failDispatch`): bumps `failure_count`; the
    /// third failure trips the circuit breaker (`circuit_broken` + task `failed`),
    /// otherwise the dispatch is `failed` and the task returns to `ready`.
    /// Failure also closes the context (`completed_at`) so a dead worker leaves no
    /// open-ended dispatch; `COALESCE` keeps an already-completed row's first stamp.
    pub fn fail_dispatch(&self, id: &str, error: &str) -> Result<Option<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT task_id, failure_count FROM dispatch_contexts WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((task_id, failure_count)) = existing else {
            return Ok(None);
        };
        let new_failure_count = failure_count + 1;
        let new_status = if new_failure_count >= 3 { "circuit_broken" } else { "failed" };
        conn.execute(
            "UPDATE dispatch_contexts
             SET status = ?2, failure_count = ?3, last_failure = ?4,
                 completed_at = COALESCE(completed_at, datetime('now'))
             WHERE id = ?1",
            params![id, new_status, new_failure_count, error],
        )?;
        let task_status = if new_status == "circuit_broken" { "failed" } else { "ready" };
        conn.execute("UPDATE tasks SET status = ?2 WHERE id = ?1", params![task_id, task_status])?;
        self.dispatch_context_by_id(id)
    }

    /// Stamp a liveness heartbeat, but only on a still-`dispatched` context (TS
    /// `recordHeartbeat`): a straggler heartbeat from a completed dispatch must
    /// not revive it. `at` is stored verbatim. Returns rows updated.
    pub fn record_heartbeat(&self, id: &str, at: &str) -> Result<usize, StoreError> {
        Ok(self.db.connection().execute(
            "UPDATE dispatch_contexts SET last_heartbeat_at = ?2 WHERE id = ?1 AND status = 'dispatched'",
            params![id, at],
        )?)
    }

    /// Dispatched contexts past the heartbeat/dispatch-age threshold (TS
    /// `getStaleDispatches`). The stored columns are written by `datetime('now')`
    /// (space-separated, `'2026-07-13 16:59:00'`) while the caller passes an ISO
    /// `T` threshold (`'…T16:50:00.000Z'`). A raw string `<` is byte-lexicographic
    /// and space (0x20) < `T` (0x54), so every same-day timestamp would sort
    /// before any threshold regardless of real time — flagging healthy workers as
    /// stale. Canonicalize BOTH operands with `datetime()` so the compare is by
    /// actual time across either format.
    pub fn get_stale_dispatches(&self, threshold_iso: &str) -> Result<Vec<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts
             WHERE status = 'dispatched'
               AND dispatched_at IS NOT NULL
               AND datetime(dispatched_at) < datetime(?1)
               AND (last_heartbeat_at IS NULL OR datetime(last_heartbeat_at) < datetime(?1))"
        ))?;
        let rows = stmt.query_map([threshold_iso], row_to_dispatch)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Set a dispatch's `dispatched_at` / `last_heartbeat_at` directly (COALESCE:
    /// a `None` leaves the column unchanged). A low-level seam used by tests to
    /// backdate timestamps deterministically; not on the production path.
    pub fn set_dispatch_timestamps(
        &self,
        id: &str,
        dispatched_at: Option<&str>,
        last_heartbeat_at: Option<&str>,
    ) -> Result<usize, StoreError> {
        Ok(self.db.connection().execute(
            "UPDATE dispatch_contexts SET dispatched_at = COALESCE(?2, dispatched_at), last_heartbeat_at = COALESCE(?3, last_heartbeat_at) WHERE id = ?1",
            params![id, dispatched_at, last_heartbeat_at],
        )?)
    }
}
