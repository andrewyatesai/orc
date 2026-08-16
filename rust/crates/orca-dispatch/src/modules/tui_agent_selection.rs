//! Parity dispatch for `orca_agents::tui_agent_selection` vs
//! `src/shared/tui-agent-selection.ts`.

use orca_agents::{
    collapse_default_tui_agent_to_builtin, filter_enabled_tui_agents, is_tui_agent_enabled,
    normalize_disabled_tui_agents, pick_tui_agent, CollapsedDefaultTuiAgent, CustomAgentProfileRef,
    DefaultTuiAgentPref,
};
use serde_json::{json, Value};

/// TS `undefined` has no JSON image, so the "no preference was ever saved"
/// answer is this sentinel on both legs — the same encoding `repo-icon` uses for
/// its tri-state result, and a string the preference union cannot otherwise
/// hold. A cutover shim MUST map it back to `undefined`: callers spread the
/// answer into props/IPC payloads where an absent key and `null` differ.
const COLLAPSE_UNDEFINED: &str = "__undefined__";

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "collapseDefaultTuiAgentToBuiltin" => {
            let roster = custom_agent_roster(input.get("customAgents"));
            match default_tui_agent_pref(input.get("pref")) {
                Some(pref) => {
                    collapsed_to_json(collapse_default_tui_agent_to_builtin(pref, &roster))
                }
                None => json!({
                    "__parity_error__":
                        "collapseDefaultTuiAgentToBuiltin: `pref` is outside the TS union \
                         (TuiAgent | 'blank' | { kind: 'custom', id } | null | absent)"
                }),
            }
        }
        "pickTuiAgent" => {
            let preferred = input.get("preferred").and_then(Value::as_str);
            let detected = json_str_args(input.get("detected"));
            let disabled = json_str_args(input.get("disabled"));
            match pick_tui_agent(preferred, &detected, &disabled) {
                Some(agent) => Value::String(agent),
                None => Value::Null,
            }
        }
        "normalizeDisabledTuiAgents" => {
            // Single-arg: input is the raw value; non-arrays yield [] like the TS guard.
            let value = json_str_args(Some(input));
            strings_to_json(normalize_disabled_tui_agents(&value))
        }
        "isTuiAgentEnabled" => {
            let agent = input.get("agent").and_then(Value::as_str).unwrap_or("");
            let disabled = json_str_args(input.get("disabled"));
            Value::Bool(is_tui_agent_enabled(agent, &disabled))
        }
        "filterEnabledTuiAgents" => {
            let agents = json_str_args(input.get("agents"));
            let disabled = json_str_args(input.get("disabled"));
            strings_to_json(filter_enabled_tui_agents(&agents, &disabled))
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Decode the `pref` argument. An ABSENT key is TS `undefined` (`JSON.stringify`
/// drops it); a present `null` is not. Objects — and arrays, which are objects
/// to the twin's `typeof pref === 'object'` guard — take the custom-profile
/// path. `None` means the input is outside the declared union (a number/bool
/// pref, or an `id` that is present but not a string): not modelled, so the arm
/// says so instead of inventing an answer.
fn default_tui_agent_pref(value: Option<&Value>) -> Option<DefaultTuiAgentPref<'_>> {
    match value {
        None => Some(DefaultTuiAgentPref::Undefined),
        Some(Value::Null) => Some(DefaultTuiAgentPref::Null),
        Some(Value::String(agent)) => Some(DefaultTuiAgentPref::Builtin(agent)),
        Some(Value::Array(_)) => Some(DefaultTuiAgentPref::Custom { id: None }),
        Some(Value::Object(fields)) => match fields.get("id") {
            None => Some(DefaultTuiAgentPref::Custom { id: None }),
            Some(Value::String(id)) => Some(DefaultTuiAgentPref::Custom { id: Some(id) }),
            Some(_) => None,
        },
        Some(_) => None,
    }
}

/// Decode the `customAgents` roster. A non-array (TS `undefined`/`null`) and an
/// empty array are the same input — both resolve a custom preference to null.
/// Entries that are not objects, or whose `id` is present but not a string, are
/// outside the `CustomAgentProfile` contract and are skipped rather than
/// guessed at (the twin would read `.id` off a boxed primitive, or throw on a
/// `null` element).
fn custom_agent_roster(value: Option<&Value>) -> Vec<CustomAgentProfileRef<'_>> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(custom_agent_profile_ref).collect())
        .unwrap_or_default()
}

fn custom_agent_profile_ref(item: &Value) -> Option<CustomAgentProfileRef<'_>> {
    let fields = item.as_object()?;
    let id = match fields.get("id") {
        None => None,
        Some(Value::String(id)) => Some(id.as_str()),
        Some(_) => return None,
    };
    Some(CustomAgentProfileRef { id, base_agent: fields.get("baseAgent").and_then(Value::as_str) })
}

fn collapsed_to_json(collapsed: CollapsedDefaultTuiAgent<'_>) -> Value {
    match collapsed {
        CollapsedDefaultTuiAgent::Undefined => Value::String(COLLAPSE_UNDEFINED.to_string()),
        CollapsedDefaultTuiAgent::Null => Value::Null,
        CollapsedDefaultTuiAgent::Builtin(agent) => Value::String(agent.to_string()),
    }
}

/// Borrow a JSON array as `&str` args; non-strings (e.g. the TS `null` member)
/// become "" so positions are preserved but they drop out as non-agents — the
/// same outcome as the TS `isTuiAgent` filter. Non-arrays yield an empty slice.
fn json_str_args(value: Option<&Value>) -> Vec<&str> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|v| v.as_str().unwrap_or("")).collect())
        .unwrap_or_default()
}

fn strings_to_json(values: Vec<String>) -> Value {
    Value::Array(values.into_iter().map(Value::String).collect())
}
