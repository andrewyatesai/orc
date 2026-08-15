//! Native OpenCode terminal-title recognition, ported from
//! `src/shared/opencode-terminal-title.ts`.
//!
//! Twin: `/^(?:[^|\s]+ \| )?OC\s*\|\s*\S/u` tested against `title?.trim() ?? ''`.
//! ECMAScript `\s` is exactly the `String.prototype.trim` set, so
//! [`is_js_trim_ws`] doubles as the `\s` class — Rust's `char::is_whitespace`
//! would diverge on U+FEFF (JS-only) and U+0085 (Rust-only).
//!
//! Matched by hand rather than by a regex engine because the crate is zero-dep;
//! the pattern needs no backtracking, since every quantifier here is followed by
//! a literal outside its own character class (`[^|\s]+` by a space, `\s*` by `|`
//! and by `\S`), so the greedy run is always the only candidate.

use crate::js_string::{is_js_trim_ws, trim_js};

pub fn is_opencode_native_title(title: Option<&str>) -> bool {
    let trimmed = trim_js(title.unwrap_or(""));
    starts_with_oc_marker(trimmed)
        || strip_multiplexer_prefix(trimmed).is_some_and(starts_with_oc_marker)
}

pub fn is_meaningful_opencode_terminal_title(title: Option<&str>) -> bool {
    is_opencode_native_title(title)
}

/// `OC\s*\|\s*\S` — case-sensitive marker, and something after the pipe.
fn starts_with_oc_marker(value: &str) -> bool {
    let Some(after_marker) = value.strip_prefix("OC") else {
        return false;
    };
    let Some(after_pipe) = after_marker
        .trim_start_matches(is_js_trim_ws)
        .strip_prefix('|')
    else {
        return false;
    };
    !after_pipe.trim_start_matches(is_js_trim_ws).is_empty()
}

/// `[^|\s]+ \| ` — one single-token multiplexer frame (`tmux | …`), or `None`.
fn strip_multiplexer_prefix(value: &str) -> Option<&str> {
    let token_len = value.find(|c: char| c == '|' || is_js_trim_ws(c))?;
    if token_len == 0 {
        return None; // `+` needs at least one token char.
    }
    value.get(token_len..)?.strip_prefix(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim from `src/shared/opencode-terminal-title.test.ts`.
    #[test]
    fn recognizes_native_session_titles() {
        assert!(is_meaningful_opencode_terminal_title(Some(
            "OC | Native Stable Session"
        )));
        assert!(is_meaningful_opencode_terminal_title(Some("  OC|Session  ")));
        assert!(is_opencode_native_title(Some(
            "OC | Understand about the plugin"
        )));
        assert!(is_opencode_native_title(Some("tmux | OC | ses_123")));
    }

    #[test]
    fn rejects_generic_incomplete_embedded_and_lookalike_titles() {
        assert!(!is_meaningful_opencode_terminal_title(Some("OpenCode")));
        assert!(!is_meaningful_opencode_terminal_title(Some("OpenCode ready")));
        assert!(!is_meaningful_opencode_terminal_title(Some("OC |")));
        assert!(!is_meaningful_opencode_terminal_title(None));
        // Why: lowercase is not OpenCode's native marker; avoid "oc |" cwd/task noise.
        assert!(!is_opencode_native_title(Some(
            "oc | Understand about the plugin"
        )));
        // Why: mid-title OC must not steal another agent's braille/task frame.
        assert!(!is_opencode_native_title(Some("⠋ Fix foo | OC | bar")));
        assert!(!is_opencode_native_title(Some("my session | OC | task")));
    }

    // Beyond the twin's file: regex corners the hand-rolled matcher could get
    // wrong, each answer taken from the pattern itself.
    #[test]
    fn matches_the_regex_on_separator_and_prefix_corners() {
        // `\s*` around the pipe is optional on both sides and multi-character.
        assert!(is_opencode_native_title(Some("OC|x")));
        assert!(is_opencode_native_title(Some("OC \t | \t x")));
        assert!(is_opencode_native_title(Some("OC  |  x")));
        assert!(is_opencode_native_title(Some("tmux | OC|x")));
        // The prefix separator is the literal " | ", not any whitespace run.
        assert!(!is_opencode_native_title(Some("tmux\t| OC | x")));
        assert!(!is_opencode_native_title(Some("tmux  |  OC | x")));
        // `[^|\s]+` needs one char, and only one frame is allowed.
        assert!(!is_opencode_native_title(Some(" | OC | x")));
        assert!(!is_opencode_native_title(Some("a | b | OC | x")));
        // Multi-byte prefixes: the token boundary is a byte index into UTF-8.
        assert!(is_opencode_native_title(Some("⠋x | OC | y")));
        assert!(is_opencode_native_title(Some("日本 | OC | x")));
        assert!(!is_opencode_native_title(Some("日本|OC | x")));
        // U+3000 is a Zs space, so JS `\s*` skips it between marker and pipe.
        assert!(is_opencode_native_title(Some("OC\u{3000}| x")));
        // Only the leading position counts.
        assert!(!is_opencode_native_title(Some("run OC | x")));
        assert!(!is_opencode_native_title(Some("oc | x")));
        // Empty/blank never matches; JS trim decides what blank means.
        assert!(!is_opencode_native_title(Some("")));
        assert!(!is_opencode_native_title(Some("   ")));
        assert!(is_opencode_native_title(Some("\u{FEFF}OC | x")));
        // U+0085 is in neither the JS trim set nor JS `\s`, so it is neither
        // trimmed off the front nor skipped between marker and pipe.
        assert!(!is_opencode_native_title(Some("\u{85}OC | x")));
        assert!(!is_opencode_native_title(Some("OC\u{85}| x")));
        // A trailing pipe with only whitespace after it fails `\S`.
        assert!(!is_opencode_native_title(Some("OC |   ")));
    }
}
