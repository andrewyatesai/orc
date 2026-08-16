//! Parity dispatch for `orca_core::agent_scratch_worktrees` vs
//! `src/shared/agent-scratch-worktrees.ts`.
//!
//! `createAgentScratchWorktreePathMatcher` returns a closure, which cannot cross
//! a JSON boundary, so its arm takes `{ checkoutPaths, worktreePath }` and
//! answers the closure's result for that one path — the same shape both adapters
//! drive, and the same call `classifyWorktreeOwnership` makes per row.

use orca_core::agent_scratch_worktrees::{
    is_agent_scratch_repo_root_path, is_agent_scratch_worktree_path,
    AgentScratchWorktreePathMatcher,
};
use serde_json::{json, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "isAgentScratchWorktreePath" => Value::Bool(is_agent_scratch_worktree_path(
            &str_field(input, "repoPath"),
            &str_field(input, "worktreePath"),
        )),
        "isAgentScratchRepoRootPath" => {
            Value::Bool(is_agent_scratch_repo_root_path(&str_field(input, "repoPath")))
        }
        "createAgentScratchWorktreePathMatcher" => {
            let checkouts: Vec<String> = input
                .get("checkoutPaths")
                .and_then(Value::as_array)
                .map(|items| {
                    items.iter().map(|item| item.as_str().unwrap_or_default().to_string()).collect()
                })
                .unwrap_or_default();
            Value::Bool(
                AgentScratchWorktreePathMatcher::new(&checkouts)
                    .matches(&str_field(input, "worktreePath")),
            )
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}
