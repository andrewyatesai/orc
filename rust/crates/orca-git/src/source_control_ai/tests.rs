//! The twin's own unit suite (`src/shared/source-control-ai.test.ts`,
//! `describe('source-control AI resolution')`), translated case for case, plus
//! the boundary cases the JSON vector corpus cannot carry (a TS `undefined`
//! answer has no JSON image, and the parity comparator never equates it with
//! `null`).

use super::SourceControlAiOperation::{BranchName, CommitMessage, PullRequest};
use super::*;
use serde_json::json;

fn smap(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn host_map(pairs: &[(&str, &[(&str, &str)])]) -> BTreeMap<String, BTreeMap<String, String>> {
    pairs
        .iter()
        .map(|(host, models)| (host.to_string(), smap(models)))
        .collect()
}

fn instr(pairs: &[(SourceControlAiOperation, &str)]) -> BTreeMap<SourceControlAiOperation, String> {
    pairs
        .iter()
        .map(|(operation, value)| (*operation, value.to_string()))
        .collect()
}

/// `getDefaultSettings('/tmp').commitMessageAi`.
fn default_commit_message_ai() -> CommitMessageAiSettings {
    CommitMessageAiSettings {
        enabled: Some(true),
        agent_id: Some(None),
        selected_model_by_agent: BTreeMap::new(),
        selected_model_by_agent_by_host: Some(BTreeMap::new()),
        discovered_models_by_agent: Some(BTreeMap::new()),
        discovered_models_by_agent_by_host: Some(BTreeMap::new()),
        selected_thinking_by_model: BTreeMap::new(),
        custom_prompt: Some(String::new()),
        custom_agent_command: Some(String::new()),
    }
}

/// The twin test's `settings()` helper.
fn settings() -> GlobalSettingsSlice {
    let mut source = get_default_source_control_ai_settings();
    source.enabled = Some(true);
    source.agent_id = Some(Some("codex".to_string()));
    source.selected_model_by_agent = smap(&[("codex", "gpt-5.5")]);
    source.selected_thinking_by_model = smap(&[("gpt-5.5", "medium"), ("gpt-5.4", "high")]);
    source.instructions_by_operation = instr(&[
        (CommitMessage, "Global commit style"),
        (PullRequest, "Global PR style"),
        (BranchName, "Global branch style"),
    ]);
    GlobalSettingsSlice {
        default_tui_agent: DefaultTuiAgentPreference::Builtin("codex".to_string()),
        custom_agents: Vec::new(),
        agent_cmd_overrides: BTreeMap::new(),
        commit_message_ai: Some(default_commit_message_ai()),
        source_control_ai: Some(source),
        disabled_tui_agents: Vec::new(),
    }
}

const PRODUCT_DEFAULTS: SourceControlAiPrCreationDefaults = SourceControlAiPrCreationDefaults {
    draft: Some(false),
    use_template: Some(false),
    generate_details_on_open: Some(false),
    open_after_create: Some(false),
};

/// The twin test's `resolve()` helper: asserts `ok` and returns the value.
fn resolve(
    operation: SourceControlAiOperation,
    overrides: Option<&Value>,
) -> ResolvedSourceControlAiOperation {
    let settings = settings();
    let input = ResolveSourceControlAiInput {
        settings: &settings,
        repo_source_control_ai: overrides,
        operation,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: Some(&PRODUCT_DEFAULTS),
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => value,
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn uses_the_global_default_model_for_every_operation() {
    assert_eq!(resolve(CommitMessage, None).params.model, "gpt-5.5");
    assert_eq!(resolve(PullRequest, None).params.model, "gpt-5.5");
    assert_eq!(resolve(BranchName, None).params.model, "gpt-5.5");
}

#[test]
fn resolves_generation_config_and_pr_defaults_when_actions_are_hidden() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.enabled = Some(false);
    source.pr_creation_defaults = Some(SourceControlAiPrCreationDefaults {
        draft: Some(true),
        use_template: Some(true),
        generate_details_on_open: Some(false),
        open_after_create: Some(false),
    });
    base.source_control_ai = Some(source);

    // Hiding the actions does NOT invalidate generation: `enabled` is resolved
    // separately, and the twin still answers a full generation config.
    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: PullRequest,
        discovery_host_key: None,
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(value.params.model, "gpt-5.5"),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }

    let repo = json!({
        "prCreationDefaults": { "draft": null, "generateDetailsOnOpen": true, "openAfterCreate": true }
    });
    assert_eq!(
        resolve_source_control_ai_pr_creation_defaults(&base, Some(&repo), Some(&PRODUCT_DEFAULTS)),
        ResolvedPrCreationDefaults {
            draft: true,
            use_template: true,
            generate_details_on_open: true,
            open_after_create: true,
        }
    );
}

#[test]
fn lets_repo_hidden_actions_keep_operation_generation_valid() {
    let settings = settings();
    let repo = json!({ "enabled": false });
    let input = ResolveSourceControlAiInput {
        settings: &settings,
        repo_source_control_ai: Some(&repo),
        operation: BranchName,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(value.params.model, "gpt-5.5"),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn lets_repo_action_visibility_override_the_global_default() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.enabled = Some(false);
    base.source_control_ai = Some(source);

    assert!(!resolve_source_control_ai_enabled(Some(&base), None));
    assert!(resolve_source_control_ai_enabled(
        Some(&base),
        Some(&json!({ "enabled": true }))
    ));

    let mut source = base.source_control_ai.clone().expect("source");
    source.enabled = Some(true);
    base.source_control_ai = Some(source);
    assert!(!resolve_source_control_ai_enabled(
        Some(&base),
        Some(&json!({ "enabled": false }))
    ));
}

#[test]
fn resolves_pr_defaults_even_when_generation_config_is_invalid() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.agent_id = Some(Some(CUSTOM_AGENT_ID.to_string()));
    source.custom_agent_command = Some(String::new());
    source.pr_creation_defaults = Some(SourceControlAiPrCreationDefaults {
        draft: Some(false),
        use_template: Some(true),
        generate_details_on_open: Some(true),
        open_after_create: Some(false),
    });
    base.source_control_ai = Some(source);

    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: PullRequest,
        discovery_host_key: None,
        pr_creation_product_defaults: None,
    };
    assert!(matches!(
        resolve_source_control_ai_for_operation(&input),
        ResolveSourceControlAiResult::Err(_)
    ));
    assert_eq!(
        resolve_source_control_ai_pr_creation_defaults(
            &base,
            Some(&json!({ "prCreationDefaults": { "draft": true } })),
            None
        ),
        ResolvedPrCreationDefaults {
            draft: true,
            use_template: true,
            generate_details_on_open: true,
            open_after_create: false,
        }
    );
}

