// The seven lookup bodies `commit-message-agent-spec.ts` held BEFORE the Rust
// cutover, transcribed verbatim from `git show HEAD:src/shared/commit-message-
// agent-spec.ts` at 5dd61f943d and imported by nothing but the two measurement
// suites.
//
// WHY A SECOND COPY OF BODIES THAT ALSO LIVE IN THE SHIM. The shim keeps the same
// bodies as its pre-ready fallback, so comparing the shim's bound answer against
// its own unbound answer can only ever see a TWIN-vs-CORE difference. The
// fallback is a THIRD implementation the moment anyone edits it, and that is not
// hypothetical: the `source-control-ai` cutover shipped a fallback that had
// silently dropped a `?? false` landed an hour earlier, and only a four-way
// comparison — pre-cutover twin unbound, shim unbound, pre-cutover twin bound,
// shim bound — could see it. This module is the fixed reference leg of that
// comparison, so a future edit to the shim's fallback that drifts from the
// behaviour Orca shipped goes red instead of agreeing with itself.
//
// It reads the SAME registry the shim keeps (`COMMIT_MESSAGE_AGENT_SPECS`), so
// nothing here duplicates the agent table — only the lookup logic.
import {
  COMMIT_MESSAGE_AGENT_SPECS,
  DEFAULT_COMMIT_MESSAGE_AGENT_ID,
  CUSTOM_AGENT_ID,
  type CommitMessageAgentCapability,
  type CommitMessageAgentChoice,
  type CommitMessageAgentSpec,
  type CommitMessageModel,
  type CommitMessageModelCapability,
  type CustomAgentId,
  type DefaultTuiAgentPreference
} from './commit-message-agent-spec'
import { withOpenAiThinking } from './commit-message-model-listing'
import { labelFromModelId } from './model-id-label'
import { isTuiAgentEnabled } from './tui-agent-selection-resolution'
import type { TuiAgent } from './types'

export function preCutoverIsCustomAgentId(id: string | null | undefined): id is CustomAgentId {
  return id === CUSTOM_AGENT_ID
}

export function preCutoverGetCommitMessageAgentSpec(
  agentId: TuiAgent
): CommitMessageAgentSpec | undefined {
  return COMMIT_MESSAGE_AGENT_SPECS[agentId]
}

export function preCutoverResolveCommitMessageAgentChoice(
  configuredAgentId: CommitMessageAgentChoice | null | undefined,
  defaultTuiAgent: DefaultTuiAgentPreference,
  disabledTuiAgents?: Iterable<unknown> | null
): CommitMessageAgentChoice | null {
  if (configuredAgentId) {
    return configuredAgentId
  }
  if (
    defaultTuiAgent &&
    defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(defaultTuiAgent, disabledTuiAgents)
  ) {
    return preCutoverGetCommitMessageAgentSpec(defaultTuiAgent) ? defaultTuiAgent : null
  }
  return isTuiAgentEnabled(DEFAULT_COMMIT_MESSAGE_AGENT_ID, disabledTuiAgents)
    ? DEFAULT_COMMIT_MESSAGE_AGENT_ID
    : null
}

export function preCutoverGetCommitMessageModel(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModel | undefined {
  const spec = preCutoverGetCommitMessageAgentSpec(agentId)
  const model = spec?.models.find((m) => m.id === modelId)
  if (model || !spec || spec.modelSource !== 'dynamic' || modelId.trim().length === 0) {
    return model
  }
  return {
    id: modelId,
    label: labelFromModelId(modelId),
    ...withOpenAiThinking(modelId)
  }
}

function preCutoverToCapability(spec: CommitMessageAgentSpec): CommitMessageAgentCapability {
  return {
    id: spec.id,
    label: spec.label,
    modelSource: spec.modelSource,
    defaultModelId: spec.defaultModelId,
    models: spec.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.thinkingLevels ? { thinkingLevels: [...model.thinkingLevels] } : {}),
      ...(model.defaultThinkingLevel ? { defaultThinkingLevel: model.defaultThinkingLevel } : {})
    }))
  }
}

export function preCutoverGetCommitMessageAgentCapability(
  agentId: TuiAgent
): CommitMessageAgentCapability | undefined {
  const spec = preCutoverGetCommitMessageAgentSpec(agentId)
  return spec ? preCutoverToCapability(spec) : undefined
}

export function preCutoverGetCommitMessageModelCapability(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModelCapability | undefined {
  return preCutoverGetCommitMessageAgentCapability(agentId)?.models.find((m) => m.id === modelId)
}

export function preCutoverListCommitMessageAgentIds(): TuiAgent[] {
  return Object.keys(COMMIT_MESSAGE_AGENT_SPECS) as TuiAgent[]
}

export function preCutoverListCommitMessageAgentCapabilities(): CommitMessageAgentCapability[] {
  return preCutoverListCommitMessageAgentIds()
    .map((id) => preCutoverGetCommitMessageAgentCapability(id))
    .filter((capability): capability is CommitMessageAgentCapability => Boolean(capability))
}
