// Source-control AI settings, migration and per-operation precedence on the Rust
// `orca_git::source_control_ai` core, over the shared dispatch seam.
//
// The module KEEPS ITS NAME AND ITS EXPORTS: every caller's import line is
// unchanged, and what moved is the implementation. The deleted twin's bodies live
// in `source-control-ai-{instruction-templates,repo-override-normalization,
// settings-normalization,legacy-model-selection-delta,legacy-commit-message-merge,
// host-model-choice,operation-precedence,generation-resolution}.ts` — split
// because the twin was one 1343-line file behind a `max-lines` bypass, and the
// bypass is now GONE from `config/max-lines-baseline.txt`.
//
// On the SEAM rather than one surface's binding because all four binding-holding
// surfaces call these: main (`persistence.ts` normalizes/merges/projects the
// settings blob on every read and write, `ipc/repos.ts` and
// `rpc/methods/repo-update-schema.ts` sanitize the repo override,
// `text-generation/commit-message-text-generation.ts` resolves the operation),
// the renderer (Settings, the repository SC-AI pane, CommitArea, ChecksPanel, the
// PR dialog, the fix-with-AI launchers — wasm at ready), `src/shared` itself
// (`constants.ts` builds the default settings, `source-control-ai-recipe-save.ts`)
// and the SSH relay through that shared surface.
//
// PRE-READY CONTRACT — `parity` for all fifteen exports, and it is FORCED TWICE.
//
//  1. By the surfaces. These settings are PERSISTED PER REPO and decide WHICH
//     MODEL runs a commit message, PR body or branch name, so a pre-ready answer
//     that is not the twin's answer gets written back:
//     `getDefaultSourceControlAiSettings` IS the `sourceControlAi` member of
//     `getDefaultSettings()` (`constants.ts:431`), the object a first run saves;
//     the two normalizers are the sanitizers on both sides; merge/project are the
//     rollback bridge. No sentinel is available for the rest either — the
//     predicates are consumed inside `if`, `resolveSourceControlAiInstructions`
//     already spends `''` on "no instructions",
//     `resolveSourceControlAiForOperation` already spends `{ok:false, error}` on
//     failure, and the three model-choice helpers already spend `undefined` on
//     "no choice recorded".
//  2. By the input contract, which is why NO export can take `requireOrcaDispatch`
//     and drop its body — not even the three whose only callers are main
//     (`sourceControlAiSettingsFromLegacy`,
//     `mergeLegacyCommitMessageAiIntoSourceControlAi`,
//     `projectSourceControlAiToLegacyCommitMessageAi`, all `persistence.ts` /
//     `orca-runtime-git.ts`, where the seam is bound at bootstrap). The twin's
//     body is ALSO the answer for every input the core models differently
//     (residual 3 below), so deleting it would change behaviour on a persisted
//     settings file, not just before wasm.
//
// Measured, not asserted, in `source-control-ai-pre-ready.test.ts` (the named
// edge cases) and `source-control-ai-shape-coverage.test.ts` (the shape cross
// product): every case runs unbound and again on the SHIPPED wasm core and the
// two answers must match, a counting binding proves each export really reached
// its arm, and the corpus half is `pnpm parity` driving this shim unbound over
// the shared vectors.
//
// NULL AT THE SEAM IS NOT ONE THING. Three exports can answer TS `undefined`
// (`readSourceControlAiModelChoiceForHost`,
// `clearSourceControlAiModelChoiceForHost`,
// `normalizeRepoSourceControlAiOverrides`) and the arm spells that case
// `Value::Null`, because `undefined` has no JSON image. For THOSE THREE a crossed
// `null` is mapped back to `undefined`. For the other twelve a top-level `null`
// is not a value the twin can return at all, so it is never reinterpreted — and
// "the seam did not run" is carried by `NOT_CROSSED`, never by `null`, so "no
// choice recorded" can never become "the choice is null".
//
// DECLARED RESIDUALS, all reachable:
//  1. The payload is encoded with `{undefinedProperties: 'omit'}` (in
//     `source-control-ai-core-crossing.ts`), so an own property whose value is
//     `undefined` arrives ABSENT. It cannot be 'reject' —
//     `normalizeSourceControlAiSettings` itself returns
//     `modelOverridesByOperation: undefined` as an own key and its output is the
//     next call's input — and it is NOT universally answer-preserving, which is
//     why `source-control-ai-core-representable.ts` exists. The twin spreads
//     (`{...defaults, ...base}`), so a present-`undefined` SHADOWS the default
//     where an absent key INHERITS it, and `hasEntries` counts an own key holding
//     `undefined` that `normalize_string_record` never sees. So own-`undefined`
//     inside a crossed blob is REFUSED, except at the positions proven identical
//     on both sides (`ALLOWED_OWN_UNDEFINED`, currently
//     `modelOverridesByOperation`, which both sides drop from the persisted
//     image).
//  2. A returned object is EQUAL BY VALUE, not key-for-key, in two ways: the core
//     OMITS a key the twin returned holding own-`undefined`, and it emits the keys
//     it does return in its own order (BTreeMap / struct order).
//
//     MEASURED BY SHAPE, NOT BY CALL COUNT. Three earlier attempts reported a big
//     denominator ("0 of 72,545", "0 of 60,995") and an independent rerun refuted
//     each one, because a fifteen-export module's shape space is large enough that
//     a six-figure sample can still miss an entire input SHAPE. The current figure
//     is the COMPLETE `settings.sourceControlAi` x `settings.commitMessageAi` x
//     `repo.sourceControlAi` product — 82 x 52 x 57 named cells — crossed with
//     every operation, action id, discovery host, product default and agent
//     environment: 7,775,055 cases, 3,162,875 of them crossing to the SHIPPED wasm
//     core, with the pre-cutover HEAD twin as the reference on both sides of the
//     seam. Three images, nested:
//       * VALUE (keys sorted, own-`undefined` dropped) — 0 mismatches. Every `?.`
//         read, every `JSON.parse` round trip and every by-key consumer sees the
//         same answer.
//       * BYTE (`JSON.stringify`) — 101,361, i.e. 3.2% of the crossed cases. KEY
//         ORDER ONLY, at exactly these paths: the whole returned object; each
//         `actions.{commitMessage,pullRequest,branchName}` recipe; `actionOverrides`
//         and its members; `selectedModelByAgent`; `selectedModelByAgentByHost` and
//         its host maps; `modelOverridesByOperation.*.selectedModelByAgent`.
//       * STRICT (own-`undefined` distinguished from absent) — 101,697, i.e. 336
//         cases beyond BYTE, only ever at `enabled`, `agentId`, `customAgentCommand`,
//         `modelOverridesByOperation` and `selectedModelByAgent`. `JSON.stringify`
//         drops all five, every `?.` read answers `undefined` either way, and the
//         twin's own re-read path never sees them because a blob carrying
//         own-`undefined` at those positions is refused on INPUT (residual 1).
//     `source-control-ai-shape-coverage.test.ts` reruns that sweep — a smaller
//     design by default, the complete product under `SCA_SHAPE_FULL=1` — and
//     asserts the path list above, so a NEW divergence class fails rather than
//     joining an average.
//
//     KEY ORDER IS NOT COSMETIC, AND "nothing does X" IS A CLAIM. An earlier note
//     here said nothing in the tree compares a result of this module by raw
//     `JSON.stringify`. That was FALSE. What the order difference looks like: for
//     one repo-override blob the twin emits `actionOverrides: {fixChecks,
//     pullRequest}` and the core `{pullRequest, fixChecks}`. Every consumer of the
//     fifteen exports was walked; three sites read the byte image and here is each:
//       * `repository-source-control-ai-persist-queue.ts` and
//         `repository-source-control-ai-global-ux.ts` — the repository pane's
//         redundant-write dedupe, `JSON.stringify(next) === JSON.stringify(base)`.
//         Both operands are `normalizeRepoSourceControlAiOverrides` output and
//         every `withRepoAi*` transform RE-NORMALIZES, so a base normalized before
//         the renderer's wasm was ready and an edit normalized after it were
//         compared across the seam and read as "changed" — the dedupe silently
//         stops deduping. FIXED: both go through
//         `repository-source-control-ai-write-dedupe.ts`, which compares by value;
//         `repository-source-control-ai-key-order.test.ts` plants the mixed case
//         and goes red on the byte comparison.
//       * `main/persistence.ts` `writeToDiskAsync` — sha1 over
//         `JSON.stringify(stateToSave)` decides whether to rewrite the store. A
//         reordered blob changes the hash, so a renderer-written pre-ready value
//         that main later re-normalizes costs ONE extra full-state write; it can
//         never suppress a needed one, because a changed value always changes the
//         string. Left alone deliberately.
//     `repository-source-control-ai-global-ux.ts:61` also memoizes
//     `JSON.stringify(persistedRepoAi)`, but only as an effect dependency ALONGSIDE
//     `persistedRepoAi` itself, so it cannot change when the identity does not.
//     Nothing else iterates these outputs for order: every other reader indexes by
//     key, counts `Object.keys(...).length`, or emits fields in a fixed order.
//  3. Inputs outside the core's contract do not cross and are answered by the
//     twin's body — a non-array `customAgents`, a non-string `agentCmdOverrides`
//     value, a non-boolean PR-creation default, an `operation`/`actionId` outside
//     its closed union, a non-string `hostKey`/`agentId`/`modelId`/
//     `discoveryHostKey`. The core reads all of those more loosely than the twin
//     did (`as_str`/`as_bool`, or a `__parity_error__` that decodes as a THROW
//     where the twin carried on), so the twin's answer stands, including where
//     the twin threw. The projections are in `source-control-ai-core-payload.ts`.
//
//     THAT REFUSAL EXTENDS INSIDE the settings, legacy and model-choice blobs, in
//     `source-control-ai-core-representable.ts`. The core's settings-level fields
//     are not tri-state (`custom_agent_command: Option<String>`,
//     `instructions_by_operation: BTreeMap<_, String>`,
//     `pr_creation_defaults: { draft: Option<bool>, … }`), so a persisted `null`
//     decodes as `None` and comes back as the DEFAULT — `""` / `false` written
//     into settings. The twin returned what it was handed, so those blobs are
//     refused. Only the REPO-override side is left to cross with nulls, because
//     the core does tri-state that side deliberately (`normalize_repo_instruction`,
//     `parse_bool_or_null`, `RepoSourceControlActionOverride`).
//  4. `resolveSourceControlAiForOperation`'s error strings are built by the core,
//     including its "Supported agents: …" summary. That catalog is duplicated in
//     Rust; a change on one side alone shows up as changed error TEXT, not as a
//     changed decision. The vectors for that function are the guard.
import type { SourceControlActionId, SourceControlActionRecipe } from './source-control-ai-actions'
import {
  areStrings,
  cross,
  crossed,
  crossedOptional,
  settingsAndRepo
} from './source-control-ai-core-crossing'
import {
  corePrCreationDefaults,
  isModelledActionId,
  isModelledOperation,
  isRecord,
  UNPROJECTABLE
} from './source-control-ai-core-payload'
import {
  coreHoldsLegacyBlob,
  coreHoldsModelChoice,
  coreHoldsSettingsBlob
} from './source-control-ai-core-representable'
import { resolveSourceControlAiForOperation as tsForOperation } from './source-control-ai-generation-resolution'
import {
  clearSourceControlAiModelChoiceForHost as tsClearChoice,
  readSourceControlAiModelChoiceForHost as tsReadChoice,
  selectSourceControlAiModelChoiceForHost as tsSelectChoice
} from './source-control-ai-host-model-choice'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi as tsMergeLegacy,
  projectSourceControlAiToLegacyCommitMessageAi as tsProjectLegacy
} from './source-control-ai-legacy-commit-message-merge'
import {
  hasConfiguredSourceControlAiInstructions as tsHasInstructions,
  resolveSourceControlActionRecipe as tsActionRecipe,
  resolveSourceControlAiEnabled as tsEnabled,
  resolveSourceControlAiInstructions as tsInstructions,
  resolveSourceControlAiPrCreationDefaults as tsPrCreationDefaults
} from './source-control-ai-operation-precedence'
import { normalizeRepoSourceControlAiOverrides as tsNormalizeOverrides } from './source-control-ai-repo-override-normalization'
import {
  getDefaultSourceControlAiSettings as tsDefaultSettings,
  normalizeSourceControlAiSettings as tsNormalizeSettings,
  sourceControlAiSettingsFromLegacy as tsSettingsFromLegacy
} from './source-control-ai-settings-normalization'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  SourceControlAiOperation,
  SourceControlAiPrCreationDefaults,
  SourceControlAiSettings
} from './source-control-ai-types'
import type { CommitMessageAiSettings, GlobalSettings, Repo, TuiAgent } from './types'

export { DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS } from './source-control-ai-pr-creation-defaults'

export type ResolvedSourceControlAiGenerationParams = {
  agentId: TuiAgent | 'custom'
  model: string
  thinkingLevel?: string
  customPrompt?: string
  commandInputTemplate?: string
  agentArgs?: string
  customAgentCommand?: string
  agentCommandOverride?: string
}

export type ResolvedSourceControlAiOperation = {
  enabled: boolean
  params: ResolvedSourceControlAiGenerationParams
  prCreationDefaults: Required<SourceControlAiPrCreationDefaults>
}

export type ResolveSourceControlAiResult =
  | { ok: true; value: ResolvedSourceControlAiOperation }
  | { ok: false; error: string }

// Exported only because the split put the body in
// `source-control-ai-generation-resolution.ts`; it was a file-local type here.
export type ResolveSourceControlAiInput = {
  settings: Pick<
    GlobalSettings,
    'defaultTuiAgent' | 'agentCmdOverrides' | 'commitMessageAi' | 'sourceControlAi'
  > &
    Partial<Pick<GlobalSettings, 'disabledTuiAgents' | 'customAgents'>>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
  discoveryHostKey?: string
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

export type ResolveSourceControlAiPrCreationDefaultsInput = {
  settings: Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

type SettingsSlice = Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
type RepoSlice = Pick<Repo, 'sourceControlAi'>
type InstructionArgs = {
  settings: SettingsSlice
  repo?: RepoSlice | null
  operation: SourceControlAiOperation
}

export function normalizeRepoSourceControlAiOverrides(
  value: unknown
): RepoSourceControlAiOverrides | undefined {
  // Why the pre-filter: the twin answered `undefined` for every non-record, so a
  // Map/Date/class instance cannot change the answer and must not cost a throw.
  if (!isRecord(value)) {
    return tsNormalizeOverrides(value)
  }
  const answer = cross('normalizeRepoSourceControlAiOverrides', value, 'value')
  return crossedOptional(answer, () => tsNormalizeOverrides(value))
}

export function getDefaultSourceControlAiSettings(): SourceControlAiSettings {
  return crossed(cross('getDefaultSourceControlAiSettings', null, 'input'), tsDefaultSettings)
}

export function sourceControlAiSettingsFromLegacy(
  legacy: CommitMessageAiSettings | null | undefined
): SourceControlAiSettings {
  if (!coreHoldsLegacyBlob(legacy)) {
    return tsSettingsFromLegacy(legacy)
  }
  const answer = cross('sourceControlAiSettingsFromLegacy', legacy ?? null, 'legacy')
  return crossed(answer, () => tsSettingsFromLegacy(legacy))
}

export function normalizeSourceControlAiSettings(
  value: SourceControlAiSettings | null | undefined,
  legacy?: CommitMessageAiSettings | null
): SourceControlAiSettings {
  if (!coreHoldsSettingsBlob(value) || !coreHoldsLegacyBlob(legacy)) {
    return tsNormalizeSettings(value, legacy)
  }
  const input = { value: value ?? null, legacy: legacy ?? null }
  return crossed(cross('normalizeSourceControlAiSettings', input, 'value'), () =>
    tsNormalizeSettings(value, legacy)
  )
}

export function mergeLegacyCommitMessageAiIntoSourceControlAi(
  sourceControlAi: SourceControlAiSettings | null | undefined,
  legacy: CommitMessageAiSettings | null | undefined,
  options: { pullRequestInstructionsFromLegacy?: boolean } = {}
): SourceControlAiSettings {
  if (!coreHoldsSettingsBlob(sourceControlAi) || !coreHoldsLegacyBlob(legacy)) {
    return tsMergeLegacy(sourceControlAi, legacy, options)
  }
  const input = {
    sourceControlAi: sourceControlAi ?? null,
    legacy: legacy ?? null,
    // Why Boolean(): the twin branched on truthiness, the core reads `as_bool`.
    options: {
      pullRequestInstructionsFromLegacy: Boolean(options.pullRequestInstructionsFromLegacy)
    }
  }
  return crossed(
    cross('mergeLegacyCommitMessageAiIntoSourceControlAi', input, 'sourceControlAi'),
    () => tsMergeLegacy(sourceControlAi, legacy, options)
  )
}

export function projectSourceControlAiToLegacyCommitMessageAi(
  sourceControlAi: SourceControlAiSettings,
  previousLegacy?: CommitMessageAiSettings | null
): CommitMessageAiSettings {
  // Why the instructionsByOperation check: the twin read THROUGH that member
  // (`sourceControlAi.instructionsByOperation.commitMessage`) and threw when a
  // hand-edited settings file omitted it, where the core decodes an absent member
  // as an empty map and answers. The throw has to stay on the TypeScript body.
  if (
    !isRecord(sourceControlAi) ||
    !isRecord(sourceControlAi.instructionsByOperation) ||
    !coreHoldsSettingsBlob(sourceControlAi) ||
    !coreHoldsLegacyBlob(previousLegacy)
  ) {
    return tsProjectLegacy(sourceControlAi, previousLegacy)
  }
  const input = { sourceControlAi, previousLegacy: previousLegacy ?? null }
  return crossed(
    cross('projectSourceControlAiToLegacyCommitMessageAi', input, 'sourceControlAi'),
    () => tsProjectLegacy(sourceControlAi, previousLegacy)
  )
}

export function readSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | null | undefined,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  if (!coreHoldsModelChoice(choice) || !areStrings(hostKey, agentId)) {
    return tsReadChoice(choice, hostKey, agentId)
  }
  const input = { choice: choice ?? null, hostKey, agentId }
  return crossedOptional(cross('readSourceControlAiModelChoiceForHost', input, 'choice'), () =>
    tsReadChoice(choice, hostKey, agentId)
  )
}

export function selectSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | undefined,
  hostKey: string,
  agentId: TuiAgent,
  modelId: string
): SourceControlAiModelChoice {
  if (!coreHoldsModelChoice(choice) || !areStrings(hostKey, agentId, modelId)) {
    return tsSelectChoice(choice, hostKey, agentId, modelId)
  }
  const input = { choice: choice ?? null, hostKey, agentId, modelId }
  return crossed(cross('selectSourceControlAiModelChoiceForHost', input, 'choice'), () =>
    tsSelectChoice(choice, hostKey, agentId, modelId)
  )
}

