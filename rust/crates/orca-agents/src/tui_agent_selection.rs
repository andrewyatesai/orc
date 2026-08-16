//! TUI-agent auto-pick + enable/disable filtering, ported from
//! `src/shared/tui-agent-selection.ts`.
//!
//! Agents are referenced by their string id (the `TuiAgent` catalog).
//! [`TUI_AGENT_AUTO_PICK_ORDER`] is the desktop catalog in fallback-priority
//! order; per the source it is kept in sync with the full catalog, so
//! membership in it is the validity check (`is_tui_agent`).

/// Desktop agent catalog in automatic-fallback priority order.
pub const TUI_AGENT_AUTO_PICK_ORDER: [&str; 34] = [
    "claude",
    "claude-agent-teams",
    "openclaude",
    "codex",
    "grok",
    "copilot",
    "opencode",
    "mimo-code",
    "ante",
    "pi",
    "omp",
    "gemini",
    "antigravity",
    "aider",
    "goose",
    "amp",
    "kilo",
    "kiro",
    "crush",
    "aug",
    "autohand",
    "cline",
    "codebuff",
    "command-code",
    "continue",
    "cursor",
    "droid",
    "kimi",
    "mistral-vibe",
    "qwen-code",
    "rovo",
    "hermes",
    "devin",
    "openclaw",
];

pub fn is_tui_agent(value: &str) -> bool {
    TUI_AGENT_AUTO_PICK_ORDER.contains(&value)
}

/// A saved `defaultTuiAgent` preference: the TS union
/// `TuiAgent | 'blank' | { kind: 'custom'; id } | null | undefined`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultTuiAgentPref<'a> {
    /// TS `undefined` — the setting was never written. Distinct from [`Self::Null`]
    /// because the twin passes each through unchanged.
    Undefined,
    /// TS `null` — the explicit "auto" choice.
    Null,
    /// A built-in agent id, or `"blank"`. Passed through verbatim: the twin
    /// never checks the string against the catalog.
    Builtin(&'a str),
    /// `{ kind: 'custom', id }`. `id: None` models an object with no `id`
    /// property; the twin matches with `===`, so it does match a roster entry
    /// that also has none (`undefined === undefined`).
    Custom { id: Option<&'a str> },
}

/// The answer of [`collapse_default_tui_agent_to_builtin`] — the same union
/// with the custom arm resolved away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollapsedDefaultTuiAgent<'a> {
    Undefined,
    Null,
    Builtin(&'a str),
}

/// The two `CustomAgentProfile` fields the collapse reads. `base_agent` is
/// `None` when the profile's `baseAgent` is absent or null (the twin's `?? null`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CustomAgentProfileRef<'a> {
    pub id: Option<&'a str>,
    pub base_agent: Option<&'a str>,
}

/// Collapse a saved `defaultTuiAgent` preference to its built-in base for
/// consumers that only understand built-ins: a custom entry resolves to its
/// profile's `baseAgent`, or to `Null` (auto) when the profile no longer exists
/// or no roster was given. Every other preference passes through unchanged.
///
/// An absent roster and an empty one are the same input here — the twin's
/// `customAgents?.find(...)` yields `undefined` for both, and `?? null` maps it
/// to `Null`.
pub fn collapse_default_tui_agent_to_builtin<'a>(
    pref: DefaultTuiAgentPref<'a>,
    custom_agents: &[CustomAgentProfileRef<'a>],
) -> CollapsedDefaultTuiAgent<'a> {
    match pref {
        DefaultTuiAgentPref::Custom { id } => custom_agents
            .iter()
            .find(|profile| profile.id == id)
            .and_then(|profile| profile.base_agent)
            .map_or(CollapsedDefaultTuiAgent::Null, CollapsedDefaultTuiAgent::Builtin),
        DefaultTuiAgentPref::Builtin(agent) => CollapsedDefaultTuiAgent::Builtin(agent),
        DefaultTuiAgentPref::Null => CollapsedDefaultTuiAgent::Null,
        DefaultTuiAgentPref::Undefined => CollapsedDefaultTuiAgent::Undefined,
    }
}

