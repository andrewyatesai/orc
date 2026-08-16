//! Model-discovery parsers for commit-message agents, ported from the parser
//! half of `src/shared/commit-message-agent-spec.ts`.
//!
//! Each agent CLI lists its models differently — Codex emits JSON, others one
//! id per line, Pi a whitespace table, Cursor `id - Label` lines. These parse
//! that stdout into the unified `CommitMessageModel` shape (with thinking-effort
//! levels where the model supports them). The per-agent spec table + `buildArgs`
//! are a separate, larger port.
//!
//! A parsed `id` becomes the PERSISTED user selection and the next `--model`
//! argv, so a divergence here ships the wrong model to the wrong agent. The
//! Codex parser is the one that reads untyped JSON, and it is served at the seam
//! as [`parse_codex_models_value`] — the JSON the twin actually returns —
//! because the twin never schema-checks that payload. [`parse_codex_models`] is
//! the narrowed typed view for Rust callers.
//!
//! ONE RESIDUAL, and it is a representational boundary rather than a choice: JS
//! `JSON.parse` accepts a lone-surrogate escape (`"\ud800"`) and yields a string
//! no Rust `String` can hold, so `serde_json` rejects the document and this core
//! answers `[]` where the twin answers a model. It has to be answered locally at
//! the seam, and the shim's `DispatchPayloadError` catch does NOT cover it — the
//! stdout itself is plain ASCII and encodes fine; only the PARSED value is
//! unrepresentable. Pinned by
//! `a_lone_surrogate_escape_is_a_representational_boundary_not_a_parse`.

use crate::json_text_structure_limit::json_text_structure_within_limits;
use orca_core::js_string::{trim_js, utf16_len};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

/// `COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS` in the twin.
const CODEX_STRUCTURAL_TOKEN_LIMIT: usize = 64 * 1024;
const CODEX_NESTING_DEPTH_LIMIT: usize = 16;

