//! Parity dispatch for `orca_relay::pairing_offer_schema` vs
//! `src/shared/mobile-relay-pairing-offer.ts`.
//!
//! This module exists because the twin's validation is a SIBLING of the module
//! that exports it: `pairing.ts` re-exports `PairingOfferSchema` and owns no rule
//! of its own, so a corpus keyed on `pairing.test.ts` never sees the relay v1
//! sub-object, the size caps or the cross-field rules at all.
//!
//! Every function here takes `nowMs` from the vector. The twin's own
//! `createPairingOfferSchema(now)` takes the same injected clock, so the invite
//! window — the one wall-clock rule in the schema — is compared at exact
//! boundaries rather than at whatever instant the two processes happened to run.

use super::pairing::offer_from_input;
use orca_relay::{
    decode_pairing_offer, encode_pairing_offer, pairing_offer_to_json, parse_pairing_code,
    validate_pairing_offer,
};
use serde_json::{json, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    let now_ms = input.get("nowMs").and_then(Value::as_f64).unwrap_or(f64::NAN);
    let field = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    match function {
        "validatePairingOffer" => {
            let payload = input.get("payload").cloned().unwrap_or(Value::Null);
            match validate_pairing_offer(&payload, now_ms) {
                Some(offer) => pairing_offer_to_json(&offer),
                None => Value::Null,
            }
        }
        "encodePairingOffer" => {
            let offer = offer_from_input(input.get("offer").unwrap_or(&Value::Null));
            match encode_pairing_offer(&offer, now_ms) {
                Ok(url) => Value::String(url),
                Err(_) => Value::Null,
            }
        }
        "decodePairingOffer" => match decode_pairing_offer(&field("url"), now_ms) {
            Ok(offer) => pairing_offer_to_json(&offer),
            Err(_) => Value::Null,
        },
        "parsePairingCode" => match parse_pairing_code(&field("input"), now_ms) {
            Some(offer) => pairing_offer_to_json(&offer),
            None => Value::Null,
        },
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}
