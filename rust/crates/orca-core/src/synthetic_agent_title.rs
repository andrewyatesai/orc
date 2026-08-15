//! Synthetic agent terminal titles, ported from
//! `src/shared/synthetic-agent-title.ts`.
//!
//! Some agents (e.g. Codex) emit working OSC titles but can miss the final
//! frame, so Orca synthesizes terminal-state titles from hook state. Others
//! (OpenCode) own semantic session titles that hook status must not replace.
//! Agent type and status state are strings here (the TS types are unions).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyntheticAgentTitleProfile {
    pub working_label: &'static str,
    pub permission_label: &'static str,
    pub idle_label: &'static str,
    /// Agents in one group answer to each other's titles (pi/omp). `None` ≙ the
    /// TS field being absent.
    pub title_identity_group: Option<&'static str>,
    /// `Some(false)` ≙ the agent owns its terminal titles; synthesize none.
    pub synthesize_terminal_title: Option<bool>,
    /// `Some(false)` ≙ do not synthesize the working state (keep the native
    /// spinner).
    pub synthesize_working_title: Option<bool>,
}

/// Insertion-ordered mirror of the TS `SYNTHETIC_AGENT_TITLE_PROFILES` record.
/// Order is load-bearing for consumers that scan it for a label match
/// (`src/shared/agent-title-owner.ts`).
pub const SYNTHETIC_AGENT_TITLE_PROFILES: [(&str, SyntheticAgentTitleProfile); 8] = [
    (
        "codex",
        SyntheticAgentTitleProfile {
            working_label: "Codex",
            permission_label: "Codex - action required",
            idle_label: "Codex ready",
            title_identity_group: None,
            synthesize_terminal_title: None,
            // Codex emits working OSC titles but can miss the final frame. Only
            // synthesize terminal states so native spinner behavior stays intact.
            synthesize_working_title: Some(false),
        },
    ),
    (
        "cursor",
        SyntheticAgentTitleProfile {
            working_label: "Cursor Agent",
            permission_label: "Cursor - action required",
            idle_label: "Cursor ready",
            title_identity_group: None,
            synthesize_terminal_title: None,
            synthesize_working_title: None,
        },
    ),
    (
        "opencode",
        SyntheticAgentTitleProfile {
            working_label: "OpenCode",
            permission_label: "OpenCode - action required",
            idle_label: "OpenCode ready",
            title_identity_group: None,
            // OpenCode owns semantic OSC session titles; hook status must not
            // replace them.
            synthesize_terminal_title: Some(false),
            synthesize_working_title: None,
        },
    ),
    (
        "pi",
        SyntheticAgentTitleProfile {
            working_label: "Pi",
            permission_label: "Pi - action required",
            idle_label: "Pi ready",
            title_identity_group: Some("pi-compatible"),
            synthesize_terminal_title: None,
            synthesize_working_title: None,
        },
    ),
    (
        "omp",
        SyntheticAgentTitleProfile {
            working_label: "OMP",
            permission_label: "OMP - action required",
            idle_label: "OMP ready",
            title_identity_group: Some("pi-compatible"),
            synthesize_terminal_title: None,
            synthesize_working_title: None,
        },
    ),
    (
        "droid",
        SyntheticAgentTitleProfile {
            working_label: "Droid",
            permission_label: "Droid - action required",
            idle_label: "Droid ready",
            title_identity_group: None,
            synthesize_terminal_title: None,
            synthesize_working_title: None,
        },
    ),
    (
        "hermes",
        SyntheticAgentTitleProfile {
            working_label: "Hermes",
            permission_label: "Hermes - action required",
            idle_label: "Hermes ready",
            title_identity_group: None,
            synthesize_terminal_title: None,
            synthesize_working_title: None,
        },
    ),
    (
        "devin",
        SyntheticAgentTitleProfile {
            working_label: "Devin",
            permission_label: "Devin - action required",
            idle_label: "Devin ready",
            title_identity_group: None,
            synthesize_terminal_title: None,
            synthesize_working_title: None,
        },
    ),
];

pub fn get_synthetic_agent_title_profile(
    agent_type: Option<&str>,
) -> Option<SyntheticAgentTitleProfile> {
    // TS guards with `if (!agentType)`, so "" is a miss as well as null; no key
    // is empty, and the scan below agrees without a special case.
    let agent_type = agent_type?;
    SYNTHETIC_AGENT_TITLE_PROFILES
        .iter()
        .find(|(name, _)| *name == agent_type)
        .map(|(_, profile)| *profile)
}