/// The ECMAScript `\s` set (WhiteSpace + LineTerminator), spelled out as regex
/// class members. The `regex` crate's `\s` is Unicode `White_Space`, which
/// disagrees with JS on U+FEFF (JS: whitespace, Rust: not) and U+0085 (Rust:
/// whitespace, JS: not) — a cursor listing separated by a BOM parsed in the twin
/// and vanished in Rust.
const JS_WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// JS `.` (no `s` flag) excludes all four LineTerminators; the `regex` crate's
/// excludes only `\n`.
const JS_DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThinkingLevel {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitMessageModel {
    pub id: String,
    pub label: String,
    pub thinking_levels: Option<Vec<ThinkingLevel>>,
    pub default_thinking_level: Option<String>,
}

fn level(id: &str, label: &str) -> ThinkingLevel {
    ThinkingLevel { id: id.to_string(), label: label.to_string() }
}

pub(crate) fn openai_thinking_levels() -> Vec<ThinkingLevel> {
    vec![level("low", "Low"), level("medium", "Medium"), level("high", "High"), level("xhigh", "Extra High")]
}

fn pi_thinking_levels() -> Vec<ThinkingLevel> {
    vec![
        level("off", "Off"),
        level("low", "Low"),
        level("medium", "Medium"),
        level("high", "High"),
        level("xhigh", "Extra High"),
    ]
}

/// `part.charAt(0).toUpperCase() + part.slice(1)`. `charAt(0)` is a UTF-16 code
/// unit, so an astral first char yields a LONE SURROGATE, which uppercases to
/// itself — the twin returns such a part unchanged where `char::to_uppercase`
/// would case-map the whole scalar (Deseret `U+10428` -> `U+10400`).
fn capitalize_first_js(part: &str) -> String {
    match part.chars().next() {
        None => String::new(),
        Some(first) if first.len_utf16() == 2 => part.to_string(),
        Some(first) => first.to_uppercase().collect::<String>() + &part[first.len_utf8()..],
    }
}

/// Turn a model/provider id into a display label: split on `/` and `-`,
/// upper-case `gpt` and short numeric parts, capitalize the rest.
pub(crate) fn label_from_model_id(id: &str) -> String {
    id.split(['/', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                return "GPT".to_string();
            }
            let starts_with_digit = part.chars().next().is_some_and(|c| c.is_ascii_digit());
            // `part.length <= 3` counts UTF-16 units: "1𝟚𝟚" is 5 to the twin.
            if utf16_len(part) <= 3 && starts_with_digit {
                part.to_uppercase()
            } else {
                capitalize_first_js(part)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// OpenAI-family models (`gpt-5*`, `codex`) expose the standard effort levels.
pub(crate) fn with_openai_thinking(id: &str) -> (Option<Vec<ThinkingLevel>>, Option<String>) {
    let lowered = id.to_lowercase();
    if lowered.contains("gpt-5") || lowered.contains("codex") {
        (Some(openai_thinking_levels()), Some("low".to_string()))
    } else {
        (None, None)
    }
}

fn unique_models(models: Vec<CommitMessageModel>) -> Vec<CommitMessageModel> {
    let mut seen: HashSet<String> = HashSet::new();
    models.into_iter().filter(|model| !model.id.is_empty() && seen.insert(model.id.clone())).collect()
}

/// `iterateModelOutputLines` — CR, LF and CRLF each end a line, so a listing
/// with classic-Mac endings splits into rows instead of arriving as one row.
/// (`split('\n')` + strip trailing `\r` keeps `a\rb` whole, which the twin does
/// not.) The final segment is always emitted, matching the twin's trailing
/// `lineStart <= output.length` yield.
pub(crate) fn model_output_lines(stdout: &str) -> Vec<&str> {
    let bytes = stdout.as_bytes();
    let mut lines = Vec::new();
    let mut line_start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        let code = bytes[index];
        if code != b'\n' && code != b'\r' {
            index += 1;
            continue;
        }
        lines.push(&stdout[line_start..index]);
        if code == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            index += 1;
        }
        index += 1;
        line_start = index;
    }
    lines.push(&stdout[line_start..]);
    lines
}

/// `Boolean(value)` for a parsed JSON value.
fn is_js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value.length` under JS truthiness, through the twin's optional chain
/// (`supported_reasoning_levels?.length`). Only strings and arrays have a real
/// `length`; a plain object has one exactly when the payload carries that key,
/// and numbers/bools/null have none — which is the branch that decides whether
/// `.map` is ever reached.
fn js_length_is_truthy(value: &Value) -> bool {
    match value {
        Value::Array(items) => !items.is_empty(),
        Value::String(text) => !text.is_empty(),
        Value::Object(map) => map.get("length").is_some_and(is_js_truthy),
        _ => false,
    }
}

/// `Boolean(model[key])` — JS truthiness on an untyped field, which is what the
/// twin's `.filter((model) => model.slug && model.display_name)` tests. NOT
/// `as_str().is_some()`: `slug: 5` is truthy in JS and keeps the entry.
fn js_truthy_field(model: &Value, key: &str) -> bool {
    model.get(key).is_some_and(is_js_truthy)
}

/// True where the twin's `.map` over THIS (already filter-surviving) entry
/// throws, taking the whole `parseCodexModels` call to `[]` via its outer catch.
fn codex_map_throws(model: &Value) -> bool {
    let Some(reasoning) = model.get("supported_reasoning_levels") else {
        return false;
    };
    if !js_length_is_truthy(reasoning) {
        return false;
    }
    // `.length` was truthy, so `.map` runs next — and only an array has one. A
    // string, or an object carrying a `length` key, is a TypeError.
    let Some(levels) = reasoning.as_array() else {
        return true;
    };
    levels.iter().any(|item| {
        // `level.effort` on a JSON null is a TypeError before any label work.
        item.is_null()
            // A truthy non-string `effort` survives `.filter(Boolean)` and reaches
            // `labelFromModelId`, which calls `.split` on it.
            || item
                .get("effort")
                .is_some_and(|effort| is_js_truthy(effort) && !effort.is_string())
    })
}

/// `Set.prototype.has` (SameValueZero), the comparison behind `uniqueModels`.
/// Objects and arrays compare by REFERENCE in JS, and two entries parsed from
/// different positions are never the same reference — so a structured id never
/// dedupes another one, however equal it looks.
fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(p), Some(q)) => p == q,
            _ => x == y,
        },
        _ => false,
    }
}

/// `parseCodexModels` as the JSON the twin actually returns.
///
/// `codex debug models` output is untyped and the twin never schema-checks it:
/// it filters on JS truthiness and copies `slug` / `display_name` /
/// `default_reasoning_level` through verbatim, so a non-string field yields a
/// non-string `id` / `label` / `defaultThinkingLevel` that no `String` field can
/// hold. The dispatch seam serves this value; [`parse_codex_models`] is the
/// narrowed typed view for Rust callers.
pub fn parse_codex_models_value(stdout: &str) -> Value {
    let empty = || Value::Array(Vec::new());
    // The twin asserts the structural budget BEFORE JSON.parse and returns []
    // when it throws; without this a 20-deep payload parsed here and not there.
    if !json_text_structure_within_limits(stdout, CODEX_STRUCTURAL_TOKEN_LIMIT, CODEX_NESTING_DEPTH_LIMIT) {
        return empty();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(stdout) else {
        return empty();
    };
    // The twin's whole body is inside one try/catch, so a payload that makes it
    // throw yields [] — never a partial list. Rust cannot throw, so each throwing
    // shape is detected at the point the twin reaches it, in the twin's order.
    //
    // `parsed.models` on a `null` parse is itself a TypeError.
    if parsed.is_null() {
        return empty();
    }
    let models = match parsed.get("models") {
        // `?? []` — absent or null both become an empty list, never a throw.
        None | Some(Value::Null) => return empty(),
        Some(value) => value,
    };
    // `.filter` exists only on an array; a string/object/number `models` throws.
    let Some(models) = models.as_array() else {
        return empty();
    };
    // The filter DEREFERENCES every element, so one JSON null anywhere in the
    // listing throws before a single model is mapped.
    if models.iter().any(Value::is_null) {
        return empty();
    }
    // The map runs over SURVIVORS only. An entry the filter dropped — no slug, or
    // an empty one — can never throw, however malformed its reasoning levels are:
    // scanning it too turned one junk entry into a wiped model list.
    let survivors: Vec<&Value> = models
        .iter()
        .filter(|model| js_truthy_field(model, "slug") && js_truthy_field(model, "display_name"))
        .collect();
    if survivors.iter().copied().any(codex_map_throws) {
        return empty();
    }

    // `uniqueModels`, inlined so the id keeps its JSON type. Its `!model.id` arm
    // is dead here — the filter above already required a truthy slug. String ids
    // go in a set because a listing can hold thousands within the token budget;
    // the rare structured id falls back to a scan it can never match anyway.
    let mut seen_ids: HashSet<&str> = HashSet::new();
    let mut seen_other_ids: Vec<&Value> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for model in survivors {
        let id = model.get("slug").expect("a survivor has a truthy slug");
        let duplicate = match id {
            Value::String(text) => !seen_ids.insert(text.as_str()),
            other => {
                let seen = seen_other_ids.iter().any(|prev| same_value_zero(prev, other));
                if !seen {
                    seen_other_ids.push(other);
                }
                seen
            }
        };
        if duplicate {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("id".to_string(), id.clone());
        entry.insert(
            "label".to_string(),
            model.get("display_name").cloned().unwrap_or(Value::Null),
        );
        if model.get("supported_reasoning_levels").is_some_and(js_length_is_truthy) {
            let levels = model
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .expect("codex_map_throws returns true for a non-array with a truthy length");
            let thinking: Vec<Value> = levels
                .iter()
                .filter_map(|item| item.get("effort"))
                .filter(|effort| is_js_truthy(effort))
                .map(|effort| {
                    let effort = effort
                        .as_str()
                        .expect("codex_map_throws returns true for a truthy non-string effort");
                    let mut level = Map::new();
                    level.insert("id".to_string(), Value::String(effort.to_string()));
                    level.insert(
                        "label".to_string(),
                        Value::String(if effort == "xhigh" {
                            "Extra High".to_string()
                        } else {
                            label_from_model_id(effort)
                        }),
                    );
                    Value::Object(level)
                })
                .collect();
            entry.insert("thinkingLevels".to_string(), Value::Array(thinking));
            // `?? 'low'` is NULLISH, not falsy: `false` and `0` are kept verbatim.
            entry.insert(
                "defaultThinkingLevel".to_string(),
                match model.get("default_reasoning_level") {
                    None | Some(Value::Null) => Value::String("low".to_string()),
                    Some(value) => value.clone(),
                },
            );
        }
        out.push(Value::Object(entry));
    }
    Value::Array(out)
}

/// The typed view of [`parse_codex_models_value`], for Rust callers that hold a
/// `CommitMessageModel`. An out-of-contract listing entry — one whose `slug`,
/// `display_name` or `default_reasoning_level` is not a string — has no typed
/// representation and is dropped HERE, never at the seam, which serves the
/// untyped value.
pub fn parse_codex_models(stdout: &str) -> Vec<CommitMessageModel> {
    let parsed = parse_codex_models_value(stdout);
    let entries = parsed.as_array().map(Vec::as_slice).unwrap_or_default();
    entries
        .iter()
        .filter_map(|entry| {
            let default_thinking_level = match entry.get("defaultThinkingLevel") {
                None => None,
                Some(value) => Some(value.as_str()?.to_string()),
            };
            let thinking_levels = entry.get("thinkingLevels").and_then(Value::as_array).map(|levels| {
                levels
                    .iter()
                    .map(|level| ThinkingLevel {
                        id: level.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                        label: level
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                    .collect()
            });
            Some(CommitMessageModel {
                id: entry.get("id")?.as_str()?.to_string(),
                label: entry.get("label")?.as_str()?.to_string(),
                thinking_levels,
                default_thinking_level,
            })
        })
        .collect()
}

pub fn parse_line_models(stdout: &str) -> Vec<CommitMessageModel> {
    let mapped = model_output_lines(stdout)
        .into_iter()
        .map(trim_js)
        .filter(|line| !line.is_empty() && !line.contains(' '))
        .map(|id| {
            let (thinking_levels, default_thinking_level) = with_openai_thinking(id);
            CommitMessageModel {
                id: id.to_string(),
                label: label_from_model_id(id),
                thinking_levels,
                default_thinking_level,
            }
        })
        .collect();
    unique_models(mapped)
}

pub fn parse_pi_models(stdout: &str) -> Vec<CommitMessageModel> {
    let mapped = model_output_lines(stdout)
        .into_iter()
        .map(|line| pi_model_table_fields(line, 6))
        .filter(|parts| parts.len() >= 6 && parts[0] != "provider")
        .map(|parts| {
            let (provider, model, thinking) = (parts[0], parts[1], parts[4]);
            let (thinking_levels, default_thinking_level) = if thinking == "yes" {
                (Some(pi_thinking_levels()), Some("low".to_string()))
            } else {
                (None, None)
            };
            CommitMessageModel {
                id: format!("{provider}/{model}"),
                label: format!("{} {}", label_from_model_id(provider), label_from_model_id(model)),
                thinking_levels,
                default_thinking_level,
            }
        })
        .collect();
    unique_models(mapped)
}

/// The twin's `isPiModelTableWhitespace` — an explicit code list, NOT
/// `char::is_whitespace`: it includes U+FEFF and excludes U+0085, the exact
/// inverse of Rust's set on those two codepoints.
fn is_pi_table_whitespace(character: char) -> bool {
    matches!(
        character as u32,
        32 | 9..=13 | 160 | 5760 | 8192..=8202 | 8232 | 8233 | 8239 | 8287 | 12288 | 65279
    )
}

/// `getPiModelTableFields` — only the first `max_fields` columns are read, so a
/// paste-sized noisy row costs a bounded scan.
fn pi_model_table_fields(line: &str, max_fields: usize) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut token_start: Option<usize> = None;
    for (index, character) in line.char_indices() {
        if !is_pi_table_whitespace(character) {
            if token_start.is_none() {
                token_start = Some(index);
            }
            continue;
        }
        if let Some(start) = token_start.take() {
            fields.push(&line[start..index]);
            if fields.len() >= max_fields {
                return fields;
            }
        }
    }
    if let Some(start) = token_start {
        fields.push(&line[start..]);
    }
    fields
}

pub fn parse_cursor_models(stdout: &str) -> Vec<CommitMessageModel> {
    let mapped = model_output_lines(stdout)
        .into_iter()
        .map(trim_js)
        .filter_map(|line| cursor_line_re().captures(line))
        .map(|captures| {
            let id = captures.get(1).map_or("", |m| m.as_str());
            let raw_label = captures.get(2).map_or("", |m| m.as_str());
            let (thinking_levels, default_thinking_level) = with_openai_thinking(id);
            CommitMessageModel {
                id: id.to_string(),
                label: cursor_default_re().replace(raw_label, "").into_owned(),
                thinking_levels,
                default_thinking_level,
            }
        })
        .collect();
    unique_models(mapped)
}

/// `/^([^\s]+)\s+-\s+(.+)$/` under ECMAScript `\s` and `.` semantics.
fn cursor_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!("^([^{JS_WS}]+)[{JS_WS}]+-[{JS_WS}]+({JS_DOT}+)$")).expect("static")
    })
}

/// `/\s+\((?:default|current)\)$/i` under ECMAScript `\s`.
fn cursor_default_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(r"(?i)[{JS_WS}]+\((?:default|current)\)$")).expect("static")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(id: &str, label: &str) -> CommitMessageModel {
        CommitMessageModel { id: id.to_string(), label: label.to_string(), thinking_levels: None, default_thinking_level: None }
    }

    fn model_with_thinking(id: &str, label: &str, levels: Vec<ThinkingLevel>, default: &str) -> CommitMessageModel {
        CommitMessageModel {
            id: id.to_string(),
            label: label.to_string(),
            thinking_levels: Some(levels),
            default_thinking_level: Some(default.to_string()),
        }
    }

    #[test]
    fn parses_codex_model_json() {
        let stdout = r#"{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]}]}"#;
        assert_eq!(
            parse_codex_models(stdout),
            vec![model_with_thinking(
                "gpt-5.5",
                "GPT-5.5",
                vec![level("low", "Low"), level("high", "High")],
                "low",
            )]
        );
    }

    #[test]
    fn parses_one_model_per_line_output() {
        assert_eq!(
            parse_line_models("opencode/gpt-5.4-mini\n\nopenai/gpt-5.5\n")
                .into_iter()
                .map(|m| m.id)
                .collect::<Vec<_>>(),
            vec!["opencode/gpt-5.4-mini".to_string(), "openai/gpt-5.5".to_string()]
        );
    }

    #[test]
    fn parses_pi_model_table_output_with_provider_qualified_ids() {
        let output = [
            "provider        model                   context  max-out  thinking  images",
            "github-copilot  gpt-5.4-mini            400K     128K     yes       yes",
            "github-copilot  gpt-4o                  128K     4.1K     no        yes",
        ]
        .join("\n");
        assert_eq!(
            parse_pi_models(&output),
            vec![
                model_with_thinking(
                    "github-copilot/gpt-5.4-mini",
                    "Github Copilot GPT 5.4 Mini",
                    pi_thinking_levels(),
                    "low",
                ),
                model("github-copilot/gpt-4o", "Github Copilot GPT 4O"),
            ]
        );
    }

    #[test]
    fn parses_cursor_model_output() {
        assert_eq!(
            parse_cursor_models("auto - Auto\ngpt-5.2 - GPT-5.2\n"),
            vec![
                model("auto", "Auto"),
                model_with_thinking("gpt-5.2", "GPT-5.2", openai_thinking_levels(), "low"),
            ]
        );
    }

    // ─── Twin test: "rejects excessive Codex model nesting before JSON.parse" ──

    #[test]
    fn rejects_excessive_codex_model_nesting_before_json_parse() {
        // The bare `[[[…0…]]]` payload of the twin's own test cannot see this
        // guard — it has no `models` key, so an UNGUARDED parse also answers [].
        // These carry a valid model past the budget, so removing the structural
        // pre-scan turns each assertion red.
        let deep = format!("{}0{}", "[".repeat(20), "]".repeat(20));
        assert_eq!(
            parse_codex_models(&format!(
                r#"{{"models":[{{"slug":"a","display_name":"A","deep":{deep}}}]}}"#
            )),
            Vec::new()
        );
        let pad = format!("[{}1]", "1,".repeat(70_000));
        assert_eq!(
            parse_codex_models(&format!(
                r#"{{"models":[{{"slug":"a","display_name":"A","pad":{pad}}}]}}"#
            )),
            Vec::new()
        );
        // Just inside both budgets, the same shape still yields its model.
        let shallow = format!("{}0{}", "[".repeat(12), "]".repeat(12));
        assert_eq!(
            parse_codex_models(&format!(
                r#"{{"models":[{{"slug":"a","display_name":"A","deep":{shallow}}}]}}"#
            )),
            vec![model("a", "A")]
        );
    }

    // ─── The four classes a HEAD-twin differential over raw `codex debug models`
    //     stdout found diverging. Every golden below is what
    //     `git show HEAD:src/shared/commit-message-agent-spec.ts` ANSWERS for that
    //     input (run, not transcribed — see the same cases in
    //     tools/parity/vectors/commit-message-models.json), and every one of them
    //     was watched failing against the core that shipped before this fix. ───

    /// CLASS 1 — the twin's `.filter` dereferences EVERY element, so one JSON
    /// `null` in the listing is a TypeError before a single model is mapped.
    #[test]
    fn a_null_listing_entry_throws_in_the_filter_stage() {
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":"a","display_name":"A"},null]}"#),
            json!([])
        );
        assert_eq!(parse_codex_models_value(r#"{"models":[null]}"#), json!([]));
        // A non-null non-object is only filtered out — reading `.slug` off it is fine.
        assert_eq!(
            parse_codex_models_value(r#"{"models":[5,"x",true,[],{"slug":"a","display_name":"A"}]}"#),
            json!([{ "id": "a", "label": "A" }])
        );
    }

    /// CLASS 2 — the `.map` runs over SURVIVORS only. Throw-checking an entry the
    /// filter dropped turned one junk listing row into a WIPED model list, which
    /// `finalizeModelDiscoveryOutput` then replaces with the static catalog — a
    /// different model than the user picked.
    #[test]
    fn an_entry_the_filter_drops_can_never_throw() {
        let good = json!([{ "id": "a", "label": "A" }]);
        // No slug at all.
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A"},{"supported_reasoning_levels":[{"effort":9}]}]}"#
            ),
            good
        );
        // Empty slug (falsy).
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A"},{"slug":"","display_name":"B","supported_reasoning_levels":"abc"}]}"#
            ),
            good
        );
        // Empty display_name (falsy).
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A"},{"slug":"b","display_name":"","supported_reasoning_levels":[{"effort":9}]}]}"#
            ),
            good
        );
        // But an entry that SURVIVES the filter still throws for everyone.
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A"},{"slug":"b","display_name":"B","supported_reasoning_levels":[{"effort":9}]}]}"#
            ),
            json!([])
        );
    }

    /// CLASS 3 — shapes that throw in the twin's `.map` and were not detected:
    /// a non-array with a truthy `.length` (no `.map`), and a `null` element
    /// (`level.effort` on null).
    #[test]
    fn undetected_throwing_reasoning_level_shapes() {
        for levels in [r#"{"length":2}"#, r#"{"length":"x"}"#, r#"{"length":[]}"#] {
            assert_eq!(
                parse_codex_models_value(&format!(
                    r#"{{"models":[{{"slug":"a","display_name":"A","supported_reasoning_levels":{levels}}}]}}"#
                )),
                json!([]),
                "a truthy .length on a non-array reaches .map, which it does not have: {levels}"
            );
        }
        // A falsy `.length` never reaches `.map`, so both keys are simply omitted.
        for levels in [r#"{"length":0}"#, r#"{"length":null}"#, "{}", "5", "true", r#""""#] {
            assert_eq!(
                parse_codex_models_value(&format!(
                    r#"{{"models":[{{"slug":"a","display_name":"A","supported_reasoning_levels":{levels}}}]}}"#
                )),
                json!([{ "id": "a", "label": "A" }]),
                "falsy length must omit both thinking keys: {levels}"
            );
        }
        // `level.effort` on a null element is a TypeError, wherever it sits.
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[null]}]}"#
            ),
            json!([])
        );
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[{"effort":"low"},null]}]}"#
            ),
            json!([])
        );
    }

    /// CLASS 4 — `codex debug models` output is untyped and the twin never
    /// schema-checks it: it filters on JS TRUTHINESS and copies the field through,
    /// so a non-string `slug` is a non-string `id`. `Value::as_str` dropped the
    /// whole entry — the `is_some()`-for-truthiness idiom in its `as_str` form.
    #[test]
    fn untyped_listing_fields_cross_verbatim() {
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":5,"display_name":"Five"}]}"#),
            json!([{ "id": 5, "label": "Five" }])
        );
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":true,"display_name":"T"}]}"#),
            json!([{ "id": true, "label": "T" }])
        );
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":"a","display_name":7}]}"#),
            json!([{ "id": "a", "label": 7 }])
        );
        // Falsy stays filtered: 0, "" and false are not ids.
        assert_eq!(parse_codex_models_value(r#"{"models":[{"slug":0,"display_name":"Z"}]}"#), json!([]));
        // `"0"` is a truthy STRING and survives.
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":"0","display_name":"Zero"}]}"#),
            json!([{ "id": "0", "label": "Zero" }])
        );
        // A non-string slug still SURVIVES the filter, so its levels are still
        // reached and can still throw for the whole call.
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":5,"display_name":"A","supported_reasoning_levels":"abc"}]}"#
            ),
            json!([])
        );
        // The typed view is the only place the entry is dropped.
        assert_eq!(parse_codex_models(r#"{"models":[{"slug":5,"display_name":"Five"}]}"#), Vec::new());
    }

    /// CLASS 4b — `?? 'low'` is NULLISH coalescing, so `false`, `0` and `""` are
    /// kept; `as_str().unwrap_or("low")` silently rewrote them to `"low"`.
    #[test]
    fn default_reasoning_level_is_nullish_coalesced_not_string_coerced() {
        let with = |default: &str| {
            parse_codex_models_value(&format!(
                r#"{{"models":[{{"slug":"a","display_name":"A","default_reasoning_level":{default},"supported_reasoning_levels":[{{"effort":"low"}}]}}]}}"#
            ))
        };
        let expect = |default: Value| {
            json!([{
                "id": "a",
                "label": "A",
                "thinkingLevels": [{ "id": "low", "label": "Low" }],
                "defaultThinkingLevel": default,
            }])
        };
        assert_eq!(with("3"), expect(json!(3)));
        assert_eq!(with("false"), expect(json!(false)));
        assert_eq!(with(r#""""#), expect(json!("")));
        // Only absent/null fall back.
        assert_eq!(with("null"), expect(json!("low")));
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[{"effort":"low"}]}]}"#
            ),
            expect(json!("low"))
        );
    }

    /// `uniqueModels` dedupes through a JS `Set` (SameValueZero), which compares
    /// objects and arrays by REFERENCE — two entries parsed from different
    /// positions are never the same reference, so a structured id never dedupes
    /// another one however equal it looks.
    #[test]
    fn unique_models_dedupes_by_same_value_zero() {
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":"a","display_name":"A"},{"slug":"a","display_name":"B"}]}"#
            ),
            json!([{ "id": "a", "label": "A" }])
        );
        // `5` and `5.0` are one number in JS.
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":5,"display_name":"A"},{"slug":5.0,"display_name":"B"}]}"#),
            json!([{ "id": 5, "label": "A" }])
        );
        // `5` and `"5"` are not.
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":5,"display_name":"A"},{"slug":"5","display_name":"B"}]}"#),
            json!([{ "id": 5, "label": "A" }, { "id": "5", "label": "B" }])
        );
        // Two equal-looking object ids are two references, so both survive.
        assert_eq!(
            parse_codex_models_value(
                r#"{"models":[{"slug":{"x":1},"display_name":"A"},{"slug":{"x":1},"display_name":"B"}]}"#
            ),
            json!([{ "id": { "x": 1 }, "label": "A" }, { "id": { "x": 1 }, "label": "B" }])
        );
    }

    /// THE ONE RESIDUAL, pinned so nobody "fixes" it by lossy replacement.
    /// JS `JSON.parse` accepts a lone-surrogate escape and yields a string no
    /// Rust `String` can hold (the same boundary `slice_utf16` documents), so
    /// `serde_json` rejects the document and the core answers `[]` where the twin
    /// answers a model. Out of contract for the core: it has to be answered
    /// locally at the seam, and the shim's `DispatchPayloadError` catch does NOT
    /// see it — the stdout itself is plain ASCII and encodes fine.
    #[test]
    fn a_lone_surrogate_escape_is_a_representational_boundary_not_a_parse() {
        // Twin: [{ id: "\ud800x", label: "A" }].
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":"\ud800x","display_name":"A"}]}"#),
            json!([])
        );
        // A well-formed pair is fine, so this is the lone half and nothing wider.
        assert_eq!(
            parse_codex_models_value(r#"{"models":[{"slug":"𐐨","display_name":"D"}]}"#),
            json!([{ "id": "\u{10428}", "label": "D" }])
        );
    }

    #[test]
    fn codex_payloads_that_make_the_twin_throw_yield_no_models() {
        // labelFromModelId(9) is a TypeError, and the twin's outer catch turns
        // the WHOLE call into [] — not a model with an empty level list.
        assert_eq!(
            parse_codex_models(
                r#"{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[{"effort":9}]}]}"#
            ),
            Vec::new()
        );
        // `.map` over a non-empty string also throws.
        assert_eq!(
            parse_codex_models(
                r#"{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":"abc"}]}"#
            ),
            Vec::new()
        );
        // A falsy effort is filtered out before it can throw.
        assert_eq!(
            parse_codex_models(
                r#"{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[{"effort":0}]}]}"#
            ),
            vec![model_with_thinking("a", "A", vec![], "low")]
        );
    }

    // ─── Twin test: "parses CRLF-heavy dynamic model outputs" ─────────────────

    #[test]
    fn parses_crlf_heavy_dynamic_model_outputs() {
        let noise = "ignored model with spaces\r\n".repeat(10_000);
        assert_eq!(
            parse_line_models(&format!("{noise}opencode/gpt-5.4-mini\r\nopenai/gpt-5.5\r\n")),
            vec![
                model_with_thinking(
                    "opencode/gpt-5.4-mini",
                    "Opencode GPT 5.4 Mini",
                    openai_thinking_levels(),
                    "low",
                ),
                model_with_thinking(
                    "openai/gpt-5.5",
                    "Openai GPT 5.5",
                    openai_thinking_levels(),
                    "low",
                ),
            ]
        );
        assert_eq!(
            parse_pi_models(&format!(
                "{noise}provider model context max-out thinking images\r\ngithub-copilot gpt-5.4-mini 400K 128K yes yes\r\n"
            ))[0]
                .id,
            "github-copilot/gpt-5.4-mini"
        );
        assert_eq!(
            parse_cursor_models(&format!("{noise}auto - Auto\r\ngpt-5.2 - GPT-5.2\r\n")).len(),
            2
        );
    }

    // ─── JS-string equivalence regressions ───────────────────────────────────

    #[test]
    fn trims_the_js_whitespace_set_not_the_rust_one() {
        // U+FEFF: JS `.trim()` strips it, `str::trim` does not — the id is the
        // persisted `--model` argument, so keeping the BOM ships a wrong flag.
        assert_eq!(parse_line_models("\u{FEFF}gpt-5.5\n")[0].id, "gpt-5.5");
        assert_eq!(parse_line_models("gpt-5.5\u{FEFF}\n")[0].id, "gpt-5.5");
        // U+0085 (NEL): `str::trim` strips it, JS does not.
        assert_eq!(parse_line_models("\u{0085}gpt-5.5\n")[0].id, "\u{0085}gpt-5.5");
    }

    #[test]
    fn treats_a_lone_cr_as_a_line_separator() {
        assert_eq!(
            parse_line_models("alpha\rbeta\r").into_iter().map(|m| m.id).collect::<Vec<_>>(),
            vec!["alpha".to_string(), "beta".to_string()]
        );
    }

    #[test]
    fn pi_table_columns_use_the_twins_whitespace_table() {
        // U+FEFF separates columns for the twin; `split_whitespace` keeps it glued.
        assert_eq!(
            parse_pi_models("github-copilot\u{FEFF}gpt-5.4-mini 400K 128K yes yes\n")[0].id,
            "github-copilot/gpt-5.4-mini"
        );
        // U+0085 does NOT separate columns for the twin, so the row is short.
        assert_eq!(parse_pi_models("a\u{0085}b c d yes f\n"), Vec::new());
    }

    #[test]
    fn cursor_regex_uses_ecmascript_whitespace_and_dot() {
        assert_eq!(
            parse_cursor_models("gpt-5.2\u{FEFF}-\u{FEFF}GPT-5.2\n")[0].id,
            "gpt-5.2"
        );
        // U+0085 is not JS whitespace, so the line does not match at all.
        assert_eq!(parse_cursor_models("gpt-5.2\u{0085}-\u{0085}GPT-5.2\n"), Vec::new());
        // JS `.` excludes U+2028, so a label containing one never matches.
        assert_eq!(parse_cursor_models("auto - Auto\u{2028}X\n"), Vec::new());
        assert_eq!(parse_cursor_models("auto - Auto (default)\n")[0].label, "Auto");
    }

    #[test]
    fn label_length_counts_utf16_units_and_charat_is_a_code_unit() {
        // "1𝟚𝟚" is 5 UTF-16 units (>3), so it takes the capitalize branch.
        assert_eq!(label_from_model_id("1\u{1D7DA}\u{1D7DA}"), "1\u{1D7DA}\u{1D7DA}");
        // charAt(0) on an astral char is a lone surrogate, which uppercases to
        // itself — Deseret U+10428 must NOT become U+10400.
        assert_eq!(label_from_model_id("\u{10428}bc"), "\u{10428}bc");
        // BMP first char still capitalizes.
        assert_eq!(label_from_model_id("sonnet"), "Sonnet");
    }
}
