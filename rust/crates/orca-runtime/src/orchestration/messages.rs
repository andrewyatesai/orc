//! Message CRUD: insert, the read paths (unread / undelivered / thread / inbox),
//! the read+delivered markers, and the lifecycle-rejection rewrite. Ported from
//! the message section of `src/main/runtime/orchestration/db.ts`.

use super::lifecycle_rejection::add_lifecycle_rejection_marker;
use super::rows::{row_to_message, Message, NewMessage, NewRunMessage, MESSAGE_COLUMNS};
use super::sql_fragments::placeholders;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, params_from_iter, OptionalExtension, ToSql};

impl OrchestrationDb {
    /// Pre-Run insert: no `run_id`, no `delivery_contract`, no `requireRun`.
    /// Only migration/legacy fixtures want this — they write rows that predate
    /// the Run schema. Every real caller wants [`Self::insert_run_message`],
    /// which is the faithful TS `insertMessage`. Deliberately not exposed over
    /// napi, so no JS caller can reach the lossy path.
    pub fn send_message(&self, message: &NewMessage) -> Result<Message, StoreError> {
        self.db.connection().execute(
            "INSERT INTO messages (id, from_handle, to_handle, subject, body, type, priority, thread_id, payload, sender_pane_key, recipient_pane_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                message.id, message.from_handle, message.to_handle, message.subject, message.body,
                message.message_type, message.priority, message.thread_id, message.payload,
                message.sender_pane_key, message.recipient_pane_key,
            ],
        )?;
        self.get_message_by_id(&message.id)?
            .ok_or_else(|| StoreError::Message("message vanished after insert".into()))
    }

    pub fn get_message_by_id(&self, id: &str) -> Result<Option<Message>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_message).optional()?)
    }

    /// Unread messages for `handle`, oldest first (TS `getUnreadMessages`);
    /// `types` optionally restricts by message type.
    pub fn get_unread_messages(&self, handle: &str, types: Option<&[String]>) -> Result<Vec<Message>, StoreError> {
        // Why the contract filter: legacy_direct/audit_only rows stay queryable
        // through history but must never be consumed by a current-contract read.
        self.query_messages(
            "read = 0 AND delivery_contract = 'current_delivery'",
            "ORDER BY sequence",
            handle,
            types,
            None,
        )
    }

    /// Unread AND undelivered messages for `handle`, oldest first — the
    /// push-on-idle replay guard (TS `getUndeliveredUnreadMessages`).
    pub fn get_undelivered_unread_messages(
        &self,
        handle: &str,
        types: Option<&[String]>,
    ) -> Result<Vec<Message>, StoreError> {
        self.query_messages(
            "read = 0 AND delivered_at IS NULL AND delivery_contract = 'current_delivery'",
            "ORDER BY sequence",
            handle,
            types,
            None,
        )
    }

    /// Most-recent messages for `handle` (TS `getAllMessages`), newest first.
    pub fn get_all_messages(&self, handle: &str, limit: i64) -> Result<Vec<Message>, StoreError> {
        self.query_messages("1 = 1", "ORDER BY sequence DESC", handle, None, Some(limit))
    }

    /// Every message for `handle`, newest first, never touching the read bit
    /// (TS `getAllMessagesForHandle`); optional type filter.
    pub fn get_all_messages_for_handle(
        &self,
        handle: &str,
        limit: i64,
        types: Option<&[String]>,
    ) -> Result<Vec<Message>, StoreError> {
        self.query_messages("1 = 1", "ORDER BY sequence DESC", handle, types, Some(limit))
    }

    /// All messages regardless of recipient, newest first (TS `getInbox`).
    pub fn get_inbox(&self, limit: i64) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connection();
        let mut stmt =
            conn.prepare(&format!("SELECT {MESSAGE_COLUMNS} FROM messages ORDER BY sequence DESC LIMIT ?1"))?;
        let rows = stmt.query_map([limit], row_to_message)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Thread-scoped replies addressed to `to_handle`, oldest first (TS
    /// `getThreadMessagesFor`); `after_sequence` resumes past an already-seen marker.
    pub fn get_thread_messages_for(
        &self,
        thread_id: &str,
        to_handle: &str,
        after_sequence: Option<i64>,
    ) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connection();
        match after_sequence {
            Some(seq) => {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {MESSAGE_COLUMNS} FROM messages WHERE thread_id = ?1 AND to_handle = ?2 AND sequence > ?3 ORDER BY sequence ASC"
                ))?;
                let rows = stmt.query_map(params![thread_id, to_handle, seq], row_to_message)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
            None => {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {MESSAGE_COLUMNS} FROM messages WHERE thread_id = ?1 AND to_handle = ?2 ORDER BY sequence ASC"
                ))?;
                let rows = stmt.query_map(params![thread_id, to_handle], row_to_message)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
        }
    }

    /// Mark messages read by id (TS `markAsRead`). Empty `ids` is a no-op.
    pub fn mark_as_read(&self, ids: &[&str]) -> Result<(), StoreError> {
        self.update_messages_by_ids("read = 1", ids)
    }

    /// Stamp `delivered_at = datetime('now')` on messages by id (TS
    /// `markAsDelivered`) — the push-on-idle delivery marker.
    pub fn mark_as_delivered(&self, ids: &[&str]) -> Result<(), StoreError> {
        self.update_messages_by_ids("delivered_at = datetime('now')", ids)
    }

    /// Mark messages both read and delivered (TS `markAsReadAndDelivered`) —
    /// superseded lifecycle messages stay queryable but must not be re-consumed
    /// or re-injected. `delivered_at` is only stamped if not already set.
    pub fn mark_as_read_and_delivered(&self, ids: &[&str]) -> Result<(), StoreError> {
        self.update_messages_by_ids(
            "read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))",
            ids,
        )
    }

    /// Rewrite a `worker_done`/`heartbeat` message into an audited rejection (TS
    /// `convertLifecycleMessageToRejection(messageId, code, reason)`): keeps the
    /// row queryable but stops it reaching later read paths as an actionable
    /// completion/liveness event. A non-lifecycle or missing message is returned
    /// unchanged. `code` is the machine-readable marker code — the federated
    /// import path rejects with codes other than `sender_not_assignee`.
    pub fn convert_lifecycle_message_to_rejection(
        &self,
        message_id: &str,
        code: &str,
        reason: &str,
    ) -> Result<Option<Message>, StoreError> {
        let Some(message) = self.get_message_by_id(message_id)? else {
            return Ok(None);
        };
        if message.message_type != "worker_done" && message.message_type != "heartbeat" {
            return Ok(Some(message));
        }
        let original_body = if message.body.is_empty() {
            String::new()
        } else {
            format!("\n\nOriginal body:\n{}", message.body)
        };
        let body = format!(
            "Orca rejected this {}: {reason}{original_body}",
            message.message_type
        );
        let payload =
            add_lifecycle_rejection_marker(message.payload.as_deref(), code, reason);
        let subject = format!("Rejected {}: {}", message.message_type, message.subject);
        self.db.connection().execute(
            "UPDATE messages SET priority = 'high', subject = ?1, body = ?2, payload = ?3 WHERE id = ?4",
            params![subject, body, payload, message_id],
        )?;
        self.get_message_by_id(message_id)
    }

    fn update_messages_by_ids(&self, set_clause: &str, ids: &[&str]) -> Result<(), StoreError> {
        if ids.is_empty() {
            return Ok(());
        }
        let placeholders = placeholders(ids.len());
        let sql = format!("UPDATE messages SET {set_clause} WHERE id IN ({placeholders})");
        let params: Vec<&dyn ToSql> = ids.iter().map(|id| id as &dyn ToSql).collect();
        self.db.connection().execute(&sql, params_from_iter(params))?;
        Ok(())
    }

    fn query_messages(
        &self,
        base_where: &str,
        order: &str,
        handle: &str,
        types: Option<&[String]>,
        limit: Option<i64>,
    ) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connection();
        let mut sql = format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE to_handle = ? AND {base_where}");
        let mut binds: Vec<&dyn ToSql> = vec![&handle];
        let types = types.filter(|t| !t.is_empty());
        if let Some(types) = types {
            sql.push_str(&format!(" AND type IN ({})", placeholders(types.len())));
            for t in types {
                binds.push(t as &dyn ToSql);
            }
        }
        sql.push(' ');
        sql.push_str(order);
        if let Some(limit) = &limit {
            sql.push_str(" LIMIT ?");
            binds.push(limit as &dyn ToSql);
        }
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), row_to_message)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Run-scoped `insertMessage`: the full upstream insert, including `run_id`
    /// and `delivery_contract`, and the `requireRun` precondition.
    ///
    /// Why a second entry point: [`Self::send_message`] is pinned to the napi
    /// `insert_message` argument list, which cannot grow without editing
    /// `native/orca-node`. Every run-aware caller (questions, federation import,
    /// legacy compatibility operations) must use this one.
    pub fn insert_run_message(&self, message: &NewRunMessage) -> Result<Message, StoreError> {
        self.require_run(&message.run_id)?;
        self.db.connection().execute(
            "INSERT INTO messages (
               id, run_id, delivery_contract, from_handle, to_handle, subject, body,
               type, priority, thread_id, payload, sender_pane_key, recipient_pane_key
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                message.id,
                message.run_id,
                message.delivery_contract,
                message.from_handle,
                message.to_handle,
                message.subject,
                message.body,
                message.message_type,
                message.priority,
                message.thread_id,
                message.payload,
                message.sender_pane_key,
                message.recipient_pane_key,
            ],
        )?;
        self.get_message_by_id(&message.id)?
            .ok_or_else(|| StoreError::Message("message vanished after insert".into()))
    }
}
