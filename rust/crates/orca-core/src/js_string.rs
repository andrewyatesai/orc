//! JS `String.prototype.trim` equivalence. Rust `char::is_whitespace` (Unicode
//! `White_Space`) diverges from the ECMAScript trim set (WhiteSpace +
//! LineTerminator) on exactly two codepoints: U+FEFF (BOM/ZWNBSP) — JS trims it,
//! Rust doesn't; U+0085 (NEL) — Rust trims it, JS doesn't. Ports that mirror a TS
//! `.trim()` MUST use this, not `str::trim`, or they diverge on those codepoints.

/// True for exactly the ECMAScript trim set (`WhiteSpace` + `LineTerminator`).
pub fn is_js_trim_ws(c: char) -> bool {
    c == '\u{FEFF}' || (c != '\u{0085}' && c.is_whitespace())
}

/// `String.prototype.trim` equivalent.
pub fn trim_js(value: &str) -> &str {
    value.trim_matches(is_js_trim_ws)
}

/// `String.prototype.length` — UTF-16 code units, not chars.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `String.prototype.slice(0, limit)` — the limit counts UTF-16 code units, so
/// `.chars().take(limit)` keeps up to TWICE as much for astral text. Five ported
/// cores had that substitution; see docs/rust-migration/ported-modules.md.
///
/// When the limit lands BETWEEN the halves of a surrogate pair, JS emits the lone
/// high surrogate and no Rust `String` can hold one, so the pair is dropped
/// instead. That residual is the boundary, not a choice.
pub fn slice_utf16(value: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if used + width > limit {
            break;
        }
        out.push(ch);
        used += width;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_bom_but_not_nel_matching_js() {
        // JS strips U+FEFF; Rust's is_whitespace does not.
        assert_eq!(trim_js("\u{FEFF}hello\u{FEFF}"), "hello");
        // JS keeps U+0085 (NEL); Rust's is_whitespace strips it.
        assert_eq!(trim_js("\u{0085}hello\u{0085}"), "\u{0085}hello\u{0085}");
        // A bare BOM is fully blank under JS trim.
        assert_eq!(trim_js("\u{FEFF}"), "");
        // Ordinary ASCII whitespace still trims.
        assert_eq!(trim_js("  hi \t"), "hi");
    }
}
