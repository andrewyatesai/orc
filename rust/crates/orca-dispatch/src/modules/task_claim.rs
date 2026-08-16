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

use orca_config::{js_string, parse_json_past_lone_surrogate_escapes};
use orca_policy::task_claim::{
    describe_reconciliation, reconcile_task_claim, ClaimReconciliation, TaskClaim,
};
use serde_json::{json, Value};

/// Tolerates the several shapes `result` has carried; anything else is unknown.
///
/// An empty string is the TS `if (!result)` arm, not a parse failure — the
/// column was never written.
///
/// The parse goes through `parse_json_past_lone_surrogate_escapes`, not a bare
/// `from_str`, for the reason the codec header records. `TaskRow.result` is
/// `JSON.stringify`d over an agent-authored `filesModified` (and an
/// agent-authored `completedBy`, which is `msg.from_handle`), and
/// `JSON.stringify` spells a lone UTF-16 surrogate as the SIX ASCII CHARACTERS
/// `\ud800`. The column is then pure ASCII: it stores, it encodes, nothing
/// throws — and a strict `from_str` rejects it at the very end, returning
/// `None`, which this module's own precedence turns into
/// `unknown / unreadable-result`.
///
/// That is the fleet's ONLY contradicting signal going silent in the direction
/// that EXONERATES the audited agent, and any agent can trigger it deliberately
/// by putting one unpaired surrogate in one filename. An unauditable claim is
/// worse than a wrong one: reading 39 of 40 entries correctly beats reading
/// none. The module's "degrade to `unknown`, never to `mismatch`" rule is about
/// evidence we do not HAVE — it was never a licence to discard evidence we do.
///
/// See `reconcile` in orca-policy for what the surviving residual costs.
fn parse_task_claim(result: Option<&str>) -> Option<TaskClaim> {
    let text = result.filter(|text| !text.is_empty())?;
    let parsed = parse_json_past_lone_surrogate_escapes(text).ok()?;
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
///
/// Everything else is COERCED, because the twin's adapter is
/// `args.result === null || args.result === undefined ? null : String(args.result)`.
/// `as_str` instead of `String(…)` is not equivalent: a one-element array of
/// the result text stringifies to that text in JS and parses into a real claim,
/// where `as_str` answers `None` and silences it as `unreadable-result` — the
/// exonerating direction again.
fn result_at(input: &Value) -> Option<String> {
    match input.get("result") {
        None | Some(Value::Null) => None,
        Some(value) => Some(js_string(value)),
    }
}

/// `None` ONLY for `null`/absent — an empty array is a real git answer that
/// says "nothing changed", and the two must never collapse into one another.
///
/// Entries are COERCED, not filtered: the twin is `changedFiles.map(String)`,
/// so a non-string entry becomes a path. `filter_map(Value::as_str)` DROPPED
/// it, which moves git's answer in both wrong directions at once — a dropped
/// entry the worker claimed becomes `missing` (a false accusation), and a
/// dropped entry it did not claim vanishes from `unclaimed`, turning a real
/// `mismatch` into a clean `match`.
fn changed_files_at(input: &Value) -> Option<Vec<String>> {
    input
        .get("changedFiles")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(js_string).collect())
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
        "parseTaskClaim" => match parse_task_claim(result_at(input).as_deref()) {
            None => Value::Null,
            Some(claim) => json!({
                "completedBy": claim.completed_by,
                "filesModified": claim.files_modified,
            }),
        },
        "reconcileTaskClaim" => reconciliation_json(&reconcile_task_claim(
            task_status,
            parse_task_claim(result_at(input).as_deref()),
            changed_files_at(input).as_deref(),
        )),
        // Composed through `reconcile` rather than over a hand-built verdict,
        // which is the shape `alab-console.ts` actually calls it in.
        "describeReconciliation" => json!(describe_reconciliation(&reconcile_task_claim(
            task_status,
            parse_task_claim(result_at(input).as_deref()),
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

    // --- the escaped-lone-surrogate class: the claim must stay AUDITABLE ---

    /// What `JSON.stringify` actually writes for a lone surrogate: six ASCII
    /// characters. Built here the way the lifecycle reconciler builds it, so the
    /// test cannot drift from the writer by a transcription slip.
    const SURROGATE_IN_COMPLETED_BY: &str =
        r#"{"completedBy":"w\ud800","filesModified":["src/a.ts","src/b.ts"],"completedAt":"now"}"#;

    #[test]
    fn the_stored_column_is_pure_ascii_which_is_why_nothing_upstream_throws() {
        assert!(SURROGATE_IN_COMPLETED_BY.is_ascii());
        // ...and a strict parse is the ONLY thing in the chain that rejects it.
        assert!(serde_json::from_str::<Value>(SURROGATE_IN_COMPLETED_BY).is_err());
    }

    #[test]
    fn a_lone_surrogate_no_longer_silences_the_whole_claim() {
        let claim = parse_task_claim(Some(SURROGATE_IN_COMPLETED_BY)).expect("readable");
        // Every OTHER entry survives intact and stays comparable to git.
        assert_eq!(claim.files_modified, files(&["src/a.ts", "src/b.ts"]));
        assert_eq!(claim.completed_by.as_deref(), Some("w\u{fffd}"));
    }

    #[test]
    fn a_lone_surrogate_inside_a_path_repairs_only_that_entry() {
        let claim = parse_task_claim(Some(
            r#"{"filesModified":["src/a\ud800.ts","src/b.ts"]}"#,
        ))
        .expect("readable");
        assert_eq!(claim.files_modified, files(&["src/a\u{fffd}.ts", "src/b.ts"]));
    }

    #[test]
    fn the_verdict_reason_is_restored_not_just_the_verdict() {
        // A supervisor acts on the REASON. Before the repair this answered
        // `unreadable-result`; the twin answers `no-git`, because it parsed the
        // claim fine and it is GIT that is missing. Same word "unknown", two
        // completely different follow-ups.
        let verdict = dispatch(
            "reconcileTaskClaim",
            &json!({ "taskStatus": "completed", "result": SURROGATE_IN_COMPLETED_BY,
                     "changedFiles": Value::Null }),
        );
        assert_eq!(verdict, json!({ "verdict": "unknown", "reason": "no-git" }));
    }

    #[test]
    fn the_contradiction_survives_end_to_end_through_the_registered_dispatch() {
        let verdict = dispatch(
            "reconcileTaskClaim",
            &json!({ "taskStatus": "completed", "result": SURROGATE_IN_COMPLETED_BY,
                     "changedFiles": ["src/b.ts"] }),
        );
        assert_eq!(
            verdict,
            json!({ "verdict": "mismatch", "claimed": ["src/a.ts", "src/b.ts"],
                    "missing": ["src/a.ts"], "unclaimed": [] })
        );
    }

    #[test]
    fn a_surrogate_plus_a_real_syntax_error_stays_unreadable() {
        // The retry must not launder a document the twin also refuses.
        assert!(parse_task_claim(Some(r#"{"completedBy":"w\ud800","filesModified":["a.ts",]}"#))
            .is_none());
        // A truncated escape is not an escape; nothing is rewritten.
        assert!(parse_task_claim(Some(r#"{"completedBy":"w\ud80","filesModified":["a.ts"]}"#))
            .is_none());
    }

    #[test]
    fn a_matched_pair_is_a_real_character_and_is_never_rewritten() {
        // The literal character and its ESCAPED spelling are the same document;
        // both parse strictly, so neither ever reaches the rewrite.
        for text in [
            r#"{"filesModified":["src/🚀.ts"]}"#,
            r#"{"filesModified":["src/\ud83d\ude80.ts"]}"#,
        ] {
            let claim = parse_task_claim(Some(text)).expect("readable");
            assert_eq!(claim.files_modified, files(&["src/\u{1f680}.ts"]), "{text}");
        }
    }

    #[test]
    fn an_escaped_backslash_is_left_alone_because_the_strict_parse_took_it() {
        // `"a\\ud800.ts"` is a backslash then the TEXT ud800 — a healthy claim.
        // Strict-first is what keeps the repair away from it.
        let claim = parse_task_claim(Some(r#"{"filesModified":["a\\ud800.ts"]}"#)).expect("readable");
        assert_eq!(claim.files_modified, files(&[r"a\ud800.ts"]));
    }

    // --- the input adapters: the twin COERCES where this dropped ---

    #[test]
    fn changed_files_entries_are_coerced_not_dropped() {
        // Twin: `changedFiles.map(String)`. Dropping the `7` deleted git's own
        // answer, turning a real mismatch into a clean bill of health.
        let verdict = dispatch(
            "reconcileTaskClaim",
            &json!({ "taskStatus": "completed", "result": r#"{"filesModified":["a.ts"]}"#,
                     "changedFiles": ["a.ts", 7] }),
        );
        assert_eq!(
            verdict,
            json!({ "verdict": "mismatch", "claimed": ["a.ts"],
                    "missing": [], "unclaimed": ["7"] })
        );
    }

    #[test]
    fn a_dropped_changed_file_used_to_invent_a_false_accusation() {
        for (changed, claimed) in [(json!([42]), "42"), (json!([null]), "null")] {
            let verdict = dispatch(
                "reconcileTaskClaim",
                &json!({ "taskStatus": "completed",
                         "result": format!(r#"{{"filesModified":["{claimed}"]}}"#),
                         "changedFiles": changed }),
            );
            assert_eq!(
                verdict,
                json!({ "verdict": "match", "claimed": [claimed] }),
                "{changed}"
            );
        }
    }

    #[test]
    fn result_is_coerced_the_way_the_twin_coerces_it() {
        // `String(["{...}"])` is the element itself, and it parses.
        let verdict = dispatch(
            "reconcileTaskClaim",
            &json!({ "taskStatus": "completed",
                     "result": [r#"{"completedBy":"w1","filesModified":["a.ts"]}"#],
                     "changedFiles": ["a.ts"] }),
        );
        assert_eq!(verdict, json!({ "verdict": "match", "claimed": ["a.ts"] }));
    }

    #[test]
    fn null_and_absent_result_stay_unreadable_rather_than_becoming_the_text_null() {
        // `String(null)` is `"null"`, but the twin short-circuits null/undefined
        // BEFORE coercing. Coercing here would parse `null` and still land on
        // unreadable — but via the wrong branch, and `String(undefined)` would
        // be worse. Pin the branch.
        assert_eq!(result_at(&json!({ "result": Value::Null })), None);
        assert_eq!(result_at(&json!({})), None);
        assert_eq!(
            result_at(&json!({ "result": 42 })).as_deref(),
            Some("42")
        );
    }
}
