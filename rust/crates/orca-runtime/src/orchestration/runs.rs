//! Lightweight Runs: the unit that scopes an orchestration graph, binds a
//! coordinator pane, and hands that coordinator crash-safe mail deliveries.
//!
//! Ported from the run section of `src/main/runtime/orchestration/db.ts`
//! (`createRun` … `getRunMailboxHistory`).
//! Tables: `runs`, `deliveries`. Constants: [`super::run_contract`].
//!
//! Private TS helpers ported here alongside them: `runsBoundToPane`,
//! `getRunRaw`, `unbindOtherRunsForPane`, `requireRun`, `fenceOutstandingDelivery`,
//! `promoteLegacyCoordinatorMailForTakeover`, `getUniqueLegacyCoordinatorHandle`,
//! `requireCurrentConsumer`, `getDeliveryRaw`, `getDeliveryMessages`.
//!
//! Timestamps come back exactly as SQLite wrote them: the TS twin's
//! `exposeRunTimestamps`/`exposeDeliveryTimestamps` RFC3339 rewrite lives on the
//! JSON boundary (`db-message-timestamp.ts`), not in the store. The `listRuns`
//! keyset cursor therefore carries the raw `created_at`, which is what the SQL
//! comparison uses.

use super::base64url;
use super::error::OrchestrationError;
use super::pane_key::{is_equivalent_pane_key, pane_key_match_suffix, PANE_KEY_MATCH_SUFFIX_SQL};
use super::rows::{
    row_to_delivery, row_to_message, row_to_run, Delivery, Message, Run, RunListPage,
    DELIVERY_COLUMNS, MESSAGE_COLUMNS, RUN_COLUMNS,
};
use super::run_contract::{LEGACY_CONTRACT_VERSION, RUN_PAGE_LIMIT};
use super::sql_fragments::{placeholders, type_filter_clause};
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, params_from_iter, OptionalExtension, ToSql};
use std::collections::BTreeSet;

/// TS `getOrCreateRunDelivery` page ceiling (`Math.min(Math.max(limit ?? 50, 1), 50)`).
const DELIVERY_PAGE_LIMIT: i64 = 50;

/// TS `bindRun(params.legacyCoordinatorAuthority)` — proof that the caller already
/// holds the legacy coordinator seat it is taking over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyCoordinatorAuthority {
    pub run_id: String,
    pub principal_id: Option<String>,
    pub terminal_handle: String,
    pub pane_key: String,
    pub consumer_generation: i64,
}

/// TS `bindRun(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BindRunParams {
    pub run_id: String,
    pub coordinator_handle: String,
    pub coordinator_pane_key: String,
    pub takeover_legacy: bool,
    pub legacy_coordinator_authority: Option<LegacyCoordinatorAuthority>,
}

/// TS `getOrCreateRunDelivery(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunDeliveryRequest {
    pub run_id: String,
    pub consumer_generation: i64,
    /// Caller-generated `delivery_<hex>` id (the shim's `generateId('delivery')`),
    /// consumed only when this call actually cuts a new delivery — the TS twin
    /// mints it inline, and the fork keeps every generated id caller-supplied so
    /// the store stays deterministic.
    pub delivery_id: String,
    /// TS default 50 when absent.
    pub limit: Option<i64>,
    pub wake_types: Option<Vec<String>>,
}

/// TS `{ delivery; messages; replayed }` — `replayed` marks an outstanding
/// delivery handed back unchanged after a consumer crash.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct RunDelivery {
    pub delivery: Delivery,
    pub messages: Vec<Message>,
    pub replayed: bool,
}

/// TS `{ delivery; duplicate }` from `acknowledgeRunDelivery`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct RunDeliveryAck {
    pub delivery: Delivery,
    pub duplicate: bool,
}

/// TS `RunListCursor`. Field order is the `JSON.stringify` key order the TS twin
/// base64url-encodes, so a cursor minted by either side decodes on the other.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct RunListCursor {
    #[serde(rename = "createdAt")]
    created_at: String,
    id: String,
}

