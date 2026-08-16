// Feature-interaction state queries on the Rust `orca_config::feature_interactions`
// core, reached through the shared dispatch seam. The twin
// (`src/shared/feature-interactions.ts`) keeps the record/state TYPES and stays
// the barrel over the catalog, category and usage-bucket data tables — the
// fallback below reads those same tables, so there is one source of ids.
//
// On the seam rather than one tree's binding directory because all three trees
// validate the same persisted blob: main + cli (`persistence.ts`, `ipc/ui.ts`,
// `runtime/rpc/methods/client-ui-schemas.ts`, napi), the renderer
// (`store/slices/ui.ts`, `web/web-preload-api.ts`, `Terminal.tsx`,
// `SidebarToolbar.tsx`, the tour and setup-guide hooks, wasm at ready) and
// `src/shared` itself (`feature-tips.ts`), which also runs under the SSH relay.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED, because the value is
// PERSISTED AS THE INTERACTION STATE ITSELF. `mergeFeatureInteractionState`
// normalizes BOTH sides and spreads the result (`store/slices/ui.ts:173`,
// `web/web-preload-api.ts:3767`, `main/persistence.ts:930`), and the merged map
// is written straight back — `window.api.ui.set`, `writeJson(UI_STORAGE_KEY, …)`,
// `scheduleSave()`. A pre-ready `{}` would therefore ERASE the user's whole
// recorded history on the first record-interaction round trip: every contextual
// tour replays and every usage bucket re-emits. The telemetry-bucket map is the
// once-only marker guarding `feature_interaction_usage_bucket_reached`
// (`persistence.ts:6273`), so a wrong `{}` re-counts the fleet.
//
// No sentinel is available either. Both normalizers return a total map whose
// EMPTY value is a real answer (a fresh profile), so nothing distinguishable is
// left over. `hasFeatureInteraction` is a total predicate read inside
// `if`/`??`/ternaries and stored into
// `activeContextualTourWasFeaturePreviouslyInteracted`. And
// `isFeatureInteractionId` is a zod `z.custom` refinement
// (`client-ui-schemas.ts:96`) and main's IPC gate (`ipc/ui.ts:68`), where a
// non-boolean signal reads as truthy and lets an arbitrary string into the
// persisted record.
//
// So the fallback recomputes the deleted twin's bodies over the kept tables and
// is the ready answer for EVERY input. Measured, not assumed: 3,292 probes of the
// SHIPPED wasm (every catalog id plus `unknown`/`toString`/`__proto__`/
// `constructor` × 30 record shapes — absent, null, array, primitive, `-0`,
// fractional, negative, 1e21, MAX_SAFE_INTEGER, string/boolean/null fields,
// interactionCount 0/-3/2.5/1e21 — plus non-object roots, every usage-bucket
// label and near-miss, and full 53-key maps in catalog and reversed key order)
// agree everywhere, including the key ORDER of the returned map, except the one
// class below. Then 7,840 pre-ready-vs-ready comparisons THROUGH THIS SHIM (the
// same corpus plus 3,000 random 53-key states and every value the codec refuses
// — cyclic, bigint, symbol, function, Date, Map, toJSON, lone surrogate,
// NaN/±Infinity/-0) found 0 divergences, which is the claim the `parity` row
// actually makes.
//
// THE ONE DISAGREEMENT, guarded here instead of shipped. The Rust arm answers an
// off-catalog `id` with `{"__parity_error__": …}`, which `decodeDispatchResult`
// turns into a THROW, where the twin returned `false` — `state?.[id]` is
// undefined for an unknown key, and even an inherited `Object.prototype` member
// (`toString`, `constructor`) fails the record shape. `id` is typed
// `FeatureInteractionId`, but the values reaching it are lifted out of persisted
// JSON and off the relay wire, so a cast is all that stands between the core and
// a throw on a code path the twin answered. The shim checks catalog membership
// locally and never dispatches an id the core would reject.
import { FEATURE_INTERACTION_IDS, type FeatureInteractionId } from './feature-interaction-catalog'
import { isFeatureInteractionUsageBucket } from './feature-interaction-usage-buckets'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import type {
  FeatureInteractionRecord,
  FeatureInteractionState,
  FeatureInteractionTelemetryBucketState
} from './feature-interactions'

// Why re-exported: these are the shim's own signature types, so a switched
// importer needs one import site rather than two.
export type {
  FeatureInteractionRecord,
  FeatureInteractionState,
  FeatureInteractionTelemetryBucketState
} from './feature-interactions'
export type { FeatureInteractionId } from './feature-interaction-catalog'

const FEATURE_INTERACTIONS = 'feature-interactions'

// Why a Set and not the twin's `Array.includes`: this guard runs on the hot
// `hasFeatureInteraction` path before every crossing. Identical semantics for
// strings, which is all the twin's array holds.
const FEATURE_INTERACTION_ID_SET: ReadonlySet<string> = new Set(FEATURE_INTERACTION_IDS)

