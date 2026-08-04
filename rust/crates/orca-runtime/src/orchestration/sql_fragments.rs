//! SQL text assembled at runtime — bind-placeholder lists and the JSON string
//! arrays the store persists into TEXT columns. Shared so every domain builds
//! `IN (…)` filters and `'[]'` defaults the same way the TS store did.

/// `?,?,?` for an `IN (…)` clause of `n` bound values.
pub fn placeholders(n: usize) -> String {
    std::iter::repeat_n("?", n).collect::<Vec<_>>().join(",")
}

/// Encode `["a","b"]` for a JSON-array TEXT column (byte-identical to the TS
/// `JSON.stringify(items)`); used for gate `options`, worker `effects`, and
/// `residual_resources`.
pub fn json_string_array(items: &[&str]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

/// Encode an already-parsed JSON array for a TEXT column, falling back to `[]`
/// exactly as the TS `JSON.stringify(value ?? [])` paths do.
pub fn json_array_text(items: &[serde_json::Value]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

/// ` AND type IN (?,?)` — the optional message-type filter every mail read path
/// shares. Empty/absent types produce an empty fragment (no filter).
pub fn type_filter_clause(column: &str, types: Option<&[String]>) -> String {
    match types.filter(|t| !t.is_empty()) {
        Some(types) => format!(" AND {column} IN ({})", placeholders(types.len())),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_placeholder_and_filter_fragments() {
        assert_eq!(placeholders(0), "");
        assert_eq!(placeholders(3), "?,?,?");
        assert_eq!(json_string_array(&["a", "b"]), r#"["a","b"]"#);
        assert_eq!(json_string_array(&[]), "[]");
        assert_eq!(type_filter_clause("type", None), "");
        assert_eq!(type_filter_clause("type", Some(&[])), "");
        assert_eq!(
            type_filter_clause("m.type", Some(&["status".to_string(), "question".to_string()])),
            " AND m.type IN (?,?)"
        );
    }
}
