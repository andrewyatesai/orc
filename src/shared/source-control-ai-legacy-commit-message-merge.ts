// The two-way bridge with the released `commitMessageAi` blob: merging a write
// from an older runtime (or a rollback build) into the split source-control AI
// shape, and projecting the split shape back down for those runtimes to read.
//
// This is deleted-twin code. `source-control-ai.ts` is now the dispatch shim on
// `orca_git::source_control_ai`; these bodies are its pre-ready `parity` answer
// and its answer for every input the core models differently, and nothing else
// calls them. Change them only alongside the Rust core.
import { CUSTOM_AGENT_ID, isCustomAgentId } from './commit-message-agent-spec'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  readSourceControlActionDefault,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import {
  commandTemplateFromOperationInstruction,
  hasActionAgentRecipe,
  legacyPromptFromCommandTemplate
} from './source-control-ai-instruction-templates'
import {
  mergeLegacyHostModelSelectionDelta,
  mergeLegacyModelSelectionDelta,
  mergeSelectedModelByAgentByHost
} from './source-control-ai-legacy-model-selection-delta'
import {
  actionRecipeFromLegacyCommitMessageAi,
  copyRecord,
  normalizeSourceControlAiSettings
} from './source-control-ai-settings-normalization'
import type { SourceControlAiModelChoice, SourceControlAiSettings } from './source-control-ai-types'
import type { CommitMessageAiSettings } from './types'

type LegacyCoreChanges = Record<
  'enabled' | 'agentId' | 'customPrompt' | 'customAgentCommand',
  boolean
>

function hasEntries(value: Record<string, unknown> | null | undefined): boolean {
  return Object.keys(value ?? {}).length > 0
}

function legacyCommitMessageCoreChanges(
  legacy: CommitMessageAiSettings,
  projected: CommitMessageAiSettings
): LegacyCoreChanges {
  return {
    enabled: legacy.enabled !== projected.enabled,
    agentId: legacy.agentId !== projected.agentId,
    customPrompt: legacy.customPrompt !== projected.customPrompt,
    customAgentCommand: legacy.customAgentCommand !== projected.customAgentCommand
  }
}

function hasLegacyCommitMessageCoreChanges(changes: LegacyCoreChanges): boolean {
  return Object.values(changes).some(Boolean)
}

function applyLegacyAgentToActionRecipe(
  recipe: SourceControlActionRecipe | undefined,
  agentId: CommitMessageAiSettings['agentId']
): SourceControlActionRecipe {
  const next = { ...recipe }
  if (agentId === null) {
    next.agentId = null
  } else if (isCustomAgentId(agentId)) {
    next.agentId = CUSTOM_AGENT_ID
  } else if (agentId && !isCustomAgentId(agentId)) {
    next.agentId = agentId
  } else {
    delete next.agentId
  }
  return next
}

function shouldImportLegacyBranchPrompt(
  base: SourceControlAiSettings,
  projectedLegacy: CommitMessageAiSettings
): boolean {
  const branchRecipe = readSourceControlActionDefault(base.actions, 'branchName')
  const projectedTemplate = commandTemplateFromOperationInstruction(
    'branchName',
    projectedLegacy.customPrompt
  )
  return (
    branchRecipe.commandInputTemplate === undefined ||
    branchRecipe.commandInputTemplate ===
      DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.branchName ||
    // Why: stale legacy branch instructions can remain after a user customizes
    // the new branch action recipe; only recipe state can prove it is still coupled.
    branchRecipe.commandInputTemplate === projectedTemplate
  )
}

function shouldImportLegacyBranchAgent(
  base: SourceControlAiSettings,
  projectedLegacy: CommitMessageAiSettings
): boolean {
  const branchRecipe = readSourceControlActionDefault(base.actions, 'branchName')
  return !hasActionAgentRecipe(branchRecipe) || branchRecipe.agentId === projectedLegacy.agentId
}