#[test]
fn treats_a_normalized_null_agent_as_default_instead_of_a_stale_legacy_agent() {
    let mut base = settings();
    base.default_tui_agent = DefaultTuiAgentPreference::Builtin("codex".to_string());
    let mut legacy = default_commit_message_ai();
    legacy.agent_id = Some(Some("claude".to_string()));
    legacy.selected_model_by_agent = smap(&[("claude", "opus")]);
    legacy.selected_thinking_by_model = smap(&[("opus", "max")]);
    base.commit_message_ai = Some(legacy);
    let mut source = base.source_control_ai.clone().expect("source");
    source.agent_id = Some(None);
    source.selected_model_by_agent = smap(&[("codex", "gpt-5.4")]);
    base.source_control_ai = Some(source);

    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => {
            assert_eq!(value.params.agent_id, "codex");
            assert_eq!(value.params.model, "gpt-5.4");
        }
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn lets_a_global_operation_model_override_win_over_the_global_default() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.model_overrides_by_operation = Some(BTreeMap::from([(
        PullRequest,
        SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
            ..SourceControlAiModelChoice::default()
        },
    )]));
    base.source_control_ai = Some(source);

    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: PullRequest,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(value.params.model, "gpt-5.4"),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn lets_a_repo_operation_model_override_win_over_the_global_operation_override() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.model_overrides_by_operation = Some(BTreeMap::from([(
        CommitMessage,
        SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
            ..SourceControlAiModelChoice::default()
        },
    )]));
    base.source_control_ai = Some(source);

    let repo = json!({
        "modelOverridesByOperation": {
            "commitMessage": { "selectedModelByAgent": { "codex": "gpt-5.4-mini" } }
        }
    });
    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: Some(&repo),
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(value.params.model, "gpt-5.4-mini"),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn uses_the_repo_custom_command_before_the_global_custom_command() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    let mut actions = source.actions.clone().unwrap_or_default();
    actions.insert(
        SourceControlActionId::CommitMessage,
        SourceControlActionRecipe {
            agent_id: Some(Some(CUSTOM_AGENT_ID.to_string())),
            command_input_template: Some(DEFAULT_ACTION_COMMAND_TEMPLATE.to_string()),
            agent_args: None,
        },
    );
    source.actions = Some(actions);
    source.custom_agent_command = Some("global-agent {prompt}".to_string());
    base.source_control_ai = Some(source);

    let repo = json!({ "customAgentCommand": "repo-agent {prompt}" });
    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: Some(&repo),
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(
            value.params.custom_agent_command.as_deref(),
            Some("repo-agent {prompt}")
        ),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn resolves_thinking_effort_with_override_precedence_and_model_default_fallback() {
    assert_eq!(
        resolve(CommitMessage, None).params.thinking_level.as_deref(),
        Some("medium")
    );
    let repo = json!({
        "modelOverridesByOperation": {
            "commitMessage": {
                "selectedModelByAgent": { "codex": "gpt-5.4" },
                "selectedThinkingByModel": { "gpt-5.4": "xhigh" }
            }
        }
    });
    assert_eq!(
        resolve(CommitMessage, Some(&repo)).params.thinking_level.as_deref(),
        Some("xhigh")
    );

    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.selected_thinking_by_model = smap(&[("gpt-5.5", "unsupported")]);
    base.source_control_ai = Some(source);
    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => {
            assert_eq!(value.params.thinking_level.as_deref(), Some("low"));
        }
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn resolves_repo_instructions_as_replacement_overrides_including_explicit_empty() {
    let prompt = |value: &ResolvedSourceControlAiOperation| {
        value.params.custom_prompt.clone().unwrap_or_default()
    };
    assert_eq!(prompt(&resolve(CommitMessage, None)), "Global commit style");
    assert_eq!(
        prompt(&resolve(
            CommitMessage,
            Some(&json!({ "instructionsByOperation": { "commitMessage": null } }))
        )),
        "Global commit style"
    );
    assert_eq!(
        prompt(&resolve(
            CommitMessage,
            Some(&json!({ "instructionsByOperation": { "commitMessage": "" } }))
        )),
        ""
    );
    assert_eq!(
        prompt(&resolve(
            CommitMessage,
            Some(&json!({ "instructionsByOperation": { "commitMessage": "Repo commit style" } }))
        )),
        "Repo commit style"
    );
    assert_eq!(prompt(&resolve(BranchName, None)), "Global branch style");
    assert_eq!(
        resolve(BranchName, None).params.command_input_template.as_deref(),
        Some("Global branch style\n\n{basePrompt}")
    );
    let repo = json!({ "instructionsByOperation": { "branchName": "Repo branch style" } });
    assert_eq!(prompt(&resolve(BranchName, Some(&repo))), "Repo branch style");
    assert_eq!(
        resolve(BranchName, Some(&repo)).params.command_input_template.as_deref(),
        Some("Repo branch style\n\n{basePrompt}")
    );
}

#[test]
fn does_not_treat_null_repo_instructions_as_configured_overrides() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.instructions_by_operation = instr(&[
        (CommitMessage, ""),
        (PullRequest, ""),
        (BranchName, ""),
    ]);
    base.source_control_ai = Some(source);

    assert!(!has_configured_source_control_ai_instructions(
        &base,
        Some(&json!({ "instructionsByOperation": { "commitMessage": null } })),
        CommitMessage
    ));
    assert!(has_configured_source_control_ai_instructions(
        &base,
        Some(&json!({ "instructionsByOperation": { "commitMessage": "" } })),
        CommitMessage
    ));
}

