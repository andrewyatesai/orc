//! Parity dispatch for `src/shared/agent-title-identity.ts`.
//!
//! That module is a byte-identical twin of `terminal-title-agent-type.ts`'s
//! `getAgentLabel` / `isClaudeAgent` (same rungs, same order; only comments and
//! an `if (c) return true; return false` reshaping differ). The Rust ladder is
//! implemented ONCE in `orca_core::terminal_title_agent_type`; this arm exists so
//! the parity harness drives BOTH TypeScript entry points against it and catches
//! drift between the copies.

use orca_core::terminal_title_agent_type::{get_agent_label, is_claude_agent};
use serde_json::{json, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    let title = input.get("title").and_then(Value::as_str).unwrap_or("");
    match function {
        "isClaudeAgent" => Value::Bool(is_claude_agent(title)),
        "getAgentLabel" => {
            get_agent_label(title).map_or(Value::Null, |v| Value::String(v.to_string()))
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}
