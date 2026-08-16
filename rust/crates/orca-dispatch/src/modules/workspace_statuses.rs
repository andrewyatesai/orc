//! Parity dispatch for `orca_config::workspace_statuses` vs
//! `src/shared/workspace-statuses.ts`. Every pure export the twin still owns is
//! routed here (defaults, id minting, normalization, clamps, group keys).

use orca_config::workspace_statuses::{
    clamp_workspace_board_column_width, clamp_workspace_board_opacity,
    clone_default_workspace_statuses, get_default_workspace_status_id, get_workspace_status,
    get_workspace_status_from_group_key, get_workspace_status_group_key, is_workspace_status_id,
    make_workspace_status_id, normalize_persisted_workspace_statuses, normalize_workspace_statuses,
    WorkspaceStatusDefinition, WorkspaceStatusNormalizeOptions,
};
use serde_json::{json, Map, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        // No-arg in TS; the vector input is an empty object and is ignored.
        "cloneDefaultWorkspaceStatuses" => statuses_to_json(&clone_default_workspace_statuses()),
        // Single arg: the value to normalize is the input itself.
        "normalizeWorkspaceStatuses" => statuses_to_json(&normalize_workspace_statuses(input)),
        "normalizePersistedWorkspaceStatuses" => {
            let absent = Value::Null;
            let value = input.get("value").unwrap_or(&absent);
            let options = input.get("options");
            // TS compares each flag with `=== true`, so a truthy non-boolean is off.
            let flag = |key: &str| {
                options.and_then(|options| options.get(key)).and_then(Value::as_bool).unwrap_or(false)
            };
            statuses_to_json(&normalize_persisted_workspace_statuses(
                value,
                WorkspaceStatusNormalizeOptions {
                    migrate_default_workflow_statuses: flag("migrateDefaultWorkflowStatuses"),
                    repair_reordered_default_statuses: flag("repairReorderedDefaultStatuses"),
                    migrate_legacy_default_status_visuals: flag("migrateLegacyDefaultStatusVisuals"),
                },
            ))
        }
        "makeWorkspaceStatusId" => {
            let label = input.get("label").and_then(Value::as_str).unwrap_or_default();
            let existing = statuses_from_json(input.get("existingStatuses"));
            Value::String(make_workspace_status_id(label, &existing))
        }
        // Single arg: `unknown` in TS, so a non-number lands on the fallback.
        "clampWorkspaceBoardOpacity" => json!(clamp_workspace_board_opacity(input.as_f64())),
        "clampWorkspaceBoardColumnWidth" => {
            json!(clamp_workspace_board_column_width(input.as_f64()))
        }
        "isWorkspaceStatusId" => {
            let value = input.get("value").and_then(Value::as_str).unwrap_or_default();
            let statuses = statuses_from_json(input.get("statuses"));
            Value::Bool(is_workspace_status_id(value, &statuses))
        }
        // Single arg: the status list is the input itself.
        "getDefaultWorkspaceStatusId" => {
            let statuses = statuses_from_json(Some(input));
            Value::String(get_default_workspace_status_id(&statuses))
        }
        "getWorkspaceStatus" => {
            // TS takes `Pick<Worktree, 'workspaceStatus'>`; only that field is read.
            let workspace_status = input
                .get("worktree")
                .and_then(|worktree| worktree.get("workspaceStatus"))
                .and_then(Value::as_str);
            let statuses = statuses_from_json(input.get("statuses"));
            Value::String(get_workspace_status(workspace_status, &statuses))
        }
        // Single arg: the status string is the input itself.
        "getWorkspaceStatusGroupKey" => {
            Value::String(get_workspace_status_group_key(input.as_str().unwrap_or_default()))
        }
        "getWorkspaceStatusFromGroupKey" => {
            let group_key = input.get("groupKey").and_then(Value::as_str).unwrap_or_default();
            let statuses = statuses_from_json(input.get("statuses"));
            // TS returns `WorkspaceStatus | null`; None maps to JSON null.
            match get_workspace_status_from_group_key(group_key, &statuses) {
                Some(status) => Value::String(status),
                None => Value::Null,
            }
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// Match `JSON.stringify` of the TS `WorkspaceStatusDefinition[]`.
fn statuses_to_json(statuses: &[WorkspaceStatusDefinition]) -> Value {
    Value::Array(
        statuses
            .iter()
            .map(|status| {
                let mut object = Map::new();
                object.insert("id".to_string(), Value::String(status.id.clone()));
                object.insert("label".to_string(), Value::String(status.label.clone()));
                object.insert("color".to_string(), Value::String(status.color.clone()));
                object.insert("icon".to_string(), Value::String(status.icon.clone()));
                Value::Object(object)
            })
            .collect(),
    )
}

/// Rebuild the status list from the vector's JSON. Only `id` drives the pure
/// id/group-key/minting functions, so absent fields default to empty strings.
fn statuses_from_json(value: Option<&Value>) -> Vec<WorkspaceStatusDefinition> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let field = |key: &str| object.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
            Some(WorkspaceStatusDefinition {
                id: field("id"),
                label: field("label"),
                color: field("color"),
                icon: field("icon"),
            })
        })
        .collect()
}
