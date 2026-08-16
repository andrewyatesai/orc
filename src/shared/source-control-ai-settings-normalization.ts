// The global source-control AI settings shape: its product defaults, the
// projection of a legacy `commitMessageAi` blob into it, and the normalizer that
// fills defaults and migrates per-operation instructions into action recipes.
//
// This is deleted-twin code. `source-control-ai.ts` is now the dispatch shim on
// `orca_git::source_control_ai`; these bodies are its pre-ready `parity` answer
// and its answer for every input the core models differently, and nothing else
// calls them. Change them only alongside the Rust core.
import { CUSTOM_AGENT_ID, isCustomAgentId, type CustomAgentId } from './commit-message-agent-spec'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  normalizeSourceControlAiActionDefaults,
  readSourceControlActionDefault,
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_IDS
} from './source-control-ai-actions'
import { DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS } from './source-control-ai-pr-creation-defaults'
import {
  commandTemplateFromInstruction,
  commandTemplateFromOperationInstruction,
  isLegacyBranchInstructionTemplate
} from './source-control-ai-instruction-templates'
import type { SourceControlAiSettings } from './source-control-ai-types'
import type { CommitMessageAiSettings, TuiAgent } from './types'

export function copyRecord<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value)
}

export function actionRecipeFromLegacyCommitMessageAi(legacy: CommitMessageAiSettings): {
  agentId?: TuiAgent | CustomAgentId | null
  commandInputTemplate: string
} {
  return {
    ...(legacy.agentId === null
      ? { agentId: null }
      : isCustomAgentId(legacy.agentId)
        ? { agentId: CUSTOM_AGENT_ID }
        : legacy.agentId
          ? { agentId: legacy.agentId }
          : {}),
    commandInputTemplate: commandTemplateFromInstruction(legacy.customPrompt)
  }
}

export function getDefaultSourceControlAiSettings(): SourceControlAiSettings {
  return {
    enabled: true,
    actions: Object.fromEntries(
      SOURCE_CONTROL_ACTION_IDS.map((actionId) => [
        actionId,
        {
          commandInputTemplate: DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
        }
      ])
    ) as SourceControlAiSettings['actions'],
    agentId: null,
    selectedModelByAgent: {},
    selectedModelByAgentByHost: {},
    discoveredModelsByAgent: {},
    discoveredModelsByAgentByHost: {},
    selectedThinkingByModel: {},
    customAgentCommand: '',
    instructionsByOperation: {
      commitMessage: '',
      pullRequest: '',
      branchName: ''
    },
    prCreationDefaults: { ...DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS },
    launchActionDefaults: {}
  }
}

export function sourceControlAiSettingsFromLegacy(
  legacy: CommitMessageAiSettings | null | undefined
): SourceControlAiSettings {
  const defaults = getDefaultSourceControlAiSettings()
  if (!legacy) {
    return defaults
  }
  const legacyActionRecipe = actionRecipeFromLegacyCommitMessageAi(legacy)
  return {
    ...defaults,
    enabled: legacy.enabled,
    agentId: legacy.agentId,
    selectedModelByAgent: { ...legacy.selectedModelByAgent },
    selectedModelByAgentByHost: copyRecord(legacy.selectedModelByAgentByHost) ?? {},
    discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
    discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
    selectedThinkingByModel: { ...legacy.selectedThinkingByModel },
    customAgentCommand: legacy.customAgentCommand,
    instructionsByOperation: {
      commitMessage: legacy.customPrompt ?? '',
      // Why: the legacy prompt covered commit generation and branch auto-rename;
      // the first split must preserve that guidance for both released paths.
      pullRequest: '',
      branchName: legacy.customPrompt ?? ''
    },
    actions: {
      ...defaults.actions,
      commitMessage: legacyActionRecipe,
      branchName: {
        ...legacyActionRecipe,
        commandInputTemplate: commandTemplateFromOperationInstruction(
          'branchName',
          legacy.customPrompt
        )
      }
    }
  }
}

export function normalizeSourceControlAiSettings(
  value: SourceControlAiSettings | null | undefined,
  legacy?: CommitMessageAiSettings | null
): SourceControlAiSettings {
  const base = value ?? sourceControlAiSettingsFromLegacy(legacy)
  const defaults = getDefaultSourceControlAiSettings()
  const normalizedLaunchActionDefaults = normalizeSourceControlAiActionDefaults(
    base.launchActionDefaults
  )
  const normalizedActions = {
    ...normalizedLaunchActionDefaults,
    ...normalizeSourceControlAiActionDefaults(base.actions)
  }
  const migratedTextActions = Object.fromEntries(
    SOURCE_CONTROL_TEXT_ACTION_IDS.map((actionId) => {
      const existing = readSourceControlActionDefault(normalizedActions, actionId)
      const instruction = base.instructionsByOperation?.[actionId]
      const legacyInstruction = actionId === 'commitMessage' ? legacy?.customPrompt : undefined
      const resolvedInstruction = instruction ?? legacyInstruction
      const instructionTemplate =
        instruction || legacyInstruction
          ? commandTemplateFromOperationInstruction(actionId, resolvedInstruction)
          : undefined
      const shouldApplyInstructionTemplate =
        instructionTemplate !== undefined &&
        (existing.commandInputTemplate === undefined ||
          existing.commandInputTemplate ===
            DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId] ||
          isLegacyBranchInstructionTemplate(
            actionId,
            resolvedInstruction,
            existing.commandInputTemplate
          ))
      return [
        actionId,
        {
          ...defaults.actions?.[actionId],
          ...(base.agentId && !isCustomAgentId(base.agentId) ? { agentId: base.agentId } : {}),
          ...existing,
          ...(shouldApplyInstructionTemplate ? { commandInputTemplate: instructionTemplate } : {})
        }
      ]
    })
  ) as SourceControlAiSettings['actions']
  const actions: SourceControlAiSettings['actions'] = {
    ...defaults.actions,
    ...normalizedActions,
    ...migratedTextActions
  }
  return {
    ...defaults,
    ...base,
    selectedModelByAgent: {
      ...defaults.selectedModelByAgent,
      ...base.selectedModelByAgent
    },
    selectedModelByAgentByHost:
      copyRecord(base.selectedModelByAgentByHost) ?? defaults.selectedModelByAgentByHost,
    discoveredModelsByAgent:
      copyRecord(base.discoveredModelsByAgent) ?? defaults.discoveredModelsByAgent,
    discoveredModelsByAgentByHost:
      copyRecord(base.discoveredModelsByAgentByHost) ?? defaults.discoveredModelsByAgentByHost,
    selectedThinkingByModel: {
      ...defaults.selectedThinkingByModel,
      ...base.selectedThinkingByModel
    },
    instructionsByOperation: {
      ...defaults.instructionsByOperation,
      ...base.instructionsByOperation
    },
    modelOverridesByOperation: copyRecord(base.modelOverridesByOperation),
    prCreationDefaults: {
      ...defaults.prCreationDefaults,
      ...base.prCreationDefaults
    },
    actions,
    launchActionDefaults: normalizedLaunchActionDefaults ?? defaults.launchActionDefaults
  }
}
