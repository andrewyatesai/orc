// Impl DELETED — the Rust orca-core `worktree_ownership` port is the sole
// implementation. Both trees reach it through one shared-seam shim pair:
// `worktree-ownership-policy.ts` (classification + external-visibility policy)
// and `orca-workspace-layouts.ts` (`buildKnownOrcaWorkspaceLayouts`). Import
// from those, not from here.
//
// Only the rollout timestamp remains. It is DATA, not logic — the date external
// worktrees became hidden-by-default — and it stays in TypeScript because the
// shim's pre-ready fallback recomputes the twin's legacy-repo test out of it,
// and a fallback that has to dispatch for its own constant is not a fallback.
// `orca_core::worktree_ownership::EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT`
// carries the same instant as epoch milliseconds; the parity vectors pin the
// two together.
export const EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT = Date.UTC(2026, 4, 23)
