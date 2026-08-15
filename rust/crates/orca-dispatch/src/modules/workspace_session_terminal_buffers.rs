//! Parity dispatch for `orca_config::workspace_session_terminal_buffers` vs
//! `src/shared/workspace-session-terminal-buffers.ts`.

use orca_config::workspace_session_terminal_buffers::{
    cap_terminal_scrollback_session_buffer, prune_local_terminal_scrollback_buffers,
    should_preserve_terminal_scrollback_buffers, RepoConnection,
};
use serde_json::{json, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "shouldPreserveTerminalScrollbackBuffers" => {
            // A JSON `null`/absent worktreeId maps to `None` (TS `undefined`).
            let worktree_id = input.get("worktreeId").and_then(Value::as_str);
            let repos = parse_repos(input.get("repos"));
            Value::Bool(should_preserve_terminal_scrollback_buffers(worktree_id, &repos))
        }
        "capTerminalScrollbackSessionBuffer" => {
            let buffer = input.get("buffer").and_then(Value::as_str).unwrap_or_default();
            let byte_limit = parse_byte_limit(input.get("byteLimit"));
            Value::String(cap_terminal_scrollback_session_buffer(buffer, byte_limit))
        }
        "pruneLocalTerminalScrollbackBuffers" => {
            let repos = parse_repos(input.get("repos"));
            let session = input.get("session").cloned().unwrap_or(Value::Null);
            let byte_limit =
                parse_byte_limit(input.get("opts").and_then(|opts| opts.get("bufferByteLimit")));
            prune_local_terminal_scrollback_buffers(&session, &repos, byte_limit)
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Absent or `null` selects the TS default parameter. (The TS adapter coalesces
/// `null` to `undefined` for the same reason: JS `null` would arithmetically
/// coerce to 0 rather than take the default, which no caller wants and no vector
/// exercises — keeping both adapters on the same rule avoids inventing one.)
///
/// Fractional limits floor: every byte cost is a whole number, so
/// `total > 10.5` and `total > 10` accept the same tails. A non-finite limit
/// saturates, matching `Number.isFinite(stopAfterBytes)` never tripping.
fn parse_byte_limit(value: Option<&Value>) -> Option<usize> {
    let limit = value?.as_f64()?;
    if limit.is_nan() {
        // JS: every `bytes > NaN` comparison is false, so nothing is ever cut.
        return Some(usize::MAX);
    }
    if limit <= 0.0 {
        return Some(0);
    }
    if limit >= usize::MAX as f64 {
        return Some(usize::MAX);
    }
    Some(limit.floor() as usize)
}

/// `connectionId`/`executionHostId` are `string | null | undefined` on the TS
/// side; both `null` and absent map to `None`.
fn parse_repos(value: Option<&Value>) -> Vec<RepoConnection> {
    value
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_object)
                .map(|object| RepoConnection {
                    id: object.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    connection_id: optional_string(object.get("connectionId")),
                    execution_host_id: optional_string(object.get("executionHostId")),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}
