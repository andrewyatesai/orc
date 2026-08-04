//! Durable question threads: a worker's `ask` becomes a `question` message plus
//! a `question_threads` row that survives a coordinator restart, and the worker
//! side of a question relayed in from a federated home.
//!
//! Ported from the question section of `src/main/runtime/orchestration/db.ts`.
//! Tables: `question_threads`, `remote_questions` (+ `messages`).
//!
//! Timestamp exposure: the TS twin wraps every `QuestionRow` it returns in
//! `exposeQuestionTimestamps`. That is deliberately NOT done here — the fork's
//! contract (see `db-message-timestamp.ts`) is that the Rust store returns rows
//! as SQLite wrote them and the shim owns RFC3339 exposure at the JSON boundary.

use super::error::orchestration_err;
use super::legacy_question_matching::legacy_message_matches_question;
use super::rows::{
    row_to_question, row_to_remote_question, Message, NewRunMessage, Question, RemoteQuestion,
    LEGACY_ROLE_WORKER, QUESTION_COLUMNS, REMOTE_QUESTION_COLUMNS,
};
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension};

/// TS `createQuestion(params)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateQuestionParams {
    /// Caller-generated `msg_<hex>` id for the question message.
    pub message_id: String,
    pub run_id: String,
    pub dispatch_id: String,
    pub asker_handle: String,
    pub question: String,
    pub options: Vec<String>,
}

/// TS `{ question; message }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct QuestionThread {
    pub question: Question,
    pub message: Message,
}

/// TS `answerQuestion` result — `duplicate` when the thread was already answered.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct AnsweredQuestion {
    pub question: Question,
    pub message: Message,
    pub duplicate: bool,
}

/// TS `findLegacyQuestionsBySemanticIdentity` row.
// Why: the two flags are camelCase in the TS result object (the nested rows stay
// snake_case because they are raw table rows).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyQuestionMatch {
    pub question: Question,
    pub message: Message,
    pub answer_acknowledged: bool,
    pub claimed_by_operation: bool,
}

/// TS `findPendingLegacyQuestions` / `findLegacyQuestionsBySemanticIdentity`
/// params — a question is identified semantically (text + options + recipient)
/// because a retrying legacy CLI has no id to present.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyQuestionQuery {
    pub principal_id: String,
    pub question: String,
    pub options: Vec<String>,
    pub recipient_handle: String,
}

/// The `messages.payload` a `question` message carries. Declaration order is the
/// TS object-literal order, so `serde_json::to_string` is byte-identical to
/// `JSON.stringify({ taskId, dispatchId, question, options })`.
#[derive(serde::Serialize)]
struct QuestionMessagePayload<'a> {
    #[serde(rename = "taskId")]
    task_id: &'a str,
    #[serde(rename = "dispatchId")]
    dispatch_id: &'a str,
    question: &'a str,
    options: &'a [String],
}

