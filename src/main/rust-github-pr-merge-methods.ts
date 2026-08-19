// Main-process GitHub PR merge-method normalization, driven by the Rust
// github-pr-merge-methods core via napi (the shared TS impl now holds types +
// label data only). One source of truth with the parity-proven Rust port.
import { dispatchToRustCore } from './rust-core-dispatch'
import type { GitHubPRMergeMethodSettings } from '../shared/types'

// Why 'omit': the four flags are `unknown` straight off a GitHub repo response,
// where a missing field arrives as undefined and must keep meaning "not stated".
function dispatch(fn: string, input: unknown): unknown {
  return dispatchToRustCore('github-pr-merge-methods', fn, input, {
    undefinedProperties: 'omit'
  })
}

export function normalizeGitHubPRMergeMethodSettings(args: {
  defaultMethod: unknown
  mergeCommitAllowed: unknown
  rebaseMergeAllowed: unknown
  squashMergeAllowed: unknown
}): GitHubPRMergeMethodSettings | undefined {
  // Rust emits JSON `null` when no method is allowed; the TS contract is
  // `undefined`, so coerce it back.
  return (
    (dispatch('normalizeGitHubPRMergeMethodSettings', args) as GitHubPRMergeMethodSettings | null) ??
    undefined
  )
}
