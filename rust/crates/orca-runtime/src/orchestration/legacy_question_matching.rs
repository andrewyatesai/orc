//! Semantic identity for a legacy `ask`: a retrying legacy CLI has no question
//! id to present, so a question is re-found by its normalized text, its
//! normalized options and its recipient. Ported from the db.ts privates
//! `normalizeLegacyQuestionText`, `normalizeLegacyQuestionOptions` and
//! `legacyMessageMatchesQuestion` — one copy, shared by `questions` (the
//! semantic-identity search) and `legacy_compat` (the ask/reply commit path).

use super::rows::Message;

/// TS `String.prototype.trim`. Rust's `trim` is Unicode `White_Space`, which
/// misses the ZWNBSP (U+FEFF) that ECMAScript also strips.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// TS `normalizeLegacyQuestionText`.
pub fn normalize_legacy_question_text(value: &str) -> String {
    js_trim(&value.replace("\r\n", "\n")).to_string()
}

/// TS `normalizeLegacyQuestionOptions` for an already-typed option list.
pub fn normalize_legacy_question_options(options: &[String]) -> String {
    let trimmed: Vec<&str> = options.iter().map(|option| js_trim(option)).collect();
    serde_json::to_string(&trimmed).unwrap_or_else(|_| "[]".to_string())
}

/// TS `normalizeLegacyQuestionOptions` for an untyped payload value: anything
/// that is not an array of strings normalizes to `[]`.
pub fn normalize_legacy_question_options_value(value: Option<&serde_json::Value>) -> String {
    let Some(serde_json::Value::Array(items)) = value else {
        return "[]".to_string();
    };
    let mut trimmed = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str() {
            Some(text) => trimmed.push(js_trim(text)),
            None => return "[]".to_string(),
        }
    }
    serde_json::to_string(&trimmed).unwrap_or_else(|_| "[]".to_string())
}

/// TS `legacyMessageMatchesQuestion`.
pub fn legacy_message_matches_question(
    message: &Message,
    question: &str,
    options: &[String],
    recipient_handles: &[&str],
) -> bool {
    if !recipient_handles.contains(&message.to_handle.as_str())
        || normalize_legacy_question_text(&message.body) != normalize_legacy_question_text(question)
    {
        return false;
    }
    let payload = message.payload.as_deref().unwrap_or("{}");
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    // Why: TS reads `payload.options` off the parsed value; on `null` that throws
    // and the surrounding catch returns false.
    if payload.is_null() {
        return false;
    }
    normalize_legacy_question_options_value(payload.get("options"))
        == normalize_legacy_question_options(options)
}
