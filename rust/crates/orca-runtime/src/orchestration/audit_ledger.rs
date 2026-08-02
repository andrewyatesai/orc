//! The durable audit ledger (design §7). Append-only is enforced by the schema's
//! `trg_audit_events_append_only` trigger, so there is deliberately no update
//! method here — a "correction" is another event, not a rewrite.

use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, params_from_iter, Row as SqlRow, ToSql};
use serde::Serialize;

pub const AUDIT_EVENT_COLUMNS: &str =
    "id, run_id, actor, action, target_pane_key, target_handle, evidence_ref, detail, created_at";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewAuditEvent {
    pub id: String,
    pub run_id: Option<String>,
    /// `human` | `manager:<handle>` | `service:<name>` — the shim composes it.
    pub actor: String,
    pub action: String,
    pub target_pane_key: Option<String>,
    pub target_handle: Option<String>,
    pub evidence_ref: Option<String>,
    /// Redacted JSON detail. §7's rule — length + hash, never raw credentials —
    /// is the caller's to apply; the store records what it is handed.
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AuditEvent {
    pub id: String,
    pub run_id: Option<String>,
    pub actor: String,
    pub action: String,
    pub target_pane_key: Option<String>,
    pub target_handle: Option<String>,
    pub evidence_ref: Option<String>,
    pub detail: Option<String>,
    pub created_at: String,
}

impl OrchestrationDb {
    pub fn append_audit_event(&self, event: &NewAuditEvent) -> Result<AuditEvent, StoreError> {
        self.db.connection().execute(
            "INSERT INTO audit_events (id, run_id, actor, action, target_pane_key, target_handle, evidence_ref, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.id, event.run_id, event.actor, event.action,
                event.target_pane_key, event.target_handle, event.evidence_ref, event.detail,
            ],
        )?;
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!("SELECT {AUDIT_EVENT_COLUMNS} FROM audit_events WHERE id = ?1"))?;
        stmt.query_row([&event.id], row_to_audit_event)
            .map_err(|_| StoreError::Message("audit event vanished after insert".into()))
    }

    /// Newest first, bounded. `run_id` of `None` is "no filter" — events recorded
    /// outside any run (grant changes, takeovers) still list.
    pub fn list_audit_events(
        &self,
        run_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<AuditEvent>, StoreError> {
        let conn = self.db.connection();
        let mut sql = format!("SELECT {AUDIT_EVENT_COLUMNS} FROM audit_events");
        let mut binds: Vec<&dyn ToSql> = Vec::new();
        if let Some(run_id) = &run_id {
            sql.push_str(" WHERE run_id = ?");
            binds.push(run_id as &dyn ToSql);
        }
        sql.push_str(" ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?");
        binds.push(&limit as &dyn ToSql);
        binds.push(&offset as &dyn ToSql);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), row_to_audit_event)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub(crate) fn row_to_audit_event(row: &SqlRow<'_>) -> rusqlite::Result<AuditEvent> {
    Ok(AuditEvent {
        id: row.get(0)?,
        run_id: row.get(1)?,
        actor: row.get(2)?,
        action: row.get(3)?,
        target_pane_key: row.get(4)?,
        target_handle: row.get(5)?,
        evidence_ref: row.get(6)?,
        detail: row.get(7)?,
        created_at: row.get(8)?,
    })
}
