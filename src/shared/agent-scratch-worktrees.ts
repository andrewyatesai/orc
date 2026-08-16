// CUT OVER to the Rust `orca_core::agent_scratch_worktrees` core. This file
// keeps the marker tables and the matcher's type; every body moved out.
//
// ONLY ONE of the three exports became a seam shim, and the split is the point
// of the cutover rather than an accident of it.
//
// `isAgentScratchRepoRootPath` had a real production caller —
// `resolveWorktreeScanCacheTtlMs` in `src/main/runtime/orca-runtime.ts`, which
// drops the worktree-scan TTL from 30s to 5min for agent-internal repos — so it
// moved to `src/shared/agent-scratch-repo-roots.ts` on `orca-dispatch-seam`.
//
// `createAgentScratchWorktreePathMatcher` and `isAgentScratchWorktreePath` are
// NOT shims and must not become them. Their only consumer at HEAD was
// `worktree-ownership-rules.ts`, which is by contract the NON-DISPATCHING
// pre-ready fallback of the already-cut-over `worktree-ownership-policy.ts`: a
// shim whose fallback dispatches is not a fallback, and routing these two would
// also turn the 60 worktree-ownership parity vectors into a Rust-vs-Rust
// self-comparison for the scratch half of the classification. Their ready path
// already runs in Rust — the policy shim sends `agentScratchCheckoutPaths` and
// `orca_core::worktree_ownership` builds the same matcher — so the bodies moved
// INTO that fallback as `legacyAgentScratchWorktreePathMatcher` /
// `legacyIsAgentScratchWorktreePath`, reading the tables below. This is the same
// call `cross-platform-path-resolution.ts` makes about `isWindowsAbsolutePathLike`.
//
// Both tables are matched against `normalizeRuntimePathForComparison` keys, so
// they are spelled lowercase: that fold lowercases Windows and UNC paths and
// leaves POSIX and the WSL Linux tail case-SENSITIVE.

/** Why: agent CLIs reserve these repo-root paths for scratch; broader matches
 *  can hide legitimate user worktrees (#9388). */
export const AGENT_SCRATCH_PATH_PREFIXES: readonly (readonly string[])[] = [
  ['.claude', 'worktrees'],
  ['.gsd-workspaces']
]

/** Why: agent CLIs also mint whole scratch *repos* under these containers; a
 *  repo registered at such a root is agent-internal, not a user project (#9388). */
export const AGENT_SCRATCH_REPO_ROOT_SEGMENTS: readonly (readonly string[])[] = [
  ['.codex-tmp'],
  ['.codex', 'vendor_imports'],
  ['.claude', 'skills'],
  ...AGENT_SCRATCH_PATH_PREFIXES
]

export type AgentScratchWorktreePathMatcher = (worktreePath: string) => boolean
