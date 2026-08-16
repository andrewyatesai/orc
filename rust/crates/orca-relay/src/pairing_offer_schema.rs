//! Port of `PairingOfferSchema` in `src/shared/mobile-relay-pairing-offer.ts`.
//!
//! `src/shared/pairing.ts` owns no validation of its own — it delegates every
//! rule to this zod schema, so the deep-link codec in [`crate::pairing`] is only
//! as strict as this file is. The schema is security-adjacent: the relay v1
//! sub-object carries an invite token and names the origins a device will trust.
//!
//! THE CLOCK IS A PARAMETER, NOT A READ. The twin's invite window is evaluated
//! against `now()`, which defaults to `Date.now()` but is injectable
//! (`createPairingOfferSchema`). Here it is a required `now_ms` argument: this
//! crate is compiled to wasm, where `SystemTime::now()` panics, and a validator
//! that reads a hidden clock cannot be differentially compared with anything.
//! Callers pass the same instant they would have passed to the twin.
//!
//! Every numeric field is read as `f64`, because the twin types them `number`.
//! `as_u64` would silently reject `2.0` and `as_i64` would accept values JS calls
//! unsafe; both read correct in Rust and are a different function than the twin.

use crate::canonical_https_origin::is_canonical_https_origin;
use orca_core::js_string::utf16_len;
use serde_json::{Map, Number, Value};

pub const PAIRING_OFFER_VERSION: u32 = 2;
pub const PAIRING_CODE_MAX_CHARACTERS: usize = 128 * 1024;
pub const PAIRING_INPUT_MAX_CHARACTERS: usize = PAIRING_CODE_MAX_CHARACTERS + 1024;
pub const PAIRING_ENDPOINT_MAX_CHARACTERS: usize = 16 * 1024;
pub const PAIRING_DEVICE_TOKEN_MAX_CHARACTERS: usize = 64 * 1024;
pub const PAIRING_PUBLIC_KEY_MAX_CHARACTERS: usize = 4 * 1024;

const RELAY_VERSION: f64 = 1.0;
const E2EE_FRAMING: f64 = 2.0;
const MAX_INVITE_TTL_MS: f64 = 10.0 * 60.0 * 1000.0;
/// The cell stamps expiry from its own clock; without leeway a cell clock even
/// slightly ahead of this machine fails every invite.
const INVITE_EXPIRY_CLOCK_SKEW_MS: f64 = 30.0 * 1000.0;
/// `Number.MAX_SAFE_INTEGER`, the ceiling `z.number().int()` enforces.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Advisory UI scope on an offer: lets the web client reject phone-QR offers
/// before opening a socket; the runtime still authorizes solely from the device
/// token. Mirrors the TS `z.enum(['mobile', 'runtime']).optional()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairingScope {
    Mobile,
    Runtime,
}

impl PairingScope {
    pub fn as_str(self) -> &'static str {
        match self {
            PairingScope::Mobile => "mobile",
            PairingScope::Runtime => "runtime",
        }
    }

    /// Public for the parity harness (vectors carry the scope as its wire string).
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "mobile" => Some(PairingScope::Mobile),
            "runtime" => Some(PairingScope::Runtime),
            _ => None,
        }
    }
}

