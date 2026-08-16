// TUI-agent selection on the Rust `orca_agents::tui_agent_selection` core. The
// twin (`src/shared/tui-agent-selection.ts`) keeps only data:
// `TUI_AGENT_AUTO_PICK_ORDER`, which `orchestration-skill-coverage.ts` iterates
// and `mobile/src/tasks/mobile-agent-catalog.test.ts` parses out of that file's
// SOURCE TEXT, and `DEFAULT_DISABLED_TUI_AGENTS`, which `constants.ts` spreads
// into the default settings.
//
// On the shared dispatch seam rather than a surface binding because all four
// binding-holding surfaces call these: main (`persistence.ts`,
// `runtime/orca-runtime.ts`, `rpc/methods/client-ui-schemas.ts`, napi), the
// renderer (~30 components and lib modules, wasm at ready), the SSH relay and
// `src/shared` itself (`source-control-ai.ts`, `commit-message-agent-spec.ts`).
//
// PRE-READY CONTRACT — `parity` for all five exports, and it is FORCED, not
// chosen. Two of the answers are written straight back into persisted settings:
//  * `collapseDefaultTuiAgentToBuiltin` resolves `settings.defaultTuiAgent` for
//    the onboarding agent step (`onboarding-settings-hydration.ts` ->
//    `use-onboarding-flow.ts:197 updateSettings({ defaultTuiAgent })`), so a
//    pre-ready answer that is not the twin's answer is SAVED AS THE USER'S
//    DEFAULT AGENT — the repo-badge-color failure, one step worse because the
//    same value then picks the launch command.
//  * `normalizeDisabledTuiAgents` IS the settings sanitizer at
//    `main/persistence.ts:5893` and `store/slices/settings.ts:90`; whatever it
//    returns is what lands in the settings file.
// No sentinel is available for the other three either: `pickTuiAgent` already
// spends its `null` on "no agent qualifies" (the explicit `blank` preference),
// `isTuiAgentEnabled` is a total predicate consumed inside `if`/`.filter`, and
// `filterEnabledTuiAgents` returns a list whose `[]` already means "all
// disabled". Lifting to a list does not help — each answer decides ONE launch.
//
// So the fallback is the deleted twin's own body over the kept catalog, which
// makes pre-ready equal ready for every input. Measured, not assumed: 2,161
// probes of the SHIPPED wasm (the full 34x34 auto-pick order, every mixed-type
// array up to length 3, and 300 pref x roster pairs) against the deleted bodies
// — see `tui-agent-selection-resolution.test.ts`.
//
// THE MEASURED DIVERGENCES, all of them inputs the TS types forbid but persisted
// JSON can still hold, and each folded back to the twin below rather than
// shipped:
//  * `preferred` that is not a string: the core reads it as "no preference"
//    while the twin returned it when `detected` held the same non-string.
//  * `preferred === ''`: falsy, so the twin skipped the preference; the core
//    reads `Some("")` and matches a detected entry it coerced to `""`.
//  * a non-string in `agents`: the core hands back `""` in its place instead of
//    the caller's own value.
//  * a `pref`/roster entry outside the modelled union (a number/boolean pref, a
//    non-string `id`, a non-string `baseAgent`): the core answers the
//    `__parity_error__` envelope, which `decodeDispatchResult` turns into a
//    THROW, where the twin answered.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import { isTuiAgent } from './tui-agent-config'
import { TUI_AGENT_AUTO_PICK_ORDER } from './tui-agent-selection'
import type { CustomAgentProfile, TuiAgent } from './types'

const TUI_AGENT_SELECTION = 'tui-agent-selection'

/** The core's encoding of TS `undefined`, which has no JSON image. */
const COLLAPSE_UNDEFINED = '__undefined__'

/** What the core reads off one `CustomAgentProfile`. */
type CoreAgentProfile = { id?: string; baseAgent?: string }

type DefaultTuiAgentPref = TuiAgent | 'blank' | { kind: 'custom'; id: string } | null | undefined

// --- the deleted twin bodies, verbatim; the pre-ready and out-of-contract answer ---

