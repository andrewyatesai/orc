// The two contextual-tour id functions on the Rust `orca_config::contextual_tours`
// core. This sits on `orca-dispatch-seam` rather than in one tree's binding
// directory because the callers span three surfaces and no single binding
// reaches them: main merges and rehydrates the persisted list
// (`persistence.ts`, napi), the renderer store hydrates it
// (`store/slices/ui.ts`, wasm at ready), and the web preload merges it
// (`web/web-preload-api.ts`), which binds NEITHER — so there the fallback below
// is the answer for the whole session, not a boot-window blip.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED, not tidy:
//  * Every answer decides `ui.contextualToursSeenIds`, which is PERSISTED. A
//    pre-ready `[]` from `normalizeContextualTourIds` hydrates an empty seen
//    list, and the very next `updateUI` writes that back — every tour the user
//    already dismissed replays, permanently.
//  * No sentinel has anywhere to live. `[]` is already the twin's real answer
//    for "nothing persisted / nothing valid", and `false` is already
//    `isContextualTourId`'s real answer for an unknown id, so neither value can
//    double as "could not ask".
// So each fallback recomputes the deleted twin's body over the kept
// `CONTEXTUAL_TOUR_IDS` table, which `contextual-tours.ts` still exports as data.
//
// MEASURED against BOTH shipped cores (`orca_git_wasm_bg.wasm` and
// `orca_node.node`, which answer identically): all seven catalog ids, unknown
// strings, and the non-string/exotic inputs below. The catalog itself has
// drifted between the twin and the core before, but not these two functions —
// they answer from the id list, not the step tables, which is why
// `getContextualTour` is NOT routed here (see its header in the twin).
import { CONTEXTUAL_TOUR_IDS, type ContextualTourId } from './contextual-tours'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'

const CONTEXTUAL_TOURS = 'contextual-tours'

/** The deleted twin's body, verbatim over the kept id table. */
function legacyIsContextualTourId(value: unknown): value is ContextualTourId {
  return typeof value === 'string' && CONTEXTUAL_TOUR_IDS.includes(value as ContextualTourId)
}

/** The deleted twin's body, verbatim — a Set, so first-seen order and dedup. */
function legacyNormalizeContextualTourIds(value: unknown): ContextualTourId[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<ContextualTourId>()
  for (const item of value) {
    if (legacyIsContextualTourId(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

/** `null` = the seam is unbound, or the payload cannot cross — answer locally.
 *  Unambiguous: both arms answer a bool or an array, never null.
 *  Why the catch: both inputs are UNVALIDATED — a persisted `ui` blob off disk,
 *  a relay peer's merge payload — so a lone surrogate, an `undefined` array
 *  entry, a sparse hole or a cycle is reachable, and the codec refuses those.
 *  The twin answered every one of them without crossing anything (it only ever
 *  looked for known strings), so the fallback is its answer, not a degrade. */
function dispatchContextualTourIds(fn: string, input: unknown, root: string): unknown {
  try {
    return tryOrcaDispatch(CONTEXTUAL_TOURS, fn, input, { root })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** True when `value` is one of the seven catalog tour ids. */
export function isContextualTourId(value: unknown): value is ContextualTourId {
  const answer = dispatchContextualTourIds('isContextualTourId', value, 'value')
  return answer === null ? legacyIsContextualTourId(value) : (answer as boolean)
}

/**
 * The persisted "seen tours" list, defended: drops anything that is not a
 * current tour id and collapses duplicates, keeping first-seen order. A
 * non-array (absent / corrupted state) normalizes to `[]`.
 */
export function normalizeContextualTourIds(value: unknown): ContextualTourId[] {
  const answer = dispatchContextualTourIds('normalizeContextualTourIds', value, 'value')
  return answer === null ? legacyNormalizeContextualTourIds(value) : (answer as ContextualTourId[])
}
