//! `orca-runtime` — runtime orchestration for Orca.
//!
//! The multi-agent coordination store — Runs and deliveries, messages, tasks,
//! dispatch contexts and capabilities, decision gates, worker/remote dispatch
//! lifecycles, federation relay, question threads, mutation receipts, and the
//! legacy compatibility surface — ported from
//! `src/main/runtime/orchestration/db.ts`, on top of `orca-store`'s vendored
//! SQLite.

pub mod orchestration;
mod orchestration_schema;

pub use orchestration::{Message, NewMessage, OrchestrationDb, Task};
