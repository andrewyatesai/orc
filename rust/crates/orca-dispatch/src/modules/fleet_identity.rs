//! Parity dispatch for `orca_policy::fleet_identity` vs its TS twins
//! `src/shared/fleet-identity/{route-key,store-key,pty-binding}.ts`.
//!
//! Like `policy`, this seam guards AUTHORITY rather than formatting: a route key
//! names whose subscription is spent, a store key names which credential files a
//! launch may write. A silent divergence here is a credential-corruption bug, so
//! both sides run the same vectors.
//!
//! The JSON shapes mirror the TS types exactly (`{kind, accountId?}`,
//! `{kind, distro|targetId|environmentId}`, `{surfaces: [...]}`), including
//! `distro: null` for the default WSL distro — the parity comparison treats a
//! missing key and an explicit null as different, which is the right strictness
//! for a type whose whole point is that "absent" is a real, named case.

use orca_policy::fleet_identity::{
    bindings_blocking_store, commit_pty_binding, create_store_key, deserialize_pty_binding,
    format_route_account_scope, format_route_key, format_store_key, parse_route_key,
    parse_store_key, pty_bindings_equal, route_keys_equal, serialize_pty_binding, store_keys_equal,
    store_keys_overlap, union_store_keys, CredentialSurface, PtyBinding, PtyBindingInput,
    RouteAccount, RouteHost, RouteKey, StoreKey,
};
use serde_json::{json, Value};

fn error(message: String) -> Value {
    json!({ "__parity_error__": message })
}

/// JS `String(value)` over a JSON value, and `String(null ?? '')` for null.
///
/// Only the persistence seam needs it: `deserializePtyBinding` reads its
/// incarnation id through `String(raw.ptyIncarnationId ?? '')`, so a persisted
/// row whose field is a number is a row the TS ACCEPTS. Numbers are rendered by
/// `serde_json`, which agrees with JS on integers and plain decimals but not on
/// the exponent forms (`1e21` vs JS `1e+21`) — off-schema enough that no vector
/// goes there.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        // `Array.prototype.join(',')`, which stringifies each element the same
        // way and renders null as empty.
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

// --- RouteKey <-> JSON -----------------------------------------------------

