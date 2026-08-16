//! Tab title/label resolution, ported from `src/shared/tab-title-resolution.ts`.
//!
//! Priority is manual title → quick-command label → native OpenCode live title
//! → AI Vault session title → generated title (only when the feature is on) →
//! live title → fallback, each trimmed and treated as absent when blank.

use crate::js_string::trim_js;
use crate::opencode_terminal_title::is_meaningful_opencode_terminal_title;

/// Trimmed (JS-`.trim()`-equivalent) value, or `None` when missing or blank.
fn first_nonblank(value: Option<&str>) -> Option<&str> {
    value.map(trim_js).filter(|t| !t.is_empty())
}

pub struct TerminalTabTitleParts<'a> {
    pub custom_title: Option<&'a str>,
    pub quick_command_label: Option<&'a str>,
    /// The `aiVaultTitle.title` string; the twin reads through the optional object.
    pub ai_vault_title: Option<&'a str>,
    pub generated_title: Option<&'a str>,
    pub title: Option<&'a str>,
}

pub fn resolve_terminal_tab_title(
    parts: &TerminalTabTitleParts<'_>,
    generated_titles_enabled: bool,
    fallback: &str,
) -> String {
    let live_title = first_nonblank(parts.title);
    first_nonblank(parts.custom_title)
        // Quick-command label sits between the manual title and the generated one.
        .or_else(|| first_nonblank(parts.quick_command_label))
        // A native `OC | …` session title outranks anything Orca generates.
        .or_else(|| live_title.filter(|t| is_meaningful_opencode_terminal_title(Some(t))))
        // A vault session title keeps a Codex/Claude thread name stable across
        // the spinner/cwd OSC titles the agent writes while it works.
        .or_else(|| first_nonblank(parts.ai_vault_title))
        .or_else(|| {
            if generated_titles_enabled {
                first_nonblank(parts.generated_title)
            } else {
                None
            }
        })
        .or(live_title)
        .unwrap_or(fallback)
        .to_string()
}

pub struct UnifiedTabLabelParts<'a> {
    pub custom_label: Option<&'a str>,
    pub quick_command_label: Option<&'a str>,
    /// The `aiVaultTitle.title` string; the twin reads through the optional object.
    pub ai_vault_title: Option<&'a str>,
    pub generated_label: Option<&'a str>,
    pub label: Option<&'a str>,
}

