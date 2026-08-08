//! Hosted git remote parsing + file-URL building, ported from
//! `src/main/git/hosted-remote-url.ts` (a scoped fork of `hosted-git-info`).
//!
//! Provider-neutral by design (GitHub / GitLab / Bitbucket), per the repo's
//! git-provider-compatibility rule. Hand-rolled (no `url`/regex crate): the
//! scheme/scp/shorthand parsing is implemented here; percent en/decoding is
//! shared via `crate::uri_component`.

use crate::uri_component::{decode_uri_component, encode_uri_component};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostedRemoteProvider {
    GitHub,
    GitLab,
    Bitbucket,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRemote {
    pub host: String,
    pub path: String,
    pub provider: HostedRemoteProvider,
}

fn shorthand_host(name: &str) -> Option<(&'static str, HostedRemoteProvider)> {
    match name {
        "bitbucket" => Some(("bitbucket.org", HostedRemoteProvider::Bitbucket)),
        "github" => Some(("github.com", HostedRemoteProvider::GitHub)),
        "gitlab" => Some(("gitlab.com", HostedRemoteProvider::GitLab)),
        _ => None,
    }
}

fn provider_for_host(host: &str) -> Option<(&'static str, HostedRemoteProvider)> {
    match host.to_ascii_lowercase().as_str() {
        // ssh.github.com is GitHub's SSH-over-HTTPS host; identity is github.com.
        "github.com" | "ssh.github.com" => Some(("github.com", HostedRemoteProvider::GitHub)),
        "gitlab.com" => Some(("gitlab.com", HostedRemoteProvider::GitLab)),
        "bitbucket.org" => Some(("bitbucket.org", HostedRemoteProvider::Bitbucket)),
        _ => None,
    }
}

fn trim_git_suffix(path: &str) -> &str {
    // `path[path.len() - 4..]` PANICKED whenever byte len-4 fell inside a
    // codepoint (`trim_git_suffix("éabc")`), and a remote URL is user data.
    // `split_at_checked` returns None there, which lands in the no-trim arm the
    // comparison would have taken anyway (".git" is 4 ASCII bytes, so a real
    // match always sits on a boundary).
    let Some(cut) = path.len().checked_sub(4) else {
        return path;
    };
    match path.split_at_checked(cut) {
        Some((head, tail)) if tail.eq_ignore_ascii_case(".git") => head,
        _ => path,
    }
}

fn clean_remote_path(path: &str) -> Option<String> {
    let normalized = trim_git_suffix(path.trim_start_matches('/').trim_end_matches('/'));
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    Some(parts.iter().map(|p| decode_uri_component(p)).collect::<Vec<_>>().join("/"))
}

/// `^([a-z]+):([^/].+)$` — a `host:path` shorthand (e.g. `github:o/r`).
fn match_shorthand(s: &str) -> Option<(&str, &str)> {
    // `split_once` over `find` + index arithmetic: the pair is total, so no
    // slice-bounds obligation is generated at all.
    let (scheme, rest) = s.split_once(':')?;
    if scheme.is_empty() {
        return None;
    }
    if !scheme.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    Some((scheme, rest))
}

fn is_scheme_url(s: &str) -> bool {
    match s.split_once("://") {
        Some((scheme, _)) if !scheme.is_empty() => {
            scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        }
        _ => false,
    }
}

/// `^(?:[^@/:]+@)?([^:\s/]+):([^\s]+)$` — scp-like `[user@]host:path`.
fn match_scp_like(s: &str) -> Option<(&str, &str)> {
    let after_user = match s.split_once('@') {
        Some((user, rest)) if !user.is_empty() && !user.contains(['/', ':']) => rest,
        _ => s,
    };
    let (host, path) = after_user.split_once(':')?;
    if host.is_empty() || host.contains('/') || host.chars().any(char::is_whitespace) {
        return None;
    }
    if path.is_empty() || path.chars().any(char::is_whitespace) {
        return None;
    }
    Some((host, path))
}

/// Extract `(scheme, host, pathname)` from `scheme://[user@]host[:port]/path`.
fn parse_scheme_url(s: &str) -> Option<(String, String, String)> {
    let (raw_scheme, rest) = s.split_once("://")?;
    let scheme = raw_scheme.to_ascii_lowercase();
    // `split_once` drops the separator, so the pathname's leading `/` is put back
    // explicitly; no `/` at all means an empty pathname, as before.
    let (authority, pathname) = match rest.split_once('/') {
        Some((authority, tail)) => {
            let mut pathname = String::from("/");
            pathname.push_str(tail);
            (authority, pathname)
        }
        None => (rest, String::new()),
    };
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = host_port.split(':').next().unwrap_or(host_port);
    Some((scheme, host.to_string(), pathname))
}

pub fn parse_hosted_remote(remote_url: &str) -> Option<HostedRemote> {
    let trimmed = remote_url.trim();
    let trimmed = trimmed.strip_prefix("git+").unwrap_or(trimmed);

    // Shorthand `host:path` always returns here (result or None) — like the TS.
    if let Some((scheme, rest)) = match_shorthand(trimmed) {
        return shorthand_host(&scheme.to_ascii_lowercase()).and_then(|(host, provider)| {
            clean_remote_path(rest).map(|path| HostedRemote { host: host.to_string(), path, provider })
        });
    }

    if !is_scheme_url(trimmed) {
        if let Some((host, path)) = match_scp_like(trimmed) {
            return provider_for_host(host).and_then(|(canonical, provider)| {
                clean_remote_path(path).map(|path| HostedRemote { host: canonical.to_string(), path, provider })
            });
        }
    }

    let (scheme, host, pathname) = parse_scheme_url(trimmed)?;
    if !matches!(scheme.as_str(), "git" | "http" | "https" | "ssh") {
        return None;
    }
    let (canonical, provider) = provider_for_host(&host)?;
    let path = clean_remote_path(&pathname)?;
    Some(HostedRemote { host: canonical.to_string(), path, provider })
}

pub fn build_hosted_remote_file_url(
    remote_url: &str,
    relative_path: &str,
    branch: &str,
    line: u32,
) -> Option<String> {
    let remote = parse_hosted_remote(remote_url)?;
    let encoded_repo = encode_remote_path(&remote.path);
    let encoded_branch = encode_uri_component(branch);
    let encoded_file = encode_relative_path(relative_path);
    let file_suffix = if encoded_file.is_empty() { String::new() } else { format!("/{encoded_file}") };
    let base = format!("https://{}/{}", remote.host, encoded_repo);

    Some(match remote.provider {
        HostedRemoteProvider::GitHub => format!("{base}/blob/{encoded_branch}{file_suffix}#L{line}"),
        HostedRemoteProvider::GitLab => format!("{base}/-/blob/{encoded_branch}{file_suffix}#L{line}"),
        HostedRemoteProvider::Bitbucket => format!(
            "{base}/src/{encoded_branch}{file_suffix}{}",
            encode_bitbucket_file_line_fragment(relative_path, line)
        ),
    })
}

fn encode_remote_path(path: &str) -> String {
    path.split('/').map(encode_uri_component).collect::<Vec<_>>().join("/")
}

fn encode_relative_path(path: &str) -> String {
    path.replace('\\', "/").split('/').filter(|p| !p.is_empty()).map(encode_uri_component).collect::<Vec<_>>().join("/")
}

fn encode_bitbucket_file_line_fragment(path: &str, line: u32) -> String {
    let normalized = path.replace('\\', "/");
    match normalized.split('/').rfind(|p| !p.is_empty()) {
        Some(file_name) => format!("#{}", encode_uri_component(&format!("{file_name}-{line}"))),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use HostedRemoteProvider::{Bitbucket, GitHub, GitLab};

    fn remote(host: &str, path: &str, provider: HostedRemoteProvider) -> HostedRemote {
        HostedRemote { host: host.to_string(), path: path.to_string(), provider }
    }

    #[test]
    fn parses_https_ssh_scp_and_shorthand() {
        assert_eq!(
            parse_hosted_remote("https://github.com/owner/repo.git"),
            Some(remote("github.com", "owner/repo", GitHub))
        );
        assert_eq!(
            parse_hosted_remote("git@github.com:owner/repo.git"),
            Some(remote("github.com", "owner/repo", GitHub))
        );
        assert_eq!(
            parse_hosted_remote("ssh://git@gitlab.com/group/proj.git"),
            Some(remote("gitlab.com", "group/proj", GitLab))
        );
        assert_eq!(
            parse_hosted_remote("github:owner/repo"),
            Some(remote("github.com", "owner/repo", GitHub))
        );
        assert_eq!(
            parse_hosted_remote("https://bitbucket.org/team/repo"),
            Some(remote("bitbucket.org", "team/repo", Bitbucket))
        );
        // ssh.github.com normalizes to github.com.
        assert_eq!(
            parse_hosted_remote("git@ssh.github.com:owner/repo.git"),
            Some(remote("github.com", "owner/repo", GitHub))
        );
        // git+ prefix is stripped.
        assert_eq!(
            parse_hosted_remote("git+https://github.com/owner/repo.git"),
            Some(remote("github.com", "owner/repo", GitHub))
        );
    }

    #[test]
    fn rejects_unknown_hosts_and_short_paths() {
        assert_eq!(parse_hosted_remote("https://example.com/owner/repo.git"), None);
        assert_eq!(parse_hosted_remote("https://github.com/onlyone.git"), None);
        assert_eq!(parse_hosted_remote("not a url"), None);
        assert_eq!(parse_hosted_remote("ftp://github.com/o/r.git"), None); // scheme not allowed
    }

    #[test]
    fn builds_provider_specific_file_urls() {
        assert_eq!(
            build_hosted_remote_file_url("https://github.com/owner/repo.git", "src/main.rs", "main", 42).as_deref(),
            Some("https://github.com/owner/repo/blob/main/src/main.rs#L42")
        );
        assert_eq!(
            build_hosted_remote_file_url("git@gitlab.com:group/proj.git", "src/main.rs", "main", 42).as_deref(),
            Some("https://gitlab.com/group/proj/-/blob/main/src/main.rs#L42")
        );
        assert_eq!(
            build_hosted_remote_file_url("https://bitbucket.org/team/repo", "src/main.rs", "main", 42).as_deref(),
            Some("https://bitbucket.org/team/repo/src/main/src/main.rs#main.rs-42")
        );
    }

    #[test]
    fn encodes_special_characters_in_paths_and_branches() {
        let url = build_hosted_remote_file_url(
            "https://github.com/owner/repo.git",
            "src/a file.rs",
            "feature/x y",
            7,
        )
        .unwrap();
        assert!(url.contains("/blob/feature%2Fx%20y/"), "{url}");
        assert!(url.contains("/src/a%20file.rs#L7"), "{url}");
    }

    /// The pre-fix `trim_git_suffix` did `path[path.len() - 4..]`, which panics
    /// when byte `len - 4` lands inside a codepoint. Reached from the PUBLIC
    /// entry point with a remote URL git itself accepts, so the panic was live.
    #[test]
    fn parses_multibyte_repo_paths_where_the_git_suffix_cut_is_mid_codepoint() {
        // "éabc" is 5 bytes; len - 4 = 1 is the middle of 'é'.
        assert_eq!(
            parse_hosted_remote("https://github.com/owner/éabc"),
            Some(HostedRemote {
                host: "github.com".to_string(),
                path: "owner/éabc".to_string(),
                provider: HostedRemoteProvider::GitHub,
            })
        );
        // Same cut position reached through the scp-like and shorthand forms.
        assert_eq!(
            parse_hosted_remote("git@gitlab.com:owner/日本語x").map(|r| r.path),
            Some("owner/日本語x".to_string())
        );
        assert_eq!(
            parse_hosted_remote("github:owner/😀abc").map(|r| r.path),
            Some("owner/😀abc".to_string())
        );
        // The trim itself still fires for a real `.git`, in any case.
        assert_eq!(
            parse_hosted_remote("https://github.com/owner/éabc.git").map(|r| r.path),
            Some("owner/éabc".to_string())
        );
        assert_eq!(
            parse_hosted_remote("https://github.com/owner/repo.GIT").map(|r| r.path),
            Some("owner/repo".to_string())
        );
    }

    /// Sweep the cut position across a multibyte alphabet: every input must
    /// return, and trimming must agree with a byte-exact `.git` suffix test.
    #[test]
    fn git_suffix_trim_is_total_over_multibyte_paths() {
        let alphabet = [".", "g", "i", "t", "é", "日", "😀"];
        let mut path = String::new();
        for a in alphabet {
            for b in alphabet {
                for c in alphabet {
                    for d in alphabet {
                        path.clear();
                        for part in [a, b, c, d] {
                            path.push_str(part);
                        }
                        let trimmed = trim_git_suffix(&path);
                        let expected = path
                            .len()
                            .checked_sub(4)
                            .and_then(|cut| path.split_at_checked(cut))
                            .filter(|(_, tail)| tail.eq_ignore_ascii_case(".git"))
                            .map_or(path.as_str(), |(head, _)| head);
                        assert_eq!(trimmed, expected, "{path:?}");
                    }
                }
            }
        }
    }
}
