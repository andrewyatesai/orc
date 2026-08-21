// Why: "not GitLab" / "host unauthenticated" only holds until someone configures
// `origin` or runs `glab auth login`. Both negatives expire on this one clock so a
// login lands within an interval; positives are cached indefinitely.
export const PROJECT_REF_NEGATIVE_TTL_MS = 5 * 60_000
