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

use serde_json::Value;

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
    match crate::dispatch(module, function, &value) {
        Some(result) => result.to_string(),
        None => dispatch_error(&format!("unknown module {module}")),
    }
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
}
