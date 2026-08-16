// Repo-over-global-over-legacy precedence for everything one source-control AI
// operation needs but the agent choice: the persisted model id, the thinking
// level, the instruction text, the PR-creation defaults and the action recipe.
//
// This is deleted-twin code. `source-control-ai.ts` is now the dispatch shim on
// `orca_git::source_control_ai`; these bodies are its pre-ready `parity` answer
// and its answer for every input the core models differently, and nothing else
// calls them. Change them only alongside the Rust core.
import type { CustomAgentId } from './commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import {
  readSourceControlActionDefault,
  resolveSourceControlActionCommandTemplate,
  type SourceControlActionId,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import type { ResolveSourceControlAiPrCreationDefaultsInput } from './source-control-ai'
import { DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS } from './source-control-ai-pr-creation-defaults'
import { readSourceControlAiModelChoiceForHost } from './source-control-ai-host-model-choice'
import {
  commandTemplateFromOperationInstruction,
  readRepoInstructionOverride
} from './source-control-ai-instruction-templates'
import { normalizeRepoSourceControlAiOverrides } from './source-control-ai-repo-override-normalization'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings-normalization'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiOperation,
  SourceControlAiPrCreationDefaults,
  SourceControlAiSettings
} from './source-control-ai-types'
import type {
  CommitMessageAiModelCapability,
  CommitMessageAiSettings,
  GlobalSettings,
  Repo,
  TuiAgent
} from './types'

function readDefaultSelectedModelId(
  settings: Pick<SourceControlAiSettings, 'selectedModelByAgent' | 'selectedModelByAgentByHost'>,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  return readSourceControlAiModelChoiceForHost(
    {
      selectedModelByAgent: settings.selectedModelByAgent,
      selectedModelByAgentByHost: settings.selectedModelByAgentByHost
    },
    hostKey,
    agentId
  )
}

export function getDiscoveredModels(
  source: SourceControlAiSettings,
  legacy: CommitMessageAiSettings | null | undefined,
  hostKey: string,
  agentId: TuiAgent
): CommitMessageAiModelCapability[] {
  return (
    source.discoveredModelsByAgentByHost?.[hostKey]?.[agentId] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? (source.discoveredModelsByAgent?.[agentId] ??
        legacy?.discoveredModelsByAgentByHost?.[hostKey]?.[agentId] ??
        legacy?.discoveredModelsByAgent?.[agentId] ??
        [])
      : (legacy?.discoveredModelsByAgentByHost?.[hostKey]?.[agentId] ?? []))
  )
}

export function selectPersistedModelId(args: {
  source: SourceControlAiSettings
  legacy: CommitMessageAiSettings | null | undefined
  repoOverrides: RepoSourceControlAiOverrides | null | undefined
  operation: SourceControlAiOperation
  hostKey: string
  agentId: TuiAgent
  defaultModelId: string
}): string {
  const { source, legacy, repoOverrides, operation, hostKey, agentId, defaultModelId } = args
  return (
    readSourceControlAiModelChoiceForHost(
      repoOverrides?.modelOverridesByOperation?.[operation],
      hostKey,
      agentId
    ) ??
    readSourceControlAiModelChoiceForHost(
      source.modelOverridesByOperation?.[operation],
      hostKey,
      agentId
    ) ??
    readDefaultSelectedModelId(source, hostKey, agentId) ??
    legacy?.selectedModelByAgentByHost?.[hostKey]?.[agentId] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? legacy?.selectedModelByAgent?.[agentId]
      : undefined) ??
    defaultModelId
  )
}

export function resolveThinkingLevel(args: {
  model: CommitMessageAiModelCapability
  source: SourceControlAiSettings
  legacy: CommitMessageAiSettings | null | undefined
  repoOverrides: RepoSourceControlAiOverrides | null | undefined
  operation: SourceControlAiOperation
}): string | undefined {
  const { model, source, legacy, repoOverrides, operation } = args
  if (!model.thinkingLevels?.length) {
    return undefined
  }
  const persisted =
    repoOverrides?.modelOverridesByOperation?.[operation]?.selectedThinkingByModel?.[model.id] ??
    source.modelOverridesByOperation?.[operation]?.selectedThinkingByModel?.[model.id] ??
    source.selectedThinkingByModel[model.id] ??
    legacy?.selectedThinkingByModel?.[model.id]
  return model.thinkingLevels.some((level) => level.id === persisted)
    ? persisted
    : model.defaultThinkingLevel
}

// Why: callers that already normalized settings/repo overrides reuse this to
// avoid re-normalizing the same inputs on every instruction lookup.
export function resolveInstructionsFromNormalized(
  source: SourceControlAiSettings,
  repoOverrides: RepoSourceControlAiOverrides | null | undefined,
  operation: SourceControlAiOperation,
  legacyCustomPrompt: string | undefined
): string {
  const repoInstruction = readRepoInstructionOverride(
    repoOverrides?.instructionsByOperation,
    operation
  )
  if (repoInstruction !== undefined) {
    return repoInstruction.trim()
  }
  const globalInstruction = source.instructionsByOperation[operation]
  if (typeof globalInstruction === 'string') {
    return globalInstruction.trim()
  }
  return operation === 'commitMessage' ? (legacyCustomPrompt ?? '').trim() : ''
}

export function resolveSourceControlAiInstructions(args: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
}): string {
  const source = normalizeSourceControlAiSettings(
    args.settings.sourceControlAi,
    args.settings.commitMessageAi
  )
  const repoOverrides = normalizeRepoSourceControlAiOverrides(args.repo?.sourceControlAi)
  return resolveInstructionsFromNormalized(
    source,
    repoOverrides,
    args.operation,
    args.settings.commitMessageAi?.customPrompt
  )
}