export function clearSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | undefined,
  hostKey: string,
  agentId: TuiAgent
): SourceControlAiModelChoice | undefined {
  if (!coreHoldsModelChoice(choice) || !areStrings(hostKey, agentId)) {
    return tsClearChoice(choice, hostKey, agentId)
  }
  const input = { choice: choice ?? null, hostKey, agentId }
  return crossedOptional(cross('clearSourceControlAiModelChoiceForHost', input, 'choice'), () =>
    tsClearChoice(choice, hostKey, agentId)
  )
}

export function resolveSourceControlAiInstructions(args: InstructionArgs): string {
  const payload = settingsAndRepo(args.settings, args.repo)
  if (payload === UNPROJECTABLE || !isModelledOperation(args.operation)) {
    return tsInstructions(args)
  }
  const input = { ...payload, operation: args.operation }
  return crossed(cross('resolveSourceControlAiInstructions', input, 'args'), () =>
    tsInstructions(args)
  )
}

export function hasConfiguredSourceControlAiInstructions(args: InstructionArgs): boolean {
  const payload = settingsAndRepo(args.settings, args.repo)
  if (payload === UNPROJECTABLE || !isModelledOperation(args.operation)) {
    return tsHasInstructions(args)
  }
  const input = { ...payload, operation: args.operation }
  return crossed(cross('hasConfiguredSourceControlAiInstructions', input, 'args'), () =>
    tsHasInstructions(args)
  )
}

