//! Linear deep-link builders, ported from `src/shared/linear-links.ts`.
//!
//! Builds `linear.app` team/settings URLs (percent-encoding path segments) and
//! extracts the workspace url-key from an issue URL. Pure: percent-encoding via
//! `crate::uri_component`, and a minimal host/first-path-segment parse in place
//! of `new URL`.

use crate::js_string::trim_js;
use crate::uri_component::{encode_uri_component, try_decode_uri_component};

/// `https://linear.app/<org>/team/<team>/all`, or `None` if either key is blank.
pub fn build_linear_team_url(organization_url_key: Option<&str>, team_key: Option<&str>) -> Option<String> {
    let organization_url_key = organization_url_key.map(trim_js).filter(|key| !key.is_empty())?;
    let team_key = team_key.map(trim_js).filter(|key| !key.is_empty())?;
    Some(format!(
        "https://linear.app/{}/team/{}/all",
        encode_uri_component(organization_url_key),
        encode_uri_component(team_key)
    ))
}

pub fn build_linear_personal_api_key_settings_url(organization_url_key: Option<&str>) -> String {
    match organization_url_key.map(trim_js).filter(|key| !key.is_empty()) {
        Some(key) => format!("https://linear.app/{}/settings/account/security", encode_uri_component(key)),
        None => "https://linear.app/settings/account/security".to_string(),
    }
}

pub fn build_linear_workspace_api_settings_url(organization_url_key: Option<&str>) -> String {
    match organization_url_key.map(trim_js).filter(|key| !key.is_empty()) {
        Some(key) => format!("https://linear.app/{}/settings/api", encode_uri_component(key)),
        None => "https://linear.app/settings/api".to_string(),
    }
}

/// The workspace url-key (first path segment) from a `linear.app` issue URL, or
/// `None` for a non-Linear host or an unparseable URL.
pub fn get_linear_organization_url_key_from_issue_url(issue_url: Option<&str>) -> Option<String> {
    let (hostname, segments) = parse_absolute_url(issue_url?)?;
    // EXACT, like the twin's `parsed.hostname !== LINEAR_APP_HOSTNAME`. The case
    // fold belongs to `parse_host`, which applies it only where `new URL` does.
    if hostname != "linear.app" {
        return None;
    }
    segments.into_iter().next()
}

/// Parsed Linear issue input: the canonical identifier plus the workspace
/// url-key when the input was a full issue URL. Mirrors `ParsedLinearIssueInput`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedLinearIssueInput {
    pub identifier: String,
    pub organization_url_key: Option<String>,
}

/// Hand-rolled `^[A-Za-z][A-Za-z0-9_]*-\d+$` (no regex crate). Since the prefix
/// class excludes `-` and the suffix is all digits, a valid match has exactly one
/// `-` — the first one splits prefix from the digit run.
fn matches_linear_identifier_pattern(value: &str) -> bool {
    let Some((prefix, suffix)) = value.split_once('-') else {
        return false;
    };
    if suffix.is_empty() || !suffix.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let mut bytes = prefix.bytes();
    match bytes.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The WHATWG "special" schemes. Takes an ALREADY-lowercased scheme — `new URL`
/// ASCII-lowercases the scheme, so `HTTPS` is special and `FOO` is not.
fn is_special_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "ws" | "wss" | "ftp" | "file")
}

/// `new URL`'s two input-cleaning steps, in spec order: strip leading/trailing
/// C0-control-or-space, then remove EVERY tab/LF/CR. Both are exact — without
/// them the scheme check below would refuse `ht<TAB>tps://…`, which the twin
/// parses as `https:` after the removal.
fn clean_url_input(input: &str) -> String {
    input
        .trim_matches(|c: char| c <= '\u{1f}' || c == ' ')
        .chars()
        .filter(|c| !matches!(c, '\u{9}' | '\u{a}' | '\u{d}'))
        .collect()
}

