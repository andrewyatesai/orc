// The git remote-error TEXT logic (normalizeGitErrorMessage,
// stripCredentialsFromMessage, isNoUpstreamError,
// formatSubmodulePushFailureDetail) lives in the Rust orca-text core: the main
// process drives it via napi (src/main/git/rust-git-remote-error.ts), the
// relay via wasm (src/relay/git-wasm.ts), and the renderer via wasm
// (src/renderer/src/lib/git-wasm/git-remote-error.ts). This shared module
// keeps the operation type plus the divergent-pull retry fallback — JS control
// flow (it wraps a runPull callback) with no Rust analog. No text logic here
// mirrors the Rust core; shared callers that need a scrub take one injected.

const DIVERGENT_PULL_RECONCILIATION_PATTERN =
  /Need to specify how to reconcile divergent branches|divergent branches and need to specify how to reconcile them/i
const REMOTE_OPERATION_TIMEOUT_PATTERN = /\btimed out\b/i
// Why: these args already pin a reconcile strategy; the merge fallback must not override an explicit choice like --ff-only.
const RECONCILIATION_PULL_ARG_PATTERN =
  /^(--rebase|--no-rebase|--ff-only|--ff|--no-ff|--merge|-r)(=|$)/
// Why: --no-rebase (historical merge default) predates the 2.25 baseline, so this fallback is safe on every supported Git.
export const MERGE_RECONCILIATION_PULL_ARGS = ['--no-rebase']

// Why: a fresh host may lack any pull.rebase/pull.ff policy, so Git 2.27+
// refuses to reconcile divergent branches. Detect that specific failure so the
// caller can retry with an explicit merge instead of surfacing a config error.
// Match the raw message directly (no credential scrub): the divergent-branch
// phrase never carries a URL, and this only returns a boolean — the message is
// never surfaced — so scrubbing (now Rust-only) cannot change the result.
export function isDivergentPullReconciliationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return DIVERGENT_PULL_RECONCILIATION_PATTERN.test(error.message)
}

// Why: if the pull already specifies a reconcile strategy, the caller's choice must win over the merge fallback.
export function pullArgsSpecifyReconciliation(pullArgs: string[]): boolean {
  return pullArgs.some((arg) => RECONCILIATION_PULL_ARG_PATTERN.test(arg))
}

// Why: on hosts with no pull.rebase/pull.ff policy, Git 2.27+ refuses divergent pulls; retry as merge (Git's historical default).
// Not GitCapabilityCache-routed: this is per-repo config/branch state, not a stable host capability.
export async function runPullWithDivergenceFallback(
  pullArgs: string[],
  runPull: (effectiveArgs: string[]) => Promise<void>
): Promise<void> {
  try {
    await runPull(pullArgs)
  } catch (error) {
    if (!pullArgsSpecifyReconciliation(pullArgs) && isDivergentPullReconciliationError(error)) {
      await runPull([...MERGE_RECONCILIATION_PULL_ARGS, ...pullArgs])
      return
    }
    throw error
  }
}

// Why: an exec-level timeout kills the child (SIGTERM) with no git stderr line,
// so message inspection can't distinguish it from a real git failure.
export function isExecKilledError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const { killed, signal } = error as { killed?: unknown; signal?: unknown }
  return killed === true || (typeof signal === 'string' && signal.length > 0)
}

export type GitRemoteOperation = 'push' | 'pull' | 'fetch' | 'upstream'

/** Fixed user-facing message for a runner-enforced remote-operation timeout,
 *  or null when `error` is not a timeout. Lives at the TS boundary (not the
 *  Rust orca-text core) because the runner's `<binary> timed out.` text is a
 *  runner artifact, and every env-specific normalizer wrapper checks it before
 *  delegating to Rust. The output is fixed text, so no credential scrub is
 *  needed before matching. */
export function formatGitRemoteOperationTimeoutMessage(
  error: unknown,
  operation?: GitRemoteOperation
): string | null {
  if (
    !operation ||
    !(error instanceof Error) ||
    !REMOTE_OPERATION_TIMEOUT_PATTERN.test(error.message)
  ) {
    return null
  }
  const label =
    operation === 'upstream' ? 'Remote status' : operation[0].toUpperCase() + operation.slice(1)
  return `${label} timed out. Check your network connection and Git authentication, then try again.`
}
