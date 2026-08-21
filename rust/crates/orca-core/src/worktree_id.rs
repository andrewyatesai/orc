//! Worktree-id parsing, ported from `src/shared/worktree-id.ts`.
//!
//! A worktree id is `"<repoId>::<worktreePath>"`. Folder projects can back
//! several workspace sessions with the same directory, so their ids carry a
//! `::workspace:<uuid>` suffix that filesystem callers must strip to recover the
//! real folder path.

use crate::js_string::trim_js;

/// The literal `"::"` separator between repo id and worktree path.
pub const WORKTREE_ID_SEPARATOR: &str = "::";

/// Separator introducing a per-session folder-workspace instance suffix.
pub const FOLDER_WORKSPACE_INSTANCE_SEPARATOR: &str = "::workspace:";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedWorktreeId {
    pub repo_id: String,
    pub worktree_path: String,
}

// `split_once`/`rsplit_once` hand back the two halves directly. The index form
// (`find` + `s[..i]`) is identical at runtime but leaves the slice bounds to be
// rediscovered from `find`'s postcondition, which the verifier cannot see.
pub fn get_repo_id_from_worktree_id(worktree_id: &str) -> String {
    match worktree_id.split_once(WORKTREE_ID_SEPARATOR) {
        Some((repo_id, _)) => repo_id.to_string(),
        None => worktree_id.to_string(),
    }
}

pub fn split_worktree_id(worktree_id: &str) -> Option<ParsedWorktreeId> {
    let (repo_id, worktree_path) = worktree_id.split_once(WORKTREE_ID_SEPARATOR)?;
    Some(ParsedWorktreeId {
        repo_id: repo_id.to_string(),
        worktree_path: worktree_path.to_string(),
    })
}

