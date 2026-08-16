//! MCP server config inspection, ported from `inspectMcpConfigContent` in
//! `src/shared/mcp-config.ts` and `summarizeMcpServer` in
//! `src/shared/mcp-server-inspection.ts`. Parses a config's JSON, extracts the
//! servers object at the candidate's path, and summarizes each server's
//! transport/status, masking sensitive env via `orca-text`.
//!
//! Four bounds run over untrusted config text before anything is copied out of
//! it, and each one has its own answer, so they are behaviour and not hygiene:
//!
//! | bound | cap | answer |
//! | --- | --- | --- |
//! | config text | 256 KiB | invalid, **checked before parsing** |
//! | server cardinality + name length | 256 / 4 KiB | invalid, `servers: []` |
//! | command / URL length | 64 KiB | that server invalid, env dropped |
//! | env field count / key / value | 256 / 4 KiB / 64 KiB | that server invalid, env dropped |

use crate::js_value_string::js_string;
use orca_text::mcp_config_inspection_limits::{
    is_mcp_config_inspection_field_within_limit, is_mcp_config_inspection_name_within_limit,
    is_mcp_config_inspection_text_within_limit, MCP_CONFIG_INSPECTION_MAX_SERVERS,
};
use orca_text::mcp_env::{inspect_mcp_env, BoundedMcpEnv};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpServerTransport {
    Stdio,
    Http,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpServerStatus {
    Enabled,
    Disabled,
    Invalid,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct McpServerSummary {
    pub name: String,
    pub transport: Option<McpServerTransport>,
    pub status: Option<McpServerStatus>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub env: Option<Vec<(String, String)>>,
    pub issue: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpConfigInspection {
    pub exists: bool,
    /// "missing" | "valid" | "invalid"
    pub status: String,
    pub servers: Vec<McpServerSummary>,
    pub error: Option<String>,
}

/// Inspect a config file's content (`None` = file absent). `servers_path` is the
/// candidate's path to the servers object (e.g. `["mcpServers"]`).
pub fn inspect_mcp_config_content(content: Option<&str>, servers_path: &[&str]) -> McpConfigInspection {
    let Some(content) = content else {
        return McpConfigInspection { exists: false, status: "missing".into(), servers: Vec::new(), error: None };
    };
    // Before `from_str`, exactly as the TS checks before `JSON.parse`: the point
    // of a size bound is that the parser never sees the oversized text.
    if !is_mcp_config_inspection_text_within_limit(content) {
        return invalid_config("MCP config exceeds the inspection size limit.");
    }
    let parsed: Value = match serde_json::from_str(content) {
        Ok(value) => value,
        // Don't expose file contents; just note it failed to parse.
        Err(error) => return invalid_config(&format!("Invalid JSON: {error}")),
    };

    let Some(servers) = extract_object_at_path(&parsed, servers_path) else {
        return McpConfigInspection { exists: true, status: "valid".into(), servers: Vec::new(), error: None };
    };

    let Some(entries) = collect_mcp_server_entries(servers) else {
        return invalid_config("MCP server collection exceeds the inspection limits.");
    };

    let servers = entries.into_iter().map(|(name, entry)| summarize_mcp_server(name, entry)).collect();
    McpConfigInspection { exists: true, status: "valid".into(), servers, error: None }
}

fn invalid_config(error: &str) -> McpConfigInspection {
    McpConfigInspection {
        exists: true,
        status: "invalid".into(),
        servers: Vec::new(),
        error: Some(error.to_string()),
    }
}

fn extract_object_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Map<String, Value>> {
    let mut current = value;
    for segment in path {
        current = current.as_object()?.get(*segment)?;
    }
    current.as_object()
}

/// `collectMcpServerEntries`: the whole collection is refused (not truncated) the
/// moment it runs past the cardinality cap or carries an over-long name.
fn collect_mcp_server_entries(servers: &Map<String, Value>) -> Option<Vec<(&String, &Value)>> {
    let mut entries: Vec<(&String, &Value)> = Vec::new();
    for (name, entry) in js_own_key_order(servers) {
        if entries.len() >= MCP_CONFIG_INSPECTION_MAX_SERVERS
            || !is_mcp_config_inspection_name_within_limit(name)
        {
            return None;
        }
        entries.push((name, entry));
    }
    Some(entries)
}

/// JS own-property order for a parsed JSON object: canonical array-index keys
/// ascending, then every other key in insertion order.
///
/// `JSON.parse` builds an ordinary object and `for…in` walks
/// OrdinaryOwnPropertyKeys, so the twin lists a server named `"2"` before `"10"`.
/// serde_json's `preserve_order` map keeps file order, so without this the two
/// answer different `servers` arrays for numeric names.
fn js_own_key_order(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<(&String, &Value)> = object.iter().collect();
    // Stable, so the non-index keys keep the order they were parsed in.
    entries.sort_by_key(|(key, _)| match array_index_key(key) {
        Some(index) => (0u8, index),
        None => (1u8, 0),
    });
    entries
}

/// The spec's array-index test: `ToString(ToUint32(P)) == P` and not 2^32-1.
fn array_index_key(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // "01" and "0000" are not canonical, so JS keeps them as ordinary keys.
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    match key.parse::<u32>() {
        Ok(index) if index != u32::MAX => Some(index),
        _ => None,
    }
}

fn summarize_mcp_server(name: &str, entry: &Value) -> McpServerSummary {
    let Some(raw) = entry.as_object() else {
        return invalid_server(name, "Server entry must be an object.", None, McpServerTransport::Unknown);
    };

    let command = read_command(raw);
    let url = read_url(raw);
    let env = inspect_env(raw.get("env"));

    // Oversize answers come first and carry NO env and NO transport: the twin's
    // `invalidServer` defaults both, so a server that blew a field cap reports
    // `unknown` even when it declared `type: "http"`.
    if command.oversized {
        return invalid_server(
            name,
            "Command exceeds the MCP inspection field limit.",
            None,
            McpServerTransport::Unknown,
        );
    }
    if url.oversized {
        return invalid_server(
            name,
            "URL exceeds the MCP inspection field limit.",
            None,
            McpServerTransport::Unknown,
        );
    }
    if env.oversized {
        return invalid_server(
            name,
            "Environment exceeds the MCP inspection field limits.",
            None,
            McpServerTransport::Unknown,
        );
    }

    let transport = resolve_transport(raw, &command.value, &url.value);
    let enabled = raw.get("enabled") != Some(&Value::Bool(false))
        && raw.get("disabled") != Some(&Value::Bool(true));

    match transport {
        McpServerTransport::Unknown => {
            invalid_server(name, "Missing command or URL.", env.value, McpServerTransport::Unknown)
        }
        McpServerTransport::Http if !url.value.as_deref().is_some_and(|v| !v.is_empty()) => {
            invalid_server(name, "Missing URL.", env.value, transport)
        }
        McpServerTransport::Stdio if !command.value.as_deref().is_some_and(|v| !v.is_empty()) => {
            invalid_server(name, "Missing command.", env.value, transport)
        }
        _ => McpServerSummary {
            name: name.to_string(),
            transport: Some(transport),
            status: Some(if enabled { McpServerStatus::Enabled } else { McpServerStatus::Disabled }),
            command: command.value,
            url: url.value,
            env: env.value,
            issue: None,
        },
    }
}

fn invalid_server(
    name: &str,
    issue: &str,
    env: Option<Vec<(String, String)>>,
    transport: McpServerTransport,
) -> McpServerSummary {
    McpServerSummary {
        name: name.to_string(),
        transport: Some(transport),
        status: Some(McpServerStatus::Invalid),
        env,
        issue: Some(issue.to_string()),
        ..Default::default()
    }
}

/// The TS `BoundedString`: an over-long field is not truncated, it is refused,
/// and the refusal is what the caller reports.
struct BoundedString {
    value: Option<String>,
    oversized: bool,
}

fn bounded_string(value: Option<String>) -> BoundedString {
    match value {
        Some(value) if !is_mcp_config_inspection_field_within_limit(&value) => {
            BoundedString { value: None, oversized: true }
        }
        value => BoundedString { value, oversized: false },
    }
}

fn read_command(raw: &Map<String, Value>) -> BoundedString {
    bounded_string(match raw.get("command") {
        Some(Value::String(command)) => Some(command.clone()),
        Some(Value::Array(items)) => items.first().and_then(Value::as_str).map(str::to_string),
        _ => None,
    })
}

fn read_url(raw: &Map<String, Value>) -> BoundedString {
    bounded_string(
        raw.get("url")
            .and_then(Value::as_str)
            .or_else(|| raw.get("httpUrl").and_then(Value::as_str))
            .map(str::to_string),
    )
}

fn resolve_transport(
    raw: &Map<String, Value>,
    command: &Option<String>,
    url: &Option<String>,
) -> McpServerTransport {
    // The twin branches on JS TRUTHINESS (`|| url`, `|| command`), so an EMPTY
    // string is falsy there and `is_some()` is not the same test: `{command:""}`
    // resolved to stdio here and came back "enabled", where the twin answers
    // unknown and reports "Missing command or URL." — a misconfiguration the pane
    // exists to surface, rendered as a healthy server.
    let truthy = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.is_empty());
    let type_field = raw.get("type").and_then(Value::as_str);
    if matches!(type_field, Some("http") | Some("remote")) || truthy(url) {
        McpServerTransport::Http
    } else if type_field == Some("local") || truthy(command) {
        McpServerTransport::Stdio
    } else {
        McpServerTransport::Unknown
    }
}

/// `inspectMcpEnv` over the JSON: coerce each value the way `String(x)` would,
/// then hand the bounded walk to `orca-text`.
///
/// Coercing every value up front (the twin coerces inside its loop and bails at
/// the first violation) cannot change the answer — a violation anywhere drops
/// the whole map — and the work is already bounded by the 256 KiB config cap.
fn inspect_env(env: Option<&Value>) -> BoundedMcpEnv {
    let Some(object) = env.and_then(Value::as_object) else {
        return BoundedMcpEnv::default();
    };
    let pairs: Vec<(String, String)> = js_own_key_order(object)
        .into_iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text.clone(),
                other => js_string(other),
            };
            (key.clone(), text)
        })
        .collect();
    let refs: Vec<(&str, &str)> = pairs.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    inspect_mcp_env(Some(&refs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use orca_text::mcp_config_inspection_limits::{
        MCP_CONFIG_INSPECTION_MAX_BYTES, MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS,
        MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES, MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS,
        MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS,
    };

    fn summary(
        name: &str,
        transport: McpServerTransport,
        status: McpServerStatus,
        command: Option<&str>,
        url: Option<&str>,
        env: Option<Vec<(&str, &str)>>,
        issue: Option<&str>,
    ) -> McpServerSummary {
        McpServerSummary {
            name: name.to_string(),
            transport: Some(transport),
            status: Some(status),
            command: command.map(str::to_string),
            url: url.map(str::to_string),
            env: env.map(|e| e.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
            issue: issue.map(str::to_string),
        }
    }

    fn inspect(content: &str) -> McpConfigInspection {
        inspect_mcp_config_content(Some(content), &["mcpServers"])
    }

    /// One server named `bounded`, so a case can vary just its entry.
    fn inspect_server(entry: &str) -> McpServerSummary {
        let content = format!(r#"{{"mcpServers":{{"bounded":{entry}}}}}"#);
        inspect(&content).servers.into_iter().next().expect("one server")
    }

    fn json_string(value: &str) -> String {
        Value::String(value.to_string()).to_string()
    }

    #[test]
    fn reports_missing_config() {
        let result = inspect_mcp_config_content(None, &["mcpServers"]);
        assert!(!result.exists);
        assert_eq!(result.status, "missing");
        assert!(result.servers.is_empty());
    }

    #[test]
    fn reports_invalid_json_without_exposing_contents() {
        let result = inspect("{");
        assert_eq!(result.status, "invalid");
        assert!(result.error.as_deref().unwrap().contains("JSON"));
        assert!(result.servers.is_empty());
    }

    #[test]
    fn summarizes_stdio_http_disabled_and_invalid_servers() {
        let content = r#"{
            "mcpServers": {
                "filesystem": { "command": "npx", "args": ["-y", "x"], "env": { "NODE_ENV": "production", "API_TOKEN": "secret-token" } },
                "docs": { "type": "http", "url": "https://example.com/mcp" },
                "old": { "command": "node", "enabled": false },
                "broken": { "args": ["missing-command"] }
            }
        }"#;
        let result = inspect(content);
        assert_eq!(result.status, "valid");
        assert_eq!(
            result.servers,
            vec![
                summary(
                    "filesystem",
                    McpServerTransport::Stdio,
                    McpServerStatus::Enabled,
                    Some("npx"),
                    None,
                    Some(vec![("NODE_ENV", "production"), ("API_TOKEN", "••••••••")]),
                    None,
                ),
                summary("docs", McpServerTransport::Http, McpServerStatus::Enabled, None, Some("https://example.com/mcp"), None, None),
                summary("old", McpServerTransport::Stdio, McpServerStatus::Disabled, Some("node"), None, None, None),
                summary("broken", McpServerTransport::Unknown, McpServerStatus::Invalid, None, None, None, Some("Missing command or URL.")),
            ]
        );
    }

    #[test]
    fn supports_agent_specific_command_and_url_shapes_from_common_adapters() {
        let content = r#"{"mcpServers":{"opencodeLocal":{"type":"local","command":["uvx","server"]},"geminiRemote":{"httpUrl":"https://example.com/sse"}}}"#;
        let result = inspect(content);
        assert_eq!(result.servers[0].transport, Some(McpServerTransport::Stdio));
        assert_eq!(result.servers[0].command.as_deref(), Some("uvx"));
        assert_eq!(result.servers[1].transport, Some(McpServerTransport::Http));
        assert_eq!(result.servers[1].url.as_deref(), Some("https://example.com/sse"));
    }

    #[test]
    fn marks_declared_transports_without_their_target_as_invalid() {
        let content = r#"{"mcpServers":{"remoteMissingUrl":{"type":"http"},"localMissingCommand":{"type":"local"}}}"#;
        let result = inspect(content);
        assert_eq!(
            result.servers,
            vec![
                summary("remoteMissingUrl", McpServerTransport::Http, McpServerStatus::Invalid, None, None, None, Some("Missing URL.")),
                summary("localMissingCommand", McpServerTransport::Stdio, McpServerStatus::Invalid, None, None, None, Some("Missing command.")),
            ]
        );
    }

    #[test]
    fn keeps_starter_config_valid_and_empty() {
        let result = inspect("{\n  \"mcpServers\": {}\n}\n");
        assert!(result.exists);
        assert_eq!(result.status, "valid");
        assert!(result.servers.is_empty());
    }

    // --- the four inspection bounds, translated from the twin's own tests ---

    #[test]
    fn parses_the_exact_input_boundary_and_rejects_plus_one_before_json_parsing() {
        let exact = format!("{}{{}}", " ".repeat(MCP_CONFIG_INSPECTION_MAX_BYTES - 2));
        assert_eq!(inspect(&exact).status, "valid");

        let over = inspect(&format!("{exact} "));
        assert_eq!(over.status, "invalid");
        // The size answer, not a parse answer: the parser never ran.
        assert_eq!(over.error.as_deref(), Some("MCP config exceeds the inspection size limit."));
    }

    #[test]
    fn rejects_multibyte_input_over_the_byte_cap_before_json_parsing() {
        let content = "é".repeat(MCP_CONFIG_INSPECTION_MAX_BYTES / 2 + 1);
        let result = inspect(&content);
        assert_eq!(result.status, "invalid");
        // `é…` is not JSON either; the size cap is what answered.
        assert_eq!(result.error.as_deref(), Some("MCP config exceeds the inspection size limit."));
    }

    #[test]
    fn admits_the_exact_server_cardinality_and_rejects_plus_one() {
        let entries: Vec<String> = (0..MCP_CONFIG_INSPECTION_MAX_SERVERS)
            .map(|index| format!(r#""server-{index}":{{"command":"node"}}"#))
            .collect();
        let exact = format!(r#"{{"mcpServers":{{{}}}}}"#, entries.join(","));
        assert_eq!(inspect(&exact).servers.len(), MCP_CONFIG_INSPECTION_MAX_SERVERS);

        let over = format!(
            r#"{{"mcpServers":{{{},"overflow":{{"command":"node"}}}}}}"#,
            entries.join(",")
        );
        let result = inspect(&over);
        assert_eq!(result.status, "invalid");
        assert!(result.servers.is_empty());
        assert_eq!(result.error.as_deref(), Some("MCP server collection exceeds the inspection limits."));
    }

    #[test]
    fn admits_an_exact_size_command_and_rejects_the_field_at_plus_one() {
        let exact = "x".repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS);
        let exact_utf8 = "é".repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES / 2);
        let inspect_command = |command: &str| {
            inspect_server(&format!(r#"{{"command":{}}}"#, json_string(command)))
        };

        assert_eq!(inspect_command(&exact).status, Some(McpServerStatus::Enabled));
        assert_eq!(inspect_command(&exact).command.as_deref(), Some(exact.as_str()));
        let over = inspect_command(&format!("{exact}x"));
        assert_eq!(over.status, Some(McpServerStatus::Invalid));
        assert_eq!(over.issue.as_deref(), Some("Command exceeds the MCP inspection field limit."));

        assert_eq!(inspect_command(&exact_utf8).status, Some(McpServerStatus::Enabled));
        let over_utf8 = inspect_command(&format!("{exact_utf8}é"));
        assert_eq!(over_utf8.status, Some(McpServerStatus::Invalid));
        assert_eq!(over_utf8.issue.as_deref(), Some("Command exceeds the MCP inspection field limit."));
    }

    #[test]
    fn admits_the_exact_env_cardinality_and_rejects_plus_one_without_retaining_env_values() {
        let fields: Vec<String> = (0..MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS)
            .map(|index| format!(r#""KEY_{index}":"value""#))
            .collect();
        let exact = inspect_server(&format!(
            r#"{{"command":"node","env":{{{}}}}}"#,
            fields.join(",")
        ));
        assert_eq!(exact.env.as_ref().map(Vec::len), Some(MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS));

        let over = inspect_server(&format!(
            r#"{{"command":"node","env":{{{},"OVERFLOW":"value"}}}}"#,
            fields.join(",")
        ));
        assert_eq!(over.status, Some(McpServerStatus::Invalid));
        assert_eq!(over.issue.as_deref(), Some("Environment exceeds the MCP inspection field limits."));
        assert_eq!(over.env, None);
    }

    // --- bounds the twin implements but does not unit-test ---

    #[test]
    fn an_over_long_url_is_invalid_and_reports_unknown_transport() {
        let url = "u".repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS + 1);
        let server = inspect_server(&format!(
            r#"{{"type":"http","url":{},"env":{{"FINE":"ok"}}}}"#,
            json_string(&url)
        ));
        assert_eq!(
            server,
            summary(
                "bounded",
                // `invalidServer` defaults the transport even though `type` said http.
                McpServerTransport::Unknown,
                McpServerStatus::Invalid,
                None,
                None,
                None,
                Some("URL exceeds the MCP inspection field limit."),
            )
        );
    }

    #[test]
    fn an_over_long_server_name_or_env_key_refuses_the_collection_or_the_env() {
        let name = "n".repeat(MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS + 1);
        let result = inspect(&format!(
            r#"{{"mcpServers":{{{}:{{"command":"node"}}}}}}"#,
            json_string(&name)
        ));
        assert_eq!(result.status, "invalid");
        assert_eq!(result.error.as_deref(), Some("MCP server collection exceeds the inspection limits."));

        let key = "k".repeat(MCP_CONFIG_INSPECTION_MAX_NAME_CODE_UNITS + 1);
        let server = inspect_server(&format!(
            r#"{{"command":"node","env":{{{}:"v"}}}}"#,
            json_string(&key)
        ));
        assert_eq!(server.issue.as_deref(), Some("Environment exceeds the MCP inspection field limits."));
        assert_eq!(server.env, None);
    }

    #[test]
    fn env_values_are_coerced_the_way_js_string_would_not_dropped() {
        let server = inspect_server(
            r#"{"command":"node","env":{"N":5,"F":5.0,"B":true,"NIL":null,"ARR":[1,2],"OBJ":{"a":1}}}"#,
        );
        assert_eq!(
            server.env,
            Some(
                vec![
                    ("N", "5"),
                    ("F", "5"),
                    ("B", "true"),
                    ("NIL", "null"),
                    ("ARR", "1,2"),
                    ("OBJ", "[object Object]"),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
            )
        );
    }

    #[test]
    fn servers_list_in_js_own_key_order_not_file_order() {
        // JSON.parse builds an ordinary object, so "2" sorts before "10" and
        // both sort before the non-index names, which keep file order.
        let result = inspect(
            r#"{"mcpServers":{"10":{"command":"a"},"b":{"command":"b"},"2":{"command":"c"},"01":{"command":"d"}}}"#,
        );
        let names: Vec<&str> = result.servers.iter().map(|server| server.name.as_str()).collect();
        assert_eq!(names, vec!["2", "10", "b", "01"]);
    }

    #[test]
    fn http_without_url_is_invalid() {
        let result = inspect(r#"{"mcpServers": {"x": {"type": "http"}}}"#);
        assert_eq!(result.servers[0].status, Some(McpServerStatus::Invalid));
        assert_eq!(result.servers[0].issue.as_deref(), Some("Missing URL."));
    }

    #[test]
    fn missing_servers_object_is_valid_empty() {
        let result = inspect(r#"{"other": 1}"#);
        assert_eq!(result.status, "valid");
        assert!(result.servers.is_empty());
    }
}
