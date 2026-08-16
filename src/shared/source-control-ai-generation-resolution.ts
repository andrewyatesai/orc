// The whole-operation resolve: agent choice (action recipe over the legacy
// global), model, thinking level, instructions, command template and PR-creation
// defaults, or the message explaining why the operation cannot run.
//
// This is deleted-twin code. `source-control-ai.ts` is now the dispatch shim on
// `orca_git::source_control_ai`; this body is its pre-ready `parity` answer and
// its answer for every input the core models differently, and nothing else calls
// it. Change it only alongside the Rust core.
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  resolveCommitMessageAgentChoice
} from './commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import type { ResolveSourceControlAiInput, ResolveSourceControlAiResult } from './source-control-ai'
import { hasActionAgentRecipe } from './source-control-ai-instruction-templates'
import {
  getDiscoveredModels,
  resolveActionRecipeForTextOperation,
  resolveInstructionsFromNormalized,
  resolvePrCreationDefaults,
  resolveThinkingLevel,
  selectPersistedModelId
} from './source-control-ai-operation-precedence'
import { normalizeRepoSourceControlAiOverrides } from './source-control-ai-repo-override-normalization'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings-normalization'
import type { SourceControlAiOperation } from './source-control-ai-types'
import { collapseDefaultTuiAgentToBuiltin } from './tui-agent-selection-resolution'

const OPERATION_LABEL: Record<SourceControlAiOperation, string> = {
  commitMessage: 'commit messages',
  pullRequest: 'pull request details',
  branchName: 'branch names'
}

function supportedSourceControlAiAgentSummary(): string {
  return `Supported agents: ${listCommitMessageAgentCapabilities()
    .map((capability) => capability.label)
    .join(', ')}, or Custom command.`
}

export function resolveSourceControlAiForOperation(
  input: ResolveSourceControlAiInput
): ResolveSourceControlAiResult {
  const legacy = input.settings.commitMessageAi
  const source = normalizeSourceControlAiSettings(input.settings.sourceControlAi, legacy)
  const repoOverrides = normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)

  const prCreationDefaults = resolvePrCreationDefaults(
    source,
    repoOverrides,
    input.prCreationProductDefaults
  )
  const actionRecipe = resolveActionRecipeForTextOperation(source, repoOverrides, input.operation)
  if (!actionRecipe.commandInputTemplate.trim()) {
    return {
      ok: false,
      error: `Command template is empty for ${OPERATION_LABEL[input.operation]}.`
    }
  }
  // Why: action recipes own the new customization model. The legacy global
  // agent remains a fallback so existing users migrate without losing intent.
  const preferredAgent = hasActionAgentRecipe(actionRecipe) ? actionRecipe.agentId : source.agentId
  const agentChoice = resolveCommitMessageAgentChoice(
    preferredAgent,
    collapseDefaultTuiAgentToBuiltin(input.settings.defaultTuiAgent, input.settings.customAgents),
    input.settings.disabledTuiAgents
  )
  if (!agentChoice) {
    return {
      ok: false,
      error: `Choose a supported Source Control AI agent for this action in Settings -> Git -> Source Control AI. ${supportedSourceControlAiAgentSummary()}`
    }
  }

  // Both operands optional-chain. `sourceControlAiSettingsFromLegacy` produces an
  // OWN `customAgentCommand: undefined` for a legacy blob that has none — the
  // shape persistence.ts:3286 builds — so the unguarded `.trim()` threw
  // "Cannot read properties of undefined" for a settings object the app itself
  // creates. The repoOverrides operand on this same line was already guarded.
  const customAgentCommand =
    repoOverrides?.customAgentCommand?.trim() || (source.customAgentCommand?.trim() ?? '')
  if (isCustomAgentId(agentChoice)) {
    if (!customAgentCommand) {
      return {
        ok: false,
        error: 'Custom command is empty. Add one in Settings -> Git -> Source Control AI.'
      }
    }
    return {
      ok: true,
      value: {
        enabled: true,
        params: {
          agentId: CUSTOM_AGENT_ID,
          model: '',
          customPrompt: resolveInstructionsFromNormalized(
            source,
            repoOverrides,
            input.operation,
            legacy?.customPrompt
          ),
          commandInputTemplate: actionRecipe.commandInputTemplate,
          ...(actionRecipe.agentArgs !== undefined ? { agentArgs: actionRecipe.agentArgs } : {}),
          customAgentCommand
        },
        prCreationDefaults
      }
    }
  }

  const agentId = agentChoice
  const actionAgentId = actionRecipe.agentId ?? agentId
  const resolvedActionAgentId =
    actionAgentId === agentId
      ? agentId
      : resolveCommitMessageAgentChoice(
          actionAgentId,
          collapseDefaultTuiAgentToBuiltin(
            input.settings.defaultTuiAgent,
            input.settings.customAgents
          ),
          input.settings.disabledTuiAgents
        )
  if (!resolvedActionAgentId || isCustomAgentId(resolvedActionAgentId)) {
    return {
      ok: false,
      error: `Choose a supported Source Control AI agent for this action. ${supportedSourceControlAiAgentSummary()}`
    }
  }
  const spec = getCommitMessageAgentSpec(resolvedActionAgentId)
  if (!spec) {
    return {
      ok: false,
      error: `Agent "${resolvedActionAgentId}" does not support Source Control AI ${OPERATION_LABEL[input.operation]}. ${supportedSourceControlAiAgentSummary()}`
    }
  }

  const hostKey = input.discoveryHostKey ?? LOCAL_COMMIT_MESSAGE_HOST_KEY
  const persistedModelId = selectPersistedModelId({
    source,
    legacy,
    repoOverrides,
    operation: input.operation,
    hostKey,
    agentId: resolvedActionAgentId,
    defaultModelId: spec.defaultModelId
  })
  const discoveredModels = getDiscoveredModels(source, legacy, hostKey, resolvedActionAgentId)
  const model =
    spec.models.find((candidate) => candidate.id === persistedModelId) ??
    discoveredModels.find((candidate) => candidate.id === persistedModelId) ??
    getCommitMessageModel(resolvedActionAgentId, spec.defaultModelId)
  if (!model) {
    return { ok: false, error: `No model is available for ${spec.label}.` }
  }

  const thinkingLevel = resolveThinkingLevel({
    model,
    source,
    legacy,
    repoOverrides,
    operation: input.operation
  })
  const agentCommandOverride = input.settings.agentCmdOverrides?.[resolvedActionAgentId]?.trim()
  return {
    ok: true,
    value: {
      enabled: true,
      params: {
        agentId: resolvedActionAgentId,
        model: model.id,
        thinkingLevel,
        customPrompt: resolveInstructionsFromNormalized(
          source,
          repoOverrides,
          input.operation,
          legacy?.customPrompt
        ),
        commandInputTemplate: actionRecipe.commandInputTemplate,
        ...(actionRecipe.agentArgs !== undefined ? { agentArgs: actionRecipe.agentArgs } : {}),
        ...(customAgentCommand ? { customAgentCommand } : {}),
        ...(agentCommandOverride ? { agentCommandOverride } : {})
      },
      prCreationDefaults
    }
  }
}
