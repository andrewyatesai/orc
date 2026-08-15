// The tree-agnostic push-target guard has TWO observable states, because its
// surfaces bind the dispatch seam at different times, and a third the codec
// forces (a field that cannot be encoded). All three must answer identically:
// this is the anti-traversal gate on a value replayed into `git push`, and an
// `asserts` function has no spare state to signal "not ready" with — a
// fail-closed guess rejects the user's own branch, a fail-open one is the bug
// the validator exists for.
import { afterEach, describe, expect, it } from 'vitest'
import { assertGitPushTargetShape } from './git-push-target-shape'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function outcome(target: unknown): { ok: boolean; error?: string } {
  try {
    assertGitPushTargetShape(target)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Expectations are the DELETED twin's answers, transcribed from its body.
const CASES: readonly (readonly [unknown, { ok: boolean; error?: string }])[] = [
  [{ remoteName: 'origin', branchName: 'main' }, { ok: true }],
  [{ remoteName: 'foo/bar', branchName: 'feature/fix' }, { ok: true }],
  [
    { remoteName: 'origin', branchName: 'main', remoteUrl: 'https://github.com/owner/repo.git' },
    { ok: true }
  ],
  [
    { remoteName: 'origin', branchName: 'main', remoteUrl: 'git@github.com:owner/repo.git' },
    { ok: true }
  ],
  [{ remoteName: 'origin', branchName: 'main', remoteUrl: undefined }, { ok: true }],
  // A matched pair (a real astral char) must cross the codec, and the twin
  // accepted it in a branch name.
  [{ remoteName: 'origin', branchName: 'feat-\u{1f680}' }, { ok: true }],
  [
    { remoteName: 'foo//bar', branchName: 'x' },
    { ok: false, error: 'Invalid git remote name: foo//bar' }
  ],
  [
    { remoteName: 'foo/../bar', branchName: 'x' },
    { ok: false, error: 'Invalid git remote name: foo/../bar' }
  ],
  [{ remoteName: '', branchName: 'x' }, { ok: false, error: 'Invalid git remote name: ' }],
  [{ remoteName: '.', branchName: 'x' }, { ok: false, error: 'Invalid git remote name: .' }],
  [
    { remoteName: 'a'.repeat(101), branchName: 'x' },
    { ok: false, error: `Invalid git remote name: ${'a'.repeat(101)}` }
  ],
  [
    { remoteName: 'bad name', branchName: 'x' },
    { ok: false, error: 'Invalid git remote name: bad name' }
  ],
  [{ remoteName: 'origin', branchName: '-rf' }, { ok: false, error: 'Invalid git branch name: -rf' }],
  [{ remoteName: 'origin', branchName: '' }, { ok: false, error: 'Invalid git branch name: ' }],
  [
    { remoteName: 'origin', branchName: 'main', remoteUrl: 'https://gitlab.com/o/r.git' },
    { ok: false, error: 'Invalid PR push target remote URL.' }
  ],
  [
    { remoteName: 'origin', branchName: 'main', remoteUrl: 'http://github.com/o/r.git' },
    { ok: false, error: 'Invalid PR push target remote URL.' }
  ],
  // unknown -> typed guards
  [null, { ok: false, error: 'Invalid PR push target.' }],
  [undefined, { ok: false, error: 'Invalid PR push target.' }],
  [42, { ok: false, error: 'Invalid PR push target.' }],
  [{}, { ok: false, error: 'Invalid PR push target remote name.' }],
  [{ remoteName: 'origin' }, { ok: false, error: 'Invalid PR push target branch name.' }],
  [
    { remoteName: 'origin', branchName: 'main', remoteUrl: 123 },
    { ok: false, error: 'Invalid PR push target remote URL.' }
  ],
  // Ordering: a name/branch value error wins over the deferred URL type guard.
  [
    { remoteName: 'bad name', branchName: 'main', remoteUrl: 123 },
    { ok: false, error: 'Invalid git remote name: bad name' }
  ],
  [
    { remoteName: 'origin', branchName: '-x', remoteUrl: 123 },
    { ok: false, error: 'Invalid git branch name: -x' }
  ]
]

const bindWasm = (): void => {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

afterEach(() => setOrcaDispatchBinding(null))

describe('assertGitPushTargetShape (orca-dispatch seam)', () => {
  it('answers the same unbound and bound', () => {
    setOrcaDispatchBinding(null)
    const unbound = CASES.map(([target]) => outcome(target))

    bindWasm()
    const bound = CASES.map(([target]) => outcome(target))

    expect(unbound).toEqual(CASES.map(([, expected]) => expected))
    expect(bound).toEqual(unbound)
  })

  it('answers a codec-refused target instead of throwing at the guard', () => {
    // JSON.stringify emits a lone surrogate as `"\ud800"` — valid JSON text that
    // is not valid UTF-8, so the codec refuses the payload. The deleted twin
    // answered without crossing, and so does this — in BOTH directions.
    bindWasm()
    // The twin's branch rule is only non-empty + no leading `-`, so it accepted
    // this; git's check-ref-format is the next gate. Rejecting here would flip an
    // accept and blame the wrong field (the reverted first attempt).
    expect(outcome({ remoteName: 'origin', branchName: 'feat-\ud800' })).toEqual({ ok: true })
    expect(outcome({ remoteName: 'orig\ud800in', branchName: 'main' })).toEqual({
      ok: false,
      error: 'Invalid git remote name: orig\ud800in'
    })
    expect(
      outcome({ remoteName: 'origin', branchName: 'main', remoteUrl: 'https://github.com/o/r\ud800.git' })
    ).toEqual({ ok: false, error: 'Invalid PR push target remote URL.' })
  })

  it('never encodes an unread property, so junk beside the three fields cannot flip the verdict', () => {
    // Only remoteName/branchName/remoteUrl cross. The twin read nothing else, so
    // a NaN or a lone surrogate on a sibling key must not become a rejection.
    bindWasm()
    expect(
      outcome({
        remoteName: 'origin',
        branchName: 'main',
        remoteCreated: true,
        note: '\ud800',
        at: Number.NaN
      })
    ).toEqual({ ok: true })
  })
})
