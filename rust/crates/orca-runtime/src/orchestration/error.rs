//! The coded orchestration failure, ported from the reference branch's
//! `orchestration/error.rs`.
//!
//! Capability callers branch on a machine-readable `code`
//! (`dispatch_inactive`, `dispatch_not_found`, `request_mismatch`), so a plain
//! string loses information. Every store fn keeps returning
//! `Result<_, StoreError>` (the napi class and the existing fns depend on that
//! shape); a coded failure travels as a `StoreError::Message` holding the JSON
//! envelope below, which `orchestration-error.ts` parses back into an
//! `OrchestrationError`. Scoped to the capability methods — existing methods
//! keep their verbatim messages, so no main consumer changes.

use orca_store::StoreError;

/// Marker key that distinguishes a coded orchestration failure from a bare
/// SQLite/message error when the shim inspects `error.message`.
pub const ORCHESTRATION_ERROR_MARKER: &str = "_orcaOrchestrationError";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrchestrationError {
    pub code: String,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

impl OrchestrationError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), data: None }
    }
}

impl std::fmt::Display for OrchestrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            serde_json::json!({
                ORCHESTRATION_ERROR_MARKER: true,
                "code": self.code,
                "message": self.message,
                "data": self.data,
            })
        )
    }
}

impl std::error::Error for OrchestrationError {}

impl From<OrchestrationError> for StoreError {
    fn from(error: OrchestrationError) -> Self {
        StoreError::Message(error.to_string())
    }
}

/// Shorthand for `Err(OrchestrationError::new(code, message).into())`.
pub fn orchestration_err<T>(
    code: impl Into<String>,
    message: impl Into<String>,
) -> Result<T, StoreError> {
    Err(OrchestrationError::new(code, message).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coded_error_survives_the_store_error_envelope() {
        let store_error: StoreError =
            OrchestrationError::new("dispatch_not_found", "Dispatch d1 was not found.").into();
        let StoreError::Message(text) = store_error else {
            panic!("expected a message error");
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed[ORCHESTRATION_ERROR_MARKER], serde_json::json!(true));
        assert_eq!(parsed["code"], "dispatch_not_found");
        assert_eq!(parsed["message"], "Dispatch d1 was not found.");
        assert_eq!(parsed["data"], serde_json::Value::Null);
    }
}