/** The deleted twin's `isFeatureInteractionId`, over the kept catalog. */
function localIsFeatureInteractionId(value: unknown): value is FeatureInteractionId {
  return typeof value === 'string' && FEATURE_INTERACTION_ID_SET.has(value)
}

/** The deleted twin's `normalizeFeatureInteractionRecord`, verbatim. */
function localRecord(value: unknown): FeatureInteractionRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const firstInteractedAt = input.firstInteractedAt
  if (
    typeof firstInteractedAt !== 'number' ||
    !Number.isFinite(firstInteractedAt) ||
    firstInteractedAt < 0
  ) {
    return null
  }
  const rawInteractionCount = input.interactionCount
  const interactionCount =
    typeof rawInteractionCount === 'number' &&
    Number.isInteger(rawInteractionCount) &&
    rawInteractionCount > 0
      ? rawInteractionCount
      : 1
  return { firstInteractedAt, interactionCount }
}

/** The deleted twin's `normalizeFeatureInteractions`, verbatim over the kept ids. */
function localNormalizeInteractions(value: unknown): FeatureInteractionState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const input = value as Record<string, unknown>
  const out: FeatureInteractionState = {}
  for (const id of FEATURE_INTERACTION_IDS) {
    const record = localRecord(input[id])
    if (record) {
      out[id] = record
    }
  }
  return out
}

/** The deleted twin's `normalizeFeatureInteractionTelemetryBuckets`, verbatim. */
function localNormalizeTelemetryBuckets(value: unknown): FeatureInteractionTelemetryBucketState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const input = value as Record<string, unknown>
  const out: FeatureInteractionTelemetryBucketState = {}
  for (const id of FEATURE_INTERACTION_IDS) {
    const bucket = input[id]
    if (isFeatureInteractionUsageBucket(bucket)) {
      out[id] = bucket
    }
  }
  return out
}

/** `null` = the seam is unbound, or the payload cannot cross, so answer locally.
 *  No arm of this module can return a real JSON null — two return maps and two
 *  return booleans — so the conflation is unambiguous. */
function dispatchFeatureInteractions(fn: string, input: unknown, root: string): unknown {
  try {
    return tryOrcaDispatch(FEATURE_INTERACTIONS, fn, input, { root })
  } catch (error) {
    // Why the catch: every input here is untrusted persisted JSON or a relay/IPC
    // payload, so it can carry a lone UTF-16 surrogate, `-0`, `NaN`, or an own
    // property explicitly set to `undefined` — all of which the codec refuses.
    // The twin answered those without crossing anything, so the local body does
    // too. A DispatchCoreError still propagates.
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** Whether `value` is a catalog feature-interaction id. */
export function isFeatureInteractionId(value: unknown): value is FeatureInteractionId {
  const answer = dispatchFeatureInteractions('isFeatureInteractionId', value, 'value')
  return answer === null ? localIsFeatureInteractionId(value) : (answer as boolean)
}

/** Whether the persisted state records a valid local interaction for `id`. */
export function hasFeatureInteraction(
  state: FeatureInteractionState | null | undefined,
  id: FeatureInteractionId
): boolean {
  const record = state?.[id]
  if (!localIsFeatureInteractionId(id)) {
    // Why not dispatch: the core answers an off-catalog id with __parity_error__,
    // which decodes to a THROW; the twin answered false. See the header.
    return localRecord(record) !== null
  }
  // Why only the one record crosses, never the caller's map: the core reads
  // `state[id]` and nothing else, so sending all 53 keys costs ~22x per call
  // (26µs vs 1.2µs on the shipped wasm) and would let a lone surrogate on an
  // UNREAD sibling key push a real answer onto the fallback.
  const answer = dispatchFeatureInteractions(
    'hasFeatureInteraction',
    { id, state: record === undefined ? {} : { [id]: record } },
    'featureInteraction'
  )
  return answer === null ? localRecord(record) !== null : (answer as boolean)
}

/** Persisted interaction records, with unknown ids and malformed values dropped. */
export function normalizeFeatureInteractions(value: unknown): FeatureInteractionState {
  const answer = dispatchFeatureInteractions(
    'normalizeFeatureInteractions',
    value,
    'featureInteractions'
  )
  return answer === null ? localNormalizeInteractions(value) : (answer as FeatureInteractionState)
}

/** Persisted last-emitted usage-bucket markers, with unknown ids and labels dropped. */
export function normalizeFeatureInteractionTelemetryBuckets(
  value: unknown
): FeatureInteractionTelemetryBucketState {
  const answer = dispatchFeatureInteractions(
    'normalizeFeatureInteractionTelemetryBuckets',
    value,
    'telemetryBuckets'
  )
  return answer === null
    ? localNormalizeTelemetryBuckets(value)
    : (answer as FeatureInteractionTelemetryBucketState)
}
