//! Codex environment setup-script import, ported from
//! `src/shared/setup-script-import-codex-environment.ts`.
//!
//! Parses the hand-rolled minimal subset of TOML used by Codex environment
//! files (`.codex/environments/environment.toml`) to extract the `[setup]` and
//! `[cleanup]` `script = …` values (basic / literal / multiline strings), and
//! flags unsupported `actions` config. The file read is injected (the IO
//! boundary), so this stays pure and testable.

use crate::setup_script_import_limits::{
    is_setup_script_import_field_within_limit, push_setup_script_import_unsupported_field,
    utf16_len, SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES, SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS,
    SETUP_SCRIPT_IMPORT_MAX_TOML_LINES,
};
use crate::setup_script_imports::SetupScriptImportCandidate;

const CODEX_ENVIRONMENT_PATH: &str = ".codex/environments/environment.toml";

struct CodexEnvironmentToml {
    setup_script: Option<String>,
    cleanup_script: Option<String>,
    unsupported_fields: Vec<String>,
}

/// `read_file(path) -> Some(contents)` / `None`. Returns `Some(candidate)` only
/// when a non-empty `[setup]` script is present; the returned candidate always
/// carries a non-empty `setup`.
#[cfg_attr(trust_verify, trust::ensures(|out: &Option<SetupScriptImportCandidate>|
    out.as_ref().map_or(true, |candidate| !candidate.setup.is_empty())))]
pub fn inspect_codex_environment_config(
    read_file: &dyn Fn(&str) -> Option<String>,
) -> Option<SetupScriptImportCandidate> {
    // `!content` in TS treats both a missing file and an empty string as absent.
    let content = read_file(CODEX_ENVIRONMENT_PATH).filter(|text| !text.is_empty())?;

    let parsed = parse_codex_environment_toml(&content);
    let setup = normalize_codex_script(parsed.setup_script.as_deref());
    if setup.is_empty() {
        return None;
    }

    let archive = Some(normalize_codex_script(parsed.cleanup_script.as_deref()))
        .filter(|text| !text.is_empty());

    Some(SetupScriptImportCandidate {
        provider: "codex".to_string(),
        label: "Codex environment".to_string(),
        files: vec![CODEX_ENVIRONMENT_PATH.to_string()],
        setup,
        archive,
        unsupported_fields: parsed.unsupported_fields,
    })
}

/// `normalizeCodexScript` — an over-size script is dropped, not truncated.
fn normalize_codex_script(value: Option<&str>) -> String {
    match value {
        Some(text) if !text.is_empty() && is_setup_script_import_field_within_limit(text) => {
            text.trim().to_string()
        }
        _ => String::new(),
    }
}

fn parse_codex_environment_toml(content: &str) -> CodexEnvironmentToml {
    // Refuse to split a pathologically long file into a line vector at all.
    if count_toml_lines(content) > SETUP_SCRIPT_IMPORT_MAX_TOML_LINES {
        return CodexEnvironmentToml {
            setup_script: None,
            cleanup_script: None,
            unsupported_fields: Vec::new(),
        };
    }
    // `content.split(/\r?\n/)`: normalize CRLF then split on LF (a bare CR that
    // is not followed by LF is preserved, matching the regex).
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let mut unsupported_fields: Vec<String> = Vec::new();
    let mut section = String::new();
    let mut setup_script: Option<String> = None;
    let mut cleanup_script: Option<String> = None;

    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if matches_actions_assignment(trimmed) {
            push_setup_script_import_unsupported_field(
                &mut unsupported_fields,
                "actions".to_string(),
            );
        }
        if let Some(name) = parse_section_header(trimmed) {
            section = name.to_string();
            if section == "actions" || section.starts_with("actions.") {
                push_setup_script_import_unsupported_field(
                    &mut unsupported_fields,
                    format!("[{section}]"),
                );
            }
            index += 1;
            continue;
        }

        if section == "setup" || section == "cleanup" {
            if let Some(raw_value) = parse_script_assignment(line) {
                let parsed = parse_toml_string_value(&lines, index, raw_value);
                // Skip the lines a multiline string consumed.
                index = parsed.end_line_index;
                if section == "setup" {
                    setup_script = Some(parsed.value);
                } else {
                    cleanup_script = Some(parsed.value);
                }
            }
        }
        index += 1;
    }

    CodexEnvironmentToml { setup_script, cleanup_script, unsupported_fields }
}

/// `/^actions\s*=/` against the trimmed line.
fn matches_actions_assignment(trimmed: &str) -> bool {
    match trimmed.strip_prefix("actions") {
        Some(rest) => rest.trim_start().starts_with('='),
        None => false,
    }
}