/// Relay v1: where the device should reach the desktop when it cannot reach it
/// directly, plus the single-use invite that admits it to that cell.
#[derive(Clone, Debug, PartialEq)]
pub struct PairingRelay {
    /// Always 1; validation rejects any other value.
    pub v: u32,
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: f64,
    pub relay_host_id: String,
    pub invite_token: String,
    pub invite_expires_at: f64,
    /// Always 2; validation rejects any other framing.
    pub e2ee_framing: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PairingOffer {
    /// Always [`PAIRING_OFFER_VERSION`]; validation rejects any other value.
    pub v: u32,
    pub endpoint: String,
    pub device_token: String,
    pub public_key_b64: String,
    /// Optional advisory scope; omitted from the encoded JSON when absent (TS
    /// `JSON.stringify` drops `undefined` fields).
    pub scope: Option<PairingScope>,
    /// Optional relay v1 routing; mobile-only (see the runtime cross-field rule).
    pub relay: Option<PairingRelay>,
}

/// `PairingOfferSchema.safeParse` — `None` is the twin's `success: false`.
/// Unknown keys are dropped at both levels, matching zod's default strip mode.
pub fn validate_pairing_offer(value: &Value, now_ms: f64) -> Option<PairingOffer> {
    let object = value.as_object()?;
    if js_number(object.get("v"))? != f64::from(PAIRING_OFFER_VERSION) {
        return None;
    }
    let endpoint = bounded_string(object.get("endpoint"), PAIRING_ENDPOINT_MAX_CHARACTERS)?;
    let device_token =
        bounded_string(object.get("deviceToken"), PAIRING_DEVICE_TOKEN_MAX_CHARACTERS)?;
    let public_key_b64 =
        bounded_string(object.get("publicKeyB64"), PAIRING_PUBLIC_KEY_MAX_CHARACTERS)?;
    // zod `.optional()`: an absent key is fine, a PRESENT one must be valid — so
    // `null` or an unknown value rejects the whole offer.
    let scope = match object.get("scope") {
        None => None,
        Some(value) => Some(PairingScope::from_str(value.as_str()?)?),
    };
    let relay = match object.get("relay") {
        None => None,
        Some(value) => Some(validate_relay(value, now_ms)?),
    };
    if relay.is_some() {
        // Relay v1 is mobile-only; accepting it on a runtime offer would imply
        // routing and credential support that client does not have.
        if scope == Some(PairingScope::Runtime) {
            return None;
        }
        // relayHostId is derived from the decoded key bytes, so relay offers
        // cannot tolerate the permissive legacy base64 aliases.
        if !is_canonical_base64_key(&public_key_b64) {
            return None;
        }
    }
    Some(PairingOffer {
        v: PAIRING_OFFER_VERSION,
        endpoint,
        device_token,
        public_key_b64,
        scope,
        relay,
    })
}

fn validate_relay(value: &Value, now_ms: f64) -> Option<PairingRelay> {
    let object = value.as_object()?;
    if js_number(object.get("v"))? != RELAY_VERSION {
        return None;
    }
    let director_url = canonical_origin_field(object.get("directorUrl"))?;
    let cell_url = canonical_origin_field(object.get("cellUrl"))?;
    let assignment_epoch = safe_integer(object.get("assignmentEpoch"))?;
    if !(0.0..=MAX_SAFE_INTEGER).contains(&assignment_epoch) {
        return None;
    }
    let relay_host_id = base64url_field(object.get("relayHostId"), 16)?;
    let invite_token = base64url_field(object.get("inviteToken"), 43)?;
    let invite_expires_at = safe_integer(object.get("inviteExpiresAt"))?;
    if !(invite_expires_at > now_ms
        && invite_expires_at <= now_ms + MAX_INVITE_TTL_MS + INVITE_EXPIRY_CLOCK_SKEW_MS)
    {
        return None;
    }
    if js_number(object.get("e2eeFraming"))? != E2EE_FRAMING {
        return None;
    }
    Some(PairingRelay {
        v: RELAY_VERSION as u32,
        director_url,
        cell_url,
        assignment_epoch,
        relay_host_id,
        invite_token,
        invite_expires_at,
        e2ee_framing: E2EE_FRAMING as u32,
    })
}

/// `atob`/`btoa` canonicity: 43 standard-alphabet characters plus one `=`,
/// decoding to 32 bytes that re-encode to the same string. Re-encoding only
/// round-trips when the final character's low two bits are zero.
pub fn is_canonical_base64_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 44 || bytes[43] != b'=' {
        return false;
    }
    if !bytes[..43].iter().all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/') {
        return false;
    }
    base64_sextet(bytes[42]).is_some_and(|sextet| sextet % 4 == 0)
}

fn base64_sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// `z.string().min(1).refine(isCanonicalHttpsOrigin)`.
fn canonical_origin_field(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && is_canonical_https_origin(text)).then(|| text.to_string())
}

