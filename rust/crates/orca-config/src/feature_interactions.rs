//! Feature-interaction catalog + persisted-state normalization, ported from
//! `src/shared/feature-interactions.ts`.
//!
//! These ids are persisted product state (see
//! docs/reference/feature-discovery-interaction-tracking.md). The normalizers
//! defend against malformed persisted blobs, so they take untrusted
//! `serde_json::Value` — hence this lives in `orca-config` (the persisted-JSON
//! tier), not zero-dep `orca-core`.

use crate::feature_interaction_usage_buckets::FeatureInteractionUsageBucket;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FeatureInteractionId {
    WorkspaceBoard,
    WorkspaceAgentSessions,
    WorkspaceBoardActions,
    CmdJ,
    CmdJWorkspaceOpen,
    CmdJBrowserPageOpen,
    CmdJSettingsOpen,
    CmdJQuickAction,
    CmdJCreateWorkspace,
    Browser,
    BrowserTabCreated,
    Tasks,
    GithubTasks,
    GitlabTasks,
    LinearTasks,
    JiraTasks,
    Automations,
    AutomationCreated,
    AutomationRun,
    BrowserAnnotations,
    BrowserAnnotationsSentToAgent,
    BrowserGrab,
    MarkdownFileCreated,
    WorkspaceCreation,
    AgentBrowserSetup,
    AgentBrowserUse,
    EphemeralVmSetup,
    AgentOrchestrationSetup,
    AgentOrchestration,
    MobileEmulatorAgentSetup,
    AiCommitGeneration,
    AiPrGeneration,
    ClaudeAccountSwitching,
    ComputerUseSetup,
    ComputerUse,
    CodexAccountSwitching,
    CookieImport,
    FloatingWorkspace,
    FloatingWorkspaceHidden,
    MobilePairing,
    Notifications,
    Ports,
    QuickCommands,
    ResourceManager,
    ReviewNotes,
    Ssh,
    TerminalPaneSplit,
    TerminalPanes,
    TerminalTabs,
    TabSplits,
    UsageTracking,
    VoiceDictation,
    WorkspaceCleanup,

}

