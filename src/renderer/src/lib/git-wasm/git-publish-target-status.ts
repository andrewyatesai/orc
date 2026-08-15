// Renderer publish-target display name, driven by the Rust push_target core in
// the orca-git wasm module (the shared TS impl is now a stub). The STATUS half of
// git-publish-target-status already runs in Rust behind both A-bridges; this pure
// `remote/branch` formatter was the last piece the renderer still called directly.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { GitPushTarget } from '../../../../shared/types'

export function getPublishTargetDisplayName(target: GitPushTarget): string {
  // Pre-ready rebuilds the deleted TS verbatim (`${remoteName}/${branchName}`,
  // which `publish_target_display_name` also emits byte-for-byte) because the sole
  // caller EQUALITY-COMPARES it to upstreamStatus.upstreamName to gate "Push linked
  // review": a null/'' sentinel would read equal to an absent upstreamName and push
  // at a target the upstream never matched.
  if (!isGitWasmReady()) {return `${target.remoteName}/${target.branchName}`}
  // Why 'omit': GitPushTarget's optional remoteUrl/remoteCreated reach here
  // explicitly undefined off the worktree store, which serde reads as absent.
  return dispatchToWasmCore('git-publish-target-status', 'getPublishTargetDisplayName', target, {
    undefinedProperties: 'omit'
  }) as string
}
