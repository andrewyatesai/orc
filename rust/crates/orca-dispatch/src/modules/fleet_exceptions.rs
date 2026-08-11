//! Parity dispatch for `orca_core::fleet_exceptions` vs its TS twin
//! `src/renderer/src/components/alab/fleet-exceptions.ts`.
//!
//! The exceptions queue is what a supervisor actually looks at, so the thing
//! this seam protects is the collapse KEY: an earlier bug collapsed per run
//! instead of per task and showed one row for a run with twelve stuck tasks.
//! Both sides run the same corpus, so a key or precedence drift cannot land
//! quietly on one of them.

use orca_core::fleet_exceptions::{
    collapse_exceptions_by_task, exception_source_status, unwired_exception_sources,
    FleetException, FleetExceptionKind, EXCEPTION_SOURCE_ORDER,
};
use serde_json::{json, Value};

fn string_at(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Absent or JSON `null` both read as "no worker", matching the TS
/// `workerHandle: string | null`.
fn optional_string_at(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Safe-integer only: past 2^53 the TS half holds an f64 that is no longer the
/// number the vector wrote, so an agreement there would be an artefact of the
/// harness. Both adapters read such a value as absent instead.
fn attempts_at(input: &Value) -> i64 {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    input
        .get("attempts")
        .and_then(Value::as_i64)
        .filter(|attempts| attempts.unsigned_abs() <= MAX_SAFE_INTEGER)
        .unwrap_or(0)
}

/// `None` when `kind` is outside §8.3's six. Neither side guesses a severity for
/// an unknown badge; the TS adapter refuses the same input the same way.
fn parse_exception(value: &Value) -> Option<FleetException> {
    Some(FleetException {
        task_id: string_at(value, "taskId"),
        kind: FleetExceptionKind::parse(value.get("kind").and_then(Value::as_str)?)?,
        summary: string_at(value, "summary"),
        worker_handle: optional_string_at(value, "workerHandle"),
        attempts: attempts_at(value),
        at: string_at(value, "at"),
    })
}

fn exception_to_json(row: &FleetException) -> Value {
    json!({
        "taskId": row.task_id,
        "kind": row.kind.as_str(),
        "summary": row.summary,
        "workerHandle": row.worker_handle,
        "attempts": row.attempts,
        "at": row.at,
    })
}

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "collapseExceptionsByTask" => {
            let raw = input
                .get("exceptions")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let parsed: Option<Vec<FleetException>> = raw.iter().map(parse_exception).collect();
            match parsed {
                Some(rows) => Value::Array(
                    collapse_exceptions_by_task(rows)
                        .iter()
                        .map(exception_to_json)
                        .collect(),
                ),
                None => json!({ "__parity_error__": "unknown FleetExceptionKind" }),
            }
        }
        "unwiredExceptionSources" => Value::Array(
            unwired_exception_sources()
                .into_iter()
                .map(|kind| Value::String(kind.as_str().to_string()))
                .collect(),
        ),
        // Projection of the TS `EXCEPTION_SOURCE_STATUS` object to an ordered
        // list, so the corpus pins both the six keys and their declaration order
        // (the order `Object.keys` — and therefore `unwiredExceptionSources` —
        // would report a regression in).
        "exceptionSourceStatuses" => Value::Array(
            EXCEPTION_SOURCE_ORDER
                .into_iter()
                .map(|kind| {
                    json!({ "kind": kind.as_str(), "status": exception_source_status(kind).as_str() })
                })
                .collect(),
        ),
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}
