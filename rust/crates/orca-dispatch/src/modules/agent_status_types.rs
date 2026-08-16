//! Parity dispatch for `orca_agents::agent_status_types` vs
//! `src/shared/agent-status-types.ts`.

use orca_agents::{
    agent_subagents_equal_values, has_unsettled_or_unknown_dispatch,
    is_fresh_non_done_agent_status, normalize_agent_status_payload, parse_agent_status_payload,
    started_at_to_json, AgentSubagentSnapshot, ParsedAgentStatusPayload,
};
use serde_json::{json, Map, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        // Single arg: the raw JSON payload string the agent sent. A non-string
        // vector value can't be parsed, which mirrors the TS `null` result.
        "parseAgentStatusPayload" => match input.as_str().and_then(parse_agent_status_payload) {
            Some(parsed) => payload_to_json(&parsed),
            None => Value::Null,
        },
        // Single arg: the already-deserialized payload object, skipping the
        // JSON round trip. Same normalizer, same `null` for a malformed shape.
        "normalizeAgentStatusPayload" => match normalize_agent_status_payload(input) {
            Some(parsed) => payload_to_json(&parsed),
            None => Value::Null,
        },
        // Single arg: the status entry. Only `entry.orchestration` is read, so
        // a bare `{}` is the hook-only context that answers false.
        "hasUnsettledOrUnknownDispatch" => Value::Bool(has_unsettled_or_unknown_dispatch(input)),
        "isFreshNonDoneAgentStatus" => match input.get("now") {
            Some(now) => Value::Bool(is_fresh_non_done_agent_status(
                input.get("entry"),
                now,
                input.get("staleAfterMs"),
            )),
            // The twin defaults `now` to `Date.now()`. A clock read is not a
            // value this side can reproduce, so it is refused loudly instead of
            // being answered against some other instant. See the module note in
            // tools/parity/dispatch/agent-status-types.ts.
            None => parity_error(
                "isFreshNonDoneAgentStatus requires an explicit `now`; the twin's Date.now() default is a clock read",
            ),
        },
        "agentSubagentsEqual" => {
            match agent_subagents_equal_values(input.get("a"), input.get("b")) {
                Some(equal) => Value::Bool(equal),
                None => parity_error(
                    "agentSubagentsEqual operands must be arrays (or absent/null) with no null element; the twin duck-types `.length` and throws on a null entry",
                ),
            }
        }
        other => parity_error(&format!("unknown function {other}")),
    }
}

fn parity_error(message: &str) -> Value {
    json!({ "__parity_error__": message })
}

/// Match `JSON.stringify` of the TS `ParsedAgentStatusPayload`: `state` as its
/// string id, `prompt` always present, every optional omitted (not emitted as
/// `null`) when `None` — exactly what `JSON.stringify` drops for `undefined`.
fn payload_to_json(payload: &ParsedAgentStatusPayload) -> Value {
    let mut map = Map::new();
    map.insert("state".to_string(), Value::String(payload.state.id().to_string()));
    map.insert("prompt".to_string(), Value::String(payload.prompt.clone()));
    insert_optional_text(&mut map, "agentType", payload.agent_type.as_deref());
    insert_optional_text(&mut map, "model", payload.model.as_deref());
    insert_optional_text(&mut map, "toolName", payload.tool_name.as_deref());
    insert_optional_text(&mut map, "toolInput", payload.tool_input.as_deref());
    insert_optional_text(&mut map, "interactivePrompt", payload.interactive_prompt.as_deref());
    insert_optional_text(
        &mut map,
        "lastAssistantMessage",
        payload.last_assistant_message.as_deref(),
    );
    if let Some(interrupted) = payload.interrupted {
        map.insert("interrupted".to_string(), Value::Bool(interrupted));
    }
    if let Some(launch_failed) = payload.launch_failed {
        map.insert("launchFailed".to_string(), Value::Bool(launch_failed));
    }
    if let Some(subagents) = &payload.subagents {
        map.insert(
            "subagents".to_string(),
            Value::Array(subagents.iter().map(subagent_to_json).collect()),
        );
    }
    Value::Object(map)
}

fn subagent_to_json(subagent: &AgentSubagentSnapshot) -> Value {
    let mut map = Map::new();
    map.insert("id".to_string(), Value::String(subagent.id.clone()));
    map.insert("state".to_string(), Value::String(subagent.state.id().to_string()));
    map.insert("startedAt".to_string(), started_at_to_json(subagent.started_at));
    insert_optional_text(&mut map, "agentType", subagent.agent_type.as_deref());
    insert_optional_text(&mut map, "model", subagent.model.as_deref());
    insert_optional_text(&mut map, "description", subagent.description.as_deref());
    Value::Object(map)
}

fn insert_optional_text(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(text) = value {
        map.insert(key.to_string(), Value::String(text.to_string()));
    }
}
