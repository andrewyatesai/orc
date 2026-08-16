// Which persisted blobs `orca_git::source_control_ai` can hold WITHOUT
// substituting a value, and therefore which ones may cross the seam.
//
// The core decodes an untrusted blob into typed structs, and its settings-level
// fields are NOT tri-state: `custom_agent_command: Option<String>`,
// `instructions_by_operation: BTreeMap<_, String>`,
// `pr_creation_defaults: { draft: Option<bool>, … }`. A value the struct cannot
// hold decodes as `None` and comes back out as the DEFAULT (`""`, `false`),
// where the twin — plain object spread — returned exactly what it was given.
// Same class as the rollback-bridge defect: a substituted `""` reaching a
// persisted write. These settings decide which model runs a commit message, so
// the blob is refused instead, and the twin's own body answers.
//
// (The repo-override side is deliberately NOT covered by this file: the core
// models it as `Option<Option<T>>` tri-states — `normalize_repo_instruction`,
// `parse_bool_or_null`, `RepoSourceControlActionOverride` — so an explicit
// `null` there is a value it can hold, and the twin's tests pin it.)
//
// OWN-`undefined` IS PART OF THE SAME REFUSAL. The payload codec runs with
// `undefinedProperties: 'omit'`, so a key present holding `undefined` arrives
// ABSENT. The core has `SourceControlAiUndefinedKeys` precisely because the twin
// spreads (`{...defaults, ...base}`), where present-`undefined` SHADOWS the
// default and absent INHERITS it — a distinction the omit-encoding destroys
// before the core can apply it. Only the positions proven answer-identical are
// allowed through; see ALLOWED_OWN_UNDEFINED.
import {
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_IDS
} from './source-control-ai-actions'

const ACTION_IDS: readonly string[] = SOURCE_CONTROL_ACTION_IDS
const OPERATION_IDS: readonly string[] = SOURCE_CONTROL_TEXT_ACTION_IDS

/**
 * Settings-blob keys where a present-`undefined` and an absent key are the same
 * answer on BOTH sides, so the omit-encoding is lossless.
 *
 * `modelOverridesByOperation` is the one that matters: the twin's own
 * `normalizeSourceControlAiSettings` returns it as an own key holding
 * `undefined`, and its output is the next call's input, so refusing it would put
 * the ordinary persistence chain on the fallback. It is safe because neither
 * side re-reads it against a default — the twin copies the own `undefined`
 * through (and `JSON.stringify` drops it) and the core copies `None` through
 * (and omits it), so the two persisted images are identical.
 */
const ALLOWED_OWN_UNDEFINED: ReadonlySet<string> = new Set(['modelOverridesByOperation'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every value a string — which also rejects an own key holding `undefined`,
 *  and must: the codec omits those, so the core cannot see a key the twin's
 *  `Object.keys().length` still counts. */
function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

function isHostStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isStringRecord)
}

/** `CommitMessageAiModelCapability`, exactly — the core keeps these four and
 *  would silently drop anything else, and `{id:"",label:""}` a non-object. */
function isModelCapability(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'id' || key === 'label' || key === 'defaultThinkingLevel') {
      if (typeof item !== 'string') {
        return false
      }
    } else if (key === 'thinkingLevels') {
      if (
        !Array.isArray(item) ||
        !item.every(
          (level) =>
            isRecord(level) &&
            Object.keys(level).every((name) => name === 'id' || name === 'label') &&
            typeof level.id === 'string' &&
            typeof level.label === 'string'
        )
      ) {
        return false
      }
    } else {
      return false
    }
  }
  return typeof value.id === 'string' && typeof value.label === 'string'
}

function isCapabilityRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((list) => Array.isArray(list) && list.every(isModelCapability))
  )
}

function isCapabilityHostRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isCapabilityRecord)
}

/** A `SourceControlAiModelChoice` the core keeps whole: only the three known
 *  members, each a non-empty string record — it drops an empty one to `None`
 *  and drops the whole choice when all three are absent, where the twin kept
 *  the object it was handed. */
function isModelChoice(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  let present = 0
  for (const [key, item] of Object.entries(value)) {
    if (key === 'selectedModelByAgent' || key === 'selectedThinkingByModel') {
      if (!isStringRecord(item) || Object.keys(item as object).length === 0) {
        return false
      }
    } else if (key === 'selectedModelByAgentByHost') {
      if (!isHostStringRecord(item) || Object.keys(item as object).length === 0) {
        return false
      }
    } else {
      return false
    }
    present += 1
  }
  return present > 0
}