export function projectSourceControlAiToLegacyCommitMessageAi(
  sourceControlAi: SourceControlAiSettings,
  previousLegacy?: CommitMessageAiSettings | null
): CommitMessageAiSettings {
  const commitMessageChoice = sourceControlAi.modelOverridesByOperation?.commitMessage
  const commitRecipe = readSourceControlActionDefault(sourceControlAi.actions, 'commitMessage')
  return {
    enabled: sourceControlAi.enabled,
    agentId: hasActionAgentRecipe(commitRecipe) ? commitRecipe.agentId : sourceControlAi.agentId,
    selectedModelByAgent: {
      ...sourceControlAi.selectedModelByAgent,
      ...commitMessageChoice?.selectedModelByAgent
    },
    selectedModelByAgentByHost: mergeSelectedModelByAgentByHost(
      sourceControlAi.selectedModelByAgentByHost,
      commitMessageChoice?.selectedModelByAgentByHost
    ),
    discoveredModelsByAgent: copyRecord(sourceControlAi.discoveredModelsByAgent) ?? {},
    discoveredModelsByAgentByHost: copyRecord(sourceControlAi.discoveredModelsByAgentByHost) ?? {},
    selectedThinkingByModel: {
      ...sourceControlAi.selectedThinkingByModel,
      ...commitMessageChoice?.selectedThinkingByModel
    },
    customPrompt: legacyPromptFromCommandTemplate(
      commitRecipe.commandInputTemplate,
      sourceControlAi.instructionsByOperation.commitMessage ?? previousLegacy?.customPrompt
    ),
    customAgentCommand: sourceControlAi.customAgentCommand
  }
}

