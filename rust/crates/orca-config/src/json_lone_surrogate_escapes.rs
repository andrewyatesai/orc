//! Repair for the one JSON document class a Rust parser cannot represent: an
//! ESCAPED lone surrogate (`"a\ud800b"`) in config text.
//!
//! `JSON.parse` accepts it — a JS string is a UTF-16 sequence and may hold an
//! unpaired surrogate — and `serde_json::from_str` rejects it, because a Rust
//! `String` is UTF-8 and has nowhere to put one. So the same `.mcp.json` is
//! "four servers" to every JS agent runtime that reads it and "invalid JSON" to
//! us. No parser setting closes that: the value is not expressible.
//!
//! What IS expressible is the substitution every UTF-8 decoder in the app
//! already performs on the same character: U+FFFD. Write that surrogate as raw
//! WTF-8 bytes instead of an escape and `buffer.toString('utf-8')` in
//! `fs:readFile` hands the twin U+FFFD too — this only rewrites the escaped
//! spelling to match the unescaped one.
//!
//! Callers run this ONLY after a strict parse has already failed, so a healthy
//! document is never rescanned and never altered. Reach for
//! `parse_json_past_lone_surrogate_escapes` rather than re-typing that order:
//! the rewrite is the easy half, the ORDER is the safety argument, and the
//! second caller is where a hand-rolled copy gets it backwards.

use serde_json::Value;

