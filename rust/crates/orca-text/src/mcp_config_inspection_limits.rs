//! MCP inspection bounds — the Rust twin of
//! `src/shared/mcp-config-inspection-limits.ts`.
//!
//! These are DoS bounds on parsing an untrusted `.mcp.json`, not cosmetics: they
//! cap the config text, the server cardinality, and every name/field the
//! inspector copies out of it.
//!
//! They live in `orca-text` rather than `orca-config` because `mcp_env` (the
//! twin of the bounded env walk in `mcp-server-inspection.ts`) needs them, and
//! the crate edge runs orca-config -> orca-text, never the reverse.
//!
//! Each cap is checked twice, exactly as the TS does: UTF-16 code units (JS
//! `String#length`) AND UTF-8 bytes. A multibyte value can pass one and fail the
//! other — 32 Ki `é` is 32 Ki code units but 64 Ki bytes.

pub const MCP_CONFIG_INSPECTION_MAX_BYTES: usize = 256 * 1024;
pub const MCP_CONFIG_INSPECTION_MAX_CODE_UNITS: usize = 256 * 1024;
pub const MCP_CONFIG_INSPECTION_MAX_SERVERS: usize = 256;
pub const MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS: usize = 256;
pub const MCP_CONFIG_INSPECTION_MAX_NAME_BYTES: usize = 4 * 1024;
pub const MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS: usize = 4 * 1024;
pub const MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES: usize = 64 * 1024;
pub const MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS: usize = 64 * 1024;

/// JS `String#length` — UTF-16 code units, not chars and not bytes.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `isTextWithinLimits`: both caps must hold.
fn within(value: &str, max_bytes: usize, max_code_units: usize) -> bool {
    // `value.len()` is the UTF-8 byte length, which is what
    // `measureUtf8ByteLength` sums for a well-formed string (a Rust `&str`
    // cannot hold the lone surrogate that would make the two differ).
    utf16_len(value) <= max_code_units && value.len() <= max_bytes
}

/// `isMcpConfigInspectionTextWithinLimit` — the whole config text.
pub fn is_mcp_config_inspection_text_within_limit(value: &str) -> bool {
    within(value, MCP_CONFIG_INSPECTION_MAX_BYTES, MCP_CONFIG_INSPECTION_MAX_CODE_UNITS)
}

/// `isMcpConfigInspectionNameWithinLimit` — a server name or an env key.
pub fn is_mcp_config_inspection_name_within_limit(value: &str) -> bool {
    within(value, MCP_CONFIG_INSPECTION_MAX_NAME_BYTES, MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS)
}

/// `isMcpConfigInspectionFieldWithinLimit` — a command, a URL, an env value.
pub fn is_mcp_config_inspection_field_within_limit(value: &str) -> bool {
    within(value, MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES, MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_utf16_code_units_not_chars() {
        assert_eq!(utf16_len("é"), 1);
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn admits_the_exact_field_size_and_rejects_plus_one() {
        let exact = "x".repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS);
        assert!(is_mcp_config_inspection_field_within_limit(&exact));
        assert!(!is_mcp_config_inspection_field_within_limit(&format!("{exact}x")));
    }

    #[test]
    fn rejects_a_multibyte_field_over_the_byte_cap_while_under_the_code_unit_cap() {
        let exact = "é".repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES / 2);
        assert!(is_mcp_config_inspection_field_within_limit(&exact));
        let over = format!("{exact}é");
        assert!(utf16_len(&over) < MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS);
        assert!(!is_mcp_config_inspection_field_within_limit(&over));
    }

    #[test]
    fn admits_the_exact_text_and_name_sizes_and_rejects_plus_one() {
        let text = " ".repeat(MCP_CONFIG_INSPECTION_MAX_BYTES);
        assert!(is_mcp_config_inspection_text_within_limit(&text));
        assert!(!is_mcp_config_inspection_text_within_limit(&format!("{text} ")));

        let name = "n".repeat(MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS);
        assert!(is_mcp_config_inspection_name_within_limit(&name));
        assert!(!is_mcp_config_inspection_name_within_limit(&format!("{name}n")));
    }
}