function legacyNormalizeDisabled(value: unknown): TuiAgent[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<TuiAgent>()
  for (const item of value) {
    if (isTuiAgent(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

function legacyCollapse(
  pref: DefaultTuiAgentPref,
  customAgents?: readonly CustomAgentProfile[] | null
): TuiAgent | 'blank' | null | undefined {
  if (pref && typeof pref === 'object') {
    return customAgents?.find((profile) => profile.id === pref.id)?.baseAgent ?? null
  }
  return pref
}

function legacyPick(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[],
  disabled: readonly unknown[]
): TuiAgent | null {
  if (preferred === 'blank') {
    return null
  }
  const disabledSet = new Set(legacyNormalizeDisabled(disabled))
  const detectedSet = new Set(detected)
  if (preferred && detectedSet.has(preferred as TuiAgent) && !disabledSet.has(preferred)) {
    return preferred as TuiAgent
  }
  return (
    TUI_AGENT_AUTO_PICK_ORDER.find((agent) => detectedSet.has(agent) && !disabledSet.has(agent)) ??
    null
  )
}

function legacyFilter<T extends TuiAgent>(agents: readonly T[], disabled: readonly unknown[]): T[] {
  const disabledSet = new Set(legacyNormalizeDisabled(disabled))
  return agents.filter((agent) => !disabledSet.has(agent))
}

// --- the crossing ---

/** `null` = the seam is unbound, or the payload could not cross, so answer from
 *  the twin's body. A real `null` answer (no agent qualifies, no custom profile)
 *  is indistinguishable here and does not need telling apart: this shim is
 *  `parity`, so the body recomputes that same `null`. */
function dispatchSelection(fn: string, input: unknown, root: string): unknown {
  try {
    return tryOrcaDispatch(TUI_AGENT_SELECTION, fn, input, { root })
  } catch (error) {
    // Why the catch: `disabledTuiAgents` and `defaultTuiAgent` are read straight
    // off persisted JSON and off the relay wire, so they can carry a lone UTF-16
    // surrogate or an explicit `undefined` the codec refuses to encode. The twin
    // answered those without crossing anything. A DispatchCoreError still
    // propagates — an unknown function is a bug, not a degraded input.
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** The twin only ever read an ARRAY of disabled ids, so every other iterable —
 *  and `null`/`undefined` — disabled nothing. */
function disabledList(disabled: Iterable<unknown> | null | undefined): readonly unknown[] {
  return Array.isArray(disabled) ? (disabled as unknown[]) : []
}

/** Whether the core models this preference. `'__undefined__'` is excluded
 *  because it is the core's own encoding of `undefined`, so it cannot make the
 *  round trip as a value. */
function isModelledPref(pref: unknown): boolean {
  if (pref === null || pref === undefined) {
    return true
  }
  if (typeof pref === 'string') {
    return pref !== COLLAPSE_UNDEFINED
  }
  if (typeof pref !== 'object') {
    return false
  }
  const { id } = pref as { id?: unknown }
  return id === undefined || typeof id === 'string'
}

/** Send only the `id` the core matches on; a real preference also carries
 *  `kind`, and an absent id must stay absent (the codec rejects `undefined`). */
function prefForCore(pref: DefaultTuiAgentPref): unknown {
  if (pref === null || typeof pref !== 'object') {
    return pref
  }
  return pref.id === undefined ? {} : { id: pref.id }
}

/** Project the roster to the two fields the core reads, or `null` when an entry
 *  is outside `CustomAgentProfile` — a non-object entry, or an `id`/`baseAgent`
 *  that is present but not a string, all of which the twin still answered.
 *  Projecting also keeps an unrelated optional field that is explicitly
 *  `undefined` (`env`) from failing the encode on every call. */
function rosterForCore(customAgents: unknown): CoreAgentProfile[] | null {
  if (customAgents === null || customAgents === undefined) {
    return []
  }
  if (!Array.isArray(customAgents)) {
    return null
  }
  const roster: CoreAgentProfile[] = []
  for (const profile of customAgents) {
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      return null
    }
    const { id, baseAgent } = profile as { id?: unknown; baseAgent?: unknown }
    if (!(id === undefined || typeof id === 'string')) {
      return null
    }
    if (!(baseAgent === undefined || baseAgent === null || typeof baseAgent === 'string')) {
      return null
    }
    const entry: CoreAgentProfile = {}
    if (id !== undefined) {
      entry.id = id
    }
    // Why: the twin coalesced a null/absent baseAgent to null, which is the
    // core's answer for an absent field — so both spellings omit it.
    if (typeof baseAgent === 'string') {
      entry.baseAgent = baseAgent
    }
    roster.push(entry)
  }
  return roster
}

/** Collapse a saved `defaultTuiAgent` preference to its built-in base for
 *  consumers that only understand built-ins: a `{ kind: 'custom', id }` entry
 *  resolves to the profile's baseAgent, or to null (auto) when the profile no
 *  longer exists / no roster was provided. */
export function collapseDefaultTuiAgentToBuiltin(
  pref: DefaultTuiAgentPref,
  customAgents?: readonly CustomAgentProfile[] | null
): TuiAgent | 'blank' | null | undefined {
  const roster = rosterForCore(customAgents)
  if (roster === null || !isModelledPref(pref)) {
    return legacyCollapse(pref, customAgents)
  }
  const payload: { customAgents: CoreAgentProfile[]; pref?: unknown } = {
    customAgents: roster
  }
  // An absent `pref` key is how the core spells the `undefined` argument.
  if (pref !== undefined) {
    payload.pref = prefForCore(pref)
  }
  const answer = dispatchSelection('collapseDefaultTuiAgentToBuiltin', payload, 'defaultTuiAgent')
  if (answer === null) {
    return legacyCollapse(pref, customAgents)
  }
  return answer === COLLAPSE_UNDEFINED ? undefined : (answer as TuiAgent | 'blank')
}

export function pickTuiAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: Iterable<TuiAgent>,
  disabled?: Iterable<unknown> | null
): TuiAgent | null {
  const detectedList = [...detected]
  const disabledIds = disabledList(disabled)
  // Widened on purpose: the declared union says string, but this preference is
  // read straight off persisted settings, so the runtime value may not be one.
  const preferredId: unknown = preferred
  // Why: the core reads `preferred` as an optional string, so a truthy
  // non-string reaches it as "no preference" — but the twin RETURNED it when
  // `detected` held that same non-string value.
  if (preferredId !== null && preferredId !== undefined && typeof preferredId !== 'string') {
    return legacyPick(preferred, detectedList, disabledIds)
  }
  const payload: {
    detected: TuiAgent[]
    disabled: readonly unknown[]
    preferred?: string
  } = {
    detected: detectedList,
    disabled: disabledIds
  }
  // Why omit `''`: it is falsy, so the twin skipped the preference branch
  // entirely — while the core would read `Some("")` and match a detected entry
  // it had coerced to `""`.
  if (typeof preferredId === 'string' && preferredId !== '') {
    payload.preferred = preferredId
  }
  const answer = dispatchSelection('pickTuiAgent', payload, 'pickTuiAgent')
  return answer === null ? legacyPick(preferred, detectedList, disabledIds) : (answer as TuiAgent)
}

export function normalizeDisabledTuiAgents(value: unknown): TuiAgent[] {
  // Why the pre-filter: this reads raw persisted settings, and the twin answered
  // [] for every non-array — including the Maps and class instances the codec
  // would refuse, which would otherwise cost an exception per call.
  const answer = dispatchSelection(
    'normalizeDisabledTuiAgents',
    Array.isArray(value) ? (value as unknown[]) : [],
    'disabledTuiAgents'
  )
  return answer === null ? legacyNormalizeDisabled(value) : (answer as TuiAgent[])
}

export function isTuiAgentEnabled(agent: TuiAgent, disabled?: Iterable<unknown> | null): boolean {
  const disabledIds = disabledList(disabled)
  const answer = dispatchSelection(
    'isTuiAgentEnabled',
    { agent, disabled: disabledIds },
    'isTuiAgentEnabled'
  )
  return answer === null
    ? !legacyNormalizeDisabled(disabledIds).includes(agent)
    : (answer as boolean)
}

export function filterEnabledTuiAgents<T extends TuiAgent>(
  agents: Iterable<T>,
  disabled?: Iterable<unknown> | null
): T[] {
  const agentList = [...agents]
  const disabledIds = disabledList(disabled)
  // Why: the core reads each entry as a string and returns `""` for anything
  // else, replacing the caller's own value instead of passing it through.
  if (!agentList.every((agent) => typeof agent === 'string')) {
    return legacyFilter(agentList, disabledIds)
  }
  const answer = dispatchSelection(
    'filterEnabledTuiAgents',
    { agents: agentList, disabled: disabledIds },
    'filterEnabledTuiAgents'
  )
  return answer === null ? legacyFilter(agentList, disabledIds) : (answer as T[])
}
