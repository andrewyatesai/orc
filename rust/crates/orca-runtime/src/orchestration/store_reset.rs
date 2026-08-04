//! Destructive resets exposed to the debug/dev surface.

use super::run_contract::LEGACY_RUN_ID;
use super::OrchestrationDb;
use orca_store::StoreError;

impl OrchestrationDb {
    /// TS `resetAll`. Mutation receipts are deliberately retained so a lost reset
    /// response cannot replay as a new mutation, and the legacy Run row is
    /// re-seeded because every un-scoped write addresses it.
    pub fn reset_all(&self) -> Result<(), StoreError> {
        self.reset_transaction(&format!(
            "DELETE FROM coordinator_runs;
             DELETE FROM decision_gates;
             DELETE FROM remote_questions;
             DELETE FROM question_threads;
             DELETE FROM deliveries;
             DELETE FROM legacy_mail_receipts;
             DELETE FROM legacy_operation_receipts;
             DELETE FROM legacy_compatibility_principals;
             DELETE FROM legacy_adoptions;
             DELETE FROM federation_relay_items;
             DELETE FROM remote_dispatch_attachments;
             DELETE FROM federated_dispatches;
             DELETE FROM worker_dispatches;
             DELETE FROM dispatch_contexts;
             DELETE FROM tasks;
             DELETE FROM messages;
             DELETE FROM runs;
             INSERT INTO runs (id, objective, home_database, consumer_generation, legacy)
               VALUES ('{LEGACY_RUN_ID}', 'Legacy orchestration state (inspect only)', 'this_database', 0, 1);"
        ))
    }

    /// TS `resetTasks` — clears the task graph and every worker attachment while
    /// leaving Runs and message history in place.
    pub fn reset_tasks(&self) -> Result<(), StoreError> {
        self.reset_transaction(
            "DELETE FROM coordinator_runs;
             DELETE FROM decision_gates;
             DELETE FROM remote_questions;
             DELETE FROM question_threads;
             DELETE FROM legacy_mail_receipts;
             DELETE FROM legacy_operation_receipts;
             DELETE FROM legacy_compatibility_principals;
             DELETE FROM legacy_adoptions;
             DELETE FROM federation_relay_items;
             DELETE FROM remote_dispatch_attachments;
             DELETE FROM federated_dispatches;
             DELETE FROM worker_dispatches;
             DELETE FROM dispatch_contexts;
             DELETE FROM tasks;",
        )
    }

    /// TS `resetMessages`. Relay rows carry contiguous cross-server cursors, not
    /// just inbox history, so the receipt/thread/delivery tables go with them.
    pub fn reset_messages(&self) -> Result<(), StoreError> {
        self.reset_transaction(
            "DELETE FROM legacy_mail_receipts;
             DELETE FROM question_threads;
             DELETE FROM deliveries;
             DELETE FROM messages;",
        )
    }

    fn reset_transaction(&self, statements: &str) -> Result<(), StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.db.exec(statements) {
            Ok(()) => self.db.exec("COMMIT"),
            Err(error) => {
                self.db.exec("ROLLBACK")?;
                Err(error)
            }
        }
    }
}