/// `z.string().regex(/^[A-Za-z0-9_-]{n}$/)` — the count is UTF-16 units, and the
/// character class is ASCII, so a byte-length check is the same predicate.
fn base64url_field(value: Option<&Value>, units: usize) -> Option<String> {
    let text = value?.as_str()?;
    let matches = text.len() == units
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    matches.then(|| text.to_string())
}

/// `z.string().min(1).max(n)` — zod counts `String.prototype.length`, i.e. UTF-16
/// code units, not chars and not bytes.
fn bounded_string(value: Option<&Value>, max_units: usize) -> Option<String> {
    let text = value?.as_str()?;
    let units = utf16_len(text);
    (units >= 1 && units <= max_units).then(|| text.to_string())
}

/// `typeof value === 'number'` after JSON parsing. `as_f64` is the only reader
/// that matches: JS has one numeric type and `JSON.parse` rounds to it.
fn js_number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64()
}

/// `z.number().int()` in zod v4 is `Number.isSafeInteger`, which also rejects
/// NaN and both infinities.
fn safe_integer(value: Option<&Value>) -> Option<f64> {
    let number = js_number(value)?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
        .then_some(number)
}

/// `JSON.stringify` of the parsed offer. Key order is the zod shape order, which
/// is load-bearing: it decides the bytes of the encoded pairing code.
pub fn pairing_offer_to_json(offer: &PairingOffer) -> Value {
    let mut object = Map::new();
    object.insert("v".to_string(), Value::from(offer.v));
    object.insert("endpoint".to_string(), Value::String(offer.endpoint.clone()));
    object.insert("deviceToken".to_string(), Value::String(offer.device_token.clone()));
    object.insert("publicKeyB64".to_string(), Value::String(offer.public_key_b64.clone()));
    if let Some(scope) = offer.scope {
        object.insert("scope".to_string(), Value::String(scope.as_str().to_string()));
    }
    if let Some(relay) = &offer.relay {
        object.insert("relay".to_string(), pairing_relay_to_json(relay));
    }
    Value::Object(object)
}

fn pairing_relay_to_json(relay: &PairingRelay) -> Value {
    let mut object = Map::new();
    object.insert("v".to_string(), Value::from(relay.v));
    object.insert("directorUrl".to_string(), Value::String(relay.director_url.clone()));
    object.insert("cellUrl".to_string(), Value::String(relay.cell_url.clone()));
    object.insert("assignmentEpoch".to_string(), js_number_to_json(relay.assignment_epoch));
    object.insert("relayHostId".to_string(), Value::String(relay.relay_host_id.clone()));
    object.insert("inviteToken".to_string(), Value::String(relay.invite_token.clone()));
    object.insert("inviteExpiresAt".to_string(), js_number_to_json(relay.invite_expires_at));
    object.insert("e2eeFraming".to_string(), Value::from(relay.e2ee_framing));
    Value::Object(object)
}

