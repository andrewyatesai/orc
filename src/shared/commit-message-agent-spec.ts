import type { TuiAgent } from './types'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { isOrcaDispatchReady, tryOrcaDispatch } from './orca-dispatch-seam'
import { isTuiAgentEnabled } from './tui-agent-selection-resolution'
import { labelFromModelId } from './model-id-label'
import {
  OPENAI_THINKING_LEVELS,
  parseAntigravityModels,
  parseCodexModels,
  parseCursorModels,
  parseLineModels,
  parsePiModels,
  withOpenAiThinking
} from './commit-message-model-listing'

/* eslint-disable max-lines -- Why: this is the single registry for non-interactive commit-message agents, their model discovery parsers, and UI capabilities. */

// Why: this file is the source of truth for non-interactive agent invocation
// (commit-message generation). It is intentionally separate from
// `tui-agent-config.ts`, which describes interactive PTY launching — mixing
// the two confuses both code paths.
//
// The five model-discovery parsers are NOT here any more: they run on the Rust
// `orca_agents::commit_message_models` core through
// `commit-message-model-listing.ts`, which every `modelDiscovery.parse` field
// below points at. The dependency runs ONE WAY (this file -> the listing
// module), which is why the OpenAI effort table and the Codex JSON budget moved
// there with them: `withOpenAiThinking` is needed by both halves, and a value
// cycle between two `src/shared` modules is the hazard that made the last one
// need a deferred call.
//
// THE SEVEN LOOKUPS NOW RUN ON `orca_agents::commit_message_agent_spec`, over the
// shared dispatch seam. Cut over IN PLACE: same path, same export names, so no
// importer's import line changed and what moved is the implementation. The
// deleted bodies stay below as the pre-ready fallback and are exported as
// `COMMIT_MESSAGE_AGENT_SPEC_LOOKUP_FALLBACKS`.
//
// `getCommitMessageAgentSpec` IS NOT ROUTED, and cannot be. Its return value
// carries two FUNCTION-VALUED fields, and JSON has no image for a function:
// `JSON.parse(JSON.stringify(spec))` drops `buildArgs` entirely and reduces
// `modelDiscovery` to `{binary, args}`. Both are called — `modelDiscovery.parse`
// in production (`main/text-generation/commit-message-text-generation.ts:256`,
// on the local and SSH-remote discovery paths) and `buildArgs` by this module's
// suite. `agent-model-probe-spec.test.ts` also asserts REFERENCE identity
// (`getAgentModelProbeSpec(id) === getCommitMessageAgentSpec(id)`), which a
// per-call crossing cannot hold. The BEHAVIOUR of both closures is already on
// Rust anyway — `buildArgs` through `commit_message_plan`
// (`planCommitMessageGeneration` builds the spawn argv in production, not this
// field) and `modelDiscovery.parse` through `commit_message_models` — so what
// stays in TypeScript is the accessor and the registry it reads, not logic that
// has no Rust twin. `orca-dispatch` deliberately registers no arm for it; the
// crate's `get_commit_message_agent_spec` exists and is used by the other arms.
//
// ON THE SEAM rather than one surface's binding: the registry is read from
// `src/shared` itself (`source-control-ai-generation-resolution.ts`,
// `agent-model-probe-spec.ts`), from main (`commit-message-text-generation.ts`)
// and from ~8 renderer components, so the reference must resolve under napi and
// wasm alike.
//
// PRE-READY CONTRACT — `parity` for all seven, and it is FORCED:
//  * `source-control-action-recipe-options.ts:18` builds a module-level
//    `TEXT_GENERATION_AGENT_ID_SET` from `listCommitMessageAgentCapabilities()`
//    AT IMPORT TIME in the renderer, i.e. before wasm init, and never recomputes
//    it; `SourceControlTextGenerationDialogForm.tsx:93` memoizes the same list
//    with an empty dep array. A pre-ready answer that is not the twin's answer is
//    frozen for the session.
//  * `getCommitMessageModel`'s answer becomes `params.model`, the `--model` argv
//    of the next agent spawn, and `resolveCommitMessageAgentChoice`'s answer
//    becomes `params.agentId`. No sentinel is available for either: both already
//    spend `undefined`/`null` on "no such model" and "no agent qualifies".
// So the fallback is the deleted body over the registry that stayed in
// TypeScript, which makes pre-ready equal ready for every input.
//
// MEASURED, NOT ASSUMED, and four ways — HEAD's twin and this shim, each unbound
// and each bound — because the fallback is a FOURTH implementation and a
// twin-vs-core differential is blind to it (that is exactly the class the
// source-control-ai cutover found). The pre-cutover bodies are frozen in
// `commit-message-agent-spec-pre-cutover-lookups.ts`;
// `commit-message-agent-spec-pre-ready.test.ts` runs the named edge classes and
// proves each arm is really reached, and
// `commit-message-agent-spec-shape-coverage.test.ts` runs the shape cross
// product and reports byte, value and strict images separately.
//
// DECLARED RESIDUALS — each one an input the twin answered and the core models
// differently, so the payload is REFUSED and the twin's body answers, including
// where the twin threw:
//  1. A PROTOTYPE-CHAIN agent id. `COMMIT_MESSAGE_AGENT_SPECS[agentId]` is a raw
//     property read, so `'toString'`/`'constructor'`/`'__proto__'` resolve to
//     Object.prototype's member; the twin then dereferences `.models` on it and
//     throws `TypeError`, or (in `resolveCommitMessageAgentChoice`) returns the
//     key as if it were an agent. The core scans a table and answers null.
//  2. A NON-STRING agent id, which that same property read COERCES —
//     `getCommitMessageModel(['claude'], 'haiku')` answers with Claude's model.
//     The core reads `as_str` and answers null.
//  3. A NON-STRING model id. On a dynamic agent with no catalog hit the twin
//     calls `modelId.trim()` and CRASHES; the core reads `""`.
//  4. A NON-STRING `configuredAgentId`/`defaultTuiAgent`: the twin returns a
//     truthy non-string configured id VERBATIM and answers null for a truthy
//     non-string default, where the core reads both as absent and falls through
//     to `claude`.
//  5. A payload the codec refuses — a lone UTF-16 surrogate in a model id (these
//     ids arrive off persisted settings and the SSH relay), or an exotic object
//     inside `disabledTuiAgents`.
// Residual with no refusal: `getCommitMessageModel` used to hand back the
// registry's OWN model object, so two calls were reference-equal and a mutation
// would have edited the table; a crossed answer is a fresh object per call.
// Value- and byte-identical, and nothing reads it by identity.