#[test]
fn resolves_repo_tri_state_pr_defaults_through_inherit_on_and_off() {
    assert!(!resolve(PullRequest, None).pr_creation_defaults.draft);
    let repo = json!({ "prCreationDefaults": { "draft": true, "openAfterCreate": false } });
    let defaults = resolve(PullRequest, Some(&repo)).pr_creation_defaults;
    assert!(defaults.draft);
    assert!(!defaults.open_after_create);
}

#[test]
fn maps_legacy_custom_prompt_to_released_split_instructions() {
    let migrated = source_control_ai_settings_from_legacy(Some(&CommitMessageAiSettings {
        enabled: Some(true),
        agent_id: Some(Some("codex".to_string())),
        selected_model_by_agent: smap(&[("codex", "gpt-5.5")]),
        selected_model_by_agent_by_host: None,
        discovered_models_by_agent: None,
        discovered_models_by_agent_by_host: None,
        selected_thinking_by_model: BTreeMap::new(),
        custom_prompt: Some("Legacy commit prompt".to_string()),
        custom_agent_command: Some(String::new()),
    }));
    assert_eq!(
        migrated.instructions_by_operation.get(&CommitMessage).map(String::as_str),
        Some("Legacy commit prompt")
    );
    assert_eq!(
        migrated.instructions_by_operation.get(&PullRequest).map(String::as_str),
        Some("")
    );
    assert_eq!(
        migrated.instructions_by_operation.get(&BranchName).map(String::as_str),
        Some("Legacy commit prompt")
    );
    let actions = migrated.actions.expect("actions");
    assert_eq!(
        actions
            .get(&SourceControlActionId::CommitMessage)
            .and_then(|recipe| recipe.command_input_template.as_deref()),
        Some("{basePrompt}\n\nLegacy commit prompt")
    );
    assert_eq!(
        actions
            .get(&SourceControlActionId::BranchName)
            .and_then(|recipe| recipe.command_input_template.as_deref()),
        Some("Legacy commit prompt\n\n{basePrompt}")
    );
}

#[test]
fn merges_legacy_commit_message_updates_without_wiping_pr_only_settings() {
    let base = settings().source_control_ai.expect("source");
    let merged = merge_legacy_commit_message_ai_into_source_control_ai(
        Some(&base),
        Some(&CommitMessageAiSettings {
            enabled: Some(false),
            agent_id: Some(Some("claude".to_string())),
            selected_model_by_agent: smap(&[("claude", "sonnet")]),
            selected_model_by_agent_by_host: None,
            discovered_models_by_agent: None,
            discovered_models_by_agent_by_host: None,
            selected_thinking_by_model: smap(&[("sonnet", "medium")]),
            custom_prompt: Some("Legacy commit prompt".to_string()),
            custom_agent_command: Some("claude".to_string()),
        }),
        &MergeLegacyOptions {
            pull_request_instructions_from_legacy: false,
        },
    );

    assert_eq!(merged.enabled, Some(false));
    assert_eq!(merged.agent_id, Some(Some("claude".to_string())));
    assert_eq!(merged.selected_model_by_agent, smap(&[("codex", "gpt-5.5")]));
    assert_eq!(
        merged.selected_thinking_by_model,
        smap(&[("gpt-5.5", "medium"), ("gpt-5.4", "high")])
    );
    assert_eq!(merged.custom_agent_command.as_deref(), Some("claude"));
    assert_eq!(
        merged.instructions_by_operation,
        instr(&[
            (CommitMessage, "Legacy commit prompt"),
            (PullRequest, "Global PR style"),
            (BranchName, "Global branch style"),
        ])
    );
    assert_eq!(
        merged
            .model_overrides_by_operation
            .as_ref()
            .and_then(|overrides| overrides.get(&CommitMessage)),
        Some(&SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("claude", "sonnet")])),
            selected_model_by_agent_by_host: None,
            selected_thinking_by_model: Some(smap(&[("sonnet", "medium")])),
        })
    );
}

#[test]
fn can_map_explicit_legacy_pr_generation_instructions_for_old_runtime_callers() {
    let merged = merge_legacy_commit_message_ai_into_source_control_ai(
        None,
        Some(&CommitMessageAiSettings {
            enabled: Some(true),
            agent_id: Some(Some("codex".to_string())),
            selected_model_by_agent: smap(&[("codex", "gpt-5.5")]),
            selected_model_by_agent_by_host: None,
            discovered_models_by_agent: None,
            discovered_models_by_agent_by_host: None,
            selected_thinking_by_model: BTreeMap::new(),
            custom_prompt: Some("Legacy PR prompt".to_string()),
            custom_agent_command: Some(String::new()),
        }),
        &MergeLegacyOptions {
            pull_request_instructions_from_legacy: true,
        },
    );
    assert_eq!(
        merged.instructions_by_operation.get(&PullRequest).map(String::as_str),
        Some("Legacy PR prompt")
    );
}

