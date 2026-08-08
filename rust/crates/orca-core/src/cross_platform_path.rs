//! Cross-platform path containment and resolution, ported from
//! `src/shared/cross-platform-path.ts`.
//!
//! These helpers deliberately operate on path *strings* with an explicit POSIX
//! or Windows flavour rather than the host `std::path`, because Orca resolves
//! paths for *remote* hosts (SSH/WSL) whose separator and drive semantics differ
//! from the machine running the code. The behaviour is byte-for-byte matched to
//! the TypeScript source so local and remote runtimes agree on containment.

/// Whether a path string should be treated with Windows semantics, regardless of
/// the host platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathFlavor {
    Posix,
    Windows,
}

/// `^[A-Za-z]:[\\/]` — a drive-letter prefix followed by a separator.
fn starts_with_windows_drive(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// `/^[A-Za-z]:\/$/` — exactly `X:/`, a bare drive root.
fn is_drive_root(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/'
}

pub fn is_windows_absolute_path_like(value: &str) -> bool {
    starts_with_windows_drive(value) || value.starts_with("\\\\") || value.starts_with("//")
}

/// Collapse runs of `/` into a single `/`.
fn collapse_slashes(value: &str) -> String {
    let mut out = String::with_capacity(value.len().min(crate::MAX_PREALLOC_HINT));
    let mut prev_slash = false;
    for ch in value.chars() {
        if ch == '/' {
            if !prev_slash {
                out.push(ch);
            }
            prev_slash = true;
        } else {
            out.push(ch);
            prev_slash = false;
        }
    }
    out
}

pub fn normalize_runtime_path_separators(value: &str) -> String {
    let normalized = collapse_slashes(&value.replace('\\', "/"));
    if value.starts_with("\\\\") || value.starts_with("//") {
        format!("//{}", normalized.trim_start_matches('/'))
    } else {
        normalized
    }
}

fn trim_runtime_path_trailing_slash(value: &str) -> String {
    if value == "/" || is_drive_root(value) {
        value.to_string()
    } else {
        value.trim_end_matches('/').to_string()
    }
}

/// Case-insensitive ASCII prefix strip. Panic-free: compares bytes (a non-ASCII
/// byte can never match an ASCII prefix byte), and only slices at `prefix.len()`
/// once the ASCII bytes matched — which guarantees a UTF-8 char boundary there.
fn strip_prefix_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    // `split_at_checked` folds the length and char-boundary guards into one total
    // call. It can only return None where the byte comparison would also fail.
    let (head, rest) = value.split_at_checked(prefix.len())?;
    if head.as_bytes().eq_ignore_ascii_case(prefix.as_bytes()) {
        Some(rest)
    } else {
        None
    }
}

/// Matches the TS `/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i` against
/// an already-separator-normalized path, returning `(distro, tail)` where `tail`
/// keeps its leading `/` (or is empty). The server alias is case-insensitive;
/// the distro and tail are returned verbatim for the caller to fold/preserve.
fn split_wsl_unc_comparison(normalized: &str) -> Option<(&str, &str)> {
    let rest = normalized.strip_prefix("//")?;
    let after_server =
        strip_prefix_ci(rest, "wsl.localhost/").or_else(|| strip_prefix_ci(rest, "wsl$/"))?;
    // distro = [^/]+ (at least one non-slash char); `/` is ASCII so the split is
    // always on a char boundary.
    let distro_len = after_server.find('/').unwrap_or(after_server.len());
    if distro_len == 0 {
        return None;
    }
    after_server.split_at_checked(distro_len)
}

