// Feature-tip eligibility, ordering and id normalization on
// `orca_config::feature_tips`, over the shared dispatch seam. The twin
// (`src/shared/feature-tips.ts`) keeps the TYPES and the `FEATURE_TIPS` catalog
// as data: the catalog holds the copy the user actually reads, and
// `CmdJPaletteTipDialog`, `FeatureTipVisual`, `FeatureTipActions` and
// `dev-education-suppression.ts` all read it directly.
//
// On the seam rather than one tree's binding because the callers span two trees
// and no single binding reaches both: MAIN (`persistence.ts` normalizes
// `featureTipsSeenIds` on read and on every `ui.set`; the runtime-RPC schema
// `client-ui-schemas.ts` validates each id with a zod `z.custom(isFeatureTipId)`)
// runs napi, while the RENDERER (`store/slices/ui.ts` hydration,
// `feature-tip-startup-gate.ts`, `feature-tip-modal-state.ts`) runs wasm.
//
// PRE-READY CONTRACT — `parity` ×4, and it is FORCED, not tidy.
//
// Every answer here is total, so no sentinel has anywhere to live: a boolean
// with no spare state, and three list/set answers whose EMPTY value is the
// twin's real answer ("not an array", "nothing completed", "nothing left to
// show"). Lifting to a list does not help either — the list IS the answer.
//
// And all three list answers are PERSISTED, in both directions:
//  * `normalizeFeatureTipIds` is the seen-list normalizer on both sides. A
//    pre-ready `[]` in the renderer hydrates an EMPTY seen list, and the next
//    `markFeatureTipsSeen` (store/slices/ui.ts) rebuilds `next` from that empty
//    set and pushes it through `window.api.ui.set`, overwriting the user's real
//    seen list with a single id. Nothing ever re-derives it.
//  * `getOrderedUnseenFeatureTips`'s FIRST element is marked seen the moment the
//    tip is SHOWN — `use-onboarding-and-feature-tips.ts:140`, deliberately, so a
//    crash before dismiss does not reappear it — and nothing ever un-marks a
//    tip. So a pre-ready list that is merely MISORDERED burns the wrong tip
//    forever, and one that ignores completions burns a tip for a feature the
//    user already uses. `getCompletedFeatureTipIds` feeds exactly that filter.
//  * `isFeatureTipId` is a zod `z.custom` predicate inside main's fail-closed
//    client-UI validator: a wrong `false` REJECTS a legitimate `ui.set` write.
//
// So the fallback recomputes the deleted twin's bodies over the kept catalog
// (and over `hasFeatureInteraction`, itself a seam shim whose fallback is the
// deleted twin body, so it is the ready answer too), making
// pre-ready equal ready for every input. Proved exhaustively rather than
// assumed, in `feature-tip-selection.test.ts`: all 8 seen-set × 9 completed-set
// combinations, every array over {3 ids, unknown string, number, null} up to
// length 3, and the truthiness/record spread for the completion state, each run
// unbound and against the shipped wasm core.
//
// Two boundary narrowings, both answer-preserving and both because the payloads
// are UNTRUSTED PERSISTED JSON that the codec would otherwise refuse whole:
//  1. Only catalog ids cross for the seen/completed sets — the twin asked
//     `.has()` for exactly those three, so a junk member cannot change the
//     answer and must not get the chance to fail the encode.
//  2. Only the interaction ids the catalog can complete a tip with cross, read
//     out of the blob with the twin's own `state?.[id]`. That keeps the record
//     CHECK in Rust while leaving an unrelated hand-edited key (a lone
//     surrogate, a `-0`) unable to push the whole call onto its fallback.
import { DispatchPayloadError } from './dispatch-payload-codec'
import type { FeatureInteractionId, FeatureInteractionState } from './feature-interactions'
// Why the sibling shim and not the twin: `feature-interactions` is itself cut
// over, so the completion predicate lives on the seam too — both fallbacks are
// then the deleted bodies, and both bound paths are the same Rust core.
import { hasFeatureInteraction } from './feature-interaction-state'
import {
  FEATURE_TIPS,
  FEATURE_TIP_IDS,
  type CompletedFeatureTipState,
  type FeatureTip,
  type FeatureTipId
} from './feature-tips'
import { tryOrcaDispatch } from './orca-dispatch-seam'

const FEATURE_TIPS_MODULE = 'feature-tips'

const NO_TIP_IDS: ReadonlySet<FeatureTipId> = new Set<FeatureTipId>()

/** The only interaction ids the core reads — every tip's completion triggers. */
const COMPLETING_INTERACTION_IDS: readonly FeatureInteractionId[] = FEATURE_TIPS.flatMap(
  (tip) => tip.completedByFeatureInteractions ?? []
)

/** `null` = the seam is unbound or the payload cannot cross, so answer locally.
 *  Never ambiguous: none of these four functions can answer null in the core. */