/// The lowercased scheme and the text after its `:`, or `None` when the input
/// has no scheme matching `[A-Za-z][A-Za-z0-9+\-.]*:` — which `new URL` throws
/// on (there is no base URL here). `:` is outside the scheme class, so the first
/// `:` is where the WHATWG scheme scan would stop.
fn split_scheme(input: &str) -> Option<(String, &str)> {
    let colon = input.find(':')?;
    let (scheme, rest) = input.split_at_checked(colon)?;
    let mut bytes = scheme.bytes();
    if !bytes.next().is_some_and(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    if !bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')) {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), rest.get(1..)?))
}

/// The authority text (`None` when this URL shape has no host component) and the
/// path text after it. The three scheme kinds reach an authority differently and
/// the difference is load-bearing: `https:linear.app/x` HAS host `linear.app`
/// (special schemes skip any run of slashes, `\` included) while `file:/x` and
/// `foo:/x` do NOT — file needs exactly two leading slashes, opaque exactly `//`.
fn split_authority<'a>(scheme: &str, special: bool, rest: &'a str) -> (Option<&'a str>, &'a str) {
    let after = if scheme == "file" {
        let bytes = rest.as_bytes();
        // A THIRD slash puts everything back on the path (`file:///x` has no host).
        if bytes.len() < 2 || !matches!(bytes.first(), Some(b'/' | b'\\')) || !matches!(bytes.get(1), Some(b'/' | b'\\')) {
            return (None, rest);
        }
        let Some((_, after)) = rest.split_at_checked(2) else {
            return (None, rest);
        };
        after
    } else if special {
        rest.trim_start_matches(['/', '\\'])
    } else {
        let Some(after) = rest.strip_prefix("//") else {
            // Non-special without `//` is an opaque path — no host at all.
            return (None, rest);
        };
        after
    };
    // `\` terminates the authority only for special schemes; for an opaque host it
    // is a forbidden code point, which `parse_host` rejects.
    let terminators: &[char] = if special { &['/', '\\', '?', '#'] } else { &['/', '?', '#'] };
    let end = after.find(terminators).unwrap_or(after.len());
    match after.split_at_checked(end) {
        Some((authority, path)) => (Some(authority), path),
        None => (None, rest),
    }
}

/// WHATWG "forbidden host code point" — any of these makes `new URL` throw.
fn is_forbidden_host_byte(byte: u8) -> bool {
    matches!(byte, 0x00 | 0x09 | 0x0a | 0x0d | b' ' | b'#' | b'/' | b':' | b'<' | b'>' | b'?' | b'@' | b'[' | b'\\' | b']' | b'^' | b'|')
}

/// A port `new URL` accepts: empty, or ASCII digits that fit in 16 bits (leading
/// zeros are allowed and dropped). Anything else throws, which is a `None` here —
/// the pre-fix core read `https://linear.app:abc/…` as host `linear.app`.
fn is_valid_port(port: &str) -> bool {
    if port.is_empty() {
        return true;
    }
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    port.trim_start_matches('0').len() <= 5 && port.parse::<u32>().is_ok_and(|value| value <= 65_535)
}

