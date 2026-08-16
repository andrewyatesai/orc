//! Explicit external-worktree imports, ported from
//! `src/shared/external-worktree-inbox.ts`.
//!
//! Only the import-membership chain is ported — `normalizeExternalWorktreeInboxPath`,
//! `areExternalWorktreeInboxPathsEqual`, `isExplicitlyImportedExternalWorktreePath`.
//! That chain is what `worktree_ownership::should_show_worktree` delegates to,
//! and it is the branch that lets a user re-reveal a row the visibility policy
//! hides. The twin file's inbox-list surface (`getHiddenExternalWorktrees`,
//! `getNewExternalWorktreeInboxWorktrees`, the suppression/prompt predicates) is
//! NOT ported: it reads `DetectedWorktreeListResult`, which no crate models yet.

use crate::cross_platform_path::normalize_runtime_path_for_comparison;

/// The inbox stores raw user paths and compares them folded, so the same
/// worktree survives a separator, case or UNC-alias difference.
pub fn normalize_external_worktree_inbox_path(path: &str) -> String {
    normalize_runtime_path_for_comparison(path)
}

pub fn are_external_worktree_inbox_paths_equal(left_path: &str, right_path: &str) -> bool {
    normalize_external_worktree_inbox_path(left_path)
        == normalize_external_worktree_inbox_path(right_path)
}

/// `repo.importedExternalWorktreePaths ?? []` — an absent list is an empty one,
/// so a repo that never imported anything answers `false` rather than erroring.
pub fn is_explicitly_imported_external_worktree_path(
    worktree_path: &str,
    imported_external_worktree_paths: &[String],
) -> bool {
    imported_external_worktree_paths
        .iter()
        .any(|path| are_external_worktree_inbox_paths_equal(path, worktree_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn matches_an_imported_path_through_separator_case_and_alias_folding() {
        assert!(is_explicitly_imported_external_worktree_path(
            "/scratch/imported",
            &paths(&["/scratch/imported/"])
        ));
        assert!(is_explicitly_imported_external_worktree_path(
            "C:\\scratch\\Imported",
            &paths(&["c:/scratch/imported"])
        ));
        assert!(is_explicitly_imported_external_worktree_path(
            "//wsl.localhost/Ubuntu/home/dev/app",
            &paths(&["//wsl$/ubuntu/home/dev/app"])
        ));
    }

    // POSIX case is significant, and an empty list (or an absent one, which the
    // twin's `?? []` turns into this) never matches.
    #[test]
    fn does_not_match_a_different_or_absent_import() {
        assert!(!is_explicitly_imported_external_worktree_path(
            "/scratch/imported",
            &paths(&["/scratch/Imported"])
        ));
        assert!(!is_explicitly_imported_external_worktree_path("/scratch/imported", &[]));
    }

    // An empty stored path is a real entry, not a wildcard: it only matches an
    // empty candidate. `Some("")` truthiness is the trap this pins.
    #[test]
    fn treats_an_empty_stored_path_as_an_ordinary_entry() {
        assert!(!is_explicitly_imported_external_worktree_path("/scratch/imported", &paths(&[""])));
        assert!(is_explicitly_imported_external_worktree_path("", &paths(&[""])));
    }
}