#[test]
fn projects_commit_message_operation_model_overrides_into_legacy_settings() {
    let mut source = settings().source_control_ai.expect("source");
    source.selected_model_by_agent = smap(&[("codex", "gpt-5.5"), ("claude", "sonnet")]);
    source.selected_model_by_agent_by_host = Some(host_map(&[
        ("local", &[("codex", "gpt-5.5")]),
        ("ssh:conn-1", &[("codex", "gpt-5.5"), ("claude", "sonnet")]),
    ]));
    source.selected_thinking_by_model = smap(&[("gpt-5.4", "high"), ("gpt-5.5", "medium")]);
    source.model_overrides_by_operation = Some(BTreeMap::from([
        (
            CommitMessage,
            SourceControlAiModelChoice {
                selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
                selected_model_by_agent_by_host: Some(host_map(&[
                    ("local", &[("codex", "gpt-5.4")]),
                    ("ssh:conn-1", &[("codex", "gpt-5.4-mini")]),
                ])),
                selected_thinking_by_model: Some(smap(&[
                    ("gpt-5.4", "xhigh"),
                    ("gpt-5.4-mini", "medium"),
                ])),
            },
        ),
        (
            PullRequest,
            SourceControlAiModelChoice {
                selected_model_by_agent: Some(smap(&[("codex", "gpt-5.2")])),
                selected_model_by_agent_by_host: None,
                selected_thinking_by_model: Some(smap(&[("gpt-5.2", "low")])),
            },
        ),
    ]));

    let legacy = project_source_control_ai_to_legacy_commit_message_ai(&source, None);
    assert_eq!(
        legacy.selected_model_by_agent,
        smap(&[("codex", "gpt-5.4"), ("claude", "sonnet")])
    );
    assert_eq!(
        legacy.selected_model_by_agent_by_host,
        Some(host_map(&[
            ("local", &[("codex", "gpt-5.4")]),
            ("ssh:conn-1", &[("codex", "gpt-5.4-mini"), ("claude", "sonnet")]),
        ]))
    );
    assert_eq!(
        legacy.selected_thinking_by_model,
        smap(&[
            ("gpt-5.4", "xhigh"),
            ("gpt-5.4-mini", "medium"),
            ("gpt-5.5", "medium"),
        ])
    );
    assert!(!legacy.selected_thinking_by_model.contains_key("gpt-5.2"));
}

#[test]
fn merges_projected_legacy_commit_message_models_without_changing_pr_defaults() {
    let mut source = settings().source_control_ai.expect("source");
    source.selected_model_by_agent = smap(&[("codex", "gpt-5.5")]);
    source.selected_thinking_by_model = smap(&[("gpt-5.5", "medium")]);
    source.model_overrides_by_operation = Some(BTreeMap::from([(
        CommitMessage,
        SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
            selected_model_by_agent_by_host: None,
            selected_thinking_by_model: Some(smap(&[("gpt-5.4", "high")])),
        },
    )]));
    let legacy = project_source_control_ai_to_legacy_commit_message_ai(&source, None);
    let merged = merge_legacy_commit_message_ai_into_source_control_ai(
        Some(&source),
        Some(&legacy),
        &MergeLegacyOptions {
            pull_request_instructions_from_legacy: false,
        },
    );

    assert_eq!(
        merged.selected_model_by_agent.get("codex").map(String::as_str),
        Some("gpt-5.5")
    );
    assert_eq!(
        merged
            .model_overrides_by_operation
            .as_ref()
            .and_then(|overrides| overrides.get(&CommitMessage))
            .and_then(|choice| choice.selected_model_by_agent.as_ref())
            .and_then(|by_agent| by_agent.get("codex"))
            .map(String::as_str),
        Some("gpt-5.4")
    );

    let mut base = settings();
    base.source_control_ai = Some(merged);
    let commit = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&commit) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(value.params.model, "gpt-5.4"),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
    let pull_request = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: PullRequest,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&pull_request) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(value.params.model, "gpt-5.5"),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn does_not_synthesize_a_commit_message_override_from_projected_global_defaults() {
    let mut source = settings().source_control_ai.expect("source");
    source.selected_model_by_agent = smap(&[("codex", "gpt-5.5")]);
    source.selected_thinking_by_model = smap(&[("gpt-5.5", "medium")]);
    source.model_overrides_by_operation = None;
    let legacy = project_source_control_ai_to_legacy_commit_message_ai(&source, None);
    let merged = merge_legacy_commit_message_ai_into_source_control_ai(
        Some(&source),
        Some(&legacy),
        &MergeLegacyOptions {
            pull_request_instructions_from_legacy: false,
        },
    );

    assert_eq!(
        merged.selected_model_by_agent.get("codex").map(String::as_str),
        Some("gpt-5.5")
    );
    assert!(merged
        .model_overrides_by_operation
        .as_ref()
        .and_then(|overrides| overrides.get(&CommitMessage))
        .is_none());
}

