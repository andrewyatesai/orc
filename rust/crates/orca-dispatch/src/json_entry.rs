//! The string-in/string-out dispatch entry both bindings ship.
//!
//! `native/orca-node` (napi) and `rust/orca-git-wasm` (wasm) each used to inline
//! their own `serde_json::from_str(..).unwrap_or(Value::Null)`, so a payload that
//! failed to parse became an argument-less call and the module answered a
//! confident wrong answer with nothing logged. Two copies of that decision is how
//! the two ends came to disagree; there is one copy now, here, and it FAILS LOUD.
//!
//! Contract (the TS twin is `src/shared/dispatch-payload-codec.ts`):
//!
//! * `input_json == ""` — the documented no-arg call → `Value::Null`.
//! * `input_json == "null"` — an explicit JSON null → `Value::Null`. Same value,
//!   reached legitimately; the TS encoder emits this for a no-arg call.
//! * anything else that does not parse → an `__dispatch_error__` object. Never
//!   `Value::Null`, which is what made the corruption silent.
//! * unknown module → the same `__dispatch_error__` shape (unchanged message).
//!
//! One error shape, not two: TS `decodeDispatchResult` detects the single
//! `__dispatch_error__` key and throws, so no caller can mistake either failure
//! for a result.
//!
//! The same entry also rejects a supplied-but-never-read input key — the typo
//! hazard, where `{"droppablesessions":40}` bought the no-arg default instead of
//! an error. See `crate::input_reader` for why the allowed keys are SELF-REPORTED
//! rather than scanned out of the source, and for the adoption rule. The check is
//! TOP-LEVEL ONLY: keys inside a nested object are not inspected.

use serde_json::Value;

use crate::input_reader::{self, Recording};

/// Decode a dispatch payload, distinguishing "no argument" from "would not parse".
///
/// The `Err` message is what a shim author reads in a stack trace, so it names the
/// module/function, the serde failure (which carries the column), and the payload
/// size — never the payload itself, which can be large or sensitive.
pub fn decode_input(module: &str, function: &str, input_json: &str) -> Result<Value, String> {
    // Empty is the no-arg call; every other input must genuinely parse.
    if input_json.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str::<Value>(input_json).map_err(|error| {
        format!(
            "{module}.{function}: input_json ({len} bytes) is not decodable JSON: {error}. \
             The payload was NOT dispatched. A lone UTF-16 surrogate is the usual cause \
             (JSON.stringify emits it as a \\ud800 escape, which is not valid UTF-8); \
             encode through encodeDispatchPayload (src/shared/dispatch-payload-codec.ts), \
             which rejects that at the call site.",
            len = input_json.len()
        )
    })
}

/// The single dispatch entry: decode, dispatch, and render the result (or the
/// failure) as the JSON text the binding returns to TypeScript.
pub fn dispatch_json(module: &str, function: &str, input_json: &str) -> String {
    let value = match decode_input(module, function, input_json) {
        Ok(value) => value,
        Err(message) => return dispatch_error(&message),
    };
    // Only a non-empty object can carry a misspelled key, so a scalar/no-arg call
    // never arms the recorder — that is what keeps this off the path entirely.
    let Some(supplied) = value.as_object().filter(|fields| !fields.is_empty()) else {
        return match crate::dispatch(module, function, &value) {
            Some(result) => result.to_string(),
            None => unknown_module(module),
        };
    };
    let recording = input_reader::arm();
    // An unknown module read nothing, so every key would look unread; the module
    // name is the real failure and keeps its own message.
    let Some(result) = crate::dispatch(module, function, &value) else {
        return unknown_module(module);
    };
    match recording.unread_keys(supplied).as_slice() {
        [] => result.to_string(),
        unread => dispatch_error(&unread_key_message(module, function, unread, &recording)),
    }
}

fn unknown_module(module: &str) -> String {
    dispatch_error(&format!("unknown module {module}"))
}

