//! Source Control AI settings: defaults, legacy migration/merge, defensive
//! normalization, host-scoped model selection, per-action recipes, and
//! per-operation precedence — ported from `src/shared/source-control-ai.ts`
//! (+ `src/shared/source-control-ai-types.ts` and the recipe helpers of
//! `src/shared/source-control-ai-actions.ts`, which the twin composes inline).
//!
//! The defaults, migration-compatibility, and operation-resolution rules live
//! together so the commit-message / pull-request / branch-name precedence cannot
//! drift across the global, repo, local, and SSH paths. Untrusted persisted
//! blobs arrive as `serde_json::Value` and are normalized into typed structs;
//! the agent/model catalog comes from `orca_agents`. The JS proto-pollution
//! guards (`__proto__`/`constructor`/`prototype`) are not memory-safety issues
//! in Rust, but the *key filtering* they implies is observable and preserved.
//!
//! TWO MODELLING RULES, because the twin's types and its runtime disagree:
//!
//! * `Option<Option<T>>` is a JSON tri-state: `None` = the key is absent
//!   (TS `undefined`), `Some(None)` = an explicit `null`, `Some(Some(v))` = a
//!   value. The twin branches on all three (`item.agentArgs === null` is not
//!   `item.agentArgs === undefined`), so collapsing them is a wrong answer.
//! * TS `undefined` and an absent key are ONE value for a DECODED blob, because
//!   JSON has no `undefined`. They are two values once this module SYNTHESIZES a
//!   settings object from a legacy one: `normalizeSourceControlAiSettings`
//!   merges with object spread (`{...defaults, ...base}`), so a key present
//!   holding `undefined` SHADOWS the default instead of inheriting it, and
//!   `JSON.stringify` then drops the key. `SourceControlAiUndefinedKeys` carries
//!   that distinction for the three keys the twin resolves by spread alone —
//!   `enabled`, `agentId`, `customAgentCommand`.
//!
//! Every `.trim()` here is `trim_js`: JS trims U+FEFF and keeps U+0085, Rust's
//! `str::trim` does the opposite, and these strings are command templates and
//! agent ids read straight back out of persisted settings.

use orca_agents::tui_agent_config::is_tui_agent;
use orca_agents::{
    collapse_default_tui_agent_to_builtin, get_commit_message_agent_spec, get_commit_message_model,
    is_custom_agent_id, list_commit_message_agent_capabilities, resolve_commit_message_agent_choice,
    CollapsedDefaultTuiAgent, CommitMessageModel, CustomAgentProfileRef, DefaultTuiAgentPref,
    CUSTOM_AGENT_ID,
};
use orca_core::commit_message_host_key::LOCAL_COMMIT_MESSAGE_HOST_KEY;
use orca_core::js_string::trim_js;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// A model/thinking capability cached from a discovery probe. Same shape as a
/// catalog model, so resolution can unify across spec/discovered/derived models.
pub type CommitMessageAiModelCapability = CommitMessageModel;

/// Every Source Control action id (`SOURCE_CONTROL_ACTION_IDS`): the three text
/// actions that generate content, then the five launch actions. Declaration
/// order IS the canonical order, and `Ord` follows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceControlActionId {
    CommitMessage,
    PullRequest,
    BranchName,
    FixCommitFailure,
    FixPushFailure,
    FixChecks,
    ResolveConflicts,
    ResolveComments,
}

impl SourceControlActionId {
    pub const ALL: [SourceControlActionId; 8] = [
        SourceControlActionId::CommitMessage,
        SourceControlActionId::PullRequest,
        SourceControlActionId::BranchName,
        SourceControlActionId::FixCommitFailure,
        SourceControlActionId::FixPushFailure,
        SourceControlActionId::FixChecks,
        SourceControlActionId::ResolveConflicts,
        SourceControlActionId::ResolveComments,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SourceControlActionId::CommitMessage => "commitMessage",
            SourceControlActionId::PullRequest => "pullRequest",
            SourceControlActionId::BranchName => "branchName",
            SourceControlActionId::FixCommitFailure => "fixCommitFailure",
            SourceControlActionId::FixPushFailure => "fixPushFailure",
            SourceControlActionId::FixChecks => "fixChecks",
            SourceControlActionId::ResolveConflicts => "resolveConflicts",
            SourceControlActionId::ResolveComments => "resolveComments",
        }
    }

    pub fn parse(value: &str) -> Option<SourceControlActionId> {
        SourceControlActionId::ALL
            .into_iter()
            .find(|action| action.as_str() == value)
    }
}

/// The three Source Control AI generation operations, in canonical order.
/// `SourceControlAiOperation` IS `SourceControlTextActionId` in the twin, so the
/// two enums stay convertible rather than duplicated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceControlAiOperation {
    CommitMessage,
    PullRequest,
    BranchName,
}

impl SourceControlAiOperation {
    pub const ALL: [SourceControlAiOperation; 3] = [
        SourceControlAiOperation::CommitMessage,
        SourceControlAiOperation::PullRequest,
        SourceControlAiOperation::BranchName,
    ];

    pub fn as_str(self) -> &'static str {
        self.action_id().as_str()
    }

    pub fn parse(value: &str) -> Option<SourceControlAiOperation> {
        SourceControlAiOperation::ALL
            .into_iter()
            .find(|operation| operation.as_str() == value)
    }

    pub fn action_id(self) -> SourceControlActionId {
        match self {
            SourceControlAiOperation::CommitMessage => SourceControlActionId::CommitMessage,
            SourceControlAiOperation::PullRequest => SourceControlActionId::PullRequest,
            SourceControlAiOperation::BranchName => SourceControlActionId::BranchName,
        }
    }

    fn label(self) -> &'static str {
        match self {
            SourceControlAiOperation::CommitMessage => "commit messages",
            SourceControlAiOperation::PullRequest => "pull request details",
            SourceControlAiOperation::BranchName => "branch names",
        }
    }
}

/// Every action's default command template is the bare `{basePrompt}`
/// (`DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES`).
pub const DEFAULT_ACTION_COMMAND_TEMPLATE: &str = "{basePrompt}";

/// A global action recipe (`SourceControlActionRecipe`). `agent_id` is the
/// tri-state; the two strings are plain optionals (the global shape has no null
/// sentinel — only the repo override does).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceControlActionRecipe {
    pub agent_id: Option<Option<String>>,
    pub command_input_template: Option<String>,
    pub agent_args: Option<String>,
}

impl SourceControlActionRecipe {
    fn is_empty(&self) -> bool {
        self.agent_id.is_none()
            && self.command_input_template.is_none()
            && self.agent_args.is_none()
    }
}

/// `SourceControlAiActionDefaults`: a partial map from action id to recipe.
pub type SourceControlAiActionDefaults = BTreeMap<SourceControlActionId, SourceControlActionRecipe>;

/// Per-operation model/thinking override (`SourceControlAiModelChoice`). A field
/// is `None` when absent, matching the optional records in the TS shape.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceControlAiModelChoice {
    pub selected_model_by_agent: Option<BTreeMap<String, String>>,
    pub selected_model_by_agent_by_host: Option<BTreeMap<String, BTreeMap<String, String>>>,
    pub selected_thinking_by_model: Option<BTreeMap<String, String>>,
}

impl SourceControlAiModelChoice {
    fn is_empty(&self) -> bool {
        self.selected_model_by_agent.is_none()
            && self.selected_model_by_agent_by_host.is_none()
            && self.selected_thinking_by_model.is_none()
    }
}

/// Global PR-creation defaults; each field absent (`None`) inherits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourceControlAiPrCreationDefaults {
    pub draft: Option<bool>,
    pub use_template: Option<bool>,
    pub generate_details_on_open: Option<bool>,
    pub open_after_create: Option<bool>,
}

/// Fully-resolved PR-creation defaults (the TS `Required<…>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedPrCreationDefaults {
    pub draft: bool,
    pub use_template: bool,
    pub generate_details_on_open: bool,
    pub open_after_create: bool,
}

const DEFAULT_PR_CREATION_DEFAULTS: ResolvedPrCreationDefaults = ResolvedPrCreationDefaults {
    draft: false,
    use_template: false,
    generate_details_on_open: false,
    open_after_create: false,
};

/// Legacy commit-message-only settings (`CommitMessageAiSettings`). The four
/// fields the TS type marks required are optionals here because a persisted
/// blob can omit them and the twin then compares against `undefined`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitMessageAiSettings {
    pub enabled: Option<bool>,
    /// A TuiAgent id, the literal `"custom"`, an explicit `null`, or absent.
    pub agent_id: Option<Option<String>>,
    pub selected_model_by_agent: BTreeMap<String, String>,
    pub selected_model_by_agent_by_host: Option<BTreeMap<String, BTreeMap<String, String>>>,
    pub discovered_models_by_agent: Option<BTreeMap<String, Vec<CommitMessageAiModelCapability>>>,
    pub discovered_models_by_agent_by_host:
        Option<BTreeMap<String, BTreeMap<String, Vec<CommitMessageAiModelCapability>>>>,
    pub selected_thinking_by_model: BTreeMap<String, String>,
    pub custom_prompt: Option<String>,
    pub custom_agent_command: Option<String>,
}

/// The three `SourceControlAiSettings` keys `normalizeSourceControlAiSettings`
/// resolves by OBJECT SPREAD (`{...defaults, ...base}`) rather than `??`: a key
/// present holding `undefined` shadows the default, and `JSON.stringify` then
/// omits it. `Option::None` alone cannot say whether the key was absent (inherit
/// the default) or present-`undefined` (omit), and guessing writes a substituted
/// `""` / `null` / `true` into settings that are persisted per repo.
///
/// Only the legacy `commitMessageAi` bridge sets these — a decoded JSON blob
/// cannot carry `undefined`, so it leaves them all `false`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourceControlAiUndefinedKeys {
    pub enabled: bool,
    pub agent_id: bool,
    pub custom_agent_command: bool,
}