#[test]
fn merges_only_rollback_legacy_model_deltas_into_commit_message_overrides() {
    let mut source = settings().source_control_ai.expect("source");
    source.selected_model_by_agent = smap(&[("codex", "gpt-5.5"), ("claude", "sonnet")]);
    source.selected_model_by_agent_by_host =
        Some(host_map(&[("local", &[("codex", "gpt-5.5"), ("claude", "sonnet")])]));
    source.selected_thinking_by_model = smap(&[("gpt-5.5", "medium"), ("sonnet", "high")]);
    source.model_overrides_by_operation = None;

    let mut legacy = project_source_control_ai_to_legacy_commit_message_ai(&source, None);
    legacy
        .selected_model_by_agent
        .insert("codex".to_string(), "gpt-5.4".to_string());
    let mut by_host = legacy.selected_model_by_agent_by_host.clone().unwrap_or_default();
    by_host
        .entry("local".to_string())
        .or_default()
        .insert("codex".to_string(), "gpt-5.4".to_string());
    legacy.selected_model_by_agent_by_host = Some(by_host);

    let merged = merge_legacy_commit_message_ai_into_source_control_ai(
        Some(&source),
        Some(&legacy),
        &MergeLegacyOptions {
            pull_request_instructions_from_legacy: false,
        },
    );

    assert_eq!(
        merged.selected_model_by_agent,
        smap(&[("codex", "gpt-5.5"), ("claude", "sonnet")])
    );
    assert_eq!(
        merged
            .model_overrides_by_operation
            .as_ref()
            .and_then(|overrides| overrides.get(&CommitMessage)),
        Some(&SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
            selected_model_by_agent_by_host: Some(host_map(&[("local", &[("codex", "gpt-5.4")])])),
            selected_thinking_by_model: None,
        })
    );
}

#[test]
fn removes_projected_commit_message_overrides_cleared_by_legacy_settings() {
    let mut source = settings().source_control_ai.expect("source");
    source.selected_model_by_agent = smap(&[("codex", "gpt-5.5")]);
    source.selected_thinking_by_model = smap(&[("gpt-5.5", "medium")]);
    source.model_overrides_by_operation = Some(BTreeMap::from([(
        CommitMessage,
        SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
            selected_model_by_agent_by_host: None,
            selected_thinking_by_model: Some(smap(&[("gpt-5.4", "high")])),
        },
    )]));

    let mut legacy = project_source_control_ai_to_legacy_commit_message_ai(&source, None);
    legacy.selected_model_by_agent.remove("codex");
    legacy.selected_thinking_by_model.remove("gpt-5.4");

    let merged = merge_legacy_commit_message_ai_into_source_control_ai(
        Some(&source),
        Some(&legacy),
        &MergeLegacyOptions {
            pull_request_instructions_from_legacy: false,
        },
    );
    assert!(merged
        .model_overrides_by_operation
        .as_ref()
        .and_then(|overrides| overrides.get(&CommitMessage))
        .is_none());
}

#[test]
fn reads_and_selects_host_scoped_model_choices_with_local_fallback_rules() {
    let local_choice =
        select_source_control_ai_model_choice_for_host(None, "local", "codex", "gpt-5.4");
    assert_eq!(
        local_choice,
        SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
            selected_model_by_agent_by_host: Some(host_map(&[("local", &[("codex", "gpt-5.4")])])),
            selected_thinking_by_model: None,
        }
    );

    let remote_choice = select_source_control_ai_model_choice_for_host(
        Some(&local_choice),
        "ssh:conn-1",
        "codex",
        "remote-model",
    );
    assert_eq!(
        read_source_control_ai_model_choice_for_host(Some(&remote_choice), "local", "codex")
            .as_deref(),
        Some("gpt-5.4")
    );
    assert_eq!(
        read_source_control_ai_model_choice_for_host(Some(&remote_choice), "ssh:conn-1", "codex")
            .as_deref(),
        Some("remote-model")
    );
    // TS `undefined`: no JSON image, so the vector corpus cannot carry this one.
    assert_eq!(
        read_source_control_ai_model_choice_for_host(Some(&remote_choice), "ssh:conn-2", "codex"),
        None
    );
    assert_eq!(
        read_source_control_ai_model_choice_for_host(
            Some(&SourceControlAiModelChoice {
                selected_model_by_agent: Some(smap(&[("codex", "global-model")])),
                ..SourceControlAiModelChoice::default()
            }),
            "local",
            "codex"
        )
        .as_deref(),
        Some("global-model")
    );
}

#[test]
fn clears_only_the_selected_host_model_override_when_inheriting() {
    let cleared = clear_source_control_ai_model_choice_for_host(
        Some(&SourceControlAiModelChoice {
            selected_model_by_agent: Some(smap(&[("codex", "local-model")])),
            selected_model_by_agent_by_host: Some(host_map(&[
                ("local", &[("codex", "local-model")]),
                ("ssh:conn-1", &[("codex", "remote-model")]),
            ])),
            selected_thinking_by_model: Some(smap(&[("remote-model", "high")])),
        }),
        "local",
        "codex",
    );

    assert_eq!(
        cleared,
        Some(SourceControlAiModelChoice {
            selected_model_by_agent: None,
            selected_model_by_agent_by_host: Some(host_map(&[(
                "ssh:conn-1",
                &[("codex", "remote-model")]
            )])),
            selected_thinking_by_model: Some(smap(&[("remote-model", "high")])),
        })
    );
    // The last host override cleared collapses the whole choice to `undefined`.
    assert_eq!(
        clear_source_control_ai_model_choice_for_host(
            Some(&SourceControlAiModelChoice {
                selected_model_by_agent: Some(smap(&[("codex", "local-model")])),
                selected_model_by_agent_by_host: Some(host_map(&[(
                    "local",
                    &[("codex", "local-model")]
                )])),
                selected_thinking_by_model: Some(smap(&[("local-model", "high")])),
            }),
            "local",
            "codex"
        ),
        None
    );
    assert_eq!(
        clear_source_control_ai_model_choice_for_host(None, "local", "codex"),
        None
    );
}

