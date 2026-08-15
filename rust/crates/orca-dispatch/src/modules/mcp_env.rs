//! Parity dispatch for `orca_text::mcp_env` vs `maskMcpEnv` in
//! `src/shared/mcp-server-inspection.ts` (re-exported by `mcp-config.ts`).

use orca_config::js_string;
use orca_text::mcp_env::mask_mcp_env;
use serde_json::{json, Map, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "maskMcpEnv" => mask_to_json(input),
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Match `JSON.stringify` of the TS `Record<string, string> | undefined` return.
///
/// `undefined` has no JSON image, so a dropped env (non-object input, or one that
/// blew a bound) answers `null` here and the TS adapter maps its `undefined` to
/// `null` for the same reason — otherwise the oversize behaviour could not be
/// covered by a vector at all.
///
/// Values are coerced with `String(x)`, because the twin does
/// (`typeof rawValue === 'string' ? rawValue : String(rawValue)`). Reading them
/// with `as_str().unwrap_or_default()` is what silently turned `{N: 5}` into
/// `{"N": ""}`.
fn mask_to_json(input: &Value) -> Value {
    let Some(object) = input.as_object() else {
        return Value::Null;
    };
    let coerced: Vec<(String, String)> = object
        .iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text.clone(),
                other => js_string(other),
            };
            (key.clone(), text)
        })
        .collect();
    let pairs: Vec<(&str, &str)> =
        coerced.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    match mask_mcp_env(Some(&pairs)) {
        Some(masked) => {
            let mut map = Map::new();
            for (key, value) in masked {
                map.insert(key, Value::String(value));
            }
            Value::Object(map)
        }
        None => Value::Null,
    }
}