/// The `URL.hostname` for an authority, or `None` where `new URL` would throw /
/// where this port cannot answer faithfully.
///
/// The case rule is the whole point: a SPECIAL scheme's host goes through
/// domain-to-ASCII, which lowercases, so `https://LINEAR.APP/…` is `linear.app`;
/// an OPAQUE host is taken verbatim, so `foo://LINEAR.APP/…` stays `LINEAR.APP`
/// and is NOT linear.app. A blanket `eq_ignore_ascii_case` at the call site read
/// the second as Linear and handed its first path segment to the org-key.
fn parse_host(authority: &str, scheme: &str, special: bool) -> Option<String> {
    // Credentials end at the LAST `@`: `https://linear.app@evil.com/` is evil.com.
    let (has_credentials, host_and_port) = match authority.rfind('@') {
        Some(at) => (true, authority.get(at.saturating_add(1)..)?),
        None => (false, authority),
    };
    let (host, port) = match host_and_port.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_and_port, None),
    };
    // A file URL may carry neither credentials nor a port; `new URL` throws on both.
    if scheme == "file" && (has_credentials || port.is_some()) {
        return None;
    }
    if port.is_some_and(|port| !is_valid_port(port)) {
        return None;
    }
    if host.is_empty() {
        return Some(String::new());
    }
    if host.bytes().any(is_forbidden_host_byte) {
        return None;
    }
    if !special {
        // Opaque host: no percent-decoding, no IDNA, NO case folding.
        return Some(host.to_string());
    }
    // Domain-to-ASCII is percent-decode + IDNA + lowercase. Only the lowercase is
    // ported, so refuse any host the other two would rewrite (`linear%2eapp`,
    // `linear。app`) rather than compare a half-mapped one — that refusal is the
    // module's documented residual gap, and it fails CLOSED.
    if !host.is_ascii() || host.contains('%') || host.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// `new URL` stand-in: `URL.hostname` plus the non-empty `URL.pathname` segments,
/// or `None` on the TS `new URL` throw path. Query/hash are excluded, matching
/// `URL.pathname`.
///
/// NOT a full WHATWG port — the residual is percent-decoding + IDNA of a special
/// scheme's host and percent-ENCODING of the pathname. Both are refusals or
/// under-decodings, i.e. this parser accepts a STRICT SUBSET of what `new URL`
/// accepts; it must never accept a host `new URL` would not, because the caller
/// turns "this is linear.app" into a persisted workspace-token selector.
fn parse_absolute_url(input: &str) -> Option<(String, Vec<String>)> {
    let cleaned = clean_url_input(input);
    let (scheme, rest) = split_scheme(&cleaned)?;
    let special = is_special_scheme(&scheme);
    let (authority, path) = split_authority(&scheme, special, rest);
    let hostname = match authority {
        Some(authority) => parse_host(authority, &scheme, special)?,
        None => String::new(),
    };
    // `split_at_checked` is total, so the cut generates no bounds obligation; the
    // offset comes from `find`/`len` and is always a boundary.
    let path_end = path.find(['?', '#']).unwrap_or(path.len());
    let (path, _) = path.split_at_checked(path_end)?;
    // `\` is a path separator only for special schemes (`https://host\a\b`).
    let separators: &[char] = if special { &['/', '\\'] } else { &['/'] };
    let segments = path
        .split(separators)
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect();
    Some((hostname, segments))
}

