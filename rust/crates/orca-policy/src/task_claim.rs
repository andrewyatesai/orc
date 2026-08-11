//! Compares what a worker SAID it changed against what git says it changed.
//!
//! Ported from `src/main/runtime/orchestration/task-claim-reconciliation.ts`
//! (`parseTaskClaim`, `reconcileTaskClaim`, `describeReconciliation`), the
//! §8.4 claim check the fleet console renders.
//!
//! This lives beside the authority decisions rather than with the formatters
//! because it is the only signal in the fleet that can CONTRADICT an agent.
//! Everything else on the console is the fleet describing itself; a task
//! claiming three modified files where git shows none is the one thing that
//! catches a worker lying or confused. Without it, "completed" is 100%
//! self-attestation.
//!
//! **It degrades to `unknown`, never to `mismatch`.** On a folder workspace
//! there is no git to ask, and an absent answer is not a discrepancy. Reporting
//! "mismatch" when the truth is "I could not check" trains a supervisor to
//! ignore the alert, which costs more than not having the alert at all. The
//! three `unknown` reasons are kept distinct for the same reason: "still
//! running", "result unreadable" and "no git" are three different follow-ups.
//!
//! Pure: git status is injected, so the comparison is a total function over its
//! inputs and needs no repository to test.
//!
//! Panic-free: no indexing, no `unwrap`, no slicing by computed range.

use serde_json::Value;

/// `TaskRow.result` is JSON written by the lifecycle reconciler.
pub struct TaskClaim {
    pub completed_by: Option<String>,
    pub files_modified: Vec<String>,
}

/// Why the claim could not be checked. Never a discrepancy — an unchecked claim
/// and a false claim are different facts and must stay different words.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub enum UnknownReason {
    /// No git to ask: a folder workspace, or a status read that failed.
    NoGit,
    /// A `result` that is absent, not JSON, or not a JSON object.
    UnreadableResult,
    /// A task that has not finished has not claimed anything yet.
    NotCompleted,
}

impl UnknownReason {
    /// The exact strings the TS side emits, so parity is textual.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoGit => "no-git",
            Self::UnreadableResult => "unreadable-result",
            Self::NotCompleted => "not-completed",
        }
    }
}

#[cfg_attr(test, derive(Debug, PartialEq))]
pub enum ClaimReconciliation {
    Unknown(UnknownReason),
    Match {
        claimed: Vec<String>,
    },
    Mismatch {
        claimed: Vec<String>,
        /// Claimed but not changed on disk — the alarming direction.
        missing: Vec<String>,
        /// Changed on disk but never claimed — sloppy, not necessarily wrong.
        unclaimed: Vec<String>,
    },
}