export function mergeLegacyCommitMessageAiIntoSourceControlAi(
  sourceControlAi: SourceControlAiSettings | null | undefined,
  legacy: CommitMessageAiSettings | null | undefined,
  options: { pullRequestInstructionsFromLegacy?: boolean } = {}
): SourceControlAiSettings {
  // Why: older runtimes and rollback builds still write commitMessageAi; merge
  // those writes into the new shape without wiping PR-only settings.
  const base = normalizeSourceControlAiSettings(sourceControlAi, legacy)
  if (!legacy) {
    return base
  }
  if (sourceControlAi) {
    const existingCommitChoice = base.modelOverridesByOperation?.commitMessage
    const projectedLegacy = projectSourceControlAiToLegacyCommitMessageAi(base)
    const selectedModelByAgent = mergeLegacyModelSelectionDelta(
      existingCommitChoice?.selectedModelByAgent,
      legacy.selectedModelByAgent,
      projectedLegacy.selectedModelByAgent
    )
    const selectedModelByAgentByHost = mergeLegacyHostModelSelectionDelta(
      existingCommitChoice?.selectedModelByAgentByHost,
      legacy.selectedModelByAgentByHost,
      projectedLegacy.selectedModelByAgentByHost
    )
    const selectedThinkingByModel = mergeLegacyModelSelectionDelta(
      existingCommitChoice?.selectedThinkingByModel,
      legacy.selectedThinkingByModel,
      projectedLegacy.selectedThinkingByModel
    )
    const shouldMergeLegacyModels =
      selectedModelByAgent !== existingCommitChoice?.selectedModelByAgent ||
      selectedModelByAgentByHost !== existingCommitChoice?.selectedModelByAgentByHost ||
      selectedThinkingByModel !== existingCommitChoice?.selectedThinkingByModel
    const nextModelOverridesByOperation = { ...base.modelOverridesByOperation }
    if (shouldMergeLegacyModels) {
      const nextCommitChoice: SourceControlAiModelChoice = {}
      if (hasEntries(selectedModelByAgent)) {
        nextCommitChoice.selectedModelByAgent = selectedModelByAgent
      }
      if (hasEntries(selectedModelByAgentByHost)) {
        nextCommitChoice.selectedModelByAgentByHost = selectedModelByAgentByHost
      }
      if (hasEntries(selectedThinkingByModel)) {
        nextCommitChoice.selectedThinkingByModel = selectedThinkingByModel
      }
      if (Object.keys(nextCommitChoice).length > 0) {
        nextModelOverridesByOperation.commitMessage = nextCommitChoice
      } else {
        delete nextModelOverridesByOperation.commitMessage
      }
    }
    // Why: rollback builds write commitMessageAi, while new builds project
    // commit-message overrides there. Keep those model choices scoped to
    // commit-message generation so PR defaults cannot drift on reload.
    const legacyActionRecipe = actionRecipeFromLegacyCommitMessageAi(legacy)
    const legacyChanges = legacyCommitMessageCoreChanges(legacy, projectedLegacy)
    const shouldMergeLegacyCore = hasLegacyCommitMessageCoreChanges(legacyChanges)
    const shouldMergeBranchPrompt =
      legacyChanges.customPrompt && shouldImportLegacyBranchPrompt(base, projectedLegacy)
    const shouldMergeBranchAgent =
      legacyChanges.agentId && shouldImportLegacyBranchAgent(base, projectedLegacy)
    return normalizeSourceControlAiSettings(
      {
        ...base,
        discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
        discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
        ...(shouldMergeLegacyCore
          ? {
              // Why: legacy commitMessageAi is also our rollback projection.
              // Only import fields that diverged so independent action recipes survive.
              ...(legacyChanges.enabled ? { enabled: legacy.enabled } : {}),
              ...(legacyChanges.agentId ? { agentId: legacy.agentId } : {}),
              ...(legacyChanges.customAgentCommand
                ? { customAgentCommand: legacy.customAgentCommand }
                : {}),
              instructionsByOperation: {
                ...base.instructionsByOperation,
                ...(legacyChanges.customPrompt ? { commitMessage: legacy.customPrompt ?? '' } : {}),
                ...(shouldMergeBranchPrompt ? { branchName: legacy.customPrompt ?? '' } : {}),
                ...(legacyChanges.customPrompt && options.pullRequestInstructionsFromLegacy
                  ? { pullRequest: legacy.customPrompt ?? '' }
                  : {})
              },
              actions: {
                ...base.actions,
                commitMessage: {
                  ...(legacyChanges.agentId
                    ? applyLegacyAgentToActionRecipe(base.actions?.commitMessage, legacy.agentId)
                    : base.actions?.commitMessage),
                  ...(legacyChanges.customPrompt
                    ? {
                        commandInputTemplate: legacyActionRecipe.commandInputTemplate
                      }
                    : {})
                },
                branchName: {
                  ...(shouldMergeBranchAgent
                    ? applyLegacyAgentToActionRecipe(base.actions?.branchName, legacy.agentId)
                    : base.actions?.branchName),
                  ...(shouldMergeBranchPrompt
                    ? {
                        commandInputTemplate: commandTemplateFromOperationInstruction(
                          'branchName',
                          legacy.customPrompt
                        )
                      }
                    : {})
                }
              }
            }
          : {}),
        modelOverridesByOperation: nextModelOverridesByOperation
      },
      shouldMergeLegacyCore ? legacy : undefined
    )
  }
  return normalizeSourceControlAiSettings(
    {
      ...base,
      enabled: legacy.enabled,
      agentId: legacy.agentId,
      selectedModelByAgent: { ...legacy.selectedModelByAgent },
      selectedModelByAgentByHost: copyRecord(legacy.selectedModelByAgentByHost) ?? {},
      discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
      discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
      selectedThinkingByModel: { ...legacy.selectedThinkingByModel },
      customAgentCommand: legacy.customAgentCommand,
      instructionsByOperation: {
        ...base.instructionsByOperation,
        commitMessage: legacy.customPrompt ?? '',
        branchName: legacy.customPrompt ?? '',
        ...(options.pullRequestInstructionsFromLegacy
          ? { pullRequest: legacy.customPrompt ?? '' }
          : {})
      }
    },
    legacy
  )
}
