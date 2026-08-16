// The agent-scratch REPO ROOT cases from the twin's tests, moved with the
// implementation onto the seam shim (they were the second half of
// src/shared/agent-scratch-worktrees.test.ts; the worktree-matcher half went to
// src/shared/worktree-ownership-agent-scratch.test.ts, where those bodies now
// live).
//
// Every case runs TWICE — seam unbound (the shim's `parity` fallback, which is
// what main runs before its napi binding lands and what any surface without a
// binding runs for the whole session) and bound to the wasm core — because a
// fallback-vs-core differential structurally cannot see a divergence that only
// appears once the seam is bound. This is the pre-ready contract row for the
// module's one shim export.
import { afterAll, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  isAgentScratchRepoRootPath,
  legacyIsAgentScratchRepoRootPath
} from './agent-scratch-repo-roots'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call()).toEqual(expected)
  bindWasm()
  expect(call()).toEqual(expected)
}

afterAll(bindWasm)

describe('isAgentScratchRepoRootPath', () => {
  it('matches codex scratch capsule repos', () => {
    bothStates(
      () => isAgentScratchRepoRootPath('/userhome/dev/.codex-tmp/foragent-capsule-b1-repo-zP9Az6'),
      true
    )
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/.codex-tmp/rc-fwd-qEXuEq'), true)
  })

  it('matches codex vendor imports and claude skills containers', () => {
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/.codex/vendor_imports/skills'), true)
    bothStates(
      () => isAgentScratchRepoRootPath('/userhome/dev/.claude/skills/obsidian-second-brain'),
      true
    )
  })

  it('matches a repo registered at the scratch container itself', () => {
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/.codex-tmp'), true)
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/.codex/vendor_imports'), true)
  })

  it('matches scratch worktree containers used as repo roots', () => {
    bothStates(
      () => isAgentScratchRepoRootPath('/userhome/dev/app/.claude/worktrees/agent-a04ccaaa'),
      true
    )
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/app/.gsd-workspaces/phase-1'), true)
  })

  it('matches Windows separators and casing', () => {
    bothStates(() => isAgentScratchRepoRootPath('C:\\userhome\\Dev\\.codex-tmp\\Capsule-X'), true)
    bothStates(() => isAgentScratchRepoRootPath('C:\\userhome\\Dev\\.Claude\\Skills\\foo'), true)
  })

  it('does not match ordinary user repos', () => {
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/projects/app'), false)
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/codex-tmp/app'), false)
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/.codex/checkouts/app'), false)
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/skills/.claude-app'), false)
  })

  it('does not match partial multi-segment markers', () => {
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/.claude/config'), false)
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/vendor_imports/app'), false)
  })

  // POSIX stays case-SENSITIVE through the normalize fold, so the marker table's
  // lowercase spelling is not a Windows-only convenience.
  it('keeps POSIX marker segments case-sensitive', () => {
    bothStates(() => isAgentScratchRepoRootPath('/userhome/dev/.Codex-Tmp/capsule'), false)
  })

  // A path the codec cannot encode: the twin answered it without crossing, so the
  // shim must too rather than throw at the seam.
  it('answers an unpaired surrogate locally instead of failing to encode', () => {
    bothStates(() => isAgentScratchRepoRootPath('/userhome/\uD800/.codex-tmp/capsule'), true)
    bothStates(() => isAgentScratchRepoRootPath('/userhome/\uD800/projects/app'), false)
  })

  // The wrong-runtime-type input, which a hand-edited `orca-data.json` repo row
  // can carry. The shim is not asserted to a single answer here: the kept twin
  // body reaches `normalizeRuntimePathForComparison`, itself a shim, so the twin
  // ITSELF answered a non-string differently in each state. What must hold — and
  // what the shim would break if it stopped falling back — is that the two arms
  // agree, per state. The observed shapes are pinned so the row cannot pass
  // vacuously if either side starts swallowing the throw.
  it('answers a non-string repo path exactly as the kept twin body does', () => {
    const capture = (call: () => boolean): unknown => {
      try {
        return { value: call() }
      } catch (error) {
        return { threw: (error as Error).constructor.name }
      }
    }
    setOrcaDispatchBinding(null)
    expect(capture(() => isAgentScratchRepoRootPath(7 as unknown as string))).toEqual(
      capture(() => legacyIsAgentScratchRepoRootPath(7 as unknown as string))
    )
    expect(capture(() => isAgentScratchRepoRootPath(7 as unknown as string))).toEqual({
      threw: 'TypeError'
    })
    bindWasm()
    expect(capture(() => isAgentScratchRepoRootPath(7 as unknown as string))).toEqual(
      capture(() => legacyIsAgentScratchRepoRootPath(7 as unknown as string))
    )
    expect(capture(() => isAgentScratchRepoRootPath(7 as unknown as string))).toEqual({
      value: false
    })
  })
})
