//! Parity dispatch for `orca_core::git_upstream_status` vs
//! `src/shared/git-upstream-status.ts`.

use orca_core::git_upstream_status::{
    is_behind_only_upstream, should_force_push_with_lease_for_upstream, GitUpstreamStatus,
};
use serde_json::{json, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "shouldForcePushWithLeaseForUpstream" => {
            // null/non-object input mirrors the TS `undefined` status that the
            // optional chain short-circuits to false.
            let status = parse_status(input);
            Value::Bool(should_force_push_with_lease_for_upstream(status.as_ref()))
        }
        "isBehindOnlyUpstream" => {
            let status = parse_status(input);
            Value::Bool(is_behind_only_upstream(status.as_ref()))
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Rebuild the TS `GitUpstreamStatus` record from JSON. Absent fields take the
/// same defaults the TS truthiness checks see for `undefined` (false / 0 / None).
fn parse_status(input: &Value) -> Option<GitUpstreamStatus> {
    let obj = input.as_object()?;
    Some(GitUpstreamStatus {
        has_upstream: obj
            .get("hasUpstream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        upstream_name: obj
            .get("upstreamName")
            .and_then(Value::as_str)
            .map(str::to_string),
        // NaN is the faithful stand-in for the twin's `undefined`: `undefined === 0`
        // and `undefined > 0` are both false, and so is every NaN comparison.
        // `as_f64` also carries 0.5 and out-of-i64 values, which `as_i64`
        // silently turned into 0.
        ahead: obj.get("ahead").and_then(Value::as_f64).unwrap_or(f64::NAN),
        behind: obj.get("behind").and_then(Value::as_f64).unwrap_or(f64::NAN),
        has_configured_push_target: obj
            .get("hasConfiguredPushTarget")
            .and_then(Value::as_bool),
        behind_commits_are_patch_equivalent: obj
            .get("behindCommitsArePatchEquivalent")
            .and_then(Value::as_bool),
    })
}
