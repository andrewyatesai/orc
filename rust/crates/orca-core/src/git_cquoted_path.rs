//! Decoder for git's C-style quoted pathnames, ported from
//! `src/shared/git-cquoted-path.ts`.
//!
//! When `core.quotePath` is on, git wraps paths containing "unusual" bytes in
//! double quotes and escapes them (`\n`, `\t`, octal `\NNN`, …). Orca parses
//! porcelain output that may contain these, so the decode must match the TS
//! implementation exactly — including accumulating a run of adjacent `\NNN`
//! octal escapes into UTF-8 bytes before decoding (git C-quotes non-ASCII as a
//! byte run), mirroring the TS `Uint8Array` + `TextDecoder` path. The octal
//! arm's totality is proof-carried in `orca-git/proofs/ay/decode_total`.

// Every `chars[i]` below is `chars.get(i)`: `n` is `Vec::len`, an opaque value
// the verifier cannot relate back to the buffer, so an `i < n` guard proves
// nothing about the index. `get` returns None exactly where the index panicked,
// and each None arm takes the same exit the guard already took.
pub fn decode_git_cquoted_path(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let n = chars.len();
    if n < 2 || chars.first() != Some(&'"') || chars.last() != Some(&'"') {
        return value.to_string();
    }

    let mut decoded = String::new();
    let mut index = 1;
    while index < n - 1 {
        let Some(&ch) = chars.get(index) else { break };
        if ch != '\\' {
            decoded.push(ch);
            index += 1;
            continue;
        }

        index += 1;
        let Some(&escaped) = chars.get(index) else {
            break;
        };
        match escaped {
            'a' => decoded.push('\u{0007}'),
            'b' => decoded.push('\u{0008}'),
            'f' => decoded.push('\u{000C}'),
            'n' => decoded.push('\n'),
            'r' => decoded.push('\r'),
            't' => decoded.push('\t'),
            'v' => decoded.push('\u{000B}'),
            '\\' | '"' => decoded.push(escaped),
            c if ('0'..='7').contains(&c) => {
                // Git C-quotes non-ASCII text as a run of adjacent `\NNN` octal
                // BYTES (UTF-8). Accumulate the whole run and decode it as one
                // unit — decoding each byte to its own char (the old behavior)
                // corrupts localized text, e.g. `\303\251` → "Ã©" instead of "é".
                let mut bytes: Vec<u8> = Vec::new();
                loop {
                    let mut octal = String::new();
                    let Some(&first) = chars.get(index) else { break };
                    octal.push(first);
                    while octal.len() < 3 && index + 1 < n - 1 {
                        let Some(&digit) = chars.get(index + 1) else { break };
                        if !digit.is_digit(8) {
                            break;
                        }
                        index += 1;
                        octal.push(digit);
                    }
                    if let Ok(value) = u32::from_str_radix(&octal, 8) {
                        // `\777` (511) wraps to a u8 the same way Uint8Array does.
                        bytes.push((value & 0xFF) as u8);
                    }
                    // Continue only if another `\NNN` escape follows immediately.
                    if index + 2 < n
                        && chars.get(index + 1) == Some(&'\\')
                        && chars.get(index + 2).is_some_and(|c| c.is_digit(8))
                    {
                        index += 2; // step onto the next byte's first octal digit
                    } else {
                        break;
                    }
                }
                decoded.push_str(&String::from_utf8_lossy(&bytes));
            }
            other => decoded.push(other),
        }
        index += 1;
    }
    decoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_unquoted_input_unchanged() {
        assert_eq!(decode_git_cquoted_path("src/index.ts"), "src/index.ts");
        assert_eq!(decode_git_cquoted_path(""), "");
        assert_eq!(decode_git_cquoted_path("\""), "\"");
    }

    #[test]
    fn strips_surrounding_quotes_for_plain_quoted_paths() {
        assert_eq!(decode_git_cquoted_path("\"src/index.ts\""), "src/index.ts");
    }

    #[test]
    fn decodes_named_escapes() {
        assert_eq!(decode_git_cquoted_path("\"a\\tb\""), "a\tb");
        assert_eq!(decode_git_cquoted_path("\"a\\nb\""), "a\nb");
        assert_eq!(decode_git_cquoted_path("\"a\\\\b\""), "a\\b");
        assert_eq!(decode_git_cquoted_path("\"a\\\"b\""), "a\"b");
    }

    #[test]
    fn decodes_octal_escapes() {
        // git quotes a UTF-8 "é" (0xC3 0xA9) as \303\251 — the adjacent octal
        // byte run must UTF-8-decode to the single codepoint, not two chars.
        assert_eq!(decode_git_cquoted_path("\"caf\\303\\251.txt\""), "café.txt");
        // A single octal byte (ASCII).
        assert_eq!(decode_git_cquoted_path("\"\\101\""), "A");
        // A three-byte codepoint (€ = 0xE2 0x82 0xAC = \342\202\254).
        assert_eq!(decode_git_cquoted_path("\"\\342\\202\\254\""), "€");
    }
}
