// `getContextualTour` on the Rust `orca_config::contextual_tours` core.
//
// Separate from `contextual-tour-id-normalization.ts` on purpose, even though
// both route to the same dispatch module: the id functions answer for THREE
// surfaces (main via napi, renderer via wasm, and the web preload, which binds
// neither), while this one is renderer-only — every caller is under
// `components/contextual-tours/` or `store/slices/ui.ts`. One file, one binding
// story, one contract note; merging them would make both harder to reason about
// and would make the other file's name a lie.
//
// PRE-READY CONTRACT — `parity`. No sentinel is possible: the return type is a
// non-null `ContextualTour` and every caller renders it, so a `null` would blank
// the overlay mid-tour rather than degrade. The fallback recomputes the deleted
// body over `CONTEXTUAL_TOURS`, which this module's twin still exports as data
// and which stays there regardless — the catalog is authored in TS.
//
// The core keeps its OWN copy of that catalog, so what has to agree here is the
// whole step table, not a predicate. It did not agree: at b06d6c6d2d the Rust
// catalog still had the board's removed tune-density step and was missing the
// browser's stay-logged-in step. Both are corrected, and every one of the seven
// tours now has a parity vector taken from this file, so the next drift is a red
// gate rather than a discovery.
//
// Returning a FRESH object per call is safe here and was checked rather than
// assumed: no caller compares tours by identity or mutates one, and the single
// render-path caller (`ContextualTourOverlay`) memoises on `activeTourId`, so
// the object is stable for as long as the tour is.
import { CONTEXTUAL_TOURS, type ContextualTour, type ContextualTourId } from './contextual-tours'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'

/** The deleted twin's body, verbatim, over the catalog it still exports. */
function legacyGetContextualTour(id: ContextualTourId): ContextualTour {
  return CONTEXTUAL_TOURS.find((tour) => tour.id === id)!
}

/** The tour with this id. Unbound seam, or a payload that cannot cross, answers
 *  locally — unambiguous, because the bound arm never answers null for a real
 *  catalog id. */
export function getContextualTour(id: ContextualTourId): ContextualTour {
  let answer: unknown
  try {
    answer = tryOrcaDispatch('contextual-tours', 'getContextualTour', id, { root: 'id' })
  } catch (error) {
    if (!(error instanceof DispatchPayloadError)) {
      throw error
    }
    answer = null
  }
  return answer === null ? legacyGetContextualTour(id) : (answer as ContextualTour)
}
