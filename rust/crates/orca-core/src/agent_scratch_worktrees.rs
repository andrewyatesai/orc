//! Agent scratch worktree/repo-root recognition, ported from
//! `src/shared/agent-scratch-worktrees.ts`.
//!
//! Sub-agent runs (Claude Code worktree isolation, gsd parallel workspaces)
//! create throwaway git worktrees at tool-internal paths under a registered
//! checkout. #9535/#9388 stopped surfacing them as workspace rows; this is the
//! predicate that decision hangs on, so a `false` here un-hides every
//! `.claude/worktrees/agent-*` row in the sidebar.
//!
//! Both matchers work on `normalize_runtime_path_for_comparison` keys, which
//! lowercase Windows/UNC paths but leave POSIX and the WSL Linux tail
//! case-SENSITIVE — so `.Claude/Worktrees` matches on Windows and does not on
//! POSIX, which is what the filesystems themselves do.

use crate::cross_platform_path::normalize_runtime_path_for_comparison;
use std::collections::HashSet;

/// Agent CLIs reserve these repo-root paths for scratch; a broader match would
/// hide legitimate user worktrees (#9388).
const AGENT_SCRATCH_PATH_PREFIXES: &[&[&str]] = &[&[".claude", "worktrees"], &[".gsd-workspaces"]];

/// Agent CLIs also mint whole scratch *repos* under these containers; a repo
/// registered at such a root is agent-internal, not a user project (#9388).
const AGENT_SCRATCH_REPO_ROOT_SEGMENTS: &[&[&str]] = &[
    &[".codex-tmp"],
    &[".codex", "vendor_imports"],
    &[".claude", "skills"],
    &[".claude", "worktrees"],
    &[".gsd-workspaces"],
];

/// `createAgentScratchWorktreePathMatcher` — the twin returns a closure over the
/// pre-normalized checkout keys so a fan-out normalizes each checkout once, not
/// once per candidate. A struct is the same thing without a boxed `Fn`.
#[derive(Clone, Debug, Default)]
pub struct AgentScratchWorktreePathMatcher {
    checkout_path_keys: HashSet<String>,
}

impl AgentScratchWorktreePathMatcher {
    pub fn new<S: AsRef<str>>(checkout_paths: &[S]) -> Self {
        Self {
            checkout_path_keys: checkout_paths
                .iter()
                .map(|path| normalize_runtime_path_for_comparison(path.as_ref()))
                .collect(),
        }
    }

    pub fn matches(&self, worktree_path: &str) -> bool {
        let normalized = normalize_runtime_path_for_comparison(worktree_path);
        let segments: Vec<&str> = normalized.split('/').collect();
        for prefix in AGENT_SCRATCH_PATH_PREFIXES {
            // Strict `<`: the marker must have a descendant, so the container
            // itself (`<repo>/.gsd-workspaces`) is not a scratch worktree.
            for index in 0..segments.len().saturating_sub(prefix.len()) {
                if !matches_prefix_at(&segments, index, prefix) {
                    continue;
                }
                if self.checkout_path_keys.contains(&checkout_path_key(&segments, index)) {
                    return true;
                }
            }
        }
        false
    }
}

fn matches_prefix_at(segments: &[&str], index: usize, prefix: &[&str]) -> bool {
    prefix
        .iter()
        .enumerate()
        .all(|(offset, segment)| segments.get(index + offset) == Some(segment))
}

/// The checkout the marker hangs off: everything left of `index`, rejoined.
/// Splitting strips the separator from filesystem roots, but normalized checkout
/// keys retain it: `""` is the POSIX root and `c:` a drive root. The drive test
/// is the twin's `/^[a-z]:$/i` — no `u` flag, so ASCII only.
fn checkout_path_key(segments: &[&str], index: usize) -> String {
    let joined = segments.iter().take(index).copied().collect::<Vec<&str>>().join("/");
    if matches!(joined.as_bytes(), [letter, b':'] if letter.is_ascii_alphabetic()) {
        return format!("{joined}/");
    }
    if joined.is_empty() {
        return "/".to_string();
    }
    joined
}

/// The single-checkout case: only the repo root counts as a registered checkout,
/// so a scratch path under some other worktree is not this repo's scratch.
pub fn is_agent_scratch_worktree_path(repo_path: &str, worktree_path: &str) -> bool {
    AgentScratchWorktreePathMatcher::new(&[repo_path]).matches(worktree_path)
}