/// `JSON.stringify(7)` is `7`, never `7.0`, and the encoded code is compared
/// byte-for-byte — so an integral f64 must serialize through the integer arm.
fn js_number_to_json(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
        return Value::Number(Number::from(value as i64));
    }
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: f64 = 1_752_336_000_000.0;
    const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";

    fn relay_json() -> Value {
        json!({
            "v": 1,
            "directorUrl": "https://relay.onorca.dev",
            "cellUrl": "https://relay-c1.onorca.dev",
            "assignmentEpoch": 7,
            "relayHostId": "AbCdEf0123_-xyZ9",
            "inviteToken": TOKEN,
            "inviteExpiresAt": NOW + 5.0 * 60.0 * 1000.0,
            "e2eeFraming": 2
        })
    }

    fn offer_json(relay: Option<Value>) -> Value {
        let mut object = json!({
            "v": 2,
            "endpoint": "ws://192.168.1.10:6768",
            "deviceToken": "device-token",
            "publicKeyB64": KEY
        });
        if let (Some(relay), Some(map)) = (relay, object.as_object_mut()) {
            map.insert("relay".to_string(), relay);
        }
        object
    }

    fn accepts(value: &Value) -> bool {
        validate_pairing_offer(value, NOW).is_some()
    }

    fn with_relay_field(key: &str, value: Value) -> Value {
        let mut relay = relay_json();
        relay.as_object_mut().unwrap().insert(key.to_string(), value);
        offer_json(Some(relay))
    }

    #[test]
    fn accepts_the_direct_and_relay_fixtures() {
        assert!(accepts(&offer_json(None)));
        assert!(accepts(&offer_json(Some(relay_json()))));
    }

    #[test]
    fn strips_unknown_keys_at_both_levels() {
        let mut relay = relay_json();
        relay.as_object_mut().unwrap().insert("ignored".to_string(), json!(true));
        let mut offer = offer_json(Some(relay));
        let map = offer.as_object_mut().unwrap();
        map.insert("ignored".to_string(), json!(true));
        map.insert("endpoints".to_string(), json!([{ "kind": "relay" }]));
        let parsed = validate_pairing_offer(&offer, NOW).unwrap();
        let clean = validate_pairing_offer(&offer_json(Some(relay_json())), NOW).unwrap();
        assert_eq!(pairing_offer_to_json(&parsed), pairing_offer_to_json(&clean));
    }

    #[test]
    fn rejects_relay_on_a_runtime_scope_offer() {
        let mut offer = offer_json(Some(relay_json()));
        offer.as_object_mut().unwrap().insert("scope".to_string(), json!("runtime"));
        assert!(!accepts(&offer));
        // The same offer without relay is fine — the rule is the pair, not the scope.
        let mut direct = offer_json(None);
        direct.as_object_mut().unwrap().insert("scope".to_string(), json!("runtime"));
        assert!(accepts(&direct));
    }

    #[test]
    fn relay_offers_require_a_canonical_32_byte_public_key() {
        let mut offer = offer_json(Some(relay_json()));
        offer
            .as_object_mut()
            .unwrap()
            .insert("publicKeyB64".to_string(), json!("legacy-nonempty-key"));
        assert!(!accepts(&offer));
        // A 43-char body whose final character carries low bits does not re-encode.
        let mut non_canonical = offer_json(Some(relay_json()));
        non_canonical
            .as_object_mut()
            .unwrap()
            .insert("publicKeyB64".to_string(), json!(format!("{}B=", "A".repeat(42))));
        assert!(!accepts(&non_canonical));
        // The legacy key is still fine on a direct offer.
        let mut direct = offer_json(None);
        direct.as_object_mut().unwrap().insert("publicKeyB64".to_string(), json!("legacy"));
        assert!(accepts(&direct));
    }

    #[test]
    fn rejects_non_canonical_relay_origins() {
        assert!(!accepts(&with_relay_field("directorUrl", json!("https://relay.onorca.dev/"))));
        assert!(!accepts(&with_relay_field("cellUrl", json!("http://relay-c1.onorca.dev"))));
        assert!(!accepts(&with_relay_field("directorUrl", json!(""))));
    }

    #[test]
    fn assignment_epoch_must_be_a_safe_non_negative_integer() {
        assert!(accepts(&with_relay_field("assignmentEpoch", json!(0))));
        assert!(!accepts(&with_relay_field("assignmentEpoch", json!(1.5))));
        assert!(!accepts(&with_relay_field("assignmentEpoch", json!(-1))));
        assert!(!accepts(&with_relay_field("assignmentEpoch", json!(9007199254740992u64))));
        assert!(accepts(&with_relay_field("assignmentEpoch", json!(9007199254740991u64))));
    }

    #[test]
    fn host_id_and_invite_token_have_fixed_base64url_lengths() {
        assert!(!accepts(&with_relay_field("relayHostId", json!("short"))));
        assert!(!accepts(&with_relay_field("relayHostId", json!("AbCdEf0123_-xyZ9x"))));
        assert!(!accepts(&with_relay_field("relayHostId", json!("AbCdEf0123_-xyZ+"))));
        assert!(!accepts(&with_relay_field("inviteToken", json!("short"))));
        assert!(!accepts(&with_relay_field("inviteToken", json!(format!("{TOKEN}x")))));
    }

    #[test]
    fn invite_window_is_open_at_the_low_end_and_closed_at_ten_minutes_plus_skew() {
        let ceiling = NOW + 10.0 * 60.0 * 1000.0 + 30.0 * 1000.0;
        assert!(!accepts(&with_relay_field("inviteExpiresAt", json!(NOW))));
        assert!(accepts(&with_relay_field("inviteExpiresAt", json!(NOW + 1.0))));
        assert!(accepts(&with_relay_field("inviteExpiresAt", json!(ceiling))));
        assert!(!accepts(&with_relay_field("inviteExpiresAt", json!(ceiling + 1.0))));
        assert!(!accepts(&with_relay_field("inviteExpiresAt", json!(NOW + 0.5))));
    }

    #[test]
    fn rejects_unsupported_framing_and_relay_version() {
        assert!(!accepts(&with_relay_field("e2eeFraming", json!(1))));
        assert!(!accepts(&with_relay_field("v", json!(2))));
    }

    #[test]
    fn literals_accept_a_fractional_zero_spelling_like_json_parse() {
        // `JSON.parse('{"v":2.0}').v === 2` in JS; `as_u64` would have said no.
        let mut offer = offer_json(None);
        offer.as_object_mut().unwrap().insert("v".to_string(), json!(2.0));
        assert!(accepts(&offer));
    }

    #[test]
    fn string_caps_count_utf16_units() {
        let mut offer = offer_json(None);
        let astral = "\u{1F600}".repeat(PAIRING_PUBLIC_KEY_MAX_CHARACTERS / 2);
        offer.as_object_mut().unwrap().insert("publicKeyB64".to_string(), json!(astral.clone()));
        assert!(accepts(&offer), "exactly at the UTF-16 cap");
        offer
            .as_object_mut()
            .unwrap()
            .insert("publicKeyB64".to_string(), json!(format!("{astral}\u{1F600}")));
        assert!(!accepts(&offer), "one unit over the UTF-16 cap");
    }

    #[test]
    fn rejects_empty_and_oversized_offer_strings() {
        for (key, max) in [
            ("endpoint", PAIRING_ENDPOINT_MAX_CHARACTERS),
            ("deviceToken", PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
            ("publicKeyB64", PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
        ] {
            let mut offer = offer_json(None);
            offer.as_object_mut().unwrap().insert(key.to_string(), json!(""));
            assert!(!accepts(&offer), "{key} must be non-empty");
            let mut oversized = offer_json(None);
            oversized.as_object_mut().unwrap().insert(key.to_string(), json!("a".repeat(max + 1)));
            assert!(!accepts(&oversized), "{key} must be capped");
        }
    }

    #[test]
    fn a_present_but_null_optional_rejects_the_whole_offer() {
        let mut with_null_scope = offer_json(None);
        with_null_scope.as_object_mut().unwrap().insert("scope".to_string(), Value::Null);
        assert!(!accepts(&with_null_scope));
        let mut with_null_relay = offer_json(None);
        with_null_relay.as_object_mut().unwrap().insert("relay".to_string(), Value::Null);
        assert!(!accepts(&with_null_relay));
    }

    #[test]
    fn integral_numbers_serialize_without_a_fractional_tail() {
        let parsed = validate_pairing_offer(&offer_json(Some(relay_json())), NOW).unwrap();
        let text = serde_json::to_string(&pairing_offer_to_json(&parsed)).unwrap();
        assert!(text.contains("\"assignmentEpoch\":7,"), "{text}");
        assert!(text.contains("\"inviteExpiresAt\":1752336300000,"), "{text}");
        // Shape order, not alphabetical: the encoded pairing code depends on it.
        assert!(text.starts_with("{\"v\":2,\"endpoint\":"), "{text}");
    }
}
