//! Task rows and the dependency DAG: creation, listing (with the active-dispatch
//! join), status updates, and the ready-promotion that runs in the same writer.

use super::rows::{row_to_task, Task, TaskWithDispatch, TASK_COLUMNS};
use super::run_contract::LEGACY_RUN_ID;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension, Row as SqlRow};

impl OrchestrationDb {
    /// Insert a task (TS `createTask`): empty deps → `ready`, else `pending`.
    /// `deps` is serialized to a JSON string array byte-identical to
    /// `JSON.stringify(deps)`; `task_title`/`display_name` are the shim's
    /// pre-resolved display strings (empty → NULL, done caller-side).
    ///
    /// The Run/parent/dependency membership guards live here rather than in the
    /// shim so a direct store caller (the daemon) cannot cross-link a task into
    /// another Run. Messages match TS `createTask` exactly.
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &self,
        id: &str,
        spec: &str,
        parent_id: Option<&str>,
        deps: &[&str],
        created_by: Option<&str>,
        task_title: Option<&str>,
        display_name: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<Task, StoreError> {
        let deps_json = serde_json::to_string(deps).unwrap_or_else(|_| "[]".to_string());
        let status = if deps.is_empty() { "ready" } else { "pending" };
        let run_id = run_id.unwrap_or(LEGACY_RUN_ID);
        self.require_run(run_id)?;
        if let Some(parent_id) = parent_id {
            self.require_task_in_run(parent_id, run_id, "Parent")?;
        }
        for dep_id in deps {
            self.require_task_in_run(dep_id, run_id, "Dependency")?;
        }
        self.db.connection().execute(
            "INSERT INTO tasks (id, run_id, parent_id, created_by_terminal_handle, task_title, display_name, spec, status, deps)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, run_id, parent_id, created_by, task_title, display_name, spec, status, deps_json],
        )?;
        self.get_task(id)?
            .ok_or_else(|| StoreError::Message("task vanished after insert".into()))
    }

    /// A missing task and a task in another Run fail identically — the caller is
    /// told the id does not belong to `run_id`, never whether it exists elsewhere.
    fn require_task_in_run(&self, task_id: &str, run_id: &str, role: &str) -> Result<(), StoreError> {
        match self.get_task(task_id)? {
            Some(task) if task.run_id == run_id => Ok(()),
            _ => Err(StoreError::Message(format!(
                "{role} task {task_id} must belong to run {run_id}"
            ))),
        }
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_task).optional()?)
    }

    /// Tasks, optionally filtered by status and/or Run, oldest first (TS
    /// `listTasks`; the shim maps its `ready` filter to `status = 'ready'`).
    pub fn list_tasks(&self, status: Option<&str>, run_id: Option<&str>) -> Result<Vec<Task>, StoreError> {
        let conn = self.db.connection();
        let mut clauses: Vec<&str> = Vec::new();
        let mut binds: Vec<&str> = Vec::new();
        // Why: run_id first so the bind order matches db.ts, which prefixes the
        // run predicate onto the status one.
        if let Some(run_id) = run_id {
            clauses.push("run_id = ?");
            binds.push(run_id);
        }
        if let Some(status) = status {
            clauses.push("status = ?");
            binds.push(status);
        }
        let where_clause =
            if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) };
        let mut stmt = conn
            .prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks {where_clause} ORDER BY created_at"))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(binds), row_to_task)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Tasks with their active dispatch's assignee + id (TS `listTasksWithDispatch`).
    /// The inner subquery picks the newest active dispatch per task; non-dispatched
    /// tasks keep NULL join columns.
    pub fn list_tasks_with_dispatch(
        &self,
        status: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<Vec<TaskWithDispatch>, StoreError> {
        let conn = self.db.connection();
        let mut clauses: Vec<&str> = Vec::new();
        let mut binds: Vec<&str> = Vec::new();
        if let Some(run_id) = run_id {
            clauses.push("t.run_id = ?");
            binds.push(run_id);
        }
        if let Some(status) = status {
            clauses.push("t.status = ?");
            binds.push(status);
        }
        let where_clause =
            if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) };
        let sql = format!(
            "SELECT {}, d.assignee_handle AS j_assignee, d.id AS j_dispatch
             FROM tasks t
             LEFT JOIN (
               SELECT dc.* FROM dispatch_contexts dc
               INNER JOIN (
                 SELECT task_id, MAX(rowid) AS max_rowid FROM dispatch_contexts
                 WHERE status IN ('pending', 'dispatched') GROUP BY task_id
               ) latest ON latest.task_id = dc.task_id AND latest.max_rowid = dc.rowid
             ) d ON d.task_id = t.id
             {where_clause}
             ORDER BY t.created_at",
            TASK_COLUMNS.split(", ").map(|c| format!("t.{c}")).collect::<Vec<_>>().join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let map = |row: &SqlRow<'_>| {
            Ok(TaskWithDispatch {
                task: row_to_task(row)?,
                assignee_handle: row.get("j_assignee")?,
                dispatch_id: row.get("j_dispatch")?,
            })
        };
        let rows = stmt
            .query_map(rusqlite::params_from_iter(binds), map)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Update a task's status (TS `updateTaskStatus`). `result` and `completed_at`
    /// are COALESCE'd (a `None` preserves the prior value); the caller passes the
    /// `new Date().toISOString()` stamp for terminal states. Completing a task runs
    /// DAG promotion + closes its active dispatch in this writer.
    pub fn update_task_status(
        &self,
        id: &str,
        status: &str,
        result: Option<&str>,
        completed_at: Option<&str>,
    ) -> Result<Option<Task>, StoreError> {
        self.db.connection().execute(
            "UPDATE tasks SET status = ?2, result = COALESCE(?3, result), completed_at = COALESCE(?4, completed_at) WHERE id = ?1",
            params![id, status, result, completed_at],
        )?;
        if status == "completed" {
            self.promote_ready_tasks(id)?;
            self.complete_active_dispatch_for_task(id)?;
        }
        self.get_task(id)
    }

    fn task_status(&self, id: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .db
            .connection()
            .query_row("SELECT status FROM tasks WHERE id = ?1", params![id], |r| r.get::<_, String>(0))
            .optional()?)
    }

    // Why: when a task completes, promote any `pending` task whose full dep set
    // is now satisfied to `ready`, in the same writer as the status update (TS
    // `promoteReadyTasks`) so there is no half-resolved window.
    //
    // `pub(crate)`: `worker_dispatch` and `federation` settle worker reports
    // inside their own writer and run this there, exactly as the TS does.
    pub(crate) fn promote_ready_tasks(&self, completed_task_id: &str) -> Result<(), StoreError> {
        let candidates: Vec<(String, String)> = {
            let conn = self.db.connection();
            let mut stmt = conn.prepare("SELECT id, deps FROM tasks WHERE status = 'pending'")?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (task_id, deps_json) in candidates {
            let deps: Vec<String> = serde_json::from_str(&deps_json).unwrap_or_default();
            if !deps.iter().any(|dep| dep == completed_task_id) {
                continue;
            }
            let mut all_completed = true;
            for dep_id in &deps {
                if self.task_status(dep_id)?.as_deref() != Some("completed") {
                    all_completed = false;
                    break;
                }
            }
            if all_completed {
                self.db
                    .connection()
                    .execute("UPDATE tasks SET status = 'ready' WHERE id = ?1", params![task_id])?;
            }
        }
        Ok(())
    }
}
