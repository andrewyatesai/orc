// Host-scoped model selection inside one `SourceControlAiModelChoice`: reading
// the model for a host, recording one, and clearing one without disturbing the
// other SSH/runtime hosts.
//
// This is deleted-twin code. `source-control-ai.ts` is now the dispatch shim on
// `orca_git::source_control_ai`; these bodies are its pre-ready `parity` answer
// and its answer for every input the core models differently, and nothing else
// calls them. Change them only alongside the Rust core.
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import type { SourceControlAiModelChoice } from './source-control-ai-types'
import type { TuiAgent } from './types'

export function readSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | null | undefined,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  return (
    choice?.selectedModelByAgentByHost?.[hostKey]?.[agentId] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? choice?.selectedModelByAgent?.[agentId]
      : undefined)
  )
}

export function selectSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | undefined,
  hostKey: string,
  agentId: TuiAgent,
  modelId: string
): SourceControlAiModelChoice {
  const hostSelectedModels = choice?.selectedModelByAgentByHost?.[hostKey] ?? {}
  return {
    ...choice,
    selectedModelByAgent:
      hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
        ? {
            ...choice?.selectedModelByAgent,
            [agentId]: modelId
          }
        : choice?.selectedModelByAgent,
    selectedModelByAgentByHost: {
      ...choice?.selectedModelByAgentByHost,
      [hostKey]: {
        ...hostSelectedModels,
        [agentId]: modelId
      }
    }
  }
}

export function clearSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | undefined,
  hostKey: string,
  agentId: TuiAgent
): SourceControlAiModelChoice | undefined {
  if (!choice) {
    return undefined
  }
  // Why: model choices are host-scoped; clearing one "Use global" selector
  // must not erase a different SSH/runtime host's override.
  const selectedModelByAgent = { ...choice.selectedModelByAgent }
  if (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY) {
    delete selectedModelByAgent[agentId]
  }

  const selectedModelByAgentByHost = { ...choice.selectedModelByAgentByHost }
  const hostModels = { ...selectedModelByAgentByHost[hostKey] }
  delete hostModels[agentId]
  if (Object.keys(hostModels).length > 0) {
    selectedModelByAgentByHost[hostKey] = hostModels
  } else {
    delete selectedModelByAgentByHost[hostKey]
  }

  const nextChoice: SourceControlAiModelChoice = {}
  if (Object.keys(selectedModelByAgent).length > 0) {
    nextChoice.selectedModelByAgent = selectedModelByAgent
  }
  if (Object.keys(selectedModelByAgentByHost).length > 0) {
    nextChoice.selectedModelByAgentByHost = selectedModelByAgentByHost
  }
  const hasModelSelection =
    nextChoice.selectedModelByAgent !== undefined ||
    nextChoice.selectedModelByAgentByHost !== undefined
  if (hasModelSelection && Object.keys(choice.selectedThinkingByModel ?? {}).length > 0) {
    nextChoice.selectedThinkingByModel = choice.selectedThinkingByModel
  }
  return hasModelSelection ? nextChoice : undefined
}