/// The message a shim author reads when a key they supplied was never read.
///
/// The module already ran — self-reporting cannot know the legal keys until it
/// does — so this discards a computed answer. Safe because the registry is
/// pure-domain: dropping a result drops nothing else.
fn unread_key_message(
    module: &str,
    function: &str,
    unread: &[String],
    recording: &Recording,
) -> String {
    let named = unread
        .iter()
        .map(|key| match recording.nearest_consumed(key) {
            Some(near) => format!("`{key}` (did you mean `{near}`?)"),
            None => format!("`{key}`"),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let read = recording
        .consumed_keys()
        .iter()
        .map(|key| format!("`{key}`"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{module}.{function}: unknown input key {named}. It was supplied but no field read \
         asked for it, so its value was ignored and the module answered as if the field were \
         absent — that answer was DISCARDED, not returned. Keys this function reads: {read}. \
         Only top-level keys are checked."
    )
}

fn dispatch_error(message: &str) -> String {
    serde_json::json!({ "__dispatch_error__": message }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real registered module with a scalar-object input, so these exercise the
    // production path rather than a stub.
    const MODULE: &str = "keep-tail";
    const FUNCTION: &str = "backgroundSessionKeepTailChars";

    fn error_message(json: &str) -> String {
        let value: Value = serde_json::from_str(json).expect("dispatch output is JSON");
        value["__dispatch_error__"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn empty_input_is_the_no_arg_call() {
        assert_eq!(decode_input(MODULE, FUNCTION, ""), Ok(Value::Null));
    }

    #[test]
    fn explicit_json_null_is_also_null() {
        assert_eq!(decode_input(MODULE, FUNCTION, "null"), Ok(Value::Null));
    }

    #[test]
    fn valid_payload_round_trips() {
        assert_eq!(
            decode_input(MODULE, FUNCTION, r#"{"droppableSessions":3}"#),
            Ok(serde_json::json!({ "droppableSessions": 3 }))
        );
    }

    #[test]
    fn lone_surrogate_escape_is_an_error_not_null() {
        let message = decode_input(MODULE, FUNCTION, r#"{"path":"a\ud800b"}"#)
            .expect_err("a lone surrogate must not decode");
        assert!(message.contains("keep-tail.backgroundSessionKeepTailChars"), "{message}");
        assert!(message.contains("surrogate"), "{message}");
    }

    #[test]
    fn matched_surrogate_pair_decodes_to_its_astral_char() {
        let value = decode_input(MODULE, FUNCTION, r#"{"emoji":"🚀"}"#)
            .expect("a matched pair is a legitimate character");
        assert_eq!(value["emoji"], Value::String("\u{1f680}".to_string()));
    }

    #[test]
    fn truncated_payload_is_an_error_not_null() {
        assert!(decode_input(MODULE, FUNCTION, r#"{"droppableSessions":"#).is_err());
    }

    #[test]
    fn dispatch_json_reports_a_parse_failure_instead_of_dispatching() {
        // The regression under test: this used to run as a no-arg call and return
        // the (wrong, confident) default keep-tail for zero sessions.
        let no_arg = dispatch_json(MODULE, FUNCTION, "");
        let broken = dispatch_json(MODULE, FUNCTION, "{\"droppableSessions\":\u{5c}ud800}");
        assert_ne!(broken, no_arg);
        assert!(error_message(&broken).contains("not decodable JSON"));
    }

    #[test]
    fn dispatch_json_still_dispatches_a_good_payload() {
        let ok = dispatch_json(MODULE, FUNCTION, r#"{"droppableSessions":4}"#);
        assert!(!ok.contains("__dispatch_error__"), "{ok}");
        assert!(ok.parse::<u64>().is_ok(), "{ok}");
    }

    #[test]
    fn unknown_module_keeps_its_message() {
        assert_eq!(
            error_message(&dispatch_json("no-such-module", FUNCTION, "null")),
            "unknown module no-such-module"
        );
    }

    // An object payload now reaches the unread-key check, so the unknown-module
    // message must still win over "every key looks unread".
    #[test]
    fn unknown_module_outranks_the_unread_key_check() {
        assert_eq!(
            error_message(&dispatch_json(
                "no-such-module",
                FUNCTION,
                r#"{"droppableSessions":4}"#
            )),
            "unknown module no-such-module"
        );
    }

    #[test]
    fn the_motivating_typo_is_rejected_not_defaulted() {
        let typo = dispatch_json(MODULE, FUNCTION, r#"{"droppablesessions":40}"#);
        let no_arg = dispatch_json(MODULE, FUNCTION, "");
        assert_ne!(typo, no_arg, "the typo must not read as a no-arg call");
        let message = error_message(&typo);
        assert!(message.contains("unknown input key `droppablesessions`"), "{message}");
        assert!(message.contains("did you mean `droppableSessions`?"), "{message}");
    }

    #[test]
    fn the_correct_spelling_still_answers() {
        assert_eq!(dispatch_json(MODULE, FUNCTION, r#"{"droppableSessions":40}"#), "65536");
    }

    #[test]
    fn provider_backoff_rejects_a_miscased_streak() {
        let message = error_message(&dispatch_json(
            "provider-backoff",
            "activeFailureRefetchThrottleMs",
            r#"{"Streak":6}"#,
        ));
        assert!(message.contains("did you mean `streak`?"), "{message}");
    }

    #[test]
    fn provider_backoff_still_answers_the_correct_key() {
        assert_eq!(
            dispatch_json("provider-backoff", "activeFailureRefetchThrottleMs", r#"{"streak":6}"#),
            "900000"
        );
    }

    // Requirement 3: a scalar has no keys to be unread, and many modules take one.
    #[test]
    fn scalar_and_empty_inputs_are_untouched() {
        for input in ["null", "42", r#""a string""#, "[1,2,3]", "{}"] {
            let out = dispatch_json(MODULE, FUNCTION, input);
            assert!(!out.contains("__dispatch_error__"), "{input} -> {out}");
        }
    }

    // The fail-open that makes incremental adoption safe: an unadopted module
    // records nothing, so an arbitrary key set passes straight through.
    #[test]
    fn an_unadopted_module_is_unchecked_not_rejected() {
        let out = dispatch_json(
            "workspace-name",
            "no-such-function",
            r#"{"anything":1,"atAll":2}"#,
        );
        assert!(!out.contains("__dispatch_error__"), "{out}");
    }

    // An unknown FUNCTION on an adopted module reads no field, so it stays
    // unchecked and keeps the module's own `__parity_error__`.
    #[test]
    fn unknown_function_keeps_the_module_error() {
        let out = dispatch_json(MODULE, "noSuchFunction", r#"{"droppableSessions":4}"#);
        assert!(out.contains("__parity_error__"), "{out}");
        assert!(!out.contains("__dispatch_error__"), "{out}");
    }

    // Requirement 4, made executable: the check is top-level only.
    #[test]
    fn nested_keys_are_not_inspected() {
        let out = dispatch_json(
            MODULE,
            FUNCTION,
            r#"{"droppableSessions":40,"nested":{"whatever":1}}"#,
        );
        // `nested` IS caught — it is top level. Its contents are not looked at.
        let message = error_message(&out);
        assert!(message.contains("`nested`"), "{message}");
        assert!(!message.contains("whatever"), "{message}");
    }

    #[test]
    fn every_keep_tail_vector_input_is_fully_read() {
        // Proves adoption is complete for this module: no vector case, all of which
        // are legitimate, is rejected by the new check.
        for function in ["backgroundSessionKeepTailChars", "backgroundSessionDropCapChars"] {
            for sessions in ["0", "1", "5", "-3", "1000000"] {
                let payload = format!(r#"{{"droppableSessions":{sessions}}}"#);
                let out = dispatch_json(MODULE, function, &payload);
                assert!(!out.contains("__dispatch_error__"), "{payload} -> {out}");
            }
        }
    }
}