/// Parse JSON, giving an escaped lone surrogate a second chance — and nothing
/// else one.
///
/// Strict first, always. A document `serde_json` accepts is returned by the
/// first parse and never rescanned, so no repair can reach text the parser
/// would have taken. Only a genuine failure earns the retry, and the ORIGINAL
/// error comes back unchanged when the rewrite finds nothing or the retry still
/// fails — a caller that renders the error therefore never describes a
/// document that existed only inside this function.
///
/// # Errors
/// The original `serde_json` parse error, whenever the text is unparseable for
/// any reason this repair does not cover.
pub fn parse_json_past_lone_surrogate_escapes(text: &str) -> Result<Value, serde_json::Error> {
    let original = match serde_json::from_str(text) {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    match replace_lone_surrogate_escapes(text) {
        // Still broken for some OTHER reason: keep the original parse error, so
        // the retry can never launder a document the twin also refuses.
        Some(repaired) => serde_json::from_str(&repaired).map_err(|_| original),
        None => Err(original),
    }
}

/// Rewrite every unpaired `\uD800`–`\uDFFF` escape inside a JSON string literal
/// to `\ufffd`; `None` when the text has none (nothing to retry).
///
/// Length-preserving by construction — six ASCII characters in, six out — so a
/// size bound already decided against the original text still holds, and byte
/// offsets in a parse error stay meaningful.
pub fn replace_lone_surrogate_escapes(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut copied = 0usize;
    let mut index = 0usize;
    let mut in_string = false;

    while index < bytes.len() {
        if !in_string {
            in_string = bytes[index] == b'"';
            index += 1;
            continue;
        }
        match bytes[index] {
            b'"' => {
                in_string = false;
                index += 1;
            }
            // Every other escape consumes two bytes, which is what keeps a
            // literal `\\ud800` (backslash then text) from reading as an escape.
            b'\\' => match hex_escape_at(bytes, index) {
                Some(0xd800..=0xdbff) if trailing_surrogate_follows(bytes, index + 6) => {
                    index += 12;
                }
                Some(0xd800..=0xdfff) => {
                    out.push_str(&text[copied..index]);
                    out.push_str("\\ufffd");
                    index += 6;
                    copied = index;
                }
                Some(_) => index += 6,
                None => index += 2,
            },
            _ => index += 1,
        }
    }

    // A rewrite always happens inside a string literal, so `copied` past 0 is
    // exactly "something was replaced".
    if copied == 0 {
        return None;
    }
    out.push_str(&text[copied..]);
    Some(out)
}

/// The code unit of a well-formed `\uXXXX` at `index`, else `None` (a different
/// escape, or malformed hex the parser will reject on its own).
fn hex_escape_at(bytes: &[u8], index: usize) -> Option<u16> {
    if bytes.get(index + 1) != Some(&b'u') {
        return None;
    }
    let digits = bytes.get(index + 2..index + 6)?;
    let mut unit: u16 = 0;
    for digit in digits {
        unit = unit * 16 + u16::try_from((*digit as char).to_digit(16)?).ok()?;
    }
    Some(unit)
}

fn trailing_surrogate_follows(bytes: &[u8], index: usize) -> bool {
    matches!(hex_escape_at(bytes, index), Some(0xdc00..=0xdfff))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_text_without_a_lone_surrogate_alone() {
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"b"}"#), None);
        // A matched pair is a real astral character and must survive intact.
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\ud83d\ude80"}"#), None);
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\u0041\uffff"}"#), None);
    }

    #[test]
    fn replaces_unpaired_high_and_low_surrogates() {
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a\ud800b":"\udc00"}"#).as_deref(),
            Some(r#"{"a\ufffdb":"\ufffd"}"#)
        );
        // Upper-case hex is the same escape.
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"\uD83D"}"#).as_deref(),
            Some(r#"{"a":"\ufffd"}"#)
        );
    }

    #[test]
    fn keeps_a_pair_while_repairing_a_lone_surrogate_in_the_same_document() {
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"\ud83d\ude80":"\ud800","x":"\ud83d\ude80"}"#)
                .as_deref(),
            Some(r#"{"\ud83d\ude80":"\ufffd","x":"\ud83d\ude80"}"#)
        );
    }

    #[test]
    fn a_reversed_pair_is_two_lone_surrogates() {
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"\udc00\ud800"}"#).as_deref(),
            Some(r#"{"a":"\ufffd\ufffd"}"#)
        );
    }

    #[test]
    fn an_escaped_backslash_is_not_an_escape_opener() {
        // `"a\\ud800"` is a backslash followed by the TEXT ud800; both parsers
        // read it that way, so rewriting it would corrupt a valid document.
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\\ud800"}"#), None);
        assert_eq!(
            replace_lone_surrogate_escapes(r#"{"a":"\\\ud800"}"#).as_deref(),
            Some(r#"{"a":"\\\ufffd"}"#)
        );
    }

    #[test]
    fn ignores_surrogate_looking_text_outside_string_literals() {
        // Not JSON at all; the parser must still answer for it, unrewritten.
        assert_eq!(replace_lone_surrogate_escapes(r"{a:\ud800}"), None);
    }

    #[test]
    fn ignores_malformed_and_truncated_escapes() {
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\ud80"}"#), None);
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\uzzzz"}"#), None);
        assert_eq!(replace_lone_surrogate_escapes(r#"{"a":"\ud800"#), Some(r#"{"a":"\ufffd"#.to_string()));
        assert_eq!(replace_lone_surrogate_escapes(r"\"), None);
    }

    #[test]
    fn preserves_length_and_multibyte_bytes() {
        let text = "{\"é\":\"\\ud800é\"}";
        let repaired = replace_lone_surrogate_escapes(text).expect("rewritten");
        assert_eq!(repaired.len(), text.len());
        assert_eq!(repaired, "{\"é\":\"\\ufffdé\"}");
    }

    #[test]
    fn rewritten_text_parses_and_the_original_does_not() {
        let text = r#"{"mcpServers":{"a\ud800":{"command":"node"}}}"#;
        assert!(serde_json::from_str::<serde_json::Value>(text).is_err());
        let repaired = replace_lone_surrogate_escapes(text).expect("rewritten");
        let parsed: serde_json::Value = serde_json::from_str(&repaired).expect("parses");
        assert!(parsed["mcpServers"].get("a\u{fffd}").is_some());
    }

    // --- the ORDER, which is the part a second caller gets wrong ---

    #[test]
    fn parse_recovers_a_document_only_the_lone_surrogate_broke() {
        let parsed = parse_json_past_lone_surrogate_escapes(r#"{"completedBy":"w\ud800"}"#)
            .expect("recovered");
        assert_eq!(parsed["completedBy"], Value::String("w\u{fffd}".to_string()));
    }

    #[test]
    fn parse_never_rescans_a_document_the_strict_parser_accepts() {
        // `\\ud800` is a backslash then the TEXT ud800 — a valid document whose
        // value a rewrite would corrupt.
        //
        // Measured, so the claim stays honest: with a CORRECT scanner the order
        // is not observable at all, because "strict parse succeeds" and "an
        // unpaired surrogate escape is present" are mutually exclusive —
        // swapping to rewrite-first alone breaks nothing. What strict-first buys
        // is CONTAINMENT of a scanner bug. Planting escaped-backslash blindness
        // in `replace_lone_surrogate_escapes` fails this test under rewrite-first
        // and passes it under strict-first, with only the scanner's own unit test
        // still red. So the order downgrades a future rewrite bug from silent
        // value corruption to a no-op on every document the parser accepts.
        let parsed = parse_json_past_lone_surrogate_escapes(r#"{"a":"\\ud800"}"#).expect("valid");
        assert_eq!(parsed["a"], Value::String("\\ud800".to_string()));
    }

    #[test]
    fn parse_returns_the_original_error_when_the_retry_still_fails() {
        // A lone surrogate AND a real syntax error: the message must describe
        // the text the caller handed in, not the repaired variant.
        let text = r#"{"a":"\ud800",}"#;
        let original = serde_json::from_str::<Value>(text).expect_err("unparseable");
        let error = parse_json_past_lone_surrogate_escapes(text).expect_err("still unparseable");
        assert_eq!(error.to_string(), original.to_string());
    }

    #[test]
    fn parse_returns_the_original_error_when_the_rewrite_changes_nothing() {
        let text = r#"{"a":}"#;
        let original = serde_json::from_str::<Value>(text).expect_err("unparseable");
        let error = parse_json_past_lone_surrogate_escapes(text).expect_err("unparseable");
        assert_eq!(error.to_string(), original.to_string());
    }

    #[test]
    fn parse_keeps_a_matched_pair_as_its_astral_character() {
        let parsed =
            parse_json_past_lone_surrogate_escapes(r#"{"a":"🚀"}"#).expect("valid");
        assert_eq!(parsed["a"], Value::String("\u{1f680}".to_string()));
    }
}