export type ThinkingLevel = { id: string; label: string }

export type CommitMessageModel = {
  /** Value passed to the agent CLI's --model flag. */
  id: string
  /** Visible label in the model dropdown. */
  label: string
  /** Omit when the model does not expose an effort selector — the UI then hides the dropdown. */
  thinkingLevels?: ThinkingLevel[]
  /** Required when thinkingLevels is present. */
  defaultThinkingLevel?: string
  /** Set when the listing marks this as the id the CLI runs with no --model flag.
   *  Optional so an older remote host that never reports it simply omits it. */
  isDefault?: boolean
}

export type CommitMessageAgentSpec = {
  id: TuiAgent
  /** Visible label in the agent dropdown. */
  label: string
  /** Binary spawned in non-interactive mode. */
  binary: string
  /** Where the prompt is delivered. Large diffs go via stdin to avoid argv limits. */
  promptDelivery: 'argv' | 'stdin'
  buildArgs: (params: { prompt: string; model: string; thinkingLevel?: string }) => string[]
  /** Whether the model list is static or discovered from the agent CLI. */
  modelSource: 'static' | 'dynamic'
  /** Command used by the main process to discover models when modelSource is dynamic. */
  modelDiscovery?: {
    binary: string
    args: string[]
    parse: (stdout: string) => CommitMessageModel[]
  }
  models: CommitMessageModel[]
  defaultModelId: string
}

export type CommitMessageModelCapability = {
  id: string
  label: string
  thinkingLevels?: ThinkingLevel[]
  defaultThinkingLevel?: string
  /** Absent from an older remote host, which simply yields no default to display. */
  isDefault?: boolean
}

export type CommitMessageAgentCapability = {
  id: TuiAgent
  label: string
  modelSource: 'static' | 'dynamic'
  models: CommitMessageModelCapability[]
  defaultModelId: string
}

// Why re-exported rather than declared here: the budget bounds the Codex listing
// parser, which moved to `commit-message-model-listing.ts`. Re-exporting keeps
// this module's public surface exactly what it was.
export { COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS } from './commit-message-model-listing'