pub fn get_synthetic_agent_terminal_title(
    agent_type: Option<&str>,
    state: &str,
) -> Option<&'static str> {
    let profile = get_synthetic_agent_title_profile(agent_type)?;
    if profile.synthesize_terminal_title == Some(false) || state == "working" {
        return None;
    }
    Some(if state == "blocked" || state == "waiting" {
        profile.permission_label
    } else {
        profile.idle_label
    })
}

pub fn should_drive_synthetic_agent_title_from_hook(agent_type: Option<&str>, state: &str) -> bool {
    match get_synthetic_agent_title_profile(agent_type) {
        None => false,
        Some(profile) if profile.synthesize_terminal_title == Some(false) => false,
        Some(profile) => state != "working" || profile.synthesize_working_title != Some(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provides_terminal_state_titles_for_codex_hook_completion() {
        assert_eq!(get_synthetic_agent_terminal_title(Some("codex"), "done"), Some("Codex ready"));
        assert_eq!(
            get_synthetic_agent_terminal_title(Some("codex"), "waiting"),
            Some("Codex - action required")
        );
    }

    #[test]
    fn does_not_synthesize_codex_working_titles_over_codex_native_spinner_titles() {
        assert!(!should_drive_synthetic_agent_title_from_hook(Some("codex"), "working"));
        assert!(should_drive_synthetic_agent_title_from_hook(Some("codex"), "done"));
    }

    #[test]
    fn does_not_synthesize_opencode_titles_over_native_session_titles() {
        assert_eq!(get_synthetic_agent_terminal_title(Some("opencode"), "done"), None);
        assert_eq!(get_synthetic_agent_terminal_title(Some("opencode"), "waiting"), None);
        assert!(!should_drive_synthetic_agent_title_from_hook(Some("opencode"), "working"));
        assert!(!should_drive_synthetic_agent_title_from_hook(Some("opencode"), "done"));
        assert!(!should_drive_synthetic_agent_title_from_hook(Some("opencode"), "waiting"));
    }

    #[test]
    fn provides_devin_titles_for_hook_driven_status_updates() {
        assert_eq!(get_synthetic_agent_terminal_title(Some("devin"), "done"), Some("Devin ready"));
        assert_eq!(
            get_synthetic_agent_terminal_title(Some("devin"), "waiting"),
            Some("Devin - action required")
        );
        assert!(should_drive_synthetic_agent_title_from_hook(Some("devin"), "working"));
    }

    #[test]
    fn provides_pi_compatible_omp_titles_for_hook_driven_status_updates() {
        assert_eq!(get_synthetic_agent_terminal_title(Some("omp"), "done"), Some("OMP ready"));
        assert_eq!(
            get_synthetic_agent_terminal_title(Some("omp"), "waiting"),
            Some("OMP - action required")
        );
        assert!(should_drive_synthetic_agent_title_from_hook(Some("omp"), "working"));
    }

    #[test]
    fn provides_pi_titles_for_hook_driven_status_updates() {
        assert_eq!(get_synthetic_agent_terminal_title(Some("pi"), "done"), Some("Pi ready"));
        assert_eq!(
            get_synthetic_agent_terminal_title(Some("pi"), "waiting"),
            Some("Pi - action required")
        );
        assert!(should_drive_synthetic_agent_title_from_hook(Some("pi"), "working"));
    }

    /// Not in the twin's test file: `titleIdentityGroup` is read by
    /// `agent-title-owner.ts`, so the group pairing is asserted here directly.
    #[test]
    fn pi_and_omp_share_the_pi_compatible_title_identity_group() {
        let pi = get_synthetic_agent_title_profile(Some("pi")).expect("pi profile");
        let omp = get_synthetic_agent_title_profile(Some("omp")).expect("omp profile");
        assert_eq!(pi.title_identity_group, Some("pi-compatible"));
        assert_eq!(pi.title_identity_group, omp.title_identity_group);
        assert_eq!(
            get_synthetic_agent_title_profile(Some("codex")).and_then(|p| p.title_identity_group),
            None
        );
    }

    #[test]
    fn unknown_and_absent_agent_types_have_no_profile() {
        assert_eq!(get_synthetic_agent_title_profile(Some("claude")), None);
        assert_eq!(get_synthetic_agent_title_profile(None), None);
        assert_eq!(get_synthetic_agent_terminal_title(Some("claude"), "done"), None);
        assert!(!should_drive_synthetic_agent_title_from_hook(Some("claude"), "done"));
    }
}