impl OrchestrationDb {
    /// TS `createQuestion` — inserts the `question` message and its thread row in
    /// one writer.
    pub fn create_question(
        &self,
        params: &CreateQuestionParams,
    ) -> Result<QuestionThread, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.create_question_in_transaction(params) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn create_question_in_transaction(
        &self,
        params: &CreateQuestionParams,
    ) -> Result<QuestionThread, StoreError> {
        self.require_run(&params.run_id)?;
        let dispatch = self.dispatch_context_by_id(&params.dispatch_id)?;
        let dispatch = match dispatch {
            Some(dispatch)
                if dispatch.run_id == params.run_id
                    && (dispatch.status == "pending" || dispatch.status == "dispatched") =>
            {
                dispatch
            }
            _ => {
                return orchestration_err(
                    "dispatch_inactive",
                    format!(
                        "Dispatch {} is not active in Run {}.",
                        params.dispatch_id, params.run_id
                    ),
                )
            }
        };

        let payload = serde_json::to_string(&QuestionMessagePayload {
            task_id: &dispatch.task_id,
            dispatch_id: &dispatch.id,
            question: &params.question,
            options: &params.options,
        })
        .map_err(|error| StoreError::Message(error.to_string()))?;
        let message = self.insert_run_message(&NewRunMessage {
            id: params.message_id.clone(),
            run_id: params.run_id.clone(),
            from_handle: format!("dispatch:{}", params.dispatch_id),
            to_handle: format!("run:{}", params.run_id),
            subject: "Question".to_string(),
            body: params.question.clone(),
            message_type: "question".to_string(),
            payload: Some(payload),
            ..NewRunMessage::default()
        })?;
        // Why: a question message is the head of its own thread, so the thread id
        // can only be stamped once the row exists.
        self.db.connection().execute(
            "UPDATE messages SET thread_id = ?1 WHERE id = ?2",
            params![message.id, message.id],
        )?;
        self.db.connection().execute(
            "INSERT INTO question_threads (
               message_id, run_id, dispatch_id, asker_handle
             ) VALUES (?1, ?2, ?3, ?4)",
            params![message.id, params.run_id, params.dispatch_id, params.asker_handle],
        )?;
        let question = self
            .get_question(&message.id)?
            .ok_or_else(|| StoreError::Message("question thread vanished after insert".into()))?;
        // Why: re-read AFTER the thread_id stamp — the row returned by the insert
        // still has thread_id NULL.
        let stored_message = self
            .get_message_by_id(&message.id)?
            .ok_or_else(|| StoreError::Message("question message vanished after insert".into()))?;
        Ok(QuestionThread { question, message: stored_message })
    }

    /// TS `getQuestion` (and its private `getQuestionRaw` — see the module note on
    /// timestamp exposure).
    pub fn get_question(&self, message_id: &str) -> Result<Option<Question>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {QUESTION_COLUMNS} FROM question_threads WHERE message_id = ?1"
        ))?;
        Ok(stmt.query_row([message_id], row_to_question).optional()?)
    }

    /// TS `answerQuestion` — records the answer against the current consumer
    /// generation and delivers the reply message to the asker.
    ///
    /// `answer_message_id` is the caller-generated `msg_<hex>` the TS twin mints
    /// inline with `generateId('msg')`; ids cross the boundary as parameters
    /// (see the `mod` fidelity contract).
    pub fn answer_question(
        &self,
        message_id: &str,
        run_id: &str,
        consumer_generation: i64,
        answer_message_id: &str,
        body: &str,
    ) -> Result<AnsweredQuestion, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.answer_question_in_transaction(
            message_id,
            run_id,
            consumer_generation,
            answer_message_id,
            body,
        ) {
            Ok(value) => {
                self.db.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.exec("ROLLBACK");
                Err(error)
            }
        }
    }

    fn answer_question_in_transaction(
        &self,
        message_id: &str,
        run_id: &str,
        consumer_generation: i64,
        answer_message_id: &str,
        body: &str,
    ) -> Result<AnsweredQuestion, StoreError> {
        self.require_current_consumer(run_id, consumer_generation)?;
        let question = self.get_question(message_id)?;
        let question = match question {
            Some(question) if question.run_id == run_id => question,
            _ => {
                return orchestration_err(
                    "question_not_found",
                    format!("Question {message_id} was not found in Run {run_id}."),
                )
            }
        };
        if question.status == "closed" {
            return orchestration_err(
                "dispatch_inactive",
                format!("Question {message_id} is closed because its Dispatch is inactive."),
            );
        }
        if question.status == "answered" {
            // Why: `!question.answer_message_id` in the TS twin is JS-falsy — an
            // empty recorded id is a conflict, not a replayable answer.
            let recorded_id = question.answer_message_id.clone().unwrap_or_default();
            if question.answer_body.as_deref() != Some(body) || recorded_id.is_empty() {
                return orchestration_err(
                    "answer_conflict",
                    format!("Question {message_id} already has a different answer."),
                );
            }
            let message = self.get_message_by_id(&recorded_id)?.ok_or_else(|| {
                StoreError::Message(format!(
                    "Recorded answer message {recorded_id} was not found."
                ))
            })?;
            return Ok(AnsweredQuestion { question, message, duplicate: true });
        }

        let message = self.insert_run_message(&NewRunMessage {
            id: answer_message_id.to_string(),
            run_id: run_id.to_string(),
            from_handle: format!("run:{run_id}"),
            to_handle: format!("dispatch:{}", question.dispatch_id),
            subject: "Re: Question".to_string(),
            body: body.to_string(),
            thread_id: Some(question.message_id.clone()),
            ..NewRunMessage::default()
        })?;
        // Why: ask returns thread state directly; leaving its answer unread would
        // deliver it again via check.
        self.mark_as_read(&[&message.id])?;
        self.db.connection().execute(
            "UPDATE question_threads
             SET status = 'answered', answer_message_id = ?1, answer_body = ?2,
                 answered_by_generation = ?3, answered_at = datetime('now')
             WHERE message_id = ?4 AND status = 'pending'",
            params![message.id, body, consumer_generation, question.message_id],
        )?;
        let answered = self
            .get_question(&question.message_id)?
            .ok_or_else(|| StoreError::Message("question thread vanished after answer".into()))?;
        let stored_message = self
            .get_message_by_id(&message.id)?
            .ok_or_else(|| StoreError::Message("answer message vanished after insert".into()))?;
        Ok(AnsweredQuestion { question: answered, message: stored_message, duplicate: false })
    }

    /// TS `closeQuestionsForDispatch` — closes every still-pending question for a
    /// dispatch that is going away; returns the closed message ids.
    pub fn close_questions_for_dispatch(
        &self,
        dispatch_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let conn = self.db.connection();
        let ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT message_id FROM question_threads WHERE dispatch_id = ?1 AND status = 'pending'",
            )?;
            let rows = stmt.query_map([dispatch_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        conn.execute(
            "UPDATE question_threads SET status = 'closed', closed_at = datetime('now') WHERE dispatch_id = ?1 AND status = 'pending'",
            params![dispatch_id],
        )?;
        Ok(ids)
    }

    /// TS `getRemoteQuestion` — the worker-side mirror row.
    pub fn get_remote_question(
        &self,
        message_id: &str,
    ) -> Result<Option<RemoteQuestion>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {REMOTE_QUESTION_COLUMNS} FROM remote_questions WHERE message_id = ?1"
        ))?;
        Ok(stmt.query_row([message_id], row_to_remote_question).optional()?)
    }

    /// TS `answerRemoteQuestion` — settles the worker-side mirror when the home's
    /// answer arrives over the relay. Not transactional in the TS twin either.
    pub fn answer_remote_question(
        &self,
        message_id: &str,
        dispatch_id: &str,
        answer_message_id: &str,
        body: &str,
    ) -> Result<(), StoreError> {
        let question = self.get_remote_question(message_id)?;
        let question = match question {
            Some(question) if question.dispatch_id == dispatch_id => question,
            _ => {
                return orchestration_err(
                    "question_not_found",
                    format!("Remote Question {message_id} was not found."),
                )
            }
        };
        if question.status == "answered" {
            if question.answer_message_id.as_deref() != Some(answer_message_id)
                || question.answer_body.as_deref() != Some(body)
            {
                return orchestration_err(
                    "answer_conflict",
                    format!("Remote Question {message_id} already has a different answer."),
                );
            }
            return Ok(());
        }
        // Why: `status = 'pending'` guard, so a 'closed' mirror falls through to a
        // no-op UPDATE rather than being revived — same as the TS twin.
        self.db.connection().execute(
            "UPDATE remote_questions
             SET status = 'answered', answer_message_id = ?1, answer_body = ?2,
                 answered_at = datetime('now')
             WHERE message_id = ?3 AND status = 'pending'",
            params![answer_message_id, body, message_id],
        )?;
        Ok(())
    }

    /// TS `registerFederatedQuestion` — records that a home-side question was
    /// relayed out to a federated worker.
    pub fn register_federated_question(
        &self,
        message_id: &str,
        run_id: &str,
        dispatch_id: &str,
    ) -> Result<(), StoreError> {
        self.db.connection().execute(
            "INSERT OR IGNORE INTO question_threads (
               message_id, run_id, dispatch_id, asker_handle
             ) VALUES (?1, ?2, ?3, ?4)",
            params![message_id, run_id, dispatch_id, format!("dispatch:{dispatch_id}")],
        )?;
        Ok(())
    }

    /// TS `findLegacyQuestionsBySemanticIdentity` — every semantic match, with the
    /// acknowledgement/claim flags the legacy retry path branches on.
    pub fn find_legacy_questions_by_semantic_identity(
        &self,
        query: &LegacyQuestionQuery,
    ) -> Result<Vec<LegacyQuestionMatch>, StoreError> {
        let principal =
            self.legacy_committed_principal(&query.principal_id, Some(LEGACY_ROLE_WORKER))?;
        let run_address = format!("run:{}", principal.run_id);
        // Why: `q.`-qualify the shared column list — `run_id` is ambiguous across
        // the join, and `row_to_question` still indexes positionally.
        let question_columns: Vec<String> =
            QUESTION_COLUMNS.split(", ").map(|column| format!("q.{column}")).collect();
        // Why: derive the flag's index from the list so adding a question column
        // in `rows` cannot silently shift the read.
        let claimed_index = question_columns.len();
        let question_columns = question_columns.join(", ");
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {question_columns},
                    EXISTS(
                      SELECT 1 FROM legacy_operation_receipts lor
                      WHERE lor.principal_id = ?1 AND lor.method = 'orchestration.ask'
                        AND lor.effect_id = q.message_id
                    ) AS claimed_by_operation
             FROM question_threads q
             INNER JOIN messages m ON m.id = q.message_id
             WHERE q.run_id = ?2 AND q.dispatch_id = ?3
               AND (
                 (m.delivery_contract = 'legacy_direct' AND m.to_handle = ?4) OR
                 (m.delivery_contract = 'current_delivery' AND m.to_handle = ?5)
               )
             ORDER BY m.sequence
             LIMIT 501"
        ))?;
        let rows = stmt.query_map(
            params![
                principal.id,
                principal.run_id,
                principal.dispatch_id,
                query.recipient_handle,
                run_address
            ],
            |row| Ok((row_to_question(row)?, row.get::<_, i64>(claimed_index)?)),
        )?;
        let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() > 500 {
            return orchestration_err(
                "operation_unknown",
                "Legacy ask identity is too ambiguous to reconstruct safely.",
            );
        }

        let recipient_handles = [query.recipient_handle.as_str(), run_address.as_str()];
        let mut matches = Vec::new();
        for (question, claimed_by_operation) in rows {
            // Why: the INNER JOIN pins m.id to q.message_id, so the TS twin's two
            // lookups (source_message_id, then message_id) are the same row.
            let Some(message) = self.get_message_by_id(&question.message_id)? else {
                continue;
            };
            if !legacy_message_matches_question(
                &message,
                &query.question,
                &query.options,
                &recipient_handles,
            ) {
                continue;
            }
            // Why: the TS twin gates on JS-truthiness of answer_message_id, so an
            // empty recorded id counts as no answer at all.
            let answer_acknowledged = match question
                .answer_message_id
                .as_deref()
                .filter(|id| !id.is_empty())
            {
                Some(answer_message_id) => conn
                    .query_row(
                        "SELECT 1 FROM legacy_mail_receipts
                         WHERE principal_id = ?1 AND message_id = ?2
                           AND acknowledged_at IS NOT NULL",
                        params![principal.id, answer_message_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some(),
                None => false,
            };
            matches.push(LegacyQuestionMatch {
                question,
                message,
                answer_acknowledged,
                claimed_by_operation: claimed_by_operation == 1,
            });
        }
        Ok(matches)
    }

    /// TS `findPendingLegacyQuestions` — the still-pending subset.
    pub fn find_pending_legacy_questions(
        &self,
        query: &LegacyQuestionQuery,
    ) -> Result<Vec<QuestionThread>, StoreError> {
        Ok(self
            .find_legacy_questions_by_semantic_identity(query)?
            .into_iter()
            .filter(|row| row.question.status == "pending")
            .map(|row| QuestionThread { question: row.question, message: row.message })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::run_contract::LEGACY_RUN_ID;

    fn store() -> OrchestrationDb {
        OrchestrationDb::open_in_memory().unwrap()
    }

    fn make_run(db: &OrchestrationDb, id: &str) {
        db.connection()
            .execute(
                "INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, consumer_generation, legacy)
                 VALUES (?1, 'objective', 'coord', 'pane:coord', 0, 0)",
                params![id],
            )
            .unwrap();
    }

    fn make_dispatch(db: &OrchestrationDb, id: &str, run_id: &str, task_id: &str, status: &str) {
        db.connection()
            .execute(
                "INSERT INTO tasks (id, run_id, spec, status) VALUES (?1, ?2, 'spec', 'dispatched')",
                params![task_id, run_id],
            )
            .unwrap();
        db.connection()
            .execute(
                "INSERT INTO dispatch_contexts (id, run_id, task_id, assignee_handle, status)
                 VALUES (?1, ?2, ?3, 'worker-a', ?4)",
                params![id, run_id, task_id, status],
            )
            .unwrap();
    }

    fn ask(db: &OrchestrationDb, message_id: &str, run_id: &str, dispatch_id: &str) -> QuestionThread {
        db.create_question(&CreateQuestionParams {
            message_id: message_id.to_string(),
            run_id: run_id.to_string(),
            dispatch_id: dispatch_id.to_string(),
            asker_handle: "worker-a".to_string(),
            question: "ship it?".to_string(),
            options: vec!["yes".to_string(), "no".to_string()],
        })
        .unwrap()
    }

    fn error_code(error: &StoreError) -> String {
        let StoreError::Message(text) = error else {
            panic!("expected a message error, got {error:?}");
        };
        let parsed: serde_json::Value = serde_json::from_str(text).expect("coded error JSON");
        parsed["code"].as_str().unwrap().to_string()
    }

    #[test]
    fn create_question_writes_thread_message_and_payload() {
        let db = store();
        make_run(&db, "run1");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");

        let created = ask(&db, "msg1", "run1", "d1");

        assert_eq!(created.question.message_id, "msg1");
        assert_eq!(created.question.run_id, "run1");
        assert_eq!(created.question.dispatch_id, "d1");
        assert_eq!(created.question.asker_handle, "worker-a");
        assert_eq!(created.question.status, "pending");
        assert!(created.question.answer_message_id.is_none());
        assert_eq!(created.message.message_type, "question");
        assert_eq!(created.message.from_handle, "dispatch:d1");
        assert_eq!(created.message.to_handle, "run:run1");
        assert_eq!(created.message.subject, "Question");
        assert_eq!(created.message.body, "ship it?");
        assert_eq!(created.message.priority, "normal");
        assert_eq!(created.message.delivery_contract.as_deref(), Some("current_delivery"));
        // Head of its own thread, re-read after the stamp.
        assert_eq!(created.message.thread_id.as_deref(), Some("msg1"));
        assert_eq!(
            created.message.payload.as_deref(),
            Some(r#"{"taskId":"t1","dispatchId":"d1","question":"ship it?","options":["yes","no"]}"#)
        );
        assert_eq!(db.get_question("msg1").unwrap().unwrap(), created.question);
        assert!(db.get_question("nope").unwrap().is_none());
    }

    #[test]
    fn create_question_rejects_an_inactive_or_foreign_dispatch() {
        let db = store();
        make_run(&db, "run1");
        make_run(&db, "run2");
        make_dispatch(&db, "d1", "run1", "t1", "completed");
        make_dispatch(&db, "d2", "run2", "t2", "dispatched");

        let params = CreateQuestionParams {
            message_id: "msg1".to_string(),
            run_id: "run1".to_string(),
            dispatch_id: "d1".to_string(),
            asker_handle: "worker-a".to_string(),
            question: "q".to_string(),
            options: Vec::new(),
        };
        // Completed dispatch.
        assert_eq!(error_code(&db.create_question(&params).unwrap_err()), "dispatch_inactive");
        // Dispatch belongs to another Run.
        let foreign = CreateQuestionParams { dispatch_id: "d2".to_string(), ..params.clone() };
        assert_eq!(error_code(&db.create_question(&foreign).unwrap_err()), "dispatch_inactive");
        // Missing dispatch.
        let missing = CreateQuestionParams { dispatch_id: "nope".to_string(), ..params.clone() };
        assert_eq!(error_code(&db.create_question(&missing).unwrap_err()), "dispatch_inactive");
        // Rolled back: no message and no thread survived.
        assert!(db.get_message_by_id("msg1").unwrap().is_none());
        assert!(db.get_question("msg1").unwrap().is_none());

        // Unknown Run is a bare error, not a coded one.
        let no_run = CreateQuestionParams { run_id: "ghost".to_string(), ..params };
        let StoreError::Message(text) = db.create_question(&no_run).unwrap_err() else {
            panic!("expected a message error");
        };
        assert_eq!(text, "Run not found: ghost");
    }

    #[test]
    fn answer_question_settles_the_thread_and_reads_the_reply() {
        let db = store();
        make_run(&db, "run1");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");
        ask(&db, "msg1", "run1", "d1");

        let answered = db.answer_question("msg1", "run1", 0, "ans1", "yes").unwrap();

        assert!(!answered.duplicate);
        assert_eq!(answered.question.status, "answered");
        assert_eq!(answered.question.answer_message_id.as_deref(), Some("ans1"));
        assert_eq!(answered.question.answer_body.as_deref(), Some("yes"));
        assert_eq!(answered.question.answered_by_generation, Some(0));
        assert!(answered.question.answered_at.is_some());
        assert_eq!(answered.message.id, "ans1");
        assert_eq!(answered.message.from_handle, "run:run1");
        assert_eq!(answered.message.to_handle, "dispatch:d1");
        assert_eq!(answered.message.subject, "Re: Question");
        assert_eq!(answered.message.thread_id.as_deref(), Some("msg1"));
        // Marked read so `check` does not redeliver it.
        assert_eq!(answered.message.read, 1);

        // Replaying the same answer is a duplicate, not a second message.
        let replay = db.answer_question("msg1", "run1", 0, "ans2", "yes").unwrap();
        assert!(replay.duplicate);
        assert_eq!(replay.message.id, "ans1");
        assert!(db.get_message_by_id("ans2").unwrap().is_none());
    }

    #[test]
    fn answer_question_rejects_fenced_missing_conflicting_and_closed_threads() {
        let db = store();
        make_run(&db, "run1");
        make_run(&db, "run2");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");
        ask(&db, "msg1", "run1", "d1");

        // Stale consumer generation is fenced.
        assert_eq!(
            error_code(&db.answer_question("msg1", "run1", 7, "ans1", "yes").unwrap_err()),
            "consumer_fenced"
        );
        // The synthetic legacy Run can never be a current consumer.
        assert_eq!(
            error_code(&db.answer_question("msg1", LEGACY_RUN_ID, 0, "ans1", "yes").unwrap_err()),
            "consumer_fenced"
        );
        // Right generation, wrong Run for the thread.
        assert_eq!(
            error_code(&db.answer_question("msg1", "run2", 0, "ans1", "yes").unwrap_err()),
            "question_not_found"
        );
        assert_eq!(
            error_code(&db.answer_question("ghost", "run1", 0, "ans1", "yes").unwrap_err()),
            "question_not_found"
        );

        db.answer_question("msg1", "run1", 0, "ans1", "yes").unwrap();
        // A different body against an answered thread conflicts.
        assert_eq!(
            error_code(&db.answer_question("msg1", "run1", 0, "ans2", "no").unwrap_err()),
            "answer_conflict"
        );

        // A closed thread reports its dispatch, not a conflict.
        ask(&db, "msg2", "run1", "d1");
        db.close_questions_for_dispatch("d1").unwrap();
        assert_eq!(
            error_code(&db.answer_question("msg2", "run1", 0, "ans3", "yes").unwrap_err()),
            "dispatch_inactive"
        );
    }

    #[test]
    fn close_questions_for_dispatch_closes_only_pending_threads() {
        let db = store();
        make_run(&db, "run1");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");
        make_dispatch(&db, "d2", "run1", "t2", "dispatched");
        ask(&db, "msg1", "run1", "d1");
        ask(&db, "msg2", "run1", "d1");
        ask(&db, "msg3", "run1", "d2");
        db.answer_question("msg1", "run1", 0, "ans1", "yes").unwrap();

        let closed = db.close_questions_for_dispatch("d1").unwrap();
        assert_eq!(closed, vec!["msg2".to_string()]);
        let closed_row = db.get_question("msg2").unwrap().unwrap();
        assert_eq!(closed_row.status, "closed");
        assert!(closed_row.closed_at.is_some());
        // The answered thread and the other dispatch are untouched.
        assert_eq!(db.get_question("msg1").unwrap().unwrap().status, "answered");
        assert_eq!(db.get_question("msg3").unwrap().unwrap().status, "pending");
        // Nothing pending left → empty, and no second close stamp.
        assert!(db.close_questions_for_dispatch("d1").unwrap().is_empty());
        assert!(db.close_questions_for_dispatch("unknown").unwrap().is_empty());
    }

    #[test]
    fn register_federated_question_is_insert_or_ignore() {
        let db = store();
        make_run(&db, "run1");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");

        db.register_federated_question("msg1", "run1", "d1").unwrap();
        let question = db.get_question("msg1").unwrap().unwrap();
        assert_eq!(question.asker_handle, "dispatch:d1");
        assert_eq!(question.status, "pending");

        // A relay replay must not overwrite the recorded thread.
        db.register_federated_question("msg1", "run1", "other").unwrap();
        assert_eq!(db.get_question("msg1").unwrap().unwrap().dispatch_id, "d1");
    }

    #[test]
    fn answer_remote_question_settles_the_mirror_and_is_idempotent() {
        let db = store();
        db.connection()
            .execute(
                "INSERT INTO remote_questions (message_id, dispatch_id) VALUES ('msg1', 'd1')",
                [],
            )
            .unwrap();

        assert!(db.get_remote_question("nope").unwrap().is_none());
        let pending = db.get_remote_question("msg1").unwrap().unwrap();
        assert_eq!(pending.status, "pending");

        db.answer_remote_question("msg1", "d1", "ans1", "yes").unwrap();
        let answered = db.get_remote_question("msg1").unwrap().unwrap();
        assert_eq!(answered.status, "answered");
        assert_eq!(answered.answer_message_id.as_deref(), Some("ans1"));
        assert_eq!(answered.answer_body.as_deref(), Some("yes"));
        assert!(answered.answered_at.is_some());

        // Same answer replayed → no-op.
        db.answer_remote_question("msg1", "d1", "ans1", "yes").unwrap();
        // Different answer → conflict.
        assert_eq!(
            error_code(&db.answer_remote_question("msg1", "d1", "ans2", "yes").unwrap_err()),
            "answer_conflict"
        );
        assert_eq!(
            error_code(&db.answer_remote_question("msg1", "d1", "ans1", "no").unwrap_err()),
            "answer_conflict"
        );
        // Unknown id, or the wrong dispatch, is not found.
        assert_eq!(
            error_code(&db.answer_remote_question("msg1", "other", "ans1", "yes").unwrap_err()),
            "question_not_found"
        );
        assert_eq!(
            error_code(&db.answer_remote_question("ghost", "d1", "ans1", "yes").unwrap_err()),
            "question_not_found"
        );
    }

    #[test]
    fn answer_remote_question_never_revives_a_closed_mirror() {
        let db = store();
        db.connection()
            .execute(
                "INSERT INTO remote_questions (message_id, dispatch_id, status) VALUES ('msg1', 'd1', 'closed')",
                [],
            )
            .unwrap();

        db.answer_remote_question("msg1", "d1", "ans1", "yes").unwrap();
        let row = db.get_remote_question("msg1").unwrap().unwrap();
        assert_eq!(row.status, "closed");
        assert!(row.answer_message_id.is_none());
    }

    // -- legacy semantic identity ------------------------------------------

    fn make_legacy_principal(db: &OrchestrationDb, id: &str, run_id: &str, dispatch_id: &str, status: &str) {
        db.connection()
            .execute(
                "INSERT INTO legacy_compatibility_principals (
                   id, run_id, dispatch_id, role, host_scope, terminal_handle, pane_key,
                   launch_token_hash, status
                 ) VALUES (?1, ?2, ?3, 'worker', 'local', 'worker-a', 'pane:worker-a', 'hash', ?4)",
                params![id, run_id, dispatch_id, status],
            )
            .unwrap();
    }

    fn legacy_query(principal_id: &str) -> LegacyQuestionQuery {
        LegacyQuestionQuery {
            principal_id: principal_id.to_string(),
            question: "ship it?".to_string(),
            options: vec!["yes".to_string(), "no".to_string()],
            recipient_handle: "coordinator".to_string(),
        }
    }

    #[test]
    fn legacy_semantic_identity_matches_text_options_and_recipient() {
        let db = store();
        make_run(&db, "run1");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");
        make_legacy_principal(&db, "p1", "run1", "d1", "committed");
        // Addressed to the Run, current_delivery — the route createQuestion writes.
        ask(&db, "msg1", "run1", "d1");
        // Same thread text but a different option set is not the same question.
        db.create_question(&CreateQuestionParams {
            message_id: "msg2".to_string(),
            run_id: "run1".to_string(),
            dispatch_id: "d1".to_string(),
            asker_handle: "worker-a".to_string(),
            question: "ship it?".to_string(),
            options: vec!["maybe".to_string()],
        })
        .unwrap();
        // A legacy_direct question addressed to the recipient handle also matches.
        db.connection()
            .execute(
                "INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, thread_id, payload)
                 VALUES ('msg3', 'run1', 'legacy_direct', 'worker-a', 'coordinator', 'Question', ' ship it?\r\n', 'question', 'msg3',
                         '{\"options\":[\"yes \",\" no\"]}')",
                [],
            )
            .unwrap();
        db.register_federated_question("msg3", "run1", "d1").unwrap();

        let matched = db.find_legacy_questions_by_semantic_identity(&legacy_query("p1")).unwrap();
        let ids: Vec<&str> = matched.iter().map(|row| row.question.message_id.as_str()).collect();
        assert_eq!(ids, vec!["msg1", "msg3"], "CRLF/whitespace normalize; option sets must agree");
        assert!(matched.iter().all(|row| !row.claimed_by_operation && !row.answer_acknowledged));

        // A recorded ask receipt flips claimed_by_operation.
        db.connection()
            .execute(
                "INSERT INTO legacy_operation_receipts (principal_id, operation_key, method, payload_hash, effect_id, response_json, completed_at)
                 VALUES ('p1', 'op1', 'orchestration.ask', 'hash', 'msg1', '{}', datetime('now'))",
                [],
            )
            .unwrap();
        // And an acknowledged answer receipt flips answer_acknowledged.
        db.answer_question("msg1", "run1", 0, "ans1", "yes").unwrap();
        db.connection()
            .execute(
                "INSERT INTO legacy_mail_receipts (principal_id, message_id, acknowledged_at)
                 VALUES ('p1', 'ans1', datetime('now'))",
                [],
            )
            .unwrap();

        let matched = db.find_legacy_questions_by_semantic_identity(&legacy_query("p1")).unwrap();
        let answered = matched.iter().find(|row| row.question.message_id == "msg1").unwrap();
        assert!(answered.claimed_by_operation);
        assert!(answered.answer_acknowledged);

        // Pending subset drops the answered thread.
        let pending = db.find_pending_legacy_questions(&legacy_query("p1")).unwrap();
        let pending_ids: Vec<&str> =
            pending.iter().map(|row| row.question.message_id.as_str()).collect();
        assert_eq!(pending_ids, vec!["msg3"]);
    }

    #[test]
    fn legacy_semantic_identity_requires_a_committed_worker_principal() {
        let db = store();
        make_run(&db, "run1");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");
        make_legacy_principal(&db, "p1", "run1", "d1", "settled");

        assert_eq!(
            error_code(
                &db.find_legacy_questions_by_semantic_identity(&legacy_query("p1")).unwrap_err()
            ),
            "request_mismatch"
        );
        assert_eq!(
            error_code(
                &db.find_legacy_questions_by_semantic_identity(&legacy_query("ghost")).unwrap_err()
            ),
            "request_mismatch"
        );
        assert_eq!(
            error_code(&db.find_pending_legacy_questions(&legacy_query("ghost")).unwrap_err()),
            "request_mismatch"
        );
    }

    #[test]
    fn legacy_semantic_identity_refuses_an_ambiguous_identity() {
        let db = store();
        make_run(&db, "run1");
        make_dispatch(&db, "d1", "run1", "t1", "dispatched");
        make_legacy_principal(&db, "p1", "run1", "d1", "committed");
        for index in 0..501 {
            ask(&db, &format!("msg{index}"), "run1", "d1");
        }

        assert_eq!(
            error_code(
                &db.find_legacy_questions_by_semantic_identity(&legacy_query("p1")).unwrap_err()
            ),
            "operation_unknown"
        );
    }

    #[test]
    fn legacy_message_match_normalizes_text_and_options() {
        let message = Message {
            id: "m".into(),
            run_id: "run1".into(),
            delivery_contract: Some("legacy_direct".into()),
            from_handle: "worker-a".into(),
            to_handle: "coordinator".into(),
            subject: "Question".into(),
            body: "  ship it?\r\n".into(),
            message_type: "question".into(),
            priority: "normal".into(),
            thread_id: None,
            payload: Some(r#"{"options":["yes "," no"]}"#.into()),
            read: 0,
            sequence: 1,
            created_at: "2026-01-01 00:00:00".into(),
            delivered_at: None,
            sender_pane_key: None,
            recipient_pane_key: None,
        };
        let options = vec!["yes".to_string(), "no".to_string()];
        assert!(legacy_message_matches_question(&message, "ship it?\n", &options, &["coordinator"]));
        // Recipient must be one of the accepted addresses.
        assert!(!legacy_message_matches_question(&message, "ship it?", &options, &["run:run1"]));
        // Different option set.
        assert!(!legacy_message_matches_question(
            &message,
            "ship it?",
            &["yes".to_string()],
            &["coordinator"]
        ));

        // Absent payload normalizes to `[]`, so it only matches an empty option set.
        let bare = Message { payload: None, ..message.clone() };
        assert!(legacy_message_matches_question(&bare, "ship it?", &[], &["coordinator"]));
        assert!(!legacy_message_matches_question(&bare, "ship it?", &options, &["coordinator"]));
        // Non-string members are not an option list.
        let mixed = Message { payload: Some(r#"{"options":[1]}"#.into()), ..message.clone() };
        assert!(legacy_message_matches_question(&mixed, "ship it?", &[], &["coordinator"]));
        // Unparseable, and JSON `null`, both fail closed.
        let broken = Message { payload: Some("not json".into()), ..message.clone() };
        assert!(!legacy_message_matches_question(&broken, "ship it?", &[], &["coordinator"]));
        let null_payload = Message { payload: Some("null".into()), ..message };
        assert!(!legacy_message_matches_question(&null_payload, "ship it?", &[], &["coordinator"]));
    }
}