const BASIC_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

const CLAUDE_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' }
]

export const COMMIT_MESSAGE_AGENT_SPECS: Partial<Record<TuiAgent, CommitMessageAgentSpec>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    binary: 'claude',
    // Why: diffs can be large and `claude -p` reads from stdin natively when no
    // positional prompt is provided.
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '-p',
      '--output-format',
      'text',
      '--model',
      model,
      '--permission-mode',
      'plan',
      ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
    ],
    modelSource: 'static',
    models: [
      {
        // Why: Claude Code aliases track the account/provider's supported
        // model IDs; hardcoded version IDs can be rejected by Bedrock/Vertex.
        id: 'haiku',
        label: 'Haiku'
      },
      {
        id: 'sonnet',
        label: 'Sonnet',
        thinkingLevels: CLAUDE_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'opus',
        label: 'Opus',
        thinkingLevels: CLAUDE_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'sonnet'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    // Why: `codex exec` reads stdin when no prompt arg is supplied. Commit
    // prompts include large staged diffs, so argv would exceed Windows and
    // some SSH/POSIX command-line limits.
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      'exec',
      // Why: commit-message generation needs text only, not a persisted agent
      // session or workspace writes. Match the safe git-text mode used by
      // local-first coding agents.
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      model,
      ...(thinkingLevel ? ['-c', `model_reasoning_effort=${thinkingLevel}`] : [])
    ],
    modelSource: 'dynamic',
    modelDiscovery: {
      binary: 'codex',
      args: ['debug', 'models'],
      parse: parseCodexModels
    },
    // Why: ordered to match the official `codex` model picker — descending
    // by version so the frontier model lands on top and legacy models trail.
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        // Why: Codex's Spark variant accepts `model_reasoning_effort` (the
        // CLI banner reports "reasoning effort: medium" by default); the
        // gating that surfaces "model not supported" is on the account
        // tier, not the effort flag.
        id: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'gpt-5.5'
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    // Why: Source Control AI prompts can include large staged diffs; OpenCode
    // accepts the prompt on stdin, which avoids cross-platform argv limits.
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      'run',
      '--model',
      model,
      '--agent',
      'build',
      '--format',
      'default',
      ...(thinkingLevel ? ['--variant', thinkingLevel] : [])
    ],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'opencode', args: ['models'], parse: parseLineModels },
    models: [
      {
        // Why: OpenCode's hosted GPT models can require workspace billing even
        // when `opencode models` lists them. This free model is available in
        // discovery and works as a usable out-of-the-box default.
        id: 'opencode/deepseek-v4-flash-free',
        label: 'OpenCode DeepSeek V4 Flash Free'
      },
      {
        id: 'opencode/gpt-5.4-mini',
        label: 'OpenCode GPT 5.4 Mini',
        ...withOpenAiThinking('gpt-5.4-mini')
      }
    ],
    defaultModelId: 'opencode/deepseek-v4-flash-free'
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    binary: 'pi',
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '--print',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-context-files',
      '--mode',
      'text',
      '--model',
      model,
      ...(thinkingLevel ? ['--thinking', thinkingLevel] : [])
    ],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'pi', args: ['--list-models'], parse: parsePiModels },
    models: [
      {
        // Why: Pi commonly authenticates through GitHub Copilot locally; using
        // that provider avoids selecting a raw OpenAI model when no key exists.
        id: 'github-copilot/gpt-5.4-mini',
        label: 'Github Copilot GPT 5.4 Mini',
        ...withOpenAiThinking('gpt-5.4-mini')
      }
    ],
    defaultModelId: 'github-copilot/gpt-5.4-mini'
  },
  amp: {
    id: 'amp',
    label: 'Amp',
    binary: 'amp',
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '--execute',
      '--no-notifications',
      '--no-ide',
      '--no-jetbrains',
      '--mode',
      model,
      ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
    ],
    modelSource: 'static',
    models: [
      { id: 'smart', label: 'Smart' },
      { id: 'rush', label: 'Rush' },
      {
        id: 'large',
        label: 'Large',
        thinkingLevels: BASIC_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'deep',
        label: 'Deep',
        thinkingLevels: BASIC_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'smart'
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    binary: 'cursor-agent',
    promptDelivery: 'argv',
    buildArgs: ({ prompt, model }) => [
      '--print',
      '--mode',
      'ask',
      '--trust',
      '--output-format',
      'text',
      '--model',
      model,
      prompt
    ],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'cursor-agent', args: ['--list-models'], parse: parseCursorModels },
    models: [{ id: 'auto', label: 'Auto' }],
    defaultModelId: 'auto'
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    binary: 'kimi',
    // Why: kimi-code accepts the generation prompt only via --prompt/-p (Claude's
    // --print is rejected). Deliver on argv so --prompt receives the text (#11669).
    promptDelivery: 'argv',
    buildArgs: ({ prompt, model, thinkingLevel }) => [
      '--prompt',
      prompt,
      '--quiet',
      ...(model && model !== 'default' ? ['--model', model] : []),
      ...(thinkingLevel === 'on'
        ? ['--thinking']
        : thinkingLevel === 'off'
          ? ['--no-thinking']
          : [])
    ],
    modelSource: 'static',
    models: [
      { id: 'default', label: 'Config default' },
      {
        // Why: Kimi resolves its managed model by provider/model; bare model
        // names are rejected by the CLI with "LLM not set".
        id: 'kimi-code/kimi-for-coding',
        label: 'Kimi K2.6',
        thinkingLevels: [
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' }
        ],
        defaultThinkingLevel: 'on'
      }
    ],
    defaultModelId: 'default'
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    binary: 'copilot',
    promptDelivery: 'argv',
    buildArgs: ({ prompt, model, thinkingLevel }) => [
      '--prompt',
      prompt,
      '--silent',
      '--stream',
      'off',
      '--no-custom-instructions',
      '--model',
      model,
      ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
    ],
    modelSource: 'static',
    // Why: Copilot CLI's picker is policy-filtered per account/org. Keep the
    // full hosted CLI catalog here so users can select models enabled for them.
    models: [
      { id: 'auto', label: 'Auto' },
      {
        id: 'claude-haiku-4.5',
        label: 'Claude Haiku 4.5'
      },
      {
        id: 'claude-sonnet-4.5',
        label: 'Claude Sonnet 4.5'
      },
      {
        id: 'claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6'
      },
      {
        id: 'claude-opus-4.5',
        label: 'Claude Opus 4.5'
      },
      {
        id: 'claude-opus-4.6',
        label: 'Claude Opus 4.6'
      },
      {
        id: 'claude-opus-4.6-fast',
        label: 'Claude Opus 4.6 Fast'
      },
      {
        id: 'claude-opus-4.7',
        label: 'Claude Opus 4.7'
      },
      {
        id: 'gpt-4.1',
        label: 'GPT-4.1'
      },
      {
        id: 'gpt-5-mini',
        label: 'GPT-5 Mini',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.2-codex',
        label: 'GPT-5.2 Codex',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'gpt-5.4'
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    binary: 'agy',
    promptDelivery: 'stdin',
    buildArgs: ({ model }) => ['--print', '--sandbox', '--model', model],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'agy', args: ['models'], parse: parseAntigravityModels },
    models: [
      { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
      { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' },
      { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash (Low)' }
    ],
    defaultModelId: 'Gemini 3.5 Flash (Medium)'
  }
}

export const DEFAULT_COMMIT_MESSAGE_AGENT_ID: TuiAgent = 'claude'

// Why: the "custom" choice is not a TuiAgent — it lets the user point Orca
// at any CLI by typing a command template (see the customAgentCommand setting;
// the template is planned into a spawn command by the Rust commit-message plan,
// via planCommitMessageGeneration). Keeping it as its own sentinel avoids
// polluting TuiAgent (shared with PTY launch / new-workspace flows that have
// nothing to do with this feature).
export const CUSTOM_AGENT_ID = 'custom' as const
export type CustomAgentId = typeof CUSTOM_AGENT_ID
export type CommitMessageAgentChoice = TuiAgent | CustomAgentId
export type DefaultTuiAgentPreference = TuiAgent | 'blank' | null | undefined

/** Stays in TypeScript: the answer carries `buildArgs` and `modelDiscovery.parse`,
 *  which JSON cannot express. See the residual note at the top of the file. */
export function getCommitMessageAgentSpec(agentId: TuiAgent): CommitMessageAgentSpec | undefined {
  return COMMIT_MESSAGE_AGENT_SPECS[agentId]
}

// --- the deleted bodies, verbatim: the pre-ready answer and the
// --- out-of-representation answer, never a second implementation ---

function localIsCustomAgentId(id: unknown): boolean {
  return id === CUSTOM_AGENT_ID
}

function localResolveAgentChoice(
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
    return getCommitMessageAgentSpec(defaultTuiAgent) ? defaultTuiAgent : null
  }
  return isTuiAgentEnabled(DEFAULT_COMMIT_MESSAGE_AGENT_ID, disabledTuiAgents)
    ? DEFAULT_COMMIT_MESSAGE_AGENT_ID
    : null
}

function localGetModel(agentId: TuiAgent, modelId: string): CommitMessageModel | undefined {
  const spec = getCommitMessageAgentSpec(agentId)
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

function toCommitMessageAgentCapability(
  spec: CommitMessageAgentSpec
): CommitMessageAgentCapability {
  return {
    id: spec.id,
    label: spec.label,
    modelSource: spec.modelSource,
    defaultModelId: spec.defaultModelId,
    // Why: renderer/settings should consume provider capabilities, not the
    // spawn contract. Copy the model metadata so future dynamic probes can
    // swap this source without leaking binary/argv details into UI code.
    models: spec.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.thinkingLevels ? { thinkingLevels: [...model.thinkingLevels] } : {}),
      ...(model.defaultThinkingLevel ? { defaultThinkingLevel: model.defaultThinkingLevel } : {})
    }))
  }
}