/// Matches the marker anywhere above the repo root (the repo lives at or under
/// the scratch container) — unlike worktree matching, which anchors to a
/// registered checkout path. `<=`, so the container itself matches.
pub fn is_agent_scratch_repo_root_path(repo_path: &str) -> bool {
    let normalized = normalize_runtime_path_for_comparison(repo_path);
    let segments: Vec<&str> = normalized.split('/').collect();
    for marker in AGENT_SCRATCH_REPO_ROOT_SEGMENTS {
        for index in 0..(segments.len() + 1).saturating_sub(marker.len()) {
            if matches_prefix_at(&segments, index, marker) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO_PATH: &str = "/userhome/dev/app";

    #[test]
    fn matches_claude_code_sub_agent_worktrees() {
        assert!(is_agent_scratch_worktree_path(
            REPO_PATH,
            "/userhome/dev/app/.claude/worktrees/agent-a04ccaaa55ddadb91"
        ));
    }

    #[test]
    fn matches_gsd_parallel_agent_workspaces() {
        assert!(is_agent_scratch_worktree_path(
            REPO_PATH,
            "/userhome/dev/app/.gsd-workspaces/phase-1-subagent-2"
        ));
    }

    #[test]
    fn matches_scratch_worktrees_created_from_a_linked_checkout() {
        let matcher = AgentScratchWorktreePathMatcher::new(&[
            REPO_PATH,
            "/userhome/dev/orca/workspaces/app/feature-x",
        ]);
        assert!(matcher
            .matches("/userhome/dev/orca/workspaces/app/feature-x/.claude/worktrees/agent-a04ccaaa"));
        assert!(!matcher.matches("/userhome/dev/other/feature-x/.claude/worktrees/agent-a04ccaaa"));
    }

    #[test]
    fn matches_windows_path_separators_and_casing() {
        assert!(is_agent_scratch_worktree_path(
            "C:\\userhome\\dev\\app",
            "c:\\USERHOME\\dev\\app\\.Claude\\Worktrees\\agent-a04ccaaa"
        ));
    }

    #[test]
    fn matches_wsl_unc_paths() {
        assert!(is_agent_scratch_worktree_path(
            "//wsl$/Ubuntu/home/dev/app",
            "//wsl.localhost/Ubuntu/home/dev/app/.claude/worktrees/agent-a04ccaaa"
        ));
    }

    #[test]
    fn preserves_case_sensitive_posix_and_wsl_tool_segments() {
        assert!(!is_agent_scratch_worktree_path(
            REPO_PATH,
            "/userhome/dev/app/.Claude/Worktrees/agent-a04ccaaa"
        ));
        assert!(!is_agent_scratch_worktree_path(
            "//wsl.localhost/Ubuntu/home/dev/app",
            "//wsl.localhost/ubuntu/home/dev/app/.Claude/Worktrees/agent-a04ccaaa"
        ));
    }

    #[test]
    fn requires_the_tool_directory_at_the_repo_root() {
        assert!(!is_agent_scratch_worktree_path(
            REPO_PATH,
            "/userhome/dev/app/.claude/other/worktrees/agent-1"
        ));
        assert!(!is_agent_scratch_worktree_path(
            REPO_PATH,
            "/userhome/dev/app/packages/demo/.claude/worktrees/agent-1"
        ));
        assert!(!is_agent_scratch_worktree_path(REPO_PATH, "/userhome/dev/app/.gsd-workspaces"));
    }

    #[test]
    fn does_not_match_undotted_claude_directories() {
        assert!(!is_agent_scratch_worktree_path(
            REPO_PATH,
            "/userhome/dev/app/claude/worktrees/agent-1"
        ));
    }

    #[test]
    fn does_not_inherit_a_scratch_classification_from_the_repo_parent_path() {
        assert!(!is_agent_scratch_worktree_path(
            "/userhome/dev/.claude/worktrees/app",
            "/userhome/dev/.claude/worktrees/app/manual/feature-x"
        ));
    }

    #[test]
    fn does_not_match_user_worktree_conventions() {
        assert!(!is_agent_scratch_worktree_path(REPO_PATH, "/userhome/dev/app/.worktrees/feature-x"));
        assert!(!is_agent_scratch_worktree_path(
            REPO_PATH,
            "/userhome/dev/.superset/worktrees/app/fix-notes"
        ));
        assert!(!is_agent_scratch_worktree_path(REPO_PATH, "/orca/workspaces/app/feature"));
    }

    // The filesystem roots are where `split('/')` and the normalized checkout key
    // disagree: the POSIX root joins back to `""` and a drive root to `c:`.
    #[test]
    fn anchors_scratch_paths_to_the_filesystem_roots_themselves() {
        assert!(is_agent_scratch_worktree_path("/", "/.claude/worktrees/agent-1"));
        assert!(is_agent_scratch_worktree_path("C:\\", "C:\\.claude\\worktrees\\agent-1"));
        assert!(!is_agent_scratch_worktree_path("D:\\", "C:\\.claude\\worktrees\\agent-1"));
    }

    // The twin's drive test is `/^[a-z]:$/i` with no `u` flag — ASCII only. A
    // two-CHARACTER segment such as `é:` is therefore an ordinary directory that
    // keeps its key verbatim; reading the length in chars instead of ASCII bytes
    // would append a root slash and lose the match.
    #[test]
    fn treats_only_ascii_drive_letters_as_filesystem_roots() {
        assert!(is_agent_scratch_worktree_path("é:", "é:/.claude/worktrees/agent-1"));
    }

    #[test]
    fn matches_codex_and_claude_scratch_repo_roots() {
        for path in [
            "/userhome/dev/.codex-tmp/foragent-capsule-b1-repo-zP9Az6",
            "/userhome/dev/.codex-tmp/rc-fwd-qEXuEq",
            "/userhome/dev/.codex/vendor_imports/skills",
            "/userhome/dev/.claude/skills/obsidian-second-brain",
            "/userhome/dev/.codex-tmp",
            "/userhome/dev/.codex/vendor_imports",
            "/userhome/dev/app/.claude/worktrees/agent-a04ccaaa",
            "/userhome/dev/app/.gsd-workspaces/phase-1",
            "C:\\userhome\\Dev\\.codex-tmp\\Capsule-X",
            "C:\\userhome\\Dev\\.Claude\\Skills\\foo",
        ] {
            assert!(is_agent_scratch_repo_root_path(path), "{path}");
        }
    }

    #[test]
    fn does_not_match_ordinary_repo_roots_or_partial_markers() {
        for path in [
            "/userhome/dev/projects/app",
            "/userhome/dev/codex-tmp/app",
            "/userhome/dev/.codex/checkouts/app",
            "/userhome/dev/skills/.claude-app",
            "/userhome/dev/.claude/config",
            "/userhome/dev/vendor_imports/app",
        ] {
            assert!(!is_agent_scratch_repo_root_path(path), "{path}");
        }
    }
}
