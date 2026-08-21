//! Terminal-title agent classification, ported from
//! `src/shared/terminal-title-agent-type.ts` and its byte-identical twin
//! `src/shared/agent-title-identity.ts`.
//!
//! ONE ladder, ported once. The TS carries two copies of `getAgentLabel` /
//! `isClaudeAgent` (verified identical at HEAD apart from comments and an
//! `if (c) { return true } return false` vs `return c` reshaping); both TS
//! surfaces map onto the functions here, and the parity harness drives both.
//!
//! # Why this crosses the seam as a classifier, not as predicates
//!
//! The callers ask ONE question — "which agent is this title?" — and the TS
//! answers it with a 10-to-12 call ladder of `titleHasAgentName`. Crossing the
//! predicate would cost ~12 seam round trips per title event (28.1 ns of TS body
//! vs 1810.9 ns of wasm seam), so [`get_agent_label`],
//! [`resolve_terminal_title_agent_type`] and
//! [`resolve_explicit_terminal_title_agent_type`] are the crossing points and
//! everything below them stays in Rust.
//!
//! # ORDER IS THE SEMANTICS
//!
//! Four orderings decide outcomes; none may be "tidied":
//!
//! 1. [`get_agent_label`]: management-null → OpenCode marker → Claude prefix →
//!    Gemini → Pi/OMP synthetic → Pi legacy → name tokens → Cursor closed set →
//!    Droid → Hermes → [`is_claude_agent`] → `None`. `is_claude_agent`'s spinner
//!    rule claims essentially every spinner-bearing title, so it MUST stay last.
//! 2. [`is_claude_agent`]: empty/management/OpenCode veto → `✳` → `". "`/`"* "` →
//!    spinner (TERMINAL — returns from inside, never falls through to the
//!    `claude`-token rung) → trim-start + `claude` prefix AND token.
//! 3. [`is_gemini_terminal_title`]: glyphs → Pi VETO (returns false) → token.
//! 4. [`resolve_explicit_terminal_title_agent_type`]: full ladder, and only then
//!    the Claude-generic-status suppressor.
//!
//! # JS-vs-Rust traps this port is written against
//!
//! * ECMAScript `\s` = the `String.prototype.trim` set: it INCLUDES U+FEFF and
//!   EXCLUDES U+0085 — Rust's `char::is_whitespace` is inverted on exactly those
//!   two. Every `\s`, `\s*`, `\s+`, `.trim()` and `.trimStart()` here goes
//!   through [`crate::js_string::is_js_trim_ws`], never `str::trim`.
//! * JS `.` (no `s` flag) excludes four line terminators; Rust's excludes only
//!   `\n`. See [`is_js_line_terminator`].
//! * The regex `i` flag on a non-`u` regex is ASCII-only folding (U+212A KELVIN
//!   does NOT fold to `k`), but `String.prototype.toLowerCase()` is full Unicode
//!   folding. Both appear in this module and must NOT be unified: regex sites use
//!   [`strip_prefix_ascii_ci`], `.toLowerCase()` sites use `str::to_lowercase`.
//! * Rust's `regex` crate has no lookbehind, and `orca-core` is zero-dependency
//!   anyway — every pattern here is hand-rolled, and the token boundary guard is
//!   reused from [`crate::agent_recognition`] rather than re-derived.
//! * `if (title)` is JS truthiness on a `string`: true only for `""`. That is
//!   `title.is_empty()`, NOT "blank after trim".

use crate::agent_recognition::{
    title_has_agent_name, title_has_agy, title_has_droid, title_has_hermes,
};
use crate::js_string::is_js_trim_ws;

/// Claude Code's idle status prefix glyph (U+2733 EIGHT SPOKED ASTERISK).
pub const CLAUDE_IDLE: char = '\u{2733}';

/// Gemini CLI "working" OSC glyph (U+2726 BLACK FOUR POINTED STAR).
pub const GEMINI_WORKING: char = '\u{2726}';
/// Gemini CLI "silent working" glyph (U+23F2 TIMER CLOCK).
pub const GEMINI_SILENT_WORKING: char = '\u{23F2}';
/// Gemini CLI "idle" glyph (U+25C7 WHITE DIAMOND).
pub const GEMINI_IDLE: char = '\u{25C7}';
/// Gemini CLI "permission required" glyph (U+270B RAISED HAND).
pub const GEMINI_PERMISSION: char = '\u{270B}';

/// OpenCode's own status glyph (U+25A3 WHITE SQUARE CONTAINING BLACK SMALL SQUARE).
const OPENCODE_STATUS_GLYPH: char = '\u{25A3}';

const CURSOR_NATIVE_TITLE_LOWER: &str = "cursor agent";

/// Windows launcher extensions accepted after a `claude` command word.
const CLAUDE_COMMAND_SUFFIXES: &[&str] = &[".exe", ".cmd", ".bat", ".ps1"];

/// `getAgentLabel`'s label → `TuiAgent` id map, in TS source order. Total over
/// the ladder's 16-value range; an unmapped label must yield `None`, never a
/// default agent, so this stays a lookup and never gains a catch-all arm.
pub const TITLE_LABEL_TO_AGENT: &[(&str, &str)] = &[
    ("Claude Code", "claude"),
    ("OpenClaude", "openclaude"),
    ("Codex", "codex"),
    ("Gemini CLI", "gemini"),
    ("GitHub Copilot", "copilot"),
    ("Grok", "grok"),
    ("Devin", "devin"),
    ("Antigravity", "antigravity"),
    ("OpenCode", "opencode"),
    ("MiMo Code", "mimo-code"),
    ("Aider", "aider"),
    ("Cursor", "cursor"),
    ("Droid", "droid"),
    ("Hermes", "hermes"),
    ("Pi", "pi"),
    ("OMP", "omp"),
];

// ---------------------------------------------------------------------------
// JS string primitives
// ---------------------------------------------------------------------------

/// ECMAScript regex `\s`. Identical to the `String.prototype.trim` set, so the
/// existing JS-trim predicate is the right class — Rust's `char::is_whitespace`
/// is NOT (it drops U+FEFF and adds U+0085).
fn is_js_ws(c: char) -> bool {
    is_js_trim_ws(c)
}