fn route_from_json(value: &Value) -> Option<RouteKey> {
    let account = value.get("account")?;
    let account = match account.get("kind").and_then(Value::as_str)? {
        "system-default" => RouteAccount::SystemDefault,
        "managed" => RouteAccount::Managed {
            account_id: account
                .get("accountId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        _ => return None,
    };
    let host = value.get("host")?;
    let host = match host.get("kind").and_then(Value::as_str)? {
        "local" => RouteHost::Local,
        // An absent `distro` reads the same as an explicit null: both are "the
        // default distro", which is what `normalizeDistro` does on the TS side.
        "wsl" => RouteHost::Wsl {
            distro: host
                .get("distro")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        },
        "ssh" => RouteHost::Ssh {
            target_id: host
                .get("targetId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        "runtime" => RouteHost::Runtime {
            environment_id: host
                .get("environmentId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        _ => return None,
    };
    Some(RouteKey {
        provider: value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        account,
        host,
    })
}

fn route_to_json(key: &RouteKey) -> Value {
    let account = match &key.account {
        RouteAccount::SystemDefault => json!({ "kind": "system-default" }),
        RouteAccount::Managed { account_id } => {
            json!({ "kind": "managed", "accountId": account_id })
        }
    };
    let host = match &key.host {
        RouteHost::Local => json!({ "kind": "local" }),
        RouteHost::Wsl { distro } => json!({ "kind": "wsl", "distro": distro }),
        RouteHost::Ssh { target_id } => json!({ "kind": "ssh", "targetId": target_id }),
        RouteHost::Runtime { environment_id } => {
            json!({ "kind": "runtime", "environmentId": environment_id })
        }
    };
    json!({ "provider": key.provider, "account": account, "host": host })
}

// --- StoreKey <-> JSON -----------------------------------------------------

fn surface_from_json(value: &Value) -> Option<CredentialSurface> {
    let path = || {
        value
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    match value.get("kind").and_then(Value::as_str)? {
        "config-dir" => Some(CredentialSurface::ConfigDir { path: path() }),
        "auth-file" => Some(CredentialSurface::AuthFile { path: path() }),
        "keychain-item" => Some(CredentialSurface::KeychainItem {
            service: value
                .get("service")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            account: value
                .get("account")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        _ => None,
    }
}

fn surface_to_json(surface: &CredentialSurface) -> Value {
    match surface {
        CredentialSurface::ConfigDir { path } => json!({ "kind": "config-dir", "path": path }),
        CredentialSurface::AuthFile { path } => json!({ "kind": "auth-file", "path": path }),
        CredentialSurface::KeychainItem { service, account } => {
            json!({ "kind": "keychain-item", "service": service, "account": account })
        }
    }
}

/// A store key vector is `{ "surfaces": [...] }` — the TS `StoreKey` shape, so
/// the same JSON round-trips as input and as output.
fn store_from_json(value: &Value) -> Option<StoreKey> {
    let surfaces = value.get("surfaces").and_then(Value::as_array)?;
    let surfaces = surfaces
        .iter()
        .map(surface_from_json)
        .collect::<Option<Vec<_>>>()?;
    Some(create_store_key(&surfaces))
}

fn store_to_json(key: &StoreKey) -> Value {
    json!({ "surfaces": key.surfaces().iter().map(surface_to_json).collect::<Vec<_>>() })
}

// --- PtyBinding <-> JSON ---------------------------------------------------

fn binding_input_from_json(value: &Value) -> Option<PtyBindingInput> {
    Some(PtyBindingInput {
        runtime_id: value
            .get("runtimeId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pty_incarnation_id: value
            .get("ptyIncarnationId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        route: route_from_json(value.get("route")?)?,
        store: store_from_json(value.get("store")?)?,
    })
}

/// Bindings cross the seam in their PERSISTED form, which is the only form the
/// TS side can hand back without leaking the frozen object's identity.
fn binding_to_json(binding: &PtyBinding) -> Value {
    let serialized = serialize_pty_binding(binding);
    json!({
        "runtimeId": serialized.runtime_id,
        "ptyIncarnationId": serialized.pty_incarnation_id,
        "routeKey": serialized.route_key,
        "storeKey": serialized.store_key,
    })
}

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "formatRouteKey" => match input.get("route").and_then(route_from_json) {
            Some(route) => Value::String(format_route_key(&route)),
            None => error("formatRouteKey: unreadable route".to_string()),
        },
        // A non-string `value` is the TS `typeof value !== 'string'` rejection.
        "parseRouteKey" => match input.get("value").and_then(Value::as_str) {
            Some(value) => parse_route_key(value)
                .as_ref()
                .map_or(Value::Null, route_to_json),
            None => Value::Null,
        },
        "routeKeysEqual" => {
            match (
                input.get("a").and_then(route_from_json),
                input.get("b").and_then(route_from_json),
            ) {
                (Some(a), Some(b)) => json!(route_keys_equal(&a, &b)),
                _ => error("routeKeysEqual: unreadable route".to_string()),
            }
        }
        "formatRouteAccountScope" => match input.get("route").and_then(route_from_json) {
            Some(route) => Value::String(format_route_account_scope(&route)),
            None => error("formatRouteAccountScope: unreadable route".to_string()),
        },
        "createStoreKey" => match store_from_json(input) {
            Some(key) => store_to_json(&key),
            None => error("createStoreKey: unreadable surfaces".to_string()),
        },
        "formatStoreKey" => match store_from_json(input) {
            Some(key) => Value::String(format_store_key(&key)),
            None => error("formatStoreKey: unreadable surfaces".to_string()),
        },
        "parseStoreKey" => match input.get("value").and_then(Value::as_str) {
            Some(value) => parse_store_key(value)
                .as_ref()
                .map_or(Value::Null, store_to_json),
            None => Value::Null,
        },
        "storeKeysEqual" | "storeKeysOverlap" => {
            match (
                input.get("a").and_then(store_from_json),
                input.get("b").and_then(store_from_json),
            ) {
                (Some(a), Some(b)) => {
                    if function == "storeKeysEqual" {
                        json!(store_keys_equal(&a, &b))
                    } else {
                        json!(store_keys_overlap(&a, &b))
                    }
                }
                _ => error(format!("{function}: unreadable store")),
            }
        }
        "unionStoreKeys" => {
            let keys = input
                .get("keys")
                .and_then(Value::as_array)
                .map(|keys| keys.iter().map(store_from_json).collect::<Option<Vec<_>>>());
            match keys {
                Some(Some(keys)) => store_to_json(&union_store_keys(&keys)),
                _ => error("unionStoreKeys: unreadable store".to_string()),
            }
        }
        "commitPtyBinding" => match binding_input_from_json(input) {
            Some(binding) => commit_pty_binding(binding)
                .as_ref()
                .map_or(Value::Null, binding_to_json),
            None => error("commitPtyBinding: unreadable binding input".to_string()),
        },
        "ptyBindingsEqual" => {
            let pair = input
                .get("a")
                .and_then(binding_input_from_json)
                .and_then(commit_pty_binding)
                .zip(
                    input
                        .get("b")
                        .and_then(binding_input_from_json)
                        .and_then(commit_pty_binding),
                );
            match pair {
                Some((a, b)) => json!(pty_bindings_equal(&a, &b)),
                None => error("ptyBindingsEqual: a vector binding did not commit".to_string()),
            }
        }
        // `runtimeId`, `routeKey` and `storeKey` are `Some` only when the persisted
        // value really is a string — that is the TS `typeof !== 'string'` rejection,
        // and it is why an ABSENT store key rejects where an EMPTY one is the empty
        // store. `ptyIncarnationId` is NOT one of those: the TS reads it through
        // `String(raw.ptyIncarnationId ?? '')`, so an off-schema JSON number commits
        // a binding rather than rejecting one. Marshalled here, not modelled in the
        // core, because it is a property of the persisted JSON and not of the key.
        "deserializePtyBinding" => {
            let field = |name: &str| {
                input
                    .get("value")
                    .and_then(|value| value.get(name))
                    .and_then(Value::as_str)
            };
            let incarnation = input
                .get("value")
                .and_then(|value| value.get("ptyIncarnationId"))
                .map_or_else(String::new, js_string);
            deserialize_pty_binding(
                field("runtimeId"),
                Some(&incarnation),
                field("routeKey"),
                field("storeKey"),
            )
            .as_ref()
            .map_or(Value::Null, binding_to_json)
        }
        "bindingsBlockingStore" => {
            let store = match input.get("store").and_then(store_from_json) {
                Some(store) => store,
                None => return error("bindingsBlockingStore: unreadable store".to_string()),
            };
            let rows = input.get("bindings").and_then(Value::as_array);
            let Some(rows) = rows else {
                return error("bindingsBlockingStore: bindings must be an array".to_string());
            };
            let mut bindings: Vec<PtyBinding> = Vec::new();
            // Liveness is the runtime's answer about ONE PROCESS, so the oracle is
            // keyed by the binding itself — `ptr::eq` against the slice the core is
            // iterating, which is the TS `Map` keyed on object identity.
            //
            // NOT keyed by (runtimeId, incarnation): two rows may carry the same
            // pair and different liveness, and a set of live pairs is a union, so it
            // can only ever report MORE panes live than the caller said. That names
            // a drain as blocked by a pane that already ended, and a rotation stalls.
            let mut live: Vec<bool> = Vec::new();
            for row in rows {
                let Some(binding) = binding_input_from_json(row).and_then(commit_pty_binding)
                else {
                    return error(
                        "bindingsBlockingStore: a vector binding did not commit".to_string(),
                    );
                };
                live.push(row.get("live").and_then(Value::as_bool).unwrap_or(false));
                bindings.push(binding);
            }
            let blocking = bindings_blocking_store(&bindings, &store, |binding| {
                bindings
                    .iter()
                    .zip(&live)
                    .any(|(candidate, is_live)| *is_live && std::ptr::eq(candidate, binding))
            });
            Value::Array(blocking.into_iter().map(binding_to_json).collect())
        }
        other => error(format!("unknown function {other}")),
    }
}
