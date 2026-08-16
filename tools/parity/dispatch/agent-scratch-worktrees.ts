// TS dispatch for the agent-scratch-worktrees parity module. The shared TS impl
// was DELETED (`src/shared/agent-scratch-worktrees.ts` keeps only the two marker
// tables and the matcher type), so this drives the two places its bodies went.
//
// `isAgentScratchRepoRootPath` is the module's one seam SHIM
// (`src/shared/agent-scratch-repo-roots.ts`), driven here exactly as the app
// runs it: `config/vitest.parity.config.ts` installs no setup file, so the seam
// is unbound and the shim answers from its `parity` fallback — which is the
// deleted body, and the code main runs before its napi binding is installed.
//
// The two worktree matchers are deliberately NOT shims. Their only consumer is
// `worktree-ownership-rules.ts`, the non-dispatching pre-ready fallback of the
// already-cut-over `worktree-ownership-policy.ts`, so the bodies live there and
// this adapter calls them there. Routing them through a shim would compare Rust
// against Rust.
//
// `createAgentScratchWorktreePathMatcher` returned a closure, which no vector can
// carry back. Its arm therefore takes `{ checkoutPaths, worktreePath }` and
// answers the closure's verdict for that path — the per-row call
// `classifyWorktreeOwnership` makes, not a synthetic stand-in.

import { isAgentScratchRepoRootPath } from '../../../src/shared/agent-scratch-repo-roots'
import {
  legacyAgentScratchWorktreePathMatcher,
  legacyIsAgentScratchWorktreePath
} from '../../../src/shared/worktree-ownership-rules'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'isAgentScratchWorktreePath': {
      const { repoPath, worktreePath } = input as { repoPath: string; worktreePath: string }
      return legacyIsAgentScratchWorktreePath(repoPath, worktreePath)
    }
    case 'isAgentScratchRepoRootPath':
      return isAgentScratchRepoRootPath((input as { repoPath: string }).repoPath)
    case 'createAgentScratchWorktreePathMatcher': {
      const { checkoutPaths, worktreePath } = input as {
        checkoutPaths: string[]
        worktreePath: string
      }
      return legacyAgentScratchWorktreePathMatcher(checkoutPaths ?? [])(worktreePath)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
