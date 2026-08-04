//! Which terminals are free to take work: handles seen in message history that
//! hold no active dispatch.

use super::OrchestrationDb;
use orca_store::StoreError;

impl OrchestrationDb {
    /// Terminal handles seen in message history that have no active dispatch (TS
    /// `getIdleTerminals`), excluding `exclude_handles`.
    pub fn get_idle_terminals(&self, exclude_handles: &[&str]) -> Result<Vec<String>, StoreError> {
        let conn = self.db.connection();
        let mut busy: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT assignee_handle FROM dispatch_contexts WHERE status IN ('pending','dispatched') AND assignee_handle IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let collected: rusqlite::Result<std::collections::HashSet<String>> = rows.collect();
            collected?
        };
        for h in exclude_handles {
            busy.insert((*h).to_string());
        }
        let mut stmt = conn
            .prepare("SELECT DISTINCT to_handle FROM messages UNION SELECT DISTINCT from_handle FROM messages")?;
        let all: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut out = Vec::new();
        for handle in all {
            if !busy.contains(&handle) && seen.insert(handle.clone()) {
                out.push(handle);
            }
        }
        Ok(out)
    }
}
