//! The `_orcaLifecycleRejection` payload marker. A `worker_done`/`heartbeat`
//! message from a sender that no longer owns the dispatch is rewritten rather
//! than deleted: the marker demotes it to audit-only so it stays queryable but
//! never reaches a read path as an actionable completion or liveness event.

/// Port of `addLifecycleRejectionMarker(payload, code, reason)`: merge the audit
/// marker into the message payload object (or a fresh object when the payload is
/// absent or not a JSON object), mirroring
/// `JSON.stringify({ ...parsed, _orcaLifecycleRejection })`.
pub fn add_lifecycle_rejection_marker(payload: Option<&str>, code: &str, reason: &str) -> String {
    let mut obj = match payload.and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok()) {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    obj.insert(
        "_orcaLifecycleRejection".to_string(),
        serde_json::json!({ "code": code, "reason": reason }),
    );
    serde_json::Value::Object(obj).to_string()
}

/// Port of `hasLifecycleRejectionMarker`: does this payload already carry the
/// marker? Drives the legacy contract classification that demotes such rows to
/// `audit_only`.
pub fn has_lifecycle_rejection_marker(payload: Option<&str>) -> bool {
    let Some(value) = payload.and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok()) else {
        return false;
    };
    let Some(marker) = value.get("_orcaLifecycleRejection").and_then(|m| m.as_object()) else {
        return false;
    };
    // Both fields must be strings — a half-written marker is not a rejection.
    marker.get("code").is_some_and(|v| v.is_string())
        && marker.get("reason").is_some_and(|v| v.is_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips_through_the_probe() {
        let marked = add_lifecycle_rejection_marker(Some(r#"{"a":1}"#), "sender_not_assignee", "stale");
        assert!(has_lifecycle_rejection_marker(Some(&marked)));
        assert!(marked.contains(r#""a":1"#));
        assert!(!has_lifecycle_rejection_marker(Some(r#"{"a":1}"#)));
        assert!(!has_lifecycle_rejection_marker(None));
        // A non-object payload is replaced by a fresh object, not corrupted.
        assert!(has_lifecycle_rejection_marker(Some(&add_lifecycle_rejection_marker(
            Some("not json"),
            "stale_dispatch",
            "stale"
        ))));
    }
}