function localGetAgentCapability(agentId: TuiAgent): CommitMessageAgentCapability | undefined {
  const spec = getCommitMessageAgentSpec(agentId)
  return spec ? toCommitMessageAgentCapability(spec) : undefined
}

function localGetModelCapability(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModelCapability | undefined {
  return localGetAgentCapability(agentId)?.models.find((m) => m.id === modelId)
}

function localListAgentIds(): TuiAgent[] {
  return Object.keys(COMMIT_MESSAGE_AGENT_SPECS) as TuiAgent[]
}

function localListAgentCapabilities(): CommitMessageAgentCapability[] {
  return localListAgentIds()
    .map((id) => localGetAgentCapability(id))
    .filter((capability): capability is CommitMessageAgentCapability => Boolean(capability))
}

// --- the crossing ---

/** The seam did not answer: unbound, or a payload it refused to encode. Kept
 *  apart from `null`, which three of these exports mean as a real answer. */
const NOT_CROSSED = Symbol('commit-message-agent-spec: the Rust core did not answer')

function cross(fn: string, input: unknown, root: string): unknown | typeof NOT_CROSSED {
  if (!isOrcaDispatchReady()) {
    return NOT_CROSSED
  }
  try {
    // The module key stays a string LITERAL: report-rust-orphan-ports.mjs can only
    // attribute a dispatch site whose key is a literal node.
    return tryOrcaDispatch('commit-message-agent-spec', fn, input, { root })
  } catch (error) {
    // Why the catch: model ids arrive off persisted settings and off the SSH
    // relay, so they can carry a lone UTF-16 surrogate the codec refuses, and
    // `disabledTuiAgents` is whatever the settings file held. The twin answered
    // those. A DispatchCoreError still propagates — an unknown function is a
    // wiring bug, not a degraded input.
    if (error instanceof DispatchPayloadError) {
      return NOT_CROSSED
    }
    throw error
  }
}

/** Whether `COMMIT_MESSAGE_AGENT_SPECS[agentId]` is a lookup the core can model.
 *  It is a raw property read, so a non-string key is COERCED to one and a
 *  prototype key resolves to `Object.prototype`'s member — residuals 1 and 2. */
function isRegistryLookupKey(agentId: unknown): agentId is TuiAgent {
  return (
    typeof agentId === 'string' &&
    (Object.hasOwn(COMMIT_MESSAGE_AGENT_SPECS, agentId) || !(agentId in COMMIT_MESSAGE_AGENT_SPECS))
  )
}

/** The twin only ever read an ARRAY of disabled ids (through `isTuiAgentEnabled`,
 *  which does the same narrowing), so every other iterable disabled nothing. */
function disabledArray(disabled: Iterable<unknown> | null | undefined): unknown[] {
  return Array.isArray(disabled) ? (disabled as unknown[]) : []
}

export function isCustomAgentId(id: string | null | undefined): id is CustomAgentId {
  const answer = cross('isCustomAgentId', id, 'id')
  return answer === NOT_CROSSED ? localIsCustomAgentId(id) : (answer as boolean)
}

export function resolveCommitMessageAgentChoice(
  configuredAgentId: CommitMessageAgentChoice | null | undefined,
  defaultTuiAgent: DefaultTuiAgentPreference,
  disabledTuiAgents?: Iterable<unknown> | null
): CommitMessageAgentChoice | null {
  // Widened on purpose: both preferences are read straight off persisted
  // settings, so the runtime value may not match the declared union.
  const configured: unknown = configuredAgentId
  const preferred: unknown = defaultTuiAgent
  const crossable =
    (configured === null || configured === undefined || typeof configured === 'string') &&
    (preferred === null || preferred === undefined || isRegistryLookupKey(preferred))
  if (!crossable) {
    return localResolveAgentChoice(configuredAgentId, defaultTuiAgent, disabledTuiAgents)
  }
  const answer = cross(
    'resolveCommitMessageAgentChoice',
    {
      configuredAgentId: configuredAgentId ?? null,
      defaultTuiAgent: defaultTuiAgent ?? null,
      disabledTuiAgents: disabledArray(disabledTuiAgents)
    },
    'resolveCommitMessageAgentChoice'
  )
  return answer === NOT_CROSSED
    ? localResolveAgentChoice(configuredAgentId, defaultTuiAgent, disabledTuiAgents)
    : (answer as CommitMessageAgentChoice | null)
}

export function getCommitMessageModel(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModel | undefined {
  if (!isRegistryLookupKey(agentId) || typeof modelId !== 'string') {
    return localGetModel(agentId, modelId)
  }
  const answer = cross('getCommitMessageModel', { agentId, modelId }, 'getCommitMessageModel')
  if (answer === NOT_CROSSED) {
    return localGetModel(agentId, modelId)
  }
  // `Value::Null` is how the arm spells TS `undefined`; no lookup answers a real null.
  return answer === null ? undefined : (answer as CommitMessageModel)
}

export function getCommitMessageAgentCapability(
  agentId: TuiAgent
): CommitMessageAgentCapability | undefined {
  if (!isRegistryLookupKey(agentId)) {
    return localGetAgentCapability(agentId)
  }
  const answer = cross(
    'getCommitMessageAgentCapability',
    { agentId },
    'getCommitMessageAgentCapability'
  )
  if (answer === NOT_CROSSED) {
    return localGetAgentCapability(agentId)
  }
  return answer === null ? undefined : (answer as CommitMessageAgentCapability)
}

export function getCommitMessageModelCapability(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModelCapability | undefined {
  if (!isRegistryLookupKey(agentId) || typeof modelId !== 'string') {
    return localGetModelCapability(agentId, modelId)
  }
  const answer = cross(
    'getCommitMessageModelCapability',
    { agentId, modelId },
    'getCommitMessageModelCapability'
  )
  if (answer === NOT_CROSSED) {
    return localGetModelCapability(agentId, modelId)
  }
  return answer === null ? undefined : (answer as CommitMessageModelCapability)
}

/** Ordered list of agents that have a non-interactive mode wired up. */
export function listCommitMessageAgentIds(): TuiAgent[] {
  const answer = cross('listCommitMessageAgentIds', undefined, 'listCommitMessageAgentIds')
  return answer === NOT_CROSSED ? localListAgentIds() : (answer as TuiAgent[])
}

export function listCommitMessageAgentCapabilities(): CommitMessageAgentCapability[] {
  const answer = cross(
    'listCommitMessageAgentCapabilities',
    undefined,
    'listCommitMessageAgentCapabilities'
  )
  return answer === NOT_CROSSED
    ? localListAgentCapabilities()
    : (answer as CommitMessageAgentCapability[])
}

/** The deleted bodies, exported for the suites that compare pre-ready against
 *  ready without reaching through the seam to do it. */
export const COMMIT_MESSAGE_AGENT_SPEC_LOOKUP_FALLBACKS = {
  isCustomAgentId: localIsCustomAgentId,
  resolveCommitMessageAgentChoice: localResolveAgentChoice,
  getCommitMessageModel: localGetModel,
  getCommitMessageAgentCapability: localGetAgentCapability,
  getCommitMessageModelCapability: localGetModelCapability,
  listCommitMessageAgentIds: localListAgentIds,
  listCommitMessageAgentCapabilities: localListAgentCapabilities
} as const
