// Projecting a source-control AI call's arguments into the shape
// `orca_git::source_control_ai` reads, and refusing the shapes it models
// DIFFERENTLY from the deleted twin.
//
// Two jobs, both load-bearing for `source-control-ai.ts`:
//
//  1. NARROW. `settings` at these call sites is the whole `GlobalSettings`
//     object, and the core reads six members of it. Sending the rest is not just
//     waste: a `GlobalSettings` built in memory routinely carries own properties
//     whose value is `undefined`, plus records the codec refuses outright, so an
//     un-narrowed payload would throw on the encode and put every call on its
//     fallback — a cutover in name only.
//  2. REFUSE. Where the core reads a member more loosely than the twin did
//     (`as_str` on a value the twin used as an object key, `as_bool` on one the
//     twin tested for truthiness), the untyped value is handed back as
//     UNPROJECTABLE so the caller answers from the twin's own body instead of
//     shipping a difference. These are all inputs the TS types forbid and
//     persisted JSON can still hold.
import {
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  type SourceControlActionId
} from './source-control-ai-actions'
import { coreHoldsLegacyBlob, coreHoldsSettingsBlob } from './source-control-ai-core-representable'
import type { SourceControlAiOperation } from './source-control-ai-types'

/** The call cannot be spelled in the core's shape without changing the answer. */
export const UNPROJECTABLE = Symbol('source-control-ai: outside the core input contract')
export type Unprojectable = typeof UNPROJECTABLE

const PR_CREATION_DEFAULT_KEYS = [
  'draft',
  'useTemplate',
  'generateDetailsOnOpen',
  'openAfterCreate'
] as const

const OPERATION_IDS: readonly string[] = SOURCE_CONTROL_TEXT_ACTION_IDS
const ACTION_IDS: readonly string[] = SOURCE_CONTROL_ACTION_IDS

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A settings/overrides blob the core's `serde_json::Value` decoders accept as
 *  "absent or an object" — exactly what the twin's own `isRecord` guards read. */
export function isSettingsBlob(value: unknown): boolean {
  return value === null || value === undefined || isRecord(value)
}

export function isModelledOperation(value: unknown): value is SourceControlAiOperation {
  return typeof value === 'string' && OPERATION_IDS.includes(value)
}

// Why refuse instead of guess: the arm answers `__parity_error__` for an id
// outside the closed union, which decodes as a THROW, where the twin read
// `undefined` off a Record and carried on.
export function isModelledActionId(value: unknown): value is SourceControlActionId {
  return typeof value === 'string' && ACTION_IDS.includes(value)
}

/** `repo?.sourceControlAi` is all the core reads; a non-object `repo` reads as
 *  absent in the twin too (`repo?.sourceControlAi` on a string is undefined). */
export function coreRepoMember(repo: unknown): unknown {
  return isRecord(repo) ? (repo.sourceControlAi ?? null) : undefined
}

/** The core reads each default with `as_bool`; the twin spread the record, so a
 *  non-boolean would have been RETURNED as the resolved default. */
export function corePrCreationDefaults(value: unknown): unknown | Unprojectable {
  if (value === null || value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return UNPROJECTABLE
  }
  const defaults: Record<string, boolean> = {}
  for (const key of PR_CREATION_DEFAULT_KEYS) {
    const flag = value[key]
    if (flag === undefined) {
      continue
    }
    if (typeof flag !== 'boolean') {
      return UNPROJECTABLE
    }
    defaults[key] = flag
  }
  return defaults
}

/** The `defaultTuiAgent` union the core models: absent, null, a built-in id (or
 *  `'blank'`), or a custom-profile reference it reads only the `id` off. */
function agentPreferenceForCore(pref: unknown): unknown | Unprojectable {
  if (pref === null || typeof pref === 'string') {
    return pref
  }
  if (!isRecord(pref)) {
    return UNPROJECTABLE
  }
  const { id } = pref
  if (id === undefined) {
    return {}
  }
  return typeof id === 'string' ? { id } : UNPROJECTABLE
}

/** Only `id`/`baseAgent` cross — the rest of a `CustomAgentProfile` is unread by
 *  the core and carries the optional-undefined members that fail the encode. */
function rosterForCore(customAgents: unknown): unknown[] | Unprojectable {
  if (!Array.isArray(customAgents)) {
    return UNPROJECTABLE
  }
  const roster: Record<string, string>[] = []
  for (const profile of customAgents) {
    if (!isRecord(profile)) {
      return UNPROJECTABLE
    }
    const { id, baseAgent } = profile
    if (!(id === undefined || typeof id === 'string')) {
      return UNPROJECTABLE
    }
    if (!(baseAgent === undefined || baseAgent === null || typeof baseAgent === 'string')) {
      return UNPROJECTABLE
    }
    const entry: Record<string, string> = {}
    if (typeof id === 'string') {
      entry.id = id
    }
    // Why omit a null baseAgent: the core's absent field and the twin's null
    // both mean "no built-in base", so the two spellings must not differ.
    if (typeof baseAgent === 'string') {
      entry.baseAgent = baseAgent
    }
    roster.push(entry)
  }
  return roster
}

/** The core takes each override with `as_str`; the twin called `.trim()` on it,
 *  so a non-string THREW rather than being skipped. */
function commandOverridesForCore(overrides: unknown): unknown | Unprojectable {
  if (overrides === null || overrides === undefined) {
    return undefined
  }
  if (!isRecord(overrides)) {
    return UNPROJECTABLE
  }
  return Object.values(overrides).every((value) => typeof value === 'string')
    ? overrides
    : UNPROJECTABLE
}

/**
 * The six `GlobalSettings` members `decode_settings_slice_value` reads, or
 * `null` when the whole argument was absent (the core's own no-settings case).
 */
export function coreSettingsSlice(
  settings: unknown
): Record<string, unknown> | null | Unprojectable {
  if (settings === null || settings === undefined) {
    return null
  }
  if (!isRecord(settings)) {
    return UNPROJECTABLE
  }
  const slice: Record<string, unknown> = {}
  if (settings.defaultTuiAgent !== undefined) {
    const pref = agentPreferenceForCore(settings.defaultTuiAgent)
    if (pref === UNPROJECTABLE) {
      return UNPROJECTABLE
    }
    slice.defaultTuiAgent = pref
  }
  if (settings.customAgents !== undefined && settings.customAgents !== null) {
    const roster = rosterForCore(settings.customAgents)
    if (roster === UNPROJECTABLE) {
      return UNPROJECTABLE
    }
    slice.customAgents = roster
  }
  const overrides = commandOverridesForCore(settings.agentCmdOverrides)
  if (overrides === UNPROJECTABLE) {
    return UNPROJECTABLE
  }
  if (overrides !== undefined) {
    slice.agentCmdOverrides = overrides
  }
  if (
    !coreHoldsLegacyBlob(settings.commitMessageAi) ||
    !coreHoldsSettingsBlob(settings.sourceControlAi)
  ) {
    return UNPROJECTABLE
  }
  slice.commitMessageAi = settings.commitMessageAi ?? null
  slice.sourceControlAi = settings.sourceControlAi ?? null
  // Why array-only: the twin fed this straight to `isTuiAgentEnabled`, which
  // treats every non-array — including null — as "nothing disabled", and so does
  // the core when the member is absent.
  if (Array.isArray(settings.disabledTuiAgents)) {
    slice.disabledTuiAgents = settings.disabledTuiAgents
  }
  return slice
}