pub fn normalize_runtime_path_for_comparison(value: &str) -> String {
    let normalized = trim_runtime_path_trailing_slash(&normalize_runtime_path_separators(value));
    // Why: Windows exposes the same case-sensitive WSL filesystem through two UNC
    // aliases (`//wsl.localhost/<distro>` and `//wsl$/<distro>`). Fold both to one
    // key with the distro lowercased (server portion is case-insensitive) but the
    // Linux tail's case preserved. Must match cross-platform-path.ts so the TS
    // renderer and this core agree on WSL worktree containment.
    if let Some((distro, tail)) = split_wsl_unc_comparison(&normalized) {
        return format!("//wsl/{}{}", distro.to_lowercase(), tail);
    }
    if is_windows_absolute_path_like(value) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn is_windows_path_flavor(value: &str) -> bool {
    starts_with_windows_drive(value) || value.contains('\\') || value.starts_with("//")
}

fn flavor_of(value: &str) -> PathFlavor {
    if is_windows_path_flavor(value) {
        PathFlavor::Windows
    } else {
        PathFlavor::Posix
    }
}

/// Whether `value` is absolute under the given flavour. When `flavor` is `None`
/// it is inferred from `value`, matching the TS default parameter.
pub fn is_runtime_path_absolute(value: &str, flavor: Option<PathFlavor>) -> bool {
    let flavor = flavor.unwrap_or_else(|| flavor_of(value));
    match flavor {
        PathFlavor::Windows => {
            starts_with_windows_drive(value) || value.starts_with('\\') || value.starts_with('/')
        }
        PathFlavor::Posix => value.starts_with('/'),
    }
}

pub fn resolve_runtime_path(base_path: &str, target_path: &str) -> String {
    let flavor = if is_windows_path_flavor(base_path) || is_windows_path_flavor(target_path) {
        PathFlavor::Windows
    } else {
        PathFlavor::Posix
    };
    if is_runtime_path_absolute(target_path, Some(flavor)) {
        return normalize_runtime_path_dots(target_path, flavor);
    }
    let base = trim_runtime_path_trailing_slash(&normalize_runtime_path_separators(base_path));
    normalize_runtime_path_dots(&format!("{base}/{target_path}"), flavor)
}

pub fn get_runtime_path_basename(value: &str) -> String {
    let trimmed = value.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .split(['\\', '/'])
        .rfind(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

pub fn is_path_inside_or_equal(root_path: &str, candidate_path: &str) -> bool {
    let root = normalize_runtime_path_for_comparison(root_path);
    let candidate = normalize_runtime_path_for_comparison(candidate_path);
    if candidate == root {
        return true;
    }
    let root_with_boundary = if root == "/" || is_drive_root(&root) {
        root
    } else {
        format!("{}/", root.trim_end_matches('/'))
    };
    candidate.starts_with(&root_with_boundary)
}

/// Returns the path of `candidate_path` relative to `root_path`, or `None` if it
/// is not contained. An exact match returns `Some("")`.
pub fn relative_path_inside_root(root_path: &str, candidate_path: &str) -> Option<String> {
    let normalized_candidate =
        trim_runtime_path_trailing_slash(&normalize_runtime_path_separators(candidate_path));
    let comparison_root = normalize_runtime_path_for_comparison(root_path);
    let comparison_candidate = normalize_runtime_path_for_comparison(candidate_path);
    if comparison_candidate == comparison_root {
        return Some(String::new());
    }
    let is_root = comparison_root == "/" || is_drive_root(&comparison_root);
    let comparison_prefix = if is_root {
        comparison_root.clone()
    } else {
        format!("{comparison_root}/")
    };
    if !comparison_candidate.starts_with(&comparison_prefix) {
        return None;
    }
    // WSL comparison keys fold the UNC alias but keep the Linux tail's case, so
    // the suffix is aligned across aliases — slice the comparison key directly.
    // Other roots are lowercased only for comparison, so slice the original-cased
    // candidate by the prefix length (ASCII prefix → char-count == TS UTF-16 slice).
    if comparison_root.starts_with("//wsl/") {
        comparison_candidate
            .strip_prefix(&comparison_prefix)
            .map(str::to_string)
    } else {
        let skip = comparison_prefix.chars().count();
        Some(normalized_candidate.chars().skip(skip).collect())
    }
}

fn normalize_runtime_path_dots(value: &str, flavor: PathFlavor) -> String {
    let normalized = normalize_runtime_path_separators(value);
    let (root, rest) = split_runtime_path_root(&normalized, flavor);
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            // Panic-free (no unwrap) so Trust can verify panic-safety: an empty
            // stack or a top-of-stack `..` both fall through to the else branch.
            if segments.last().is_some_and(|last| *last != "..") {
                segments.pop();
            } else if root.is_empty() {
                segments.push("..");
            }
            continue;
        }
        segments.push(segment);
    }
    let suffix = segments.join("/");
    if root.is_empty() {
        if suffix.is_empty() {
            ".".to_string()
        } else {
            suffix
        }
    } else if !suffix.is_empty() {
        format!("{root}{suffix}")
    } else {
        trim_runtime_path_trailing_slash(&root)
    }
}

/// `X` -> `"X:/"`, without a `format!` (whose `Arguments::new` is an unmodeled
/// unsafe call for the verifier).
fn drive_root(drive: u8) -> String {
    let mut root = String::with_capacity(3);
    root.push(drive as char);
    root.push_str(":/");
    root
}

fn split_runtime_path_root(value: &str, flavor: PathFlavor) -> (String, String) {
    if flavor == PathFlavor::Windows {
        // `^([A-Za-z]:)(?:\/|$)` — slice patterns carry the length each arm needs,
        // which `b.len() >= 2` plus `b[0]`/`b[1]` indexing does not.
        match value.as_bytes() {
            [drive, b':'] if drive.is_ascii_alphabetic() => {
                return (drive_root(*drive), String::new());
            }
            [drive, b':', b'/', ..] if drive.is_ascii_alphabetic() => {
                // Byte 2 is `/`, so byte 3 is always a char boundary.
                let tail = value.get(3..).unwrap_or("");
                return (drive_root(*drive), tail.to_string());
            }
            _ => {}
        }
        if let Some(stripped) = value.strip_prefix("//") {
            let parts: Vec<&str> = stripped.split('/').collect();
            if let [server, share, rest @ ..] = parts.as_slice() {
                if !server.is_empty() && !share.is_empty() {
                    let root = format!("//{server}/{share}/");
                    return (root, rest.join("/"));
                }
            }
            return ("//".to_string(), stripped.to_string());
        }
        if let Some(stripped) = value.strip_prefix('/') {
            return ("/".to_string(), stripped.to_string());
        }
    }
    if let Some(stripped) = value.strip_prefix('/') {
        return ("/".to_string(), stripped.to_string());
    }
    (String::new(), value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported verbatim from src/shared/cross-platform-path.test.ts.

    #[test]
    fn keeps_posix_sibling_prefixes_outside_the_root() {
        assert!(is_path_inside_or_equal("/repo/app", "/repo/app"));
        assert!(is_path_inside_or_equal("/repo/app", "/repo/app/src/index.ts"));
        assert!(!is_path_inside_or_equal(
            "/repo/app",
            "/repo/application/src/index.ts"
        ));
        assert_eq!(
            relative_path_inside_root("/repo/app/", "/repo/app/src/index.ts"),
            Some("src/index.ts".to_string())
        );
    }

    #[test]
    fn handles_windows_drive_roots_and_sibling_drives_case_insensitively() {
        assert!(is_path_inside_or_equal("C:\\Repo", "c:\\repo\\src\\index.ts"));
        assert_eq!(
            relative_path_inside_root("C:\\Repo", "c:\\repo\\src\\index.ts"),
            Some("src/index.ts".to_string())
        );
        assert!(!is_path_inside_or_equal(
            "C:\\Repo",
            "D:\\Repo\\src\\index.ts"
        ));
        assert_eq!(
            relative_path_inside_root("C:\\", "c:\\repo\\src\\index.ts"),
            Some("repo/src/index.ts".to_string())
        );
    }

    #[test]
    fn handles_unc_roots_trailing_slashes_mixed_separators_and_case() {
        assert!(is_path_inside_or_equal(
            "\\\\Server\\Share\\Repo\\",
            "//server/share/repo/src"
        ));
        assert_eq!(
            relative_path_inside_root("\\\\Server\\Share\\Repo\\", "//server/share/repo/src"),
            Some("src".to_string())
        );
        assert!(!is_path_inside_or_equal(
            "\\\\Server\\Share\\Repo",
            "\\\\server\\share\\repo2"
        ));
    }

    #[test]
    fn treats_wsl_unc_aliases_as_the_same_case_sensitive_filesystem() {
        // Ported verbatim from cross-platform-path.test.ts: the two UNC aliases
        // (wsl$ / wsl.localhost) + distro case fold to one root; the Linux tail
        // stays case-sensitive.
        let root = "\\\\wsl$\\Ubuntu\\home\\Alice\\repo";
        assert!(is_path_inside_or_equal(
            root,
            "\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\src"
        ));
        assert_eq!(
            relative_path_inside_root(root, "\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\Src"),
            Some("Src".to_string())
        );
        // Linux tail casing differs (alice != Alice) → not contained.
        assert!(!is_path_inside_or_equal(
            root,
            "\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src"
        ));
        assert_eq!(
            relative_path_inside_root(root, "\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src"),
            None
        );
        assert_eq!(
            relative_path_inside_root(
                root,
                "\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\line\nbreak"
            ),
            Some("line\nbreak".to_string())
        );
    }

    #[test]
    fn resolves_posix_relative_paths_without_using_the_process_cwd() {
        assert_eq!(
            resolve_runtime_path("/repos/app/repo", "../worktrees/feature"),
            "/repos/app/worktrees/feature"
        );
        assert_eq!(
            resolve_runtime_path("/repos/app/repo", "/custom/worktrees"),
            "/custom/worktrees"
        );
        assert!(!is_runtime_path_absolute("../worktrees", None));
    }

    #[test]
    fn resolves_windows_relative_paths_with_windows_semantics() {
        assert_eq!(
            resolve_runtime_path("C:\\Repos\\app\\repo", "..\\worktrees\\feature"),
            "C:/Repos/app/worktrees/feature"
        );
        assert_eq!(
            resolve_runtime_path("C:\\Repos\\app\\repo", "D:\\worktrees"),
            "D:/worktrees"
        );
        assert!(is_runtime_path_absolute(
            "/remote/worktrees",
            Some(PathFlavor::Windows)
        ));
    }

    #[test]
    fn basename_strips_trailing_separators() {
        assert_eq!(get_runtime_path_basename("/repo/app/"), "app");
        assert_eq!(get_runtime_path_basename("C:\\repo\\app\\\\"), "app");
        assert_eq!(get_runtime_path_basename(""), "");
    }
}