/// Pick the agent to launch: an installed, enabled `preferred`; else the first
/// installed, enabled agent in catalog order. `preferred == Some("blank")` is
/// the explicit "no agent" choice. `None` if nothing qualifies.
pub fn pick_tui_agent(preferred: Option<&str>, detected: &[&str], disabled: &[&str]) -> Option<String> {
    if preferred == Some("blank") {
        return None;
    }
    let disabled = normalize_disabled_tui_agents(disabled);
    let enabled_and_detected =
        |agent: &str| detected.contains(&agent) && !disabled.iter().any(|d| d == agent);

    if let Some(preferred) = preferred {
        if enabled_and_detected(preferred) {
            return Some(preferred.to_string());
        }
    }
    TUI_AGENT_AUTO_PICK_ORDER.into_iter().find(|agent| enabled_and_detected(agent)).map(str::to_string)
}

/// Valid agent ids from a raw list, deduped and order-preserving; unsupported
/// values are dropped.
pub fn normalize_disabled_tui_agents(value: &[&str]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for item in value {
        if is_tui_agent(item) && !seen.iter().any(|s| s == item) {
            seen.push((*item).to_string());
        }
    }
    seen
}

pub fn is_tui_agent_enabled(agent: &str, disabled: &[&str]) -> bool {
    !normalize_disabled_tui_agents(disabled).iter().any(|d| d == agent)
}