#[test]
fn normalizes_repo_overrides_defensively_and_preserves_explicit_inherit_sentinels() {
    let normalized = normalize_repo_source_control_ai_overrides(&json!({
        "modelOverridesByOperation": {
            "commitMessage": {
                "selectedModelByAgent": { "codex": "gpt-5.4", "claude": 42, "constructor": "polluted" },
                "selectedModelByAgentByHost": {
                    "local": { "codex": "gpt-5.4" },
                    "ssh:conn-1": { "codex": "remote-model", "claude": false },
                    "malformed": "not-a-record",
                    "prototype": { "codex": "polluted" }
                },
                "selectedThinkingByModel": {
                    "gpt-5.4": "xhigh",
                    "remote-model": "high",
                    "bad": true,
                    "constructor": "polluted"
                }
            },
            "pullRequest": { "selectedModelByAgent": [] },
            "branchName": { "selectedModelByAgent": { "codex": "gpt-5.4" } },
            "unknown": { "selectedModelByAgent": { "codex": "ignored" } }
        },
        "instructionsByOperation": {
            "commitMessage": null,
            "pullRequest": "",
            "branchName": "branch style",
            "unknown": "ignored"
        },
        "prCreationDefaults": {
            "draft": true,
            "useTemplate": null,
            "generateDetailsOnOpen": "yes",
            "openAfterCreate": false
        }
    }))
    .expect("record input normalizes");

    assert_eq!(
        normalized.model_overrides_by_operation,
        Some(BTreeMap::from([
            (
                CommitMessage,
                SourceControlAiModelChoice {
                    selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
                    selected_model_by_agent_by_host: Some(host_map(&[
                        ("local", &[("codex", "gpt-5.4")]),
                        ("ssh:conn-1", &[("codex", "remote-model")]),
                    ])),
                    selected_thinking_by_model: Some(smap(&[
                        ("gpt-5.4", "xhigh"),
                        ("remote-model", "high"),
                    ])),
                }
            ),
            (
                BranchName,
                SourceControlAiModelChoice {
                    selected_model_by_agent: Some(smap(&[("codex", "gpt-5.4")])),
                    ..SourceControlAiModelChoice::default()
                }
            ),
        ]))
    );
    assert_eq!(
        normalized.instructions_by_operation,
        Some(BTreeMap::from([
            (CommitMessage, None),
            (PullRequest, Some(String::new())),
            (BranchName, Some("branch style".to_string())),
        ]))
    );
    assert_eq!(
        normalized.action_overrides,
        Some(BTreeMap::from([
            (
                SourceControlActionId::PullRequest,
                RepoSourceControlActionOverride {
                    command_input_template: Some(Some("{basePrompt}".to_string())),
                    ..RepoSourceControlActionOverride::default()
                }
            ),
            (
                SourceControlActionId::BranchName,
                RepoSourceControlActionOverride {
                    command_input_template: Some(Some(
                        "branch style\n\n{basePrompt}".to_string()
                    )),
                    ..RepoSourceControlActionOverride::default()
                }
            ),
        ]))
    );
    assert_eq!(
        normalized.pr_creation_defaults,
        Some(RepoPrCreationDefaults {
            draft: Some(Some(true)),
            use_template: Some(None),
            generate_details_on_open: None,
            open_after_create: Some(Some(false)),
        })
    );
    assert_eq!(normalized.enabled, None);
    assert_eq!(normalized.custom_agent_command, None);

    assert_eq!(
        normalize_repo_source_control_ai_overrides(&Value::Null),
        None
    );
    assert_eq!(normalize_repo_source_control_ai_overrides(&json!([])), None);
    // An object with nothing recognisable is `undefined`, not an empty record.
    assert_eq!(normalize_repo_source_control_ai_overrides(&json!({})), None);
}

#[test]
fn preserves_repo_null_command_templates_without_requiring_another_override_field() {
    let normalized = normalize_repo_source_control_ai_overrides(&json!({
        "instructionsByOperation": { "commitMessage": "legacy repo style" },
        "actionOverrides": { "commitMessage": { "commandInputTemplate": null } }
    }))
    .expect("record input normalizes");

    assert_eq!(
        normalized.instructions_by_operation,
        Some(BTreeMap::from([(
            CommitMessage,
            Some("legacy repo style".to_string())
        )]))
    );
    // ONLY the null template: an absent `agentId`/`agentArgs` must not be
    // reported as an explicit inherit sentinel.
    assert_eq!(
        normalized.action_overrides,
        Some(BTreeMap::from([(
            SourceControlActionId::CommitMessage,
            RepoSourceControlActionOverride {
                agent_id: None,
                command_input_template: Some(None),
                agent_args: None,
            }
        )]))
    );
}

// --- boundary cases the twin's suite does not write down ---

#[test]
fn an_absent_repo_template_still_takes_the_instruction_migration() {
    // The absent/null distinction decides which prompt actually runs: with only
    // an `agentArgs` override present, the instruction must still migrate.
    let normalized = normalize_repo_source_control_ai_overrides(&json!({
        "instructionsByOperation": { "commitMessage": "repo style" },
        "actionOverrides": { "commitMessage": { "agentArgs": "--json" } }
    }))
    .expect("record input normalizes");
    assert_eq!(
        normalized
            .action_overrides
            .as_ref()
            .and_then(|by_action| by_action.get(&SourceControlActionId::CommitMessage)),
        Some(&RepoSourceControlActionOverride {
            agent_id: None,
            command_input_template: Some(Some("{basePrompt}\n\nrepo style".to_string())),
            agent_args: Some(Some("--json".to_string())),
        })
    );
}

