//! Parity dispatch for `orca_policy` vs its TS twins
//! `src/main/story-world/play-path-guard.ts` and `src/shared/fleet-grant.ts`.
//!
//! Unlike most modules here, these two are *authority* decisions rather than
//! formatting or ranking: "may this file be served to a child's browser" and
//! "may this caller type into that agent's terminal". The parity seam exists so
//! the verified Rust answer and the shipping TS answer cannot drift apart
//! silently — the shared `parity-corpus.txt` is run by both sides.
//!
//! Only the LEXICAL half of the play-path decision crosses this seam. The
//! realpath half needs a filesystem, so it stays where the syscall is.

use orca_policy::{
    decide_fleet_grant, decide_play_path_lexical, is_allowed_play_host, Grant, GrantRequest,
    GrantTarget, PlayPathVerdict,
};
use serde_json::{json, Value};

fn string_at(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// An absent/non-string field reads as `None`, which is the FAIL-CLOSED side for
/// `incarnation`: unknown incarnation means a respawn cannot be ruled out.
fn optional_string_at(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn string_list_at(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_grant(value: &Value) -> Grant {
    Grant {
        generation: value.get("generation").and_then(Value::as_u64).unwrap_or(0),
        ops: string_list_at(value, "ops"),
        targets: value
            .get("targets")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|target| GrantTarget {
                        handle: string_at(target, "handle"),
                        incarnation: optional_string_at(target, "incarnation"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        expires_at_ms: value.get("expiresAtMs").and_then(Value::as_u64),
        revoked: value
            .get("revoked")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        // Returns the TS `PlayPathDecision` shape minus `absolutePath`, which
        // only the realpath half can supply.
        "decidePlayPathLexical" => match decide_play_path_lexical(&string_at(input, "requestPath"))
        {
            PlayPathVerdict::NeedsRealpathCheck { relative_path } => {
                json!({ "allowed": true, "relativePath": relative_path })
            }
            PlayPathVerdict::Denied(denial) => {
                json!({ "allowed": false, "reason": denial.as_str() })
            }
        },
        // An absent Host header reads as the empty string, which has no port and
        // is therefore refused — same as the TS `if (!host) return false`.
        "isAllowedPlayHost" => json!(is_allowed_play_host(
            input.get("host").and_then(Value::as_str).unwrap_or_default(),
            u16::try_from(
                input
                    .get("expectedPort")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            )
            .unwrap_or(0),
        )),
        "decideFleetGrant" => {
            let grant = input.get("grant").filter(|g| !g.is_null()).map(parse_grant);
            let request = GrantRequest {
                op: string_at(input, "op"),
                handle: string_at(input, "handle"),
                incarnation: optional_string_at(input, "incarnation"),
                current_generation: input
                    .get("currentGeneration")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                now_ms: input.get("nowMs").and_then(Value::as_u64).unwrap_or(0),
            };
            match decide_fleet_grant(grant.as_ref(), &request) {
                None => json!({ "allowed": true }),
                Some(denial) => json!({ "allowed": false, "reason": denial.as_str() }),
            }
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}