function isOperationRecord(value: unknown, isMember: (item: unknown) => boolean): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, item]) => OPERATION_IDS.includes(key) && isMember(item))
  )
}

/** A settings-level action recipe. `commandInputTemplate` and `agentArgs` are
 *  `Option<String>` in the core — NOT the repo side's tri-state — so an explicit
 *  `null` would come back as the default. */
function isActionRecipe(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'agentId') {
      if (!(item === null || typeof item === 'string')) {
        return false
      }
    } else if (key === 'commandInputTemplate' || key === 'agentArgs') {
      if (typeof item !== 'string') {
        return false
      }
    } else {
      return false
    }
  }
  return true
}

function isActionDefaults(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, item]) => ACTION_IDS.includes(key) && isActionRecipe(item))
  )
}

function isPrCreationDefaults(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, item]) =>
        (key === 'draft' ||
          key === 'useTemplate' ||
          key === 'generateDetailsOnOpen' ||
          key === 'openAfterCreate') &&
        typeof item === 'boolean'
    )
  )
}

type MemberCheck = (value: unknown) => boolean

const SETTINGS_MEMBERS: Readonly<Record<string, MemberCheck>> = {
  enabled: (value) => typeof value === 'boolean',
  agentId: (value) => value === null || typeof value === 'string',
  customAgentCommand: (value) => typeof value === 'string',
  actions: isActionDefaults,
  launchActionDefaults: isActionDefaults,
  selectedModelByAgent: isStringRecord,
  selectedThinkingByModel: isStringRecord,
  selectedModelByAgentByHost: isHostStringRecord,
  discoveredModelsByAgent: isCapabilityRecord,
  discoveredModelsByAgentByHost: isCapabilityHostRecord,
  instructionsByOperation: (value) => isOperationRecord(value, (item) => typeof item === 'string'),
  modelOverridesByOperation: (value) => isOperationRecord(value, isModelChoice),
  prCreationDefaults: isPrCreationDefaults
}

const LEGACY_MEMBERS: Readonly<Record<string, MemberCheck>> = {
  enabled: (value) => typeof value === 'boolean',
  agentId: (value) => value === null || typeof value === 'string',
  customPrompt: (value) => typeof value === 'string',
  customAgentCommand: (value) => typeof value === 'string',
  selectedModelByAgent: isStringRecord,
  selectedThinkingByModel: isStringRecord,
  selectedModelByAgentByHost: isHostStringRecord,
  discoveredModelsByAgent: isCapabilityRecord,
  discoveredModelsByAgentByHost: isCapabilityHostRecord
}

function holdsBlob(value: unknown, members: Readonly<Record<string, MemberCheck>>): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (!isRecord(value)) {
    // Not a record: the shim's own `isSettingsBlob` guard already refuses these.
    return false
  }
  for (const [key, item] of Object.entries(value)) {
    const check = members[key]
    if (!check) {
      // An unknown member: the core drops it, the twin's spread carries it into
      // the object it returns and then into the settings file.
      return false
    }
    if (item === undefined) {
      if (!ALLOWED_OWN_UNDEFINED.has(key)) {
        return false
      }
      continue
    }
    if (!check(item)) {
      return false
    }
  }
  return true
}

/**
 * The same question for a `SourceControlAiModelChoice` argument.
 *
 * The core reads each member with `normalize_string_record`, which SKIPS an
 * entry whose value is not a string and answers `None` for the empty result —
 * so a choice the twin still counted as having entries (`Object.keys().length`,
 * which counts a key holding `undefined`) becomes "no choice recorded" and the
 * three optional exports answer `undefined` where the twin answered an object.
 */
export function coreHoldsModelChoice(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (!isRecord(value)) {
    return false
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      return false
    }
    if (key === 'selectedModelByAgent' || key === 'selectedThinkingByModel') {
      if (!isStringRecord(item)) {
        return false
      }
    } else if (key === 'selectedModelByAgentByHost') {
      if (!isRecord(item) || !Object.values(item).every(isStringRecord)) {
        return false
      }
    } else {
      return false
    }
  }
  return true
}

/** True when `orca_git` can hold this `sourceControlAi` blob without
 *  substituting a default for something the twin would have returned as-is. */
export function coreHoldsSettingsBlob(value: unknown): boolean {
  return holdsBlob(value, SETTINGS_MEMBERS)
}

/** The same question for a legacy `commitMessageAi` blob. */
export function coreHoldsLegacyBlob(value: unknown): boolean {
  return holdsBlob(value, LEGACY_MEMBERS)
}
