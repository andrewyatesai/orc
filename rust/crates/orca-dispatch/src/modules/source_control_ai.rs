//! Parity dispatch for `orca_git::source_control_ai` vs
//! `src/shared/source-control-ai.ts`.
//!
//! Every export of the twin is routed. These settings are PERSISTED PER REPO
//! and decide which model runs a commit-message / PR / branch-name generation,
//! so a wrong answer here is a silently wrong model, not a visible failure.
//!
//! TWO ENCODING RULES, both forced by `JSON.stringify` and by the parity
//! comparator (which treats a missing key as `undefined` but never equates
//! `undefined` with `null`):
//!
//! * An absent optional is OMITTED, never emitted as `null`. A tri-state field
//!   (`Option<Option<T>>`) emits `null` only for an explicit inherit sentinel.
//! * A function whose TS answer can be `undefined` (`readSourceControlAiModel
//!   ChoiceForHost`, `clearSourceControlAiModelChoiceForHost`,
//!   `normalizeRepoSourceControlAiOverrides`) answers `Value::Null` for that
//!   case. `undefined` has no JSON image, so the vector corpus cannot carry
//!   those inputs at all — they are covered by the crate's test port instead.

use orca_git::source_control_ai::{
    clear_source_control_ai_model_choice_for_host, get_default_source_control_ai_settings,
    has_configured_source_control_ai_instructions,
    merge_legacy_commit_message_ai_into_source_control_ai,
    normalize_repo_source_control_ai_overrides, normalize_source_control_ai_settings,
    project_source_control_ai_to_legacy_commit_message_ai,
    read_source_control_ai_model_choice_for_host, resolve_source_control_action_recipe,
    resolve_source_control_ai_enabled, resolve_source_control_ai_for_operation,
    resolve_source_control_ai_instructions, resolve_source_control_ai_pr_creation_defaults,
    select_source_control_ai_model_choice_for_host, source_control_ai_settings_from_legacy,
    CommitMessageAiModelCapability, CommitMessageAiSettings, CustomAgentProfile,
    DefaultTuiAgentPreference, GlobalSettingsSlice, MergeLegacyOptions, RepoPrCreationDefaults,
    RepoSourceControlActionOverride, RepoSourceControlAiOverrides, ResolveSourceControlAiInput,
    ResolveSourceControlAiResult, ResolvedPrCreationDefaults,
    ResolvedSourceControlAiGenerationParams, ResolvedSourceControlAiOperation,
    SourceControlActionId, SourceControlActionRecipe, SourceControlAiActionDefaults,
    SourceControlAiModelChoice, SourceControlAiOperation, SourceControlAiPrCreationDefaults,
    SourceControlAiSettings,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "normalizeRepoSourceControlAiOverrides" => {
            match normalize_repo_source_control_ai_overrides(input) {
                Some(overrides) => overrides_to_json(&overrides),
                // Non-record input, or a record with nothing recognisable → TS
                // `undefined`; vectors only seed inputs with a defined answer.
                None => Value::Null,
            }
        }
        "getDefaultSourceControlAiSettings" => {
            settings_to_json(&get_default_source_control_ai_settings())
        }
        "sourceControlAiSettingsFromLegacy" => {
            let legacy = decode_optional_legacy(Some(input));
            settings_to_json(&source_control_ai_settings_from_legacy(legacy.as_ref()))
        }
        "normalizeSourceControlAiSettings" => {
            let value = decode_optional_settings(field(input, "value"));
            let legacy = decode_optional_legacy(field(input, "legacy"));
            settings_to_json(&normalize_source_control_ai_settings(
                value.as_ref(),
                legacy.as_ref(),
            ))
        }
        "mergeLegacyCommitMessageAiIntoSourceControlAi" => {
            let source = decode_optional_settings(field(input, "sourceControlAi"));
            let legacy = decode_optional_legacy(field(input, "legacy"));
            let options = MergeLegacyOptions {
                pull_request_instructions_from_legacy: field(input, "options")
                    .and_then(|options| options.get("pullRequestInstructionsFromLegacy"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            };
            settings_to_json(&merge_legacy_commit_message_ai_into_source_control_ai(
                source.as_ref(),
                legacy.as_ref(),
                &options,
            ))
        }
        "projectSourceControlAiToLegacyCommitMessageAi" => {
            let source = decode_settings(field(input, "sourceControlAi").unwrap_or(&Value::Null));
            let previous = decode_optional_legacy(field(input, "previousLegacy"));
            legacy_to_json(&project_source_control_ai_to_legacy_commit_message_ai(
                &source,
                previous.as_ref(),
            ))
        }
        "readSourceControlAiModelChoiceForHost" => {
            let choice = decode_optional_model_choice(field(input, "choice"));
            match read_source_control_ai_model_choice_for_host(
                choice.as_ref(),
                text(input, "hostKey"),
                text(input, "agentId"),
            ) {
                Some(model) => Value::String(model),
                None => Value::Null,
            }
        }
        "selectSourceControlAiModelChoiceForHost" => {
            let choice = decode_optional_model_choice(field(input, "choice"));
            choice_to_json(&select_source_control_ai_model_choice_for_host(
                choice.as_ref(),
                text(input, "hostKey"),
                text(input, "agentId"),
                text(input, "modelId"),
            ))
        }
        "clearSourceControlAiModelChoiceForHost" => {
            let choice = decode_optional_model_choice(field(input, "choice"));
            match clear_source_control_ai_model_choice_for_host(
                choice.as_ref(),
                text(input, "hostKey"),
                text(input, "agentId"),
            ) {
                Some(choice) => choice_to_json(&choice),
                None => Value::Null,
            }
        }
        "resolveSourceControlAiInstructions" => match operation_arg(input) {
            Ok(operation) => Value::String(resolve_source_control_ai_instructions(
                &decode_settings_slice(field(input, "settings")),
                repo_source_control_ai(input),
                operation,
            )),
            Err(error) => error,
        },
        "hasConfiguredSourceControlAiInstructions" => match operation_arg(input) {
            Ok(operation) => Value::Bool(has_configured_source_control_ai_instructions(
                &decode_settings_slice(field(input, "settings")),
                repo_source_control_ai(input),
                operation,
            )),
            Err(error) => error,
        },
        "resolveSourceControlAiPrCreationDefaults" => {
            let product = decode_pr_creation_defaults(field(input, "prCreationProductDefaults"));
            resolved_pr_defaults_to_json(&resolve_source_control_ai_pr_creation_defaults(
                &decode_settings_slice(field(input, "settings")),
                repo_source_control_ai(input),
                product.as_ref(),
            ))
        }
        "resolveSourceControlAiEnabled" => {
            // `settings` is nullable in the twin, and a null one still resolves.
            let settings = field(input, "settings").map(decode_settings_slice_value);
            Value::Bool(resolve_source_control_ai_enabled(
                settings.as_ref(),
                repo_source_control_ai(input),
            ))
        }
        "resolveSourceControlActionRecipe" => {
            let Some(action_id) = field(input, "actionId")
                .and_then(Value::as_str)
                .and_then(SourceControlActionId::parse)
            else {
                return unknown_member("actionId", field(input, "actionId"));
            };
            let settings = field(input, "settings").map(decode_settings_slice_value);
            recipe_to_json(&resolve_source_control_action_recipe(
                settings.as_ref(),
                repo_source_control_ai(input),
                action_id,
            ))
        }
        "resolveSourceControlAiForOperation" => {
            let operation = match operation_arg(input) {
                Ok(operation) => operation,
                Err(error) => return error,
            };
            let settings = decode_settings_slice(field(input, "settings"));
            let product = decode_pr_creation_defaults(field(input, "prCreationProductDefaults"));
            let resolve_input = ResolveSourceControlAiInput {
                settings: &settings,
                repo_source_control_ai: repo_source_control_ai(input),
                operation,
                discovery_host_key: field(input, "discoveryHostKey").and_then(Value::as_str),
                pr_creation_product_defaults: product.as_ref(),
            };
            match resolve_source_control_ai_for_operation(&resolve_input) {
                ResolveSourceControlAiResult::Ok(value) => {
                    json!({ "ok": true, "value": resolved_operation_to_json(&value) })
                }
                ResolveSourceControlAiResult::Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

// ---------------------------------------------------------------------------
// Argument readers.
// ---------------------------------------------------------------------------

/// A present, non-null member. JSON `null` is the twin's `null`/`undefined` for
/// every optional argument here, so both collapse to "absent".
fn field<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    input.get(key).filter(|value| !value.is_null())
}

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `repo?.sourceControlAi`.
fn repo_source_control_ai(input: &Value) -> Option<&Value> {
    field(input, "repo").and_then(|repo| field(repo, "sourceControlAi"))
}

fn operation_arg(input: &Value) -> Result<SourceControlAiOperation, Value> {
    field(input, "operation")
        .and_then(Value::as_str)
        .and_then(SourceControlAiOperation::parse)
        .ok_or_else(|| unknown_member("operation", field(input, "operation")))
}

/// An operation/action id outside the closed union is a caller bug, not a value
/// to guess at: the twin would index a `Record` with it and read `undefined`.
fn unknown_member(key: &str, value: Option<&Value>) -> Value {
    json!({
        "__parity_error__": format!(
            "source-control-ai: `{key}` is not one of the known ids (got {})",
            value.map(ToString::to_string).unwrap_or_else(|| "absent".to_string())
        )
    })
}

// ---------------------------------------------------------------------------
// Decoding. Nothing here validates a value the twin's own normalizers reject —
// `actions.agentId` keeps whatever string it holds so
// `normalizeSourceControlAiSettings` is the one place the catalog is enforced.
// ---------------------------------------------------------------------------

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Some(obj) = value.and_then(Value::as_object) {
        for (key, item) in obj {
            if let Some(text) = item.as_str() {
                map.insert(key.clone(), text.to_string());
            }
        }
    }
    map
}

fn host_string_map(value: Option<&Value>) -> Option<BTreeMap<String, BTreeMap<String, String>>> {
    let obj = value?.as_object()?;
    Some(
        obj.iter()
            .map(|(host, models)| (host.clone(), string_map(Some(models))))
            .collect(),
    )
}

fn decode_model(value: &Value) -> CommitMessageAiModelCapability {
    CommitMessageAiModelCapability {
        id: value.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
        label: value.get("label").and_then(Value::as_str).unwrap_or_default().to_string(),
        thinking_levels: value.get("thinkingLevels").and_then(Value::as_array).map(|levels| {
            levels
                .iter()
                .map(|level| orca_agents::ThinkingLevel {
                    id: level.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    label: level
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        }),
        default_thinking_level: value
            .get("defaultThinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn decode_models_by_agent(
    value: Option<&Value>,
) -> Option<BTreeMap<String, Vec<CommitMessageAiModelCapability>>> {
    let obj = value?.as_object()?;
    Some(
        obj.iter()
            .map(|(agent, models)| {
                let models = models
                    .as_array()
                    .map(|models| models.iter().map(decode_model).collect())
                    .unwrap_or_default();
                (agent.clone(), models)
            })
            .collect(),
    )
}

fn decode_models_by_agent_by_host(
    value: Option<&Value>,
) -> Option<BTreeMap<String, BTreeMap<String, Vec<CommitMessageAiModelCapability>>>> {
    let obj = value?.as_object()?;
    Some(
        obj.iter()
            .map(|(host, by_agent)| {
                (host.clone(), decode_models_by_agent(Some(by_agent)).unwrap_or_default())
            })
            .collect(),
    )
}

/// `T | null | undefined` off a JSON member: absent → `None`, `null` →
/// `Some(None)`, a string → `Some(Some(_))`.
fn decode_tri_string(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    }
}

fn decode_model_choice(value: &Value) -> SourceControlAiModelChoice {
    SourceControlAiModelChoice {
        selected_model_by_agent: value
            .get("selectedModelByAgent")
            .filter(|item| item.is_object())
            .map(|item| string_map(Some(item))),
        selected_model_by_agent_by_host: host_string_map(value.get("selectedModelByAgentByHost")),
        selected_thinking_by_model: value
            .get("selectedThinkingByModel")
            .filter(|item| item.is_object())
            .map(|item| string_map(Some(item))),
    }
}

fn decode_optional_model_choice(value: Option<&Value>) -> Option<SourceControlAiModelChoice> {
    Some(decode_model_choice(value?))
}

fn decode_model_choices_by_operation(
    value: Option<&Value>,
) -> Option<BTreeMap<SourceControlAiOperation, SourceControlAiModelChoice>> {
    let obj = value?.as_object()?;
    let mut map = BTreeMap::new();
    for (key, item) in obj {
        if let Some(operation) = SourceControlAiOperation::parse(key) {
            map.insert(operation, decode_model_choice(item));
        }
    }
    Some(map)
}

fn decode_action_recipe(value: &Value) -> SourceControlActionRecipe {
    SourceControlActionRecipe {
        agent_id: decode_tri_string(value.get("agentId")),
        command_input_template: value
            .get("commandInputTemplate")
            .and_then(Value::as_str)
            .map(str::to_string),
        agent_args: value.get("agentArgs").and_then(Value::as_str).map(str::to_string),
    }
}

fn decode_action_defaults(value: Option<&Value>) -> Option<SourceControlAiActionDefaults> {
    let obj = value?.as_object()?;
    let mut map = SourceControlAiActionDefaults::new();
    for (key, item) in obj {
        if let Some(action_id) = SourceControlActionId::parse(key) {
            map.insert(action_id, decode_action_recipe(item));
        }
    }
    Some(map)
}

fn decode_pr_creation_defaults(
    value: Option<&Value>,
) -> Option<SourceControlAiPrCreationDefaults> {
    let obj = value?.as_object()?;
    Some(SourceControlAiPrCreationDefaults {
        draft: obj.get("draft").and_then(Value::as_bool),
        use_template: obj.get("useTemplate").and_then(Value::as_bool),
        generate_details_on_open: obj.get("generateDetailsOnOpen").and_then(Value::as_bool),
        open_after_create: obj.get("openAfterCreate").and_then(Value::as_bool),
    })
}

fn decode_instructions(value: Option<&Value>) -> BTreeMap<SourceControlAiOperation, String> {
    let mut map = BTreeMap::new();
    if let Some(obj) = value.and_then(Value::as_object) {
        for (key, item) in obj {
            if let (Some(operation), Some(text)) =
                (SourceControlAiOperation::parse(key), item.as_str())
            {
                map.insert(operation, text.to_string());
            }
        }
    }
    map
}

fn decode_settings(value: &Value) -> SourceControlAiSettings {
    SourceControlAiSettings {
        enabled: value.get("enabled").and_then(Value::as_bool),
        actions: decode_action_defaults(value.get("actions")),
        agent_id: decode_tri_string(value.get("agentId")),
        selected_model_by_agent: string_map(value.get("selectedModelByAgent")),
        selected_model_by_agent_by_host: host_string_map(value.get("selectedModelByAgentByHost")),
        discovered_models_by_agent: decode_models_by_agent(value.get("discoveredModelsByAgent")),
        discovered_models_by_agent_by_host: decode_models_by_agent_by_host(
            value.get("discoveredModelsByAgentByHost"),
        ),
        selected_thinking_by_model: string_map(value.get("selectedThinkingByModel")),
        custom_agent_command: value
            .get("customAgentCommand")
            .and_then(Value::as_str)
            .map(str::to_string),
        instructions_by_operation: decode_instructions(value.get("instructionsByOperation")),
        model_overrides_by_operation: decode_model_choices_by_operation(
            value.get("modelOverridesByOperation"),
        ),
        pr_creation_defaults: decode_pr_creation_defaults(value.get("prCreationDefaults")),
        launch_action_defaults: decode_action_defaults(value.get("launchActionDefaults")),
    }
}

fn decode_optional_settings(value: Option<&Value>) -> Option<SourceControlAiSettings> {
    Some(decode_settings(value?))
}

fn decode_legacy(value: &Value) -> CommitMessageAiSettings {
    CommitMessageAiSettings {
        enabled: value.get("enabled").and_then(Value::as_bool),
        agent_id: decode_tri_string(value.get("agentId")),
        selected_model_by_agent: string_map(value.get("selectedModelByAgent")),
        selected_model_by_agent_by_host: host_string_map(value.get("selectedModelByAgentByHost")),
        discovered_models_by_agent: decode_models_by_agent(value.get("discoveredModelsByAgent")),
        discovered_models_by_agent_by_host: decode_models_by_agent_by_host(
            value.get("discoveredModelsByAgentByHost"),
        ),
        selected_thinking_by_model: string_map(value.get("selectedThinkingByModel")),
        custom_prompt: value.get("customPrompt").and_then(Value::as_str).map(str::to_string),
        custom_agent_command: value
            .get("customAgentCommand")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn decode_optional_legacy(value: Option<&Value>) -> Option<CommitMessageAiSettings> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    Some(decode_legacy(value))
}

/// The `defaultTuiAgent` union: absent, `null`, a built-in id (or `'blank'`),
/// or `{ kind: 'custom', id }`.
fn decode_default_tui_agent(value: Option<&Value>) -> DefaultTuiAgentPreference {
    match value {
        None => DefaultTuiAgentPreference::Undefined,
        Some(Value::Null) => DefaultTuiAgentPreference::Null,
        Some(Value::String(agent)) => DefaultTuiAgentPreference::Builtin(agent.clone()),
        Some(other) => DefaultTuiAgentPreference::Custom {
            id: other.get("id").and_then(Value::as_str).map(str::to_string),
        },
    }
}

fn decode_settings_slice_value(value: &Value) -> GlobalSettingsSlice {
    GlobalSettingsSlice {
        default_tui_agent: decode_default_tui_agent(value.get("defaultTuiAgent")),
        custom_agents: value
            .get("customAgents")
            .and_then(Value::as_array)
            .map(|profiles| {
                profiles
                    .iter()
                    .map(|profile| CustomAgentProfile {
                        id: profile.get("id").and_then(Value::as_str).map(str::to_string),
                        base_agent: profile
                            .get("baseAgent")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        agent_cmd_overrides: string_map(value.get("agentCmdOverrides")),
        commit_message_ai: decode_optional_legacy(value.get("commitMessageAi")),
        source_control_ai: decode_optional_settings(
            value.get("sourceControlAi").filter(|item| !item.is_null()),
        ),
        disabled_tui_agents: value
            .get("disabledTuiAgents")
            .and_then(Value::as_array)
            .map(|agents| agents.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
    }
}

fn decode_settings_slice(value: Option<&Value>) -> GlobalSettingsSlice {
    value.map(decode_settings_slice_value).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Encoding. Absent optionals are omitted (what `JSON.stringify` does with
// `undefined`); an explicit inherit sentinel is the only source of a `null`.
// ---------------------------------------------------------------------------

fn insert_opt(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_string(), value);
    }
}

/// A `T | null | undefined` slot: omitted when absent, `null` when explicit.
fn tri_string_to_json(value: &Option<Option<String>>) -> Option<Value> {
    value.as_ref().map(|inner| match inner {
        Some(text) => Value::String(text.clone()),
        None => Value::Null,
    })
}

fn string_map_to_json(values: &BTreeMap<String, String>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

fn host_map_to_json(values: &BTreeMap<String, BTreeMap<String, String>>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(host, models)| (host.clone(), string_map_to_json(models)))
            .collect(),
    )
}

fn model_to_json(model: &CommitMessageAiModelCapability) -> Value {
    let mut map = Map::new();
    map.insert("id".to_string(), Value::String(model.id.clone()));
    map.insert("label".to_string(), Value::String(model.label.clone()));
    if let Some(levels) = &model.thinking_levels {
        map.insert(
            "thinkingLevels".to_string(),
            Value::Array(
                levels
                    .iter()
                    .map(|level| json!({ "id": level.id, "label": level.label }))
                    .collect(),
            ),
        );
    }
    if let Some(default) = &model.default_thinking_level {
        map.insert("defaultThinkingLevel".to_string(), Value::String(default.clone()));
    }
    Value::Object(map)
}

fn models_by_agent_to_json(values: &BTreeMap<String, Vec<CommitMessageAiModelCapability>>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(agent, models)| {
                (agent.clone(), Value::Array(models.iter().map(model_to_json).collect()))
            })
            .collect(),
    )
}

fn models_by_agent_by_host_to_json(
    values: &BTreeMap<String, BTreeMap<String, Vec<CommitMessageAiModelCapability>>>,
) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(host, by_agent)| (host.clone(), models_by_agent_to_json(by_agent)))
            .collect(),
    )
}

fn choice_to_json(choice: &SourceControlAiModelChoice) -> Value {
    let mut map = Map::new();
    insert_opt(
        &mut map,
        "selectedModelByAgent",
        choice.selected_model_by_agent.as_ref().map(string_map_to_json),
    );
    insert_opt(
        &mut map,
        "selectedModelByAgentByHost",
        choice.selected_model_by_agent_by_host.as_ref().map(host_map_to_json),
    );
    insert_opt(
        &mut map,
        "selectedThinkingByModel",
        choice.selected_thinking_by_model.as_ref().map(string_map_to_json),
    );
    Value::Object(map)
}

fn choices_by_operation_to_json(
    values: &BTreeMap<SourceControlAiOperation, SourceControlAiModelChoice>,
) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(operation, choice)| (operation.as_str().to_string(), choice_to_json(choice)))
            .collect(),
    )
}

fn recipe_to_json(recipe: &SourceControlActionRecipe) -> Value {
    let mut map = Map::new();
    insert_opt(&mut map, "agentId", tri_string_to_json(&recipe.agent_id));
    insert_opt(
        &mut map,
        "commandInputTemplate",
        recipe.command_input_template.clone().map(Value::String),
    );
    insert_opt(&mut map, "agentArgs", recipe.agent_args.clone().map(Value::String));
    Value::Object(map)
}

fn action_defaults_to_json(defaults: &SourceControlAiActionDefaults) -> Value {
    Value::Object(
        defaults
            .iter()
            .map(|(action_id, recipe)| (action_id.as_str().to_string(), recipe_to_json(recipe)))
            .collect(),
    )
}

fn pr_defaults_to_json(defaults: &SourceControlAiPrCreationDefaults) -> Value {
    let mut map = Map::new();
    insert_opt(&mut map, "draft", defaults.draft.map(Value::Bool));
    insert_opt(&mut map, "useTemplate", defaults.use_template.map(Value::Bool));
    insert_opt(
        &mut map,
        "generateDetailsOnOpen",
        defaults.generate_details_on_open.map(Value::Bool),
    );
    insert_opt(&mut map, "openAfterCreate", defaults.open_after_create.map(Value::Bool));
    Value::Object(map)
}

fn resolved_pr_defaults_to_json(defaults: &ResolvedPrCreationDefaults) -> Value {
    json!({
        "draft": defaults.draft,
        "useTemplate": defaults.use_template,
        "generateDetailsOnOpen": defaults.generate_details_on_open,
        "openAfterCreate": defaults.open_after_create,
    })
}

fn settings_to_json(settings: &SourceControlAiSettings) -> Value {
    let mut map = Map::new();
    insert_opt(&mut map, "enabled", settings.enabled.map(Value::Bool));
    insert_opt(
        &mut map,
        "actions",
        settings.actions.as_ref().map(action_defaults_to_json),
    );
    insert_opt(&mut map, "agentId", tri_string_to_json(&settings.agent_id));
    map.insert(
        "selectedModelByAgent".to_string(),
        string_map_to_json(&settings.selected_model_by_agent),
    );
    insert_opt(
        &mut map,
        "selectedModelByAgentByHost",
        settings.selected_model_by_agent_by_host.as_ref().map(host_map_to_json),
    );
    insert_opt(
        &mut map,
        "discoveredModelsByAgent",
        settings.discovered_models_by_agent.as_ref().map(models_by_agent_to_json),
    );
    insert_opt(
        &mut map,
        "discoveredModelsByAgentByHost",
        settings
            .discovered_models_by_agent_by_host
            .as_ref()
            .map(models_by_agent_by_host_to_json),
    );
    map.insert(
        "selectedThinkingByModel".to_string(),
        string_map_to_json(&settings.selected_thinking_by_model),
    );
    insert_opt(
        &mut map,
        "customAgentCommand",
        settings.custom_agent_command.clone().map(Value::String),
    );
    map.insert(
        "instructionsByOperation".to_string(),
        Value::Object(
            settings
                .instructions_by_operation
                .iter()
                .map(|(operation, text)| {
                    (operation.as_str().to_string(), Value::String(text.clone()))
                })
                .collect(),
        ),
    );
    insert_opt(
        &mut map,
        "modelOverridesByOperation",
        settings.model_overrides_by_operation.as_ref().map(choices_by_operation_to_json),
    );
    insert_opt(
        &mut map,
        "prCreationDefaults",
        settings.pr_creation_defaults.as_ref().map(pr_defaults_to_json),
    );
    insert_opt(
        &mut map,
        "launchActionDefaults",
        settings.launch_action_defaults.as_ref().map(action_defaults_to_json),
    );
    Value::Object(map)
}

fn legacy_to_json(legacy: &CommitMessageAiSettings) -> Value {
    let mut map = Map::new();
    insert_opt(&mut map, "enabled", legacy.enabled.map(Value::Bool));
    insert_opt(&mut map, "agentId", tri_string_to_json(&legacy.agent_id));
    map.insert(
        "selectedModelByAgent".to_string(),
        string_map_to_json(&legacy.selected_model_by_agent),
    );
    insert_opt(
        &mut map,
        "selectedModelByAgentByHost",
        legacy.selected_model_by_agent_by_host.as_ref().map(host_map_to_json),
    );
    insert_opt(
        &mut map,
        "discoveredModelsByAgent",
        legacy.discovered_models_by_agent.as_ref().map(models_by_agent_to_json),
    );
    insert_opt(
        &mut map,
        "discoveredModelsByAgentByHost",
        legacy
            .discovered_models_by_agent_by_host
            .as_ref()
            .map(models_by_agent_by_host_to_json),
    );
    map.insert(
        "selectedThinkingByModel".to_string(),
        string_map_to_json(&legacy.selected_thinking_by_model),
    );
    insert_opt(&mut map, "customPrompt", legacy.custom_prompt.clone().map(Value::String));
    insert_opt(
        &mut map,
        "customAgentCommand",
        legacy.custom_agent_command.clone().map(Value::String),
    );
    Value::Object(map)
}

fn resolved_params_to_json(params: &ResolvedSourceControlAiGenerationParams) -> Value {
    let mut map = Map::new();
    map.insert("agentId".to_string(), Value::String(params.agent_id.clone()));
    map.insert("model".to_string(), Value::String(params.model.clone()));
    insert_opt(&mut map, "thinkingLevel", params.thinking_level.clone().map(Value::String));
    insert_opt(&mut map, "customPrompt", params.custom_prompt.clone().map(Value::String));
    insert_opt(
        &mut map,
        "commandInputTemplate",
        params.command_input_template.clone().map(Value::String),
    );
    insert_opt(&mut map, "agentArgs", params.agent_args.clone().map(Value::String));
    insert_opt(
        &mut map,
        "customAgentCommand",
        params.custom_agent_command.clone().map(Value::String),
    );
    insert_opt(
        &mut map,
        "agentCommandOverride",
        params.agent_command_override.clone().map(Value::String),
    );
    Value::Object(map)
}

fn resolved_operation_to_json(value: &ResolvedSourceControlAiOperation) -> Value {
    json!({
        "enabled": value.enabled,
        "params": resolved_params_to_json(&value.params),
        "prCreationDefaults": resolved_pr_defaults_to_json(&value.pr_creation_defaults),
    })
}

fn action_override_to_json(override_: &RepoSourceControlActionOverride) -> Value {
    let mut map = Map::new();
    insert_opt(&mut map, "agentId", tri_string_to_json(&override_.agent_id));
    insert_opt(
        &mut map,
        "commandInputTemplate",
        tri_string_to_json(&override_.command_input_template),
    );
    insert_opt(&mut map, "agentArgs", tri_string_to_json(&override_.agent_args));
    Value::Object(map)
}

fn repo_pr_defaults_to_json(pr: &RepoPrCreationDefaults) -> Value {
    let mut map = Map::new();
    insert_tri_bool(&mut map, "draft", pr.draft);
    insert_tri_bool(&mut map, "useTemplate", pr.use_template);
    insert_tri_bool(&mut map, "generateDetailsOnOpen", pr.generate_details_on_open);
    insert_tri_bool(&mut map, "openAfterCreate", pr.open_after_create);
    Value::Object(map)
}

fn insert_tri_bool(map: &mut Map<String, Value>, key: &str, field: Option<Option<bool>>) {
    if let Some(value) = field {
        map.insert(
            key.to_string(),
            match value {
                Some(flag) => Value::Bool(flag),
                None => Value::Null,
            },
        );
    }
}

fn overrides_to_json(overrides: &RepoSourceControlAiOverrides) -> Value {
    let mut map = Map::new();
    insert_opt(&mut map, "enabled", overrides.enabled.map(Value::Bool));
    insert_opt(
        &mut map,
        "customAgentCommand",
        overrides.custom_agent_command.clone().map(Value::String),
    );
    insert_opt(
        &mut map,
        "modelOverridesByOperation",
        overrides.model_overrides_by_operation.as_ref().map(choices_by_operation_to_json),
    );
    if let Some(by_op) = &overrides.instructions_by_operation {
        map.insert(
            "instructionsByOperation".to_string(),
            Value::Object(
                by_op
                    .iter()
                    .map(|(operation, instruction)| {
                        (
                            operation.as_str().to_string(),
                            match instruction {
                                Some(text) => Value::String(text.clone()),
                                None => Value::Null,
                            },
                        )
                    })
                    .collect(),
            ),
        );
    }
    if let Some(by_action) = &overrides.action_overrides {
        map.insert(
            "actionOverrides".to_string(),
            Value::Object(
                by_action
                    .iter()
                    .map(|(action_id, override_)| {
                        (action_id.as_str().to_string(), action_override_to_json(override_))
                    })
                    .collect(),
            ),
        );
    }
    insert_opt(
        &mut map,
        "prCreationDefaults",
        overrides.pr_creation_defaults.as_ref().map(repo_pr_defaults_to_json),
    );
    Value::Object(map)
}
