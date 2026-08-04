//! Pane-key identity: the remint-stable leaf behind a terminal handle. Ported
//! from `isEquivalentPaneKey` / `parsePaneKey` / `isStablePaneId`, and shared by
//! every domain that resolves an actor by pane rather than by handle (dispatch
//! contexts, runs, remote attachments, legacy compatibility principals).

/// Port of `parsePaneKey().leafId`: a pane key is `<tabId>:<leafId>` with a
/// single `:` and a stable-pane-id (v1-5 UUID) leaf; returns the leaf or None.
pub fn pane_key_leaf(key: &str) -> Option<&str> {
    let idx = key.find(':')?;
    if idx == 0 || key.rfind(':') != Some(idx) || idx + 1 >= key.len() {
        return None;
    }
    let leaf = &key[idx + 1..];
    is_stable_pane_id(leaf).then_some(leaf)
}

/// Port of `isStablePaneId` UUID_RE:
/// `[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`.
pub fn is_stable_pane_id(v: &str) -> bool {
    let b = v.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        14 => c.is_ascii_digit() && (b'1'..=b'5').contains(&c),
        19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
        _ => matches!(c, b'0'..=b'9' | b'a'..=b'f'),
    })
}

/// Port of `isEquivalentPaneKey`: identical keys, or the same stable leaf.
pub fn is_equivalent_pane_key(a: &str, b: &str) -> bool {
    a == b || matches!((pane_key_leaf(a), pane_key_leaf(b)), (Some(la), Some(lb)) if la == lb)
}

/// Port of `paneKeyMatchSuffix`: everything after the first `:` (or the whole
/// key when there is none). The JS-side half of the indexable pre-filter whose
/// SQL half is [`PANE_KEY_MATCH_SUFFIX_SQL`] — it narrows candidate rows, it does
/// not decide equivalence. Always confirm a hit with [`is_equivalent_pane_key`].
pub fn pane_key_match_suffix(pane_key: &str) -> &str {
    match pane_key.find(':') {
        Some(idx) => &pane_key[idx + 1..],
        None => pane_key,
    }
}

/// The SQL expression behind `idx_runs_coordinator_pane_leaf`; pair it with
/// [`pane_key_match_suffix`] as the bound parameter.
pub const PANE_KEY_MATCH_SUFFIX_SQL: &str =
    "substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1)";

#[cfg(test)]
mod tests {
    use super::*;

    const LEAF_A: &str = "0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
    const LEAF_B: &str = "1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d";

    #[test]
    fn equivalence_follows_the_leaf_across_a_tab_remint() {
        assert!(is_equivalent_pane_key(&format!("tab1:{LEAF_A}"), &format!("tab2:{LEAF_A}")));
        assert!(!is_equivalent_pane_key(&format!("tab1:{LEAF_A}"), &format!("tab1:{LEAF_B}")));
        // Unparseable keys fall back to exact match.
        assert!(is_equivalent_pane_key("legacy-key", "legacy-key"));
        assert!(!is_equivalent_pane_key("legacy-key", "other-key"));
    }

    #[test]
    fn match_suffix_mirrors_the_sql_prefilter() {
        assert_eq!(pane_key_match_suffix(&format!("tab1:{LEAF_A}")), LEAF_A);
        assert_eq!(pane_key_match_suffix("legacy-key"), "legacy-key");
    }
}
