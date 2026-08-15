//! MCP env inspection, ported from `inspectMcpEnv`/`maskMcpEnv` in
//! `src/shared/mcp-server-inspection.ts` (re-exported by `mcp-config.ts`).
//!
//! Two jobs, in the twin's order: BOUND the map (field count, key length, value
//! length) and mask values whose key looks credential-ish or whose value looks
//! like a known token shape (OpenAI `sk-…`, GitHub `ghp_…`, Slack `xox?-…`), so
//! MCP server configs can be surfaced without leaking secrets.
//!
//! The bounds are not cosmetic: an oversized env is DROPPED WHOLE, which is what
//! turns the owning server summary invalid. Callers pass values already coerced
//! to strings the way JS `String(x)` would (see `orca_config::js_value_string`),
//! because the twin coerces before it measures.

use crate::mcp_config_inspection_limits::{
    is_mcp_config_inspection_field_within_limit, is_mcp_config_inspection_name_within_limit,
    MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS,
};
use regex::Regex;
use std::sync::OnceLock;

const MASK: &str = "••••••••";

fn sensitive_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // ASCII case-insensitive (`-u`): keys are ASCII; substring match.
    RE.get_or_init(|| {
        Regex::new(r"(?i-u)(api[_-]?key|auth|bearer|cookie|credential|password|private[_-]?key|secret|session|token)").unwrap()
    })
}

fn sensitive_value_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})").unwrap()
    })
}

/// The TS `BoundedEnv`: a masked map, or nothing plus the reason.
///
/// `oversized` is the part callers cannot reconstruct from `value`: a server
/// whose env blew a bound is INVALID, while a server with no env at all is fine.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BoundedMcpEnv {
    pub value: Option<Vec<(String, String)>>,
    pub oversized: bool,
}

/// `inspectMcpEnv`. `None` in (missing/non-object env) → neither value nor
/// oversize. Input order is preserved; the first bound violation drops the
/// whole map.
pub fn inspect_mcp_env(env: Option<&[(&str, &str)]>) -> BoundedMcpEnv {
    let Some(env) = env else {
        return BoundedMcpEnv::default();
    };

    let mut masked: Vec<(String, String)> = Vec::new();
    let mut fields: usize = 0;
    for (key, value) in env {
        fields = fields.saturating_add(1);
        if fields > MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS
            || !is_mcp_config_inspection_name_within_limit(key)
        {
            return BoundedMcpEnv { value: None, oversized: true };
        }
        if !is_mcp_config_inspection_field_within_limit(value) {
            return BoundedMcpEnv { value: None, oversized: true };
        }
        let text = if sensitive_key_re().is_match(key) || sensitive_value_re().is_match(value) {
            MASK.to_string()
        } else {
            (*value).to_string()
        };
        masked.push(((*key).to_string(), text));
    }
    BoundedMcpEnv { value: Some(masked), oversized: false }
}

/// `maskMcpEnv`: the masked map, or nothing — which the twin answers for a
/// missing/non-object env AND for one that blew a bound.
pub fn mask_mcp_env(env: Option<&[(&str, &str)]>) -> Option<Vec<(String, String)>> {
    inspect_mcp_env(env).value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_config_inspection_limits::{
        MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS, MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS,
    };

    fn masked(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        mask_mcp_env(Some(pairs)).unwrap()
    }

    #[test]
    fn masks_by_sensitive_key_or_value() {
        assert_eq!(
            masked(&[("NORMAL", "visible"), ("PASSWORD", "hunter2"), ("MAYBE", "sk-abc123456789xyz")]),
            vec![
                ("NORMAL".to_string(), "visible".to_string()),
                ("PASSWORD".to_string(), MASK.to_string()),
                ("MAYBE".to_string(), MASK.to_string()),
            ]
        );
    }

    #[test]
    fn masks_various_key_shapes_case_insensitively() {
        for key in ["API_KEY", "api-key", "apikey", "AUTH", "github_token", "Session", "PRIVATE-KEY"] {
            assert_eq!(masked(&[(key, "plainvalue")])[0].1, MASK, "key {key}");
        }
        // A non-sensitive key + non-token value is left visible.
        assert_eq!(masked(&[("REGION", "us-east-1")])[0].1, "us-east-1");
    }

    #[test]
    fn masks_known_token_value_shapes() {
        // The Slack shape is split: a published file may not carry a contiguous
        // token-shaped literal, and `concat!` keeps the value byte-identical.
        for value in ["ghp_0123456789abcdef", concat!("xox", "b-0123456789012"), "sk-0123456789abcdefxyz"] {
            assert_eq!(masked(&[("X", value)])[0].1, MASK, "value {value}");
        }
        // Too-short token-like values are not masked.
        assert_eq!(masked(&[("X", "sk-short")])[0].1, "sk-short");
    }

    #[test]
    fn none_env_returns_none() {
        assert_eq!(mask_mcp_env(None), None);
        assert_eq!(inspect_mcp_env(None), BoundedMcpEnv { value: None, oversized: false });
    }

    #[test]
    fn admits_the_exact_env_cardinality_and_rejects_plus_one() {
        let keys: Vec<String> =
            (0..MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS).map(|index| format!("KEY_{index}")).collect();
        let mut pairs: Vec<(&str, &str)> =
            keys.iter().map(|key| (key.as_str(), "value")).collect();
        assert_eq!(mask_mcp_env(Some(&pairs)).unwrap().len(), MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS);

        pairs.push(("OVERFLOW", "value"));
        assert_eq!(
            inspect_mcp_env(Some(&pairs)),
            BoundedMcpEnv { value: None, oversized: true }
        );
        assert_eq!(mask_mcp_env(Some(&pairs)), None);
    }

    #[test]
    fn drops_the_whole_map_when_a_key_or_value_blows_its_cap() {
        let long_key = "K".repeat(MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS + 1);
        assert!(mask_mcp_env(Some(&[("FINE", "ok"), (&long_key, "v")])).is_none());

        let long_value = "v".repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS + 1);
        assert!(mask_mcp_env(Some(&[("FINE", "ok"), ("BIG", &long_value)])).is_none());

        // Exactly at the caps, the map survives whole.
        let exact_key = "K".repeat(MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS);
        let exact_value = "v".repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS);
        assert_eq!(
            mask_mcp_env(Some(&[(exact_key.as_str(), exact_value.as_str())])).unwrap().len(),
            1
        );
    }
}
