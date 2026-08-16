//! Parity dispatch for `orca_core::stable_pane_id` vs
//! `src/shared/stable-pane-id.ts`.

use orca_core::stable_pane_id::{
    is_stable_pane_id, is_terminal_leaf_id, make_pane_key, parse_legacy_numeric_pane_key,
    parse_pane_key, LegacyNumericPaneKey, ParsedPaneKey,
};
use serde_json::{json, Value};

/// Shape guard text, mirrored verbatim in `tools/parity/dispatch/stable-pane-id.ts`.
const MAKE_PANE_KEY_SHAPE: &str = "makePaneKey expects { tabId: string, stableLeafId: string }";

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        // Two arguments, so the vector `input` is the named-argument object
        // `{ tabId, stableLeafId }` (the parameter names of the twin).
        //
        // THROWING IS THE CONTRACT: the twin throws on a colon-bearing/empty tab
        // id or a non-UUID leaf, and callers (src/main/persistence.ts:1916 and
        // :2337, useIpcEvents tryMakePaneKey, aterm-pane-open, …) treat the throw
        // as "not a pane". Every one of them catches bare, so no caller matches
        // the TEXT — but the message is still routed through the harness's error
        // marker so TS and Rust are diffed on the string, not just on failing.
        "makePaneKey" => {
            match (
                input.get("tabId").and_then(Value::as_str),
                input.get("stableLeafId").and_then(Value::as_str),
            ) {
                (Some(tab_id), Some(stable_leaf_id)) => {
                    match make_pane_key(tab_id, stable_leaf_id) {
                        Ok(pane_key) => Value::String(pane_key),
                        Err(message) => json!({ "__parity_error__": message }),
                    }
                }
                _ => json!({ "__parity_error__": MAKE_PANE_KEY_SHAPE }),
            }
        }
        "isStablePaneId" => match input.as_str() {
            Some(s) => Value::Bool(is_stable_pane_id(s)),
            None => json!({ "__parity_error__": "isStablePaneId expects a string" }),
        },
        "isTerminalLeafId" => match input.as_str() {
            Some(s) => Value::Bool(is_terminal_leaf_id(s)),
            None => json!({ "__parity_error__": "isTerminalLeafId expects a string" }),
        },
        "parsePaneKey" => match input.as_str() {
            Some(s) => parsed_pane_key_to_json(parse_pane_key(s)),
            None => json!({ "__parity_error__": "parsePaneKey expects a string" }),
        },
        // TS accepts `unknown` and returns null for non-strings; a non-string
        // Value yields None here, matching that null return.
        "parseLegacyNumericPaneKey" => {
            legacy_to_json(input.as_str().and_then(parse_legacy_numeric_pane_key))
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Match `JSON.stringify` of the TS `{ tabId, leafId, stablePaneId } | null`.
fn parsed_pane_key_to_json(parsed: Option<ParsedPaneKey>) -> Value {
    match parsed {
        // TS exposes `stablePaneId` as an alias of the leaf id (same branded string).
        Some(p) => json!({
            "tabId": p.tab_id,
            "leafId": p.leaf_id.clone(),
            "stablePaneId": p.leaf_id,
        }),
        None => Value::Null,
    }
}

/// Match `JSON.stringify` of the TS `{ tabId, numericPaneId, paneKey } | null`.
fn legacy_to_json(parsed: Option<LegacyNumericPaneKey>) -> Value {
    match parsed {
        Some(p) => json!({
            "tabId": p.tab_id,
            "numericPaneId": p.numeric_pane_id,
            "paneKey": p.pane_key,
        }),
        None => Value::Null,
    }
}
