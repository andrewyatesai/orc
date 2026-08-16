//! Parity dispatch for `orca_relay::pairing` vs `src/shared/pairing.ts`.
//!
//! These vectors drive the DEEP-LINK layer only. The twin's schema reads
//! `Date.now()` internally, so the TS adapter pins the global clock to
//! [`VECTOR_CLOCK_MS`] for the duration of each call and this side passes the
//! same instant — otherwise a relay-bearing vector would compare two different
//! instants. Relay rules are measured at their boundaries in the
//! `mobile-relay-pairing-offer` module, where BOTH halves take an injected clock.

use orca_relay::{
    decode_pairing_offer, encode_pairing_offer, pairing_offer_to_json, parse_pairing_code,
    PairingOffer, PairingRelay, PairingScope, PAIRING_OFFER_VERSION,
};
use serde_json::{json, Value};

/// The instant both halves evaluate this module's vectors at.
pub const VECTOR_CLOCK_MS: f64 = 0.0;

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        // TS `encodePairingOffer` validates before stringifying and throws on a
        // bad offer; the TS adapter maps that throw to null, as `Err` does here.
        "encodePairingOffer" => {
            match encode_pairing_offer(&offer_from_input(input), VECTOR_CLOCK_MS) {
                Ok(url) => Value::String(url),
                Err(_) => Value::Null,
            }
        }
        // TS `decodePairingOffer` throws on a bad URL/payload and the TS adapter
        // maps that throw to null, so `Err` must produce the same null image.
        "decodePairingOffer" => {
            match decode_pairing_offer(input.as_str().unwrap_or_default(), VECTOR_CLOCK_MS) {
                Ok(offer) => pairing_offer_to_json(&offer),
                Err(_) => Value::Null,
            }
        }
        "parsePairingCode" => {
            match parse_pairing_code(input.as_str().unwrap_or_default(), VECTOR_CLOCK_MS) {
                Some(offer) => pairing_offer_to_json(&offer),
                None => Value::Null,
            }
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Rebuild the offer WITHOUT validating: encode vectors have to be able to carry
/// an offer the schema rejects, which is the behaviour under test.
pub fn offer_from_input(input: &Value) -> PairingOffer {
    PairingOffer {
        v: input
            .get("v")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| u64::from(PAIRING_OFFER_VERSION)) as u32,
        endpoint: string_field(input, "endpoint"),
        device_token: string_field(input, "deviceToken"),
        public_key_b64: string_field(input, "publicKeyB64"),
        scope: input.get("scope").and_then(Value::as_str).and_then(PairingScope::from_str),
        relay: input.get("relay").filter(|relay| !relay.is_null()).map(relay_from_input),
    }
}

fn relay_from_input(input: &Value) -> PairingRelay {
    PairingRelay {
        v: input.get("v").and_then(Value::as_u64).unwrap_or(1) as u32,
        director_url: string_field(input, "directorUrl"),
        cell_url: string_field(input, "cellUrl"),
        assignment_epoch: number_field(input, "assignmentEpoch"),
        relay_host_id: string_field(input, "relayHostId"),
        invite_token: string_field(input, "inviteToken"),
        invite_expires_at: number_field(input, "inviteExpiresAt"),
        e2ee_framing: input.get("e2eeFraming").and_then(Value::as_u64).unwrap_or(2) as u32,
    }
}

fn string_field(input: &Value, key: &str) -> String {
    input.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn number_field(input: &Value, key: &str) -> f64 {
    input.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}
