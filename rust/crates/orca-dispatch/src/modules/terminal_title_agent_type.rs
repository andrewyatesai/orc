//! Parity dispatch for `orca_core::terminal_title_agent_type` vs
//! `src/shared/terminal-title-agent-type.ts`.
//!
//! The three classifier entry points (`getAgentLabel`,
//! `resolveTerminalTitleAgentType`, `resolveExplicitTerminalTitleAgentType`) are
//! what production crosses the seam for; the leaf predicates are exposed too so
//! the parity corpus can localise a divergence instead of only seeing the label
//! flip.
//!
//! A missing/non-string `title` maps to `""` — the same harness convention the
//! `agent-recognition` arm uses. It is a harness convention, not a semantic
//! equivalence: the TS `getAgentLabel(undefined)` throws a TypeError, so the
//! corpus must not feed it null.

use orca_core::terminal_title_agent_type::{
    contains_agent_spinner_glyph, contains_braille_spinner, contains_quarter_circle_spinner,
    get_agent_label, get_pi_compatible_synthetic_agent_label, is_claude_agent,
    is_claude_management_title, is_cursor_agent_title, is_cursor_native_agent_title,
    is_gemini_terminal_title, is_grok_rotating_working_title, is_legacy_pi_compatible_title,
    is_meaningful_opencode_terminal_title, is_opencode_native_title, is_pi_agent_title,
    is_pi_terminal_title, resolve_explicit_terminal_title_agent_type,
    resolve_terminal_title_agent_type,
};
use serde_json::{json, Value};

fn title(input: &Value) -> &str {
    input.get("title").and_then(Value::as_str).unwrap_or("")
}

/// `string | null | undefined` parameters keep the absent case distinguishable,
/// because the TS predicate branches on it rather than coercing.
fn nullable_title(input: &Value) -> Option<&str> {
    input.get("title").and_then(Value::as_str)
}

fn label(value: Option<&'static str>) -> Value {
    value.map_or(Value::Null, |v| Value::String(v.to_string()))
}

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "containsBrailleSpinner" => Value::Bool(contains_braille_spinner(title(input))),
        "containsQuarterCircleSpinner" => {
            Value::Bool(contains_quarter_circle_spinner(title(input)))
        }
        "containsAgentSpinnerGlyph" => Value::Bool(contains_agent_spinner_glyph(title(input))),
        "isClaudeManagementTitle" => Value::Bool(is_claude_management_title(title(input))),
        "isOpenCodeNativeTitle" => Value::Bool(is_opencode_native_title(nullable_title(input))),
        "isMeaningfulOpenCodeTerminalTitle" => {
            Value::Bool(is_meaningful_opencode_terminal_title(nullable_title(input)))
        }
        "isCursorAgentTitle" => Value::Bool(is_cursor_agent_title(nullable_title(input))),
        "isCursorNativeAgentTitle" => Value::Bool(is_cursor_native_agent_title(title(input))),
        "isLegacyPiCompatibleTitle" => Value::Bool(is_legacy_pi_compatible_title(title(input))),
        "isPiAgentTitle" => Value::Bool(is_pi_agent_title(title(input))),
        "isPiTerminalTitle" => Value::Bool(is_pi_terminal_title(title(input))),
        "getPiCompatibleSyntheticAgentLabel" => {
            label(get_pi_compatible_synthetic_agent_label(title(input)))
        }
        "isGeminiTerminalTitle" => Value::Bool(is_gemini_terminal_title(title(input))),
        "isGrokRotatingWorkingTitle" => Value::Bool(is_grok_rotating_working_title(title(input))),
        "isClaudeAgent" => Value::Bool(is_claude_agent(title(input))),
        "getAgentLabel" => label(get_agent_label(title(input))),
        "resolveTerminalTitleAgentType" => label(resolve_terminal_title_agent_type(title(input))),
        "resolveExplicitTerminalTitleAgentType" => {
            label(resolve_explicit_terminal_title_agent_type(title(input)))
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    /// Drive the REAL aggregate registry, not this module's `dispatch` directly —
    /// an unregistered arm is the failure mode a direct call cannot see.
    fn route(module: &str, function: &str, title: &str) -> serde_json::Value {
        crate::modules::dispatch(module, function, &json!({ "title": title }))
            .unwrap_or_else(|| panic!("module {module:?} is not registered"))
    }

    #[test]
    fn the_classifier_entry_points_are_reachable_through_the_registry() {
        let module = "terminal-title-agent-type";
        assert_eq!(route(module, "getAgentLabel", "⠋ Codex"), json!("Codex"));
        assert_eq!(
            route(module, "resolveTerminalTitleAgentType", "⠋ Cursor Agent"),
            json!("cursor")
        );
        // The suppressor arm: activity evidence with no `claude` name token.
        assert_eq!(
            route(module, "resolveTerminalTitleAgentType", "⠸ investigating startup"),
            json!("claude")
        );
        assert_eq!(
            route(
                module,
                "resolveExplicitTerminalTitleAgentType",
                "⠸ investigating startup"
            ),
            json!(null)
        );
        assert_eq!(route(module, "isClaudeAgent", "✳ Claude Code"), json!(true));
        assert_eq!(route(module, "getPiCompatibleSyntheticAgentLabel", "OMP"), json!("OMP"));
        assert_eq!(route(module, "getAgentLabel", "Terminal 1"), json!(null));
    }

    #[test]
    fn the_agent_title_identity_twin_resolves_to_the_same_ladder() {
        for title in ["⠋ Codex", "✳ Claude Code", "OC | task", "Terminal 1", "π - x"] {
            assert_eq!(
                route("agent-title-identity", "getAgentLabel", title),
                route("terminal-title-agent-type", "getAgentLabel", title),
                "{title:?}"
            );
            assert_eq!(
                route("agent-title-identity", "isClaudeAgent", title),
                route("terminal-title-agent-type", "isClaudeAgent", title),
                "{title:?}"
            );
        }
    }

    #[test]
    fn an_unknown_function_reports_a_parity_error_rather_than_a_default_answer() {
        let out = route("terminal-title-agent-type", "notAFunction", "x");
        assert!(out.get("__parity_error__").is_some(), "{out}");
    }
}