impl OrchestrationDb {
    /// TS `createRun`. Caller supplies the generated `run_<hex>` id.
    pub fn create_run(
        &self,
        id: &str,
        objective: &str,
        coordinator_handle: &str,
        coordinator_pane_key: &str,
    ) -> Result<Run, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        // Why: COMMIT sits inside the fallible path (as in the TS try block), so a
        // failed COMMIT rolls back instead of leaving a half-bound pane.
        let written = self
            .create_run_in_transaction(id, objective, coordinator_handle, coordinator_pane_key)
            .and_then(|()| self.db.exec("COMMIT"));
        if let Err(error) = written {
            self.db.exec("ROLLBACK")?;
            return Err(error);
        }
        self.get_run(id)?
            .ok_or_else(|| StoreError::Message("run vanished after insert".into()))
    }

    fn create_run_in_transaction(
        &self,
        id: &str,
        objective: &str,
        coordinator_handle: &str,
        coordinator_pane_key: &str,
    ) -> Result<(), StoreError> {
        self.unbind_other_runs_for_pane(coordinator_pane_key, None)?;
        self.db.connection().execute(
            "INSERT INTO runs (
               id, objective, coordinator_handle, coordinator_pane_key,
               consumer_generation, legacy
             ) VALUES (?1, ?2, ?3, ?4, 1, 0)",
            params![id, objective, coordinator_handle, coordinator_pane_key],
        )?;
        Ok(())
    }

    /// TS `getRun` (and its `getRunRaw` twin — the two differ only by the
    /// RFC3339 exposure the fork does at the JSON boundary).
    pub fn get_run(&self, id: &str) -> Result<Option<Run>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_run).optional()?)
    }

    /// TS `listRuns` — newest first, `(created_at, id)` keyset cursor, page
    /// ceiling [`super::run_contract::RUN_PAGE_LIMIT`]. Both arguments absent is
    /// the unpaginated compatibility read: every Run, no cursor.
    pub fn list_runs(
        &self,
        limit: Option<i64>,
        cursor: Option<&str>,
    ) -> Result<RunListPage, StoreError> {
        let conn = self.db.connection();
        if limit.is_none() && cursor.is_none() {
            let mut stmt = conn.prepare(&format!(
                "SELECT {RUN_COLUMNS} FROM runs ORDER BY created_at DESC, id DESC"
            ))?;
            let runs = stmt.query_map([], row_to_run)?.collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(RunListPage { runs, next_cursor: None });
        }
        let limit = limit.unwrap_or(RUN_PAGE_LIMIT).max(1).min(RUN_PAGE_LIMIT);
        // Why: an empty cursor string is falsy in the TS twin, so it means "no
        // cursor" rather than a decode failure.
        let cursor = match cursor.filter(|value| !value.is_empty()) {
            Some(value) => Some(decode_run_list_cursor(value)?),
            None => None,
        };
        // One page is read over `limit + 1` rows so the extra row answers "is there
        // a next page?" without a second COUNT.
        let page_size = limit + 1;
        let mut sql = format!("SELECT {RUN_COLUMNS} FROM runs");
        let mut binds: Vec<&dyn ToSql> = Vec::new();
        if let Some(cursor) = &cursor {
            sql.push_str(" WHERE created_at < ? OR (created_at = ? AND id < ?)");
            binds.push(&cursor.created_at);
            binds.push(&cursor.created_at);
            binds.push(&cursor.id);
        }
        sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
        binds.push(&page_size);
        let mut stmt = conn.prepare(&sql)?;
        let mut rows =
            stmt.query_map(params_from_iter(binds), row_to_run)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = rows.len() as i64 > limit;
        if has_more {
            rows.truncate(limit as usize);
        }
        let next_cursor = if has_more { rows.last().map(encode_run_list_cursor) } else { None };
        Ok(RunListPage { runs: rows, next_cursor })
    }

    /// TS `bindRun` — moves the coordinator seat to a new handle/pane, bumping
    /// `consumer_generation` and fencing the outstanding delivery. `None` when
    /// the run does not exist (or is the synthetic legacy Run).
    pub fn bind_run(&self, params: &BindRunParams) -> Result<Option<Run>, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        let bound = self
            .bind_run_in_transaction(params)
            .and_then(|bound| if bound { self.db.exec("COMMIT").map(|()| bound) } else { Ok(bound) });
        match bound {
            Ok(true) => self.get_run(&params.run_id),
            // The TS twin rolls back before returning undefined, so a rejected
            // bind leaves no partially applied unbinding behind.
            Ok(false) => {
                self.db.exec("ROLLBACK")?;
                Ok(None)
            }
            Err(error) => {
                self.db.exec("ROLLBACK")?;
                Err(error)
            }
        }
    }

    fn bind_run_in_transaction(&self, params: &BindRunParams) -> Result<bool, StoreError> {
        let conn = self.db.connection();
        let Some(run) = self.get_run(&params.run_id)? else {
            return Ok(false);
        };
        if run.legacy == 1 {
            return Ok(false);
        }
        let same_binding = run
            .coordinator_pane_key
            .as_deref()
            .is_some_and(|key| is_equivalent_pane_key(key, &params.coordinator_pane_key));
        let adoption = self.get_legacy_adoption()?;
        let adopted_run = adoption.is_some_and(|adoption| adoption.adopted_run_id == params.run_id);
        let authority = params.legacy_coordinator_authority.as_ref();
        // A null/empty principal id is falsy in the TS twin: no principal is read,
        // so the binding can never be proven.
        let legacy_principal = match authority
            .and_then(|authority| authority.principal_id.as_deref())
            .filter(|id| !id.is_empty())
        {
            Some(id) => self.get_legacy_compatibility_principal(id)?,
            None => None,
        };
        let proven_legacy_binding = adopted_run
            && authority.is_some_and(|authority| {
                authority.principal_id.is_some()
                    && authority.run_id == params.run_id
                    && authority.consumer_generation == run.consumer_generation
                    && legacy_principal.as_ref().is_some_and(|principal| {
                        principal.run_id == params.run_id
                            && principal.role == "coordinator"
                            && principal.status == "committed"
                            && principal.terminal_handle == authority.terminal_handle
                            && is_equivalent_pane_key(&principal.pane_key, &authority.pane_key)
                    })
                    && params.coordinator_handle == authority.terminal_handle
                    && is_equivalent_pane_key(&params.coordinator_pane_key, &authority.pane_key)
            });
        if authority.is_some() && !proven_legacy_binding {
            return Err(OrchestrationError::with_data(
                "legacy_read_only",
                "This retained legacy coordinator no longer has lifecycle authority. No effects were applied.",
                serde_json::json!({ "effectsApplied": false }),
            )
            .into());
        }
        let active_legacy_assignment = adopted_run
            && conn
                .query_row(
                    "SELECT 1 FROM dispatch_contexts
                     WHERE run_id = ?1 AND contract_version = ?2
                       AND status IN ('pending', 'dispatched')
                     LIMIT 1",
                    params![params.run_id, LEGACY_CONTRACT_VERSION],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
        let coordinator_principal = if adopted_run {
            self.get_legacy_coordinator_principal(&params.run_id)?
        } else {
            None
        };
        let retained_coordinator_handle = match coordinator_principal
            .as_ref()
            .map(|principal| principal.terminal_handle.clone())
            .or_else(|| run.coordinator_handle.clone())
        {
            Some(handle) => Some(handle),
            None => self.unique_legacy_coordinator_handle(&params.run_id)?,
        };
        let takeover_already_applied = params.takeover_legacy
            && same_binding
            && run.coordinator_handle.as_deref() == Some(params.coordinator_handle.as_str())
            && coordinator_principal.as_ref().map(|principal| principal.status.as_str())
                != Some("committed");
        let replaces_legacy_coordinator = adopted_run
            && !proven_legacy_binding
            && retained_coordinator_handle.as_deref().is_some_and(|handle| !handle.is_empty())
            && (params.takeover_legacy
                || retained_coordinator_handle.as_deref()
                    != Some(params.coordinator_handle.as_str())
                || !same_binding);
        if params.takeover_legacy && !adopted_run {
            return Err(OrchestrationError::new(
                "invalid_argument",
                "Legacy takeover is only available for the automatically adopted Run.",
            )
            .into());
        }
        // Why: only LIVE legacy work needs the flag — settled work has no competing authority left, and
        // fencing it would strand the recovered graph behind an attestation the caller may not have.
        if active_legacy_assignment
            && !same_binding
            && !proven_legacy_binding
            && !params.takeover_legacy
        {
            return Err(OrchestrationError::with_data(
                "consumer_fenced",
                "This adopted Run still has live legacy work. Its attested coordinator may rebind it, or a current coordinator may explicitly use run-use --takeover-legacy.",
                serde_json::json!({
                    "effectsApplied": false,
                    "recoveryCommand": format!(
                        "orca orchestration run-use --id {} --takeover-legacy",
                        params.run_id
                    ),
                }),
            )
            .into());
        }
        self.unbind_other_runs_for_pane(&params.coordinator_pane_key, Some(&params.run_id))?;
        if (params.takeover_legacy && !takeover_already_applied)
            || !same_binding
            || run.coordinator_handle.as_deref() != Some(params.coordinator_handle.as_str())
        {
            if adopted_run && (params.takeover_legacy || !active_legacy_assignment) {
                if let Some(principal) = coordinator_principal.as_ref() {
                    if principal.status == "committed"
                        && (params.takeover_legacy
                            || principal.terminal_handle != params.coordinator_handle
                            || !is_equivalent_pane_key(
                                &principal.pane_key,
                                &params.coordinator_pane_key,
                            ))
                    {
                        self.set_legacy_compatibility_principal_status(&principal.id, "revoked")?;
                    }
                }
            }
            conn.execute(
                "UPDATE runs
                 SET coordinator_handle = ?1, coordinator_pane_key = ?2,
                     consumer_generation = consumer_generation + 1,
                     updated_at = datetime('now')
                 WHERE id = ?3",
                params![params.coordinator_handle, params.coordinator_pane_key, params.run_id],
            )?;
            self.fence_outstanding_delivery(&params.run_id)?;
            if params.takeover_legacy || replaces_legacy_coordinator {
                self.promote_legacy_coordinator_mail_for_takeover(
                    &params.run_id,
                    retained_coordinator_handle.as_deref(),
                )?;
            }
        }
        Ok(true)
    }

    /// TS `getCurrentRunForPane` — resolves by pane-key equivalence, not by
    /// handle, so a reminted terminal keeps its Run.
    pub fn get_current_run_for_pane(&self, pane_key: &str) -> Result<Option<Run>, StoreError> {
        Ok(self.runs_bound_to_pane(pane_key)?.into_iter().next())
    }

    /// TS `runsBoundToPane`. The indexed suffix only narrows candidates;
    /// `isEquivalentPaneKey` still decides, so reminted tab halves keep matching
    /// and unparseable keys keep requiring an exact match.
    fn runs_bound_to_pane(&self, pane_key: &str) -> Result<Vec<Run>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM runs
             WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
               AND {PANE_KEY_MATCH_SUFFIX_SQL} = ?1
             ORDER BY rowid"
        ))?;
        let rows = stmt.query_map([pane_key_match_suffix(pane_key)], row_to_run)?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|run| {
                run.coordinator_pane_key
                    .as_deref()
                    .is_some_and(|key| is_equivalent_pane_key(key, pane_key))
            })
            .collect())
    }

    /// TS `unbindOtherRunsForPane` — one pane may hold at most one Run, so every
    /// other Run on it loses its seat and has its outstanding delivery fenced.
    fn unbind_other_runs_for_pane(
        &self,
        pane_key: &str,
        except_run_id: Option<&str>,
    ) -> Result<(), StoreError> {
        for run in self.runs_bound_to_pane(pane_key)? {
            if Some(run.id.as_str()) == except_run_id {
                continue;
            }
            self.db.connection().execute(
                "UPDATE runs
                 SET coordinator_handle = NULL, coordinator_pane_key = NULL,
                     consumer_generation = consumer_generation + 1,
                     updated_at = datetime('now')
                 WHERE id = ?1",
                params![run.id],
            )?;
            self.fence_outstanding_delivery(&run.id)?;
        }
        Ok(())
    }

    /// TS `requireRun` — a plain `Error`, not a coded orchestration failure.
    /// Shared: every run-scoped write in the other domain modules asserts with it.
    pub(crate) fn require_run(&self, run_id: &str) -> Result<(), StoreError> {
        match self.get_run(run_id)? {
            Some(_) => Ok(()),
            None => Err(StoreError::Message(format!("Run not found: {run_id}"))),
        }
    }

    /// TS `fenceOutstandingDelivery`.
    fn fence_outstanding_delivery(&self, run_id: &str) -> Result<(), StoreError> {
        self.db.connection().execute(
            "UPDATE deliveries SET status = 'fenced' WHERE run_id = ?1 AND status = 'outstanding'",
            params![run_id],
        )?;
        Ok(())
    }

    /// TS `promoteLegacyCoordinatorMailForTakeover`, on the store handle.
    fn promote_legacy_coordinator_mail_for_takeover(
        &self,
        run_id: &str,
        retained_coordinator_handle: Option<&str>,
    ) -> Result<(), StoreError> {
        promote_legacy_coordinator_mail(
            self.db.connection(),
            run_id,
            retained_coordinator_handle,
        )
    }
}

