// TS dispatch for the feature-interactions parity module. The shared TS impl was
// DELETED (`src/shared/feature-interactions.ts` keeps only the record/state types
// and the catalog/category/usage-bucket barrel) — every surface now reaches
// `orca_config::feature_interactions` through
// `src/shared/feature-interaction-state.ts` on the orca-dispatch seam.
//
// Like the wsl-paths adapter, this drives the SHIM rather than the wasm oracle,
// so the harness keeps a real TS-vs-Rust differential instead of degenerating to
// wasm-vs-binary: config/vitest.parity.config.ts installs no setup file, so the
// seam is unbound here and the shim answers from its `parity` fallback — which is
// exactly the deleted body, and exactly the code the renderer runs before wasm
// init.

import {
  hasFeatureInteraction,
  isFeatureInteractionId,
  normalizeFeatureInteractions,
  normalizeFeatureInteractionTelemetryBuckets,
  type FeatureInteractionId
} from '../../../src/shared/feature-interaction-state'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'normalizeFeatureInteractions':
      return normalizeFeatureInteractions(input)
    case 'normalizeFeatureInteractionTelemetryBuckets':
      return normalizeFeatureInteractionTelemetryBuckets(input)
    case 'hasFeatureInteraction': {
      const { state, id } = input as { state?: unknown; id: FeatureInteractionId }
      return hasFeatureInteraction(state as never, id)
    }
    case 'isFeatureInteractionId':
      return isFeatureInteractionId(input)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
