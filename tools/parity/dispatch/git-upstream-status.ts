// TS dispatch for the git-upstream-status parity module. The shared TS impl was
// DELETED (`src/shared/git-upstream-status.ts` held nothing but the two
// predicates, so the file is gone; `GitUpstreamStatus` always lived in
// `git-status-types.ts`) — both surfaces now reach
// `orca_core::git_upstream_status` through `src/shared/git-upstream-reconciliation.ts`
// on the orca-dispatch seam.
//
// Like the stable-pane-id, wsl-paths and worktree-id adapters, this drives the
// SHIM rather than the wasm oracle, so the harness keeps a real TS-vs-Rust
// differential instead of degenerating to wasm-vs-binary:
// config/vitest.parity.config.ts installs no setup file, so the seam is unbound
// here and the shim answers from its `parity` fallback — which is exactly the
// deleted body, and exactly the code mobile and the pre-init renderer run.

import {
  isBehindOnlyUpstream,
  shouldForcePushWithLeaseForUpstream
} from '../../../src/shared/git-upstream-reconciliation'
import type { GitUpstreamStatus } from '../../../src/shared/git-status-types'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'shouldForcePushWithLeaseForUpstream':
      // Single-arg `status`: null/undefined inputs short-circuit via optional chaining.
      return shouldForcePushWithLeaseForUpstream(input as GitUpstreamStatus | undefined)
    case 'isBehindOnlyUpstream':
      // Same single-arg `status` encoding; the twin is a total predicate, never throws.
      return isBehindOnlyUpstream(input as GitUpstreamStatus | undefined)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
