//! Dispatch capabilities: the unforgeable token a worker presents to prove it is
//! the process this dispatch was handed to. Stored as a SHA-256 hash on
//! `dispatch_contexts`, bound to a pane key and a process incarnation so a
//! reminted handle or a restarted process cannot reuse it.
//!
//! Ported from the capability section of
//! `src/main/runtime/orchestration/db.ts`.
//! Table: `dispatch_contexts` (columns `capability_hash`, `process_incarnation`,
//! `capability_revoked_at`, `launch_token_hash`, `contract_version`).
//!
//! Private TS helper this module also needs: `findActiveDispatchForAssignee`.
//!
//! Three rules the port must not soften:
//! 1. Compare hashes in constant time (TS uses `timingSafeEqual`).
//! 2. Only the hash is persisted — the capability itself is returned once, at mint.
//! 3. The token is minted INSIDE the store, from the OS CSPRNG, exactly as the
//!    TS does at all three mint sites — it is an authentication secret, not one
//!    of the display/id values the fork lets the caller supply.
//!
//! This module owns the capability primitives (`dcap_` mint, SHA-256 hex hash,
//! constant-time compare); `worker_dispatch` and `remote_attachment` mint and
//! verify through them rather than carrying their own copies.

use super::base64url;
use super::error::orchestration_err;
use super::pane_key::is_equivalent_pane_key;
use super::rows::{row_to_dispatch, DispatchContext, DISPATCH_COLUMNS};
use super::run_contract::CURRENT_CONTRACT_VERSION;
use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// TS `mintDispatchCapability(params)`. No `capability` field: the TS mints the
/// token in the store, so this port does too.
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

/// TS `` `dcap_${randomBytes(32).toString('base64url')}` `` — the one mint for
/// every capability site (`mintDispatchCapability`, `prepareStartingWorkerAuthority`,
/// `prepareRemoteAttachmentAuthority`). The token authenticates a launched
/// process, so the entropy comes from the OS CSPRNG.
pub fn mint_dispatch_capability_token() -> Result<String, StoreError> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw)
        .map_err(|error| StoreError::Message(format!("capability entropy unavailable: {error}")))?;
    Ok(format!("dcap_{}", base64url::encode(&raw)))
}

