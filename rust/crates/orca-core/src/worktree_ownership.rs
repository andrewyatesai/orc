//! Worktree ownership classification + external-visibility policy, ported from
//! `src/shared/worktree-ownership.ts`.
//!
//! Decides whether a discovered git worktree is Orca-managed, an unknown legacy
//! row, or external — and whether it should be shown — by matching its path
//! against the known Orca workspace layouts. Composes `cross_platform_path`,
//! `wsl_paths`, `agent_scratch_worktrees` (the classifier's scratch step) and
//! `external_worktree_inbox` (the visibility half's explicit-import override).
//! Input structs are the lean projections the logic reads.

use crate::agent_scratch_worktrees::{
    is_agent_scratch_worktree_path, AgentScratchWorktreePathMatcher,
};
use crate::cross_platform_path::{
    is_runtime_path_absolute, is_windows_absolute_path_like,
    normalize_runtime_path_for_comparison, normalize_runtime_path_separators,
    relative_path_inside_root, resolve_runtime_path, PathFlavor,
};
use crate::external_worktree_inbox::is_explicitly_imported_external_worktree_path;
use crate::js_string::trim_js;
use crate::wsl_paths::parse_wsl_unc_path;
use std::collections::HashSet;

/// `Date.UTC(2026, 4, 23)` — 2026-05-23 UTC, in epoch milliseconds.
pub const EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT: i64 = 1_779_494_400_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalWorktreeVisibility {
    Show,
    Hide,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorktreeOwnership {
    OrcaManaged,
    UnknownLegacy,
    External,
    /// `agent-scratch` — sub-agent plumbing (`.claude/worktrees`, `.gsd-workspaces`),
    /// minted by `classify_worktree_ownership` via `agent_scratch_worktrees` and
    /// hidden unless explicitly imported or the selected checkout (#9535/#9388).
    AgentScratch,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrcaWorkspaceLayout {
    pub path: String,
    pub nest_workspaces: bool,
}

/// The repo fields the ownership/visibility logic reads.
#[derive(Clone, Debug, Default)]
pub struct Repo {
    pub path: String,
    pub external_worktree_visibility: Option<ExternalWorktreeVisibility>,
    pub external_worktree_visibility_legacy: Option<bool>,
    pub added_at: Option<f64>,
    pub connection_id: Option<String>,
    pub worktree_base_path: Option<String>,
    /// `importedExternalWorktreePaths` — rows the user pulled out of the inbox by
    /// hand. An absent list is the twin's `?? []`, so `Vec::new()` is faithful.
    pub imported_external_worktree_paths: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Worktree {
    pub path: String,
    pub is_main_worktree: bool,
}

/// Strong-ownership signals: any present marker means Orca created the worktree.
#[derive(Clone, Debug, Default)]
pub struct WorktreeMeta {
    pub orca_created_at: Option<f64>,
    /// `orcaCreationWorkspaceLayout` — present iff Orca recorded the layout it
    /// created the worktree under (#7078's metadata-only ownership proof).
    pub orca_creation_workspace_layout: bool,
    pub created_at: Option<f64>,
    /// `createdWithAgent` is a TuiAgent STRING and `pushTarget` a GitPushTarget
    /// OBJECT in the twin; both are presence flags here, so a caller must fill
    /// them with JS truthiness, never by reading a boolean that never exists.
    pub created_with_agent: bool,
    pub push_target: bool,
    pub sparse_base_ref: Option<String>,
    pub sparse_preset_id: Option<String>,
    pub preserve_branch_on_delete: bool,
}

/// `Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>`.
#[derive(Clone, Debug, Default)]
pub struct WorkspaceLayoutSettings {
    pub workspace_dir: Option<String>,
    pub nest_workspaces: bool,
    pub workspace_dir_history: Vec<OrcaWorkspaceLayout>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetectedWorktree {
    pub path: String,
    pub is_main_worktree: bool,
    pub ownership: WorktreeOwnership,
    pub selected_checkout: bool,
    pub visible: bool,
}

pub fn is_legacy_repo_for_external_worktree_visibility(repo: &Repo) -> bool {
    if let Some(legacy) = repo.external_worktree_visibility_legacy {
        return legacy;
    }
    if repo.external_worktree_visibility.is_none() {
        return true;
    }
    match repo.added_at {
        Some(added) if added.is_finite() => added < EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT as f64,
        _ => true,
    }
}

pub fn effective_external_worktree_visibility(
    visibility: Option<ExternalWorktreeVisibility>,
    is_legacy_repo_for_visibility: bool,
) -> ExternalWorktreeVisibility {
    visibility.unwrap_or(if is_legacy_repo_for_visibility {
        ExternalWorktreeVisibility::Show
    } else {
        ExternalWorktreeVisibility::Hide
    })
}

pub fn build_known_orca_workspace_layouts(
    settings: &WorkspaceLayoutSettings,
    repo: Option<&Repo>,
) -> Vec<OrcaWorkspaceLayout> {
    let mut layouts: Vec<OrcaWorkspaceLayout> = Vec::new();

    if let (Some(repo), Some(base)) = (repo, repo.and_then(get_repo_worktree_base_path)) {
        layouts.push(OrcaWorkspaceLayout {
            path: resolve_workspace_layout_path(&repo.path, &base),
            nest_workspaces: settings.nest_workspaces,
        });
    }

    if let Some(workspace_dir) = settings.workspace_dir.as_deref().filter(|dir| !dir.is_empty()) {
        if should_include_workspace_layout(repo, workspace_dir) {
            layouts.push(OrcaWorkspaceLayout {
                path: match repo {
                    Some(repo) => resolve_workspace_layout_path(&repo.path, workspace_dir),
                    None => workspace_dir.to_string(),
                },
                nest_workspaces: settings.nest_workspaces,
            });
            for layout in &settings.workspace_dir_history {
                if should_include_workspace_layout(repo, &layout.path) {
                    layouts.push(OrcaWorkspaceLayout {
                        path: match repo {
                            Some(repo) => resolve_workspace_layout_path(&repo.path, &layout.path),
                            None => layout.path.clone(),
                        },
                        nest_workspaces: layout.nest_workspaces,
                    });
                }
            }
        }
    }

    if let Some(repo) = repo {
        layouts.extend(build_wsl_workspace_layouts(&repo.path, settings));
    }

    let mut seen: HashSet<String> = HashSet::new();
    layouts
        .into_iter()
        .filter(|layout| {
            let key = format!("{}:{}", normalize_runtime_path_for_comparison(&layout.path), layout.nest_workspaces);
            seen.insert(key) && !layout.path.is_empty()
        })
        .collect()
}

/// The twin is `repo.worktreeBasePath?.trim() || undefined`, and a worktree base
/// path is user-typed/pasted text — `str::trim` would keep a leading U+FEFF (so
/// the path stops reading as absolute) and eat a U+0085 the twin keeps.
fn get_repo_worktree_base_path(repo: &Repo) -> Option<String> {
    repo.worktree_base_path.as_deref().map(trim_js).filter(|trimmed| !trimmed.is_empty()).map(str::to_string)
}

fn resolve_workspace_layout_path(repo_path: &str, layout_path: &str) -> String {
    if is_runtime_path_absolute_for_repo(repo_path, layout_path) {
        normalize_runtime_path_separators(layout_path)
    } else {
        resolve_runtime_path(repo_path, layout_path)
    }
}

fn is_runtime_path_absolute_for_repo(repo_path: &str, layout_path: &str) -> bool {
    let flavor = if is_windows_absolute_path_like(repo_path) || is_windows_absolute_path_like(layout_path) {
        PathFlavor::Windows
    } else {
        PathFlavor::Posix
    };
    is_runtime_path_absolute(layout_path, Some(flavor))
}

fn should_include_workspace_layout(repo: Option<&Repo>, layout_path: &str) -> bool {
    match repo {
        Some(repo) if repo.connection_id.as_deref().is_some_and(|id| !id.is_empty()) => {
            !is_runtime_path_absolute_for_repo(&repo.path, layout_path)
        }
        _ => true,
    }
}

fn build_wsl_workspace_layouts(repo_path: &str, settings: &WorkspaceLayoutSettings) -> Vec<OrcaWorkspaceLayout> {
    let Some(parsed) = parse_wsl_unc_path(repo_path) else {
        return Vec::new();
    };
    // The Linux home is `/home/<user>` (the first segment under /home).
    let Some(rest) = parsed.linux_path.strip_prefix("/home/") else {
        return Vec::new();
    };
    let user = rest.split('/').next().unwrap_or("");
    if user.is_empty() {
        return Vec::new();
    }
    let root = format!("//wsl.localhost/{}/home/{}/orca/workspaces", parsed.distro, user);

    let mut modes = vec![settings.nest_workspaces];
    modes.extend(settings.workspace_dir_history.iter().map(|layout| layout.nest_workspaces));
    let mut seen = HashSet::new();
    modes
        .into_iter()
        .filter(|mode| seen.insert(*mode))
        .map(|nest_workspaces| OrcaWorkspaceLayout { path: root.clone(), nest_workspaces })
        .collect()
}

/// `agent_scratch_matcher` is the twin's optional
/// `agentScratchWorktreePathMatcher`, pre-normalized over every registered
/// checkout by the caller. `None` falls back to the repo root alone, exactly as
/// the twin's `?? isAgentScratchWorktreePath(repo.path, …)` does — a matcher that
/// answers `false` is an answer, not an absence.
pub fn classify_worktree_ownership(
    repo: &Repo,
    worktree: &Worktree,
    meta: Option<&WorktreeMeta>,
    known_orca_layouts: &[OrcaWorkspaceLayout],
    agent_scratch_matcher: Option<&AgentScratchWorktreePathMatcher>,
) -> WorktreeOwnership {
    if has_strong_orca_metadata(meta) {
        return WorktreeOwnership::OrcaManaged;
    }
    // Sub-agent scratch worktrees (e.g. .claude/worktrees) are tool plumbing,
    // not workspaces; classify before the layout heuristics (#9388).
    let is_scratch = match agent_scratch_matcher {
        Some(matcher) => matcher.matches(&worktree.path),
        None => is_agent_scratch_worktree_path(&repo.path, &worktree.path),
    };
    if is_scratch {
        return WorktreeOwnership::AgentScratch;
    }
    // A plain `git worktree add` can target Orca's nested workspace folder —
    // only metadata proves Orca created it (#7078); path shape never does.
    if is_under_flat_or_untrusted_orca_root(&worktree.path, known_orca_layouts) {
        return WorktreeOwnership::UnknownLegacy;
    }
    if can_classify_as_external(&worktree.path, known_orca_layouts) {
        return WorktreeOwnership::External;
    }
    WorktreeOwnership::UnknownLegacy
}

pub fn to_detected_worktree(
    repo: &Repo,
    worktree: &Worktree,
    meta: Option<&WorktreeMeta>,
    known_orca_layouts: &[OrcaWorkspaceLayout],
    is_legacy_repo_for_visibility: Option<bool>,
    agent_scratch_matcher: Option<&AgentScratchWorktreePathMatcher>,
) -> DetectedWorktree {
    let ownership =
        classify_worktree_ownership(repo, worktree, meta, known_orca_layouts, agent_scratch_matcher);
    let selected_checkout = are_runtime_paths_equal(&worktree.path, &repo.path);
    let is_legacy =
        is_legacy_repo_for_visibility.unwrap_or_else(|| is_legacy_repo_for_external_worktree_visibility(repo));
    let visible = should_show_worktree(
        &worktree.path,
        ownership,
        repo,
        is_legacy,
        selected_checkout,
        &repo.imported_external_worktree_paths,
    );
    DetectedWorktree {
        path: worktree.path.clone(),
        is_main_worktree: worktree.is_main_worktree,
        ownership,
        selected_checkout,
        visible,
    }
}

/// `importedExternalWorktreePaths` is a SEPARATE argument in the twin, not read
/// off `repo` — `to_detected_worktree` is what forwards `repo`'s list, and other
/// callers pass a narrower one. The override outranks the scratch rule below, so
/// an explicitly imported scratch row stays visible.
pub fn should_show_worktree(
    worktree_path: &str,
    ownership: WorktreeOwnership,
    repo: &Repo,
    is_legacy_repo_for_visibility: bool,
    is_selected_checkout: bool,
    imported_external_worktree_paths: &[String],
) -> bool {
    if is_selected_checkout {
        return true;
    }
    if ownership == WorktreeOwnership::OrcaManaged {
        return true;
    }
    if is_explicitly_imported_external_worktree_path(worktree_path, imported_external_worktree_paths)
    {
        return true;
    }
    // Agent scratch stays hidden even when the repo shows non-Orca worktrees;
    // only an explicit import or the selected checkout reveals it (#9388).
    if ownership == WorktreeOwnership::AgentScratch {
        return false;
    }
    if ownership == WorktreeOwnership::UnknownLegacy && is_legacy_repo_for_visibility {
        return true;
    }
    effective_external_worktree_visibility(repo.external_worktree_visibility, is_legacy_repo_for_visibility)
        == ExternalWorktreeVisibility::Show
}

/// `applyMetadataFallbackVisibility` — the git scan failed, so metadata is the
/// only evidence left. Fail open: reveal the row and demote any non-managed
/// ownership to `unknown-legacy`, because a path-shape guess is worthless
/// without the scan. Agent scratch is returned untouched — its policy (hidden
/// unless explicitly imported or selected) must survive the fallback.
///
/// The twin returns the very same object for the scratch case and the caller
/// asserts identity; this returns a value-equal clone. No production caller
/// depends on the reference — both (`src/main/ipc/worktrees.ts`,
/// `src/main/runtime/orca-runtime.ts`) push the result straight into an array.
pub fn apply_metadata_fallback_visibility(detected: &DetectedWorktree) -> DetectedWorktree {
    if detected.ownership == WorktreeOwnership::AgentScratch {
        return detected.clone();
    }
    DetectedWorktree {
        visible: true,
        ownership: if detected.ownership == WorktreeOwnership::OrcaManaged {
            WorktreeOwnership::OrcaManaged
        } else {
            WorktreeOwnership::UnknownLegacy
        },
        ..detected.clone()
    }
}

pub fn are_runtime_paths_equal(left_path: &str, right_path: &str) -> bool {
    normalize_runtime_path_for_comparison(left_path) == normalize_runtime_path_for_comparison(right_path)
}

fn has_strong_orca_metadata(meta: Option<&WorktreeMeta>) -> bool {
    let Some(meta) = meta else {
        return false;
    };
    meta.orca_created_at.is_some_and(|value| value != 0.0)
        || meta.orca_creation_workspace_layout
        || meta.created_at.is_some_and(|value| value != 0.0)
        || meta.created_with_agent
        || meta.push_target
        || meta.sparse_base_ref.as_deref().is_some_and(|value| !value.is_empty())
        || meta.sparse_preset_id.as_deref().is_some_and(|value| !value.is_empty())
        || meta.preserve_branch_on_delete
}


fn is_under_flat_or_untrusted_orca_root(worktree_path: &str, known_orca_layouts: &[OrcaWorkspaceLayout]) -> bool {
    for layout in known_orca_layouts {
        if relative_path_inside_root(&layout.path, worktree_path).is_none() {
            continue;
        }
        if !layout.nest_workspaces {
            return true;
        }
    }
    false
}

fn can_classify_as_external(worktree_path: &str, known_orca_layouts: &[OrcaWorkspaceLayout]) -> bool {
    if known_orca_layouts.is_empty() {
        return false;
    }
    for layout in known_orca_layouts {
        if relative_path_inside_root(&layout.path, worktree_path).is_none() {
            continue;
        }
        return layout.nest_workspaces;
    }
    true
}




#[cfg(test)]
mod tests {
    use super::*;
    use ExternalWorktreeVisibility::{Hide, Show};
    use WorktreeOwnership::{AgentScratch, External, OrcaManaged, UnknownLegacy};

    const SCRATCH_PATH: &str = "/repos/app/.claude/worktrees/agent-a04ccaaa55ddadb91";

    fn detected(path: &str, ownership: WorktreeOwnership, visible: bool) -> DetectedWorktree {
        DetectedWorktree {
            path: path.to_string(),
            is_main_worktree: false,
            ownership,
            selected_checkout: false,
            visible,
        }
    }

    fn make_repo() -> Repo {
        Repo {
            path: "/repos/app".to_string(),
            added_at: Some((EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT + 1) as f64),
            ..Default::default()
        }
    }

    fn make_settings() -> WorkspaceLayoutSettings {
        WorkspaceLayoutSettings {
            workspace_dir: Some("/orca/workspaces".to_string()),
            nest_workspaces: true,
            workspace_dir_history: Vec::new(),
        }
    }

    fn worktree(path: &str) -> Worktree {
        Worktree { path: path.to_string(), is_main_worktree: true }
    }

    #[test]
    fn treats_explicit_orca_metadata_as_managed_even_outside_workspace_root() {
        let repo = make_repo();
        let settings = make_settings();
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        let meta = WorktreeMeta { orca_created_at: Some(1.0), ..Default::default() };
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree("/tmp/outside"), Some(&meta), &layouts, None),
            OrcaManaged
        );
    }

    #[test]
    fn treats_nested_orca_workspace_paths_without_metadata_as_external() {
        let repo = make_repo();
        let settings = make_settings();
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        // #7078: a plain `git worktree add` can target the nested workspace
        // folder — only metadata proves Orca created it, never path shape.
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree("/orca/workspaces/app/feature"), None, &layouts, None),
            External
        );
        let meta = WorktreeMeta { orca_creation_workspace_layout: true, ..Default::default() };
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree("/orca/workspaces/app/feature"), Some(&meta), &layouts, None),
            OrcaManaged
        );
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree("/orca/workspaces/other/feature"), None, &layouts, None),
            External
        );
    }

    #[test]
    fn treats_flat_workspace_root_descendants_as_unknown_legacy_without_strong_metadata() {
        let repo = make_repo();
        let settings = WorkspaceLayoutSettings { nest_workspaces: false, ..make_settings() };
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree("/orca/workspaces/feature"), None, &layouts, None),
            UnknownLegacy
        );
    }

    #[test]
    fn keeps_flat_layout_history_weak_after_switching_same_root_to_nested() {
        let repo = make_repo();
        let settings = WorkspaceLayoutSettings {
            workspace_dir_history: vec![OrcaWorkspaceLayout { path: "/orca/workspaces".to_string(), nest_workspaces: false }],
            ..make_settings()
        };
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree("/orca/workspaces/feature"), None, &layouts, None),
            UnknownLegacy
        );
    }

    #[test]
    fn uses_each_historical_layout_nest_mode_when_matching_old_roots() {
        let repo = make_repo();
        let settings = WorkspaceLayoutSettings {
            workspace_dir: Some("/new/workspaces".to_string()),
            workspace_dir_history: vec![OrcaWorkspaceLayout { path: "/old/workspaces".to_string(), nest_workspaces: true }],
            ..make_settings()
        };
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        // Historical nested roots still classify by nest mode: metadata-free
        // descendants are external (#7078), not unknown-legacy.
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree("/old/workspaces/app/feature"), None, &layouts, None),
            External
        );
    }

    #[test]
    fn builds_known_layouts_from_large_workspace_history_lists() {
        const COUNT: usize = 150_000;
        let repo = make_repo();
        let history: Vec<OrcaWorkspaceLayout> = (0..COUNT)
            .map(|index| OrcaWorkspaceLayout { path: format!("/history/workspaces-{index}"), nest_workspaces: index % 2 == 0 })
            .collect();
        let settings = WorkspaceLayoutSettings {
            workspace_dir: Some("/new/workspaces".to_string()),
            workspace_dir_history: history,
            ..make_settings()
        };
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        assert_eq!(layouts.len(), COUNT + 1);
        assert_eq!(layouts[0], OrcaWorkspaceLayout { path: "/new/workspaces".to_string(), nest_workspaces: true });
        assert_eq!(layouts[1], OrcaWorkspaceLayout { path: "/history/workspaces-0".to_string(), nest_workspaces: true });
        assert_eq!(
            layouts.last().unwrap(),
            &OrcaWorkspaceLayout { path: format!("/history/workspaces-{}", COUNT - 1), nest_workspaces: false }
        );
    }

    // `worktreeBasePath` is user-typed text, and the twin trims it with JS
    // `.trim()`. `str::trim` keeps U+FEFF (so a pasted BOM stops the path reading
    // as absolute and it resolves under the repo instead) and strips U+0085 (so a
    // base path the twin keeps disappears entirely).
    #[test]
    fn trims_the_repo_worktree_base_path_with_the_js_trim_set() {
        let settings = WorkspaceLayoutSettings { workspace_dir: None, ..make_settings() };
        let bom = Repo { worktree_base_path: Some("\u{FEFF}/abs/base".to_string()), ..make_repo() };
        assert_eq!(
            build_known_orca_workspace_layouts(&settings, Some(&bom)),
            vec![OrcaWorkspaceLayout { path: "/abs/base".to_string(), nest_workspaces: true }]
        );
        let nel = Repo { worktree_base_path: Some("\u{0085}".to_string()), ..make_repo() };
        assert_eq!(
            build_known_orca_workspace_layouts(&settings, Some(&nel)),
            vec![OrcaWorkspaceLayout { path: "/repos/app/\u{0085}".to_string(), nest_workspaces: true }]
        );
        let spaces = Repo { worktree_base_path: Some("  base \t".to_string()), ..make_repo() };
        assert_eq!(
            build_known_orca_workspace_layouts(&settings, Some(&spaces)),
            vec![OrcaWorkspaceLayout { path: "/repos/app/base".to_string(), nest_workspaces: true }]
        );
    }

    // The twin's `||` chain accepts a TuiAgent string and a GitPushTarget object,
    // which is the whole point of those two markers existing separately from
    // `orcaCreatedAt` (`hasLegacyOrcaCreationEvidence` names that state).
    #[test]
    fn treats_the_non_numeric_metadata_markers_as_strong_ownership() {
        let repo = make_repo();
        let layouts = build_known_orca_workspace_layouts(&make_settings(), Some(&repo));
        for meta in [
            WorktreeMeta { created_with_agent: true, ..Default::default() },
            WorktreeMeta { push_target: true, ..Default::default() },
        ] {
            assert_eq!(
                classify_worktree_ownership(&repo, &worktree("/scratch/manual"), Some(&meta), &layouts, None),
                OrcaManaged
            );
        }
    }

    #[test]
    fn handles_windows_drive_casing_and_separators() {
        let repo = Repo { path: "C:\\repos\\App".to_string(), ..make_repo() };
        let settings = WorkspaceLayoutSettings { workspace_dir: Some("C:\\Orca\\Workspaces".to_string()), ..make_settings() };
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        let worktree = Worktree { path: "C:\\ORCA\\WORKSPACES\\App\\Feature".to_string(), is_main_worktree: false };
        // Nested-root descendants without metadata classify external (#7078); the
        // drive-casing/separator normalization is what keeps this off unknown-legacy.
        assert_eq!(classify_worktree_ownership(&repo, &worktree, None, &layouts, None), External);
    }

    #[test]
    fn keeps_selected_linked_checkouts_visible_without_trusting_git_main_worktree() {
        let repo = Repo {
            path: "/repos/app-linked".to_string(),
            external_worktree_visibility: Some(Hide),
            ..make_repo()
        };
        let settings = make_settings();
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        let selected = to_detected_worktree(
            &repo,
            &Worktree { path: "/repos/app-linked".to_string(), is_main_worktree: false },
            None,
            &layouts,
            None,
            None,
        );
        let git_main = to_detected_worktree(
            &repo,
            &Worktree { path: "/repos/app-main".to_string(), is_main_worktree: true },
            None,
            &layouts,
            None,
            None,
        );
        assert!(selected.visible);
        assert!(!git_main.visible);
        assert_eq!(git_main.ownership, External);
    }

    #[test]
    fn defaults_undefined_visibility_to_hide_for_new_and_show_for_legacy() {
        assert_eq!(effective_external_worktree_visibility(None, false), Hide);
        assert_eq!(effective_external_worktree_visibility(None, true), Show);
    }

    #[test]
    fn treats_persisted_repos_without_explicit_visibility_as_legacy() {
        assert!(is_legacy_repo_for_external_worktree_visibility(&make_repo()));
    }

    #[test]
    fn computes_legacy_status_from_rollout_timing_not_stored_visibility() {
        let repo = Repo {
            added_at: Some((EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT - 1) as f64),
            external_worktree_visibility: Some(Hide),
            ..make_repo()
        };
        assert!(is_legacy_repo_for_external_worktree_visibility(&repo));
    }

    #[test]
    fn honors_an_explicit_legacy_marker_after_visibility_changes() {
        let legacy = Repo {
            external_worktree_visibility: Some(Hide),
            external_worktree_visibility_legacy: Some(true),
            ..make_repo()
        };
        let not_legacy = Repo {
            external_worktree_visibility: Some(Hide),
            external_worktree_visibility_legacy: Some(false),
            ..make_repo()
        };
        assert!(is_legacy_repo_for_external_worktree_visibility(&legacy));
        assert!(!is_legacy_repo_for_external_worktree_visibility(&not_legacy));
    }

    #[test]
    fn treats_repos_without_a_valid_added_at_as_legacy() {
        assert!(is_legacy_repo_for_external_worktree_visibility(&Repo { added_at: None, ..make_repo() }));
        assert!(is_legacy_repo_for_external_worktree_visibility(&Repo { added_at: Some(f64::NAN), ..make_repo() }));
    }

    // Twin: 'hides agent scratch even when the repo shows non-Orca worktrees'.
    #[test]
    fn hides_agent_scratch_even_when_the_repo_shows_non_orca_worktrees() {
        let shows_external = Repo { external_worktree_visibility: Some(Show), ..make_repo() };
        assert!(!should_show_worktree(SCRATCH_PATH, AgentScratch, &shows_external, false, false, &[]));
        let legacy = Repo {
            added_at: Some((EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT - 1) as f64),
            ..make_repo()
        };
        assert!(!should_show_worktree(SCRATCH_PATH, AgentScratch, &legacy, true, false, &[]));
    }

    // Twin: 'still shows agent scratch for the selected checkout or an explicit
    // import'.
    #[test]
    fn still_shows_agent_scratch_for_the_selected_checkout_or_an_explicit_import() {
        assert!(should_show_worktree(SCRATCH_PATH, AgentScratch, &make_repo(), false, true, &[]));
        assert!(should_show_worktree(
            SCRATCH_PATH,
            AgentScratch,
            &make_repo(),
            false,
            false,
            &[SCRATCH_PATH.to_string()]
        ));
    }

    // Twin: 'shows explicitly imported external worktrees while repo visibility
    // stays hide'. The override outranks the hide policy AND the scratch rule,
    // and it is the ONLY route by which a scratch row becomes visible without
    // being the selected checkout.
    #[test]
    fn shows_explicitly_imported_rows_while_repo_visibility_stays_hide() {
        let repo = Repo {
            external_worktree_visibility: Some(Hide),
            imported_external_worktree_paths: vec!["/scratch/imported".to_string()],
            ..make_repo()
        };
        let layouts = build_known_orca_workspace_layouts(&make_settings(), Some(&repo));
        let imported = to_detected_worktree(
            &repo,
            &Worktree { path: "/scratch/imported".to_string(), is_main_worktree: false },
            None,
            &layouts,
            None,
            None,
        );
        let other = to_detected_worktree(
            &repo,
            &Worktree { path: "/scratch/other".to_string(), is_main_worktree: false },
            None,
            &layouts,
            None,
            None,
        );
        assert!(imported.visible);
        assert!(!other.visible);
    }

    // The stored path and the row's path are compared through the comparison
    // fold, so a trailing slash, a separator flip or Windows casing all still
    // reveal the row — but POSIX case does not.
    #[test]
    fn folds_the_imported_path_the_way_the_comparison_key_does() {
        let repo = Repo { external_worktree_visibility: Some(Hide), ..make_repo() };
        for stored in ["/scratch/imported/", "/scratch//imported"] {
            assert!(
                should_show_worktree(
                    "/scratch/imported",
                    External,
                    &repo,
                    false,
                    false,
                    &[stored.to_string()]
                ),
                "{stored}"
            );
        }
        assert!(should_show_worktree(
            "C:\\scratch\\Imported",
            External,
            &repo,
            false,
            false,
            &["c:/scratch/imported".to_string()]
        ));
        assert!(!should_show_worktree(
            "/scratch/imported",
            External,
            &repo,
            false,
            false,
            &["/scratch/Imported".to_string()]
        ));
    }

    // `classifyWorktreeOwnership` step 2. Without it every one of these rows
    // classifies `external` and un-hides in the sidebar (#9535/#9388).
    #[test]
    fn classifies_sub_agent_scratch_paths_as_agent_scratch_without_metadata() {
        let repo = make_repo();
        let layouts = build_known_orca_workspace_layouts(&make_settings(), Some(&repo));
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree(SCRATCH_PATH), None, &layouts, None),
            AgentScratch
        );
        assert_eq!(
            classify_worktree_ownership(
                &repo,
                &worktree("/repos/app/.gsd-workspaces/phase-1-subagent-2"),
                None,
                &layouts,
                None
            ),
            AgentScratch
        );
        // Not anchored to a registered checkout, so it stays an ordinary row.
        assert_eq!(
            classify_worktree_ownership(
                &repo,
                &worktree("/repos/other/.claude/worktrees/agent-1"),
                None,
                &layouts,
                None
            ),
            External
        );
    }

    // Twin: 'classifies scratch worktrees created inside another linked checkout'.
    // An explicit matcher REPLACES the repo-root fallback — including when it
    // says no, which is why `??` and not `||`.
    #[test]
    fn uses_the_supplied_matcher_instead_of_the_repo_root_fallback() {
        let repo = make_repo();
        let layouts = build_known_orca_workspace_layouts(&make_settings(), Some(&repo));
        let linked = "/orca/workspaces/app/feature-x/.claude/worktrees/agent-1";
        let matcher = AgentScratchWorktreePathMatcher::new(&[
            repo.path.clone(),
            "/orca/workspaces/app/feature-x".to_string(),
        ]);
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree(linked), None, &layouts, Some(&matcher)),
            AgentScratch
        );
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree(linked), None, &layouts, None),
            External
        );
        let narrow = AgentScratchWorktreePathMatcher::new(&["/somewhere/else".to_string()]);
        assert_eq!(
            classify_worktree_ownership(
                &repo,
                &worktree(SCRATCH_PATH),
                None,
                &layouts,
                Some(&narrow)
            ),
            External
        );
    }

    // Twin: 'keeps strong Orca metadata authoritative over the scratch path match'
    // — step 1 runs before step 2.
    #[test]
    fn keeps_strong_orca_metadata_authoritative_over_the_scratch_path_match() {
        let repo = make_repo();
        let layouts = build_known_orca_workspace_layouts(&make_settings(), Some(&repo));
        let meta = WorktreeMeta { orca_created_at: Some(1.0), ..Default::default() };
        assert_eq!(
            classify_worktree_ownership(&repo, &worktree(SCRATCH_PATH), Some(&meta), &layouts, None),
            OrcaManaged
        );
    }

    // Twin: 'does not classify worktrees from a repo stored below a scratch-looking
    // parent'. The marker must sit directly under a registered checkout, so a repo
    // that itself lives in `.claude/worktrees` does not make its children scratch.
    #[test]
    fn does_not_classify_rows_of_a_repo_stored_below_a_scratch_looking_parent() {
        let repo = Repo { path: "/repos/.claude/worktrees/app".to_string(), ..make_repo() };
        let layouts = build_known_orca_workspace_layouts(&make_settings(), Some(&repo));
        assert_ne!(
            classify_worktree_ownership(
                &repo,
                &worktree("/repos/.claude/worktrees/app/manual/feature-x"),
                None,
                &layouts,
                None
            ),
            AgentScratch
        );
    }

    // Step 2 runs BEFORE the layout heuristics, so a scratch path that also sits
    // under a flat Orca root is scratch, not unknown-legacy.
    #[test]
    fn classifies_scratch_ahead_of_the_flat_orca_root_heuristic() {
        let repo = Repo { path: "/orca/workspaces".to_string(), ..make_repo() };
        let settings = WorkspaceLayoutSettings { nest_workspaces: false, ..make_settings() };
        let layouts = build_known_orca_workspace_layouts(&settings, Some(&repo));
        assert_eq!(
            classify_worktree_ownership(
                &repo,
                &worktree("/orca/workspaces/.claude/worktrees/agent-1"),
                None,
                &layouts,
                None
            ),
            AgentScratch
        );
    }

    // Twin: 'keeps agent scratch hidden in the metadata fallback while revealing
    // the rest'.
    #[test]
    fn keeps_agent_scratch_hidden_in_the_metadata_fallback_while_revealing_the_rest() {
        let scratch = detected(SCRATCH_PATH, AgentScratch, false);
        let external = detected("/scratch/manual", External, true);

        let scratch_fallback = apply_metadata_fallback_visibility(&scratch);
        assert!(!scratch_fallback.visible);
        assert_eq!(scratch_fallback.ownership, AgentScratch);

        let external_fallback = apply_metadata_fallback_visibility(&external);
        assert!(external_fallback.visible);
        assert_eq!(external_fallback.ownership, UnknownLegacy);
    }

    // Twin: 'preserves an explicit scratch import in the metadata fallback' —
    // there the row is visible because it was imported, and the twin asserts the
    // fallback hands back the SAME object (`toBe`). Value equality is the
    // portable half of that contract.
    #[test]
    fn preserves_an_explicit_scratch_import_in_the_metadata_fallback() {
        let scratch = detected(SCRATCH_PATH, AgentScratch, true);
        assert_eq!(apply_metadata_fallback_visibility(&scratch), scratch);
    }

    // Boundary the twin's tests leave to the ternary: managed rows keep their
    // ownership through the fallback, every other non-scratch row is demoted.
    #[test]
    fn metadata_fallback_keeps_managed_ownership_and_demotes_the_rest() {
        let managed = apply_metadata_fallback_visibility(&detected("/tmp/outside", OrcaManaged, false));
        assert_eq!(managed.ownership, OrcaManaged);
        assert!(managed.visible);
        for ownership in [External, UnknownLegacy] {
            let row = apply_metadata_fallback_visibility(&detected("/tmp/outside", ownership, false));
            assert_eq!(row.ownership, UnknownLegacy);
            assert!(row.visible);
        }
    }

    // The fallback decides two fields and touches nothing else.
    #[test]
    fn metadata_fallback_leaves_the_rest_of_the_row_alone() {
        let selected = DetectedWorktree {
            path: "/repos/app".to_string(),
            is_main_worktree: true,
            ownership: External,
            selected_checkout: true,
            visible: true,
        };
        let fallback = apply_metadata_fallback_visibility(&selected);
        assert_eq!(fallback.path, selected.path);
        assert_eq!(fallback.is_main_worktree, selected.is_main_worktree);
        assert_eq!(fallback.selected_checkout, selected.selected_checkout);
    }

    #[test]
    fn keeps_unknown_legacy_rows_visible_for_legacy_repos_after_hiding_external_rows() {
        let repo = Repo {
            added_at: Some((EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT - 1) as f64),
            external_worktree_visibility: Some(Hide),
            ..make_repo()
        };
        assert!(should_show_worktree("/scratch/manual", UnknownLegacy, &repo, true, false, &[]));
    }
}
