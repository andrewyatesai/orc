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
    describe_reconciliation, reconcile_task_claim, ClaimReconciliation, TaskClaim,
};
use serde_json::{json, Value};

/// Tolerates the several shapes `result` has carried; anything else is unknown.
///
/// An empty string is the TS `if (!result)` arm, not a parse failure — the
/// column was never written.
fn parse_task_claim(result: Option<&str>) -> Option<TaskClaim> {
    let text = result.filter(|text| !text.is_empty())?;
    let parsed: Value = serde_json::from_str(text).ok()?;
    parse_task_claim_value(&parsed)
}

/// The shape tolerance, over an already-parsed value.
///
/// A JSON ARRAY passes. That is not sloppiness: the TS guard is
/// `typeof parsed !== 'object' || parsed === null`, and in JS an array IS an
/// object, so `[1,2]` reads as a claim with no files rather than an unreadable
/// result. A port that rejected it would report `unreadable-result` where the
/// shipping console reports a real (empty) claim.
fn parse_task_claim_value(parsed: &Value) -> Option<TaskClaim> {
    if !matches!(parsed, Value::Object(_) | Value::Array(_)) {
        return None;
    }
    // A present-but-wrong `filesModified` degrades to "claimed nothing", and a
    // non-string entry is dropped rather than coerced: a claim is only as good
    // as the parts of it that are actually paths.
    let files_modified = parsed
        .get("filesModified")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(TaskClaim {
        completed_by: parsed
            .get("completedBy")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        files_modified,
    })
}

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
            parse_task_claim(result_at(input)),
            changed_files_at(input).as_deref(),
        )),
        // Composed through `reconcile` rather than over a hand-built verdict,
        // which is the shape `alab-console.ts` actually calls it in.
        "describeReconciliation" => json!(describe_reconciliation(&reconcile_task_claim(
            task_status,
            parse_task_claim(result_at(input)),
            changed_files_at(input).as_deref(),
        ))),
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(paths: &[&str]) -> Vec<String> {
        paths.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn parse_drops_non_string_entries_rather_than_trusting_the_shape() {
        let claim = parse_task_claim(Some("{\"filesModified\":[\"a.ts\",42,null]}"));
        assert_eq!(
            claim.map(|claim| claim.files_modified),
            Some(files(&["a.ts"]))
        );
    }

    #[test]
    fn parse_returns_none_for_anything_unreadable() {
        assert!(parse_task_claim(Some("nope")).is_none());
        assert!(parse_task_claim(None).is_none());
        assert!(parse_task_claim(Some("")).is_none());
        assert!(parse_task_claim(Some("\"a string\"")).is_none());
        assert!(parse_task_claim(Some("null")).is_none());
        // A write that was cut off mid-flush is unreadable, not empty.
        assert!(parse_task_claim(Some("{\"filesModified\":[\"a.ts\"")).is_none());
    }

    #[test]
    fn parse_accepts_an_array_because_js_calls_it_an_object() {
        let claim = parse_task_claim(Some("[1,2]"));
        assert_eq!(claim.map(|claim| claim.files_modified.len()), Some(0));
    }
}