/// The four characters ECMAScript `.` never matches without the `s` flag. Rust's
/// `.` excludes only `\n`, so any `.`-derived scan must use this explicitly.
fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trimStart` (and the greedy head of a `^\s*`).
fn trim_start_js(value: &str) -> &str {
    value.trim_start_matches(is_js_trim_ws)
}

/// `String.prototype.trim`.
fn trim_js(value: &str) -> &str {
    value.trim_matches(is_js_trim_ws)
}

/// Strip `prefix` from `value` folding ASCII case ONLY — the ECMAScript `i` flag
/// on a non-`u` regex refuses non-ASCII→ASCII folds, so U+212A KELVIN must not
/// match `k` and U+017F LONG S must not match `s`.
fn strip_prefix_ascii_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let mut cursor = value.char_indices();
    for expected in prefix.chars() {
        let (_, actual) = cursor.next()?;
        if !actual.eq_ignore_ascii_case(&expected) {
            return None;
        }
    }
    Some(cursor.as_str())
}

/// True when `rest` starts with one or more JS-whitespace chars; returns the
/// remainder past the whole run. `\s+` is always followed by a non-whitespace
/// literal in this module, so the greedy run is the only candidate — no
/// backtracking is reachable.
fn strip_ws_run(rest: &str) -> Option<&str> {
    let after = trim_start_js(rest);
    if after.len() == rest.len() {
        None
    } else {
        Some(after)
    }
}

// ---------------------------------------------------------------------------
// Spinner glyphs
// ---------------------------------------------------------------------------

fn is_braille_spinner_char(c: char) -> bool {
    ('\u{2800}'..='\u{28FF}').contains(&c)
}

fn is_quarter_circle_spinner_char(c: char) -> bool {
    ('\u{25D0}'..='\u{25D3}').contains(&c)
}

/// `containsBrailleSpinner` — the full Braille Patterns block, inclusive at both
/// ends. The TS iterates CODE POINTS (`for…of` + `codePointAt(0)`), which
/// `chars()` twins exactly; a byte scan can never see 0x2800..0x28FF and would
/// always answer false.
pub fn contains_braille_spinner(title: &str) -> bool {
    title.chars().any(is_braille_spinner_char)
}

/// `containsQuarterCircleSpinner` — U+25D0..U+25D3, Claude Code 2.1.228's busy
/// frames.
pub fn contains_quarter_circle_spinner(title: &str) -> bool {
    title.chars().any(is_quarter_circle_spinner_char)
}

/// `containsAgentSpinnerGlyph` — any frame glyph an agent animates its OSC title
/// with. Agent-specific frame shapes (Grok, Pi, synthetic Cursor) stay pinned to
/// braille only.
pub fn contains_agent_spinner_glyph(title: &str) -> bool {
    contains_braille_spinner(title) || contains_quarter_circle_spinner(title)
}

// ---------------------------------------------------------------------------
// `claude agents` management title
// ---------------------------------------------------------------------------

/// `CLAUDE_MANAGEMENT_TITLE_RE`:
/// `^\s*(?:"CMD"|'CMD'|CMD)\s+agents\s*$` (flag `i` only), where
/// `CMD = (?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?`.
///
/// The leading `^\s*` is taken greedily, which is exact: every alternative
/// continues with `"`, `'`, `claude`, or a path prefix whose `.*` cannot cross a
/// line terminator, and none of those is whitespace — so a shorter whitespace
/// prefix can never rescue a failed maximal one.
pub fn is_claude_management_title(title: &str) -> bool {
    let head = trim_start_js(title);
    for quote in ['"', '\''] {
        if let Some(body) = head.strip_prefix(quote) {
            if claude_command_then_agents(body, Some(quote)) {
                return true;
            }
        }
    }
    claude_command_then_agents(head, None)
}

/// `CMD` followed by the optional closing quote and `\s+agents\s*$`.
fn claude_command_then_agents(body: &str, closing_quote: Option<char>) -> bool {
    // `(?:.*[\\/])?` omitted entirely.
    if claude_word_at(body, 0, closing_quote) {
        return true;
    }
    // `(?:.*[\\/])?` present: the word may start just past any `/` or `\` that
    // the `.*` can reach — and `.` stops at a line terminator.
    for (idx, ch) in body.char_indices() {
        if is_js_line_terminator(ch) {
            break;
        }
        if (ch == '/' || ch == '\\') && claude_word_at(body, idx.saturating_add(ch.len_utf8()), closing_quote) {
            return true;
        }
    }
    false
}

fn claude_word_at(body: &str, start: usize, closing_quote: Option<char>) -> bool {
    let Some(rest) = body.get(start..) else {
        return false;
    };
    let Some(after_word) = strip_prefix_ascii_ci(rest, "claude") else {
        return false;
    };
    // `(?:\.(?:exe|cmd|bat|ps1))?` is greedy; JS backtracks to the no-suffix
    // branch when the tail fails, so both are tried.
    for suffix in CLAUDE_COMMAND_SUFFIXES {
        if let Some(after_suffix) = strip_prefix_ascii_ci(after_word, suffix) {
            if agents_tail(after_suffix, closing_quote) {
                return true;
            }
        }
    }
    agents_tail(after_word, closing_quote)
}

fn agents_tail(rest: &str, closing_quote: Option<char>) -> bool {
    let rest = match closing_quote {
        Some(quote) => match rest.strip_prefix(quote) {
            Some(after) => after,
            None => return false,
        },
        None => rest,
    };
    let Some(after_ws) = strip_ws_run(rest) else {
        return false;
    };
    let Some(tail) = strip_prefix_ascii_ci(after_ws, "agents") else {
        return false;
    };
    trim_start_js(tail).is_empty()
}

// ---------------------------------------------------------------------------
// OpenCode native marker
// ---------------------------------------------------------------------------

/// `OPENCODE_NATIVE_TITLE_RE`:
/// `^\s*(?:(?![▣⠀-⣿])[^|]+? \| )?(?:[▣⠀-⣿] )?OC \|[ \t]+\S` (flag `u` only, so
/// CASE-SENSITIVE), tested via `title ? RE.test(title) : false`.
///
/// The optional wrapper's `[^|]+?` also matches whitespace, so unlike every other
/// `^\s*` in this module the leading run is genuinely ambiguous: `"   | OC | x"`
/// matches only when `\s*` gives two of its three spaces back to `[^|]+?`. Every
/// split of the leading whitespace run is therefore tried.
pub fn is_opencode_native_title(title: Option<&str>) -> bool {
    // TS `title ? … : false` is JS truthiness on `string | null | undefined`:
    // absent and empty are the same answer, and the value is NOT pre-trimmed.
    let Some(title) = title else {
        return false;
    };
    if title.is_empty() {
        return false;
    }
    let mut rest = title;
    loop {
        if opencode_after_leading_ws(rest) {
            return true;
        }
        let mut cursor = rest.chars();
        match cursor.next() {
            Some(c) if is_js_ws(c) => rest = cursor.as_str(),
            _ => return false,
        }
    }
}

/// `isMeaningfulOpenCodeTerminalTitle` — an exact alias of
/// [`is_opencode_native_title`] in the TS, kept as an alias here. The names
/// answer different questions ("is this OpenCode's marker?" vs "is this live
/// title worth keeping?") and have disjoint consumer sets; the TS one is
/// fallback-load-bearing and must not be deleted or routed through the seam.
pub fn is_meaningful_opencode_terminal_title(title: Option<&str>) -> bool {
    is_opencode_native_title(title)
}

fn is_opencode_leading_glyph(c: char) -> bool {
    c == OPENCODE_STATUS_GLYPH || is_braille_spinner_char(c)
}

fn opencode_after_leading_ws(rest: &str) -> bool {
    if opencode_glyph_then_marker(rest) {
        return true;
    }
    // `(?![▣⠀-⣿])` — the wrapper cannot itself start with a glyph, so a
    // spinner-led task from another agent (`⠋ Fix foo | OC | …`) never
    // masquerades as a wrapper frame.
    if rest.chars().next().is_some_and(is_opencode_leading_glyph) {
        return false;
    }
    // `[^|]+? \| ` — laziness cannot change a boolean, so enumerate the splits.
    for (idx, ch) in rest.char_indices() {
        if ch == '|' {
            return false;
        }
        let after = idx.saturating_add(ch.len_utf8());
        let Some(tail) = rest.get(after..) else {
            return false;
        };
        if let Some(remainder) = tail.strip_prefix(" | ") {
            if opencode_glyph_then_marker(remainder) {
                return true;
            }
        }
    }
    false
}

fn opencode_glyph_then_marker(rest: &str) -> bool {
    if opencode_marker(rest) {
        return true;
    }
    // `(?:[▣⠀-⣿] )?` — exactly one glyph and exactly one ASCII space.
    let mut cursor = rest.chars();
    if cursor.next().is_some_and(is_opencode_leading_glyph) {
        if let Some(after_glyph) = cursor.as_str().strip_prefix(' ') {
            return opencode_marker(after_glyph);
        }
    }
    false
}

/// `OC \|[ \t]+\S` — case-sensitive `OC`, the literal spaced pipe OpenCode
/// emits, then at least one space/tab and one non-whitespace char.
fn opencode_marker(rest: &str) -> bool {
    let Some(after_marker) = rest.strip_prefix("OC |") else {
        return false;
    };
    let after_gap = after_marker.trim_start_matches([' ', '\t']);
    if after_gap.len() == after_marker.len() {
        return false;
    }
    // `[ \t]+` is greedy and exact: giving a char back lands on a space or tab,
    // which `\S` rejects.
    after_gap.chars().next().is_some_and(|c| !is_js_ws(c))
}

// ---------------------------------------------------------------------------
// Cursor closed title set
// ---------------------------------------------------------------------------

/// `isCursorAgentTitle`. A CLOSED SET — `cursor` is ordinary editor vocabulary,
/// so this is deliberately not a name-token match and must never become one.
///
/// The three literals are compared against the FULL-Unicode-lowercased trimmed
/// title; the synthetic spinner form is compared against the TRIMMED (not
/// lowercased) title and is case-sensitive with exactly one braille char and
/// exactly one ASCII space.
pub fn is_cursor_agent_title(title: Option<&str>) -> bool {
    // TS `typeof title !== 'string'` — `""` is a string and falls through.
    let Some(title) = title else {
        return false;
    };
    let trimmed = trim_js(title);
    let lower = trimmed.to_lowercase();
    if lower == CURSOR_NATIVE_TITLE_LOWER
        || lower == "cursor ready"
        || lower == "cursor - action required"
    {
        return true;
    }
    let mut cursor = trimmed.chars();
    cursor.next().is_some_and(is_braille_spinner_char) && cursor.as_str() == " Cursor Agent"
}

/// `isCursorNativeAgentTitle` — the bare native literal only, no spinner
/// allowance.
pub fn is_cursor_native_agent_title(title: &str) -> bool {
    trim_js(title).to_lowercase() == CURSOR_NATIVE_TITLE_LOWER
}

// ---------------------------------------------------------------------------
// Pi / OMP
// ---------------------------------------------------------------------------

/// `LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?π(?:\s*[-:]|\s)\s*.*$/u`.
///
/// Flags are `u` only — NO `i`, so only U+03C0 π matches and U+03A0 Π does not.
/// The delimiter after π is REQUIRED (bare `"π"` is false, `"π "` is true).
pub fn is_legacy_pi_compatible_title(title: &str) -> bool {
    let head = trim_start_js(title);
    if pi_delimited_body(head) {
        return true;
    }
    // `(?:[⠀-⣿]\s+)?` — EXACTLY one braille char, then one or more whitespace.
    let mut cursor = head.chars();
    if cursor.next().is_some_and(is_braille_spinner_char) {
        if let Some(after_ws) = strip_ws_run(cursor.as_str()) {
            return pi_delimited_body(after_ws);
        }
    }
    false
}

fn pi_delimited_body(rest: &str) -> bool {
    let Some(after_pi) = rest.strip_prefix('\u{03C0}') else {
        return false;
    };
    // `(?:\s*[-:]|\s)` — alternative 1: optional whitespace then `-` or `:`.
    if let Some(tail) = trim_start_js(after_pi).strip_prefix(['-', ':']) {
        if pi_payload(tail) {
            return true;
        }
    }
    // Alternative 2: exactly ONE whitespace char.
    let mut cursor = after_pi.chars();
    if cursor.next().is_some_and(is_js_ws) {
        return pi_payload(cursor.as_str());
    }
    false
}

/// `\s*.*$` with no `s` and no `m` flag: `\s*` may absorb line terminators but
/// `.*` may not, and `$` is end-of-input. So every line terminator must sit
/// inside the leading whitespace run.
fn pi_payload(rest: &str) -> bool {
    !trim_start_js(rest).chars().any(is_js_line_terminator)
}

/// `isPiAgentTitle` — IDENTITY ("this pane is Pi/OMP, spinning or not").
pub fn is_pi_agent_title(title: &str) -> bool {
    is_legacy_pi_compatible_title(title)
}

/// `isPiTerminalTitle` — IDENTITY AND SETTLED. Distinct from
/// [`is_pi_agent_title`] by the spinner veto; the Gemini ladder uses the
/// IDENTITY one, and swapping them lets a spinning Pi title fall through to the
/// `gemini` token check.
pub fn is_pi_terminal_title(title: &str) -> bool {
    is_legacy_pi_compatible_title(title) && !contains_braille_spinner(title)
}

/// `PI_COMPATIBLE_SYNTHETIC_TITLE_RE`:
/// `^\s*(?:[⠀-⣿]\s+)?(pi|omp)(?:\s+-\s+action required|\s+(?:ready|idle|done))?\s*$`
/// (flag `i` only). Capture group 1 decides the label. THE ONLY producer of
/// `"OMP"` in the whole ladder — collapsing this into `is_pi_agent_title`
/// silently deletes the OMP identity path.
pub fn get_pi_compatible_synthetic_agent_label(title: &str) -> Option<&'static str> {
    let head = trim_start_js(title);
    if let Some(label) = pi_synthetic_name(head) {
        return Some(label);
    }
    let mut cursor = head.chars();
    if cursor.next().is_some_and(is_braille_spinner_char) {
        if let Some(after_ws) = strip_ws_run(cursor.as_str()) {
            return pi_synthetic_name(after_ws);
        }
    }
    None
}