pub fn filter_enabled_tui_agents(agents: &[&str], disabled: &[&str]) -> Vec<String> {
    let disabled = normalize_disabled_tui_agents(disabled);
    agents.iter().filter(|agent| !disabled.iter().any(|d| d == *agent)).map(|agent| (*agent).to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_an_installed_preferred_agent() {
        assert_eq!(pick_tui_agent(Some("codex"), &["claude", "codex"], &[]).as_deref(), Some("codex"));
    }

    #[test]
    fn falls_back_in_desktop_catalog_order_when_preference_absent_or_stale() {
        assert_eq!(pick_tui_agent(None, &["cursor", "codex"], &[]).as_deref(), Some("codex"));
        assert_eq!(pick_tui_agent(Some("gemini"), &["cursor", "codex"], &[]).as_deref(), Some("codex"));
        assert_eq!(
            pick_tui_agent(None, &["continue", "command-code"], &[]).as_deref(),
            Some("command-code")
        );
    }

    #[test]
    fn respects_the_explicit_blank_terminal_preference() {
        assert_eq!(pick_tui_agent(Some("blank"), &["cursor", "claude"], &[]), None);
    }

    #[test]
    fn ignores_disabled_preferred_and_fallback_agents() {
        assert_eq!(pick_tui_agent(Some("codex"), &["claude", "codex"], &["codex"]).as_deref(), Some("claude"));
        assert_eq!(pick_tui_agent(None, &["claude", "codex"], &["claude", "codex"]), None);
    }

    #[test]
    fn dedupes_supported_agent_ids_and_drops_unsupported_values() {
        // The "" entries stand in for the TS `null`/non-string members (both
        // are dropped as non-agents).
        assert_eq!(
            normalize_disabled_tui_agents(&["codex", "unknown", "codex", "", "claude"]),
            vec!["codex".to_string(), "claude".to_string()]
        );
    }

    /// The catalog is the twin's `TUI_AGENT_AUTO_PICK_ORDER`, which
    /// `quick-workspace-agent-selection.test.ts` pins to the desktop agent
    /// catalog. Four ids added upstream after this port was taken
    /// (claude-agent-teams, mimo-code, ante, devin) were missing, so
    /// `is_tui_agent` — and with it disabled-agent filtering — answered false
    /// for them.
    #[test]
    fn knows_every_agent_the_twins_catalog_lists() {
        for agent in ["claude-agent-teams", "mimo-code", "ante", "devin"] {
            assert!(is_tui_agent(agent), "{agent} missing from the catalog");
        }
        assert_eq!(TUI_AGENT_AUTO_PICK_ORDER.len(), 34);
        assert_eq!(pick_tui_agent(None, &["pi", "mimo-code"], &[]).as_deref(), Some("mimo-code"));
        assert!(!is_tui_agent_enabled("devin", &["devin"]));
    }

    // --- collapse_default_tui_agent_to_builtin ---
    //
    // The twin has no unit tests of its own for this export (see
    // `src/shared/tui-agent-selection.test.ts`, which covers pickTuiAgent and
    // normalizeDisabledTuiAgents only), so these are derived from its source
    // contract and from what the callers in `src/renderer` actually pass.

    const CLAUDE_ZAI: CustomAgentProfileRef<'static> =
        CustomAgentProfileRef { id: Some("p1"), base_agent: Some("claude") };

    #[test]
    fn passes_non_custom_preferences_through_unchanged() {
        let roster = [CLAUDE_ZAI];
        for (pref, expected) in [
            (DefaultTuiAgentPref::Builtin("codex"), CollapsedDefaultTuiAgent::Builtin("codex")),
            (DefaultTuiAgentPref::Builtin("blank"), CollapsedDefaultTuiAgent::Builtin("blank")),
            (DefaultTuiAgentPref::Null, CollapsedDefaultTuiAgent::Null),
            (DefaultTuiAgentPref::Undefined, CollapsedDefaultTuiAgent::Undefined),
        ] {
            assert_eq!(collapse_default_tui_agent_to_builtin(pref, &roster), expected);
        }
    }

    #[test]
    fn passes_an_unknown_agent_id_through_without_validating_it() {
        // The twin returns the string as-is; it never consults the catalog.
        assert_eq!(
            collapse_default_tui_agent_to_builtin(DefaultTuiAgentPref::Builtin("not-an-agent"), &[]),
            CollapsedDefaultTuiAgent::Builtin("not-an-agent")
        );
    }

    #[test]
    fn resolves_a_custom_preference_to_its_profiles_base_agent() {
        assert_eq!(
            collapse_default_tui_agent_to_builtin(
                DefaultTuiAgentPref::Custom { id: Some("p1") },
                &[CustomAgentProfileRef { id: Some("p0"), base_agent: Some("codex") }, CLAUDE_ZAI]
            ),
            CollapsedDefaultTuiAgent::Builtin("claude")
        );
    }

    #[test]
    fn falls_back_to_auto_when_the_custom_profile_is_gone() {
        let deleted = DefaultTuiAgentPref::Custom { id: Some("gone") };
        // Roster without the id, empty roster, and no roster at all all agree.
        assert_eq!(
            collapse_default_tui_agent_to_builtin(deleted, &[CLAUDE_ZAI]),
            CollapsedDefaultTuiAgent::Null
        );
        assert_eq!(collapse_default_tui_agent_to_builtin(deleted, &[]), CollapsedDefaultTuiAgent::Null);
    }

    #[test]
    fn treats_a_profile_without_a_base_agent_as_auto() {
        assert_eq!(
            collapse_default_tui_agent_to_builtin(
                DefaultTuiAgentPref::Custom { id: Some("p1") },
                &[CustomAgentProfileRef { id: Some("p1"), base_agent: None }]
            ),
            CollapsedDefaultTuiAgent::Null
        );
    }

    #[test]
    fn keeps_an_empty_base_agent_because_the_twin_coalesces_with_nullish_not_falsy() {
        assert_eq!(
            collapse_default_tui_agent_to_builtin(
                DefaultTuiAgentPref::Custom { id: Some("p1") },
                &[CustomAgentProfileRef { id: Some("p1"), base_agent: Some("") }]
            ),
            CollapsedDefaultTuiAgent::Builtin("")
        );
    }

    #[test]
    fn takes_the_first_profile_when_a_roster_repeats_an_id() {
        assert_eq!(
            collapse_default_tui_agent_to_builtin(
                DefaultTuiAgentPref::Custom { id: Some("p1") },
                &[CLAUDE_ZAI, CustomAgentProfileRef { id: Some("p1"), base_agent: Some("codex") }]
            ),
            CollapsedDefaultTuiAgent::Builtin("claude")
        );
    }

    #[test]
    fn matches_an_id_less_preference_against_an_id_less_profile() {
        // JS `undefined === undefined`, so the twin's `find` hits. Outside the
        // typed contract, modelled exactly rather than guessed at.
        let no_id = DefaultTuiAgentPref::Custom { id: None };
        assert_eq!(
            collapse_default_tui_agent_to_builtin(
                no_id,
                &[CustomAgentProfileRef { id: None, base_agent: Some("codex") }]
            ),
            CollapsedDefaultTuiAgent::Builtin("codex")
        );
        assert_eq!(
            collapse_default_tui_agent_to_builtin(no_id, &[CLAUDE_ZAI]),
            CollapsedDefaultTuiAgent::Null
        );
    }
}