impl FeatureInteractionId {
    pub fn as_str(self) -> &'static str {
        match self {
            FeatureInteractionId::WorkspaceBoard => "workspace-board",
            FeatureInteractionId::WorkspaceAgentSessions => "workspace-agent-sessions",
            FeatureInteractionId::WorkspaceBoardActions => "workspace-board-actions",
            FeatureInteractionId::CmdJ => "cmd-j",
            FeatureInteractionId::CmdJWorkspaceOpen => "cmd-j-workspace-open",
            FeatureInteractionId::CmdJBrowserPageOpen => "cmd-j-browser-page-open",
            FeatureInteractionId::CmdJSettingsOpen => "cmd-j-settings-open",
            FeatureInteractionId::CmdJQuickAction => "cmd-j-quick-action",
            FeatureInteractionId::CmdJCreateWorkspace => "cmd-j-create-workspace",
            FeatureInteractionId::Browser => "browser",
            FeatureInteractionId::BrowserTabCreated => "browser-tab-created",
            FeatureInteractionId::Tasks => "tasks",
            FeatureInteractionId::GithubTasks => "github-tasks",
            FeatureInteractionId::GitlabTasks => "gitlab-tasks",
            FeatureInteractionId::LinearTasks => "linear-tasks",
            FeatureInteractionId::JiraTasks => "jira-tasks",
            FeatureInteractionId::Automations => "automations",
            FeatureInteractionId::AutomationCreated => "automation-created",
            FeatureInteractionId::AutomationRun => "automation-run",
            FeatureInteractionId::BrowserAnnotations => "browser-annotations",
            FeatureInteractionId::BrowserAnnotationsSentToAgent => "browser-annotations-sent-to-agent",
            FeatureInteractionId::BrowserGrab => "browser-grab",
            FeatureInteractionId::MarkdownFileCreated => "markdown-file-created",
            FeatureInteractionId::WorkspaceCreation => "workspace-creation",
            FeatureInteractionId::AgentBrowserSetup => "agent-browser-setup",
            FeatureInteractionId::AgentBrowserUse => "agent-browser-use",
            FeatureInteractionId::EphemeralVmSetup => "ephemeral-vm-setup",
            FeatureInteractionId::AgentOrchestrationSetup => "agent-orchestration-setup",
            FeatureInteractionId::AgentOrchestration => "agent-orchestration",
            FeatureInteractionId::MobileEmulatorAgentSetup => "mobile-emulator-agent-setup",
            FeatureInteractionId::AiCommitGeneration => "ai-commit-generation",
            FeatureInteractionId::AiPrGeneration => "ai-pr-generation",
            FeatureInteractionId::ClaudeAccountSwitching => "claude-account-switching",
            FeatureInteractionId::ComputerUseSetup => "computer-use-setup",
            FeatureInteractionId::ComputerUse => "computer-use",
            FeatureInteractionId::CodexAccountSwitching => "codex-account-switching",
            FeatureInteractionId::CookieImport => "cookie-import",
            FeatureInteractionId::FloatingWorkspace => "floating-workspace",
            FeatureInteractionId::FloatingWorkspaceHidden => "floating-workspace-hidden",
            FeatureInteractionId::MobilePairing => "mobile-pairing",
            FeatureInteractionId::Notifications => "notifications",
            FeatureInteractionId::Ports => "ports",
            FeatureInteractionId::QuickCommands => "quick-commands",
            FeatureInteractionId::ResourceManager => "resource-manager",
            FeatureInteractionId::ReviewNotes => "review-notes",
            FeatureInteractionId::Ssh => "ssh",
            FeatureInteractionId::TerminalPaneSplit => "terminal-pane-split",
            FeatureInteractionId::TerminalPanes => "terminal-panes",
            FeatureInteractionId::TerminalTabs => "terminal-tabs",
            FeatureInteractionId::TabSplits => "tab-splits",
            FeatureInteractionId::UsageTracking => "usage-tracking",
            FeatureInteractionId::VoiceDictation => "voice-dictation",
            FeatureInteractionId::WorkspaceCleanup => "workspace-cleanup",

        }
    }

    pub fn from_id(value: &str) -> Option<FeatureInteractionId> {
        FEATURE_INTERACTIONS.iter().find(|def| def.id.as_str() == value).map(|def| def.id)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FeatureInteractionDefinition {
    pub id: FeatureInteractionId,
    /// The product action that counts as "the user has interacted with this feature."
    pub interaction: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FeatureInteractionRecord {
    /// Unix timestamp in milliseconds for the first local interaction.
    pub first_interacted_at: f64,
    /// Number of local interactions recorded for this feature.
    pub interaction_count: f64,
}

pub type FeatureInteractionState = BTreeMap<FeatureInteractionId, FeatureInteractionRecord>;

/// The last usage bucket emitted per feature, so a bucket is reported once.
pub type FeatureInteractionTelemetryBucketState =
    BTreeMap<FeatureInteractionId, FeatureInteractionUsageBucket>;

// Why: these ids become persisted product state; see
// docs/reference/feature-discovery-interaction-tracking.md before changing them.
pub const FEATURE_INTERACTIONS: [FeatureInteractionDefinition; 53] = [
    FeatureInteractionDefinition { id: FeatureInteractionId::WorkspaceBoard, interaction: "workspace board opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::WorkspaceAgentSessions, interaction: "workspace agent-session surface opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::WorkspaceBoardActions, interaction: "workspace board card, lane, density, or status action used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CmdJ, interaction: "Cmd+J palette opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CmdJWorkspaceOpen, interaction: "workspace opened from Cmd+J" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CmdJBrowserPageOpen, interaction: "browser page opened from Cmd+J" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CmdJSettingsOpen, interaction: "settings opened from Cmd+J" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CmdJQuickAction, interaction: "quick action run from Cmd+J" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CmdJCreateWorkspace, interaction: "workspace creation started from Cmd+J" },
    FeatureInteractionDefinition { id: FeatureInteractionId::Browser, interaction: "in-app browser opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::BrowserTabCreated, interaction: "browser tab explicitly created" },
    FeatureInteractionDefinition { id: FeatureInteractionId::Tasks, interaction: "Tasks page opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::GithubTasks, interaction: "GitHub task item workflow used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::GitlabTasks, interaction: "GitLab task item workflow used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::LinearTasks, interaction: "Linear task item workflow used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::JiraTasks, interaction: "Jira task item workflow used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::Automations, interaction: "Automations page opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AutomationCreated, interaction: "automation created" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AutomationRun, interaction: "automation run queued" },
    FeatureInteractionDefinition { id: FeatureInteractionId::BrowserAnnotations, interaction: "browser annotation added, copied, or cleared" },
    FeatureInteractionDefinition { id: FeatureInteractionId::BrowserAnnotationsSentToAgent, interaction: "browser annotations sent to an agent" },
    FeatureInteractionDefinition { id: FeatureInteractionId::BrowserGrab, interaction: "browser element grab or screenshot used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::MarkdownFileCreated, interaction: "untitled markdown file explicitly created" },
    FeatureInteractionDefinition { id: FeatureInteractionId::WorkspaceCreation, interaction: "workspace creation flow opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AgentBrowserSetup, interaction: "Agent Browser Use setup enabled or opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AgentBrowserUse, interaction: "agent browser runtime method used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::EphemeralVmSetup, interaction: "Ephemeral VMs setup opened or scaffold prompt copied" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AgentOrchestrationSetup, interaction: "Agent Orchestration setup enabled or opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AgentOrchestration, interaction: "agent orchestration runtime method used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::MobileEmulatorAgentSetup, interaction: "Mobile Emulator agent CLI or skill setup opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AiCommitGeneration, interaction: "AI commit message generation enabled or used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::AiPrGeneration, interaction: "AI pull request generation used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::ClaudeAccountSwitching, interaction: "Claude managed account added, selected, reauthenticated, or removed" },
    FeatureInteractionDefinition { id: FeatureInteractionId::ComputerUseSetup, interaction: "Computer Use setup or permission flow opened" },
    FeatureInteractionDefinition { id: FeatureInteractionId::ComputerUse, interaction: "computer-use runtime method used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CodexAccountSwitching, interaction: "Codex managed account added, selected, reauthenticated, or removed" },
    FeatureInteractionDefinition { id: FeatureInteractionId::CookieImport, interaction: "browser cookies imported or cleared" },
    FeatureInteractionDefinition { id: FeatureInteractionId::FloatingWorkspace, interaction: "Floating Workspace opened or configured" },
    FeatureInteractionDefinition { id: FeatureInteractionId::FloatingWorkspaceHidden, interaction: "Floating Workspace explicitly hidden or disabled" },
    FeatureInteractionDefinition { id: FeatureInteractionId::MobilePairing, interaction: "mobile pairing enabled or QR code generated" },
    FeatureInteractionDefinition { id: FeatureInteractionId::Notifications, interaction: "desktop notifications enabled or tested" },
    FeatureInteractionDefinition { id: FeatureInteractionId::Ports, interaction: "Ports popover opened, configured, or port action used" },
    FeatureInteractionDefinition { id: FeatureInteractionId::QuickCommands, interaction: "terminal quick command created or edited" },
    FeatureInteractionDefinition { id: FeatureInteractionId::ResourceManager, interaction: "Resource Manager opened or configured" },
    FeatureInteractionDefinition { id: FeatureInteractionId::ReviewNotes, interaction: "review note added or sent to an agent" },
    FeatureInteractionDefinition { id: FeatureInteractionId::Ssh, interaction: "SSH target added, imported, tested, connected, disconnected, or configured" },
    FeatureInteractionDefinition { id: FeatureInteractionId::TerminalPaneSplit, interaction: "terminal pane split from the split-pane command" },
    FeatureInteractionDefinition { id: FeatureInteractionId::TerminalPanes, interaction: "terminal/editor/browser pane created, resized, or merged" },
    FeatureInteractionDefinition { id: FeatureInteractionId::TerminalTabs, interaction: "workspace tab created, moved, reordered, pinned, renamed, recolored, or closed" },
    FeatureInteractionDefinition { id: FeatureInteractionId::TabSplits, interaction: "workspace tab split into another pane" },
    FeatureInteractionDefinition { id: FeatureInteractionId::UsageTracking, interaction: "Stats & Usage or provider usage details opened or configured" },
    FeatureInteractionDefinition { id: FeatureInteractionId::VoiceDictation, interaction: "dictation session started" },
    FeatureInteractionDefinition { id: FeatureInteractionId::WorkspaceCleanup, interaction: "workspace disk space scan, review, or cleanup action used" },
];

pub fn is_feature_interaction_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| FeatureInteractionId::from_id(s).is_some())
}

pub fn has_feature_interaction(state: Option<&Value>, id: FeatureInteractionId) -> bool {
    let record = state.and_then(Value::as_object).and_then(|object| object.get(id.as_str()));
    normalize_feature_interaction_record(record).is_some()
}

pub fn normalize_feature_interactions(value: &Value) -> FeatureInteractionState {
    // as_object() is None for null / array / primitive — matches the TS object guard → {}.
    let Some(object) = value.as_object() else {
        return BTreeMap::new();
    };
    let mut out = FeatureInteractionState::new();
    for def in FEATURE_INTERACTIONS {
        if let Some(record) = normalize_feature_interaction_record(object.get(def.id.as_str())) {
            out.insert(def.id, record);
        }
    }
    out
}

pub fn normalize_feature_interaction_telemetry_buckets(
    value: &Value,
) -> FeatureInteractionTelemetryBucketState {
    // Same object guard as normalize_feature_interactions: null / array / primitive → {}.
    let Some(object) = value.as_object() else {
        return BTreeMap::new();
    };
    let mut out = FeatureInteractionTelemetryBucketState::new();
    for def in FEATURE_INTERACTIONS {
        // `isFeatureInteractionUsageBucket` in two steps: non-strings (null,
        // numbers, nested objects) fail `as_str`, unknown labels fail `from_id`.
        if let Some(bucket) = object
            .get(def.id.as_str())
            .and_then(Value::as_str)
            .and_then(FeatureInteractionUsageBucket::from_id)
        {
            out.insert(def.id, bucket);
        }
    }
    out
}

fn normalize_feature_interaction_record(value: Option<&Value>) -> Option<FeatureInteractionRecord> {
    let object = value?.as_object()?;
    let first_interacted_at = match object.get("firstInteractedAt").and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n >= 0.0 => n,
        _ => return None,
    };
    let interaction_count = match object.get("interactionCount").and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n > 0.0 => n,
        _ => 1.0,
    };
    Some(FeatureInteractionRecord { first_interacted_at, interaction_count })
}

#[cfg(test)]
mod tests {
    use super::FeatureInteractionId::{Automations, Browser, BrowserGrab, Tasks, VoiceDictation};
    use super::*;
    use serde_json::json;

    fn rec(first_interacted_at: f64, interaction_count: f64) -> FeatureInteractionRecord {
        FeatureInteractionRecord { first_interacted_at, interaction_count }
    }

    #[test]
    fn defines_local_interaction_semantics_for_product_education_features() {
        // The Rust enum is the single source of truth, so the TS compile-time
        // "catalog matches public union" check is structurally guaranteed here.
        let ids: Vec<FeatureInteractionId> = FEATURE_INTERACTIONS.iter().map(|def| def.id).collect();
        assert_eq!(
            ids,
            vec![
                FeatureInteractionId::WorkspaceBoard,
                FeatureInteractionId::WorkspaceAgentSessions,
                FeatureInteractionId::WorkspaceBoardActions,
                FeatureInteractionId::CmdJ,
                FeatureInteractionId::CmdJWorkspaceOpen,
                FeatureInteractionId::CmdJBrowserPageOpen,
                FeatureInteractionId::CmdJSettingsOpen,
                FeatureInteractionId::CmdJQuickAction,
                FeatureInteractionId::CmdJCreateWorkspace,
                FeatureInteractionId::Browser,
                FeatureInteractionId::BrowserTabCreated,
                FeatureInteractionId::Tasks,
                FeatureInteractionId::GithubTasks,
                FeatureInteractionId::GitlabTasks,
                FeatureInteractionId::LinearTasks,
                FeatureInteractionId::JiraTasks,
                FeatureInteractionId::Automations,
                FeatureInteractionId::AutomationCreated,
                FeatureInteractionId::AutomationRun,
                FeatureInteractionId::BrowserAnnotations,
                FeatureInteractionId::BrowserAnnotationsSentToAgent,
                FeatureInteractionId::BrowserGrab,
                FeatureInteractionId::MarkdownFileCreated,
                FeatureInteractionId::WorkspaceCreation,
                FeatureInteractionId::AgentBrowserSetup,
                FeatureInteractionId::AgentBrowserUse,
                FeatureInteractionId::EphemeralVmSetup,
                FeatureInteractionId::AgentOrchestrationSetup,
                FeatureInteractionId::AgentOrchestration,
                FeatureInteractionId::MobileEmulatorAgentSetup,
                FeatureInteractionId::AiCommitGeneration,
                FeatureInteractionId::AiPrGeneration,
                FeatureInteractionId::ClaudeAccountSwitching,
                FeatureInteractionId::ComputerUseSetup,
                FeatureInteractionId::ComputerUse,
                FeatureInteractionId::CodexAccountSwitching,
                FeatureInteractionId::CookieImport,
                FeatureInteractionId::FloatingWorkspace,
                FeatureInteractionId::FloatingWorkspaceHidden,
                FeatureInteractionId::MobilePairing,
                FeatureInteractionId::Notifications,
                FeatureInteractionId::Ports,
                FeatureInteractionId::QuickCommands,
                FeatureInteractionId::ResourceManager,
                FeatureInteractionId::ReviewNotes,
                FeatureInteractionId::Ssh,
                FeatureInteractionId::TerminalPaneSplit,
                FeatureInteractionId::TerminalPanes,
                FeatureInteractionId::TerminalTabs,
                FeatureInteractionId::TabSplits,
                FeatureInteractionId::UsageTracking,
                FeatureInteractionId::VoiceDictation,
                FeatureInteractionId::WorkspaceCleanup,
            ]
        );
        for def in FEATURE_INTERACTIONS {
            assert!(!def.interaction.is_empty());
        }
    }

    #[test]
    fn normalizes_persisted_records_by_removing_unknown_ids_and_malformed_values() {
        // `Number.NaN` is not representable in JSON; it persists as `null`, which
        // both the TS and Rust validators reject (non-finite/non-number).
        let input = json!({
            "tasks": { "firstInteractedAt": 100 },
            "browser": { "firstInteractedAt": null },
            "automations": { "firstInteractedAt": 200, "interactionCount": 3 },
            "browser-grab": { "firstInteractedAt": 250, "interactionCount": 0 },
            "unknown": { "firstInteractedAt": 200 },
            "voice-dictation": { "firstInteractedAt": 300 }
        });
        let mut expected = FeatureInteractionState::new();
        expected.insert(Tasks, rec(100.0, 1.0));
        expected.insert(Automations, rec(200.0, 3.0));
        expected.insert(BrowserGrab, rec(250.0, 1.0));
        expected.insert(VoiceDictation, rec(300.0, 1.0));
        assert_eq!(normalize_feature_interactions(&input), expected);
    }

    #[test]
    fn treats_only_valid_known_records_as_interacted() {
        let state = json!({ "tasks": { "firstInteractedAt": 100, "interactionCount": 1 } });
        assert!(has_feature_interaction(Some(&state), Tasks));
        assert!(!has_feature_interaction(Some(&state), Browser));
        // `Number.POSITIVE_INFINITY` persists as JSON `null` and is rejected.
        let non_finite = json!({ "tasks": { "firstInteractedAt": null, "interactionCount": 1 } });
        assert!(!has_feature_interaction(Some(&non_finite), Tasks));
    }

    #[test]
    fn normalizes_persisted_telemetry_bucket_markers_by_removing_unknown_ids_and_buckets() {
        // Verbatim from the twin's
        // "normalizes persisted telemetry bucket markers by removing unknown ids and buckets".
        let input = json!({
            "tasks": "count_1",
            "browser": "count_1000_plus",
            "automations": "count_4",
            "unknown": "count_1",
            "voice-dictation": null
        });
        let mut expected = FeatureInteractionTelemetryBucketState::new();
        expected.insert(Tasks, FeatureInteractionUsageBucket::Count1);
        expected.insert(Browser, FeatureInteractionUsageBucket::Count1000Plus);
        assert_eq!(normalize_feature_interaction_telemetry_buckets(&input), expected);
    }

    #[test]
    fn accepts_every_bucket_label_and_only_bucket_labels() {
        // Both ends of the vocabulary plus the near-miss labels around them:
        // "count_0" is below the first bucket, "count_3" and "count_4" name
        // counts inside count_3_4's range but are not bucket names, and
        // "count_1000" is one short of the top-coded label.
        let input = json!({
            "workspace-board": "count_0",
            "cmd-j": "count_1",
            "browser": "count_3",
            "tasks": "count_3_4",
            "ports": "count_4",
            "ssh": "count_1000",
            "workspace-cleanup": "count_1000_plus"
        });
        let mut expected = FeatureInteractionTelemetryBucketState::new();
        expected.insert(FeatureInteractionId::CmdJ, FeatureInteractionUsageBucket::Count1);
        expected.insert(Tasks, FeatureInteractionUsageBucket::Count3To4);
        expected.insert(
            FeatureInteractionId::WorkspaceCleanup,
            FeatureInteractionUsageBucket::Count1000Plus,
        );
        assert_eq!(normalize_feature_interaction_telemetry_buckets(&input), expected);
    }

    #[test]
    fn treats_non_objects_as_an_empty_telemetry_bucket_state() {
        for input in [json!(null), json!("count_1"), json!(7), json!(["count_1"])] {
            assert_eq!(
                normalize_feature_interaction_telemetry_buckets(&input),
                FeatureInteractionTelemetryBucketState::new()
            );
        }
    }
}