/// TS `promoteLegacyCoordinatorMailForTakeover` — re-addresses the retained
/// legacy coordinator's still-actionable mail to the Run address so the new
/// current coordinator inherits it. A missing retained handle is a no-op.
///
/// Why a free fn on `&Connection`: `legacy_compat`'s v20 migration runs the same
/// statement before an `OrchestrationDb` exists, and one statement is the only
/// way the two paths cannot drift.
pub(crate) fn promote_legacy_coordinator_mail(
    conn: &rusqlite::Connection,
    run_id: &str,
    retained_coordinator_handle: Option<&str>,
) -> Result<(), StoreError> {
    let Some(retained) = retained_coordinator_handle.filter(|handle| !handle.is_empty()) else {
        return Ok(());
    };
    conn.execute(
        "UPDATE messages
             SET to_handle = ?1, delivery_contract = 'current_delivery',
                 read = 0, delivered_at = NULL
             WHERE run_id = ?2 AND delivery_contract = 'legacy_direct'
               AND to_handle = ?3
               AND EXISTS(
                 SELECT 1 FROM dispatch_contexts d
                 WHERE d.run_id = messages.run_id
                   AND d.contract_version = ?4
                   AND (
                     messages.from_handle = d.assignee_handle OR
                     messages.from_handle = 'dispatch:' || d.id
                   )
               )
               AND (
                 read = 0 OR EXISTS(
                   SELECT 1 FROM question_threads q
                   WHERE q.message_id = messages.id AND q.status = 'pending'
                 ) OR EXISTS(
                   SELECT 1
                   FROM legacy_mail_receipts r
                   INNER JOIN legacy_compatibility_principals p
                     ON p.id = r.principal_id
                   WHERE r.message_id = messages.id
                     AND r.acknowledged_at IS NULL
                     AND p.run_id = messages.run_id
                     AND p.role = 'coordinator'
                     AND p.terminal_handle = ?5
                 ) OR (
                   read = 1
                   AND NOT EXISTS(
                     SELECT 1 FROM legacy_compatibility_principals p
                     WHERE p.run_id = messages.run_id AND p.role = 'coordinator'
                   )
                   AND EXISTS(
                     SELECT 1 FROM dispatch_contexts d
                     WHERE d.run_id = messages.run_id
                       AND d.contract_version = ?6
                       AND d.status IN ('pending', 'dispatched')
                       AND messages.created_at >= d.created_at
                       AND (
                         messages.from_handle = d.assignee_handle OR
                         messages.from_handle = 'dispatch:' || d.id
                       )
                   )
                 )
               )",
        params![
            format!("run:{run_id}"),
            run_id,
            retained,
            LEGACY_CONTRACT_VERSION,
            retained,
            LEGACY_CONTRACT_VERSION,
        ],
    )?;
    Ok(())
}