/// Tolerates the several shapes `result` has carried; anything else is unknown.
///
/// An empty string is the TS `if (!result)` arm, not a parse failure — the
/// column was never written.
#[must_use]
pub fn parse_task_claim(result: Option<&str>) -> Option<TaskClaim> {
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
#[must_use]
pub fn parse_task_claim_value(parsed: &Value) -> Option<TaskClaim> {
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

/// JS `String.prototype.trim` — deliberately NOT `char::is_whitespace`.
///
/// The two disagree in both directions on exactly two code points: JS trims
/// U+FEFF (ZWNBSP, which a BOM-prefixed tool output really does emit) and Rust
/// does not; Rust trims U+0085 (NEL) and JS does not. Using the Rust set would
/// make one side see `\u{feff}src/a.ts` as a different file from `src/a.ts`,
/// which is a mismatch invented by the port.
fn is_js_trim_whitespace(ch: char) -> bool {
    ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}')
}

/// Paths arrive from two systems with different conventions; compare shapes.
///
/// Exactly one leading `./` is dropped (JS `replace` without `/g`), then every
/// leading and trailing `/`. Backslashes are deliberately untouched — see the
/// module note in the vectors.
#[must_use]
pub fn normalize_claim_path(path: &str) -> String {
    let trimmed = path.trim_matches(is_js_trim_whitespace);
    let relative = trimmed.strip_prefix("./").unwrap_or(trimmed);
    relative
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string()
}

/// The §8.4 decision.
///
/// Order is load-bearing: status first (a running task has not spoken), then
/// the claim (an unreadable result is unreadable whether or not git answered),
/// then git availability. Each precedence step is pinned by its own vector,
/// because a supervisor reads the REASON, not just the verdict.
#[must_use]
pub fn reconcile_task_claim(
    task_status: &str,
    result: Option<&str>,
    changed_files: Option<&[String]>,
) -> ClaimReconciliation {
    if task_status != "completed" {
        return ClaimReconciliation::Unknown(UnknownReason::NotCompleted);
    }
    let claim = match parse_task_claim(result) {
        Some(claim) => claim,
        None => return ClaimReconciliation::Unknown(UnknownReason::UnreadableResult),
    };
    // Folder workspace, or git unavailable. NOT a mismatch.
    let changed_files = match changed_files {
        Some(changed_files) => changed_files,
        None => return ClaimReconciliation::Unknown(UnknownReason::NoGit),
    };

    // The claim keeps its duplicates: `["a.ts", "./a.ts"]` is a worker that
    // named one file twice, and flattening that would hide it from the count.
    let claimed: Vec<String> = claim
        .files_modified
        .iter()
        .map(|file| normalize_claim_path(file))
        .filter(|file| !file.is_empty())
        .collect();

    // git's side is a JS `Set`: de-duplicated, FIRST-occurrence order, which is
    // the order `unclaimed` is reported in.
    let mut actual: Vec<String> = Vec::new();
    for file in changed_files {
        let file = normalize_claim_path(file);
        if file.is_empty() || actual.iter().any(|seen| *seen == file) {
            continue;
        }
        actual.push(file);
    }

    let missing: Vec<String> = claimed
        .iter()
        .filter(|file| !actual.iter().any(|seen| seen == *file))
        .cloned()
        .collect();
    let unclaimed: Vec<String> = actual
        .iter()
        .filter(|file| !claimed.iter().any(|seen| seen == *file))
        .cloned()
        .collect();

    if missing.is_empty() && unclaimed.is_empty() {
        return ClaimReconciliation::Match { claimed };
    }
    ClaimReconciliation::Mismatch {
        claimed,
        missing,
        unclaimed,
    }
}

/// A one-line summary for the console. Never says "mismatch" for `unknown`.
#[must_use]
pub fn describe_reconciliation(reconciliation: &ClaimReconciliation) -> String {
    match reconciliation {
        ClaimReconciliation::Match { claimed } => {
            format!("{} file(s) claimed and changed", claimed.len())
        }
        // The alarming direction wins the sentence when both are non-empty.
        ClaimReconciliation::Mismatch {
            missing, unclaimed, ..
        } => {
            if missing.is_empty() {
                format!("changed {} file(s) it did not claim", unclaimed.len())
            } else {
                format!(
                    "claimed {} file(s) git does not show as changed",
                    missing.len()
                )
            }
        }
        ClaimReconciliation::Unknown(UnknownReason::NoGit) => {
            "cannot check on a folder workspace".to_string()
        }
        ClaimReconciliation::Unknown(_) => "nothing to check yet".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed(files: &[&str]) -> String {
        let list = files
            .iter()
            .map(|file| format!("\"{file}\""))
            .collect::<Vec<_>>()
            .join(",");
        format!("{{\"completedBy\":\"w1\",\"filesModified\":[{list}],\"completedAt\":\"now\"}}")
    }

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn is_the_alert_that_can_contradict_an_agent() {
        let claim = completed(&["src/a.ts", "src/b.ts", "src/c.ts"]);
        assert_eq!(
            reconcile_task_claim("completed", Some(&claim), Some(&[])),
            ClaimReconciliation::Mismatch {
                claimed: files(&["src/a.ts", "src/b.ts", "src/c.ts"]),
                missing: files(&["src/a.ts", "src/b.ts", "src/c.ts"]),
                unclaimed: files(&[]),
            }
        );
    }

    #[test]
    fn degrades_to_unknown_with_no_git_never_to_mismatch() {
        // Same claim that mismatches above; a null answer must NOT convict it.
        let claim = completed(&["src/a.ts", "src/b.ts", "src/c.ts"]);
        let verdict = reconcile_task_claim("completed", Some(&claim), None);
        assert_eq!(verdict, ClaimReconciliation::Unknown(UnknownReason::NoGit));
        assert!(!describe_reconciliation(&verdict).contains("mismatch"));
    }

    #[test]
    fn keeps_the_three_unknown_reasons_apart() {
        let claim = completed(&["src/a.ts"]);
        assert_eq!(
            reconcile_task_claim("dispatched", Some(&claim), Some(&[])),
            ClaimReconciliation::Unknown(UnknownReason::NotCompleted)
        );
        assert_eq!(
            reconcile_task_claim("completed", Some("not json"), Some(&[])),
            ClaimReconciliation::Unknown(UnknownReason::UnreadableResult)
        );
        assert_eq!(
            reconcile_task_claim("completed", None, Some(&[])),
            ClaimReconciliation::Unknown(UnknownReason::UnreadableResult)
        );
        assert_eq!(
            reconcile_task_claim("completed", Some(&claim), None),
            ClaimReconciliation::Unknown(UnknownReason::NoGit)
        );
    }

    #[test]
    fn reports_status_before_the_result_and_the_result_before_git() {
        // A running task with garbage in `result` is still "not-completed": the
        // follow-up is "wait", not "go read the row".
        assert_eq!(
            reconcile_task_claim("dispatched", Some("not json"), None),
            ClaimReconciliation::Unknown(UnknownReason::NotCompleted)
        );
        assert_eq!(
            reconcile_task_claim("completed", Some("not json"), None),
            ClaimReconciliation::Unknown(UnknownReason::UnreadableResult)
        );
    }

    #[test]
    fn distinguishes_missing_from_unclaimed() {
        let claim = completed(&["src/a.ts", "src/b.ts"]);
        assert_eq!(
            reconcile_task_claim(
                "completed",
                Some(&claim),
                Some(&files(&["src/b.ts", "src/c.ts"]))
            ),
            ClaimReconciliation::Mismatch {
                claimed: files(&["src/a.ts", "src/b.ts"]),
                missing: files(&["src/a.ts"]),
                unclaimed: files(&["src/c.ts"]),
            }
        );
    }

    #[test]
    fn normalizes_path_shape() {
        for claimed in ["./src/a.ts", "/src/a.ts/", " src/a.ts ", "\u{feff}src/a.ts"] {
            let claim = completed(&[claimed]);
            assert_eq!(
                reconcile_task_claim("completed", Some(&claim), Some(&files(&["src/a.ts"]))),
                ClaimReconciliation::Match {
                    claimed: files(&["src/a.ts"])
                },
                "{claimed}"
            );
        }
    }

    #[test]
    fn does_not_trim_a_code_point_js_keeps() {
        // U+0085 is Unicode White_Space (so Rust's `trim` eats it) but is NOT in
        // the JS trim set. Eating it here would invent a match TS never sees.
        let claim = completed(&["\u{85}src/a.ts"]);
        assert!(matches!(
            reconcile_task_claim("completed", Some(&claim), Some(&files(&["src/a.ts"]))),
            ClaimReconciliation::Mismatch { .. }
        ));
    }

    #[test]
    fn a_claim_of_nothing_with_nothing_changed_is_a_match() {
        assert_eq!(
            reconcile_task_claim("completed", Some(&completed(&[])), Some(&[])),
            ClaimReconciliation::Match {
                claimed: files(&[])
            }
        );
    }

    #[test]
    fn de_duplicates_git_but_not_the_claim() {
        // Two spellings of one file in the CLAIM stay two entries (the count is
        // the worker's own arithmetic); in git's answer they are one file.
        let claim = completed(&["src/a.ts", "./src/a.ts"]);
        assert_eq!(
            reconcile_task_claim(
                "completed",
                Some(&claim),
                Some(&files(&["src/a.ts", "/src/a.ts"]))
            ),
            ClaimReconciliation::Match {
                claimed: files(&["src/a.ts", "src/a.ts"])
            }
        );
    }

    #[test]
    fn drops_entries_that_normalize_to_nothing() {
        let claim = "{\"filesModified\":[\"\",\"  \",\"/\"]}";
        assert_eq!(
            reconcile_task_claim("completed", Some(claim), Some(&[])),
            ClaimReconciliation::Match {
                claimed: files(&[])
            }
        );
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

    #[test]
    fn describes_without_ever_saying_mismatch_for_unknown() {
        for reason in [
            UnknownReason::NoGit,
            UnknownReason::UnreadableResult,
            UnknownReason::NotCompleted,
        ] {
            let summary = describe_reconciliation(&ClaimReconciliation::Unknown(reason));
            assert!(!summary.contains("mismatch"), "{summary}");
        }
    }

    #[test]
    fn describes_the_alarming_direction_first() {
        assert_eq!(
            describe_reconciliation(&ClaimReconciliation::Mismatch {
                claimed: files(&["a.ts"]),
                missing: files(&["a.ts"]),
                unclaimed: files(&["b.ts"]),
            }),
            "claimed 1 file(s) git does not show as changed"
        );
        assert_eq!(
            describe_reconciliation(&ClaimReconciliation::Mismatch {
                claimed: files(&[]),
                missing: files(&[]),
                unclaimed: files(&["b.ts"]),
            }),
            "changed 1 file(s) it did not claim"
        );
    }
}