/// TS `hashDispatchCapability` — `createHash('sha256').update(c).digest('hex')`,
/// i.e. lowercase hex. The capability itself is never persisted, only this.
pub fn hash_dispatch_capability(capability: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(capability.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// The `timingSafeEqual` half of the TS compare: decode both hex digests and
/// compare the bytes in constant time, with the explicit length guard TS keeps
/// in front of it (`timingSafeEqual` throws on a length mismatch).
pub fn constant_time_hex_eq(expected_hex: &str, observed_hex: &str) -> bool {
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
/// `!row.capability_hash`-style, so an empty string reads as absent. A Rust
/// `Some("")` must therefore take the same branch as `None`. Shared with
/// `remote_attachment`, which gates its own authority checks the same way.
pub(super) fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

impl OrchestrationDb {
    /// TS `mintDispatchCapability` — stores the hash + identity binding and
    /// returns the capability string the worker must present.
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

    /// TS `revokeDispatchCapability` — stamps `capability_revoked_at`; the hash is
    /// kept so a later presentation is diagnosable rather than merely unknown.
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
    ) -> Result<DispatchContext, StoreError> {
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

    /// TS `getActiveDispatchForIdentity` — the active dispatch for a handle, or
    /// for any pane equivalent to `pane_key` when the handle was reminted.
    pub fn get_active_dispatch_for_identity(
        &self,
        handle: &str,
        pane_key: Option<&str>,
    ) -> Result<Option<DispatchContext>, StoreError> {
        self.find_active_dispatch_for_assignee(handle, pane_key)
    }

    /// TS private `findActiveDispatchForAssignee`: handle first, then — only when
    /// a pane key was supplied — the pane-equivalence scan, so a reminted handle
    /// still resolves to the dispatch its pane already owns.
    fn find_active_dispatch_for_assignee(
        &self,
        assignee_handle: &str,
        assignee_pane_key: Option<&str>,
    ) -> Result<Option<DispatchContext>, StoreError> {
        let conn = self.db.connection();
        let mut by_handle = conn.prepare(&format!(
            "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts WHERE assignee_handle = ?1 AND status IN ('pending', 'dispatched') LIMIT 1"
        ))?;
        if let Some(row) = by_handle.query_row([assignee_handle], row_to_dispatch).optional()? {
            return Ok(Some(row));
        }
        let Some(assignee_pane_key) = present(assignee_pane_key) else {
            return Ok(None);
        };
        // Equivalence can't be expressed in SQL, so the TS scans every active
        // pane-keyed row in table order and returns the first match; same here.
        let mut actives = conn.prepare(&format!(
            "SELECT {DISPATCH_COLUMNS} FROM dispatch_contexts WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched')"
        ))?;
        let rows = actives.query_map([], row_to_dispatch)?;
        for row in rows {
            let row = row?;
            if present(row.assignee_pane_key.as_deref())
                .is_some_and(|key| is_equivalent_pane_key(key, assignee_pane_key))
            {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANE_A: &str = "tab1:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
    const PANE_A_REMINTED: &str = "tab9:0f9a1b2c-3d4e-4f5a-8b7c-0d1e2f3a4b5c";
    const PANE_B: &str = "tab1:1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d";

    fn dispatched(pane_key: Option<&str>) -> OrchestrationDb {
        let db = OrchestrationDb::open_in_memory().unwrap();
        db.create_task("t1", "do the thing", None, &[], None, None, None, None).unwrap();
        db.create_dispatch_context("t1", "worker-1", "ctx1", pane_key, None).unwrap();
        db
    }

    fn mint(db: &OrchestrationDb, pane_key: &str, incarnation: &str) -> String {
        db.mint_dispatch_capability(&MintCapabilityParams {
            dispatch_id: "ctx1".to_string(),
            pane_key: pane_key.to_string(),
            process_incarnation: incarnation.to_string(),
        })
        .unwrap()
    }

    fn identity(capability: &str, pane_key: &str, incarnation: &str) -> DispatchIdentity {
        DispatchIdentity {
            dispatch_id: "ctx1".to_string(),
            capability: Some(capability.to_string()),
            pane_key: Some(pane_key.to_string()),
            process_incarnation: Some(incarnation.to_string()),
        }
    }

    fn reason(verdict: &CapabilityVerdict) -> String {
        match verdict {
            CapabilityVerdict::Invalid { reason, .. } => reason.clone(),
            CapabilityVerdict::Valid { .. } => panic!("expected an invalid verdict"),
        }
    }

    fn coded(error: StoreError) -> (String, String) {
        let StoreError::Message(text) = error else { panic!("expected a coded message error") };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        (
            parsed["code"].as_str().unwrap().to_string(),
            parsed["message"].as_str().unwrap().to_string(),
        )
    }

    #[test]
    fn hashing_matches_node_createhash_sha256_hex() {
        // NIST vector, identical to `createHash('sha256').update('abc').digest('hex')`.
        assert_eq!(
            hash_dispatch_capability("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hash_dispatch_capability(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

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
        // `dcap_` + unpadded base64url of 32 random bytes, as the TS mints.
        let token = mint_dispatch_capability_token().unwrap();
        assert!(token.starts_with("dcap_"));
        assert_eq!(token.len(), "dcap_".len() + 43);
        assert_ne!(token, mint_dispatch_capability_token().unwrap());
    }

    #[test]
    fn mint_persists_only_the_hash_and_binds_the_identity() {
        let db = dispatched(None);
        let capability = mint(&db, PANE_A, "pid-1");
        // `dcap_` + unpadded base64url of 32 random bytes, as the TS mints.
        assert!(capability.starts_with("dcap_"));
        assert_eq!(capability.len(), "dcap_".len() + 43);
        assert_ne!(capability, mint(&db, PANE_A, "pid-1"));
        let capability = mint(&db, PANE_A, "pid-1");

        let row = db.dispatch_context_by_id("ctx1").unwrap().unwrap();
        assert_eq!(row.capability_hash.as_deref(), Some(hash_dispatch_capability(&capability).as_str()));
        assert_eq!(row.assignee_pane_key.as_deref(), Some(PANE_A));
        assert_eq!(row.process_incarnation.as_deref(), Some("pid-1"));
        assert_eq!(row.capability_revoked_at, None);
        // The token itself is never written anywhere on the row.
        let stored = serde_json::to_string(&row).unwrap();
        assert!(!stored.contains(&capability), "the capability must not be persisted: {stored}");
    }

    #[test]
    fn remint_rebinds_the_identity_and_clears_a_prior_revocation() {
        let db = dispatched(Some(PANE_A));
        let first = mint(&db, PANE_A, "pid-1");
        db.revoke_dispatch_capability("ctx1").unwrap();

        let second = db
            .mint_dispatch_capability(&MintCapabilityParams {
                dispatch_id: "ctx1".to_string(),
                pane_key: PANE_A_REMINTED.to_string(),
                process_incarnation: "pid-2".to_string(),
            })
            .unwrap();

        let row = db.dispatch_context_by_id("ctx1").unwrap().unwrap();
        assert_eq!(row.capability_revoked_at, None);
        assert_eq!(row.process_incarnation.as_deref(), Some("pid-2"));
        // The superseded token no longer verifies; the new one does.
        assert_eq!(
            reason(&db.verify_dispatch_capability(&identity(&first, PANE_A_REMINTED, "pid-2")).unwrap()),
            "The Dispatch capability is invalid."
        );
        assert_eq!(
            db.verify_dispatch_capability(&identity(&second, PANE_A_REMINTED, "pid-2")).unwrap(),
            CapabilityVerdict::valid()
        );
    }

    #[test]
    fn mint_refuses_an_inactive_or_unknown_dispatch() {
        let db = dispatched(Some(PANE_A));
        db.complete_dispatch("ctx1").unwrap();
        let (code, message) = coded(
            db.mint_dispatch_capability(&MintCapabilityParams {
                dispatch_id: "ctx1".to_string(),
                pane_key: PANE_A.to_string(),
                process_incarnation: "pid-1".to_string(),
            })
            .unwrap_err(),
        );
        assert_eq!(code, "dispatch_inactive");
        assert_eq!(message, "Dispatch ctx1 is not active.");
        // A completed dispatch keeps no capability it never had.
        assert_eq!(db.dispatch_context_by_id("ctx1").unwrap().unwrap().capability_hash, None);

        let (code, message) = coded(
            db.mint_dispatch_capability(&MintCapabilityParams {
                dispatch_id: "nope".to_string(),
                pane_key: PANE_A.to_string(),
                process_incarnation: "pid-1".to_string(),
            })
            .unwrap_err(),
        );
        assert_eq!(code, "dispatch_inactive");
        assert_eq!(message, "Dispatch nope is not active.");
    }

    #[test]
    fn verify_accepts_the_minted_capability_across_a_pane_remint() {
        let db = dispatched(Some(PANE_A));
        let capability = mint(&db, PANE_A, "pid-1");
        assert_eq!(
            db.verify_dispatch_capability(&identity(&capability, PANE_A, "pid-1")).unwrap(),
            CapabilityVerdict::valid()
        );
        // Same stable pane leaf behind a new tab id still verifies.
        assert_eq!(
            db.verify_dispatch_capability(&identity(&capability, PANE_A_REMINTED, "pid-1")).unwrap(),
            CapabilityVerdict::valid()
        );
    }

    #[test]
    fn verify_rejects_every_failure_mode_with_the_ts_reason() {
        let db = dispatched(Some(PANE_A));

        let unknown = DispatchIdentity { dispatch_id: "nope".to_string(), ..Default::default() };
        assert_eq!(
            reason(&db.verify_dispatch_capability(&unknown).unwrap()),
            "Dispatch nope was not found."
        );

        // Never minted.
        assert_eq!(
            reason(&db.verify_dispatch_capability(&identity("dcap_x", PANE_A, "pid-1")).unwrap()),
            "Dispatch ctx1 has no lifecycle capability."
        );

        let capability = mint(&db, PANE_A, "pid-1");

        // Missing / empty presented capability, checked before the compare.
        let mut missing = identity(&capability, PANE_A, "pid-1");
        missing.capability = None;
        assert_eq!(
            reason(&db.verify_dispatch_capability(&missing).unwrap()),
            "The Dispatch capability is missing."
        );
        missing.capability = Some(String::new());
        assert_eq!(
            reason(&db.verify_dispatch_capability(&missing).unwrap()),
            "The Dispatch capability is missing."
        );

        // Wrong token.
        assert_eq!(
            reason(&db.verify_dispatch_capability(&identity("dcap_wrong", PANE_A, "pid-1")).unwrap()),
            "The Dispatch capability is invalid."
        );

        // Right token, wrong pane — and a missing pane is equally a wrong pane.
        assert_eq!(
            reason(&db.verify_dispatch_capability(&identity(&capability, PANE_B, "pid-1")).unwrap()),
            "The caller is not the Dispatch pane."
        );
        let mut no_pane = identity(&capability, PANE_A, "pid-1");
        no_pane.pane_key = None;
        assert_eq!(
            reason(&db.verify_dispatch_capability(&no_pane).unwrap()),
            "The caller is not the Dispatch pane."
        );

        // Right token and pane, restarted process.
        assert_eq!(
            reason(&db.verify_dispatch_capability(&identity(&capability, PANE_A, "pid-2")).unwrap()),
            "The Dispatch process incarnation changed."
        );
        let mut no_incarnation = identity(&capability, PANE_A, "pid-1");
        no_incarnation.process_incarnation = None;
        assert_eq!(
            reason(&db.verify_dispatch_capability(&no_incarnation).unwrap()),
            "The Dispatch process incarnation changed."
        );

        // Revocation is checked before the token itself.
        db.revoke_dispatch_capability("ctx1").unwrap();
        assert_eq!(
            reason(&db.verify_dispatch_capability(&identity(&capability, PANE_A, "pid-1")).unwrap()),
            "Dispatch ctx1 capability is revoked."
        );
    }

    #[test]
    fn revoke_keeps_the_hash_and_the_first_stamp_and_ignores_unknown_ids() {
        let db = dispatched(Some(PANE_A));
        let capability = mint(&db, PANE_A, "pid-1");
        db.revoke_dispatch_capability("ctx1").unwrap();
        let first = db.dispatch_context_by_id("ctx1").unwrap().unwrap();
        assert!(first.capability_revoked_at.is_some());
        // The hash survives so a later presentation is diagnosable.
        assert_eq!(first.capability_hash.as_deref(), Some(hash_dispatch_capability(&capability).as_str()));

        db.connection()
            .execute(
                "UPDATE dispatch_contexts SET capability_revoked_at = '2020-01-01 00:00:00' WHERE id = 'ctx1'",
                [],
            )
            .unwrap();
        db.revoke_dispatch_capability("ctx1").unwrap();
        assert_eq!(
            db.dispatch_context_by_id("ctx1").unwrap().unwrap().capability_revoked_at.as_deref(),
            Some("2020-01-01 00:00:00")
        );

        // Unknown ids are a silent no-op, exactly like the TS UPDATE.
        db.revoke_dispatch_capability("nope").unwrap();
    }

    #[test]
    fn launch_token_commitment_is_first_write_wins() {
        let db = dispatched(Some(PANE_A));
        let committed = db.commit_dispatch_launch_token_hash("ctx1", "hash-1").unwrap();
        assert_eq!(committed.launch_token_hash.as_deref(), Some("hash-1"));

        // Re-committing the same hash is idempotent.
        let again = db.commit_dispatch_launch_token_hash("ctx1", "hash-1").unwrap();
        assert_eq!(again.launch_token_hash.as_deref(), Some("hash-1"));

        let (code, message) =
            coded(db.commit_dispatch_launch_token_hash("ctx1", "hash-2").unwrap_err());
        assert_eq!(code, "request_mismatch");
        assert_eq!(message, "Dispatch ctx1 already has a different launch-token commitment.");
        assert_eq!(
            db.dispatch_context_by_id("ctx1").unwrap().unwrap().launch_token_hash.as_deref(),
            Some("hash-1")
        );
    }

    #[test]
    fn launch_token_commitment_rejects_unknown_and_legacy_contract_dispatches() {
        let db = dispatched(Some(PANE_A));
        let (code, message) =
            coded(db.commit_dispatch_launch_token_hash("nope", "hash-1").unwrap_err());
        assert_eq!(code, "dispatch_not_found");
        assert_eq!(message, "Dispatch nope was not found.");

        db.connection()
            .execute("UPDATE dispatch_contexts SET contract_version = 0 WHERE id = 'ctx1'", [])
            .unwrap();
        let (code, message) =
            coded(db.commit_dispatch_launch_token_hash("ctx1", "hash-1").unwrap_err());
        assert_eq!(code, "request_mismatch");
        assert_eq!(message, "Dispatch ctx1 does not use the current contract.");
        assert_eq!(db.dispatch_context_by_id("ctx1").unwrap().unwrap().launch_token_hash, None);
    }

    #[test]
    fn process_currency_needs_both_an_equivalent_pane_and_the_same_incarnation() {
        let db = dispatched(Some(PANE_A));
        mint(&db, PANE_A, "pid-1");

        assert!(db.is_dispatch_process_current(&identity("", PANE_A, "pid-1")).unwrap());
        assert!(db.is_dispatch_process_current(&identity("", PANE_A_REMINTED, "pid-1")).unwrap());
        assert!(!db.is_dispatch_process_current(&identity("", PANE_B, "pid-1")).unwrap());
        assert!(!db.is_dispatch_process_current(&identity("", PANE_A, "pid-2")).unwrap());

        let mut absent = identity("", PANE_A, "pid-1");
        absent.pane_key = None;
        assert!(!db.is_dispatch_process_current(&absent).unwrap());
        let mut absent = identity("", PANE_A, "pid-1");
        absent.process_incarnation = None;
        assert!(!db.is_dispatch_process_current(&absent).unwrap());

        // Unknown dispatch, and a dispatch that never bound a process.
        let unknown = DispatchIdentity { dispatch_id: "nope".to_string(), ..Default::default() };
        assert!(!db.is_dispatch_process_current(&unknown).unwrap());
        db.create_task("t2", "second", None, &[], None, None, None, None).unwrap();
        db.create_dispatch_context("t2", "worker-2", "ctx2", None, None).unwrap();
        let unbound = DispatchIdentity {
            dispatch_id: "ctx2".to_string(),
            capability: None,
            pane_key: Some(PANE_A.to_string()),
            process_incarnation: Some("pid-1".to_string()),
        };
        assert!(!db.is_dispatch_process_current(&unbound).unwrap());
    }

    #[test]
    fn active_dispatch_resolves_by_handle_then_by_equivalent_pane() {
        let db = dispatched(Some(PANE_A));

        // Handle hit needs no pane key at all.
        assert_eq!(
            db.get_active_dispatch_for_identity("worker-1", None).unwrap().unwrap().id,
            "ctx1"
        );
        // Reminted handle, same pane leaf.
        assert_eq!(
            db.get_active_dispatch_for_identity("worker-9", Some(PANE_A_REMINTED))
                .unwrap()
                .unwrap()
                .id,
            "ctx1"
        );
        // A different pane, and an absent/empty pane key, resolve to nothing.
        assert!(db.get_active_dispatch_for_identity("worker-9", Some(PANE_B)).unwrap().is_none());
        assert!(db.get_active_dispatch_for_identity("worker-9", None).unwrap().is_none());
        assert!(db.get_active_dispatch_for_identity("worker-9", Some("")).unwrap().is_none());

        // Only active dispatches count.
        db.complete_dispatch("ctx1").unwrap();
        assert!(db.get_active_dispatch_for_identity("worker-1", Some(PANE_A)).unwrap().is_none());
    }
}
