//! Dispatch capabilities (schema v10): the unforgeable token a worker presents
//! to prove it is the process this dispatch was handed to. Stored as a SHA-256
//! hash on `dispatch_contexts`, bound to a pane key and a process incarnation
//! so a reminted handle or a restarted process cannot reuse it.
//!
//! Ported from the reference branch's `orchestration/capability.rs` (v22),
//! adapted to this schema's shapes. Columns: `capability_hash`,
//! `process_incarnation`, `capability_revoked_at`, `launch_token_hash`,
//! `contract_version`.
//!
//! Three rules the port must not soften:
//! 1. Compare hashes in constant time (the TS twin used `timingSafeEqual`).
//! 2. Only the hash is persisted — the capability itself is returned once, at mint.
//! 3. The token is minted INSIDE the store, from the OS CSPRNG — it is an
//!    authentication secret, not one of the display/id values the shim supplies.

use super::error::orchestration_err;
use super::sha256::sha256_hex;
use super::{is_equivalent_pane_key, OrchestrationDb};
use orca_store::StoreError;
use rusqlite::params;
use subtle::ConstantTimeEq;

/// `LEGACY_CONTRACT_VERSION` — a dispatch created before capability minting.
/// The v10 migration backfills every pre-existing row to it.
pub const LEGACY_CONTRACT_VERSION: i64 = 0;

/// The contract every new dispatch is stamped with. Also the
/// `dispatch_contexts.contract_version` DDL default.
pub const CURRENT_CONTRACT_VERSION: i64 = 1;

/// TS `mintDispatchCapability(params)`. No `capability` field: the token is
/// minted in the store, never supplied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintCapabilityParams {
    pub dispatch_id: String,
    pub pane_key: String,
    pub process_incarnation: String,
}

/// TS `verifyDispatchCapability(params)` — every field may legitimately be
/// absent, which is itself a verification failure rather than an error.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DispatchIdentity {
    pub dispatch_id: String,
    pub capability: Option<String>,
    pub pane_key: Option<String>,
    pub process_incarnation: Option<String>,
}

/// TS `{ valid: true } | { valid: false; reason }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub enum CapabilityVerdict {
    Valid { valid: bool },
    Invalid { valid: bool, reason: String },
}

impl CapabilityVerdict {
    pub fn valid() -> Self {
        Self::Valid { valid: true }
    }

    pub fn invalid(reason: impl Into<String>) -> Self {
        Self::Invalid { valid: false, reason: reason.into() }
    }
}

