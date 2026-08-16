//! Pairing deep-link codec, ported from `src/shared/pairing.ts`.
//!
//! The desktop emits an `orca://pair?code=<base64url>` link carrying a versioned
//! offer; the mobile client scans or pastes it to bootstrap the encrypted
//! session. This file owns only the transport — the URL shape, the base64 code
//! and the size caps. EVERY field rule lives in [`crate::pairing_offer_schema`],
//! exactly as the twin delegates to `mobile-relay-pairing-offer.ts`.
//!
//! `now_ms` is threaded through because the offer schema has a wall-clock invite
//! window; see that module for why the clock is an argument and not a read.

use crate::pairing_offer_schema::{
    pairing_offer_to_json, validate_pairing_offer, PAIRING_CODE_MAX_CHARACTERS,
    PAIRING_INPUT_MAX_CHARACTERS,
};
use orca_core::js_string::{trim_js, utf16_len};
use serde_json::Value;

pub use crate::pairing_offer_schema::{PairingOffer, PairingRelay, PairingScope};

/// `encodePairingOffer`. The twin runs the offer through the schema BEFORE
/// stringifying it, so an invalid offer never becomes a link — `Err` is that
/// throw.
pub fn encode_pairing_offer(offer: &PairingOffer, now_ms: f64) -> Result<String, String> {
    let parsed = validate_pairing_offer(&pairing_offer_to_json(offer), now_ms)
        .ok_or_else(|| "Invalid pairing offer".to_string())?;
    let json = serde_json::to_string(&pairing_offer_to_json(&parsed))
        .map_err(|error| error.to_string())?;
    let code = crate::base64::encode_url_safe_no_pad(json.as_bytes());
    if utf16_len(&code) > PAIRING_CODE_MAX_CHARACTERS {
        return Err("Pairing offer exceeds safe size".to_string());
    }
    // Query param, not fragment: Android camera intents / Expo Router preserve
    // query params more reliably than URL fragments on custom-scheme launches.
    Ok(format!("orca://pair?code={code}"))
}

/// Decode an `orca://pair` deep link. `Err` carries an "Invalid pairing URL"
/// message for a bad/foreign URL, or a payload error for a malformed offer.
pub fn decode_pairing_offer(url: &str, now_ms: f64) -> Result<PairingOffer, String> {
    if utf16_len(url) > PAIRING_INPUT_MAX_CHARACTERS {
        return Err("Invalid pairing URL: pairing code exceeds safe size".to_string());
    }
    let code = extract_pairing_code_from_url(url).ok_or_else(|| {
        "Invalid pairing URL: must start with orca://pair and include a pairing code".to_string()
    })?;
    decode_pairing_base64(&code, now_ms).ok_or_else(|| "Invalid pairing offer payload".to_string())
}

/// Accept either an `orca://pair?...` URL or a bare base64url payload (the mobile
/// paste-pair flow takes whichever the user copied). `None` on any failure.
pub fn parse_pairing_code(input: &str, now_ms: f64) -> Option<PairingOffer> {
    if utf16_len(input) > PAIRING_INPUT_MAX_CHARACTERS {
        return None;
    }
    // trim_js, not str::trim: they disagree on U+FEFF and U+0085, and a NEL-
    // prefixed code that Rust trimmed would decode here while the twin rejected it.
    let trimmed = trim_js(input);
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() >= 7 && trimmed.as_bytes()[..7].eq_ignore_ascii_case(b"orca://") {
        decode_pairing_offer(trimmed, now_ms).ok()
    } else {
        decode_pairing_base64(trimmed, now_ms)
    }
}