fn pi_synthetic_name(rest: &str) -> Option<&'static str> {
    // Alternation order preserved from the TS; `pi` and `omp` are disjoint on
    // their first letter, so at most one can ever match.
    for (needle, label) in [("pi", "Pi"), ("omp", "OMP")] {
        if let Some(after_name) = strip_prefix_ascii_ci(rest, needle) {
            if pi_synthetic_status_tail(after_name) {
                return Some(label);
            }
        }
    }
    None
}

fn pi_synthetic_status_tail(rest: &str) -> bool {
    if let Some(after_ws) = strip_ws_run(rest) {
        // `\s+-\s+action required`
        if let Some(after_dash) = after_ws.strip_prefix('-') {
            if let Some(after_gap) = strip_ws_run(after_dash) {
                if let Some(tail) = strip_prefix_ascii_ci(after_gap, "action required") {
                    if trim_start_js(tail).is_empty() {
                        return true;
                    }
                }
            }
        }
        // `\s+(?:ready|idle|done)`
        for word in ["ready", "idle", "done"] {
            if let Some(tail) = strip_prefix_ascii_ci(after_ws, word) {
                if trim_start_js(tail).is_empty() {
                    return true;
                }
            }
        }
    }
    // The whole status group is optional; `\s*$` still has to hold.
    trim_start_js(rest).is_empty()
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/// `isGeminiTerminalTitle`. THREE steps, and the Pi veto sits BETWEEN the glyph
/// evidence and the name token — hoisting it loses `"π - ✦ building"`, sinking
/// it loses `"π - run gemini now"`.
pub fn is_gemini_terminal_title(title: &str) -> bool {
    if title.contains(GEMINI_PERMISSION)
        || title.contains(GEMINI_WORKING)
        || title.contains(GEMINI_SILENT_WORKING)
        || title.contains(GEMINI_IDLE)
    {
        return true;
    }
    if is_pi_agent_title(title) {
        return false;
    }
    title_has_agent_name(title, "gemini")
}

// ---------------------------------------------------------------------------
// Grok working frames
// ---------------------------------------------------------------------------

/// `isGrokRotatingWorkingTitle`. The spinner gate is logically redundant (both
/// frame shapes are anchored on a braille run) but is kept for shape fidelity.
pub fn is_grok_rotating_working_title(title: &str) -> bool {
    if !contains_braille_spinner(title) {
        return false;
    }
    grok_rotating_frame(title) || grok_collapsed_working_title(title)
}

fn strip_braille_run(title: &str) -> Option<&str> {
    let rest = title.trim_start_matches(is_braille_spinner_char);
    if rest.len() == title.len() {
        None
    } else {
        Some(rest)
    }
}

/// `^[⠀-⣿]+\s+-\s+[\s\S]+?\s-\s+grok\s*$` (flag `i`).
fn grok_rotating_frame(title: &str) -> bool {
    let Some(after_spinner) = strip_braille_run(title) else {
        return false;
    };
    let Some(after_ws) = strip_ws_run(after_spinner) else {
        return false;
    };
    let Some(after_dash) = after_ws.strip_prefix('-') else {
        return false;
    };
    // `\s+[\s\S]+?` — the lazy middle matches ANY char, so the `\s+` before it is
    // the one quantifier here that genuinely backtracks. The constraint reduces
    // to: at least one leading whitespace char, and at least one more char before
    // the identity tail.
    if !after_dash.chars().next().is_some_and(is_js_ws) {
        return false;
    }
    for (char_index, (byte_index, _)) in after_dash.char_indices().enumerate() {
        if char_index < 2 {
            continue;
        }
        let Some(tail) = after_dash.get(byte_index..) else {
            return false;
        };
        if grok_identity_tail(tail) {
            return true;
        }
    }
    false
}

/// `\s-\s+grok\s*$` — note the deliberate asymmetry: EXACTLY ONE whitespace char
/// on the left of the hyphen, one or more on the right.
fn grok_identity_tail(rest: &str) -> bool {
    let mut cursor = rest.chars();
    if !cursor.next().is_some_and(is_js_ws) {
        return false;
    }
    let Some(after_dash) = cursor.as_str().strip_prefix('-') else {
        return false;
    };
    let Some(after_ws) = strip_ws_run(after_dash) else {
        return false;
    };
    let Some(tail) = strip_prefix_ascii_ci(after_ws, "grok") else {
        return false;
    };
    trim_start_js(tail).is_empty()
}

/// `^[⠀-⣿]+\s+grok\s*$` (flag `i`) — keeps Orca's own collapsed `"⠋ Grok"` label
/// idempotent under re-normalization.
fn grok_collapsed_working_title(title: &str) -> bool {
    let Some(after_spinner) = strip_braille_run(title) else {
        return false;
    };
    let Some(after_ws) = strip_ws_run(after_spinner) else {
        return false;
    };
    let Some(tail) = strip_prefix_ascii_ci(after_ws, "grok") else {
        return false;
    };
    trim_start_js(tail).is_empty()
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/// `isClaudeAgent` — the five-stage ladder shared verbatim by
/// `terminal-title-agent-type.ts` and `agent-title-identity.ts`.
pub fn is_claude_agent(title: &str) -> bool {
    // C0: `!title` is JS falsiness on a `string` — TRUE ONLY for `""`. A
    // whitespace-only title is truthy and proceeds.
    if title.is_empty() || is_claude_management_title(title) || is_opencode_native_title(Some(title))
    {
        return false;
    }
    // Computed unconditionally in the TS right after C0, read only in C3.
    // FULL Unicode lowercase (`String.prototype.toLowerCase`), not ASCII folding.
    let lower = title.to_lowercase();

    // C1: the `✳` prefix (glyph + one ASCII space) or the bare glyph. No trim.
    if starts_with_claude_idle_prefix(title) || is_bare_claude_idle(title) {
        return true;
    }
    // C2: `". "` (working) and `"* "` (idle). The trailing space is required.
    if title.starts_with(". ") || title.starts_with("* ") {
        return true;
    }
    // C3: TERMINAL. A spinner-bearing title returns from HERE and never reaches
    // C4. `openclaude` is a deliberate SUBSTRING test on the lowercased title —
    // broader than the token match used at the OpenClaude rung, and that
    // asymmetry is load-bearing (`"⠋ openclaude-blinker"` must be false).
    if contains_agent_spinner_glyph(title) {
        return !is_cursor_agent_title(Some(title)) && !lower.contains("openclaude");
    }
    // C4: both sub-tests run on the LEADING-trimmed string. The prefix test is a
    // cheap pre-filter; the token test is the real gate.
    let trimmed = trim_start_js(title);
    trimmed.to_lowercase().starts_with("claude") && title_has_agent_name(trimmed, "claude")
}

fn starts_with_claude_idle_prefix(title: &str) -> bool {
    let mut cursor = title.chars();
    cursor.next() == Some(CLAUDE_IDLE) && cursor.as_str().starts_with(' ')
}

fn is_bare_claude_idle(title: &str) -> bool {
    let mut cursor = title.chars();
    cursor.next() == Some(CLAUDE_IDLE) && cursor.as_str().is_empty()
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/// `getAgentLabel` — 19 rungs then `None`. Every rung returns; there is no
/// scoring and no "best match". Reordering any pair changes behaviour.
///
/// Structural facts a port must preserve: there is NO `claude` token rung (Claude
/// arrives only via the prefix rung or the last rung); there is NO `cursor` token
/// rung (Cursor is a closed title set); `openclaw` is in `AGENT_NAMES` but has no
/// rung, so it can never be labelled.
pub fn get_agent_label(title: &str) -> Option<&'static str> {
    // G1: an EARLY NULL, not a fallthrough — `claude agents` aborts the whole
    // classification so nothing after this rung runs.
    if is_claude_management_title(title) {
        return None;
    }
    // G2: the native marker owns the whole title; its session text may name other
    // agents and carry their status glyphs.
    if is_opencode_native_title(Some(title)) {
        return Some("OpenCode");
    }
    // G3: a bare Claude status prefix beats every name token below it.
    if starts_with_claude_idle_prefix(title)
        || is_bare_claude_idle(title)
        || title.starts_with(". ")
        || title.starts_with("* ")
    {
        return Some("Claude Code");
    }
    if is_gemini_terminal_title(title) {
        return Some("Gemini CLI");
    }
    // G5: truthiness on a `'Pi' | 'OMP' | null`; neither label is empty, so
    // `is_some` is faithful. The ONLY rung that can produce "OMP".
    if let Some(label) = get_pi_compatible_synthetic_agent_label(title) {
        return Some(label);
    }
    if is_pi_agent_title(title) {
        return Some("Pi");
    }
    // G7..G15: explicit name tokens, all before Claude's generic spinner rule.
    if title_has_agent_name(title, "codex") {
        return Some("Codex");
    }
    if title_has_agent_name(title, "openclaude") {
        return Some("OpenClaude");
    }
    if title_has_agent_name(title, "copilot") {
        return Some("GitHub Copilot");
    }
    if title_has_agent_name(title, "grok") {
        return Some("Grok");
    }
    if title_has_agent_name(title, "devin") {
        return Some("Devin");
    }
    if title_has_agent_name(title, "antigravity") || title_has_agy(title) {
        return Some("Antigravity");
    }
    // G13: the SECOND OpenCode rung, and a different predicate from G2. G2 (the
    // native marker) beats every name token; this one loses to all of them.
    if title_has_agent_name(title, "opencode") {
        return Some("OpenCode");
    }
    if title_has_agent_name(title, "mimo") {
        return Some("MiMo Code");
    }
    if title_has_agent_name(title, "aider") {
        return Some("Aider");
    }
    if is_cursor_agent_title(Some(title)) {
        return Some("Cursor");
    }
    if title_has_droid(title) {
        return Some("Droid");
    }
    if title_has_hermes(title) {
        return Some("Hermes");
    }
    // G19: LAST on purpose.
    if is_claude_agent(title) {
        return Some("Claude Code");
    }
    None
}

/// `resolveTerminalTitleAgentType`. Two nullish steps in the TS; the unmapped-label
/// arm is currently dead (the map is total over the ladder's range) but is kept
/// as the safe default — a new label without a map entry must yield `None`, not
/// an invented identity.
pub fn resolve_terminal_title_agent_type(title: &str) -> Option<&'static str> {
    let label = get_agent_label(title)?;
    TITLE_LABEL_TO_AGENT
        .iter()
        .find(|(key, _)| *key == label)
        .map(|(_, agent)| *agent)
}

/// `hasGenericClaudeStatusPrefix` — a SUPERSET of `is_claude_agent`'s C1+C2+C3
/// conditions: the spinner test is a first-class disjunct here rather than a
/// gated branch.
fn has_generic_claude_status_prefix(title: &str) -> bool {
    contains_agent_spinner_glyph(title)
        || starts_with_claude_idle_prefix(title)
        || is_bare_claude_idle(title)
        || title.starts_with(". ")
        || title.starts_with("* ")
}

/// Note the deliberate difference from `is_claude_agent`'s C4: the token match
/// here runs on the RAW title, not the leading-trimmed one. Behaviourally inert
/// (whitespace is not in the boundary class) but the source distinction is real,
/// so both call sites stay verbatim.
fn is_generic_claude_status_claim(title: &str, title_agent: Option<&str>) -> bool {
    title_agent == Some("claude")
        && has_generic_claude_status_prefix(title)
        && !title_has_agent_name(title, "claude")
}

/// `resolveExplicitTerminalTitleAgentType`. Strictly a post-filter: it can only
/// turn `"claude"` into `None`. Claude's bare status prefixes are ACTIVITY
/// evidence, not IDENTITY.
pub fn resolve_explicit_terminal_title_agent_type(title: &str) -> Option<&'static str> {
    let title_agent = resolve_terminal_title_agent_type(title);
    if is_generic_claude_status_claim(title, title_agent) {
        return None;
    }
    title_agent
}