/// `::workspace:` followed by exactly 36 `[0-9a-f-]` chars at end of string.
fn is_folder_instance_uuid(after: &str) -> bool {
    after.len() == 36
        && after
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

fn strip_folder_workspace_instance_suffix(path: &str) -> String {
    let sep = FOLDER_WORKSPACE_INSTANCE_SEPARATOR;
    // Only the last separator can qualify: the suffix is anchored to the end at a
    // fixed 36 chars, and a uuid ([0-9a-f-]) can contain no further separator.
    match path.rsplit_once(sep) {
        Some((prefix, after)) if is_folder_instance_uuid(after) => prefix.to_string(),
        _ => path.to_string(),
    }
}

pub fn split_worktree_id_for_filesystem(worktree_id: &str) -> Option<ParsedWorktreeId> {
    let parsed = split_worktree_id(worktree_id)?;
    Some(ParsedWorktreeId {
        repo_id: parsed.repo_id,
        worktree_path: strip_folder_workspace_instance_suffix(&parsed.worktree_path),
    })
}

pub fn get_worktree_path_basename_from_id(worktree_id: &str) -> Option<String> {
    let worktree_path = split_worktree_id_for_filesystem(worktree_id)
        .map(|p| p.worktree_path)
        .unwrap_or_default();
    // `trim_js`, not `trim`: the twin calls JS `.trim()`, whose whitespace set is
    // not Rust's. JS strips U+FEFF and Rust does not; Rust strips U+0085 (NEL)
    // and JS does not. Both directions were live here — `"r::/a/b\u{feff}"`
    // answered `"b\u{feff}"` against the twin's `"b"`, and `"r::\u{85}"`
    // answered `None` against the twin's `"\u{85}"`. Six vectors pin it.
    let normalized_path = trim_js(&worktree_path).trim_end_matches(['\\', '/']);
    if normalized_path.is_empty() {
        return None;
    }
    let basename = normalized_path
        .split(['\\', '/'])
        .rfind(|s| !s.is_empty())
        .map(trim_js)
        .unwrap_or("");
    if basename.is_empty() {
        None
    } else {
        Some(basename.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(repo_id: &str, worktree_path: &str) -> ParsedWorktreeId {
        ParsedWorktreeId {
            repo_id: repo_id.to_string(),
            worktree_path: worktree_path.to_string(),
        }
    }

    #[test]
    fn separator_is_double_colon() {
        assert_eq!(WORKTREE_ID_SEPARATOR, "::");
    }

    #[test]
    fn get_repo_id_cases() {
        assert_eq!(get_repo_id_from_worktree_id("repo-123::/abs/path"), "repo-123");
        assert_eq!(get_repo_id_from_worktree_id("just-a-repo-id"), "just-a-repo-id");
        assert_eq!(get_repo_id_from_worktree_id(""), "");
        assert_eq!(get_repo_id_from_worktree_id("::"), "");
        assert_eq!(get_repo_id_from_worktree_id("::path"), "");
        assert_eq!(get_repo_id_from_worktree_id("repo::"), "repo");
        assert_eq!(get_repo_id_from_worktree_id("repo::a::b"), "repo");
    }

    #[test]
    fn split_worktree_id_cases() {
        assert_eq!(
            split_worktree_id("repo-123::/abs/path"),
            Some(parsed("repo-123", "/abs/path"))
        );
        assert_eq!(split_worktree_id("just-a-repo-id"), None);
        assert_eq!(split_worktree_id(""), None);
        assert_eq!(split_worktree_id("::"), Some(parsed("", "")));
        assert_eq!(split_worktree_id("::path"), Some(parsed("", "path")));
        assert_eq!(split_worktree_id("repo::"), Some(parsed("repo", "")));
        assert_eq!(split_worktree_id("repo::a::b"), Some(parsed("repo", "a::b")));
        assert_eq!(
            split_worktree_id("repo::/folder::workspace:123e4567-e89b-12d3-a456-426614174000"),
            Some(parsed(
                "repo",
                "/folder::workspace:123e4567-e89b-12d3-a456-426614174000"
            ))
        );
    }

    #[test]
    fn split_for_filesystem_strips_instance_suffix() {
        assert_eq!(
            split_worktree_id_for_filesystem(
                "repo::/folder::workspace:123e4567-e89b-12d3-a456-426614174000"
            ),
            Some(parsed("repo", "/folder"))
        );
    }

    /// Pre-`rsplit_once` implementation, kept as the behavioral oracle.
    fn strip_suffix_by_forward_scan(path: &str) -> String {
        let sep = FOLDER_WORKSPACE_INSTANCE_SEPARATOR;
        let mut search_start = 0;
        while let Some(rel) = path[search_start..].find(sep) {
            let pos = search_start + rel;
            if is_folder_instance_uuid(&path[pos + sep.len()..]) {
                return path[..pos].to_string();
            }
            search_start = pos + 1;
        }
        path.to_string()
    }

    #[test]
    fn strip_suffix_matches_forward_scan_on_repeated_separators() {
        let uuid = "123e4567-e89b-12d3-a456-426614174000";
        for path in [
            "".to_string(),
            "/plain/folder".to_string(),
            format!("/a::workspace:{uuid}"),
            // an earlier non-qualifying separator must not shadow the real one
            format!("/a::workspace:not-a-uuid::workspace:{uuid}"),
            // a qualifying separator must not be shadowed by a later partial one
            format!("/a::workspace:{uuid}::workspace:"),
            format!("/a:::workspace:{uuid}"),
            "/a::workspace:".to_string(),
            format!("::workspace:{uuid}"),
            format!("/\u{4e2d}\u{6587}::workspace:{uuid}"),
        ] {
            assert_eq!(
                strip_folder_workspace_instance_suffix(&path),
                strip_suffix_by_forward_scan(&path),
                "diverged on {path:?}"
            );
        }
    }

    /// `find` returns a char boundary, so the old index arithmetic never panicked;
    /// pin that the `split_once` rewrite agrees on multibyte and degenerate ids.
    #[test]
    fn parsing_is_total_over_multibyte_ids() {
        let alphabet = [":", "a", "\u{e9}", "\u{1f600}"];
        for len in 0..=5usize {
            for mut k in 0..alphabet.len().pow(len as u32) {
                let mut id = String::new();
                for _ in 0..len {
                    id.push_str(alphabet[k % alphabet.len()]);
                    k /= alphabet.len();
                }
                let repo_id = get_repo_id_from_worktree_id(&id);
                match split_worktree_id(&id) {
                    Some(p) => {
                        assert_eq!(p.repo_id, repo_id);
                        assert_eq!(
                            format!("{}{WORKTREE_ID_SEPARATOR}{}", p.repo_id, p.worktree_path),
                            id
                        );
                    }
                    None => assert_eq!(repo_id, id),
                }
                let _ = get_worktree_path_basename_from_id(&id);
            }
        }
    }

    #[test]
    fn basename_cases() {
        assert_eq!(
            get_worktree_path_basename_from_id("repo-123::/abs/path/nightly-checks"),
            Some("nightly-checks".to_string())
        );
        assert_eq!(
            get_worktree_path_basename_from_id("repo-123::C:\\workspaces\\nightly-checks"),
            Some("nightly-checks".to_string())
        );
        assert_eq!(
            get_worktree_path_basename_from_id(
                "repo-123::/abs/project::workspace:123e4567-e89b-12d3-a456-426614174000"
            ),
            Some("project".to_string())
        );
        assert_eq!(get_worktree_path_basename_from_id("repo-123"), None);
        assert_eq!(get_worktree_path_basename_from_id("repo-123::"), None);
    }
}
