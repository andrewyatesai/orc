//! Stable pane id + pane-key handling, ported from `src/shared/stable-pane-id.ts`.
//!
//! A pane key (`<tabId>:<leafUuid>`) crosses renderer reloads, PTY env, hook
//! IPC, and retained UI rows, so it keys on the durable terminal-layout leaf
//! UUID, never the renderer-local numeric pane id. Validation is strict so a
//! legacy numeric key can't masquerade as a stable one.

/// `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
/// (lowercase only — uppercase UUIDs are rejected, matching the un-flagged regex).
fn all_hex_lower(bytes: &[u8]) -> bool {
    bytes.iter().all(|&c| c.is_ascii_digit() || matches!(c, b'a'..=b'f'))
}

fn is_hex_group(s: &str, len: usize) -> bool {
    let b = s.as_bytes();
    b.len() == len && all_hex_lower(b)
}

/// `len` bytes, all hex except the leading version/variant byte the caller checks.
fn is_hex_group_after_first(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes().skip(1).all(|c| c.is_ascii_digit() || matches!(c, b'a'..=b'f'))
}

pub fn is_stable_pane_id(value: &str) -> bool {
    // Split on `-` rather than indexing fixed offsets: a hex group can never
    // contain a dash, so exactly five groups of length 8-4-4-4-12 pins the same
    // 36-char layout with the dashes at 8/13/18/23 — and every bound here is
    // structural, so nothing needs a length relation the verifier can't derive.
    let mut parts = value.split('-');
    let (Some(g1), Some(g2), Some(g3), Some(g4), Some(g5), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return false;
    };
    // `first()`/`skip(1)` rather than a `[head, rest @ ..]` slice pattern: the
    // verifier havocs a rest-binding's length, so the pattern reintroduces the
    // bounds obligation it was meant to discharge.
    is_hex_group(g1, 8)
        && is_hex_group(g2, 4)
        && matches!(g3.as_bytes().first().copied(), Some(b'1'..=b'5'))
        && is_hex_group_after_first(g3, 4)
        && matches!(g4.as_bytes().first().copied(), Some(b'8' | b'9' | b'a' | b'b'))
        && is_hex_group_after_first(g4, 4)
        && is_hex_group(g5, 12)
}

pub fn is_terminal_leaf_id(value: &str) -> bool {
    is_stable_pane_id(value)
}

