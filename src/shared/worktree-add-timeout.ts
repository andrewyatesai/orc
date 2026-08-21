// Why: bound `git worktree add` and the deferred git-crypt checkout so a
// OneDrive/cloud-placeholder stall fails fast (STA-1292, #7410) into rollback
// instead of hanging; ample for an ordinary large checkout, but not one behind a
// slow content filter (#12696).
// Doubles as the floor for ORCA_WORKTREE_ADD_TIMEOUT_MS — lowering it to fail
// faster also lowers the minimum any override can request.
// Shared so the local (src/main/git) and relay (src/relay) twins stay in sync.
export const WORKTREE_ADD_TIMEOUT_MS = 180_000

// Why: ceiling for ORCA_WORKTREE_ADD_TIMEOUT_MS (#12696) — ~8x the slowest reported
// checkout (3.5 min). The cost is that a genuine stall now blocks a create for up to
// 30 min instead of 3.
export const WORKTREE_ADD_TIMEOUT_MAX_MS = 30 * 60_000

/**
 * `ORCA_WORKTREE_ADD_TIMEOUT_MS` clamped into [{@link WORKTREE_ADD_TIMEOUT_MS},
 * {@link WORKTREE_ADD_TIMEOUT_MAX_MS}]; unset, blank, or unparseable yields the default.
 * Warns when a non-blank value is rejected or clamped; trimming and fractional truncation are silent.
 * `env` is injectable for tests.
 */
export function resolveWorktreeAddTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_WORKTREE_ADD_TIMEOUT_MS?.trim()
  const requested = Math.floor(Number(raw))
  // Why: `=300` reads as seconds to most operators, so clamp rather than obey.
  const resolved = Number.isNaN(requested)
    ? WORKTREE_ADD_TIMEOUT_MS
    : Math.min(Math.max(requested, WORKTREE_ADD_TIMEOUT_MS), WORKTREE_ADD_TIMEOUT_MAX_MS)
  // Why: an `isNaN` guard here would delete the unparseable-value warning — comparing against NaN is unequal, and that is what catches it.
  if (raw && resolved !== requested) {
    const problem = Number.isNaN(requested)
      ? // Why: `600_000` copied out of this file is NaN, not out of range — say which.
        'is not a number'
      : `is outside [${WORKTREE_ADD_TIMEOUT_MS}, ${WORKTREE_ADD_TIMEOUT_MAX_MS}]ms`
    console.warn(
      `[git/worktree] ORCA_WORKTREE_ADD_TIMEOUT_MS="${raw}" ${problem}; using ${resolved}ms`
    )
  }
  return resolved
}
