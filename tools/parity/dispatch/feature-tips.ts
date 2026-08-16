// TS dispatch for the feature-tips parity module. The shared TS impl was DELETED
// (`src/shared/feature-tips.ts` keeps only the types and the FEATURE_TIPS
// catalog, which the tip dialogs render) — main, the renderer and src/shared all
// reach `orca_config::feature_tips` through
// `src/shared/feature-tip-selection.ts` on the orca-dispatch seam.
//
// Like the wsl-paths adapter, this drives the SHIM rather than the wasm oracle,
// so the harness keeps a real TS-vs-Rust differential instead of degenerating to
// wasm-vs-binary: config/vitest.parity.config.ts installs no setup file, so the
// seam is unbound here and the shim answers from its `parity` fallback — which
// is exactly the deleted body, and exactly what the renderer runs before (or
// without) a binding.
import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  isFeatureTipId,
  normalizeFeatureTipIds
} from '../../../src/shared/feature-tip-selection'
import type { CompletedFeatureTipState, FeatureTipId } from '../../../src/shared/feature-tips'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'isFeatureTipId':
      return isFeatureTipId(input)
    case 'normalizeFeatureTipIds':
      return normalizeFeatureTipIds(input)
    case 'getCompletedFeatureTipIds':
      // Spread the Set to an array so it survives JSON.stringify.
      return [...getCompletedFeatureTipIds(input as CompletedFeatureTipState)]
    case 'getOrderedUnseenFeatureTips': {
      const { seenTipIds, completedTipIds } = input as {
        seenTipIds: FeatureTipId[]
        completedTipIds?: FeatureTipId[]
      }
      return getOrderedUnseenFeatureTips({
        seenTipIds: new Set(seenTipIds),
        completedTipIds: completedTipIds ? new Set(completedTipIds) : undefined
      })
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