/// The split Source Control AI settings (`SourceControlAiSettings`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceControlAiSettings {
    pub enabled: Option<bool>,
    pub actions: Option<SourceControlAiActionDefaults>,
    pub agent_id: Option<Option<String>>,
    pub selected_model_by_agent: BTreeMap<String, String>,
    pub selected_model_by_agent_by_host: Option<BTreeMap<String, BTreeMap<String, String>>>,
    pub discovered_models_by_agent: Option<BTreeMap<String, Vec<CommitMessageAiModelCapability>>>,
    pub discovered_models_by_agent_by_host:
        Option<BTreeMap<String, BTreeMap<String, Vec<CommitMessageAiModelCapability>>>>,
    pub selected_thinking_by_model: BTreeMap<String, String>,
    pub custom_agent_command: Option<String>,
    pub instructions_by_operation: BTreeMap<SourceControlAiOperation, String>,
    pub model_overrides_by_operation:
        Option<BTreeMap<SourceControlAiOperation, SourceControlAiModelChoice>>,
    pub pr_creation_defaults: Option<SourceControlAiPrCreationDefaults>,
    /// Deprecated in the twin; kept for automatic migration + rollback.
    pub launch_action_defaults: Option<SourceControlAiActionDefaults>,
    /// Which of `enabled` / `agent_id` / `custom_agent_command` are present
    /// holding `undefined` rather than absent.
    pub undefined_keys: SourceControlAiUndefinedKeys,
}

/// Repo-level tri-state PR-creation override: `None` outer = absent (inherit),
/// `Some(None)` = explicit null (inherit), `Some(Some(b))` = explicit boolean.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RepoPrCreationDefaults {
    pub draft: Option<Option<bool>>,
    pub use_template: Option<Option<bool>>,
    pub generate_details_on_open: Option<Option<bool>>,
    pub open_after_create: Option<Option<bool>>,
}

/// A repo-scoped action-recipe override (an entry of `actionOverrides`). Every
/// field is tri-state: absent (`None`), an explicit inherit `null` sentinel
/// (`Some(None)`), or a concrete value (`Some(Some(_))`) — mirroring the TS
/// `{ agentId?; commandInputTemplate?: string | null; agentArgs?: string | null }`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepoSourceControlActionOverride {
    /// A `TuiAgent` id, the custom-agent id, or an explicit `null`.
    pub agent_id: Option<Option<String>>,
    pub command_input_template: Option<Option<String>>,
    pub agent_args: Option<Option<String>>,
}

impl RepoSourceControlActionOverride {
    fn is_empty(&self) -> bool {
        self.agent_id.is_none()
            && self.command_input_template.is_none()
            && self.agent_args.is_none()
    }
}

/// Repo-scoped overrides (`RepoSourceControlAiOverrides`). Instructions are
/// `Option<String>` (`Some` = string replacement, `None` = explicit null).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepoSourceControlAiOverrides {
    pub enabled: Option<bool>,
    pub custom_agent_command: Option<String>,
    pub model_overrides_by_operation:
        Option<BTreeMap<SourceControlAiOperation, SourceControlAiModelChoice>>,
    pub instructions_by_operation: Option<BTreeMap<SourceControlAiOperation, Option<String>>>,
    /// Per-action recipe overrides, including the templates derived from
    /// per-operation instructions.
    pub action_overrides: Option<BTreeMap<SourceControlActionId, RepoSourceControlActionOverride>>,
    pub pr_creation_defaults: Option<RepoPrCreationDefaults>,
}

impl RepoSourceControlAiOverrides {
    fn is_empty(&self) -> bool {
        self.enabled.is_none()
            && self.custom_agent_command.is_none()
            && self.model_overrides_by_operation.is_none()
            && self.instructions_by_operation.is_none()
            && self.action_overrides.is_none()
            && self.pr_creation_defaults.is_none()
    }
}

// ---------------------------------------------------------------------------
// Command templates derived from instructions.
// ---------------------------------------------------------------------------

/// `commandTemplateFromInstruction`: an empty/blank instruction yields the bare
/// `{basePrompt}`; otherwise the trimmed instruction is appended below it.
fn command_template_from_instruction(instruction: Option<&str>) -> String {
    let trimmed = trim_js(instruction.unwrap_or_default());
    if trimmed.is_empty() {
        DEFAULT_ACTION_COMMAND_TEMPLATE.to_string()
    } else {
        format!("{DEFAULT_ACTION_COMMAND_TEMPLATE}\n\n{trimmed}")
    }
}

/// `commandTemplateFromOperationInstruction`: branch-naming instructions define
/// naming style, so they must PRECEDE the general built-in prompt; the other
/// operations retain their released order.
fn command_template_from_operation_instruction(
    operation: SourceControlAiOperation,
    instruction: Option<&str>,
) -> String {
    let trimmed = trim_js(instruction.unwrap_or_default());
    if trimmed.is_empty() {
        return DEFAULT_ACTION_COMMAND_TEMPLATE.to_string();
    }
    if operation == SourceControlAiOperation::BranchName {
        format!("{trimmed}\n\n{DEFAULT_ACTION_COMMAND_TEMPLATE}")
    } else {
        command_template_from_instruction(Some(trimmed))
    }
}

/// `isLegacyBranchInstructionTemplate`: reorder only the exact template older
/// settings derived automatically; a user-authored template stays authoritative.
fn is_legacy_branch_instruction_template(
    operation: SourceControlAiOperation,
    instruction: Option<&str>,
    template: Option<&str>,
) -> bool {
    operation == SourceControlAiOperation::BranchName
        && !trim_js(instruction.unwrap_or_default()).is_empty()
        && template == Some(command_template_from_instruction(instruction).as_str())
}