/// Parse a bare Linear identifier (`ENG-123`) or a `linear.app` issue URL into a
/// canonical (uppercased) identifier plus, for URLs, the workspace url-key.
/// Returns `None` for blank/invalid input or a non-Linear URL.
pub fn parse_linear_issue_input(input: &str) -> Option<ParsedLinearIssueInput> {
    let trimmed = trim_js(input);
    if trimmed.is_empty() {
        return None;
    }
    if matches_linear_identifier_pattern(trimmed) {
        return Some(ParsedLinearIssueInput {
            identifier: trimmed.to_uppercase(),
            organization_url_key: None,
        });
    }
    let (hostname, segments) = parse_absolute_url(trimmed)?;
    // EXACT — see `get_linear_organization_url_key_from_issue_url`. The org key
    // below is persisted and equality-compared to pick a Linear API token, so a
    // widened host check here selects another workspace's token.
    if hostname != "linear.app" {
        return None;
    }
    let organization_url_key = segments.first()?;
    let raw_identifier = segments
        .iter()
        .position(|segment| segment.as_str() == "issue")
        .and_then(|issue_index| segments.get(issue_index.saturating_add(1)))?;
    // Decode then take up to the first `/ ? #`, matching `split(/[/?#]/)[0]`. Both
    // decodes fail CLOSED (`?` -> None) to mirror the TS `decodeURIComponent` throw
    // being caught by the surrounding try/catch (-> null on a malformed %-escape).
    let decoded = try_decode_uri_component(raw_identifier)?;
    let identifier = decoded.split(['/', '?', '#']).next().unwrap_or("");
    if !matches_linear_identifier_pattern(identifier) {
        return None;
    }
    Some(ParsedLinearIssueInput {
        identifier: identifier.to_uppercase(),
        organization_url_key: Some(try_decode_uri_component(organization_url_key)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_team_urls_from_workspace_and_team_keys() {
        assert_eq!(
            build_linear_team_url(Some("acme"), Some("ENG")).unwrap(),
            "https://linear.app/acme/team/ENG/all"
        );
    }

    #[test]
    fn encodes_url_path_segments() {
        assert_eq!(
            build_linear_team_url(Some("acme inc"), Some("A/B")).unwrap(),
            "https://linear.app/acme%20inc/team/A%2FB/all"
        );
    }

    #[test]
    fn extracts_the_workspace_url_key_from_linear_issue_urls() {
        assert_eq!(
            get_linear_organization_url_key_from_issue_url(Some("https://linear.app/acme/issue/ENG-1")),
            Some("acme".to_string())
        );
    }

    #[test]
    fn builds_organization_scoped_api_key_settings_urls() {
        assert_eq!(
            build_linear_personal_api_key_settings_url(Some("acme inc")),
            "https://linear.app/acme%20inc/settings/account/security"
        );
        assert_eq!(
            build_linear_workspace_api_settings_url(Some("acme/inc")),
            "https://linear.app/acme%2Finc/settings/api"
        );
    }

    #[test]
    fn falls_back_to_global_api_settings_urls_when_no_organization_slug() {
        assert_eq!(
            build_linear_personal_api_key_settings_url(None),
            "https://linear.app/settings/account/security"
        );
        assert_eq!(build_linear_workspace_api_settings_url(Some("   ")), "https://linear.app/settings/api");
    }

    #[test]
    fn parses_bare_linear_issue_identifiers() {
        assert_eq!(
            parse_linear_issue_input("eng-123"),
            Some(ParsedLinearIssueInput { identifier: "ENG-123".to_string(), organization_url_key: None })
        );
        // Underscores are allowed in the prefix.
        assert_eq!(
            parse_linear_issue_input("ENG_TEAM-45"),
            Some(ParsedLinearIssueInput { identifier: "ENG_TEAM-45".to_string(), organization_url_key: None })
        );
    }

    #[test]
    fn parses_linear_issue_urls_with_organization_keys() {
        assert_eq!(
            parse_linear_issue_input("https://linear.app/acme/issue/eng-123/fix-auth"),
            Some(ParsedLinearIssueInput {
                identifier: "ENG-123".to_string(),
                organization_url_key: Some("acme".to_string()),
            })
        );
        assert_eq!(
            parse_linear_issue_input("https://linear.app/stably/issue/STA-335/test-issue"),
            Some(ParsedLinearIssueInput {
                identifier: "STA-335".to_string(),
                organization_url_key: Some("stably".to_string()),
            })
        );
        // The org url-key is percent-decoded.
        assert_eq!(
            parse_linear_issue_input("https://linear.app/acme%20inc/issue/ENG-9"),
            Some(ParsedLinearIssueInput {
                identifier: "ENG-9".to_string(),
                organization_url_key: Some("acme inc".to_string()),
            })
        );
    }

    #[test]
    fn rejects_non_linear_and_invalid_issue_input() {
        assert_eq!(parse_linear_issue_input("https://example.com/acme/issue/ENG-123"), None);
        assert_eq!(parse_linear_issue_input("not an issue"), None);
        assert_eq!(parse_linear_issue_input(""), None);
        // Bare-looking but invalid identifiers aren't URLs either.
        assert_eq!(parse_linear_issue_input("ENG-"), None);
        assert_eq!(parse_linear_issue_input("ENG-1-2"), None);
    }

    /// The org key these return is PERSISTED and equality-compared to pick a
    /// Linear API token, so every case here is a wrong-workspace outcome, not a
    /// cosmetic parse difference. Each was ACCEPTED by the pre-2026-08-16 core.
    #[test]
    fn refuses_every_host_the_twin_refuses() {
        for input in [
            // Text before the URL is not a scheme; `new URL` throws.
            "see https://linear.app/evil/issue/ENG-1",
            "1https://linear.app/evil/issue/ENG-1",
            "h_ttps://linear.app/evil/issue/ENG-1",
            // Opaque (non-special) hosts are NOT case-folded by `new URL`.
            "foo://LINEAR.APP/evil/issue/ENG-1",
            "FOO://Linear.App/evil/issue/ENG-1",
            // A file URL may carry neither a port nor credentials.
            "file://linear.app:443/evil/issue/ENG-1",
            "file://user@linear.app/evil/issue/ENG-1",
            // An unparseable or out-of-range port throws.
            "https://linear.app:abc/evil/issue/ENG-1",
            "https://linear.app:65536/evil/issue/ENG-1",
            // Credentials end at the LAST `@`, so the host here is evil.com.
            "https://linear.app@evil.com/evil/issue/ENG-1",
            // `\` is a forbidden opaque-host code point and not a separator.
            "foo://linear.app\\evil\\issue\\ENG-1",
            // A third slash leaves a file URL with an empty host.
            "file:///linear.app/evil/issue/ENG-1",
            // A non-special scheme needs exactly `//` to reach a host.
            "foo:/linear.app/evil/issue/ENG-1",
        ] {
            assert_eq!(parse_linear_issue_input(input), None, "must refuse {input:?}");
            assert_eq!(
                get_linear_organization_url_key_from_issue_url(Some(input)),
                None,
                "must refuse {input:?}"
            );
        }
    }

    /// The other side of the same rule — narrowing the host check must not cost
    /// any shape `new URL` really does read as linear.app.
    #[test]
    fn still_accepts_every_host_the_twin_accepts() {
        for input in [
            // Special schemes lowercase the host, and reach it through ANY run of
            // slashes (backslashes included) — or none at all.
            "HTTPS://LINEAR.APP/acme/issue/ENG-1",
            "https:linear.app/acme/issue/ENG-1",
            "https:////linear.app/acme/issue/ENG-1",
            "https:/\\linear.app/acme/issue/ENG-1",
            "https://linear.app:65535/acme/issue/ENG-1",
            "https://evil.com@linear.app/acme/issue/ENG-1",
            "file://linear.app/acme/issue/ENG-1",
            // A lowercase opaque host IS linear.app, port and all.
            "foo://linear.app/acme/issue/ENG-1",
            "foo://linear.app:80/acme/issue/ENG-1",
            // `new URL` removes tab/LF/CR anywhere and strips leading C0 controls,
            // both BEFORE the scheme is read.
            "ht\ttps://linear.app/acme/issue/ENG-1",
            "\u{1}https://linear.app/acme/issue/ENG-1",
            "https://lin\rear.app/acme/issue/ENG-1",
        ] {
            assert_eq!(
                parse_linear_issue_input(input),
                Some(ParsedLinearIssueInput {
                    identifier: "ENG-1".to_string(),
                    organization_url_key: Some("acme".to_string()),
                }),
                "must accept {input:?}"
            );
            assert_eq!(
                get_linear_organization_url_key_from_issue_url(Some(input)),
                Some("acme".to_string()),
                "must accept {input:?}"
            );
        }
    }

    /// The residual: domain-to-ASCII is percent-decode + IDNA + lowercase and only
    /// the lowercase is ported, so a host the other two would rewrite is REFUSED
    /// rather than guessed at. Pinned so the direction stays fail-closed — a
    /// future IDNA port turns these into accepts, never the reverse.
    #[test]
    fn refuses_hosts_that_need_domain_to_ascii_rather_than_guessing() {
        assert_eq!(parse_linear_issue_input("https://linear%2eapp/evil/issue/ENG-1"), None);
        assert_eq!(parse_linear_issue_input("https://linear\u{3002}app/evil/issue/ENG-1"), None);
    }
}