export function hasConfiguredSourceControlAiInstructions(args: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
}): boolean {
  const repoOverrides = normalizeRepoSourceControlAiOverrides(args.repo?.sourceControlAi)
  const repoInstruction = readRepoInstructionOverride(
    repoOverrides?.instructionsByOperation,
    args.operation
  )
  if (repoInstruction !== undefined) {
    return true
  }
  return resolveSourceControlAiInstructions(args).length > 0
}

export function resolvePrCreationDefaults(
  source: SourceControlAiSettings,
  repoOverrides: RepoSourceControlAiOverrides | null | undefined,
  productDefaults: SourceControlAiPrCreationDefaults | undefined
): Required<SourceControlAiPrCreationDefaults> {
  const base = {
    ...DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
    ...productDefaults,
    ...source.prCreationDefaults
  }
  const repoDefaults = repoOverrides?.prCreationDefaults
  if (!repoDefaults) {
    return base
  }
  return {
    draft: repoDefaults.draft ?? base.draft,
    useTemplate: repoDefaults.useTemplate ?? base.useTemplate,
    generateDetailsOnOpen: repoDefaults.generateDetailsOnOpen ?? base.generateDetailsOnOpen,
    openAfterCreate: repoDefaults.openAfterCreate ?? base.openAfterCreate
  }
}

export function resolveActionRecipeForTextOperation(
  source: SourceControlAiSettings,
  repoOverrides: RepoSourceControlAiOverrides | null | undefined,
  operation: SourceControlAiOperation
): {
  agentId?: TuiAgent | CustomAgentId | null
  commandInputTemplate: string
  agentArgs?: string
} {
  const globalRecipe = readSourceControlActionDefault(source.actions, operation)
  const repoRecipe = repoOverrides?.actionOverrides?.[operation]
  const repoInstruction = readRepoInstructionOverride(
    repoOverrides?.instructionsByOperation,
    operation
  )
  const fallbackTemplate =
    repoInstruction !== undefined
      ? commandTemplateFromOperationInstruction(operation, repoInstruction)
      : resolveSourceControlActionCommandTemplate(source.actions, operation)
  const repoTemplate =
    typeof repoRecipe?.commandInputTemplate === 'string'
      ? repoRecipe.commandInputTemplate.trim()
      : undefined
  const repoAgentArgs =
    typeof repoRecipe?.agentArgs === 'string'
      ? repoRecipe.agentArgs.trim()
      : repoRecipe?.agentArgs === null
        ? ''
        : undefined
  return {
    ...(repoRecipe?.agentId !== undefined
      ? { agentId: repoRecipe.agentId }
      : globalRecipe.agentId !== undefined
        ? { agentId: globalRecipe.agentId }
        : {}),
    ...(repoAgentArgs !== undefined
      ? { agentArgs: repoAgentArgs }
      : globalRecipe.agentArgs !== undefined
        ? { agentArgs: globalRecipe.agentArgs }
        : {}),
    commandInputTemplate:
      repoTemplate !== undefined
        ? repoTemplate
        : globalRecipe.commandInputTemplate !== undefined
          ? globalRecipe.commandInputTemplate
          : fallbackTemplate
  }
}

export function resolveSourceControlAiPrCreationDefaults(
  input: ResolveSourceControlAiPrCreationDefaultsInput
): Required<SourceControlAiPrCreationDefaults> {
  const source = normalizeSourceControlAiSettings(
    input.settings.sourceControlAi,
    input.settings.commitMessageAi
  )
  return resolvePrCreationDefaults(
    source,
    normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi),
    input.prCreationProductDefaults
  )
}

export function resolveSourceControlAiEnabled(input: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
}): boolean {
  const source = normalizeSourceControlAiSettings(
    input.settings?.sourceControlAi,
    input.settings?.commitMessageAi
  )
  const repoOverrides = normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)
  // `?? false` because the return type says `boolean` and this could hand back
  // `undefined`: a persisted `commitMessageAi` with no `enabled` key normalizes to
  // an own-undefined `enabled`, so the coalesce fell through both operands.
  return repoOverrides?.enabled ?? source.enabled ?? false
}

export function resolveSourceControlActionRecipe(input: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
  actionId: SourceControlActionId
}): SourceControlActionRecipe {
  const source = normalizeSourceControlAiSettings(
    input.settings?.sourceControlAi,
    input.settings?.commitMessageAi
  )
  const globalRecipe = readSourceControlActionDefault(source.actions, input.actionId)
  const repoRecipe = normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)
    ?.actionOverrides?.[input.actionId]
  if (!repoRecipe) {
    return {
      ...globalRecipe,
      commandInputTemplate: resolveSourceControlActionCommandTemplate(
        source.actions,
        input.actionId
      )
    }
  }
  return {
    ...globalRecipe,
    commandInputTemplate: resolveSourceControlActionCommandTemplate(source.actions, input.actionId),
    ...(repoRecipe.agentId !== undefined ? { agentId: repoRecipe.agentId } : {}),
    ...(typeof repoRecipe.commandInputTemplate === 'string'
      ? { commandInputTemplate: repoRecipe.commandInputTemplate.trim() }
      : {}),
    ...(typeof repoRecipe.agentArgs === 'string'
      ? { agentArgs: repoRecipe.agentArgs.trim() }
      : repoRecipe.agentArgs === null
        ? { agentArgs: '' }
        : {})
  }
}