fn extract_pairing_code_from_url(url: &str) -> Option<String> {
    let normalized = normalize_whatwg_url_input(url);
    let (scheme, rest) = normalized.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("orca") {
        return None;
    }
    let (before_fragment, fragment) = match rest.split_once('#') {
        Some((before, fragment)) => (before, Some(fragment)),
        None => (rest, None),
    };
    let (authority_path, query) = match before_fragment.split_once('?') {
        Some((before, query)) => (before, Some(query)),
        None => (before_fragment, None),
    };
    let (authority, path) = match authority_path.split_once('/') {
        Some((authority, rest)) => (authority, format!("/{rest}")),
        None => (authority_path, String::new()),
    };
    // Userinfo ends at the LAST `@`; the port is whatever follows the first colon.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let (hostname, port) = match host.split_once(':') {
        Some((hostname, port)) => (hostname, Some(port)),
        None => (host, None),
    };
    // `orca:` is a non-special scheme, so its host is OPAQUE and the parser does
    // NOT lowercase it: `ORCA://PAIR` fails the twin's `hostname !== 'pair'`.
    if hostname != "pair" {
        return None;
    }
    if port.is_some_and(|port| !is_parsable_port(port)) {
        return None;
    }
    if !path.is_empty() && path != "/" {
        return None;
    }
    if let Some(code) = query.and_then(|query| form_urlencoded_first(query, "code")) {
        if !code.is_empty() {
            return Some(code);
        }
    }
    // Legacy fallback: the code in the URL fragment.
    fragment.filter(|fragment| !fragment.is_empty()).map(str::to_string)
}

/// What `new URL` does to its input before parsing: strip leading/trailing C0
/// controls and spaces, then remove every tab, LF and CR wherever they appear.
fn normalize_whatwg_url_input(url: &str) -> String {
    url.trim_matches(|c: char| c <= '\u{1F}' || c == ' ')
        .chars()
        .filter(|c| !matches!(c, '\u{9}' | '\u{A}' | '\u{D}'))
        .collect()
}

/// A port that the parser can read; an unparsable or out-of-range one throws,
/// and an empty one is simply dropped.
fn is_parsable_port(port: &str) -> bool {
    port.is_empty()
        || (port.bytes().all(|byte| byte.is_ascii_digit())
            && port.parse::<u64>().is_ok_and(|number| number <= 65535))
}

/// `URLSearchParams.get` — `application/x-www-form-urlencoded` decoding of BOTH
/// the name and the value, so `+` is a space and `%4A` is a `J`. Reading the raw
/// bytes instead let a `+`-bearing code through that the twin turns into a space
/// and rejects.
fn form_urlencoded_first(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (form_urlencoded_decode(name) == key).then(|| form_urlencoded_decode(value))
    })
}

fn form_urlencoded_decode(part: &str) -> String {
    let bytes = part.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'+' {
            out.push(b' ');
            index += 1;
            continue;
        }
        if byte == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                // Both are `to_digit(16)` results (<= 15), so the shift-or is a byte.
                out.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(byte);
        index += 1;
    }
    // A malformed sequence stays literal and invalid UTF-8 becomes U+FFFD, which
    // is what the twin's decoder does; neither survives the pairing-code pattern.
    String::from_utf8_lossy(&out).into_owned()
}

fn decode_pairing_base64(base64url: &str, now_ms: f64) -> Option<PairingOffer> {
    let units = utf16_len(base64url);
    if units == 0 || units > PAIRING_CODE_MAX_CHARACTERS || !is_pairing_code_shaped(base64url) {
        return None;
    }
    let bytes = crate::base64::decode(base64url)?;
    // `Buffer.toString('utf-8')` is lossy, not a throw: invalid bytes become
    // U+FFFD and the JSON is parsed anyway.
    let json = String::from_utf8_lossy(&bytes);
    let value: Value = serde_json::from_str(&json).ok()?;
    validate_pairing_offer(&value, now_ms)
}