#[cfg(test)]
mod tests {
    use super::*;


    /// Recorded-golden differential against the TypeScript ladder at HEAD.
    ///
    /// Rows are `(title, isClaudeAgent, getAgentLabel, resolveTerminalTitleAgentType,
    /// resolveExplicitTerminalTitleAgentType)`, produced by executing the TS regex
    /// literals and function bodies verbatim under Node. The corpus is the pinned
    /// cases from `src/shared/terminal-title-agent-type.test.ts` and
    /// `src/renderer/src/lib/agent-status.test.ts` PLUS the Unicode adversarials
    /// that no TS test covers and where a plausible Rust port diverges silently:
    /// U+FEFF vs U+0085 (`\s` and `.trim()`), U+212A (the regex `i` fold vs
    /// `.toLowerCase()`), U+2028 (`.` line terminators), and the OpenCode
    /// leading-whitespace / wrapper-group ambiguity.
    #[rustfmt::skip]
    const TS_GOLDEN: &[(&str, bool, Option<&str>, Option<&str>, Option<&str>)] = &[
    ("", false, None, None, None),
    (" ", false, None, None, None),
    ("   ", false, None, None, None),
    ("zsh", false, None, None, None),
    ("bash", false, None, None, None),
    ("Terminal 1", false, None, None, None),
    ("✳ Claude Code", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("✳", true, Some("Claude Code"), Some("claude"), None),
    ("✳x", false, None, None, None),
    ("✳ ", true, Some("Claude Code"), Some("claude"), None),
    (" ✳ x", false, None, None, None),
    (". Claude Code compare Opencode", true, Some("Claude Code"), Some("claude"), Some("claude")),
    (". Compare Opencode Vs Orca", true, Some("Claude Code"), Some("claude"), None),
    ("* Review Codex behavior", true, Some("Claude Code"), Some("claude"), None),
    (".", false, None, None, None),
    ("*", false, None, None, None),
    (". ", true, Some("Claude Code"), Some("claude"), None),
    ("* ", true, Some("Claude Code"), Some("claude"), None),
    ("⠋ Codex", true, Some("Codex"), Some("codex"), Some("codex")),
    ("⠋ Codex: fix cursor offsets", true, Some("Codex"), Some("codex"), Some("codex")),
    ("⠋ preserve cursor visibility across replays", true, Some("Claude Code"), Some("claude"), None),
    ("⠋ OpenClaude", false, Some("OpenClaude"), Some("openclaude"), Some("openclaude")),
    ("⠋ openclaude-blinker", false, None, None, None),
    ("⠋ ~/openclaude-scratch", false, None, None, None),
    ("⠋ OPENCLAUDE", false, Some("OpenClaude"), Some("openclaude"), Some("openclaude")),
    ("⠋ Cursor Agent", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("Cursor Agent", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("Cursor ready", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("Cursor - action required", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("⠋ cursor agent", true, Some("Claude Code"), Some("claude"), None),
    ("⠋  Cursor Agent", true, Some("Claude Code"), Some("claude"), None),
    ("⠋⠙ Cursor Agent", true, Some("Claude Code"), Some("claude"), None),
    ("  ⠋ Cursor Agent  ", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("CURSOR AGENT", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("Cursor Ready", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("CURSOR - ACTION REQUIRED", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("cursor  agent", false, None, None, None),
    ("cursor agent x", false, None, None, None),
    ("\u{feff}⠋ Cursor Agent", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("\u{85}cursor agent", false, None, None, None),
    ("⠋ Cursor Agent claude", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("⠋ Cursor Agent openclaude", false, Some("OpenClaude"), Some("openclaude"), Some("openclaude")),
    ("OC | ⠋ implementing the feature", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC | Understand about the plugin", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC | Compare Codex and Claude", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC | ✦ Gemini CLI", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("tmux | OC | ses_123", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC|compact-session", false, None, None, None),
    ("OC | Native Stable Session", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("  OC|Session  ", false, None, None, None),
    ("OC |", false, None, None, None),
    ("OC | ", false, None, None, None),
    ("OC |   ", false, None, None, None),
    ("oc | Understand about the plugin", false, None, None, None),
    ("⠋ Fix foo | OC | bar", true, Some("Claude Code"), Some("claude"), None),
    ("my session | OC | task", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("tmux\u{9}| OC | x", false, None, None, None),
    ("OC \u{9} | \u{9} x", false, None, None, None),
    ("OC  |  x", false, None, None, None),
    ("tmux | OC|x", false, None, None, None),
    ("⠋x | OC | y", true, Some("Claude Code"), Some("claude"), None),
    ("日本 | OC | x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC\u{3000}| x", false, None, None, None),
    ("\u{feff}OC | x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("\u{85}OC | x", false, None, None, None),
    ("OC\u{85}| x", false, None, None, None),
    (" | OC | x", false, None, None, None),
    ("   | OC | x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("a | b | OC | x", false, None, None, None),
    ("日本|OC | x", false, None, None, None),
    ("run OC | x", false, None, None, None),
    ("▣ OC | task", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("⠋ OC | task", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("▣OC | task", false, None, None, None),
    ("OC | x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC |\u{9}x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC | \u{9} x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OC |\u{a} x", false, None, None, None),
    ("OC | \u{a}", false, None, None, None),
    ("  OC | x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OpenCode", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("OpenCode ready", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("opencode-blinker", false, None, None, None),
    ("~/opencode/working", false, None, None, None),
    ("Pi ready", false, Some("Pi"), Some("pi"), Some("pi")),
    ("OMP", false, Some("OMP"), Some("omp"), Some("omp")),
    ("OMP ready", false, Some("OMP"), Some("omp"), Some("omp")),
    ("omp - action required", false, Some("OMP"), Some("omp"), Some("omp")),
    ("⠋ omp - action required", true, Some("OMP"), Some("omp"), Some("omp")),
    ("⠋ Pi", true, Some("Pi"), Some("pi"), Some("pi")),
    ("Pi", false, Some("Pi"), Some("pi"), Some("pi")),
    ("pi", false, Some("Pi"), Some("pi"), Some("pi")),
    ("PI", false, Some("Pi"), Some("pi"), Some("pi")),
    ("Omp", false, Some("OMP"), Some("omp"), Some("omp")),
    ("⠋⠙ Pi", true, Some("Claude Code"), Some("claude"), None),
    ("⠋Pi", true, Some("Claude Code"), Some("claude"), None),
    ("pin", false, None, None, None),
    ("pi ready extra", false, None, None, None),
    ("pi  ready", false, Some("Pi"), Some("pi"), Some("pi")),
    ("pi - action required", false, Some("Pi"), Some("pi"), Some("pi")),
    ("pi -  action required", false, Some("Pi"), Some("pi"), Some("pi")),
    ("pi\u{9}- action required", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π - foo", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π: foo", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π foo", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π -", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π:", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π ", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π", false, None, None, None),
    ("⠋ π - foo", true, Some("Pi"), Some("pi"), Some("pi")),
    ("  π - x", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π\u{9}- x", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π x", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π  -  x", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π -\u{a}foo", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π - foo\u{a}bar", false, None, None, None),
    ("Π - foo", false, None, None, None),
    ("⠋π - foo", true, Some("Claude Code"), Some("claude"), None),
    ("π - gemini", false, Some("Pi"), Some("pi"), Some("pi")),
    ("π - run gemini now", false, Some("Pi"), Some("pi"), Some("pi")),
    ("⠋ π - gemini", true, Some("Pi"), Some("pi"), Some("pi")),
    ("⠋ π: gemini", true, Some("Pi"), Some("pi"), Some("pi")),
    ("π: gemini", false, Some("Pi"), Some("pi"), Some("pi")),
    ("⠋ π gemini", true, Some("Pi"), Some("pi"), Some("pi")),
    ("π gemini", false, Some("Pi"), Some("pi"), Some("pi")),
    ("⠋ π - gemini-project", true, Some("Pi"), Some("pi"), Some("pi")),
    ("π - ✦ building", false, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("⠋ π - ✦ build", true, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("✦  Typing prompt... (workspace)", false, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("◇  Ready (workspace)", false, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("gemini waiting for input", false, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("⠂ Claude Code", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("/tmp/gemini/working", false, None, None, None),
    ("✋ permission", false, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("⏲ silent", false, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("◇ idle", false, Some("Gemini CLI"), Some("gemini"), Some("gemini")),
    ("claude agents", false, None, None, None),
    ("  Claude Agents  ", false, None, None, None),
    ("CLAUDE AGENTS", false, None, None, None),
    ("claude.exe agents", false, None, None, None),
    ("claude.cmd agents", false, None, None, None),
    ("claude.bat agents", false, None, None, None),
    ("claude.ps1 agents", false, None, None, None),
    ("/usr/bin/claude agents", false, None, None, None),
    ("C:\\Users\\d\\claude.cmd agents", false, None, None, None),
    ("\"C:\\Users\\d\\claude.cmd\" agents", false, None, None, None),
    ("'/usr/bin/claude' agents", false, None, None, None),
    ("claude  agents", false, None, None, None),
    ("\u{9}claude agents\u{a}", false, None, None, None),
    ("\"claude\" agents", false, None, None, None),
    ("\u{a0}claude agents", false, None, None, None),
    ("\u{feff}claude agents", false, None, None, None),
    ("\u{85}claude agents", false, None, None, None),
    ("claudeagents", false, None, None, None),
    ("claude agents x", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("xclaude agents", false, None, None, None),
    ("claude.zip agents", false, None, None, None),
    ("claude agent", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("claude\" agents", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("a\u{a}claude agents", false, None, None, None),
    ("~/x\u{2028}y/claude agents", false, None, None, None),
    ("/usr/local/bin/claude.exe   agents  ", false, None, None, None),
    ("✳ claude agents", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("\"claude.exe\" agents", false, None, None, None),
    ("claude.exel agents", false, None, None, None),
    ("claude.exe.exe agents", false, None, None, None),
    ("claude", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("Claude Code", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("claude-scratch", false, None, None, None),
    ("fixing claude bug", false, None, None, None),
    ("claude ready", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("  claude ready", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("\u{feff}claude ready", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("\u{85}claude ready", false, None, None, None),
    ("\u{feff}Claude Code", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("Claude Code — ~/repo", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("日claude", false, None, None, None),
    ("écodex", false, Some("Codex"), Some("codex"), Some("codex")),
    ("\u{212a}odex ready", false, None, None, None),
    ("gro\u{212a}", false, None, None, None),
    ("⠋ gro\u{212a}", true, Some("Claude Code"), Some("claude"), None),
    ("⠋ grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ Grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("grok", false, Some("Grok"), Some("grok"), Some("grok")),
    ("Fix the auth bug - grok", false, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ - Waiting for response… - grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠴ - Thinking - grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠦ - Sleep 2s then echo hello… - grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ debugging grok - claude", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ ~/grok-scratch/ready", true, Some("Claude Code"), Some("claude"), None),
    ("⠋ grokking the plan", true, Some("Claude Code"), Some("claude"), None),
    ("⠋ wire up grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ Codex is thinking about grok", true, Some("Codex"), Some("codex"), Some("codex")),
    ("⠋ support for Grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ fix the flaky suite - grok", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ review grok integration - claude", true, Some("Grok"), Some("grok"), Some("grok")),
    ("⠋ - Thinking -grok", true, Some("Claude Code"), Some("claude"), None),
    ("claude fix ⠋ openclaude drift", false, Some("OpenClaude"), Some("openclaude"), Some("openclaude")),
    ("⠋ claude something openclaude", false, Some("OpenClaude"), Some("openclaude"), Some("openclaude")),
    ("  ⠋  ", true, Some("Claude Code"), Some("claude"), None),
    ("⣿ done", true, Some("Claude Code"), Some("claude"), None),
    ("⤀", false, None, None, None),
    ("⠀", true, Some("Claude Code"), Some("claude"), None),
    ("⠀ Cursor Agent", false, Some("Cursor"), Some("cursor"), Some("cursor")),
    ("◐ working on it", true, Some("Claude Code"), Some("claude"), None),
    ("◑ x", true, Some("Claude Code"), Some("claude"), None),
    ("◒ x", true, Some("Claude Code"), Some("claude"), None),
    ("◓ x", true, Some("Claude Code"), Some("claude"), None),
    ("◐ Codex", true, Some("Codex"), Some("codex"), Some("codex")),
    ("◐ Cursor Agent", true, Some("Claude Code"), Some("claude"), None),
    ("◐ OpenClaude", false, Some("OpenClaude"), Some("openclaude"), Some("openclaude")),
    ("◐", true, Some("Claude Code"), Some("claude"), None),
    ("● x", false, None, None, None),
    ("◔ x", false, None, None, None),
    ("droid ready", false, Some("Droid"), Some("droid"), Some("droid")),
    ("android ready", false, None, None, None),
    ("droid.exe", false, None, None, None),
    ("⠋ Droid", true, Some("Droid"), Some("droid"), Some("droid")),
    ("hermes working", false, Some("Hermes"), Some("hermes"), Some("hermes")),
    ("~/hermes/working", false, None, None, None),
    ("agy now", false, Some("Antigravity"), Some("antigravity"), Some("antigravity")),
    ("shaggy", false, None, None, None),
    ("antigravity ready", false, Some("Antigravity"), Some("antigravity"), Some("antigravity")),
    ("⠋ agy", true, Some("Antigravity"), Some("antigravity"), Some("antigravity")),
    ("copilot ready", false, Some("GitHub Copilot"), Some("copilot"), Some("copilot")),
    ("devin working", false, Some("Devin"), Some("devin"), Some("devin")),
    ("mimo ready", false, Some("MiMo Code"), Some("mimo-code"), Some("mimo-code")),
    ("aider going", false, Some("Aider"), Some("aider"), Some("aider")),
    ("MiMo Code", false, Some("MiMo Code"), Some("mimo-code"), Some("mimo-code")),
    ("~/cursor-rules", false, None, None, None),
    ("⠸ investigating startup", true, Some("Claude Code"), Some("claude"), None),
    ("✳ investigating startup", true, Some("Claude Code"), Some("claude"), None),
    ("codex • ~/repo", false, Some("Codex"), Some("codex"), Some("codex")),
    ("timestamp ready", false, None, None, None),
    ("openclaude", false, Some("OpenClaude"), Some("openclaude"), Some("openclaude")),
    ("openclaw ready", false, None, None, None),
    ("😀claude", false, None, None, None),
    ("claude😀", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("é claude é", false, None, None, None),
    ("  claude  ", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("zsh | ⠋ Claude Code", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("claude.exe ready", true, Some("Claude Code"), Some("claude"), Some("claude")),
    ("OC | claude agents", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("✳ Claude Code | OC | x", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("x | ▣ OC | y", false, Some("OpenCode"), Some("opencode"), Some("opencode")),
    ("▣ | OC | x", false, None, None, None),
    ];

    #[test]
    fn matches_the_recorded_typescript_ladder() {
        let mut labelled = 0usize;
        let mut suppressed = 0usize;
        for &(title, claude, label, agent, explicit) in TS_GOLDEN {
            assert_eq!(is_claude_agent(title), claude, "isClaudeAgent {title:?}");
            assert_eq!(get_agent_label(title), label, "getAgentLabel {title:?}");
            assert_eq!(
                resolve_terminal_title_agent_type(title),
                agent,
                "resolveTerminalTitleAgentType {title:?}"
            );
            assert_eq!(
                resolve_explicit_terminal_title_agent_type(title),
                explicit,
                "resolveExplicitTerminalTitleAgentType {title:?}"
            );
            if label.is_some() {
                labelled += 1;
            }
            if agent.is_some() && explicit.is_none() {
                suppressed += 1;
            }
        }
        // A corpus that only ever asserts `None` would pass against a stub.
        assert!(TS_GOLDEN.len() >= 240, "corpus shrank: {}", TS_GOLDEN.len());
        assert!(labelled >= 100, "too few labelled rows: {labelled}");
        assert!(suppressed >= 5, "the explicit-suppressor arm is untested: {suppressed}");
    }

    #[test]
    fn braille_and_quarter_circle_spinner_detection() {
        assert!(contains_braille_spinner("⠋ working"));
        assert!(contains_braille_spinner("⣿ done")); // inclusive upper bound
        assert!(contains_braille_spinner("⠀")); // inclusive lower bound (BLANK)
        assert!(!contains_braille_spinner("⤀")); // U+2900, just past the block
        assert!(!contains_braille_spinner(""));
        assert!(contains_quarter_circle_spinner("◐ working"));
        assert!(contains_quarter_circle_spinner("◓ x"));
        assert!(!contains_quarter_circle_spinner("● x")); // U+25CF, outside
        assert!(contains_agent_spinner_glyph("◐ x"));
        assert!(contains_agent_spinner_glyph("⠋ x"));
        assert!(!contains_agent_spinner_glyph("x"));
    }

    #[test]
    fn claude_management_titles() {
        assert!(is_claude_management_title("claude agents"));
        assert!(is_claude_management_title("  Claude Agents  "));
        assert!(is_claude_management_title("claude.exe agents"));
        assert!(is_claude_management_title("/usr/bin/claude agents"));
        assert!(is_claude_management_title(r#""C:\Users\d\claude.cmd" agents"#));
        assert!(is_claude_management_title("'/usr/bin/claude' agents"));
        assert!(!is_claude_management_title("claudeagents"));
        assert!(!is_claude_management_title("claude agents x"));
        assert!(!is_claude_management_title("xclaude agents"));
        assert!(!is_claude_management_title("claude.zip agents"));
        assert!(!is_claude_management_title("a\nclaude agents"));
    }

    #[test]
    fn claude_management_title_uses_the_js_whitespace_set() {
        // JS `\s` includes U+FEFF and excludes U+0085; Rust's is the reverse.
        assert!(is_claude_management_title("\u{FEFF}claude agents"));
        assert!(!is_claude_management_title("\u{0085}claude agents"));
        // JS `.` cannot cross U+2028, so the path prefix stops there.
        assert!(!is_claude_management_title("~/x\u{2028}y/claude agents"));
    }

    #[test]
    fn opencode_native_marker() {
        assert!(is_opencode_native_title(Some("OC | Native Stable Session")));
        assert!(is_opencode_native_title(Some("tmux | OC | ses_123")));
        assert!(is_opencode_native_title(Some("my session | OC | task")));
        assert!(is_opencode_native_title(Some("▣ OC | task")));
        assert!(is_opencode_native_title(Some("⠋ OC | task")));
        assert!(is_opencode_native_title(Some("OC |\tx")));
        // The wrapper cannot start with a glyph, so another agent's spinner-led
        // task never masquerades as a wrapper frame.
        assert!(!is_opencode_native_title(Some("⠋ Fix foo | OC | bar")));
        assert!(!is_opencode_native_title(Some("oc | task"))); // case-sensitive
        assert!(!is_opencode_native_title(Some("OC|compact-session")));
        assert!(!is_opencode_native_title(Some("OC |")));
        assert!(!is_opencode_native_title(Some("OC |   ")));
        assert!(!is_opencode_native_title(Some("a | b | OC | x")));
        assert!(!is_opencode_native_title(Some("")));
        assert!(!is_opencode_native_title(None));
    }

    #[test]
    fn opencode_leading_whitespace_is_shared_with_the_wrapper_group() {
        // `[^|]+?` matches whitespace too, so `^\s*` is genuinely ambiguous here:
        // this only matches when the leading run gives two spaces back.
        assert!(is_opencode_native_title(Some("   | OC | x")));
        assert!(!is_opencode_native_title(Some(" | OC | x")));
        assert!(is_opencode_native_title(Some("  OC | x")));
        // U+FEFF is JS `\s`; U+0085 and U+3000-before-the-pipe are not usable.
        assert!(is_opencode_native_title(Some("\u{FEFF}OC | x")));
        assert!(!is_opencode_native_title(Some("\u{0085}OC | x")));
        assert!(!is_opencode_native_title(Some("OC\u{3000}| x")));
    }

    #[test]
    fn cursor_closed_title_set() {
        assert!(is_cursor_agent_title(Some("Cursor Agent")));
        assert!(is_cursor_agent_title(Some("CURSOR AGENT")));
        assert!(is_cursor_agent_title(Some("Cursor ready")));
        assert!(is_cursor_agent_title(Some("Cursor - action required")));
        assert!(is_cursor_agent_title(Some("⠋ Cursor Agent")));
        assert!(is_cursor_agent_title(Some("  ⠋ Cursor Agent  ")));
        assert!(is_cursor_agent_title(Some("\u{FEFF}⠋ Cursor Agent")));
        // The synthetic arm is case-SENSITIVE, one braille char, one ASCII space.
        assert!(!is_cursor_agent_title(Some("⠋ cursor agent")));
        assert!(!is_cursor_agent_title(Some("⠋  Cursor Agent")));
        assert!(!is_cursor_agent_title(Some("⠋⠙ Cursor Agent")));
        assert!(!is_cursor_agent_title(Some("cursor  agent")));
        assert!(!is_cursor_agent_title(None));
        assert!(is_cursor_native_agent_title("  CURSOR AGENT  "));
        assert!(!is_cursor_native_agent_title("⠋ Cursor Agent"));
    }

    #[test]
    fn legacy_pi_titles_require_a_delimiter_and_lowercase_pi() {
        assert!(is_legacy_pi_compatible_title("π - foo"));
        assert!(is_legacy_pi_compatible_title("π: foo"));
        assert!(is_legacy_pi_compatible_title("π foo"));
        assert!(is_legacy_pi_compatible_title("π -"));
        assert!(is_legacy_pi_compatible_title("π "));
        assert!(is_legacy_pi_compatible_title("⠋ π - foo"));
        assert!(is_legacy_pi_compatible_title("π\t- x"));
        assert!(is_legacy_pi_compatible_title("π  -  x"));
        assert!(is_legacy_pi_compatible_title("π -\nfoo")); // `\s*` may cross a LF
        assert!(!is_legacy_pi_compatible_title("π - foo\nbar")); // `.*` may not
        assert!(!is_legacy_pi_compatible_title("π")); // delimiter is required
        assert!(!is_legacy_pi_compatible_title("Π - foo")); // no `i` flag
        assert!(!is_legacy_pi_compatible_title("⠋π - foo")); // `\s+` is required
        // The spinner veto is what separates the two Pi predicates.
        assert!(is_pi_agent_title("⠋ π - foo"));
        assert!(!is_pi_terminal_title("⠋ π - foo"));
        assert!(is_pi_terminal_title("π - foo"));
    }

    #[test]
    fn pi_compatible_synthetic_labels() {
        assert_eq!(get_pi_compatible_synthetic_agent_label("⠋ Pi"), Some("Pi"));
        assert_eq!(get_pi_compatible_synthetic_agent_label("OMP ready"), Some("OMP"));
        assert_eq!(get_pi_compatible_synthetic_agent_label("OMP"), Some("OMP"));
        assert_eq!(
            get_pi_compatible_synthetic_agent_label("⠋ omp - action required"),
            Some("OMP")
        );
        assert_eq!(get_pi_compatible_synthetic_agent_label("pi  ready"), Some("Pi"));
        assert_eq!(get_pi_compatible_synthetic_agent_label("⠋⠙ Pi"), None);
        assert_eq!(get_pi_compatible_synthetic_agent_label("⠋Pi"), None);
        assert_eq!(get_pi_compatible_synthetic_agent_label("pin"), None);
        assert_eq!(get_pi_compatible_synthetic_agent_label("pi ready extra"), None);
    }

    #[test]
    fn gemini_glyphs_beat_the_pi_veto_which_beats_the_name_token() {
        assert!(is_gemini_terminal_title("✦  Typing prompt... (workspace)"));
        assert!(is_gemini_terminal_title("◇  Ready (workspace)"));
        assert!(is_gemini_terminal_title("gemini waiting for input"));
        assert!(is_gemini_terminal_title("π - ✦ building")); // glyph wins over Pi
        assert!(!is_gemini_terminal_title("π - run gemini now")); // Pi vetoes
        assert!(!is_gemini_terminal_title("⠋ π - gemini"));
        assert!(!is_gemini_terminal_title("/tmp/gemini/working"));
        assert!(!is_gemini_terminal_title("⠂ Claude Code"));
    }

    #[test]
    fn grok_working_frames_require_the_post_spinner_delimiter() {
        assert!(is_grok_rotating_working_title("⠋ - Waiting for response… - grok"));
        assert!(is_grok_rotating_working_title("⠴ - Thinking - grok"));
        assert!(is_grok_rotating_working_title("⠦ - Sleep 2s then echo hello… - grok"));
        assert!(is_grok_rotating_working_title("⠋ grok"));
        assert!(is_grok_rotating_working_title("⠋ Grok"));
        assert!(!is_grok_rotating_working_title("grok"));
        assert!(!is_grok_rotating_working_title("Fix the auth bug - grok"));
        assert!(!is_grok_rotating_working_title("⠋ fix the flaky suite - grok"));
        assert!(!is_grok_rotating_working_title("⠋ wire up grok"));
        assert!(!is_grok_rotating_working_title("⠋ grokking the plan"));
        assert!(!is_grok_rotating_working_title("⠋ ~/grok-scratch/ready"));
        assert!(!is_grok_rotating_working_title("⠋ Codex"));
        // `\s-\s+grok`: one whitespace left of the hyphen, one or more right.
        assert!(!is_grok_rotating_working_title("⠋ - Thinking -grok"));
        // ASCII fold only — U+212A KELVIN must not stand in for `k`.
        assert!(!is_grok_rotating_working_title("⠋ gro\u{212A}"));
    }

    #[test]
    fn claude_agent_ladder() {
        assert!(is_claude_agent("✳ Claude Code"));
        assert!(is_claude_agent("✳"));
        assert!(!is_claude_agent("✳x"));
        assert!(is_claude_agent(". Compare Opencode Vs Orca"));
        assert!(is_claude_agent("* Review Codex behavior"));
        assert!(is_claude_agent("⠋ preserve cursor visibility across replays"));
        assert!(is_claude_agent("◐ working on it")); // quarter-circle spinner
        assert!(!is_claude_agent("⠋ Cursor Agent"));
        assert!(!is_claude_agent("Cursor ready"));
        assert!(!is_claude_agent("⠋ OpenClaude"));
        assert!(!is_claude_agent("OC | ⠋ implementing the feature"));
        assert!(!is_claude_agent("OC | Understand about the plugin"));
        assert!(!is_claude_agent(""));
        assert!(is_claude_agent("claude ready"));
        assert!(!is_claude_agent("claude-scratch")); // token boundary
        assert!(!is_claude_agent("fixing claude bug")); // prefix pre-filter
    }

    #[test]
    fn claude_agent_spinner_branch_is_terminal_and_substring_scoped() {
        // The spinner branch RETURNS: a spinner title never reaches the
        // claude-prefix rung, so this is false even though it starts with
        // "claude" and carries the token.
        assert!(!is_claude_agent("claude fix ⠋ openclaude drift"));
        // A SUBSTRING test, not a token match: the hyphen compound still kills it.
        assert!(!is_claude_agent("⠋ openclaude-blinker"));
        assert!(!is_claude_agent("⠋ OPENCLAUDE")); // full-Unicode lowercase
        // A whitespace-only title is truthy in JS, so C0 must not pre-trim.
        assert!(is_claude_agent("  ⠋  "));
    }

    #[test]
    fn claude_agent_trim_start_uses_the_js_trim_set() {
        assert!(is_claude_agent("  claude ready"));
        assert!(is_claude_agent("\u{FEFF}claude ready")); // JS trims the BOM
        assert!(!is_claude_agent("\u{0085}claude ready")); // JS keeps NEL
    }

    #[test]
    fn agent_label_ladder_order() {
        assert_eq!(get_agent_label("claude agents"), None); // G1 early null
        // G1's regex is anchored on `^\s*` and `✳` is not whitespace, so a
        // decorated management title is NOT vetoed — it is a Claude status
        // prefix and G3 claims it. Pinned because it reads like a G1 miss.
        assert_eq!(get_agent_label("✳ claude agents"), Some("Claude Code"));
        assert_eq!(get_agent_label("  /usr/local/bin/claude.exe   agents  "), None);
        assert_eq!(get_agent_label("OC | Compare Codex and Claude"), Some("OpenCode"));
        assert_eq!(get_agent_label(". Compare Opencode Vs Orca"), Some("Claude Code"));
        assert_eq!(get_agent_label("✦ Gemini CLI"), Some("Gemini CLI"));
        assert_eq!(get_agent_label("OMP"), Some("OMP"));
        assert_eq!(get_agent_label("π - ~/repo"), Some("Pi"));
        assert_eq!(get_agent_label("⠋ Codex"), Some("Codex"));
        assert_eq!(get_agent_label("⠋ Codex: fix cursor offsets"), Some("Codex"));
        assert_eq!(get_agent_label("⠋ OpenClaude"), Some("OpenClaude"));
        assert_eq!(get_agent_label("copilot ready"), Some("GitHub Copilot"));
        assert_eq!(get_agent_label("⠋ agy"), Some("Antigravity"));
        assert_eq!(get_agent_label("OpenCode ready"), Some("OpenCode"));
        assert_eq!(get_agent_label("mimo ready"), Some("MiMo Code"));
        assert_eq!(get_agent_label("⠋ Cursor Agent"), Some("Cursor"));
        assert_eq!(get_agent_label("⠋ Droid"), Some("Droid"));
        assert_eq!(get_agent_label("hermes working"), Some("Hermes"));
        assert_eq!(
            get_agent_label("⠋ preserve cursor visibility across replays"),
            Some("Claude Code")
        );
        assert_eq!(get_agent_label("Terminal 1"), None);
        assert_eq!(get_agent_label(""), None);
        // `openclaw` is in AGENT_NAMES but has no rung, so it is unreachable.
        assert_eq!(get_agent_label("openclaw ready"), None);
    }

    #[test]
    fn resolve_terminal_title_agent_type_cases() {
        assert_eq!(resolve_terminal_title_agent_type("⠋ Cursor Agent"), Some("cursor"));
        assert_eq!(resolve_terminal_title_agent_type("Cursor Agent"), Some("cursor"));
        assert_eq!(resolve_terminal_title_agent_type("Cursor ready"), Some("cursor"));
        assert_eq!(
            resolve_terminal_title_agent_type("Cursor - action required"),
            Some("cursor")
        );
        assert_eq!(
            resolve_terminal_title_agent_type("⠋ preserve cursor visibility across replays"),
            Some("claude")
        );
        assert_eq!(
            resolve_terminal_title_agent_type("⠋ Codex: fix cursor offsets"),
            Some("codex")
        );
        assert_eq!(
            resolve_terminal_title_agent_type("OC | ⠋ implementing the feature"),
            Some("opencode")
        );
    }

    #[test]
    fn resolve_explicit_suppresses_bare_claude_status_prefixes_only() {
        for (title, expected) in [
            ("✳ Claude Code", Some("claude")),
            ("⠋ Codex", Some("codex")),
            ("✦ Gemini CLI", Some("gemini")),
            ("MiMo Code", Some("mimo-code")),
            ("⠋ OpenClaude", Some("openclaude")),
            ("OMP", Some("omp")),
            ("Cursor Agent", Some("cursor")),
            ("⠋ Cursor Agent", Some("cursor")),
            ("Cursor ready", Some("cursor")),
            ("Cursor - action required", Some("cursor")),
            ("Pi ready", Some("pi")),
            ("OpenCode ready", Some("opencode")),
            ("OC | Understand about the plugin", Some("opencode")),
            ("OC | Compare Codex and Claude", Some("opencode")),
            ("OC | ✦ Gemini CLI", Some("opencode")),
            ("tmux | OC | ses_123", Some("opencode")),
            (". Claude Code compare Opencode", Some("claude")),
            // Suppressed: activity evidence with no `claude` name token.
            ("✳ investigating startup", None),
            ("⠸ investigating startup", None),
            (". Compare Opencode Vs Orca", None),
            ("* Review Codex behavior", None),
            ("⠋ preserve cursor visibility across replays", None),
            ("~/cursor-rules", None),
            ("⠋ Fix foo | OC | bar", None),
            ("oc | Understand about the plugin", None),
            ("Terminal 1", None),
            ("zsh", None),
        ] {
            assert_eq!(
                resolve_explicit_terminal_title_agent_type(title),
                expected,
                "{title:?}"
            );
        }
    }

    #[test]
    fn token_boundaries_stay_ascii_like_the_non_unicode_js_regexes() {
        // JS `\w` without the `u` flag is ASCII-only, so a non-ASCII neighbour is
        // a boundary and the token still matches.
        assert_eq!(get_agent_label("écodex"), Some("Codex"));
        // ASCII case folding only: U+212A KELVIN is not `k`.
        assert_eq!(get_agent_label("\u{212A}odex ready"), None);
    }

    #[test]
    fn label_map_is_total_over_the_ladder_range() {
        for (label, _) in TITLE_LABEL_TO_AGENT {
            assert!(
                TITLE_LABEL_TO_AGENT.iter().filter(|(k, _)| k == label).count() == 1,
                "duplicate label {label:?}"
            );
        }
        assert_eq!(TITLE_LABEL_TO_AGENT.len(), 16);
    }
}