function dispatchFeatureTips(fn: string, input: unknown, root: string): unknown {
  try {
    return tryOrcaDispatch(FEATURE_TIPS_MODULE, fn, input, { root })
  } catch (error) {
    // Why the catch: these inputs are untrusted persisted JSON, so they can hold
    // a lone surrogate, a `-0` (JSON.parse produces one) or a runtime-only value
    // the codec refuses. The twin answered all of them without crossing, so the
    // local body does too. A DispatchCoreError still propagates.
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

function legacyIsFeatureTipId(value: unknown): value is FeatureTipId {
  return typeof value === 'string' && FEATURE_TIP_IDS.includes(value as FeatureTipId)
}

function legacyNormalizeFeatureTipIds(value: unknown): FeatureTipId[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<FeatureTipId>()
  for (const item of value) {
    if (legacyIsFeatureTipId(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

function legacyCompletedFeatureTipIds(state: CompletedFeatureTipState): Set<FeatureTipId> {
  const completedIds = new Set<FeatureTipId>()
  if (state.cliInstalled) {
    completedIds.add('orca-cli')
  }
  if (state.voiceDictationEnabled) {
    completedIds.add('voice-dictation')
  }
  for (const tip of FEATURE_TIPS) {
    if (
      tip.completedByFeatureInteractions?.some((id) =>
        hasFeatureInteraction(state.featureInteractions, id)
      )
    ) {
      completedIds.add(tip.id)
    }
  }
  return completedIds
}

function legacyOrderedUnseenFeatureTips(
  seenTipIds: ReadonlySet<FeatureTipId>,
  completedTipIds: ReadonlySet<FeatureTipId>
): FeatureTip[] {
  const unseenTips = FEATURE_TIPS.filter(
    (tip) => !seenTipIds.has(tip.id) && !completedTipIds.has(tip.id)
  )
  return [
    ...unseenTips.filter((tip) => tip.priority === 'new'),
    ...unseenTips.filter((tip) => tip.priority !== 'new')
  ]
}

/** Narrowing 1: the catalog ids the set holds, in catalog order. Reads `.has`
 *  so a non-Set throws the same TypeError the twin threw. */
function catalogIdsIn(ids: ReadonlySet<FeatureTipId>): FeatureTipId[] {
  return FEATURE_TIP_IDS.filter((id) => ids.has(id))
}

/** Narrowing 2: the twin's own `state?.[id]` read, for the completing ids only. */
function completingInteractions(
  state: FeatureInteractionState | undefined
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const id of COMPLETING_INTERACTION_IDS) {
    const record = state?.[id]
    if (record !== undefined) {
      payload[id] = record
    }
  }
  return payload
}

/** The core decides WHICH tips and in what ORDER; the rows themselves stay the
 *  twin's catalog objects, so the copy the user reads has one source and both
 *  paths return the identical rows. `null` when the core named a tip this
 *  build's catalog does not have — data the renderer could not render anyway. */
function catalogRowsFor(answer: unknown): FeatureTip[] | null {
  if (!Array.isArray(answer)) {
    return null
  }
  const rows: FeatureTip[] = []
  for (const entry of answer) {
    const id = (entry as { id?: unknown } | null)?.id
    const row = FEATURE_TIPS.find((tip) => tip.id === id)
    if (!row) {
      return null
    }
    rows.push(row)
  }
  return rows
}

/** Whether an untrusted value is one of the catalog's tip ids. */
export function isFeatureTipId(value: unknown): value is FeatureTipId {
  const answer = dispatchFeatureTips('isFeatureTipId', value, 'value')
  return answer === null ? legacyIsFeatureTipId(value) : answer === true
}

/** Persisted seen-id list → the valid ids, deduped, in first-seen order. */
export function normalizeFeatureTipIds(value: unknown): FeatureTipId[] {
  const answer = dispatchFeatureTips('normalizeFeatureTipIds', value, 'value')
  return answer === null ? legacyNormalizeFeatureTipIds(value) : (answer as FeatureTipId[])
}

/** The tips whose feature the user has already set up or interacted with. */
export function getCompletedFeatureTipIds(state: CompletedFeatureTipState): Set<FeatureTipId> {
  // Booleans are coerced with the twin's truthiness, because the core reads them
  // strictly (`as_bool`) and these fields also arrive from persisted settings.
  const answer = dispatchFeatureTips(
    'getCompletedFeatureTipIds',
    {
      cliInstalled: Boolean(state.cliInstalled),
      voiceDictationEnabled: Boolean(state.voiceDictationEnabled),
      featureInteractions: completingInteractions(state.featureInteractions)
    },
    'completedFeatureTipState'
  )
  return answer === null ? legacyCompletedFeatureTipIds(state) : new Set(answer as FeatureTipId[])
}

/** The tips still worth showing, "new" ones first, in catalog order. */
export function getOrderedUnseenFeatureTips(args: {
  seenTipIds: ReadonlySet<FeatureTipId>
  completedTipIds?: ReadonlySet<FeatureTipId>
}): FeatureTip[] {
  const completedTipIds = args.completedTipIds ?? NO_TIP_IDS
  const answer = dispatchFeatureTips(
    'getOrderedUnseenFeatureTips',
    {
      seenTipIds: catalogIdsIn(args.seenTipIds),
      completedTipIds: catalogIdsIn(completedTipIds)
    },
    'featureTipSelection'
  )
  return (
    (answer === null ? null : catalogRowsFor(answer)) ??
    legacyOrderedUnseenFeatureTips(args.seenTipIds, completedTipIds)
  )
}
