//! Top-coded usage buckets for feature-interaction telemetry, ported from
//! `src/shared/feature-interaction-usage-buckets.ts`.
//!
//! Only the bucket vocabulary is ported here — that is what
//! `feature_interactions::normalize_feature_interaction_telemetry_buckets`
//! needs to validate a persisted marker. The count→bucket thresholds
//! (`getFeatureInteractionUsageBucket`) and the ordering comparator
//! (`compareFeatureInteractionUsageBuckets`) still live only in the twin; see
//! the note on `FEATURE_INTERACTION_USAGE_BUCKETS` before adding them.

/// Declaration order is the twin's `FEATURE_INTERACTION_USAGE_BUCKETS` order,
/// which is also its rank order — so the derived `Ord` is
/// `compareFeatureInteractionUsageBuckets`'s sign, should a port need it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FeatureInteractionUsageBucket {
    Count1,
    Count2,
    Count3To4,
    Count5To9,
    Count10To19,
    Count20To49,
    Count50To99,
    Count100To199,
    Count200To499,
    Count500To999,
    Count1000Plus,
}

pub const FEATURE_INTERACTION_USAGE_BUCKETS: [FeatureInteractionUsageBucket; 11] = [
    FeatureInteractionUsageBucket::Count1,
    FeatureInteractionUsageBucket::Count2,
    FeatureInteractionUsageBucket::Count3To4,
    FeatureInteractionUsageBucket::Count5To9,
    FeatureInteractionUsageBucket::Count10To19,
    FeatureInteractionUsageBucket::Count20To49,
    FeatureInteractionUsageBucket::Count50To99,
    FeatureInteractionUsageBucket::Count100To199,
    FeatureInteractionUsageBucket::Count200To499,
    FeatureInteractionUsageBucket::Count500To999,
    FeatureInteractionUsageBucket::Count1000Plus,
];

impl FeatureInteractionUsageBucket {
    pub fn as_str(self) -> &'static str {
        match self {
            FeatureInteractionUsageBucket::Count1 => "count_1",
            FeatureInteractionUsageBucket::Count2 => "count_2",
            FeatureInteractionUsageBucket::Count3To4 => "count_3_4",
            FeatureInteractionUsageBucket::Count5To9 => "count_5_9",
            FeatureInteractionUsageBucket::Count10To19 => "count_10_19",
            FeatureInteractionUsageBucket::Count20To49 => "count_20_49",
            FeatureInteractionUsageBucket::Count50To99 => "count_50_99",
            FeatureInteractionUsageBucket::Count100To199 => "count_100_199",
            FeatureInteractionUsageBucket::Count200To499 => "count_200_499",
            FeatureInteractionUsageBucket::Count500To999 => "count_500_999",
            FeatureInteractionUsageBucket::Count1000Plus => "count_1000_plus",
        }
    }

    /// `isFeatureInteractionUsageBucket`, as a parse. The twin's predicate is
    /// `typeof value === 'string' && BUCKETS.includes(value)`; a non-string
    /// never reaches here because callers go through `Value::as_str` first.
    pub fn from_id(value: &str) -> Option<FeatureInteractionUsageBucket> {
        FEATURE_INTERACTION_USAGE_BUCKETS.into_iter().find(|bucket| bucket.as_str() == value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_exact_top_coded_telemetry_bucket_vocabulary() {
        let ids: Vec<&str> =
            FEATURE_INTERACTION_USAGE_BUCKETS.iter().map(|bucket| bucket.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "count_1",
                "count_2",
                "count_3_4",
                "count_5_9",
                "count_10_19",
                "count_20_49",
                "count_50_99",
                "count_100_199",
                "count_200_499",
                "count_500_999",
                "count_1000_plus",
            ]
        );
        for bucket in FEATURE_INTERACTION_USAGE_BUCKETS {
            assert_eq!(FeatureInteractionUsageBucket::from_id(bucket.as_str()), Some(bucket));
        }
    }

    #[test]
    fn rejects_labels_that_are_not_in_the_vocabulary() {
        // `count_4` sits inside the count_3_4 bucket's range but is not a bucket
        // NAME — membership is the check, not the threshold.
        assert_eq!(FeatureInteractionUsageBucket::from_id("count_4"), None);
        assert_eq!(FeatureInteractionUsageBucket::from_id("count_0"), None);
        assert_eq!(FeatureInteractionUsageBucket::from_id("count_1000"), None);
        assert_eq!(FeatureInteractionUsageBucket::from_id("COUNT_1"), None);
        assert_eq!(FeatureInteractionUsageBucket::from_id(""), None);
    }

    #[test]
    fn ranks_buckets_in_declaration_order() {
        assert!(FeatureInteractionUsageBucket::Count1 < FeatureInteractionUsageBucket::Count2);
        assert!(
            FeatureInteractionUsageBucket::Count500To999
                < FeatureInteractionUsageBucket::Count1000Plus
        );
    }
}
