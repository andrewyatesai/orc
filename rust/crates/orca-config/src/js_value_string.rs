//! JS `String(value)` over a parsed JSON value.
//!
//! Config readers that mirror a TS `typeof x === 'string' ? x : String(x)` need
//! this, not `Value::to_string()`: serde's rendering is JSON text, so a numeric
//! env value came back `5` only by luck and `{"a":1}` came back as JSON where JS
//! says `[object Object]`. The measured case that forced it: `mcp_env` reached
//! this through `as_str().unwrap_or_default()`, so `{N: 5, B: true}` masked to
//! `{"N": "", "B": ""}` — silent value destruction on a credential-bearing map.
//!
//! Numbers follow ECMAScript `Number::toString` (7.1.12.1), including the
//! exponent thresholds Rust's `Display` does not have: JS writes `1e+21` where
//! Rust writes `1000000000000000000000`, and `1e-7` where Rust writes
//! `0.0000001`. A JSON number is a double on the TS side, so the f64 is the
//! faithful model even when serde stored an integer.

use serde_json::Value;

/// JS `String(value)`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        // `as_f64` only fails under `arbitrary_precision`, which this crate does
        // not enable; serde's own rendering is the closest thing to a fallback.
        Value::Number(number) => {
            number.as_f64().map(js_number_string).unwrap_or_else(|| number.to_string())
        }
        Value::String(text) => text.clone(),
        // `Array.prototype.join(',')`: each element stringified the same way,
        // with null/undefined rendered as empty.
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        // No `toString` override survives JSON, so every plain object is this.
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// ECMAScript `Number::toString` for a finite double.
///
/// Rust's `{:e}` gives the same shortest round-tripping digits JS picks, so the
/// only work is re-placing the decimal point per the spec's `n`/`k` rules.
pub fn js_number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_infinite() {
        return if value < 0.0 { "-Infinity".to_string() } else { "Infinity".to_string() };
    }
    if value < 0.0 {
        return format!("-{}", js_number_string(-value));
    }

    // `{:e}` is `d[.ddd]e<exp>`; digits are the spec's `s`, `k` their count, and
    // `n` the position of the decimal point (value = 0.<digits> * 10^n).
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = match scientific.split_once('e') {
        Some(parts) => parts,
        None => return scientific,
    };
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = digits.len() as i64;
    let n = match exponent.parse::<i64>() {
        Ok(exponent) => exponent.saturating_add(1),
        Err(_) => return scientific,
    };

    if k <= n && n <= 21 {
        let zeros = (n - k).max(0) as usize;
        return format!("{digits}{}", "0".repeat(zeros));
    }
    if 0 < n && n <= 21 {
        let split = n.clamp(0, k) as usize;
        let (head, tail) = digits.split_at(split);
        return format!("{head}.{tail}");
    }
    if -6 < n && n <= 0 {
        let zeros = (-n).max(0) as usize;
        return format!("0.{}{digits}", "0".repeat(zeros));
    }
    let power = n.saturating_sub(1);
    let sign = if power >= 0 { "+" } else { "-" };
    let magnitude = power.unsigned_abs();
    if k == 1 {
        return format!("{digits}e{sign}{magnitude}");
    }
    let (head, tail) = digits.split_at(1);
    format!("{head}.{tail}e{sign}{magnitude}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every expectation here is what `node -e 'console.log(String(x))'` prints.
    #[test]
    fn matches_js_string_for_each_json_shape() {
        assert_eq!(js_string(&json!(null)), "null");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!(false)), "false");
        assert_eq!(js_string(&json!(5)), "5");
        assert_eq!(js_string(&json!(5.0)), "5");
        assert_eq!(js_string(&json!("text")), "text");
        assert_eq!(js_string(&json!([1, 2])), "1,2");
        assert_eq!(js_string(&json!([])), "");
        assert_eq!(js_string(&json!([null, 1])), ",1");
        assert_eq!(js_string(&json!([[1], [2, 3]])), "1,2,3");
        assert_eq!(js_string(&json!({})), "[object Object]");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(js_string(&json!([{ "a": 1 }])), "[object Object]");
    }

    #[test]
    fn matches_js_number_formatting_including_the_exponent_thresholds() {
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (5.0, "5"),
            (-5.0, "-5"),
            (100.0, "100"),
            (0.1, "0.1"),
            (123.456, "123.456"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (9007199254740991.0, "9007199254740991"),
        ] {
            assert_eq!(js_number_string(value), expected, "String({value})");
        }
    }
}
