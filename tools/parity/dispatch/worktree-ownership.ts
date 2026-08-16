// TS dispatch for the worktree-ownership parity module: maps the shared vector
// function names to the real `src/shared/worktree-ownership.ts` exports so the
// harness compares the live TS reference against the Rust port.

import { createAgentScratchWorktreePathMatcher } from '../../../src/shared/agent-scratch-worktrees'
import {
  applyMetadataFallbackVisibility,
  areRuntimePathsEqual,
  buildKnownOrcaWorkspaceLayouts,
  classifyWorktreeOwnership,
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility,
  shouldShowWorktree,
  toDetectedWorktree
} from '../../../src/shared/worktree-ownership'
import type { DetectedWorktree, Repo } from '../../../src/shared/types'

// `agentScratchWorktreePathMatcher` is a closure and cannot ride in a vector, so
// the corpus carries the checkout paths production builds it from. An ABSENT key
// leaves the matcher undefined, which is the twin's repo-root fallback; `[]` is a
// real matcher that matches nothing.
function agentScratchMatcher(input: unknown) {
  const checkoutPaths = (input as { agentScratchCheckoutPaths?: string[] })
    .agentScratchCheckoutPaths
  return Array.isArray(checkoutPaths)
    ? createAgentScratchWorktreePathMatcher(checkoutPaths)
    : undefined
}

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
      return classifyWorktreeOwnership({
        ...(input as Parameters<typeof classifyWorktreeOwnership>[0]),
        agentScratchWorktreePathMatcher: agentScratchMatcher(input)
      })
    case 'toDetectedWorktree':
      // Output spreads the input worktree, so vectors pass only { path, isMainWorktree }
      // to match the lean Rust DetectedWorktree shape.
      return toDetectedWorktree({
        ...(input as Parameters<typeof toDetectedWorktree>[0]),
        agentScratchWorktreePathMatcher: agentScratchMatcher(input)
      })
    case 'shouldShowWorktree':
      return shouldShowWorktree(input as Parameters<typeof shouldShowWorktree>[0])
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
