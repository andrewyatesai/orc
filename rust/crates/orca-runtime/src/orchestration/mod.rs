//! Orchestration coordination store, ported from
//! `src/main/runtime/orchestration/db.ts`. Schema creation and the
//! `user_version` migration ladder live in `crate::orchestration_schema`; this
//! module owns the store handle, and each submodule owns one domain's methods on
//! it.
//!
//! Fidelity contract with the TS twin: row structs serialize to the exact TS Row
//! JSON; JS-side nondeterminism (generated ids, `new Date().toISOString()`
//! completion stamps, display strings) is computed by the caller and passed in,
//! while all other timestamps use SQLite `datetime('now')` — byte-identical to
//! what the TS store writes.
//!
//! Layout: `base64url`, `error`, `legacy_question_matching`,
//! `lifecycle_rejection`, `pane_key`, `rows`, `run_contract` and `sql_fragments`
//! are the shared vocabulary; every other submodule is a domain that adds
//! `impl OrchestrationDb` methods. Rust resolves inherent methods across modules,
//! so a caller sees one flat `OrchestrationDb` API no matter which file a method
//! lives in.
//!
//! Consequence: inherent method names share ONE namespace across every
//! submodule, private ones included. Prefix a domain-private helper with its
//! domain (`fn worker_row(..)`, not `fn row(..)`) or two modules collide on a
//! duplicate definition.

// Shared vocabulary — imported by the domain modules, never duplicated in them.
pub mod base64url;
pub mod error;
pub mod legacy_question_matching;
pub mod lifecycle_rejection;
pub mod pane_key;
pub mod rows;
pub mod run_contract;
pub mod sql_fragments;

// Domains — one owner each.
pub mod capability;
pub mod coordinator_runs;
pub mod decision_gates;
pub mod dispatch_context;
pub mod federation;
pub mod legacy_compat;
pub mod messages;
pub mod mutation_receipt;
pub mod questions;
pub mod raw_sql;
pub mod remote_attachment;
pub mod runs;
pub mod state_dump;
pub mod store_reset;
pub mod tasks;
pub mod terminal_availability;
pub mod worker_dispatch;

use crate::orchestration_schema;
use orca_store::{Database, OpenOptions, StoreError};

pub use error::OrchestrationError;
pub use rows::{
    CoordinatorRun, DecisionGate, Delivery, DispatchContext, FederatedDispatch,
    FederationRelayItem, LegacyAdoption, LegacyCompatibilityPrincipal, LegacyMailReceipt,
    LegacyOperationReceipt, LegacyWorkerTerminalRecovery, Message, MutationReceipt, NewMessage,
    NewRunMessage, Question, RemoteDispatchAttachment, RemoteQuestion, Run, RunListPage, Task,
    TaskWithDispatch, WorkerDispatch, RELAY_DIRECTION_TO_HOME, RELAY_DIRECTION_TO_WORKER,
};

// Every parameter/result type an `OrchestrationDb` method names, re-exported flat
// so the napi layer can bind the whole API without reaching into submodules.
pub use capability::{CapabilityVerdict, DispatchIdentity, MintCapabilityParams};
pub use federation::{
    EnqueueRelayParams, FederatedWorkerStartReport, ImportRelayItemParams, ImportedRelayItem,
    ImportedRelayLifecycle, ImportedRelayMessage,
};
pub use legacy_compat::{
    CommitLegacyPrincipalParams, CommittedLegacyPrincipal, LegacyAnswerAck,
    LegacyCoordinatorCandidate, LegacyIdentityQuery, LegacyLifecycle, LegacyLifecycleCommit,
    LegacyMailAck, LegacyMailPage, LegacyOperationKey, LegacyOperationMessage, LegacyQuestionCommit,
    LegacyWorkerCompletionQuery,
};
pub use mutation_receipt::{
    MutationReceiptClaim, MutationReceiptDisposition, MutationReceiptKey,
    MUTATION_RECEIPT_MAX_AGE_DAYS, MUTATION_RECEIPT_MAX_ROWS,
};
pub use questions::{
    AnsweredQuestion, CreateQuestionParams, LegacyQuestionMatch, LegacyQuestionQuery, QuestionThread,
};
pub use remote_attachment::{
    CreateRemoteAttachmentParams, PrepareRemoteAttachmentAuthorityParams, RemoteAttachmentIdentity,
    RemoteAttachmentSetupEvidence, RemoteAttachmentStageUpdate,
};
pub use run_contract::{
    CURRENT_CONTRACT_VERSION, DELIVERY_CONTRACT_AUDIT_ONLY, DELIVERY_CONTRACT_CURRENT,
    DELIVERY_CONTRACT_LEGACY_DIRECT, LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID, RUN_PAGE_LIMIT,
};
pub use runs::{
    BindRunParams, LegacyCoordinatorAuthority, RunDelivery, RunDeliveryAck, RunDeliveryRequest,
};
pub use worker_dispatch::{
    CreateStartingWorkerParams, PrepareWorkerAuthorityParams, StartingWorkerDispatch,
    WorkerAbandonDisposition, WorkerAbandonment, WorkerFederationTarget, WorkerReportSettlement,
    WorkerSetupEvidence, WorkerStageUpdate, WorkerStopDisposition, WorkerStopStart,
};

pub struct OrchestrationDb {
    db: Database,
}

impl OrchestrationDb {
    pub fn open(path: &str) -> Result<Self, StoreError> {
        let db = Database::open(path, OpenOptions::default())?;
        Self::init(db)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Database::open_in_memory()?)
    }

    /// Borrow the underlying SQLite connection for raw introspection — used by
    /// tests and the parity state-dump harness, not by production callers.
    pub fn connection(&self) -> &rusqlite::Connection {
        self.db.connection()
    }

    fn init(db: Database) -> Result<Self, StoreError> {
        // Why: same pragmas in the same order as the TS constructor. WAL is a
        // no-op for :memory:; harmless on both sides.
        db.exec("PRAGMA journal_mode = WAL")?;
        db.exec("PRAGMA synchronous = NORMAL")?;
        db.exec("PRAGMA busy_timeout = 5000")?;
        orchestration_schema::create_tables(&db)?;
        orchestration_schema::migrate(&db)?;
        // Why: after migrate — a pre-v9 upgrade rebuilds the messages table and
        // would drop a fork column added before it.
        orchestration_schema::create_fork_pane_identity_columns_if_missing(&db)?;
        Ok(Self { db })
    }
}

#[cfg(test)]
mod tests;