export function resolveSourceControlAiPrCreationDefaults(
  input: ResolveSourceControlAiPrCreationDefaultsInput
): Required<SourceControlAiPrCreationDefaults> {
  const payload = settingsAndRepo(input.settings, input.repo)
  const product = corePrCreationDefaults(input.prCreationProductDefaults)
  if (payload === UNPROJECTABLE || product === UNPROJECTABLE) {
    return tsPrCreationDefaults(input)
  }
  const call = product === undefined ? payload : { ...payload, prCreationProductDefaults: product }
  return crossed(cross('resolveSourceControlAiPrCreationDefaults', call, 'input'), () =>
    tsPrCreationDefaults(input)
  )
}

export function resolveSourceControlAiEnabled(input: {
  settings: SettingsSlice | null | undefined
  repo?: RepoSlice | null
}): boolean {
  const payload = settingsAndRepo(input.settings, input.repo)
  if (payload === UNPROJECTABLE) {
    return tsEnabled(input)
  }
  return crossed(cross('resolveSourceControlAiEnabled', payload, 'input'), () => tsEnabled(input))
}

export function resolveSourceControlActionRecipe(input: {
  settings: SettingsSlice | null | undefined
  repo?: RepoSlice | null
  actionId: SourceControlActionId
}): SourceControlActionRecipe {
  const payload = settingsAndRepo(input.settings, input.repo)
  if (payload === UNPROJECTABLE || !isModelledActionId(input.actionId)) {
    return tsActionRecipe(input)
  }
  const call = { ...payload, actionId: input.actionId }
  return crossed(cross('resolveSourceControlActionRecipe', call, 'input'), () =>
    tsActionRecipe(input)
  )
}

export function resolveSourceControlAiForOperation(
  input: ResolveSourceControlAiInput
): ResolveSourceControlAiResult {
  const payload = settingsAndRepo(input.settings, input.repo)
  const product = corePrCreationDefaults(input.prCreationProductDefaults)
  const hostKey: unknown = input.discoveryHostKey
  if (
    payload === UNPROJECTABLE ||
    product === UNPROJECTABLE ||
    !isModelledOperation(input.operation) ||
    !(hostKey === undefined || typeof hostKey === 'string')
  ) {
    return tsForOperation(input)
  }
  const call = {
    ...payload,
    operation: input.operation,
    ...(hostKey === undefined ? {} : { discoveryHostKey: hostKey }),
    ...(product === undefined ? {} : { prCreationProductDefaults: product })
  }
  return crossed(cross('resolveSourceControlAiForOperation', call, 'input'), () =>
    tsForOperation(input)
  )
}
