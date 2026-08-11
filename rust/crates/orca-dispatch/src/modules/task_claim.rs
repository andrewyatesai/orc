//! Parity dispatch for `orca_policy::task_claim` vs its TS twin
//! `src/main/runtime/orchestration/task-claim-reconciliation.ts`.
//!
//! The seam matters more here than for a formatter: this is the fleet's only
//! signal capable of contradicting an agent, so a port that drifts does not
//! produce a cosmetic difference — it produces a false accusation, or (worse)
//! silence where a real one belonged.
//!
//! `changedFiles: null` is the load-bearing input and is passed through as
//! `None`: no git to ask. An ABSENT key reads the same way, because the caller
//! in `alab-console.ts` supplies `null` exactly when the status read failed.

use orca_policy::task_claim::{
    describe_reconciliation, parse_task_claim, reconcile_task_claim, ClaimReconciliation,
};
use serde_json::{json, Value};

/// JSON `null` and an absent key both mean "no result row was written", which
/// is the TS `string | null`.
fn result_at(input: &Value) -> Option<&str> {
    input.get("result").and_then(Value::as_str)
}

/// `None` ONLY for `null`/absent — an empty array is a real git answer that
/// says "nothing changed", and the two must never collapse into one another.
fn changed_files_at(input: &Value) -> Option<Vec<String>> {
    input
        .get("changedFiles")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
}

/// Mirrors `JSON.stringify` of the TS discriminated union, key for key: the
/// comparison is key-count sensitive, so `match` must NOT carry the mismatch
/// fields.
fn reconciliation_json(reconciliation: &ClaimReconciliation) -> Value {
    match reconciliation {
        ClaimReconciliation::Unknown(reason) => {
            json!({ "verdict": "unknown", "reason": reason.as_str() })
        }
        ClaimReconciliation::Match { claimed } => json!({ "verdict": "match", "claimed": claimed }),
        ClaimReconciliation::Mismatch {
            claimed,
            missing,
            unclaimed,
        } => json!({
            "verdict": "mismatch",
            "claimed": claimed,
            "missing": missing,
            "unclaimed": unclaimed,
        }),
    }
}

pub fn dispatch(function: &str, input: &Value) -> Value {
    let task_status = input
        .get("taskStatus")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match function {
        "parseTaskClaim" => match parse_task_claim(result_at(input)) {
            None => Value::Null,
            Some(claim) => json!({
                "completedBy": claim.completed_by,
                "filesModified": claim.files_modified,
            }),
        },
        "reconcileTaskClaim" => reconciliation_json(&reconcile_task_claim(
            task_status,
            result_at(input),
            changed_files_at(input).as_deref(),
        )),
        // Composed through `reconcile` rather than over a hand-built verdict,
        // which is the shape `alab-console.ts` actually calls it in.
        "describeReconciliation" => json!(describe_reconciliation(&reconcile_task_claim(
            task_status,
            result_at(input),
            changed_files_at(input).as_deref(),
        ))),
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}