const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Node `Buffer.toString('base64url')`: the URL-safe alphabet, never padded.
/// Hand-rolled because the workspace is offline/vendored and no base64 crate
/// is vendored.
fn base64url_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let packed = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        encoded.push(BASE64URL_ALPHABET[(packed >> 18) as usize & 63] as char);
        encoded.push(BASE64URL_ALPHABET[(packed >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            encoded.push(BASE64URL_ALPHABET[(packed >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            encoded.push(BASE64URL_ALPHABET[packed as usize & 63] as char);
        }
    }
    encoded
}

/// TS `` `dcap_${randomBytes(32).toString('base64url')}` ``. The token
/// authenticates a dispatched process, so the entropy comes from the OS CSPRNG.
pub fn mint_dispatch_capability_token() -> Result<String, StoreError> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw)
        .map_err(|error| StoreError::Message(format!("capability entropy unavailable: {error}")))?;
    Ok(format!("dcap_{}", base64url_encode(&raw)))
}

/// TS `hashDispatchCapability` — `createHash('sha256').update(c).digest('hex')`,
/// i.e. lowercase hex. The capability itself is never persisted, only this.
pub fn hash_dispatch_capability(capability: &str) -> String {
    sha256_hex(capability.as_bytes())
}

/// The `timingSafeEqual` half of the TS compare: decode both hex digests and
/// compare the bytes in constant time, with the explicit length guard TS keeps
/// in front of it (`timingSafeEqual` throws on a length mismatch).
fn constant_time_hex_eq(expected_hex: &str, observed_hex: &str) -> bool {
    let expected = node_hex_bytes(expected_hex);
    let observed = node_hex_bytes(observed_hex);
    expected.len() == observed.len() && expected.ct_eq(&observed).into()
}

/// `Buffer.from(value, 'hex')`: decode whole pairs and stop at the first pair
/// that isn't hex (Node truncates rather than throwing). Mirrored exactly so a
/// malformed stored digest fails the length guard here the same way it does in
/// TS instead of taking a different branch.
fn node_hex_bytes(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        let (Some(high), Some(low)) = (hex_nibble(bytes[index]), hex_nibble(bytes[index + 1]))
        else {
            break;
        };
        out.push((high << 4) | low);
        index += 2;
    }
    out
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// JS truthiness for a nullable TEXT column: the TS guards are all
/// `!row.capability_hash`-style, so an empty string reads as absent — a Rust
/// `Some("")` must take the same branch as `None`.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

impl OrchestrationDb {
    /// TS `mintDispatchCapability` — stores the hash + identity binding and
    /// returns the capability string the worker must present.
    ///
    /// `waiting_gate` is deliberately not mintable: minting re-binds identity
    /// for a (re)launch, and a parked dispatch keeps the identity it parked with
    /// until gate resolution releases it.
    pub fn mint_dispatch_capability(
        &self,
        params: &MintCapabilityParams,
    ) -> Result<String, StoreError> {
        let dispatch = self.dispatch_context_by_id(&params.dispatch_id)?;
        let active = dispatch
            .as_ref()
            .is_some_and(|row| row.status == "pending" || row.status == "dispatched");
        if !active {
            return orchestration_err(
                "dispatch_inactive",
                format!("Dispatch {} is not active.", params.dispatch_id),
            );
        }
        let capability = mint_dispatch_capability_token()?;
        // Minting re-binds the identity and clears any prior revocation, so a
        // relaunch on the same context supersedes the dead process's token.
        self.db.connection().execute(
            "UPDATE dispatch_contexts
             SET capability_hash = ?2, assignee_pane_key = ?3, process_incarnation = ?4,
                 capability_revoked_at = NULL
             WHERE id = ?1",
            params![
                params.dispatch_id,
                hash_dispatch_capability(&capability),
                params.pane_key,
                params.process_incarnation
            ],
        )?;
        Ok(capability)
    }

    /// TS `verifyDispatchCapability`.
    pub fn verify_dispatch_capability(
        &self,
        identity: &DispatchIdentity,
    ) -> Result<CapabilityVerdict, StoreError> {
        let Some(dispatch) = self.dispatch_context_by_id(&identity.dispatch_id)? else {
            return Ok(CapabilityVerdict::invalid(format!(
                "Dispatch {} was not found.",
                identity.dispatch_id
            )));
        };
        let Some(stored_hash) = present(dispatch.capability_hash.as_deref()) else {
            return Ok(CapabilityVerdict::invalid(format!(
                "Dispatch {} has no lifecycle capability.",
                identity.dispatch_id
            )));
        };
        if present(dispatch.capability_revoked_at.as_deref()).is_some() {
            return Ok(CapabilityVerdict::invalid(format!(
                "Dispatch {} capability is revoked.",
                identity.dispatch_id
            )));
        }
        let Some(capability) = present(identity.capability.as_deref()) else {
            return Ok(CapabilityVerdict::invalid("The Dispatch capability is missing."));
        };
        if !constant_time_hex_eq(stored_hash, &hash_dispatch_capability(capability)) {
            return Ok(CapabilityVerdict::invalid("The Dispatch capability is invalid."));
        }
        // A valid token still only speaks for the pane it was minted to: pane
        // equivalence survives a handle remint, an unrelated pane never matches.
        let pane_matches = match (
            present(dispatch.assignee_pane_key.as_deref()),
            present(identity.pane_key.as_deref()),
        ) {
            (Some(stored), Some(presented)) => is_equivalent_pane_key(stored, presented),
            _ => false,
        };
        if !pane_matches {
            return Ok(CapabilityVerdict::invalid("The caller is not the Dispatch pane."));
        }
        let incarnation_matches = matches!(
            (
                present(dispatch.process_incarnation.as_deref()),
                present(identity.process_incarnation.as_deref()),
            ),
            (Some(stored), Some(presented)) if stored == presented
        );
        if !incarnation_matches {
            return Ok(CapabilityVerdict::invalid("The Dispatch process incarnation changed."));
        }
        Ok(CapabilityVerdict::valid())
    }

    /// TS `revokeDispatchCapability` — stamps `capability_revoked_at`; the hash
    /// is kept so a later presentation is diagnosable rather than merely unknown.
    pub fn revoke_dispatch_capability(&self, dispatch_id: &str) -> Result<(), StoreError> {
        // COALESCE: re-revoking keeps the first stamp, and an unknown id is a
        // no-op rather than an error (TS returns void either way).
        self.db.connection().execute(
            "UPDATE dispatch_contexts
             SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
             WHERE id = ?1",
            params![dispatch_id],
        )?;
        Ok(())
    }

    /// TS `commitDispatchLaunchTokenHash` — binds the launch token that will be
    /// exchanged for a capability once the process reports in.
    pub fn commit_dispatch_launch_token_hash(
        &self,
        dispatch_id: &str,
        launch_token_hash: &str,
    ) -> Result<super::DispatchContext, StoreError> {
        let Some(dispatch) = self.dispatch_context_by_id(dispatch_id)? else {
            return orchestration_err(
                "dispatch_not_found",
                format!("Dispatch {dispatch_id} was not found."),
            );
        };
        if dispatch.contract_version != CURRENT_CONTRACT_VERSION {
            return orchestration_err(
                "request_mismatch",
                format!("Dispatch {dispatch_id} does not use the current contract."),
            );
        }
        // First commitment wins: re-committing the same hash is idempotent, a
        // different one is a mismatched request, never an overwrite.
        if present(dispatch.launch_token_hash.as_deref())
            .is_some_and(|existing| existing != launch_token_hash)
        {
            return orchestration_err(
                "request_mismatch",
                format!("Dispatch {dispatch_id} already has a different launch-token commitment."),
            );
        }
        self.db.connection().execute(
            "UPDATE dispatch_contexts
             SET launch_token_hash = COALESCE(launch_token_hash, ?2)
             WHERE id = ?1",
            params![dispatch_id, launch_token_hash],
        )?;
        self.dispatch_context_by_id(dispatch_id)?.ok_or_else(|| {
            StoreError::Message("dispatch context vanished after launch-token commit".into())
        })
    }

    /// TS `isDispatchProcessCurrent` — pane/incarnation currency without a
    /// capability, for read paths that only need "is this still the same process".
    pub fn is_dispatch_process_current(
        &self,
        identity: &DispatchIdentity,
    ) -> Result<bool, StoreError> {
        let Some(dispatch) = self.dispatch_context_by_id(&identity.dispatch_id)? else {
            return Ok(false);
        };
        let pane_matches = match (
            present(dispatch.assignee_pane_key.as_deref()),
            present(identity.pane_key.as_deref()),
        ) {
            (Some(stored), Some(presented)) => is_equivalent_pane_key(stored, presented),
            _ => false,
        };
        let incarnation_matches = matches!(
            (
                present(dispatch.process_incarnation.as_deref()),
                present(identity.process_incarnation.as_deref()),
            ),
            (Some(stored), Some(presented)) if stored == presented
        );
        Ok(pane_matches && incarnation_matches)
    }
}

#[cfg(test)]
mod primitive_tests {
    use super::*;

    #[test]
    fn hex_compare_guards_length_before_comparing() {
        let hash = hash_dispatch_capability("abc");
        assert!(constant_time_hex_eq(&hash, &hash));
        assert!(!constant_time_hex_eq(&hash, &hash_dispatch_capability("abd")));
        // A malformed stored digest truncates on decode, so the length guard rejects.
        assert!(!constant_time_hex_eq("zz", &hash));
        assert!(!constant_time_hex_eq("", &hash));
        // Node's lenient decode: stop at the first invalid pair / odd tail.
        assert_eq!(node_hex_bytes("0a0B"), vec![0x0a, 0x0b]);
        assert_eq!(node_hex_bytes("0aZZ0b"), vec![0x0a]);
        assert_eq!(node_hex_bytes("0a0"), vec![0x0a]);
        assert_eq!(node_hex_bytes(""), Vec::<u8>::new());
    }

    #[test]
    fn every_mint_is_a_fresh_dcap_token() {
        // `dcap_` + unpadded base64url of 32 random bytes.
        let token = mint_dispatch_capability_token().unwrap();
        assert!(token.starts_with("dcap_"));
        assert_eq!(token.len(), "dcap_".len() + 43);
        assert_ne!(token, mint_dispatch_capability_token().unwrap());
    }

    #[test]
    fn base64url_matches_node_buffer_encoding() {
        // RFC 4648 vectors, unpadded, URL alphabet.
        assert_eq!(base64url_encode(b""), "");
        assert_eq!(base64url_encode(b"f"), "Zg");
        assert_eq!(base64url_encode(b"fo"), "Zm8");
        assert_eq!(base64url_encode(b"foo"), "Zm9v");
        assert_eq!(base64url_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url_encode(&[0xfb, 0xff, 0xbf]), "-_-_");
        assert_eq!(base64url_encode(&[0u8; 32]).len(), 43);
    }
}