/// `/^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/` — returns the section name on match.
fn parse_section_header(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix('[')?;
    let name_end = rest.find(|c: char| !is_section_char(c)).unwrap_or(rest.len());
    if name_end == 0 {
        return None;
    }
    let name = &rest[..name_end];
    let after = rest[name_end..].strip_prefix(']')?.trim_start();
    (after.is_empty() || after.starts_with('#')).then_some(name)
}

fn is_section_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

/// `/^\s*script\s*=\s*(.*)$/` against the raw line — returns the captured value.
fn parse_script_assignment(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix("script")?;
    let rest = rest.trim_start().strip_prefix('=')?;
    Some(rest.trim_start())
}

struct ParsedTomlValue {
    value: String,
    end_line_index: usize,
}

fn parse_toml_string_value(lines: &[&str], start_line_index: usize, raw_value: &str) -> ParsedTomlValue {
    let value = raw_value.trim_start();
    if value.starts_with("\"\"\"") || value.starts_with("'''") {
        let delimiter = if value.starts_with("\"\"\"") { "\"\"\"" } else { "'''" };
        return parse_toml_multiline_string(lines, start_line_index, &value[3..], delimiter);
    }
    if value.starts_with('"') {
        return ParsedTomlValue { value: parse_toml_basic_string(value), end_line_index: start_line_index };
    }
    if value.starts_with('\'') {
        return ParsedTomlValue { value: parse_toml_literal_string(value), end_line_index: start_line_index };
    }
    ParsedTomlValue { value: strip_inline_comment_and_trim(value), end_line_index: start_line_index }
}

/// Bounded accumulator for a multiline TOML script: a chunk that would push the
/// value past the field cap is refused, and the whole value is then abandoned
/// rather than truncated — matching upstream's `append`.
struct BoundedTomlScript {
    content: String,
    bytes: usize,
    code_units: usize,
}

impl BoundedTomlScript {
    fn new() -> Self {
        Self { content: String::new(), bytes: 0, code_units: 0 }
    }

    fn append(&mut self, value: &str) -> bool {
        let code_units = utf16_len(value);
        if self.code_units + code_units > SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS
            || self.bytes + value.len() > SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES
        {
            return false;
        }
        self.content.push_str(value);
        self.bytes += value.len();
        self.code_units += code_units;
        true
    }
}

fn parse_toml_multiline_string(
    lines: &[&str],
    start_line_index: usize,
    first_line_remainder: &str,
    delimiter: &str,
) -> ParsedTomlValue {
    let mut script = BoundedTomlScript::new();
    let mut oversized = false;
    let mut remainder = first_line_remainder;
    let mut index = start_line_index;
    while index < lines.len() {
        if index > start_line_index {
            remainder = lines[index];
        }
        if let Some(close_index) = remainder.find(delimiter) {
            if !oversized && !script.append(&remainder[..close_index]) {
                oversized = true;
            }
            return ParsedTomlValue {
                value: if oversized { String::new() } else { script.content },
                end_line_index: index,
            };
        }
        if !oversized && !script.append(&format!("{remainder}\n")) {
            oversized = true;
            script.content = String::new();
        }
        index += 1;
    }
    ParsedTomlValue {
        value: if oversized { String::new() } else { script.content.trim_end().to_string() },
        end_line_index: lines.len().saturating_sub(1),
    }
}

/// `countTomlLines` — stops as soon as the cap is exceeded.
fn count_toml_lines(content: &str) -> usize {
    let mut lines = 1usize;
    for byte in content.as_bytes() {
        if *byte == b'\n' {
            lines += 1;
            if lines > SETUP_SCRIPT_IMPORT_MAX_TOML_LINES {
                return lines;
            }
        }
    }
    lines
}

fn parse_toml_basic_string(value: &str) -> String {
    let close = find_toml_string_close(value, '"');
    let raw = &value[..close];
    // `JSON.parse(raw)` decodes the escapes; fall back to stripping the quotes.
    match serde_json::from_str::<String>(raw) {
        Ok(parsed) => parsed,
        Err(_) => drop_first_last_char(raw),
    }
}

fn parse_toml_literal_string(value: &str) -> String {
    let chars: Vec<(usize, char)> = value.char_indices().collect();
    let count = chars.len();
    // `findTomlStringEnd(value, "'")`: first `'` after index 0, else `length - 1`.
    let mut end_char_index = count.saturating_sub(1);
    let mut k = 1;
    while k < count {
        if chars[k].1 == '\'' {
            end_char_index = k;
            break;
        }
        k += 1;
    }
    let start_byte = chars.get(1).map_or(value.len(), |&(byte, _)| byte);
    let end_byte = chars.get(end_char_index).map_or(value.len(), |&(byte, _)| byte);
    if start_byte >= end_byte {
        return String::new();
    }
    value[start_byte..end_byte].to_string()
}

