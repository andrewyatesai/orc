// TS dispatch for the worktree-ownership parity module. The shared TS impl was
// DELETED (`src/shared/worktree-ownership.ts` keeps only
// `EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT`) — every surface now reaches
// `orca_core::worktree_ownership` through `src/shared/worktree-ownership-policy.ts`
// and `src/shared/orca-workspace-layouts.ts` on the orca-dispatch seam.
//
// Like the wsl-paths, branch-name-from-work and stable-pane-id adapters, this
// drives the SHIMS rather than the wasm oracle, so the harness keeps a real
// TS-vs-Rust differential instead of degenerating to wasm-vs-binary:
// config/vitest.parity.config.ts installs no setup file, so the seam is unbound
// here and each shim answers from its `parity` fallback — which is exactly the
// deleted body, and exactly the code main/renderer/relay run before (or
// without) a binding.
//
// `agentScratchWorktreePathMatcher` was a closure the vectors could not carry,
// which is why the corpus has always spelled the checkout paths instead. The
// shims now take that array directly, so the adapter forwards it verbatim: an
// ABSENT key is the twin's absent matcher (the repo-root fallback), while `[]`
// is a real matcher that matches nothing.
import { buildKnownOrcaWorkspaceLayouts } from '../../../src/shared/orca-workspace-layouts'
import {
  applyMetadataFallbackVisibility,
  areRuntimePathsEqual,
  classifyWorktreeOwnership,
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility,
  shouldShowWorktree,
  toDetectedWorktree,
  type DetectedWorktreeInput,
  type ShouldShowWorktreeInput,
  type WorktreeOwnershipInput
} from '../../../src/shared/worktree-ownership-policy'
import type { DetectedWorktree, Repo } from '../../../src/shared/types'

type ScratchCase = { agentScratchCheckoutPaths?: string[] }

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'isLegacyRepoForExternalWorktreeVisibility':
      return isLegacyRepoForExternalWorktreeVisibility(input as Repo)
    case 'effectiveExternalWorktreeVisibility': {
      const { repo, isLegacyRepoForVisibility } = input as {
        repo: Pick<Repo, 'externalWorktreeVisibility'>
        isLegacyRepoForVisibility: boolean
      }
      return effectiveExternalWorktreeVisibility(repo, isLegacyRepoForVisibility)
    }
    case 'buildKnownOrcaWorkspaceLayouts': {
      const { settings, repo } = input as {
        settings: Parameters<typeof buildKnownOrcaWorkspaceLayouts>[0]
        repo?: Parameters<typeof buildKnownOrcaWorkspaceLayouts>[1]
      }
      return buildKnownOrcaWorkspaceLayouts(settings, repo)
    }
    case 'classifyWorktreeOwnership':
      // The corpus predates the shim's signature and still carries the unread
      // `settings` the twin took; only the fields the logic reads are forwarded.
      return classifyWorktreeOwnership(
        ownershipInput(input as WorktreeOwnershipInput & ScratchCase)
      )
    case 'toDetectedWorktree': {
      // Output spreads the input worktree, so vectors pass only
      // { path, isMainWorktree } to match the lean Rust DetectedWorktree shape.
      const args = input as DetectedWorktreeInput & ScratchCase
      return toDetectedWorktree({
        ...ownershipInput(args),
        repo: args.repo,
        worktree: args.worktree,
        isLegacyRepoForVisibility: args.isLegacyRepoForVisibility
      })
    }
    case 'shouldShowWorktree':
      return shouldShowWorktree(input as ShouldShowWorktreeInput)
    case 'applyMetadataFallbackVisibility':
      // The single argument IS the input: a row a caller already built, whose
      // fields beyond the lean projection ride through the TS spread — so the
      // Rust arm re-emits them too instead of rebuilding the lean shape.
      return applyMetadataFallbackVisibility(input as DetectedWorktree)
    case 'areRuntimePathsEqual': {
      const { leftPath, rightPath } = input as { leftPath: string; rightPath: string }
      return areRuntimePathsEqual(leftPath, rightPath)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}

function ownershipInput(args: WorktreeOwnershipInput & ScratchCase): WorktreeOwnershipInput {
  return {
    repo: args.repo,
    worktree: args.worktree,
    meta: args.meta,
    knownOrcaLayouts: args.knownOrcaLayouts,
    agentScratchCheckoutPaths: args.agentScratchCheckoutPaths
  }
}