/// `/^[A-Za-z0-9+/_-]+={0,2}$/`. Padding is only legal at the END: the decoder
/// alone stops at the first `=`, which accepted `<valid-code>=junk`.
fn is_pairing_code_shaped(code: &str) -> bool {
    let body = code.trim_end_matches('=');
    code.len() - body.len() <= 2
        && !body.is_empty()
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing_offer_schema::PAIRING_OFFER_VERSION;

    const NOW: f64 = 1_752_336_000_000.0;
    const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";

    fn offer() -> PairingOffer {
        PairingOffer {
            v: 2,
            endpoint: "ws://192.168.1.10:6768".to_string(),
            // Matches src/shared/pairing.test.ts and the parity vectors; deadbeef so the
            // base64 pairing codes it appears in do not read as real credentials.
            device_token: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string(),
            public_key_b64: "dGVzdC1wdWJsaWMta2V5LWJhc2U2NC1lbmNvZGVk".to_string(),
            scope: None,
            relay: None,
        }
    }

    fn relay_offer() -> PairingOffer {
        PairingOffer {
            public_key_b64: KEY.to_string(),
            relay: Some(PairingRelay {
                v: 1,
                director_url: "https://relay.onorca.dev".to_string(),
                cell_url: "https://relay-c1.onorca.dev".to_string(),
                assignment_epoch: 7.0,
                relay_host_id: "AbCdEf0123_-xyZ9".to_string(),
                invite_token: TOKEN.to_string(),
                invite_expires_at: NOW + 5.0 * 60.0 * 1000.0,
                e2ee_framing: 2,
            }),
            ..offer()
        }
    }

    fn encode(offer: &PairingOffer) -> String {
        encode_pairing_offer(offer, NOW).unwrap()
    }

    fn code_of(url: &str) -> String {
        url.strip_prefix("orca://pair?code=").unwrap().to_string()
    }

    fn fragment_url(json: &str) -> String {
        format!("orca://pair#{}", crate::base64::encode_url_safe_no_pad(json.as_bytes()))
    }

    #[test]
    fn encode_then_decode_round_trips_correctly() {
        let url = encode(&offer());
        assert!(url.starts_with("orca://pair?code="));
        assert_eq!(decode_pairing_offer(&url, NOW).unwrap(), offer());
    }

    #[test]
    fn relay_offers_round_trip_including_the_sub_object() {
        let url = encode(&relay_offer());
        assert_eq!(decode_pairing_offer(&url, NOW).unwrap(), relay_offer());
    }

    #[test]
    fn encoded_url_uses_base64url_no_plus_slash_or_equals() {
        let code = code_of(&encode(&offer()));
        assert!(!code.contains('+') && !code.contains('/') && !code.contains('='));
    }

    #[test]
    fn rejects_urls_with_wrong_scheme() {
        let error = decode_pairing_offer("https://example.com#abc", NOW).unwrap_err();
        assert!(error.contains("Invalid pairing URL"));
    }

    #[test]
    fn rejects_orca_urls_outside_the_exact_pairing_route() {
        let code = code_of(&encode(&offer()));
        assert_eq!(parse_pairing_code(&format!("orca://pairing?code={code}"), NOW), None);
        assert_eq!(parse_pairing_code(&format!("orca://pair-extra?code={code}"), NOW), None);
        assert!(decode_pairing_offer(&format!("orca://pairing?code={code}"), NOW)
            .unwrap_err()
            .contains("Invalid pairing URL"));
    }

    #[test]
    fn rejects_an_uppercase_host_the_opaque_parser_does_not_lowercase() {
        let code = code_of(&encode(&offer()));
        assert_eq!(parse_pairing_code(&format!("ORCA://PAIR?code={code}"), NOW), None);
        // The SCHEME is lowercased by the parser, so a shouty scheme still works.
        assert!(parse_pairing_code(&format!("ORCA://pair?code={code}"), NOW).is_some());
    }

    #[test]
    fn rejects_urls_without_a_pairing_code() {
        assert!(decode_pairing_offer("orca://pair", NOW)
            .unwrap_err()
            .contains("Invalid pairing URL"));
    }

    #[test]
    fn decodes_legacy_hash_urls() {
        let code = code_of(&encode(&offer()));
        assert_eq!(decode_pairing_offer(&format!("orca://pair#{code}"), NOW).unwrap(), offer());
    }

    #[test]
    fn strips_tabs_and_newlines_and_surrounding_controls_like_new_url() {
        let code = code_of(&encode(&offer()));
        assert_eq!(decode_pairing_offer(&format!("orca://pa\tir?code={code}"), NOW).unwrap(), offer());
        assert_eq!(decode_pairing_offer(&format!("\u{1}orca://pair?code={code} "), NOW).unwrap(), offer());
    }

    #[test]
    fn form_decodes_the_code_query_parameter() {
        let code = code_of(&encode(&offer()));
        let percent_encoded = code.replacen('e', "%65", 1);
        assert_eq!(decode_pairing_offer(&format!("orca://pair?code={percent_encoded}"), NOW).unwrap(), offer());
        // `+` decodes to a space, which the pairing-code pattern rejects — the raw
        // read treated it as a base64 `+` and accepted a standard-alphabet code.
        assert!(decode_pairing_offer("orca://pair?code=eyJ2Ijoy+fQ", NOW).is_err());
        // A valueless `code` is the empty string, so the fragment is NOT consulted
        // for a later `code=` pair.
        assert!(decode_pairing_offer(&format!("orca://pair?code&code={code}"), NOW).is_err());
    }

    #[test]
    fn rejects_a_port_the_url_parser_would_refuse() {
        let code = code_of(&encode(&offer()));
        assert!(decode_pairing_offer(&format!("orca://pair:abc?code={code}"), NOW).is_err());
        assert!(decode_pairing_offer(&format!("orca://pair:65536?code={code}"), NOW).is_err());
        assert!(decode_pairing_offer(&format!("orca://pair:1234?code={code}"), NOW).is_ok());
    }

    #[test]
    fn rejects_padding_that_is_not_at_the_end_of_the_code() {
        let code = code_of(&encode(&offer()));
        // The bare decoder stopped at the first `=` and decoded a valid offer.
        assert_eq!(parse_pairing_code(&format!("{code}=junk"), NOW), None);
        assert_eq!(parse_pairing_code(&format!("{code}==="), NOW), None);
    }

    #[test]
    fn rejects_payloads_with_missing_fields() {
        let url = fragment_url(r#"{"v":2,"endpoint":"ws://host:1234"}"#);
        assert!(decode_pairing_offer(&url, NOW).is_err());
    }

    #[test]
    fn rejects_payloads_with_wrong_version() {
        let url = fragment_url(
            r#"{"v":1,"endpoint":"ws://host:1234","deviceToken":"tok","publicKeyB64":"k"}"#,
        );
        assert!(decode_pairing_offer(&url, NOW).is_err());
    }

    #[test]
    fn rejects_payloads_with_missing_public_key_b64() {
        let url = fragment_url(r#"{"v":2,"endpoint":"ws://host:1234","deviceToken":"tok"}"#);
        assert!(decode_pairing_offer(&url, NOW).is_err());
    }

    #[test]
    fn scope_round_trips_for_both_values_and_is_omitted_when_absent() {
        for scope in [PairingScope::Mobile, PairingScope::Runtime] {
            let scoped = PairingOffer { scope: Some(scope), ..offer() };
            assert_eq!(decode_pairing_offer(&encode(&scoped), NOW).unwrap(), scoped);
        }
        // Absent scope: encode must OMIT the key (TS JSON.stringify drops
        // undefined), so the payload stays byte-compatible with old clients.
        let json_b64 = code_of(&encode(&offer()));
        let json = String::from_utf8(crate::base64::decode(&json_b64).unwrap()).unwrap();
        assert!(!json.contains("scope"));
    }

    #[test]
    fn rejects_present_but_invalid_scope_like_zod() {
        // zod .optional(): absent is fine; present must be a valid enum string.
        let bad = fragment_url(
            r#"{"v":2,"endpoint":"ws://h:1","deviceToken":"t","publicKeyB64":"k","scope":"desktop"}"#,
        );
        assert!(decode_pairing_offer(&bad, NOW).is_err());
        let null_scope = fragment_url(
            r#"{"v":2,"endpoint":"ws://h:1","deviceToken":"t","publicKeyB64":"k","scope":null}"#,
        );
        assert!(decode_pairing_offer(&null_scope, NOW).is_err());
    }

    #[test]
    fn encode_refuses_an_offer_the_schema_rejects() {
        assert!(encode_pairing_offer(&PairingOffer { endpoint: String::new(), ..offer() }, NOW).is_err());
        assert!(encode_pairing_offer(&PairingOffer { v: 3, ..offer() }, NOW).is_err());
        // A relay offer whose invite has expired at `now` never becomes a link.
        let stale = PairingOffer {
            relay: relay_offer().relay.map(|relay| PairingRelay { invite_expires_at: NOW, ..relay }),
            ..relay_offer()
        };
        assert!(encode_pairing_offer(&stale, NOW).is_err());
        // ...and the same offer is fine one millisecond earlier on the clock.
        assert!(encode_pairing_offer(&stale, NOW - 1.0).is_ok());
    }

    #[test]
    fn caps_the_input_and_the_code_at_the_twin_s_limits() {
        let oversized = format!("orca://pair?code={}", "A".repeat(PAIRING_INPUT_MAX_CHARACTERS));
        assert!(decode_pairing_offer(&oversized, NOW).is_err());
        assert_eq!(parse_pairing_code(&oversized, NOW), None);
        assert_eq!(parse_pairing_code(&"A".repeat(PAIRING_CODE_MAX_CHARACTERS + 1), NOW), None);
    }

    // --- parse_pairing_code ---

    fn paste_offer() -> PairingOffer {
        PairingOffer {
            v: PAIRING_OFFER_VERSION,
            endpoint: "ws://192.168.1.10:6768".to_string(),
            device_token: "token-abc".to_string(),
            public_key_b64: "pubkey-xyz".to_string(),
            scope: None,
            relay: None,
        }
    }

    #[test]
    fn parses_a_full_orca_pair_url() {
        assert_eq!(parse_pairing_code(&encode(&paste_offer()), NOW), Some(paste_offer()));
    }

    #[test]
    fn parses_a_bare_base64url_payload_without_scheme_prefix() {
        let code = code_of(&encode(&paste_offer()));
        assert_eq!(parse_pairing_code(&code, NOW), Some(paste_offer()));
    }

    #[test]
    fn tolerates_surrounding_whitespace_from_clipboard() {
        let url = encode(&paste_offer());
        assert_eq!(parse_pairing_code(&format!("  {url}\n"), NOW), Some(paste_offer()));
    }

    #[test]
    fn trims_exactly_the_ecmascript_whitespace_set() {
        let code = code_of(&encode(&paste_offer()));
        // JS strips U+FEFF; Rust's own `trim` does not.
        assert_eq!(parse_pairing_code(&format!("\u{FEFF}{code}\u{FEFF}"), NOW), Some(paste_offer()));
        // JS keeps U+0085, so the code stays malformed; `str::trim` would have
        // removed it and accepted.
        assert_eq!(parse_pairing_code(&format!("\u{85}{code}"), NOW), None);
    }

    #[test]
    fn returns_none_for_empty_input() {
        assert_eq!(parse_pairing_code("", NOW), None);
        assert_eq!(parse_pairing_code("   ", NOW), None);
    }

    #[test]
    fn returns_none_for_garbage_input() {
        assert_eq!(parse_pairing_code("not a pairing code", NOW), None);
        assert_eq!(parse_pairing_code("https://example.com", NOW), None);
    }

    #[test]
    fn returns_none_for_valid_base64_of_unrelated_json() {
        let bogus = crate::base64::encode_url_safe_no_pad(br#"{"hello":"world"}"#);
        assert_eq!(parse_pairing_code(&bogus, NOW), None);
    }
}
