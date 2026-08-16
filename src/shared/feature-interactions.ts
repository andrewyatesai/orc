// Types and data for the feature-interaction catalog. The four query/normalizer
// bodies that used to live here were CUT OVER to `orca_config::feature_interactions`
// and now ship from `./feature-interaction-state.ts` on the orca-dispatch seam;
// this file stays the barrel over the catalog, category and usage-bucket tables,
// which the shim's pre-ready fallback reads so there is one source of ids.
import type { FeatureInteractionId } from './feature-interaction-catalog'
import type { FeatureInteractionUsageBucket } from './feature-interaction-usage-buckets'

export {
  FEATURE_INTERACTIONS,
  FEATURE_INTERACTION_IDS,
  type FeatureInteractionDefinition,
  type FeatureInteractionId
} from './feature-interaction-catalog'
export {
  FEATURE_INTERACTION_CATEGORIES,
  FEATURE_INTERACTION_CATEGORY_BY_ID,
  getFeatureInteractionCategory,
  type FeatureInteractionCategory
} from './feature-interaction-categories'
export {
  compareFeatureInteractionUsageBuckets,
  FEATURE_INTERACTION_USAGE_BUCKETS,
  FEATURE_INTERACTION_USAGE_BUCKET_SPECS,
  getFeatureInteractionUsageBucket,
  isFeatureInteractionUsageBucket,
  type FeatureInteractionUsageBucket
} from './feature-interaction-usage-buckets'

export type FeatureInteractionRecord = {
  /** Unix timestamp in milliseconds for the first local interaction. */
  firstInteractedAt: number
  /** Number of local interactions recorded for this feature. */
  interactionCount: number
}

export type FeatureInteractionState = Partial<
  Record<FeatureInteractionId, FeatureInteractionRecord>
>

export type FeatureInteractionTelemetryBucketState = Partial<
  Record<FeatureInteractionId, FeatureInteractionUsageBucket>
>