#[test]
fn keeps_the_fix_push_failure_action_override() {
    // `fixPushFailure` is one of the eight action ids; dropping it silently
    // discards a repo's push-fix recipe.
    let normalized = normalize_repo_source_control_ai_overrides(&json!({
        "actionOverrides": { "fixPushFailure": { "agentId": "claude" } }
    }))
    .expect("record input normalizes");
    assert_eq!(
        normalized
            .action_overrides
            .as_ref()
            .and_then(|by_action| by_action.get(&SourceControlActionId::FixPushFailure)),
        Some(&RepoSourceControlActionOverride {
            agent_id: Some(Some("claude".to_string())),
            command_input_template: None,
            agent_args: None,
        })
    );
}

#[test]
fn trims_command_templates_the_way_javascript_does() {
    // JS `.trim()` strips U+FEFF and keeps U+0085; `str::trim` does the reverse,
    // and these strings come straight back out of persisted settings.
    let mut source = get_default_source_control_ai_settings();
    let mut actions = source.actions.clone().unwrap_or_default();
    actions.insert(
        SourceControlActionId::FixChecks,
        SourceControlActionRecipe {
            agent_id: None,
            command_input_template: Some("\u{FEFF}fix \u{0085}checks\u{FEFF}".to_string()),
            agent_args: None,
        },
    );
    source.actions = Some(actions);
    let settings = GlobalSettingsSlice {
        source_control_ai: Some(source),
        ..GlobalSettingsSlice::default()
    };
    assert_eq!(
        resolve_source_control_action_recipe(
            Some(&settings),
            None,
            SourceControlActionId::FixChecks
        )
        .command_input_template
        .as_deref(),
        Some("fix \u{0085}checks")
    );
}

#[test]
fn a_repo_action_override_wins_for_a_launch_action() {
    let settings = settings();
    let repo = json!({
        "actionOverrides": {
            "resolveConflicts": { "agentId": "claude", "commandInputTemplate": "  resolve  ", "agentArgs": null }
        }
    });
    assert_eq!(
        resolve_source_control_action_recipe(
            Some(&settings),
            Some(&repo),
            SourceControlActionId::ResolveConflicts
        ),
        SourceControlActionRecipe {
            // The global `agentId: 'codex'` is projected onto the three TEXT
            // actions only, so the launch action carries the repo choice alone.
            agent_id: Some(Some("claude".to_string())),
            command_input_template: Some("resolve".to_string()),
            agent_args: Some(String::new()),
        }
    );
}

#[test]
fn an_empty_command_template_refuses_generation() {
    let mut base = settings();
    let repo = json!({ "actionOverrides": { "commitMessage": { "commandInputTemplate": "   " } } });
    let mut source = base.source_control_ai.clone().expect("source");
    source.instructions_by_operation = instr(&[(CommitMessage, "")]);
    base.source_control_ai = Some(source);
    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: Some(&repo),
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    assert_eq!(
        resolve_source_control_ai_for_operation(&input),
        ResolveSourceControlAiResult::Err(
            "Command template is empty for commit messages.".to_string()
        )
    );
}

#[test]
fn a_custom_default_agent_collapses_to_its_base_agent() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.agent_id = Some(None);
    source.selected_model_by_agent = BTreeMap::new();
    base.source_control_ai = Some(source);
    base.default_tui_agent = DefaultTuiAgentPreference::Custom {
        id: Some("profile-1".to_string()),
    };
    base.custom_agents = vec![CustomAgentProfile {
        id: Some("profile-1".to_string()),
        base_agent: Some("claude".to_string()),
    }];
    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => assert_eq!(value.params.agent_id, "claude"),
        ResolveSourceControlAiResult::Err(error) => panic!("{error}"),
    }
}

#[test]
fn a_disabled_default_agent_with_claude_disabled_has_no_choice() {
    let mut base = settings();
    let mut source = base.source_control_ai.clone().expect("source");
    source.agent_id = Some(None);
    base.source_control_ai = Some(source);
    base.disabled_tui_agents = vec!["codex".to_string(), "claude".to_string()];
    let input = ResolveSourceControlAiInput {
        settings: &base,
        repo_source_control_ai: None,
        operation: CommitMessage,
        discovery_host_key: Some("local"),
        pr_creation_product_defaults: None,
    };
    match resolve_source_control_ai_for_operation(&input) {
        ResolveSourceControlAiResult::Ok(value) => panic!("unexpected {value:?}"),
        ResolveSourceControlAiResult::Err(error) => assert!(
            error.starts_with(
                "Choose a supported Source Control AI agent for this action in Settings -> Git -> Source Control AI. Supported agents: "
            ),
            "{error}"
        ),
    }
}

#[test]
fn resolve_instructions_falls_back_to_the_legacy_prompt_for_commit_messages() {
    let mut legacy = default_commit_message_ai();
    legacy.custom_prompt = Some("  Legacy prompt  ".to_string());
    let settings = GlobalSettingsSlice {
        commit_message_ai: Some(legacy),
        ..GlobalSettingsSlice::default()
    };
    // With no `sourceControlAi`, normalize derives the instruction from legacy.
    assert_eq!(
        resolve_source_control_ai_instructions(&settings, None, CommitMessage),
        "Legacy prompt"
    );
    assert_eq!(
        resolve_source_control_ai_instructions(&settings, None, PullRequest),
        ""
    );
}

