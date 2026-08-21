// How a source-control AI action recipe's two inherited slots are read: the
// command template an instruction derives (and the reverse projection back to a
// legacy prompt), and whether a recipe declares an agent of its own.
//
// This is deleted-twin code. `source-control-ai.ts` is now the dispatch shim on
// `orca_git::source_control_ai`; these bodies are its pre-ready `parity` answer
// and its answer for every input the core models differently, and nothing else
// calls them. Change them only alongside the Rust core.
import type { CustomAgentId } from './commit-message-agent-spec'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiOperation
} from './source-control-ai-types'
import type { TuiAgent } from './types'

export function commandTemplateFromInstruction(instruction: string | null | undefined): string {
  const trimmed = instruction?.trim()
  if (!trimmed) {
    return '{basePrompt}'
  }
  return ['{basePrompt}', '', trimmed].join('\n')
}

export function commandTemplateFromOperationInstruction(
  operation: SourceControlAiOperation,
  instruction: string | null | undefined
): string {
  const trimmed = instruction?.trim()
  if (!trimmed) {
    return '{basePrompt}'
  }
  // Why: branch naming instructions define naming style, so they must precede
  // the general built-in prompt. Other operations retain their released order.
  return operation === 'branchName'
    ? [trimmed, '', '{basePrompt}'].join('\n')
    : commandTemplateFromInstruction(trimmed)
}

export function isLegacyBranchInstructionTemplate(
  operation: SourceControlAiOperation,
  instruction: string | null | undefined,
  template: string | null | undefined
): boolean {
  // Why: reorder only the exact template older settings derived automatically;
  // a user-authored command template remains authoritative.
  return (
    operation === 'branchName' &&
    Boolean(instruction?.trim()) &&
    template === commandTemplateFromInstruction(instruction)
  )
}

export function legacyPromptFromCommandTemplate(
  template: string | undefined,
  fallback: string | undefined
): string {
  const trimmed = template?.trim()
  if (!trimmed || trimmed === '{basePrompt}') {
    return fallback ?? ''
  }
  if (trimmed.startsWith('{basePrompt}')) {
    return trimmed.slice('{basePrompt}'.length).trim()
  }
  return trimmed
}

export function hasActionAgentRecipe(recipe: {
  agentId?: TuiAgent | CustomAgentId | null
}): recipe is { agentId: TuiAgent | CustomAgentId | null } {
  return Object.hasOwn(recipe, 'agentId')
}

function hasOwnInstruction(
  instructions: Partial<Record<SourceControlAiOperation, string | null>> | null | undefined,
  operation: SourceControlAiOperation
): boolean {
  return Object.hasOwn(instructions ?? {}, operation)
}

export function readRepoInstructionOverride(
  instructions: RepoSourceControlAiOverrides['instructionsByOperation'],
  operation: SourceControlAiOperation
): string | undefined {
  if (!hasOwnInstruction(instructions, operation)) {
    return undefined
  }
  const instruction = instructions?.[operation]
  return typeof instruction === 'string' ? instruction : undefined
}
