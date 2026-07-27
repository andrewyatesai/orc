//! Byte / cardinality bounds for setup-script import parsing — the Rust twin of
//! `src/shared/setup-script-import-limits.ts`.
//!
//! Upstream bounds untrusted agent-tool config parsing (OOM hardening) inside its
//! TS parsers; the fork parses in this crate instead, so the same bounds live
//! here. The whole-file cap stays at the TS IO edge (`setup-script-imports.ts`)
//! so no oversized blob ever crosses the dispatch seam.
//!
//! The TS caps count UTF-16 code units (JS `String#length`), so the code-unit
//! checks here sum `len_utf16` — not `chars().count()`, not `len()`.

pub const SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES: usize = 64 * 1024;
pub const SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS: usize = 64 * 1024;
pub const SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS: usize = 256;
pub const SETUP_SCRIPT_IMPORT_MAX_CMUX_COMMANDS: usize = 256;
pub const SETUP_SCRIPT_IMPORT_MAX_KEYWORDS: usize = 64;
pub const SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS: usize = 128;
pub const SETUP_SCRIPT_IMPORT_MAX_TOML_LINES: usize = 4_096;

/// JS `String#length` — UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `isSetupScriptImportFieldWithinLimit`: both the code-unit and the UTF-8 byte
/// cap must hold (a multibyte field can pass one and fail the other).
pub fn is_setup_script_import_field_within_limit(value: &str) -> bool {
    utf16_len(value) <= SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS
        && value.len() <= SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES
}

/// `pushSetupScriptImportUnsupportedField`: silently drops past the cap.
pub fn push_setup_script_import_unsupported_field(fields: &mut Vec<String>, value: String) {
    if fields.len() < SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS {
        fields.push(value);
    }
}

/// `normalizeSetupScriptImportCommand` for a single string: reject before
/// trimming on raw size, then re-check the trimmed result.
pub fn normalize_setup_script_import_command_string(value: &str) -> String {
    if utf16_len(value) > SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS {
        return String::new();
    }
    let trimmed = value.trim();
    if !trimmed.is_empty() && is_setup_script_import_field_within_limit(trimmed) {
        trimmed.to_string()
    } else {
        String::new()
    }
}

/// `joinSetupScriptImportCommands`: newline-join, bailing to empty as soon as the
/// accumulator would exceed the field cap (the accumulation is what OOMs).
pub fn join_setup_script_import_commands(parts: &[String]) -> String {
    let mut command = String::new();
    for part in parts {
        let next = if command.is_empty() { part.clone() } else { format!("{command}\n{part}") };
        if !is_setup_script_import_field_within_limit(&next) {
            return String::new();
        }
        command = next;
    }
    command
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
        let exact = "x".repeat(SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS);
        assert!(is_setup_script_import_field_within_limit(&exact));
        assert!(!is_setup_script_import_field_within_limit(&format!("{exact}x")));
    }

    #[test]
    fn rejects_a_multibyte_field_over_the_byte_cap_while_under_the_code_unit_cap() {
        let exact = "é".repeat(SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES / 2);
        assert!(is_setup_script_import_field_within_limit(&exact));
        let over = format!("{exact}é");
        assert!(utf16_len(&over) < SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS);
        assert!(!is_setup_script_import_field_within_limit(&over));
    }

    #[test]
    fn join_bails_to_empty_once_the_accumulator_exceeds_the_cap() {
        // Two halves plus the joining newline land exactly on the cap.
        let half = "x".repeat(SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS / 2 - 1);
        assert_eq!(
            join_setup_script_import_commands(&[half.clone(), half.clone()]).len(),
            SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS - 1
        );
        assert!(join_setup_script_import_commands(&[half.clone(), half.clone(), half]).is_empty());
    }

    #[test]
    fn unsupported_field_pushes_stop_at_the_cap() {
        let mut fields = Vec::new();
        for index in 0..SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS + 10 {
            push_setup_script_import_unsupported_field(&mut fields, index.to_string());
        }
        assert_eq!(fields.len(), SETUP_SCRIPT_IMPORT_MAX_UNSUPPORTED_FIELDS);
    }
}
