// The agent-scratch WORKTREE-MATCHER cases from the twin's tests, moved with the
// implementation (they were the first half of
// src/shared/agent-scratch-worktrees.test.ts; the repo-root half went to
// src/shared/agent-scratch-repo-roots.test.ts, which is where that body became a
// shim).
//
// These two bodies deliberately did NOT become shims — `worktree-ownership-rules.ts`
// is the non-dispatching pre-ready fallback of `worktree-ownership-policy.ts`,
// and a fallback that dispatches is not a fallback — so each case is asserted
// twice over.
//
// 1. Against the fallback body itself, which is the code `pnpm parity` compares
//    to `orca_core::agent_scratch_worktrees` and the code every unbound surface
//    runs (mobile binds no seam at all).
// 2. Through `classifyWorktreeOwnership`, the PRODUCTION construction path, with
//    the seam unbound AND bound to the wasm core — so the same path shapes also
//    prove `orca_core::worktree_ownership` rebuilds the matcher from the
//    `agentScratchCheckoutPaths` array the shim sends. A `false` here un-hides
//    every `.claude/worktrees/agent-*` row in the sidebar, the regression #9535
//    and #9388 fixed.
//
// Watched failing first, per the repo's rule: flipping the fallback's strict `<`
// to `<=` turns the `.gsd-workspaces` container row `agent-scratch` in the
// unbound leg while the bound leg stays `unknown-legacy`.
import { afterAll, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { classifyWorktreeOwnership } from './worktree-ownership-policy'
import {
  legacyAgentScratchWorktreePathMatcher,
  legacyIsAgentScratchWorktreePath
} from './worktree-ownership-rules'

const REPO_PATH = '/userhome/dev/app'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

function classify(
  repoPath: string,
  worktreePath: string,
  agentScratchCheckoutPaths?: readonly string[]
): string {
  return classifyWorktreeOwnership({
    repo: { path: repoPath },
    worktree: { path: worktreePath, isMainWorktree: false },
    knownOrcaLayouts: [],
    agentScratchCheckoutPaths
  })
}

/** The twin's verdict, checked against the fallback body and against the shipped
 *  classification in both seam states. `unknown-legacy` is what a non-scratch
 *  worktree classifies as with no known Orca layouts. */
function expectScratch(repoPath: string, worktreePath: string, scratch: boolean): void {
  expect(legacyIsAgentScratchWorktreePath(repoPath, worktreePath)).toBe(scratch)
  const expected = scratch ? 'agent-scratch' : 'unknown-legacy'
  setOrcaDispatchBinding(null)
  expect(classify(repoPath, worktreePath)).toBe(expected)
  bindWasm()
  expect(classify(repoPath, worktreePath)).toBe(expected)
}

afterAll(bindWasm)

describe('the agent-scratch worktree matcher', () => {
  it('matches Claude Code sub-agent worktrees', () => {
    expectScratch(REPO_PATH, '/userhome/dev/app/.claude/worktrees/agent-a04ccaaa55ddadb91', true)
  })

  it('matches gsd parallel-agent workspaces', () => {
    expectScratch(REPO_PATH, '/userhome/dev/app/.gsd-workspaces/phase-1-subagent-2', true)
  })

  it('matches scratch worktrees created from a linked checkout', () => {
    const checkoutPaths = [REPO_PATH, '/userhome/dev/orca/workspaces/app/feature-x']
    const linkedScratch =
      '/userhome/dev/orca/workspaces/app/feature-x/.claude/worktrees/agent-a04ccaaa'
    const foreignScratch = '/userhome/dev/other/feature-x/.claude/worktrees/agent-a04ccaaa'
    const matcher = legacyAgentScratchWorktreePathMatcher(checkoutPaths)
    expect(matcher(linkedScratch)).toBe(true)
    expect(matcher(foreignScratch)).toBe(false)

    for (const bind of [() => setOrcaDispatchBinding(null), bindWasm]) {
      bind()
      expect(classify(REPO_PATH, linkedScratch, checkoutPaths)).toBe('agent-scratch')
      expect(classify(REPO_PATH, foreignScratch, checkoutPaths)).toBe('unknown-legacy')
      // Absent is the repo-root fallback, not the same matcher: the linked
      // checkout is no longer registered, so its scratch dir stops matching.
      expect(classify(REPO_PATH, linkedScratch)).toBe('unknown-legacy')
      // `[]` is a real matcher that matches nothing — NOT the absent-matcher arm.
      expect(classify(REPO_PATH, linkedScratch, [])).toBe('unknown-legacy')
      expect(classify(REPO_PATH, '/userhome/dev/app/.claude/worktrees/agent-a04ccaaa', [])).toBe(
        'unknown-legacy'
      )
    }
  })

  it('matches Windows path separators and casing', () => {
    expectScratch(
      'C:\\userhome\\dev\\app',
      'c:\\USERHOME\\dev\\app\\.Claude\\Worktrees\\agent-a04ccaaa',
      true
    )
  })

  it('matches WSL UNC paths', () => {
    expectScratch(
      '//wsl$/Ubuntu/home/dev/app',
      '//wsl.localhost/Ubuntu/home/dev/app/.claude/worktrees/agent-a04ccaaa',
      true
    )
  })

  it('preserves case-sensitive POSIX and WSL tool segments', () => {
    expectScratch(REPO_PATH, '/userhome/dev/app/.Claude/Worktrees/agent-a04ccaaa', false)
    expectScratch(
      '//wsl.localhost/Ubuntu/home/dev/app',
      '//wsl.localhost/ubuntu/home/dev/app/.Claude/Worktrees/agent-a04ccaaa',
      false
    )
  })

  it('requires the tool directory at the repo root', () => {
    expectScratch(REPO_PATH, '/userhome/dev/app/.claude/other/worktrees/agent-1', false)
    expectScratch(REPO_PATH, '/userhome/dev/app/packages/demo/.claude/worktrees/agent-1', false)
    // The container itself has no descendant, so it is not a scratch worktree.
    expectScratch(REPO_PATH, '/userhome/dev/app/.gsd-workspaces', false)
  })

  it('does not match undotted claude directories', () => {
    expectScratch(REPO_PATH, '/userhome/dev/app/claude/worktrees/agent-1', false)
  })

  it('does not inherit a scratch classification from the repo parent path', () => {
    expectScratch(
      '/userhome/dev/.claude/worktrees/app',
      '/userhome/dev/.claude/worktrees/app/manual/feature-x',
      false
    )
  })

  it('does not match user worktree conventions', () => {
    expectScratch(REPO_PATH, '/userhome/dev/app/.worktrees/feature-x', false)
    expectScratch(REPO_PATH, '/userhome/dev/.superset/worktrees/app/fix-notes', false)
    expectScratch(REPO_PATH, '/orca/workspaces/app/feature', false)
  })

  // The filesystem roots are where `split('/')` and the normalized checkout key
  // disagree: the POSIX root rejoins to `''` and a drive root to `c:`.
  it('anchors scratch paths to the filesystem roots themselves', () => {
    expectScratch('/', '/.claude/worktrees/agent-1', true)
    expectScratch('C:\\', 'C:\\.claude\\worktrees\\agent-1', true)
    expectScratch('D:\\', 'C:\\.claude\\worktrees\\agent-1', false)
  })
})
