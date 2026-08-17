// The cut-over ref splitter, checked in BOTH seam states.
//
// `null` is one of this function's real answers AND the seam's unbound signal,
// so the shim asks `isOrcaDispatchReady()` instead of reading it off the result.
// That makes the unbound cases below load-bearing: if the shim ever went back to
// inferring readiness from a `null`, every "not a remote ref" input would still
// look right while every bound one silently took the fallback.
import { afterEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { splitRemoteBranchName } from './git-remote-branch-split'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'

function bind(): void {
  setOrcaDispatchBinding((module, fn, input) => orcaDispatch(module, fn, input))
}

function inBothSeamStates(assert: () => void): void {
  setOrcaDispatchBinding(null)
  assert()
  bind()
  assert()
}

afterEach(bind)

const SPLITS: readonly [string, { remoteName: string; branchName: string } | null][] = [
  ['origin/main', { remoteName: 'origin', branchName: 'main' }],
  ['origin/feature/x', { remoteName: 'origin', branchName: 'feature/x' }],
  ['a/b', { remoteName: 'a', branchName: 'b' }],
  ['main', null],
  ['', null],
  ['/', null],
  ['/leading', null],
  ['trailing/', null],
  // Non-ASCII around the slash. The twin indexes in UTF-16 units, the core in
  // bytes; these agree only because both ask solely whether the slash is first
  // or last, which is a property worth pinning rather than trusting.
  ['ünïcode/main', { remoteName: 'ünïcode', branchName: 'main' }],
  ['😀/main', { remoteName: '😀', branchName: 'main' }],
  ['a😀/b', { remoteName: 'a😀', branchName: 'b' }],
  ['x/😀', { remoteName: 'x', branchName: '😀' }],
  ['😀/', null],
  ['😀😀/😀😀', { remoteName: '😀😀', branchName: '😀😀' }]
]

describe('splitRemoteBranchName', () => {
  for (const [refName, expected] of SPLITS) {
    it(`splits ${JSON.stringify(refName)} the same way bound and unbound`, () => {
      inBothSeamStates(() => {
        expect(splitRemoteBranchName(refName)).toEqual(expected)
      })
    })
  }

  it('answers the twin for a ref name that cannot cross the seam', () => {
    // A lone surrogate: the codec refuses it, and the twin never needed to
    // encode anything to answer.
    inBothSeamStates(() => {
      expect(splitRemoteBranchName('orig\uD800in/main')).toEqual({
        remoteName: 'orig\uD800in',
        branchName: 'main'
      })
    })
  })
})