pub fn resolve_unified_tab_label(
    parts: Option<&UnifiedTabLabelParts<'_>>,
    generated_titles_enabled: bool,
    fallback: &str,
) -> String {
    let live_label = first_nonblank(parts.and_then(|p| p.label));
    first_nonblank(parts.and_then(|p| p.custom_label))
        // Quick-command label sits between the manual label and the generated one.
        .or_else(|| first_nonblank(parts.and_then(|p| p.quick_command_label)))
        // A native `OC | …` session title outranks anything Orca generates.
        .or_else(|| live_label.filter(|t| is_meaningful_opencode_terminal_title(Some(t))))
        // Same vault step as the terminal resolver; the two ladders stay identical.
        .or_else(|| first_nonblank(parts.and_then(|p| p.ai_vault_title)))
        .or_else(|| {
            if generated_titles_enabled {
                first_nonblank(parts.and_then(|p| p.generated_label))
            } else {
                None
            }
        })
        .or(live_label)
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Terminal-tab parts with everything absent; tests set only what they mean.
    fn tab() -> TerminalTabTitleParts<'static> {
        TerminalTabTitleParts {
            custom_title: None,
            quick_command_label: None,
            ai_vault_title: None,
            generated_title: None,
            title: None,
        }
    }

    /// Unified-tab parts with everything absent.
    fn unified() -> UnifiedTabLabelParts<'static> {
        UnifiedTabLabelParts {
            custom_label: None,
            quick_command_label: None,
            ai_vault_title: None,
            generated_label: None,
            label: None,
        }
    }

    // The cases below are the twin's own, verbatim from
    // `src/shared/tab-title-resolution.test.ts`.

    #[test]
    fn uses_live_terminal_titles_when_generated_titles_are_disabled() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            generated_title: Some("Refactor auth"),
            title: Some("Claude working"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, false, ""), "Claude working");
    }

    #[test]
    fn places_generated_titles_between_manual_and_live_titles_when_enabled() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            generated_title: Some("Refactor auth"),
            title: Some("Claude working"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Refactor auth");
        let parts = TerminalTabTitleParts {
            custom_title: Some("Payments"),
            generated_title: Some("Refactor auth"),
            title: Some("Claude working"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Payments");
    }

    #[test]
    fn uses_meaningful_native_opencode_session_titles_before_generated_titles() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            generated_title: Some("Refactor auth"),
            title: Some("OC | Native Stable Session"),
            ..tab()
        };
        assert_eq!(
            resolve_terminal_tab_title(&parts, true, ""),
            "OC | Native Stable Session"
        );
    }

    #[test]
    fn keeps_generated_titles_ahead_of_generic_opencode_titles() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            generated_title: Some("Refactor auth"),
            title: Some("OpenCode"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Refactor auth");
    }

    #[test]
    fn places_quick_command_labels_between_manual_and_generated_titles() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            quick_command_label: Some("Run tests"),
            generated_title: Some("Refactor auth"),
            title: Some("pnpm test"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Run tests");
        let parts = TerminalTabTitleParts {
            custom_title: Some("Manual label"),
            quick_command_label: Some("Run tests"),
            generated_title: Some("Refactor auth"),
            title: Some("pnpm test"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Manual label");
    }

    #[test]
    fn keeps_a_codex_thread_name_stable_across_activity_plus_project_osc_titles() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            ai_vault_title: Some("Repair provider-native tab titles"),
            title: Some("⠋ albacore"),
            ..tab()
        };
        assert_eq!(
            resolve_terminal_tab_title(&parts, false, ""),
            "Repair provider-native tab titles"
        );
    }

    #[test]
    fn keeps_manual_and_quick_command_labels_ahead_of_ai_vault_titles() {
        let parts = TerminalTabTitleParts {
            custom_title: Some("Manual label"),
            quick_command_label: Some("Run tests"),
            ai_vault_title: Some("Claude conversation"),
            title: Some("claude working"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, false, ""), "Manual label");
        let parts = TerminalTabTitleParts {
            custom_title: None,
            quick_command_label: Some("Run tests"),
            ai_vault_title: Some("Claude conversation"),
            title: Some("claude working"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, false, ""), "Run tests");
    }

    #[test]
    fn keeps_opencode_native_and_orca_generated_title_behavior_intact() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            ai_vault_title: Some("Codex conversation"),
            generated_title: Some("Orca generated"),
            title: Some("OC | OpenCode native"),
            ..tab()
        };
        assert_eq!(
            resolve_terminal_tab_title(&parts, true, ""),
            "OC | OpenCode native"
        );
        let parts = TerminalTabTitleParts {
            custom_title: None,
            generated_title: Some("Orca generated"),
            title: Some("⠋ albacore"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Orca generated");
    }

    /// The vault step is blank-trimmed like every other, so a whitespace-only
    /// vault title falls through instead of blanking the tab.
    #[test]
    fn a_blank_ai_vault_title_falls_through_to_the_generated_title() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            ai_vault_title: Some("   "),
            generated_title: Some("Refactor auth"),
            title: Some("⠋ albacore"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Refactor auth");
    }

    #[test]
    fn unified_labels_take_the_vault_title_ahead_of_the_generated_label() {
        let parts = UnifiedTabLabelParts {
            custom_label: None,
            ai_vault_title: Some("Vault conversation"),
            generated_label: Some("Fix flaky tests"),
            label: Some("Codex working"),
            ..unified()
        };
        assert_eq!(
            resolve_unified_tab_label(Some(&parts), true, ""),
            "Vault conversation"
        );
    }

    #[test]
    fn uses_the_same_priority_for_unified_tab_labels() {
        let parts = UnifiedTabLabelParts {
            custom_label: None,
            generated_label: Some("Fix flaky tests"),
            label: Some("Codex working"),
            ..unified()
        };
        assert_eq!(resolve_unified_tab_label(Some(&parts), true, ""), "Fix flaky tests");
    }

    #[test]
    fn uses_quick_command_labels_before_generated_unified_labels() {
        let parts = UnifiedTabLabelParts {
            custom_label: None,
            quick_command_label: Some("Run build"),
            generated_label: Some("Fix flaky tests"),
            label: Some("Codex working"),
            ..unified()
        };
        assert_eq!(resolve_unified_tab_label(Some(&parts), true, ""), "Run build");
    }

    #[test]
    fn uses_meaningful_native_opencode_labels_before_generated_unified_labels() {
        let parts = UnifiedTabLabelParts {
            custom_label: None,
            generated_label: Some("Fix flaky tests"),
            label: Some("OC | Native Stable Session"),
            ..unified()
        };
        assert_eq!(
            resolve_unified_tab_label(Some(&parts), true, ""),
            "OC | Native Stable Session"
        );
    }

    #[test]
    fn keeps_manual_and_quick_command_labels_ahead_of_native_opencode_labels() {
        let parts = UnifiedTabLabelParts {
            custom_label: Some("Manual label"),
            quick_command_label: Some("Run build"),
            generated_label: Some("Fix flaky tests"),
            label: Some("OC | Native Stable Session"),
            ..unified()
        };
        assert_eq!(resolve_unified_tab_label(Some(&parts), true, ""), "Manual label");
        let parts = UnifiedTabLabelParts {
            custom_label: None,
            quick_command_label: Some("Run build"),
            generated_label: Some("Fix flaky tests"),
            label: Some("OC | Native Stable Session"),
            ..unified()
        };
        assert_eq!(resolve_unified_tab_label(Some(&parts), true, ""), "Run build");
    }

    // Beyond the twin's file: blank-handling and the OpenCode branch's
    // interaction with the live-title tail, both vector-backed.

    #[test]
    fn whitespace_only_quick_command_label_falls_through_to_the_generated_title() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            quick_command_label: Some("   "),
            generated_title: Some("Refactor auth"),
            title: Some("pnpm test"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Refactor auth");
    }

    #[test]
    fn native_opencode_titles_win_even_with_generated_titles_disabled() {
        // The OpenCode branch is not gated on the feature flag, so the answer is
        // the same either way — it just also beats the live-title tail's trim.
        let parts = TerminalTabTitleParts {
            custom_title: None,
            generated_title: Some("Refactor auth"),
            title: Some("  OC|Session  "),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, false, ""), "OC|Session");
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "OC|Session");
    }

    #[test]
    fn an_incomplete_opencode_marker_falls_through_to_the_generated_title() {
        let parts = TerminalTabTitleParts {
            custom_title: None,
            generated_title: Some("Refactor auth"),
            title: Some("OC |"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, ""), "Refactor auth");
        // With nothing generated, the live title still comes back as-is.
        let parts = TerminalTabTitleParts {
            custom_title: None,
            title: Some("OC |"),
            ..tab()
        };
        assert_eq!(resolve_terminal_tab_title(&parts, true, "Untitled"), "OC |");
    }
}
