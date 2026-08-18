import type { FeatureInteractionState } from '../../../shared/feature-interactions'
import { hasFeatureInteraction } from '../../../shared/feature-interaction-state'
export type FloatingWorkspaceTourInteractionSnapshot = {
  wasPreviouslyInteracted?: boolean
  persisted?: Promise<void>
  recordFeatureInteractionForTour: boolean
}

export function createFloatingWorkspaceTourInteractionSnapshot(args: {
  featureInteractions: FeatureInteractionState
  persistedUIReady: boolean
  recordFeatureInteraction: (id: 'floating-workspace') => Promise<void>
}): FloatingWorkspaceTourInteractionSnapshot {
  const wasPreviouslyInteracted = hasFeatureInteraction(
    args.featureInteractions,
    'floating-workspace'
  )
  if (!args.persistedUIReady) {
    return {
      recordFeatureInteractionForTour: true
    }
  }
  return {
    wasPreviouslyInteracted,
    persisted: args.recordFeatureInteraction('floating-workspace'),
    recordFeatureInteractionForTour: false
  }
}