/// `legacyPromptFromCommandTemplate`: recover the instruction a command template
/// was derived from, for the rollback projection.
fn legacy_prompt_from_command_template(
    template: Option<&str>,
    fallback: Option<&str>,
) -> String {
    let trimmed = trim_js(template.unwrap_or_default());
    if trimmed.is_empty() || trimmed == DEFAULT_ACTION_COMMAND_TEMPLATE {
        return fallback.unwrap_or_default().to_string();
    }
    match trimmed.strip_prefix(DEFAULT_ACTION_COMMAND_TEMPLATE) {
        Some(rest) => trim_js(rest).to_string(),
        None => trimmed.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Action recipes (`source-control-ai-actions.ts`).
// ---------------------------------------------------------------------------

/// Drop empty and prototype-chain keys. Not a memory-safety guard in Rust, but
/// the resulting key filtering is observable, so it is preserved.
fn is_safe_record_key(key: &str) -> bool {
    !key.is_empty() && key != "__proto__" && key != "constructor" && key != "prototype"
}

/// `normalizeSourceControlActionRecipe` over an already-decoded recipe: keep an
/// `agentId` that is null / a known TuiAgent / the custom-agent id, keep the two
/// string fields, and drop a recipe left with nothing.
///
/// This re-validates a TYPED value on purpose: the twin's `actions` blob is
/// `unknown` at runtime, so an agent id that left the catalog is dropped here
/// and not by the decoder.
fn normalize_source_control_action_recipe(
    recipe: &SourceControlActionRecipe,
) -> Option<SourceControlActionRecipe> {
    let mut normalized = SourceControlActionRecipe::default();
    match &recipe.agent_id {
        Some(None) => normalized.agent_id = Some(None),
        Some(Some(agent_id)) if is_tui_agent(agent_id) || is_custom_agent_id(Some(agent_id)) => {
            normalized.agent_id = Some(Some(agent_id.clone()));
        }
        _ => {}
    }
    normalized.command_input_template = recipe.command_input_template.clone();
    normalized.agent_args = recipe.agent_args.clone();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// `normalizeSourceControlAiActionDefaults`.
fn normalize_source_control_ai_action_defaults(
    value: Option<&SourceControlAiActionDefaults>,
) -> Option<SourceControlAiActionDefaults> {
    let value = value?;
    let mut normalized = SourceControlAiActionDefaults::new();
    for (action_id, recipe) in value {
        if let Some(recipe) = normalize_source_control_action_recipe(recipe) {
            normalized.insert(*action_id, recipe);
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// `readSourceControlActionDefault`: the recipe with its string fields trimmed,
/// keys omitted when absent or not a string.
fn read_source_control_action_default(
    defaults: Option<&SourceControlAiActionDefaults>,
    action_id: SourceControlActionId,
) -> SourceControlActionRecipe {
    let value = defaults.and_then(|defaults| defaults.get(&action_id));
    SourceControlActionRecipe {
        agent_id: value.and_then(|recipe| recipe.agent_id.clone()),
        command_input_template: value
            .and_then(|recipe| recipe.command_input_template.as_deref())
            .map(|template| trim_js(template).to_string()),
        agent_args: value
            .and_then(|recipe| recipe.agent_args.as_deref())
            .map(|args| trim_js(args).to_string()),
    }
}

/// `resolveSourceControlActionCommandTemplate`.
fn resolve_source_control_action_command_template(
    defaults: Option<&SourceControlAiActionDefaults>,
    action_id: SourceControlActionId,
) -> String {
    read_source_control_action_default(defaults, action_id)
        .command_input_template
        .unwrap_or_else(|| DEFAULT_ACTION_COMMAND_TEMPLATE.to_string())
}

// ---------------------------------------------------------------------------
// Defensive normalization over untrusted `serde_json::Value`.
// ---------------------------------------------------------------------------

static NULL: Value = Value::Null;

fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&NULL)
}

fn normalize_string_record(value: &Value) -> Option<BTreeMap<String, String>> {
    let obj = value.as_object()?;
    let mut normalized = BTreeMap::new();
    for (key, item) in obj {
        if is_safe_record_key(key) {
            if let Some(text) = item.as_str() {
                normalized.insert(key.clone(), text.to_string());
            }
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_host_agent_model_record(
    value: &Value,
) -> Option<BTreeMap<String, BTreeMap<String, String>>> {
    let obj = value.as_object()?;
    let mut normalized = BTreeMap::new();
    for (host_key, host_models) in obj {
        if !is_safe_record_key(host_key) {
            continue;
        }
        if let Some(models) = normalize_string_record(host_models) {
            normalized.insert(host_key.clone(), models);
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_source_control_ai_model_choice(value: &Value) -> Option<SourceControlAiModelChoice> {
    if !value.is_object() {
        return None;
    }
    let choice = SourceControlAiModelChoice {
        selected_model_by_agent: normalize_string_record(get(value, "selectedModelByAgent")),
        selected_model_by_agent_by_host: normalize_host_agent_model_record(get(
            value,
            "selectedModelByAgentByHost",
        )),
        selected_thinking_by_model: normalize_string_record(get(value, "selectedThinkingByModel")),
    };
    if choice.is_empty() {
        None
    } else {
        Some(choice)
    }
}

fn normalize_operation_record<T>(
    value: &Value,
    normalize_value: fn(&Value) -> Option<T>,
) -> Option<BTreeMap<SourceControlAiOperation, T>> {
    let obj = value.as_object()?;
    let mut normalized = BTreeMap::new();
    for operation in SourceControlAiOperation::ALL {
        // `Object.prototype.hasOwnProperty.call(value, operation)`: own keys only.
        if let Some(item) = obj.get(operation.as_str()) {
            if let Some(parsed) = normalize_value(item) {
                normalized.insert(operation, parsed);
            }
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// `string | null | undefined`: a present-but-defined value (string or null) is
/// kept (outer `Some`); anything else is dropped (outer `None`).
fn normalize_repo_instruction(value: &Value) -> Option<Option<String>> {
    if let Some(text) = value.as_str() {
        Some(Some(text.to_string()))
    } else if value.is_null() {
        Some(None)
    } else {
        None
    }
}

fn parse_bool_or_null(value: &Value) -> Option<Option<bool>> {
    if let Some(flag) = value.as_bool() {
        Some(Some(flag))
    } else if value.is_null() {
        Some(None)
    } else {
        None
    }
}

fn normalize_repo_pr_creation_defaults(value: &Value) -> Option<RepoPrCreationDefaults> {
    let obj = value.as_object()?;
    let mut normalized = RepoPrCreationDefaults::default();
    let mut any = false;
    if let Some(item) = obj.get("draft").and_then(parse_bool_or_null) {
        normalized.draft = Some(item);
        any = true;
    }
    if let Some(item) = obj.get("useTemplate").and_then(parse_bool_or_null) {
        normalized.use_template = Some(item);
        any = true;
    }
    if let Some(item) = obj.get("generateDetailsOnOpen").and_then(parse_bool_or_null) {
        normalized.generate_details_on_open = Some(item);
        any = true;
    }
    if let Some(item) = obj.get("openAfterCreate").and_then(parse_bool_or_null) {
        normalized.open_after_create = Some(item);
        any = true;
    }
    if any {
        Some(normalized)
    } else {
        None
    }
}

/// One `actionOverrides` entry: `normalizeSourceControlActionRecipe` plus the
/// two explicit-null inherit sentinels the repo shape allows.
///
/// An ABSENT key and an explicit `null` are different answers here: an absent
/// `commandInputTemplate` lets a per-operation instruction migrate into one,
/// a `null` blocks that migration. Reading both off `value.get(..)` and testing
/// `is_null()` on a defaulted `Value::Null` conflates them.
fn normalize_repo_action_override(item: &Value) -> Option<RepoSourceControlActionOverride> {
    let obj = item.as_object()?;
    let mut normalized = RepoSourceControlActionOverride::default();
    match obj.get("agentId") {
        Some(Value::Null) => normalized.agent_id = Some(None),
        Some(Value::String(text))
            if is_tui_agent(text) || is_custom_agent_id(Some(text.as_str())) =>
        {
            normalized.agent_id = Some(Some(text.clone()));
        }
        _ => {}
    }
    match obj.get("commandInputTemplate") {
        Some(Value::String(text)) => normalized.command_input_template = Some(Some(text.clone())),
        Some(Value::Null) => normalized.command_input_template = Some(None),
        _ => {}
    }
    match obj.get("agentArgs") {
        Some(Value::String(text)) => normalized.agent_args = Some(Some(text.clone())),
        Some(Value::Null) => normalized.agent_args = Some(None),
        _ => {}
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_action_overrides(
    value: &Value,
) -> Option<BTreeMap<SourceControlActionId, RepoSourceControlActionOverride>> {
    let obj = value.as_object()?;
    let mut normalized = BTreeMap::new();
    for action_id in SourceControlActionId::ALL {
        if let Some(item) = obj.get(action_id.as_str()) {
            if let Some(parsed) = normalize_repo_action_override(item) {
                normalized.insert(action_id, parsed);
            }
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub fn normalize_repo_source_control_ai_overrides(
    value: &Value,
) -> Option<RepoSourceControlAiOverrides> {
    // `isRecord`: an object that is neither null nor an array — `is_object()`
    // is already false for both.
    if !value.is_object() {
        return None;
    }
    let mut normalized = RepoSourceControlAiOverrides {
        enabled: get(value, "enabled").as_bool(),
        ..RepoSourceControlAiOverrides::default()
    };
    if let Some(command) = get(value, "customAgentCommand").as_str() {
        let command = trim_js(command);
        if !command.is_empty() {
            normalized.custom_agent_command = Some(command.to_string());
        }
    }
    normalized.model_overrides_by_operation = normalize_operation_record(
        get(value, "modelOverridesByOperation"),
        normalize_source_control_ai_model_choice,
    );
    let instructions_by_operation = normalize_operation_record(
        get(value, "instructionsByOperation"),
        normalize_repo_instruction,
    );
    // Why: per-operation instructions migrate into an action recipe's
    // commandInputTemplate when the recipe doesn't already carry one — but only
    // when the template is ABSENT (an explicit null sentinel must survive).
    let mut action_overrides =
        normalize_action_overrides(get(value, "actionOverrides")).unwrap_or_default();
    for operation in SourceControlAiOperation::ALL {
        // `typeof instruction === 'string'`: a string migrates; null/absent skip.
        let Some(Some(instruction)) = instructions_by_operation
            .as_ref()
            .and_then(|map| map.get(&operation))
        else {
            continue;
        };
        let action_id = operation.action_id();
        let existing = action_overrides
            .get(&action_id)
            .and_then(|entry| entry.command_input_template.as_ref());
        let should_migrate = match existing {
            None => true,
            Some(Some(template)) => is_legacy_branch_instruction_template(
                operation,
                Some(instruction),
                Some(template.as_str()),
            ),
            Some(None) => false,
        };
        if should_migrate {
            action_overrides
                .entry(action_id)
                .or_default()
                .command_input_template = Some(Some(command_template_from_operation_instruction(
                operation,
                Some(instruction),
            )));
        }
    }
    normalized.instructions_by_operation = instructions_by_operation;
    if !action_overrides.is_empty() {
        normalized.action_overrides = Some(action_overrides);
    }
    normalized.pr_creation_defaults =
        normalize_repo_pr_creation_defaults(get(value, "prCreationDefaults"));
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

// ---------------------------------------------------------------------------
// Defaults + legacy migration.
// ---------------------------------------------------------------------------

fn default_actions() -> SourceControlAiActionDefaults {
    SourceControlActionId::ALL
        .into_iter()
        .map(|action_id| {
            (
                action_id,
                SourceControlActionRecipe {
                    agent_id: None,
                    command_input_template: Some(
                        DEFAULT_ACTION_COMMAND_TEMPLATE.to_string(),
                    ),
                    agent_args: None,
                },
            )
        })
        .collect()
}

pub fn get_default_source_control_ai_settings() -> SourceControlAiSettings {
    let instructions = SourceControlAiOperation::ALL
        .into_iter()
        .map(|operation| (operation, String::new()))
        .collect();
    SourceControlAiSettings {
        enabled: Some(true),
        actions: Some(default_actions()),
        agent_id: Some(None),
        selected_model_by_agent: BTreeMap::new(),
        selected_model_by_agent_by_host: Some(BTreeMap::new()),
        discovered_models_by_agent: Some(BTreeMap::new()),
        discovered_models_by_agent_by_host: Some(BTreeMap::new()),
        selected_thinking_by_model: BTreeMap::new(),
        custom_agent_command: Some(String::new()),
        instructions_by_operation: instructions,
        model_overrides_by_operation: None,
        pr_creation_defaults: Some(SourceControlAiPrCreationDefaults {
            draft: Some(false),
            use_template: Some(false),
            generate_details_on_open: Some(false),
            open_after_create: Some(false),
        }),
        launch_action_defaults: Some(SourceControlAiActionDefaults::new()),
        undefined_keys: SourceControlAiUndefinedKeys::default(),
    }
}

/// `actionRecipeFromLegacyCommitMessageAi`.
fn action_recipe_from_legacy(legacy: &CommitMessageAiSettings) -> SourceControlActionRecipe {
    let agent_id = match &legacy.agent_id {
        Some(None) => Some(None),
        Some(Some(agent_id)) if is_custom_agent_id(Some(agent_id)) => {
            Some(Some(CUSTOM_AGENT_ID.to_string()))
        }
        // `legacy.agentId ? { agentId } : {}` — a falsy (empty) id is dropped.
        Some(Some(agent_id)) if !agent_id.is_empty() => Some(Some(agent_id.clone())),
        _ => None,
    };
    SourceControlActionRecipe {
        agent_id,
        command_input_template: Some(command_template_from_instruction(
            legacy.custom_prompt.as_deref(),
        )),
        agent_args: None,
    }
}

pub fn source_control_ai_settings_from_legacy(
    legacy: Option<&CommitMessageAiSettings>,
) -> SourceControlAiSettings {
    let defaults = get_default_source_control_ai_settings();
    let legacy = match legacy {
        Some(legacy) => legacy,
        None => return defaults,
    };
    let legacy_recipe = action_recipe_from_legacy(legacy);
    let mut actions = defaults.actions.clone().unwrap_or_default();
    actions.insert(SourceControlActionId::CommitMessage, legacy_recipe.clone());
    actions.insert(
        SourceControlActionId::BranchName,
        SourceControlActionRecipe {
            command_input_template: Some(command_template_from_operation_instruction(
                SourceControlAiOperation::BranchName,
                legacy.custom_prompt.as_deref(),
            )),
            ..legacy_recipe
        },
    );
    let prompt = legacy.custom_prompt.clone().unwrap_or_default();
    let mut instructions = BTreeMap::new();
    // Why: the legacy prompt covered commit generation and branch auto-rename;
    // the first split must preserve that guidance for both released paths.
    instructions.insert(SourceControlAiOperation::CommitMessage, prompt.clone());
    instructions.insert(SourceControlAiOperation::PullRequest, String::new());
    instructions.insert(SourceControlAiOperation::BranchName, prompt);
    SourceControlAiSettings {
        enabled: legacy.enabled,
        actions: Some(actions),
        agent_id: legacy.agent_id.clone(),
        selected_model_by_agent: legacy.selected_model_by_agent.clone(),
        selected_model_by_agent_by_host: Some(
            legacy.selected_model_by_agent_by_host.clone().unwrap_or_default(),
        ),
        discovered_models_by_agent: Some(
            legacy.discovered_models_by_agent.clone().unwrap_or_default(),
        ),
        discovered_models_by_agent_by_host: Some(
            legacy.discovered_models_by_agent_by_host.clone().unwrap_or_default(),
        ),
        selected_thinking_by_model: legacy.selected_thinking_by_model.clone(),
        custom_agent_command: legacy.custom_agent_command.clone(),
        instructions_by_operation: instructions,
        model_overrides_by_operation: defaults.model_overrides_by_operation,
        pr_creation_defaults: defaults.pr_creation_defaults,
        launch_action_defaults: defaults.launch_action_defaults,
        // These three are written as own keys off `legacy`, so an absent legacy
        // field lands as a present `undefined`, not as the spread default.
        undefined_keys: legacy_undefined_keys(legacy),
    }
}

/// Which of the three spread-only keys a `{ ...defaults, enabled: legacy.enabled,
/// agentId: legacy.agentId, customAgentCommand: legacy.customAgentCommand }`
/// write leaves holding `undefined`.
fn legacy_undefined_keys(legacy: &CommitMessageAiSettings) -> SourceControlAiUndefinedKeys {
    SourceControlAiUndefinedKeys {
        enabled: legacy.enabled.is_none(),
        agent_id: legacy.agent_id.is_none(),
        custom_agent_command: legacy.custom_agent_command.is_none(),
    }
}

pub fn normalize_source_control_ai_settings(
    value: Option<&SourceControlAiSettings>,
    legacy: Option<&CommitMessageAiSettings>,
) -> SourceControlAiSettings {
    let base_owned;
    let base: &SourceControlAiSettings = match value {
        Some(value) => value,
        None => {
            base_owned = source_control_ai_settings_from_legacy(legacy);
            &base_owned
        }
    };
    let defaults = get_default_source_control_ai_settings();

    let normalized_launch_action_defaults =
        normalize_source_control_ai_action_defaults(base.launch_action_defaults.as_ref());
    let mut normalized_actions = normalized_launch_action_defaults.clone().unwrap_or_default();
    if let Some(from_actions) = normalize_source_control_ai_action_defaults(base.actions.as_ref()) {
        normalized_actions.extend(from_actions);
    }

    let mut actions = defaults.actions.clone().unwrap_or_default();
    actions.extend(normalized_actions.clone());
    for operation in SourceControlAiOperation::ALL {
        let action_id = operation.action_id();
        let existing = read_source_control_action_default(Some(&normalized_actions), action_id);
        let instruction = base.instructions_by_operation.get(&operation);
        let legacy_instruction = if operation == SourceControlAiOperation::CommitMessage {
            legacy.and_then(|legacy| legacy.custom_prompt.as_deref())
        } else {
            None
        };
        // `instruction ?? legacyInstruction` — nullish, so an EMPTY instruction
        // still wins over the legacy prompt.
        let resolved_instruction = instruction.map(String::as_str).or(legacy_instruction);
        // `instruction || legacyInstruction` — truthy, so an empty instruction
        // with no legacy prompt derives no template at all.
        let has_instruction = instruction.is_some_and(|value| !value.is_empty())
            || legacy_instruction.is_some_and(|value| !value.is_empty());
        let instruction_template = has_instruction.then(|| {
            command_template_from_operation_instruction(operation, resolved_instruction)
        });
        let should_apply = instruction_template.is_some()
            && match existing.command_input_template.as_deref() {
                None => true,
                Some(DEFAULT_ACTION_COMMAND_TEMPLATE) => true,
                Some(template) => is_legacy_branch_instruction_template(
                    operation,
                    resolved_instruction,
                    Some(template),
                ),
            };
        let mut recipe = defaults
            .actions
            .as_ref()
            .and_then(|defaults| defaults.get(&action_id))
            .cloned()
            .unwrap_or_default();
        if let Some(Some(agent_id)) = base.agent_id.as_ref() {
            if !agent_id.is_empty() && !is_custom_agent_id(Some(agent_id)) {
                recipe.agent_id = Some(Some(agent_id.clone()));
            }
        }
        if existing.agent_id.is_some() {
            recipe.agent_id = existing.agent_id.clone();
        }
        if existing.command_input_template.is_some() {
            recipe.command_input_template = existing.command_input_template.clone();
        }
        if existing.agent_args.is_some() {
            recipe.agent_args = existing.agent_args.clone();
        }
        if let Some(template) = instruction_template.filter(|_| should_apply) {
            recipe.command_input_template = Some(template);
        }
        actions.insert(action_id, recipe);
    }

    let mut selected_model_by_agent = defaults.selected_model_by_agent.clone();
    selected_model_by_agent.extend(base.selected_model_by_agent.clone());
    let mut selected_thinking_by_model = defaults.selected_thinking_by_model.clone();
    selected_thinking_by_model.extend(base.selected_thinking_by_model.clone());
    let mut instructions_by_operation = defaults.instructions_by_operation.clone();
    instructions_by_operation.extend(base.instructions_by_operation.clone());

    // `{ ...defaults, ...base }`: a key `base` holds as `undefined` shadows the
    // default rather than inheriting it, and is then dropped by JSON.stringify.
    SourceControlAiSettings {
        enabled: if base.undefined_keys.enabled {
            None
        } else {
            base.enabled.or(defaults.enabled)
        },
        actions: Some(actions),
        agent_id: if base.undefined_keys.agent_id {
            None
        } else {
            base.agent_id.clone().or(defaults.agent_id)
        },
        selected_model_by_agent,
        selected_model_by_agent_by_host: base
            .selected_model_by_agent_by_host
            .clone()
            .or(defaults.selected_model_by_agent_by_host),
        discovered_models_by_agent: base
            .discovered_models_by_agent
            .clone()
            .or(defaults.discovered_models_by_agent),
        discovered_models_by_agent_by_host: base
            .discovered_models_by_agent_by_host
            .clone()
            .or(defaults.discovered_models_by_agent_by_host),
        selected_thinking_by_model,
        custom_agent_command: if base.undefined_keys.custom_agent_command {
            None
        } else {
            base.custom_agent_command
                .clone()
                .or(defaults.custom_agent_command)
        },
        instructions_by_operation,
        model_overrides_by_operation: base.model_overrides_by_operation.clone(),
        pr_creation_defaults: Some(merge_pr_defaults(base.pr_creation_defaults.as_ref())),
        launch_action_defaults: normalized_launch_action_defaults
            .or(defaults.launch_action_defaults),
        // The spread copies the own `undefined` through, so re-normalizing the
        // result must not resurrect the default either.
        undefined_keys: base.undefined_keys,
    }
}

fn merge_pr_defaults(
    base: Option<&SourceControlAiPrCreationDefaults>,
) -> SourceControlAiPrCreationDefaults {
    let mut out = SourceControlAiPrCreationDefaults {
        draft: Some(false),
        use_template: Some(false),
        generate_details_on_open: Some(false),
        open_after_create: Some(false),
    };
    if let Some(base) = base {
        out.draft = base.draft.or(out.draft);
        out.use_template = base.use_template.or(out.use_template);
        out.generate_details_on_open = base.generate_details_on_open.or(out.generate_details_on_open);
        out.open_after_create = base.open_after_create.or(out.open_after_create);
    }
    out
}

fn merge_selected_model_by_agent_by_host(
    base: Option<&BTreeMap<String, BTreeMap<String, String>>>,
    override_: Option<&BTreeMap<String, BTreeMap<String, String>>>,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut merged = base.cloned().unwrap_or_default();
    if let Some(override_) = override_ {
        for (host_key, host_models) in override_ {
            merged.entry(host_key.clone()).or_default().extend(host_models.clone());
        }
    }
    merged
}

/// Returns the merged record plus whether the delta changed anything. The
/// boolean replaces the TS reference-identity check (`result !== existing`),
/// which is exactly "did this delta produce a different object".
fn merge_legacy_model_selection_delta(
    existing: Option<&BTreeMap<String, String>>,
    legacy: Option<&BTreeMap<String, String>>,
    projected: Option<&BTreeMap<String, String>>,
) -> (Option<BTreeMap<String, String>>, bool) {
    let empty = BTreeMap::new();
    let legacy = legacy.unwrap_or(&empty);
    let projected = projected.unwrap_or(&empty);
    let mut merged = existing.cloned().unwrap_or_default();
    let mut changed = false;
    let mut keys: BTreeSet<&String> = BTreeSet::new();
    keys.extend(legacy.keys());
    keys.extend(projected.keys());
    for key in keys {
        let legacy_value = legacy.get(key);
        // `JSON.stringify(projected[key]) === JSON.stringify(legacyValue)` over
        // string values is plain (UTF-8) equality, with `None == None`.
        if projected.get(key) == legacy_value {
            continue;
        }
        changed = true;
        match legacy_value {
            Some(value) => {
                merged.insert(key.clone(), value.clone());
            }
            None => {
                merged.remove(key);
            }
        }
    }
    if changed {
        (Some(merged), true)
    } else {
        (existing.cloned(), false)
    }
}

/// host id -> (agent -> model id).
type HostModelSelections = BTreeMap<String, BTreeMap<String, String>>;

fn merge_legacy_host_model_selection_delta(
    existing: Option<&HostModelSelections>,
    legacy: Option<&HostModelSelections>,
    projected: Option<&HostModelSelections>,
) -> (Option<HostModelSelections>, bool) {
    let empty = BTreeMap::new();
    let legacy = legacy.unwrap_or(&empty);
    let projected = projected.unwrap_or(&empty);
    let mut merged = existing.cloned().unwrap_or_default();
    let mut changed = false;
    let mut host_keys: BTreeSet<&String> = BTreeSet::new();
    host_keys.extend(legacy.keys());
    host_keys.extend(projected.keys());
    for host_key in host_keys {
        let current = merged.get(host_key).cloned();
        let (next_host_models, inner_changed) = merge_legacy_model_selection_delta(
            current.as_ref(),
            legacy.get(host_key),
            projected.get(host_key),
        );
        if inner_changed {
            changed = true;
        }
        match next_host_models {
            Some(models) if !models.is_empty() => {
                merged.insert(host_key.clone(), models);
            }
            _ => {
                merged.remove(host_key);
            }
        }
    }
    if changed {
        (Some(merged), true)
    } else {
        (existing.cloned(), false)
    }
}

fn has_entries<K, V>(map: Option<&BTreeMap<K, V>>) -> bool {
    matches!(map, Some(map) if !map.is_empty())
}

/// `applyLegacyAgentToActionRecipe`.
fn apply_legacy_agent_to_action_recipe(
    recipe: Option<&SourceControlActionRecipe>,
    agent_id: &Option<Option<String>>,
) -> SourceControlActionRecipe {
    let mut next = recipe.cloned().unwrap_or_default();
    next.agent_id = match agent_id {
        Some(None) => Some(None),
        Some(Some(id)) if is_custom_agent_id(Some(id)) => Some(Some(CUSTOM_AGENT_ID.to_string())),
        Some(Some(id)) if !id.is_empty() => Some(Some(id.clone())),
        _ => None,
    };
    next
}

/// `shouldImportLegacyBranchPrompt`: stale legacy branch instructions can remain
/// after a user customizes the new branch recipe; only recipe state can prove
/// the two are still coupled.
fn should_import_legacy_branch_prompt(
    base: &SourceControlAiSettings,
    projected_legacy: &CommitMessageAiSettings,
) -> bool {
    let branch_recipe =
        read_source_control_action_default(base.actions.as_ref(), SourceControlActionId::BranchName);
    let projected_template = command_template_from_operation_instruction(
        SourceControlAiOperation::BranchName,
        projected_legacy.custom_prompt.as_deref(),
    );
    match branch_recipe.command_input_template.as_deref() {
        None => true,
        Some(template) => {
            template == DEFAULT_ACTION_COMMAND_TEMPLATE || template == projected_template
        }
    }
}

/// `shouldImportLegacyBranchAgent`.
fn should_import_legacy_branch_agent(
    base: &SourceControlAiSettings,
    projected_legacy: &CommitMessageAiSettings,
) -> bool {
    let branch_recipe =
        read_source_control_action_default(base.actions.as_ref(), SourceControlActionId::BranchName);
    match branch_recipe.agent_id {
        None => true,
        Some(agent_id) => Some(agent_id) == projected_legacy.agent_id,
    }
}

pub struct MergeLegacyOptions {
    pub pull_request_instructions_from_legacy: bool,
}

/// The four legacy fields the merge compares against its own rollback
/// projection (`legacyCommitMessageCoreChanges`).
struct LegacyCoreChanges {
    enabled: bool,
    agent_id: bool,
    custom_prompt: bool,
    custom_agent_command: bool,
}

impl LegacyCoreChanges {
    fn any(&self) -> bool {
        self.enabled || self.agent_id || self.custom_prompt || self.custom_agent_command
    }
}

fn legacy_core_changes(
    legacy: &CommitMessageAiSettings,
    projected: &CommitMessageAiSettings,
) -> LegacyCoreChanges {
    LegacyCoreChanges {
        enabled: legacy.enabled != projected.enabled,
        agent_id: legacy.agent_id != projected.agent_id,
        custom_prompt: legacy.custom_prompt != projected.custom_prompt,
        custom_agent_command: legacy.custom_agent_command != projected.custom_agent_command,
    }
}

pub fn merge_legacy_commit_message_ai_into_source_control_ai(
    source_control_ai: Option<&SourceControlAiSettings>,
    legacy: Option<&CommitMessageAiSettings>,
    options: &MergeLegacyOptions,
) -> SourceControlAiSettings {
    // Why: older runtimes and rollback builds still write commitMessageAi; merge
    // those writes into the new shape without wiping PR-only settings.
    let base = normalize_source_control_ai_settings(source_control_ai, legacy);
    let legacy = match legacy {
        Some(legacy) => legacy,
        None => return base,
    };
    let legacy_prompt = legacy.custom_prompt.clone().unwrap_or_default();

    if source_control_ai.is_none() {
        let mut next = base.clone();
        next.enabled = legacy.enabled;
        next.agent_id = legacy.agent_id.clone();
        next.selected_model_by_agent = legacy.selected_model_by_agent.clone();
        next.selected_model_by_agent_by_host =
            Some(legacy.selected_model_by_agent_by_host.clone().unwrap_or_default());
        next.discovered_models_by_agent =
            Some(legacy.discovered_models_by_agent.clone().unwrap_or_default());
        next.discovered_models_by_agent_by_host =
            Some(legacy.discovered_models_by_agent_by_host.clone().unwrap_or_default());
        next.selected_thinking_by_model = legacy.selected_thinking_by_model.clone();
        next.custom_agent_command = legacy.custom_agent_command.clone();
        next.undefined_keys = legacy_undefined_keys(legacy);
        next.instructions_by_operation
            .insert(SourceControlAiOperation::CommitMessage, legacy_prompt.clone());
        next.instructions_by_operation
            .insert(SourceControlAiOperation::BranchName, legacy_prompt.clone());
        if options.pull_request_instructions_from_legacy {
            next.instructions_by_operation
                .insert(SourceControlAiOperation::PullRequest, legacy_prompt);
        }
        return normalize_source_control_ai_settings(Some(&next), Some(legacy));
    }

    let existing_commit_choice = base
        .model_overrides_by_operation
        .as_ref()
        .and_then(|overrides| overrides.get(&SourceControlAiOperation::CommitMessage));
    let projected_legacy = project_source_control_ai_to_legacy_commit_message_ai(&base, None);
    let (selected_model_by_agent, changed_models) = merge_legacy_model_selection_delta(
        existing_commit_choice.and_then(|choice| choice.selected_model_by_agent.as_ref()),
        Some(&legacy.selected_model_by_agent),
        Some(&projected_legacy.selected_model_by_agent),
    );
    let (selected_model_by_agent_by_host, changed_host_models) =
        merge_legacy_host_model_selection_delta(
            existing_commit_choice.and_then(|choice| choice.selected_model_by_agent_by_host.as_ref()),
            legacy.selected_model_by_agent_by_host.as_ref(),
            projected_legacy.selected_model_by_agent_by_host.as_ref(),
        );
    let (selected_thinking_by_model, changed_thinking) = merge_legacy_model_selection_delta(
        existing_commit_choice.and_then(|choice| choice.selected_thinking_by_model.as_ref()),
        Some(&legacy.selected_thinking_by_model),
        Some(&projected_legacy.selected_thinking_by_model),
    );
    let should_merge_models = changed_models || changed_host_models || changed_thinking;
    let mut next_overrides = base.model_overrides_by_operation.clone().unwrap_or_default();
    if should_merge_models {
        let mut next_choice = SourceControlAiModelChoice::default();
        if has_entries(selected_model_by_agent.as_ref()) {
            next_choice.selected_model_by_agent = selected_model_by_agent;
        }
        if has_entries(selected_model_by_agent_by_host.as_ref()) {
            next_choice.selected_model_by_agent_by_host = selected_model_by_agent_by_host;
        }
        if has_entries(selected_thinking_by_model.as_ref()) {
            next_choice.selected_thinking_by_model = selected_thinking_by_model;
        }
        if next_choice.is_empty() {
            next_overrides.remove(&SourceControlAiOperation::CommitMessage);
        } else {
            next_overrides.insert(SourceControlAiOperation::CommitMessage, next_choice);
        }
    }

    // Why: rollback builds write commitMessageAi, while new builds project
    // commit-message overrides there. Keep those model choices scoped to
    // commit-message generation so PR defaults cannot drift on reload.
    let mut next = base.clone();
    next.discovered_models_by_agent =
        Some(legacy.discovered_models_by_agent.clone().unwrap_or_default());
    next.discovered_models_by_agent_by_host =
        Some(legacy.discovered_models_by_agent_by_host.clone().unwrap_or_default());
    let changes = legacy_core_changes(legacy, &projected_legacy);
    let should_merge_core = changes.any();
    if should_merge_core {
        let should_merge_branch_prompt =
            changes.custom_prompt && should_import_legacy_branch_prompt(&base, &projected_legacy);
        let should_merge_branch_agent =
            changes.agent_id && should_import_legacy_branch_agent(&base, &projected_legacy);
        let legacy_recipe = action_recipe_from_legacy(legacy);
        // Why: legacy commitMessageAi is also our rollback projection. Only
        // import fields that diverged so independent action recipes survive.
        // Each import writes an OWN key, so an absent legacy field lands as a
        // present `undefined` — no recorded value, and none to be invented.
        let legacy_undefined = legacy_undefined_keys(legacy);
        if changes.enabled {
            next.enabled = legacy.enabled;
            next.undefined_keys.enabled = legacy_undefined.enabled;
        }
        if changes.agent_id {
            next.agent_id = legacy.agent_id.clone();
            next.undefined_keys.agent_id = legacy_undefined.agent_id;
        }
        if changes.custom_agent_command {
            next.custom_agent_command = legacy.custom_agent_command.clone();
            next.undefined_keys.custom_agent_command = legacy_undefined.custom_agent_command;
        }
        if changes.custom_prompt {
            next.instructions_by_operation
                .insert(SourceControlAiOperation::CommitMessage, legacy_prompt.clone());
        }
        if should_merge_branch_prompt {
            next.instructions_by_operation
                .insert(SourceControlAiOperation::BranchName, legacy_prompt.clone());
        }
        if changes.custom_prompt && options.pull_request_instructions_from_legacy {
            next.instructions_by_operation
                .insert(SourceControlAiOperation::PullRequest, legacy_prompt.clone());
        }
        let mut actions = base.actions.clone().unwrap_or_default();
        let base_commit = base
            .actions
            .as_ref()
            .and_then(|actions| actions.get(&SourceControlActionId::CommitMessage));
        let mut commit_recipe = if changes.agent_id {
            apply_legacy_agent_to_action_recipe(base_commit, &legacy.agent_id)
        } else {
            base_commit.cloned().unwrap_or_default()
        };
        if changes.custom_prompt {
            commit_recipe.command_input_template = legacy_recipe.command_input_template.clone();
        }
        actions.insert(SourceControlActionId::CommitMessage, commit_recipe);
        let base_branch = base
            .actions
            .as_ref()
            .and_then(|actions| actions.get(&SourceControlActionId::BranchName));
        let mut branch_recipe = if should_merge_branch_agent {
            apply_legacy_agent_to_action_recipe(base_branch, &legacy.agent_id)
        } else {
            base_branch.cloned().unwrap_or_default()
        };
        if should_merge_branch_prompt {
            branch_recipe.command_input_template = Some(command_template_from_operation_instruction(
                SourceControlAiOperation::BranchName,
                legacy.custom_prompt.as_deref(),
            ));
        }
        actions.insert(SourceControlActionId::BranchName, branch_recipe);
        next.actions = Some(actions);
    }
    next.model_overrides_by_operation = Some(next_overrides);
    normalize_source_control_ai_settings(Some(&next), should_merge_core.then_some(legacy))
}

// ---------------------------------------------------------------------------
// Host-scoped model selection.
// ---------------------------------------------------------------------------

pub fn read_source_control_ai_model_choice_for_host(
    choice: Option<&SourceControlAiModelChoice>,
    host_key: &str,
    agent_id: &str,
) -> Option<String> {
    choice
        .and_then(|choice| choice.selected_model_by_agent_by_host.as_ref())
        .and_then(|by_host| by_host.get(host_key))
        .and_then(|by_agent| by_agent.get(agent_id))
        .cloned()
        .or_else(|| {
            if host_key == LOCAL_COMMIT_MESSAGE_HOST_KEY {
                choice
                    .and_then(|choice| choice.selected_model_by_agent.as_ref())
                    .and_then(|by_agent| by_agent.get(agent_id))
                    .cloned()
            } else {
                None
            }
        })
}

pub fn select_source_control_ai_model_choice_for_host(
    choice: Option<&SourceControlAiModelChoice>,
    host_key: &str,
    agent_id: &str,
    model_id: &str,
) -> SourceControlAiModelChoice {
    let mut result = choice.cloned().unwrap_or_default();
    if host_key == LOCAL_COMMIT_MESSAGE_HOST_KEY {
        let mut by_agent = choice
            .and_then(|choice| choice.selected_model_by_agent.clone())
            .unwrap_or_default();
        by_agent.insert(agent_id.to_string(), model_id.to_string());
        result.selected_model_by_agent = Some(by_agent);
    } else {
        result.selected_model_by_agent =
            choice.and_then(|choice| choice.selected_model_by_agent.clone());
    }

    let mut by_host = choice
        .and_then(|choice| choice.selected_model_by_agent_by_host.clone())
        .unwrap_or_default();
    let mut host_selected = by_host.get(host_key).cloned().unwrap_or_default();
    host_selected.insert(agent_id.to_string(), model_id.to_string());
    by_host.insert(host_key.to_string(), host_selected);
    result.selected_model_by_agent_by_host = Some(by_host);
    result
}

pub fn clear_source_control_ai_model_choice_for_host(
    choice: Option<&SourceControlAiModelChoice>,
    host_key: &str,
    agent_id: &str,
) -> Option<SourceControlAiModelChoice> {
    let choice = choice?;
    // Why: model choices are host-scoped; clearing one "Use global" selector
    // must not erase a different SSH/runtime host's override.
    let mut selected_model_by_agent = choice.selected_model_by_agent.clone().unwrap_or_default();
    if host_key == LOCAL_COMMIT_MESSAGE_HOST_KEY {
        selected_model_by_agent.remove(agent_id);
    }

    let mut selected_model_by_agent_by_host =
        choice.selected_model_by_agent_by_host.clone().unwrap_or_default();
    let mut host_models = selected_model_by_agent_by_host
        .get(host_key)
        .cloned()
        .unwrap_or_default();
    host_models.remove(agent_id);
    if host_models.is_empty() {
        selected_model_by_agent_by_host.remove(host_key);
    } else {
        selected_model_by_agent_by_host.insert(host_key.to_string(), host_models);
    }

    let mut next_choice = SourceControlAiModelChoice::default();
    if !selected_model_by_agent.is_empty() {
        next_choice.selected_model_by_agent = Some(selected_model_by_agent);
    }
    if !selected_model_by_agent_by_host.is_empty() {
        next_choice.selected_model_by_agent_by_host = Some(selected_model_by_agent_by_host);
    }
    let has_model_selection = next_choice.selected_model_by_agent.is_some()
        || next_choice.selected_model_by_agent_by_host.is_some();
    if !has_model_selection {
        return None;
    }
    if let Some(thinking) = choice.selected_thinking_by_model.as_ref() {
        if !thinking.is_empty() {
            next_choice.selected_thinking_by_model = Some(thinking.clone());
        }
    }
    Some(next_choice)
}

pub fn project_source_control_ai_to_legacy_commit_message_ai(
    source_control_ai: &SourceControlAiSettings,
    previous_legacy: Option<&CommitMessageAiSettings>,
) -> CommitMessageAiSettings {
    let commit_choice = source_control_ai
        .model_overrides_by_operation
        .as_ref()
        .and_then(|overrides| overrides.get(&SourceControlAiOperation::CommitMessage));
    let commit_recipe = read_source_control_action_default(
        source_control_ai.actions.as_ref(),
        SourceControlActionId::CommitMessage,
    );

    let mut selected_model_by_agent = source_control_ai.selected_model_by_agent.clone();
    if let Some(by_agent) = commit_choice.and_then(|choice| choice.selected_model_by_agent.clone()) {
        selected_model_by_agent.extend(by_agent);
    }
    let mut selected_thinking_by_model = source_control_ai.selected_thinking_by_model.clone();
    if let Some(by_model) = commit_choice.and_then(|choice| choice.selected_thinking_by_model.clone())
    {
        selected_thinking_by_model.extend(by_model);
    }
    let fallback_prompt = source_control_ai
        .instructions_by_operation
        .get(&SourceControlAiOperation::CommitMessage)
        .map(String::as_str)
        .or_else(|| previous_legacy.and_then(|legacy| legacy.custom_prompt.as_deref()));

    CommitMessageAiSettings {
        enabled: source_control_ai.enabled,
        agent_id: commit_recipe
            .agent_id
            .clone()
            .or_else(|| source_control_ai.agent_id.clone()),
        selected_model_by_agent,
        selected_model_by_agent_by_host: Some(merge_selected_model_by_agent_by_host(
            source_control_ai.selected_model_by_agent_by_host.as_ref(),
            commit_choice.and_then(|choice| choice.selected_model_by_agent_by_host.as_ref()),
        )),
        discovered_models_by_agent: Some(
            source_control_ai.discovered_models_by_agent.clone().unwrap_or_default(),
        ),
        discovered_models_by_agent_by_host: Some(
            source_control_ai.discovered_models_by_agent_by_host.clone().unwrap_or_default(),
        ),
        selected_thinking_by_model,
        custom_prompt: Some(legacy_prompt_from_command_template(
            commit_recipe.command_input_template.as_deref(),
            fallback_prompt,
        )),
        custom_agent_command: source_control_ai.custom_agent_command.clone(),
    }
}

// ---------------------------------------------------------------------------
// Per-operation resolution.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSourceControlAiGenerationParams {
    pub agent_id: String,
    pub model: String,
    pub thinking_level: Option<String>,
    pub custom_prompt: Option<String>,
    pub command_input_template: Option<String>,
    pub agent_args: Option<String>,
    pub custom_agent_command: Option<String>,
    pub agent_command_override: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSourceControlAiOperation {
    pub enabled: bool,
    pub params: ResolvedSourceControlAiGenerationParams,
    pub pr_creation_defaults: ResolvedPrCreationDefaults,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolveSourceControlAiResult {
    Ok(ResolvedSourceControlAiOperation),
    Err(String),
}

/// A saved `defaultTuiAgent` preference, owned (the borrowing form lives in
/// `orca_agents`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum DefaultTuiAgentPreference {
    /// The setting was never written.
    #[default]
    Undefined,
    /// The explicit "auto" choice.
    Null,
    /// A built-in agent id, or `"blank"`.
    Builtin(String),
    /// `{ kind: 'custom', id }`.
    Custom { id: Option<String> },
}

/// The two `CustomAgentProfile` fields the default-agent collapse reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CustomAgentProfile {
    pub id: Option<String>,
    pub base_agent: Option<String>,
}

/// The slice of `GlobalSettings` the resolvers actually read.
#[derive(Clone, Debug, Default)]
pub struct GlobalSettingsSlice {
    pub default_tui_agent: DefaultTuiAgentPreference,
    pub custom_agents: Vec<CustomAgentProfile>,
    pub agent_cmd_overrides: BTreeMap<String, String>,
    pub commit_message_ai: Option<CommitMessageAiSettings>,
    pub source_control_ai: Option<SourceControlAiSettings>,
    pub disabled_tui_agents: Vec<String>,
}

impl GlobalSettingsSlice {
    /// `collapseDefaultTuiAgentToBuiltin(settings.defaultTuiAgent, settings.customAgents)`.
    fn collapsed_default_tui_agent(&self) -> Option<&str> {
        let pref = match &self.default_tui_agent {
            DefaultTuiAgentPreference::Undefined => DefaultTuiAgentPref::Undefined,
            DefaultTuiAgentPreference::Null => DefaultTuiAgentPref::Null,
            DefaultTuiAgentPreference::Builtin(agent) => DefaultTuiAgentPref::Builtin(agent),
            DefaultTuiAgentPreference::Custom { id } => {
                DefaultTuiAgentPref::Custom { id: id.as_deref() }
            }
        };
        let roster: Vec<CustomAgentProfileRef<'_>> = self
            .custom_agents
            .iter()
            .map(|profile| CustomAgentProfileRef {
                id: profile.id.as_deref(),
                base_agent: profile.base_agent.as_deref(),
            })
            .collect();
        match collapse_default_tui_agent_to_builtin(pref, &roster) {
            CollapsedDefaultTuiAgent::Builtin(agent) => Some(agent),
            CollapsedDefaultTuiAgent::Null | CollapsedDefaultTuiAgent::Undefined => None,
        }
    }

    fn disabled(&self) -> Vec<&str> {
        self.disabled_tui_agents.iter().map(String::as_str).collect()
    }
}

pub struct ResolveSourceControlAiInput<'a> {
    pub settings: &'a GlobalSettingsSlice,
    /// `repo?.sourceControlAi` as raw JSON (normalized defensively); `None` when
    /// no repo override is present.
    pub repo_source_control_ai: Option<&'a Value>,
    pub operation: SourceControlAiOperation,
    pub discovery_host_key: Option<&'a str>,
    pub pr_creation_product_defaults: Option<&'a SourceControlAiPrCreationDefaults>,
}

fn supported_source_control_ai_agent_summary() -> String {
    let labels: Vec<String> = list_commit_message_agent_capabilities()
        .into_iter()
        .map(|capability| capability.label)
        .collect();
    format!("Supported agents: {}, or Custom command.", labels.join(", "))
}

fn read_default_selected_model_id(
    source: &SourceControlAiSettings,
    host_key: &str,
    agent_id: &str,
) -> Option<String> {
    let choice = SourceControlAiModelChoice {
        selected_model_by_agent: Some(source.selected_model_by_agent.clone()),
        selected_model_by_agent_by_host: source.selected_model_by_agent_by_host.clone(),
        selected_thinking_by_model: None,
    };
    read_source_control_ai_model_choice_for_host(Some(&choice), host_key, agent_id)
}

fn get_discovered_models(
    source: &SourceControlAiSettings,
    legacy: Option<&CommitMessageAiSettings>,
    host_key: &str,
    agent_id: &str,
) -> Vec<CommitMessageAiModelCapability> {
    if let Some(models) = source
        .discovered_models_by_agent_by_host
        .as_ref()
        .and_then(|by_host| by_host.get(host_key))
        .and_then(|by_agent| by_agent.get(agent_id))
    {
        return models.clone();
    }
    if host_key == LOCAL_COMMIT_MESSAGE_HOST_KEY {
        if let Some(models) = source
            .discovered_models_by_agent
            .as_ref()
            .and_then(|by_agent| by_agent.get(agent_id))
        {
            return models.clone();
        }
        if let Some(legacy) = legacy {
            if let Some(models) = legacy
                .discovered_models_by_agent_by_host
                .as_ref()
                .and_then(|by_host| by_host.get(host_key))
                .and_then(|by_agent| by_agent.get(agent_id))
            {
                return models.clone();
            }
            if let Some(models) = legacy
                .discovered_models_by_agent
                .as_ref()
                .and_then(|by_agent| by_agent.get(agent_id))
            {
                return models.clone();
            }
        }
        Vec::new()
    } else {
        legacy
            .and_then(|legacy| legacy.discovered_models_by_agent_by_host.as_ref())
            .and_then(|by_host| by_host.get(host_key))
            .and_then(|by_agent| by_agent.get(agent_id))
            .cloned()
            .unwrap_or_default()
    }
}

#[allow(clippy::too_many_arguments)]
fn select_persisted_model_id(
    source: &SourceControlAiSettings,
    legacy: Option<&CommitMessageAiSettings>,
    repo_overrides: Option<&RepoSourceControlAiOverrides>,
    operation: SourceControlAiOperation,
    host_key: &str,
    agent_id: &str,
    default_model_id: &str,
) -> String {
    let repo_choice = repo_overrides
        .and_then(|overrides| overrides.model_overrides_by_operation.as_ref())
        .and_then(|by_op| by_op.get(&operation));
    let source_choice = source
        .model_overrides_by_operation
        .as_ref()
        .and_then(|by_op| by_op.get(&operation));
    read_source_control_ai_model_choice_for_host(repo_choice, host_key, agent_id)
        .or_else(|| read_source_control_ai_model_choice_for_host(source_choice, host_key, agent_id))
        .or_else(|| read_default_selected_model_id(source, host_key, agent_id))
        .or_else(|| {
            legacy
                .and_then(|legacy| legacy.selected_model_by_agent_by_host.as_ref())
                .and_then(|by_host| by_host.get(host_key))
                .and_then(|by_agent| by_agent.get(agent_id))
                .cloned()
        })
        .or_else(|| {
            if host_key == LOCAL_COMMIT_MESSAGE_HOST_KEY {
                legacy
                    .and_then(|legacy| legacy.selected_model_by_agent.get(agent_id))
                    .cloned()
            } else {
                None
            }
        })
        .unwrap_or_else(|| default_model_id.to_string())
}

fn resolve_thinking_level(
    model: &CommitMessageAiModelCapability,
    source: &SourceControlAiSettings,
    legacy: Option<&CommitMessageAiSettings>,
    repo_overrides: Option<&RepoSourceControlAiOverrides>,
    operation: SourceControlAiOperation,
) -> Option<String> {
    let levels = model.thinking_levels.as_ref().filter(|levels| !levels.is_empty())?;
    let persisted = repo_overrides
        .and_then(|overrides| overrides.model_overrides_by_operation.as_ref())
        .and_then(|by_op| by_op.get(&operation))
        .and_then(|choice| choice.selected_thinking_by_model.as_ref())
        .and_then(|by_model| by_model.get(&model.id))
        .or_else(|| {
            source
                .model_overrides_by_operation
                .as_ref()
                .and_then(|by_op| by_op.get(&operation))
                .and_then(|choice| choice.selected_thinking_by_model.as_ref())
                .and_then(|by_model| by_model.get(&model.id))
        })
        .or_else(|| source.selected_thinking_by_model.get(&model.id))
        .or_else(|| legacy.and_then(|legacy| legacy.selected_thinking_by_model.get(&model.id)));
    if levels.iter().any(|level| Some(&level.id) == persisted) {
        persisted.cloned()
    } else {
        model.default_thinking_level.clone()
    }
}

/// `readRepoInstructionOverride`: present-and-string is the override;
/// present-and-null or absent inherits.
fn read_repo_instruction_override(
    overrides: Option<&RepoSourceControlAiOverrides>,
    operation: SourceControlAiOperation,
) -> Option<String> {
    let instructions = overrides?.instructions_by_operation.as_ref()?;
    match instructions.get(&operation) {
        Some(Some(instruction)) => Some(instruction.clone()),
        _ => None,
    }
}

/// `resolveInstructionsFromNormalized`: callers that already normalized settings
/// and repo overrides reuse this instead of re-normalizing per lookup.
fn resolve_instructions_from_normalized(
    source: &SourceControlAiSettings,
    repo_overrides: Option<&RepoSourceControlAiOverrides>,
    operation: SourceControlAiOperation,
    legacy_custom_prompt: Option<&str>,
) -> String {
    if let Some(instruction) = read_repo_instruction_override(repo_overrides, operation) {
        return trim_js(&instruction).to_string();
    }
    if let Some(global) = source.instructions_by_operation.get(&operation) {
        return trim_js(global).to_string();
    }
    if operation == SourceControlAiOperation::CommitMessage {
        return trim_js(legacy_custom_prompt.unwrap_or_default()).to_string();
    }
    String::new()
}

// The answer is always JS-trimmed. `str::trim` would be the wrong postcondition:
// it strips U+0085, which `trim_js` (and the twin) deliberately keep.
#[cfg_attr(trust_verify, trust::ensures(|out: &String| trim_js(out).len() == out.len()))]
pub fn resolve_source_control_ai_instructions(
    settings: &GlobalSettingsSlice,
    repo_source_control_ai: Option<&Value>,
    operation: SourceControlAiOperation,
) -> String {
    let source = normalize_source_control_ai_settings(
        settings.source_control_ai.as_ref(),
        settings.commit_message_ai.as_ref(),
    );
    let repo_overrides =
        normalize_repo_source_control_ai_overrides(repo_source_control_ai.unwrap_or(&NULL));
    resolve_instructions_from_normalized(
        &source,
        repo_overrides.as_ref(),
        operation,
        settings
            .commit_message_ai
            .as_ref()
            .and_then(|legacy| legacy.custom_prompt.as_deref()),
    )
}

pub fn has_configured_source_control_ai_instructions(
    settings: &GlobalSettingsSlice,
    repo_source_control_ai: Option<&Value>,
    operation: SourceControlAiOperation,
) -> bool {
    let repo_overrides =
        normalize_repo_source_control_ai_overrides(repo_source_control_ai.unwrap_or(&NULL));
    if read_repo_instruction_override(repo_overrides.as_ref(), operation).is_some() {
        return true;
    }
    !resolve_source_control_ai_instructions(settings, repo_source_control_ai, operation).is_empty()
}

fn resolve_pr_creation_defaults(
    source: &SourceControlAiSettings,
    repo_overrides: Option<&RepoSourceControlAiOverrides>,
    product_defaults: Option<&SourceControlAiPrCreationDefaults>,
) -> ResolvedPrCreationDefaults {
    let mut base = DEFAULT_PR_CREATION_DEFAULTS;
    if let Some(product) = product_defaults {
        overlay_pr_defaults(&mut base, product);
    }
    if let Some(source_defaults) = source.pr_creation_defaults.as_ref() {
        overlay_pr_defaults(&mut base, source_defaults);
    }
    let repo_defaults =
        match repo_overrides.and_then(|overrides| overrides.pr_creation_defaults.as_ref()) {
            Some(repo_defaults) => repo_defaults,
            None => return base,
        };
    ResolvedPrCreationDefaults {
        draft: flatten_repo_default(repo_defaults.draft, base.draft),
        use_template: flatten_repo_default(repo_defaults.use_template, base.use_template),
        generate_details_on_open: flatten_repo_default(
            repo_defaults.generate_details_on_open,
            base.generate_details_on_open,
        ),
        open_after_create: flatten_repo_default(
            repo_defaults.open_after_create,
            base.open_after_create,
        ),
    }
}

fn overlay_pr_defaults(
    base: &mut ResolvedPrCreationDefaults,
    overlay: &SourceControlAiPrCreationDefaults,
) {
    if let Some(draft) = overlay.draft {
        base.draft = draft;
    }
    if let Some(use_template) = overlay.use_template {
        base.use_template = use_template;
    }
    if let Some(generate_details_on_open) = overlay.generate_details_on_open {
        base.generate_details_on_open = generate_details_on_open;
    }
    if let Some(open_after_create) = overlay.open_after_create {
        base.open_after_create = open_after_create;
    }
}

fn flatten_repo_default(field: Option<Option<bool>>, base: bool) -> bool {
    match field {
        Some(Some(value)) => value,
        _ => base,
    }
}

pub fn resolve_source_control_ai_pr_creation_defaults(
    settings: &GlobalSettingsSlice,
    repo_source_control_ai: Option<&Value>,
    product_defaults: Option<&SourceControlAiPrCreationDefaults>,
) -> ResolvedPrCreationDefaults {
    let source = normalize_source_control_ai_settings(
        settings.source_control_ai.as_ref(),
        settings.commit_message_ai.as_ref(),
    );
    let repo_overrides =
        normalize_repo_source_control_ai_overrides(repo_source_control_ai.unwrap_or(&NULL));
    resolve_pr_creation_defaults(&source, repo_overrides.as_ref(), product_defaults)
}

/// `resolveSourceControlAiEnabled`: the repo switch wins over the global one.
pub fn resolve_source_control_ai_enabled(
    settings: Option<&GlobalSettingsSlice>,
    repo_source_control_ai: Option<&Value>,
) -> bool {
    let empty = GlobalSettingsSlice::default();
    let settings = settings.unwrap_or(&empty);
    let source = normalize_source_control_ai_settings(
        settings.source_control_ai.as_ref(),
        settings.commit_message_ai.as_ref(),
    );
    let repo_overrides =
        normalize_repo_source_control_ai_overrides(repo_source_control_ai.unwrap_or(&NULL));
    repo_overrides
        .and_then(|overrides| overrides.enabled)
        .or(source.enabled)
        .unwrap_or_default()
}

/// `resolveSourceControlActionRecipe`: the global recipe with the repo override
/// applied, for ANY action id (the launch actions included).
pub fn resolve_source_control_action_recipe(
    settings: Option<&GlobalSettingsSlice>,
    repo_source_control_ai: Option<&Value>,
    action_id: SourceControlActionId,
) -> SourceControlActionRecipe {
    let empty = GlobalSettingsSlice::default();
    let settings = settings.unwrap_or(&empty);
    let source = normalize_source_control_ai_settings(
        settings.source_control_ai.as_ref(),
        settings.commit_message_ai.as_ref(),
    );
    let mut recipe = read_source_control_action_default(source.actions.as_ref(), action_id);
    recipe.command_input_template = Some(resolve_source_control_action_command_template(
        source.actions.as_ref(),
        action_id,
    ));
    let repo_overrides =
        normalize_repo_source_control_ai_overrides(repo_source_control_ai.unwrap_or(&NULL));
    let repo_recipe = repo_overrides
        .as_ref()
        .and_then(|overrides| overrides.action_overrides.as_ref())
        .and_then(|by_action| by_action.get(&action_id));
    let repo_recipe = match repo_recipe {
        Some(repo_recipe) => repo_recipe,
        None => return recipe,
    };
    if repo_recipe.agent_id.is_some() {
        recipe.agent_id = repo_recipe.agent_id.clone();
    }
    if let Some(Some(template)) = repo_recipe.command_input_template.as_ref() {
        recipe.command_input_template = Some(trim_js(template).to_string());
    }
    match repo_recipe.agent_args.as_ref() {
        Some(Some(args)) => recipe.agent_args = Some(trim_js(args).to_string()),
        Some(None) => recipe.agent_args = Some(String::new()),
        None => {}
    }
    recipe
}

/// `resolveActionRecipeForTextOperation`: the recipe one generation operation
/// runs with. `commandInputTemplate` is always present.
fn resolve_action_recipe_for_text_operation(
    source: &SourceControlAiSettings,
    repo_overrides: Option<&RepoSourceControlAiOverrides>,
    operation: SourceControlAiOperation,
) -> SourceControlActionRecipe {
    let action_id = operation.action_id();
    let global_recipe = read_source_control_action_default(source.actions.as_ref(), action_id);
    let repo_recipe = repo_overrides
        .and_then(|overrides| overrides.action_overrides.as_ref())
        .and_then(|by_action| by_action.get(&action_id));
    let repo_instruction = read_repo_instruction_override(repo_overrides, operation);
    let fallback_template = match repo_instruction.as_deref() {
        Some(instruction) => {
            command_template_from_operation_instruction(operation, Some(instruction))
        }
        None => resolve_source_control_action_command_template(source.actions.as_ref(), action_id),
    };
    let repo_template = repo_recipe
        .and_then(|recipe| recipe.command_input_template.as_ref())
        .and_then(|template| template.as_deref())
        .map(|template| trim_js(template).to_string());
    let repo_agent_args = match repo_recipe.and_then(|recipe| recipe.agent_args.as_ref()) {
        Some(Some(args)) => Some(trim_js(args).to_string()),
        Some(None) => Some(String::new()),
        None => None,
    };
    SourceControlActionRecipe {
        agent_id: repo_recipe
            .and_then(|recipe| recipe.agent_id.clone())
            .or_else(|| global_recipe.agent_id.clone()),
        agent_args: repo_agent_args.or_else(|| global_recipe.agent_args.clone()),
        command_input_template: Some(
            repo_template
                .or_else(|| global_recipe.command_input_template.clone())
                .unwrap_or(fallback_template),
        ),
    }
}

pub fn resolve_source_control_ai_for_operation(
    input: &ResolveSourceControlAiInput,
) -> ResolveSourceControlAiResult {
    let legacy = input.settings.commit_message_ai.as_ref();
    let source =
        normalize_source_control_ai_settings(input.settings.source_control_ai.as_ref(), legacy);
    let repo_overrides = normalize_repo_source_control_ai_overrides(
        input.repo_source_control_ai.unwrap_or(&NULL),
    );

    let pr_creation_defaults = resolve_pr_creation_defaults(
        &source,
        repo_overrides.as_ref(),
        input.pr_creation_product_defaults,
    );
    let action_recipe =
        resolve_action_recipe_for_text_operation(&source, repo_overrides.as_ref(), input.operation);
    let command_input_template = action_recipe.command_input_template.clone().unwrap_or_default();
    if trim_js(&command_input_template).is_empty() {
        return ResolveSourceControlAiResult::Err(format!(
            "Command template is empty for {}.",
            input.operation.label()
        ));
    }
    // Why: action recipes own the new customization model. The legacy global
    // agent remains a fallback so existing users migrate without losing intent.
    let preferred_agent = match action_recipe.agent_id.clone() {
        Some(agent_id) => agent_id,
        None => source.agent_id.clone().flatten(),
    };
    let collapsed_default = input.settings.collapsed_default_tui_agent();
    let disabled = input.settings.disabled();
    let agent_choice = match resolve_commit_message_agent_choice(
        preferred_agent.as_deref(),
        collapsed_default,
        &disabled,
    ) {
        Some(agent_choice) => agent_choice,
        None => {
            return ResolveSourceControlAiResult::Err(format!(
                "Choose a supported Source Control AI agent for this action in Settings -> Git -> Source Control AI. {}",
                supported_source_control_ai_agent_summary()
            ));
        }
    };

    let repo_custom_command = repo_overrides
        .as_ref()
        .and_then(|overrides| overrides.custom_agent_command.as_deref())
        .map(trim_js)
        .filter(|command| !command.is_empty());
    let source_custom_command = source.custom_agent_command.as_deref().unwrap_or_default();
    let custom_agent_command = repo_custom_command.unwrap_or(trim_js(source_custom_command));

    if is_custom_agent_id(Some(agent_choice.as_str())) {
        if custom_agent_command.is_empty() {
            return ResolveSourceControlAiResult::Err(
                "Custom command is empty. Add one in Settings -> Git -> Source Control AI."
                    .to_string(),
            );
        }
        return ResolveSourceControlAiResult::Ok(ResolvedSourceControlAiOperation {
            enabled: true,
            params: ResolvedSourceControlAiGenerationParams {
                agent_id: CUSTOM_AGENT_ID.to_string(),
                model: String::new(),
                thinking_level: None,
                custom_prompt: Some(resolve_instructions_from_normalized(
                    &source,
                    repo_overrides.as_ref(),
                    input.operation,
                    legacy.and_then(|legacy| legacy.custom_prompt.as_deref()),
                )),
                command_input_template: Some(command_input_template),
                agent_args: action_recipe.agent_args.clone(),
                custom_agent_command: Some(custom_agent_command.to_string()),
                agent_command_override: None,
            },
            pr_creation_defaults,
        });
    }

    // `actionRecipe.agentId ?? agentId`: an explicit repo/global null falls back
    // to the resolved choice, and only a DIFFERENT id is re-resolved.
    let action_agent_id = action_recipe
        .agent_id
        .clone()
        .flatten()
        .unwrap_or_else(|| agent_choice.clone());
    let resolved_action_agent_id = if action_agent_id == agent_choice {
        Some(agent_choice.clone())
    } else {
        resolve_commit_message_agent_choice(
            Some(action_agent_id.as_str()),
            collapsed_default,
            &disabled,
        )
    };
    let resolved_action_agent_id = match resolved_action_agent_id {
        Some(agent_id) if !is_custom_agent_id(Some(agent_id.as_str())) => agent_id,
        _ => {
            return ResolveSourceControlAiResult::Err(format!(
                "Choose a supported Source Control AI agent for this action. {}",
                supported_source_control_ai_agent_summary()
            ));
        }
    };
    let spec = match get_commit_message_agent_spec(&resolved_action_agent_id) {
        Some(spec) => spec,
        None => {
            return ResolveSourceControlAiResult::Err(format!(
                "Agent \"{}\" does not support Source Control AI {}. {}",
                resolved_action_agent_id,
                input.operation.label(),
                supported_source_control_ai_agent_summary()
            ));
        }
    };

    let host_key = input.discovery_host_key.unwrap_or(LOCAL_COMMIT_MESSAGE_HOST_KEY);
    let persisted_model_id = select_persisted_model_id(
        &source,
        legacy,
        repo_overrides.as_ref(),
        input.operation,
        host_key,
        &resolved_action_agent_id,
        spec.default_model_id,
    );
    let discovered_models =
        get_discovered_models(&source, legacy, host_key, &resolved_action_agent_id);
    let model = spec
        .models
        .iter()
        .find(|candidate| candidate.id == persisted_model_id)
        .cloned()
        .or_else(|| {
            discovered_models
                .iter()
                .find(|candidate| candidate.id == persisted_model_id)
                .cloned()
        })
        .or_else(|| get_commit_message_model(&resolved_action_agent_id, spec.default_model_id));
    let model = match model {
        Some(model) => model,
        None => {
            return ResolveSourceControlAiResult::Err(format!(
                "No model is available for {}.",
                spec.label
            ));
        }
    };

    let thinking_level = resolve_thinking_level(
        &model,
        &source,
        legacy,
        repo_overrides.as_ref(),
        input.operation,
    );
    let agent_command_override = input
        .settings
        .agent_cmd_overrides
        .get(&resolved_action_agent_id)
        .map(|command| trim_js(command).to_string())
        .filter(|command| !command.is_empty());

    ResolveSourceControlAiResult::Ok(ResolvedSourceControlAiOperation {
        enabled: true,
        params: ResolvedSourceControlAiGenerationParams {
            agent_id: resolved_action_agent_id,
            model: model.id.clone(),
            thinking_level,
            custom_prompt: Some(resolve_instructions_from_normalized(
                &source,
                repo_overrides.as_ref(),
                input.operation,
                legacy.and_then(|legacy| legacy.custom_prompt.as_deref()),
            )),
            command_input_template: Some(command_input_template),
            agent_args: action_recipe.agent_args.clone(),
            custom_agent_command: (!custom_agent_command.is_empty())
                .then(|| custom_agent_command.to_string()),
            agent_command_override,
        },
        pr_creation_defaults,
    })
}

#[cfg(test)]
mod tests;