impl OrchestrationDb {
    /// TS `getUniqueLegacyCoordinatorHandle` — the one handle that provably acted
    /// as the adopted Run's coordinator, or `None` when the evidence is ambiguous
    /// (any candidate that also worked the Run disqualifies the whole inference).
    pub(crate) fn unique_legacy_coordinator_handle(
        &self,
        run_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let conn = self.db.connection();
        let Some(adoption) = self.get_legacy_adoption()? else {
            return Ok(None);
        };
        if adoption.adopted_run_id != run_id {
            return Ok(None);
        }
        let mut worker_handles: BTreeSet<String> = BTreeSet::new();
        {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT assignee_handle AS handle
                 FROM dispatch_contexts
                 WHERE run_id = ?1 AND contract_version = ?2
                   AND assignee_handle IS NOT NULL
                 UNION
                 SELECT DISTINCT terminal_handle AS handle
                 FROM legacy_compatibility_principals
                 WHERE run_id = ?3 AND role = 'worker'
                   AND status IN ('committed', 'settled')",
            )?;
            let rows = stmt.query_map(
                params![run_id, LEGACY_CONTRACT_VERSION, run_id],
                |row| row.get::<_, String>(0),
            )?;
            for handle in rows {
                worker_handles.insert(handle?);
            }
        }
        let durable: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT coordinator_handle AS handle
                 FROM coordinator_runs
                 WHERE scheduler_lost_at = ?1
                 UNION
                 SELECT created_by_terminal_handle AS handle
                 FROM tasks t
                 WHERE t.run_id = ?2 AND t.created_by_terminal_handle IS NOT NULL
                   AND t.created_at <= ?3
                   AND EXISTS(
                     SELECT 1 FROM dispatch_contexts d
                     WHERE d.task_id = t.id AND d.run_id = t.run_id
                       AND d.contract_version = ?4
                   )",
            )?;
            let rows = stmt.query_map(
                params![adoption.adopted_at, run_id, adoption.adopted_at, LEGACY_CONTRACT_VERSION],
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if durable.iter().any(|handle| worker_handles.contains(handle)) {
            return Ok(None);
        }
        let mut candidates: BTreeSet<String> = durable.into_iter().collect();
        let mail: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT m.to_handle AS handle
                 FROM messages m
                 INNER JOIN dispatch_contexts d
                   ON d.run_id = m.run_id AND d.contract_version = ?1
                  AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
                 WHERE m.run_id = ?2 AND m.delivery_contract = 'legacy_direct'
                   AND m.created_at <= ?3
                 UNION
                 SELECT m.from_handle AS handle
                 FROM messages m
                 INNER JOIN dispatch_contexts d
                   ON d.run_id = m.run_id AND d.contract_version = ?4
                  AND (m.to_handle = d.assignee_handle OR m.to_handle = 'dispatch:' || d.id)
                 WHERE m.run_id = ?5 AND m.delivery_contract = 'legacy_direct'
                   AND m.created_at <= ?6",
            )?;
            let rows = stmt.query_map(
                params![
                    LEGACY_CONTRACT_VERSION,
                    run_id,
                    adoption.adopted_at,
                    LEGACY_CONTRACT_VERSION,
                    run_id,
                    adoption.adopted_at,
                ],
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for handle in mail {
            if !worker_handles.contains(&handle)
                && !handle.starts_with("dispatch:")
                && !handle.starts_with("run:")
            {
                candidates.insert(handle);
            }
        }
        Ok(if candidates.len() == 1 { candidates.into_iter().next() } else { None })
    }

    /// TS `requireCurrentConsumer` — the mailbox fence. Shared: the question and
    /// legacy domains gate their consumer-scoped writes on it too.
    pub(crate) fn require_current_consumer(
        &self,
        run_id: &str,
        consumer_generation: i64,
    ) -> Result<Run, StoreError> {
        match self.get_run(run_id)? {
            Some(run)
                if run.legacy != 1 && run.consumer_generation == consumer_generation =>
            {
                Ok(run)
            }
            _ => Err(OrchestrationError::new(
                "consumer_fenced",
                "This mailbox consumer has been replaced. Rebind with orchestration run-use.",
            )
            .into()),
        }
    }

    /// TS `getDeliveryRaw`.
    fn runs_delivery_row(&self, id: &str) -> Result<Option<Delivery>, StoreError> {
        let conn = self.db.connection();
        let mut stmt =
            conn.prepare(&format!("SELECT {DELIVERY_COLUMNS} FROM deliveries WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_delivery).optional()?)
    }

    /// TS `getDeliveryMessages` — the delivery's messages in the order the
    /// delivery recorded them, silently dropping ids whose row is gone.
    fn runs_delivery_messages(&self, delivery: &Delivery) -> Result<Vec<Message>, StoreError> {
        let ids: Vec<String> = serde_json::from_str(&delivery.message_ids).map_err(|error| {
            StoreError::Message(format!(
                "delivery {} has an unreadable message_ids array: {error}",
                delivery.id
            ))
        })?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages WHERE id IN ({})",
            placeholders(ids.len())
        ))?;
        let binds: Vec<&dyn ToSql> = ids.iter().map(|id| id as &dyn ToSql).collect();
        let rows = stmt
            .query_map(params_from_iter(binds), row_to_message)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids
            .iter()
            .filter_map(|id| rows.iter().find(|row| &row.id == id).cloned())
            .collect())
    }

    /// TS `getOrCreateRunDelivery` — replays the outstanding delivery if one
    /// exists, else cuts a new one from the run's undelivered mail. `None` when
    /// there is nothing to deliver.
    pub fn get_or_create_run_delivery(
        &self,
        request: &RunDeliveryRequest,
    ) -> Result<Option<RunDelivery>, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        let delivered = self
            .get_or_create_run_delivery_in_transaction(request)
            .and_then(|value| self.db.exec("COMMIT").map(|()| value));
        match delivered {
            Ok(value) => Ok(value),
            Err(error) => {
                self.db.exec("ROLLBACK")?;
                Err(error)
            }
        }
    }

    fn get_or_create_run_delivery_in_transaction(
        &self,
        request: &RunDeliveryRequest,
    ) -> Result<Option<RunDelivery>, StoreError> {
        let limit = request.limit.unwrap_or(DELIVERY_PAGE_LIMIT).max(1).min(DELIVERY_PAGE_LIMIT);
        self.require_current_consumer(&request.run_id, request.consumer_generation)?;
        let conn = self.db.connection();
        let existing = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {DELIVERY_COLUMNS} FROM deliveries WHERE run_id = ?1 AND status = 'outstanding'"
            ))?;
            stmt.query_row([&request.run_id], row_to_delivery).optional()?
        };
        if let Some(existing) = existing {
            if existing.consumer_generation != request.consumer_generation {
                return Err(OrchestrationError::new(
                    "consumer_fenced",
                    "This mailbox Delivery belongs to a fenced consumer generation.",
                )
                .into());
            }
            let messages = self.runs_delivery_messages(&existing)?;
            return Ok(Some(RunDelivery { delivery: existing, messages, replayed: true }));
        }

        let address = format!("run:{}", request.run_id);
        if let Some(wake_types) = request.wake_types.as_ref().filter(|types| !types.is_empty()) {
            let sql = format!(
                "SELECT 1 FROM messages
                 WHERE run_id = ? AND to_handle = ? AND read = 0
                   AND delivery_contract = 'current_delivery'
                   AND type IN ({}) LIMIT 1",
                placeholders(wake_types.len())
            );
            let mut binds: Vec<&dyn ToSql> = vec![&request.run_id, &address];
            for wake_type in wake_types {
                binds.push(wake_type as &dyn ToSql);
            }
            let matching =
                conn.query_row(&sql, params_from_iter(binds), |_| Ok(())).optional()?;
            if matching.is_none() {
                return Ok(None);
            }
        }

        let mut stmt = conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages
             WHERE run_id = ?1 AND to_handle = ?2 AND read = 0
               AND delivery_contract = 'current_delivery'
             ORDER BY sequence ASC LIMIT ?3"
        ))?;
        let messages = stmt
            .query_map(params![request.run_id, address, limit], row_to_message)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if messages.is_empty() {
            return Ok(None);
        }

        let message_ids = serde_json::to_string(
            &messages.iter().map(|message| message.id.as_str()).collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO deliveries (id, run_id, consumer_generation, message_ids)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                request.delivery_id,
                request.run_id,
                request.consumer_generation,
                message_ids
            ],
        )?;
        let delivery = self
            .runs_delivery_row(&request.delivery_id)?
            .ok_or_else(|| StoreError::Message("delivery vanished after insert".into()))?;
        Ok(Some(RunDelivery { delivery, messages, replayed: false }))
    }

    /// TS `acknowledgeRunDelivery` — settles a delivery for the current consumer
    /// generation; acknowledging an already-settled delivery is a duplicate, not
    /// an error.
    pub fn acknowledge_run_delivery(
        &self,
        run_id: &str,
        consumer_generation: i64,
        delivery_id: &str,
    ) -> Result<RunDeliveryAck, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        let acknowledged = self
            .acknowledge_run_delivery_in_transaction(run_id, consumer_generation, delivery_id)
            .and_then(|value| self.db.exec("COMMIT").map(|()| value));
        match acknowledged {
            Ok(value) => Ok(value),
            Err(error) => {
                self.db.exec("ROLLBACK")?;
                Err(error)
            }
        }
    }

    fn acknowledge_run_delivery_in_transaction(
        &self,
        run_id: &str,
        consumer_generation: i64,
        delivery_id: &str,
    ) -> Result<RunDeliveryAck, StoreError> {
        self.require_current_consumer(run_id, consumer_generation)?;
        let Some(delivery) =
            self.runs_delivery_row(delivery_id)?.filter(|delivery| delivery.run_id == run_id)
        else {
            return Err(OrchestrationError::new(
                "stale_delivery",
                format!("Delivery {delivery_id} does not belong to this Run."),
            )
            .into());
        };
        if delivery.consumer_generation != consumer_generation || delivery.status == "fenced" {
            return Err(OrchestrationError::new(
                "consumer_fenced",
                "This mailbox Delivery belongs to a fenced consumer generation.",
            )
            .into());
        }
        if delivery.status == "acknowledged" {
            return Ok(RunDeliveryAck { delivery, duplicate: true });
        }

        let conn = self.db.connection();
        let message_ids: Vec<String> =
            serde_json::from_str(&delivery.message_ids).map_err(|error| {
                StoreError::Message(format!(
                    "delivery {} has an unreadable message_ids array: {error}",
                    delivery.id
                ))
            })?;
        if !message_ids.is_empty() {
            let sql = format!(
                "UPDATE messages SET read = 1 WHERE id IN ({})",
                placeholders(message_ids.len())
            );
            let binds: Vec<&dyn ToSql> = message_ids.iter().map(|id| id as &dyn ToSql).collect();
            conn.execute(&sql, params_from_iter(binds))?;
        }
        conn.execute(
            "UPDATE deliveries SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?1",
            params![delivery.id],
        )?;
        let acknowledged = self
            .runs_delivery_row(&delivery.id)?
            .ok_or_else(|| StoreError::Message("delivery vanished after acknowledgement".into()))?;
        Ok(RunDeliveryAck { delivery: acknowledged, duplicate: false })
    }

    /// TS `hasPendingCurrentDelivery` — is there an outstanding delivery for the
    /// run right now? Scoped to the current delivery contract, so promoted-away
    /// `legacy_direct` mail never counts.
    pub fn has_pending_current_delivery(&self, run_id: &str) -> Result<bool, StoreError> {
        Ok(self
            .db
            .connection()
            .query_row(
                "SELECT 1 FROM messages
                 WHERE run_id = ?1 AND to_handle = ?2
                   AND delivery_contract = 'current_delivery' AND read = 0
                 LIMIT 1",
                params![run_id, format!("run:{run_id}")],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// TS `getRunMailboxHistory` — the run's mail newest-first, never touching
    /// the read bit. TS default limit 100.
    pub fn get_run_mailbox_history(
        &self,
        run_id: &str,
        limit: i64,
        types: Option<&[String]>,
    ) -> Result<Vec<Message>, StoreError> {
        let address = format!("run:{run_id}");
        let filter = type_filter_clause("type", types);
        let sql = format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages WHERE run_id = ? AND to_handle = ?{filter}
             ORDER BY sequence DESC LIMIT ?"
        );
        let mut binds: Vec<&dyn ToSql> = vec![&run_id, &address];
        if let Some(types) = types.filter(|types| !types.is_empty()) {
            for message_type in types {
                binds.push(message_type as &dyn ToSql);
            }
        }
        binds.push(&limit as &dyn ToSql);
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), row_to_message)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

// ---------------------------------------------------------------------------
// listRuns cursor codec: Node `Buffer.toString('base64url')`, shared with capability minting.

/// TS `encodeRunListCursor` — over the RAW `created_at`, which is what the
/// keyset comparison in `listRuns` binds.
fn encode_run_list_cursor(run: &Run) -> String {
    let cursor = RunListCursor { created_at: run.created_at.clone(), id: run.id.clone() };
    base64url::encode(serde_json::to_string(&cursor).unwrap_or_default().as_bytes())
}

/// TS `decodeRunListCursor` — every malformed shape collapses to `cursor_invalid`.
fn decode_run_list_cursor(value: &str) -> Result<RunListCursor, StoreError> {
    fn invalid() -> StoreError {
        OrchestrationError::new("cursor_invalid", "The Run list cursor is invalid.").into()
    }
    let bytes = base64url::decode(value).ok_or_else(invalid)?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    serde_json::from_str::<RunListCursor>(&text).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::run_contract::{DELIVERY_CONTRACT_CURRENT, LEGACY_RUN_ID};

    const LEAF_A: &str = "0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
    const LEAF_B: &str = "1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d";

    fn store() -> OrchestrationDb {
        OrchestrationDb::open_in_memory().unwrap()
    }

    fn error_code(error: &StoreError) -> String {
        let StoreError::Message(text) = error else {
            panic!("expected a coded message error, got {error:?}");
        };
        let parsed: serde_json::Value = serde_json::from_str(text)
            .unwrap_or_else(|_| panic!("expected an orchestration error envelope, got {text}"));
        parsed["code"].as_str().unwrap().to_string()
    }

    fn error_data(error: &StoreError) -> serde_json::Value {
        let StoreError::Message(text) = error else {
            panic!("expected a coded message error, got {error:?}");
        };
        serde_json::from_str::<serde_json::Value>(text).unwrap()["data"].clone()
    }

    /// Insert run-scoped mail directly: `insert_run_message` is another module's
    /// stub, and these tests need explicit `run_id` / `delivery_contract` values.
    fn mail(
        db: &OrchestrationDb,
        id: &str,
        run_id: &str,
        to_handle: &str,
        message_type: &str,
        contract: &str,
    ) {
        db.connection()
            .execute(
                "INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, body, type)
                 VALUES (?1, ?2, ?3, 'worker-a', ?4, ?5, '', ?6)",
                params![id, run_id, contract, to_handle, format!("subject {id}"), message_type],
            )
            .unwrap();
    }

    fn run_mail(db: &OrchestrationDb, id: &str, run_id: &str, message_type: &str) {
        mail(db, id, run_id, &format!("run:{run_id}"), message_type, DELIVERY_CONTRACT_CURRENT);
    }

    fn generation(db: &OrchestrationDb, run_id: &str) -> i64 {
        db.get_run(run_id).unwrap().unwrap().consumer_generation
    }

    fn delivery_status(db: &OrchestrationDb, id: &str) -> String {
        db.connection()
            .query_row("SELECT status FROM deliveries WHERE id = ?1", params![id], |row| row.get(0))
            .unwrap()
    }

    fn bind(run_id: &str, handle: &str, pane_key: &str) -> BindRunParams {
        BindRunParams {
            run_id: run_id.to_string(),
            coordinator_handle: handle.to_string(),
            coordinator_pane_key: pane_key.to_string(),
            takeover_legacy: false,
            legacy_coordinator_authority: None,
        }
    }

    fn request(run_id: &str, generation: i64, delivery_id: &str) -> RunDeliveryRequest {
        RunDeliveryRequest {
            run_id: run_id.to_string(),
            consumer_generation: generation,
            delivery_id: delivery_id.to_string(),
            limit: None,
            wake_types: None,
        }
    }

    #[test]
    fn create_run_seats_the_coordinator_and_unbinds_the_pane_incumbent() {
        let db = store();
        let first = db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        assert_eq!(first.consumer_generation, 1);
        assert_eq!(first.legacy, 0);
        assert_eq!(first.home_database, "this_database");
        assert_eq!(first.coordinator_handle.as_deref(), Some("term-1"));

        // The incumbent holds an outstanding delivery that must be fenced when the
        // pane is taken over — matched by leaf, so a reminted tab still collides.
        run_mail(&db, "m1", "run_a", "status");
        db.get_or_create_run_delivery(&request("run_a", 1, "delivery_1")).unwrap().unwrap();

        let second =
            db.create_run("run_b", "other", "term-2", &format!("tab2:{LEAF_A}")).unwrap();
        assert_eq!(second.consumer_generation, 1);

        let evicted = db.get_run("run_a").unwrap().unwrap();
        assert_eq!(evicted.coordinator_handle, None);
        assert_eq!(evicted.coordinator_pane_key, None);
        assert_eq!(evicted.consumer_generation, 2);
        assert_eq!(delivery_status(&db, "delivery_1"), "fenced");
        assert_eq!(db.get_current_run_for_pane(&format!("tab9:{LEAF_A}")).unwrap().unwrap().id, "run_b");
    }

    #[test]
    fn get_run_and_require_run_agree_on_absence() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        assert_eq!(db.get_run("run_a").unwrap().unwrap().objective, "ship it");
        assert!(db.get_run("nope").unwrap().is_none());
        db.require_run("run_a").unwrap();
        let error = db.require_run("nope").unwrap_err();
        assert_eq!(error.to_string(), "Run not found: nope");
    }

    #[test]
    fn list_runs_pages_newest_first_through_an_opaque_cursor() {
        let db = store();
        for (index, id) in ["run_a", "run_b", "run_c"].iter().enumerate() {
            db.create_run(id, "objective", "term", &format!("tab{index}:{LEAF_A}")).unwrap();
        }
        // Pin created_at so the keyset walks distinct timestamps AND a tie that
        // only the id DESC tiebreak can order (run_c before run_b).
        for (id, created_at) in [
            (LEGACY_RUN_ID, "2026-01-01 00:00:00"),
            ("run_a", "2026-01-02 00:00:00"),
            ("run_b", "2026-01-03 00:00:00"),
            ("run_c", "2026-01-03 00:00:00"),
        ] {
            db.connection()
                .execute("UPDATE runs SET created_at = ?2 WHERE id = ?1", params![id, created_at])
                .unwrap();
        }
        // Unpaginated compatibility read: every Run — the synthetic legacy Run
        // included, exactly as the TS twin lists it — and no cursor.
        let all = db.list_runs(None, None).unwrap();
        assert_eq!(all.runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(), [
            "run_c",
            "run_b",
            "run_a",
            LEGACY_RUN_ID
        ]);
        assert_eq!(all.next_cursor, None);

        let first = db.list_runs(Some(2), None).unwrap();
        assert_eq!(first.runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(), [
            "run_c", "run_b"
        ]);
        let cursor = first.next_cursor.clone().expect("a second page exists");
        let second = db.list_runs(Some(2), Some(&cursor)).unwrap();
        assert_eq!(second.runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(), [
            "run_a",
            LEGACY_RUN_ID
        ]);
        assert_eq!(second.next_cursor, None);

        // The ceiling clamps in both directions, and an empty cursor is "no cursor".
        assert_eq!(db.list_runs(Some(0), None).unwrap().runs.len(), 1);
        assert_eq!(db.list_runs(Some(9_999), None).unwrap().runs.len(), 4);
        assert_eq!(db.list_runs(None, Some("")).unwrap().runs.len(), 4);
    }

    #[test]
    fn list_runs_rejects_a_malformed_cursor() {
        let db = store();
        // Not base64url, valid base64url that is not JSON, and JSON of the wrong shape.
        for bad in ["!!!!", &base64url::encode(b"not json"), &base64url::encode(br#"{"id":1}"#)] {
            let error = db.list_runs(Some(2), Some(bad)).unwrap_err();
            assert_eq!(error_code(&error), "cursor_invalid");
        }
        // A well-formed cursor round-trips byte-for-byte.
        let run = db.create_run("run_a", "o", "term", &format!("tab1:{LEAF_A}")).unwrap();
        let cursor = encode_run_list_cursor(&run);
        let decoded = decode_run_list_cursor(&cursor).unwrap();
        assert_eq!(decoded.id, "run_a");
        assert_eq!(decoded.created_at, run.created_at);
    }

    #[test]
    fn bind_run_moves_the_seat_bumps_the_generation_and_fences_the_delivery() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        run_mail(&db, "m1", "run_a", "status");
        db.get_or_create_run_delivery(&request("run_a", 1, "delivery_1")).unwrap().unwrap();

        let rebound =
            db.bind_run(&bind("run_a", "term-2", &format!("tab1:{LEAF_B}"))).unwrap().unwrap();
        assert_eq!(rebound.coordinator_handle.as_deref(), Some("term-2"));
        assert_eq!(rebound.coordinator_pane_key.as_deref(), Some(format!("tab1:{LEAF_B}").as_str()));
        assert_eq!(rebound.consumer_generation, 2);
        assert_eq!(delivery_status(&db, "delivery_1"), "fenced");

        // Re-binding the same handle to an equivalent (reminted) pane is a no-op:
        // no generation bump, so the live consumer is not fenced out of its mail.
        let same =
            db.bind_run(&bind("run_a", "term-2", &format!("tab7:{LEAF_B}"))).unwrap().unwrap();
        assert_eq!(same.consumer_generation, 2);
        assert_eq!(same.coordinator_pane_key.as_deref(), Some(format!("tab1:{LEAF_B}").as_str()));
    }

    #[test]
    fn bind_run_returns_none_for_a_missing_or_legacy_run() {
        let db = store();
        assert!(db.bind_run(&bind("nope", "term-1", &format!("tab1:{LEAF_A}"))).unwrap().is_none());
        // The schema ladder always seats the synthetic legacy Run; it is inspect-only.
        assert_eq!(db.get_run(LEGACY_RUN_ID).unwrap().unwrap().legacy, 1);
        assert!(db
            .bind_run(&bind(LEGACY_RUN_ID, "term-1", &format!("tab1:{LEAF_A}")))
            .unwrap()
            .is_none());
        // The rejected bind rolled back, so the writer is still usable.
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
    }

    #[test]
    fn bind_run_refuses_takeover_of_a_run_that_was_never_adopted() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        let mut params = bind("run_a", "term-2", &format!("tab2:{LEAF_B}"));
        params.takeover_legacy = true;
        let error = db.bind_run(&params).unwrap_err();
        assert_eq!(error_code(&error), "invalid_argument");
        // No effects: the seat is untouched.
        assert_eq!(db.get_run("run_a").unwrap().unwrap().coordinator_handle.as_deref(), Some("term-1"));
        assert_eq!(generation(&db, "run_a"), 1);
    }

    #[test]
    fn bind_run_refuses_an_unproven_legacy_authority() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        let mut params = bind("run_a", "term-1", &format!("tab1:{LEAF_A}"));
        params.legacy_coordinator_authority = Some(LegacyCoordinatorAuthority {
            run_id: "run_a".to_string(),
            principal_id: Some("principal_1".to_string()),
            terminal_handle: "term-1".to_string(),
            pane_key: format!("tab1:{LEAF_A}"),
            consumer_generation: 1,
        });
        // Nothing was adopted and no principal exists, so the claim cannot be proven.
        let error = db.bind_run(&params).unwrap_err();
        assert_eq!(error_code(&error), "legacy_read_only");
        assert_eq!(error_data(&error)["effectsApplied"], serde_json::json!(false));
    }

    #[test]
    fn bind_run_fences_a_current_coordinator_off_live_legacy_work() {
        let db = store();
        db.create_run("run_a", "ship it", "term-legacy", &format!("tab1:{LEAF_A}")).unwrap();
        adopt(&db, "run_a");
        db.create_task("task_1", "spec", None, &[], Some("term-legacy"), None, None, None).unwrap();
        db.connection()
            .execute(
                "INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, assignee_handle, status)
                 VALUES ('dispatch_1', 'run_a', 'task_1', ?1, 'worker-a', 'dispatched')",
                params![LEGACY_CONTRACT_VERSION],
            )
            .unwrap();

        let error =
            db.bind_run(&bind("run_a", "term-new", &format!("tab2:{LEAF_B}"))).unwrap_err();
        assert_eq!(error_code(&error), "consumer_fenced");
        assert_eq!(
            error_data(&error)["recoveryCommand"],
            serde_json::json!("orca orchestration run-use --id run_a --takeover-legacy")
        );
        assert_eq!(generation(&db, "run_a"), 1);

        // --takeover-legacy is the documented escape hatch: it rebinds, revokes the
        // committed legacy coordinator principal, and promotes its retained mail.
        mail(&db, "m1", "run_a", "term-legacy", "worker_done", "legacy_direct");
        db.connection()
            .execute(
                "INSERT INTO legacy_compatibility_principals
                   (id, run_id, dispatch_id, role, host_scope, terminal_handle, pane_key, launch_token_hash, status)
                 VALUES ('principal_1', 'run_a', NULL, 'coordinator', 'local', 'term-legacy', ?1, 'hash', 'committed')",
                params![format!("tab1:{LEAF_A}")],
            )
            .unwrap();
        let mut params = bind("run_a", "term-new", &format!("tab2:{LEAF_B}"));
        params.takeover_legacy = true;
        let rebound = db.bind_run(&params).unwrap().unwrap();
        assert_eq!(rebound.coordinator_handle.as_deref(), Some("term-new"));
        assert_eq!(rebound.consumer_generation, 2);

        let status: String = db
            .connection()
            .query_row(
                "SELECT status FROM legacy_compatibility_principals WHERE id = 'principal_1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "revoked");
        let promoted = db.get_run_mailbox_history("run_a", 100, None).unwrap();
        assert_eq!(promoted.len(), 1);
        assert_eq!(promoted[0].id, "m1");
        assert_eq!(promoted[0].delivery_contract.as_deref(), Some(DELIVERY_CONTRACT_CURRENT));
        assert!(db.has_pending_current_delivery("run_a").unwrap());
    }

    #[test]
    fn unique_legacy_coordinator_handle_needs_unambiguous_evidence() {
        let db = store();
        db.create_run("run_a", "ship it", "term-legacy", &format!("tab1:{LEAF_A}")).unwrap();
        // Nothing adopted yet.
        assert_eq!(db.unique_legacy_coordinator_handle("run_a").unwrap(), None);
        adopt(&db, "run_a");
        assert_eq!(db.unique_legacy_coordinator_handle("other_run").unwrap(), None);

        db.connection()
            .execute(
                "INSERT INTO coordinator_runs (id, spec, coordinator_handle, scheduler_lost_at)
                 VALUES ('crun_1', 'spec', 'term-legacy', (SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?1))",
                params![LEGACY_RUN_ID],
            )
            .unwrap();
        assert_eq!(
            db.unique_legacy_coordinator_handle("run_a").unwrap().as_deref(),
            Some("term-legacy")
        );

        // A second durable candidate makes the inference ambiguous.
        db.connection()
            .execute(
                "INSERT INTO coordinator_runs (id, spec, coordinator_handle, scheduler_lost_at)
                 VALUES ('crun_2', 'spec', 'term-other', (SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?1))",
                params![LEGACY_RUN_ID],
            )
            .unwrap();
        assert_eq!(db.unique_legacy_coordinator_handle("run_a").unwrap(), None);

        // And a candidate that also worked the Run disqualifies the whole inference.
        db.connection().execute("DELETE FROM coordinator_runs WHERE id = 'crun_2'", []).unwrap();
        db.connection()
            .execute(
                "INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, assignee_handle, status)
                 VALUES ('dispatch_1', 'run_a', 'task_1', ?1, 'term-legacy', 'completed')",
                params![LEGACY_CONTRACT_VERSION],
            )
            .unwrap();
        assert_eq!(db.unique_legacy_coordinator_handle("run_a").unwrap(), None);
    }

    fn adopt(db: &OrchestrationDb, adopted_run_id: &str) {
        db.connection()
            .execute(
                "INSERT INTO legacy_adoptions (source_run_id, adopted_run_id, scheduler_state_lost)
                 VALUES (?1, ?2, 1)",
                params![LEGACY_RUN_ID, adopted_run_id],
            )
            .unwrap();
    }

    #[test]
    fn get_current_run_for_pane_follows_the_leaf_and_skips_the_legacy_run() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        assert_eq!(
            db.get_current_run_for_pane(&format!("tab2:{LEAF_A}")).unwrap().unwrap().id,
            "run_a"
        );
        assert!(db.get_current_run_for_pane(&format!("tab1:{LEAF_B}")).unwrap().is_none());

        // The synthetic legacy Run is never returned, even when it holds the pane.
        db.connection()
            .execute(
                "UPDATE runs SET coordinator_handle = 'term-9', coordinator_pane_key = ?2 WHERE id = ?1",
                params![LEGACY_RUN_ID, format!("tab1:{LEAF_B}")],
            )
            .unwrap();
        assert!(db.get_current_run_for_pane(&format!("tab1:{LEAF_B}")).unwrap().is_none());
    }

    #[test]
    fn run_delivery_cuts_replays_and_settles_the_mailbox() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        // Nothing addressed to the Run yet.
        assert!(db.get_or_create_run_delivery(&request("run_a", 1, "delivery_1")).unwrap().is_none());

        run_mail(&db, "m1", "run_a", "status");
        run_mail(&db, "m2", "run_a", "worker_done");
        // Neither the wrong contract nor another Run's mail is deliverable.
        mail(&db, "m3", "run_a", "run:run_a", "status", "legacy_direct");

        let cut = db.get_or_create_run_delivery(&request("run_a", 1, "delivery_1")).unwrap().unwrap();
        assert!(!cut.replayed);
        assert_eq!(cut.delivery.status, "outstanding");
        assert_eq!(cut.delivery.consumer_generation, 1);
        assert_eq!(cut.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1", "m2"]);
        assert_eq!(cut.delivery.message_ids, r#"["m1","m2"]"#);

        // A crashed consumer replays the same delivery rather than cutting a second.
        let replay =
            db.get_or_create_run_delivery(&request("run_a", 1, "delivery_2")).unwrap().unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.delivery.id, "delivery_1");
        assert_eq!(replay.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1", "m2"]);

        let ack = db.acknowledge_run_delivery("run_a", 1, "delivery_1").unwrap();
        assert!(!ack.duplicate);
        assert_eq!(ack.delivery.status, "acknowledged");
        assert!(ack.delivery.acknowledged_at.is_some());
        assert!(!db.has_pending_current_delivery("run_a").unwrap());

        // Acknowledging again is a duplicate, not an error.
        let again = db.acknowledge_run_delivery("run_a", 1, "delivery_1").unwrap();
        assert!(again.duplicate);
        assert_eq!(again.delivery.status, "acknowledged");
        // And the mailbox is drained.
        assert!(db.get_or_create_run_delivery(&request("run_a", 1, "delivery_3")).unwrap().is_none());
    }

    #[test]
    fn run_delivery_honours_wake_types_and_the_page_ceiling() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        run_mail(&db, "m1", "run_a", "status");
        run_mail(&db, "m2", "run_a", "worker_done");

        // No matching wake type: nothing is cut and no delivery row is written.
        let mut wake = request("run_a", 1, "delivery_1");
        wake.wake_types = Some(vec!["escalation".to_string()]);
        assert!(db.get_or_create_run_delivery(&wake).unwrap().is_none());
        assert!(db.runs_delivery_row("delivery_1").unwrap().is_none());

        // A matching wake type delivers the whole unread page, not just that type.
        let mut wake = request("run_a", 1, "delivery_1");
        wake.wake_types = Some(vec!["worker_done".to_string()]);
        wake.limit = Some(1);
        let cut = db.get_or_create_run_delivery(&wake).unwrap().unwrap();
        assert_eq!(cut.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1"]);
    }

    #[test]
    fn run_delivery_rejects_a_fenced_consumer_and_a_foreign_delivery() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        db.create_run("run_b", "other", "term-2", &format!("tab2:{LEAF_B}")).unwrap();
        run_mail(&db, "m1", "run_a", "status");
        db.get_or_create_run_delivery(&request("run_a", 1, "delivery_1")).unwrap().unwrap();

        // A stale generation never reaches the mailbox.
        let error = db.get_or_create_run_delivery(&request("run_a", 0, "delivery_2")).unwrap_err();
        assert_eq!(error_code(&error), "consumer_fenced");
        let error = db.acknowledge_run_delivery("run_a", 0, "delivery_1").unwrap_err();
        assert_eq!(error_code(&error), "consumer_fenced");

        // A delivery from another Run is stale, not fenced.
        let error = db.acknowledge_run_delivery("run_b", 1, "delivery_1").unwrap_err();
        assert_eq!(error_code(&error), "stale_delivery");
        let error = db.acknowledge_run_delivery("run_b", 1, "nope").unwrap_err();
        assert_eq!(error_code(&error), "stale_delivery");

        // Rebinding fences the outstanding delivery; the old consumer's ack fails
        // and its messages stay unread for the new one.
        db.bind_run(&bind("run_a", "term-9", &format!("tab9:{LEAF_A}"))).unwrap().unwrap();
        let error = db.acknowledge_run_delivery("run_a", 2, "delivery_1").unwrap_err();
        assert_eq!(error_code(&error), "consumer_fenced");
        assert!(db.has_pending_current_delivery("run_a").unwrap());
        let recut =
            db.get_or_create_run_delivery(&request("run_a", 2, "delivery_2")).unwrap().unwrap();
        assert!(!recut.replayed);
        assert_eq!(recut.delivery.id, "delivery_2");
    }

    #[test]
    fn run_delivery_replay_refuses_an_outstanding_delivery_from_another_generation() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        run_mail(&db, "m1", "run_a", "status");
        // A delivery left outstanding at a generation the run no longer reports is
        // never replayed — the defensive half of the fence, since the run-level
        // check alone cannot see it.
        db.connection()
            .execute(
                "INSERT INTO deliveries (id, run_id, consumer_generation, message_ids)
                 VALUES ('delivery_stale', 'run_a', 7, '[\"m1\"]')",
                [],
            )
            .unwrap();
        let error = db.get_or_create_run_delivery(&request("run_a", 1, "delivery_1")).unwrap_err();
        assert_eq!(error_code(&error), "consumer_fenced");
        assert_eq!(delivery_status(&db, "delivery_stale"), "outstanding");
    }

    #[test]
    fn run_delivery_never_crosses_run_boundaries() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        db.create_run("run_b", "other", "term-2", &format!("tab2:{LEAF_B}")).unwrap();
        // Right address, right contract — wrong Run.
        mail(&db, "m1", "run_b", "run:run_a", "status", DELIVERY_CONTRACT_CURRENT);
        assert!(db.get_or_create_run_delivery(&request("run_a", 1, "delivery_1")).unwrap().is_none());
        assert!(!db.has_pending_current_delivery("run_a").unwrap());
        assert!(db.get_run_mailbox_history("run_a", 100, None).unwrap().is_empty());
    }

    #[test]
    fn has_pending_current_delivery_is_scoped_to_the_run_address_and_contract() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        assert!(!db.has_pending_current_delivery("run_a").unwrap());
        // Wrong contract, and mail addressed to a worker rather than the Run.
        mail(&db, "m1", "run_a", "run:run_a", "status", "legacy_direct");
        mail(&db, "m2", "run_a", "worker-a", "status", DELIVERY_CONTRACT_CURRENT);
        assert!(!db.has_pending_current_delivery("run_a").unwrap());
        run_mail(&db, "m3", "run_a", "status");
        assert!(db.has_pending_current_delivery("run_a").unwrap());
        db.mark_as_read(&["m3"]).unwrap();
        assert!(!db.has_pending_current_delivery("run_a").unwrap());
    }

    #[test]
    fn run_mailbox_history_is_newest_first_and_ignores_the_read_bit() {
        let db = store();
        db.create_run("run_a", "ship it", "term-1", &format!("tab1:{LEAF_A}")).unwrap();
        run_mail(&db, "m1", "run_a", "status");
        run_mail(&db, "m2", "run_a", "worker_done");
        mail(&db, "m3", "run_a", "run:run_a", "status", "legacy_direct");
        mail(&db, "m4", "run_a", "worker-a", "status", DELIVERY_CONTRACT_CURRENT);
        db.mark_as_read(&["m1", "m2", "m3"]).unwrap();

        // Every contract addressed to the Run, newest first; other recipients out.
        let history = db.get_run_mailbox_history("run_a", 100, None).unwrap();
        assert_eq!(history.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m3", "m2", "m1"]);
        assert_eq!(db.get_run_mailbox_history("run_a", 2, None).unwrap().len(), 2);
        let filtered = db
            .get_run_mailbox_history("run_a", 100, Some(&["worker_done".to_string()]))
            .unwrap();
        assert_eq!(filtered.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m2"]);
        // An empty filter list means "no filter", as in the TS twin.
        assert_eq!(db.get_run_mailbox_history("run_a", 100, Some(&[])).unwrap().len(), 3);
        // The read bit is untouched by the read path.
        assert_eq!(db.get_message_by_id("m1").unwrap().unwrap().read, 1);
    }

    #[test]
    fn base64url_round_trips_the_node_alphabet() {
        for payload in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0xfb, 0xff, 0xfe][..]] {
            let encoded = base64url::encode(payload);
            assert!(!encoded.contains('='));
            assert!(!encoded.contains('+') && !encoded.contains('/'));
            assert_eq!(base64url::decode(&encoded).unwrap(), payload);
        }
        // Padded and standard-alphabet input still decodes, as Node's does.
        assert_eq!(base64url::decode("YQ==").unwrap(), b"a");
        assert_eq!(base64url::decode("+/8").unwrap(), base64url::decode("-_8").unwrap());
        assert!(base64url::decode("no!").is_none());
    }
}
