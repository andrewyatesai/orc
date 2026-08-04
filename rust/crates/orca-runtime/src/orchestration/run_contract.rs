//! Run-scope and delivery-contract constants shared by the schema ladder and
//! every domain module, mirroring the exported constants in
//! `src/main/runtime/orchestration/db.ts` and `shared/orchestration-*`.

/// `ORCHESTRATION_LEGACY_RUN_ID` — the synthetic Run every pre-Run row is
/// adopted by. Also the `run_id` DEFAULT baked into the schema DDL.
pub const LEGACY_RUN_ID: &str = "run_legacy_local";

/// `LEGACY_CONTRACT_VERSION` — a dispatch created before capability minting.
pub const LEGACY_CONTRACT_VERSION: i64 = 0;

/// `ORCHESTRATION_CONTRACT_VERSION` — the contract every new dispatch is stamped
/// with. Also the `dispatch_contexts.contract_version` DDL default.
pub const CURRENT_CONTRACT_VERSION: i64 = 1;

/// `ORCHESTRATION_RUN_PAGE_LIMIT` — the `listRuns` page ceiling.
pub const RUN_PAGE_LIMIT: i64 = 100;

/// `messages.delivery_contract` values. Pre-Run mail is `legacy_direct`; mail
/// written by a current consumer is `current_delivery`; a rejected lifecycle
/// message is demoted to `audit_only` so it stays queryable but undeliverable.
pub const DELIVERY_CONTRACT_LEGACY_DIRECT: &str = "legacy_direct";
pub const DELIVERY_CONTRACT_CURRENT: &str = "current_delivery";
pub const DELIVERY_CONTRACT_AUDIT_ONLY: &str = "audit_only";