/// `value.slice(0, findTomlStringEnd(value, quote) + 1)` end offset (in bytes).
/// Always `<= value.len()`.
#[cfg_attr(trust_verify, trust::ensures(|out: &usize| *out <= value.len()))]
fn find_toml_string_close(value: &str, quote: char) -> usize {
    let chars: Vec<(usize, char)> = value.char_indices().collect();
    let mut k = 1;
    while k < chars.len() {
        let (byte_idx, c) = chars[k];
        if c == quote && (quote == '\'' || !is_escaped(&chars, k)) {
            return byte_idx + c.len_utf8();
        }
        k += 1;
    }
    value.len()
}

fn is_escaped(chars: &[(usize, char)], index: usize) -> bool {
    let mut slash_count = 0usize;
    let mut cursor = index;
    while cursor > 0 && chars[cursor - 1].1 == '\\' {
        slash_count += 1;
        cursor -= 1;
    }
    slash_count % 2 == 1
}

/// `value.replace(/\s+#.*$/, '').trim()` — drop the first inline comment
/// (whitespace-run followed by `#`) and trim.
fn strip_inline_comment_and_trim(value: &str) -> String {
    let mut run_start: Option<usize> = None;
    let mut cut: Option<usize> = None;
    for (i, c) in value.char_indices() {
        if c == '#' {
            if let Some(start) = run_start {
                cut = Some(start);
                break;
            }
        }
        if c.is_whitespace() {
            if run_start.is_none() {
                run_start = Some(i);
            }
        } else {
            run_start = None;
        }
    }
    match cut {
        Some(start) => value[..start].trim().to_string(),
        None => value.trim().to_string(),
    }
}

/// `raw.slice(1, -1)` — drop the first and last char (the surrounding quotes).
fn drop_first_last_char(value: &str) -> String {
    let mut chars = value.chars();
    chars.next();
    chars.next_back();
    chars.as_str().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reader(files: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<String> {
        move |path| {
            files
                .iter()
                .find(|(name, _)| *name == path)
                .map(|(_, content)| content.to_string())
        }
    }

    // Derived from `setup-script-imports.test.ts`
    // "imports setup and cleanup scripts from Codex environment config".
    #[test]
    fn imports_setup_and_cleanup_scripts() {
        let toml = "\n[setup]\nscript = \"\"\"\nnpm ci\npnpm build\n\"\"\"\n\n[cleanup]\nscript = \"pnpm clean\"\n\n[actions.test]\ncommand = \"pnpm test\"\n";
        let read = reader(vec![(".codex/environments/environment.toml", toml)]);
        assert_eq!(
            inspect_codex_environment_config(&read),
            Some(SetupScriptImportCandidate {
                provider: "codex".to_string(),
                label: "Codex environment".to_string(),
                files: vec![".codex/environments/environment.toml".to_string()],
                setup: "npm ci\npnpm build".to_string(),
                archive: Some("pnpm clean".to_string()),
                unsupported_fields: vec!["[actions.test]".to_string()],
            })
        );
    }

    // Derived from the "ignores malformed or setup-less configs" Codex case:
    // a `[cleanup]`-only file yields no candidate (no `[setup]` script).
    #[test]
    fn ignores_cleanup_only_config() {
        let read = reader(vec![(".codex/environments/environment.toml", "[cleanup]\nscript = \"pnpm clean\"")]);
        assert_eq!(inspect_codex_environment_config(&read), None);
    }

    #[test]
    fn ignores_missing_config() {
        let read = reader(vec![]);
        assert_eq!(inspect_codex_environment_config(&read), None);
    }

    fn inspect_owned(content: String) -> Option<SetupScriptImportCandidate> {
        let read = move |path: &str| {
            (path == CODEX_ENVIRONMENT_PATH).then(|| content.clone())
        };
        inspect_codex_environment_config(&read)
    }

    #[test]
    fn bounds_multiline_script_accumulation_at_the_exact_field_limit() {
        let exact = "x".repeat(SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS);
        assert_eq!(
            inspect_owned(format!("[setup]\nscript = \"\"\"{exact}\"\"\""))
                .map(|candidate| candidate.setup),
            Some(exact.clone())
        );
        assert_eq!(inspect_owned(format!("[setup]\nscript = \"\"\"{exact}x\"\"\"")), None);
    }

    #[test]
    fn bounds_toml_line_splitting_at_the_exact_line_limit() {
        let exact = format!(
            "[setup]\nscript = \"pnpm install\"{}",
            "\n".repeat(SETUP_SCRIPT_IMPORT_MAX_TOML_LINES - 2)
        );
        assert_eq!(
            inspect_owned(exact.clone()).map(|candidate| candidate.setup),
            Some("pnpm install".to_string())
        );
        assert_eq!(inspect_owned(format!("{exact}\n")), None);
    }
}