pub fn make_pane_key(tab_id: &str, stable_leaf_id: &str) -> Result<String, String> {
    if tab_id.is_empty() || tab_id.contains(':') {
        return Err("tabId must be non-empty and must not contain \":\"".to_string());
    }
    if !is_terminal_leaf_id(stable_leaf_id) {
        return Err("stableLeafId must be a UUID".to_string());
    }
    Ok(format!("{tab_id}:{stable_leaf_id}"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedPaneKey {
    pub tab_id: String,
    pub leaf_id: String,
}

/// Splits a single-colon `<tabId>:<uuid>` key, validating the UUID.
pub fn parse_pane_key(pane_key: &str) -> Option<ParsedPaneKey> {
    // `split_once` gives the same first-colon split with no index arithmetic:
    // an empty tail ≙ the old `first == len - 1`, a `:` in the tail ≙ the old
    // `rfind(':') != Some(first)`.
    let (tab_id, leaf_id) = pane_key.split_once(':')?;
    if tab_id.is_empty() || leaf_id.is_empty() || leaf_id.contains(':') {
        return None;
    }
    if !is_terminal_leaf_id(leaf_id) {
        return None;
    }
    Some(ParsedPaneKey {
        tab_id: tab_id.to_string(),
        leaf_id: leaf_id.to_string(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyNumericPaneKey {
    pub tab_id: String,
    pub numeric_pane_id: String,
    pub pane_key: String,
}

/// Parses a legacy `<tabId>:<numeric>` key (migration aliases only).
pub fn parse_legacy_numeric_pane_key(pane_key: &str) -> Option<LegacyNumericPaneKey> {
    if pane_key.len() > 256 {
        return None;
    }
    let trimmed = pane_key.trim();
    let (tab_id, numeric) = trimmed.split_once(':')?;
    if tab_id.is_empty() || numeric.is_empty() || numeric.contains(':') {
        return None;
    }
    if !numeric.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(LegacyNumericPaneKey {
        tab_id: tab_id.to_string(),
        numeric_pane_id: numeric.to_string(),
        pane_key: trimmed.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEAF_ID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn recognizes_uuid_leaf_ids_as_stable_pane_ids() {
        assert!(is_stable_pane_id(LEAF_ID));
        assert!(is_terminal_leaf_id(LEAF_ID));
    }

    #[test]
    fn rejects_legacy_numeric_ids_and_malformed_uuids() {
        for value in ["1", "pane:1", "11111111-1111-6111-8111-111111111111", ""] {
            assert!(!is_stable_pane_id(value), "{value}");
            assert!(!is_terminal_leaf_id(value), "{value}");
        }
    }

    #[test]
    fn builds_and_parses_pane_keys() {
        let pane_key = make_pane_key("tab-1", LEAF_ID).unwrap();
        assert_eq!(pane_key, format!("tab-1:{LEAF_ID}"));
        assert_eq!(
            parse_pane_key(&pane_key),
            Some(ParsedPaneKey {
                tab_id: "tab-1".to_string(),
                leaf_id: LEAF_ID.to_string(),
            })
        );
    }

    #[test]
    fn rejects_ambiguous_tab_ids_and_non_uuid_leaf_ids_when_building() {
        assert!(make_pane_key("", LEAF_ID).unwrap_err().contains("tabId"));
        assert!(make_pane_key("tab:1", LEAF_ID).unwrap_err().contains("tabId"));
        assert!(make_pane_key("tab-1", "1").unwrap_err().contains("UUID"));
    }

    #[test]
    fn rejects_ambiguous_or_legacy_inputs_when_parsing() {
        assert_eq!(parse_pane_key("tab-1:1"), None);
        assert_eq!(parse_pane_key(&format!("tab:1:{LEAF_ID}")), None);
        assert_eq!(parse_pane_key(&format!(":{LEAF_ID}")), None);
        assert_eq!(parse_pane_key("tab-1:"), None);
    }

    #[test]
    fn parses_legacy_numeric_pane_keys_only_for_migration_aliases() {
        assert_eq!(
            parse_legacy_numeric_pane_key(" tab-1:12 "),
            Some(LegacyNumericPaneKey {
                tab_id: "tab-1".to_string(),
                numeric_pane_id: "12".to_string(),
                pane_key: "tab-1:12".to_string(),
            })
        );
        assert_eq!(parse_legacy_numeric_pane_key(&format!("tab-1:{LEAF_ID}")), None);
        assert_eq!(parse_legacy_numeric_pane_key("tab:1:12"), None);
    }

    /// `is_stable_pane_id` moved from fixed byte offsets to a `-` split. The
    /// pre-rewrite implementation is kept here as the behavioural oracle so a
    /// disagreement on any adversarial layout fails rather than silently
    /// widening (or narrowing) what counts as a leaf id.
    fn is_stable_pane_id_by_offset(value: &str) -> bool {
        let b = value.as_bytes();
        if b.len() != 36 {
            return false;
        }
        if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
            return false;
        }
        let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
        let hex_run = |range: std::ops::Range<usize>| range.clone().all(|i| hex(b[i]));
        hex_run(0..8)
            && hex_run(9..13)
            && (b'1'..=b'5').contains(&b[14])
            && hex_run(15..18)
            && matches!(b[19], b'8' | b'9' | b'a' | b'b')
            && hex_run(20..23)
            && hex_run(24..36)
    }

    #[test]
    fn dash_split_uuid_check_agrees_with_the_fixed_offset_check() {
        let mut cases: Vec<String> = vec![
            LEAF_ID.to_string(),
            // Right total length, dashes in the wrong places.
            "111111111-111-4111-8111-111111111111".to_string(),
            "1111111-11111-4111-8111-111111111111".to_string(),
            "11111111-1111-4111-8111-11111111111-".to_string(),
            "-1111111-1111-4111-8111-111111111111".to_string(),
            // Extra / missing dashes.
            "11111111-1111-4111-8111-11111111-111".to_string(),
            "111111111111411181111111111111111111".to_string(),
            // Case, version and variant edges.
            "11111111-1111-4111-8111-11111111111A".to_string(),
            "11111111-1111-0111-8111-111111111111".to_string(),
            "11111111-1111-6111-8111-111111111111".to_string(),
            "11111111-1111-4111-7111-111111111111".to_string(),
            "11111111-1111-4111-c111-111111111111".to_string(),
            // Non-hex and multibyte in each group.
            "1111111g-1111-4111-8111-111111111111".to_string(),
            "11111111-1111-4111-8111-11111111111é".to_string(),
            "é1111111-1111-4111-8111-111111111111".to_string(),
            // Lengths either side of 36.
            String::new(),
            "-".to_string(),
            "11111111-1111-4111-8111-1111111111111".to_string(),
            "11111111-1111-4111-8111-11111111111".to_string(),
        ];
        // Sweep every single-position mutation of a valid id.
        for i in 0..LEAF_ID.len() {
            for replacement in ['-', 'g', '0', 'f', 'F', '9'] {
                let mut mutated: Vec<char> = LEAF_ID.chars().collect();
                mutated[i] = replacement;
                cases.push(mutated.into_iter().collect());
            }
        }
        for case in &cases {
            assert_eq!(
                is_stable_pane_id(case),
                is_stable_pane_id_by_offset(case),
                "{case:?}"
            );
        }
        // The oracle must actually discriminate, or the sweep proves nothing.
        assert!(cases.iter().any(|c| is_stable_pane_id_by_offset(c)));
        assert!(cases.iter().any(|c| !is_stable_pane_id_by_offset(c)));
    }
}