// ---------------------------------------------------------------------------
// The rollback bridge's own-`undefined` slots.
//
// `normalizeSourceControlAiSettings` merges with `{ ...defaults, ...base }`, so
// a legacy field the rollback build never wrote arrives as a key holding
// `undefined` and SHADOWS the product default — `JSON.stringify` then omits it
// and persistence writes nothing. Substituting `""` / `null` / `true` here
// persists a custom command, an agent choice and an enabled flag the user never
// made. Goldens are the committed twin's own answers
// (`git show HEAD:src/shared/source-control-ai.ts`), read through
// `JSON.parse(JSON.stringify(...))` so an own-`undefined` shows up as absent.
// ---------------------------------------------------------------------------

/// The rollback repro's stored blob: `{ enabled: true, agentId: null,
/// selectedModelByAgent: {}, selectedThinkingByModel: {}, customAgentCommand,
/// instructionsByOperation: {} }`.
fn stored_settings(custom_agent_command: &str) -> SourceControlAiSettings {
    SourceControlAiSettings {
        enabled: Some(true),
        agent_id: Some(None),
        custom_agent_command: Some(custom_agent_command.to_string()),
        ..SourceControlAiSettings::default()
    }
}

fn merge_legacy(
    source: Option<&SourceControlAiSettings>,
    legacy: &CommitMessageAiSettings,
) -> SourceControlAiSettings {
    merge_legacy_commit_message_ai_into_source_control_ai(
        source,
        Some(legacy),
        &MergeLegacyOptions {
            pull_request_instructions_from_legacy: false,
        },
    )
}

#[test]
fn rollback_merge_records_no_custom_command_when_legacy_omits_one() {
    let base = stored_settings("keep-me");
    let merged = merge_legacy(
        Some(&base),
        &CommitMessageAiSettings {
            enabled: Some(false),
            agent_id: Some(Some("codex".to_string())),
            ..CommitMessageAiSettings::default()
        },
    );

    assert_eq!(merged.custom_agent_command, None);
    assert_eq!(merged.enabled, Some(false));
    assert_eq!(merged.agent_id, Some(Some("codex".to_string())));
}

#[test]
fn rollback_merge_records_no_agent_when_legacy_omits_one() {
    let base = stored_settings("keep-me");
    let merged = merge_legacy(
        Some(&base),
        &CommitMessageAiSettings {
            enabled: Some(true),
            custom_agent_command: Some("keep-me".to_string()),
            ..CommitMessageAiSettings::default()
        },
    );

    assert_eq!(merged.agent_id, None);
    assert_eq!(merged.enabled, Some(true));
    assert_eq!(merged.custom_agent_command.as_deref(), Some("keep-me"));
}

#[test]
fn rollback_merge_records_no_enabled_flag_when_legacy_omits_one() {
    let base = stored_settings("keep-me");
    let merged = merge_legacy(
        Some(&base),
        &CommitMessageAiSettings {
            agent_id: Some(None),
            custom_agent_command: Some("keep-me".to_string()),
            ..CommitMessageAiSettings::default()
        },
    );

    assert_eq!(merged.enabled, None);
    assert_eq!(merged.agent_id, Some(None));
    assert_eq!(merged.custom_agent_command.as_deref(), Some("keep-me"));
}

#[test]
fn legacy_only_merge_records_none_of_the_three_core_slots_from_an_empty_blob() {
    let merged = merge_legacy(None, &CommitMessageAiSettings::default());

    assert_eq!(merged.enabled, None);
    assert_eq!(merged.agent_id, None);
    assert_eq!(merged.custom_agent_command, None);
    assert_eq!(
        merged.instructions_by_operation,
        instr(&[(CommitMessage, ""), (PullRequest, ""), (BranchName, "")])
    );
}

#[test]
fn normalizing_a_from_legacy_projection_keeps_the_unwritten_slots_unset() {
    let normalized = normalize_source_control_ai_settings(
        None,
        Some(&CommitMessageAiSettings::default()),
    );

    assert_eq!(normalized.enabled, None);
    assert_eq!(normalized.agent_id, None);
    assert_eq!(normalized.custom_agent_command, None);
}

#[test]
fn re_normalizing_a_merged_result_does_not_resurrect_the_defaults() {
    // Why: the twin's spread copies the own `undefined` through, and
    // persistence normalizes what it just merged.
    let merged = merge_legacy(None, &CommitMessageAiSettings::default());
    let again = normalize_source_control_ai_settings(Some(&merged), None);

    assert_eq!(again.enabled, None);
    assert_eq!(again.agent_id, None);
    assert_eq!(again.custom_agent_command, None);
}

#[test]
fn an_absent_key_on_a_decoded_blob_still_inherits_the_product_default() {
    // The other half of the contract: JSON cannot carry `undefined`, so a blob
    // that simply lacks the key takes the spread default, as the twin does.
    let normalized = normalize_source_control_ai_settings(
        Some(&SourceControlAiSettings {
            enabled: Some(true),
            ..SourceControlAiSettings::default()
        }),
        None,
    );

    assert_eq!(normalized.enabled, Some(true));
    assert_eq!(normalized.agent_id, Some(None));
    assert_eq!(normalized.custom_agent_command.as_deref(), Some(""));
}

#[test]
fn rollback_merge_keeps_a_custom_command_the_legacy_blob_did_write() {
    let base = stored_settings("keep-me");
    let merged = merge_legacy(
        Some(&base),
        &CommitMessageAiSettings {
            enabled: Some(false),
            custom_agent_command: Some("rollback-wrote-this".to_string()),
            ..CommitMessageAiSettings::default()
        },
    );

    assert_eq!(
        merged.custom_agent_command.as_deref(),
        Some("rollback-wrote-this")
    );
}
