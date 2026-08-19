// The worktree-id twin's tests, moved with the implementation onto the seam
// shim. Every case runs TWICE — with the dispatch seam unbound (the renderer
// before wasm init, mobile, the Playwright specs) and bound to the wasm core
// (main/cli via napi, the relay via initSync) — because a worktree id is
// IDENTITY: the repo id is a store key and the parsed path becomes a PTY cwd,
// so the two states disagreeing would file a worktree under the wrong repo or
// run an agent in the wrong directory.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { WORKTREE_ID_SEPARATOR } from './worktree-id'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from './worktree-id-parsing'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

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

afterEach(() => setOrcaDispatchBinding(null))

describe('WORKTREE_ID_SEPARATOR', () => {
  it('is the literal "::" separator', () => {
    expect(WORKTREE_ID_SEPARATOR).toBe('::')
  })
})

describe('getRepoIdFromWorktreeId', () => {
  it('returns the repo id for a canonical worktree id', () => {
    bothStates(() => getRepoIdFromWorktreeId('repo-123::/abs/path'), 'repo-123')
  })

  it('returns the whole input when there is no separator', () => {
    bothStates(() => getRepoIdFromWorktreeId('just-a-repo-id'), 'just-a-repo-id')
  })

  it('returns the empty string for an empty input', () => {
    bothStates(() => getRepoIdFromWorktreeId(''), '')
  })

  it('returns an empty repo id for a bare separator', () => {
    bothStates(() => getRepoIdFromWorktreeId('::'), '')
  })

  it('returns an empty repo id for a leading separator', () => {
    bothStates(() => getRepoIdFromWorktreeId('::path'), '')
  })

  it('returns the repo id when only a trailing separator is present', () => {
    bothStates(() => getRepoIdFromWorktreeId('repo::'), 'repo')
  })

  it('splits on the first separator when the path itself contains "::"', () => {
    bothStates(() => getRepoIdFromWorktreeId('repo::a::b'), 'repo')
  })
})

describe('splitWorktreeId', () => {
  it('splits a canonical worktree id into repo id and path', () => {
    bothStates(() => splitWorktreeId('repo-123::/abs/path'), {
      repoId: 'repo-123',
      worktreePath: '/abs/path'
    })
  })

  it('returns null when there is no separator', () => {
    bothStates(() => splitWorktreeId('just-a-repo-id'), null)
  })

  it('returns null for an empty input', () => {
    bothStates(() => splitWorktreeId(''), null)
  })

  it('returns empty repo id and empty path for a bare separator', () => {
    bothStates(() => splitWorktreeId('::'), { repoId: '', worktreePath: '' })
  })

  it('returns an empty repo id when the separator is leading', () => {
    bothStates(() => splitWorktreeId('::path'), { repoId: '', worktreePath: 'path' })
  })

  it('returns an empty path when the separator is trailing', () => {
    bothStates(() => splitWorktreeId('repo::'), { repoId: 'repo', worktreePath: '' })
  })

  it('splits on the first separator when the path itself contains "::"', () => {
    bothStates(() => splitWorktreeId('repo::a::b'), { repoId: 'repo', worktreePath: 'a::b' })
  })

  it('preserves folder workspace instance suffixes in the literal parsed path', () => {
    bothStates(
      () => splitWorktreeId('repo::/folder::workspace:123e4567-e89b-12d3-a456-426614174000'),
      {
        repoId: 'repo',
        worktreePath: '/folder::workspace:123e4567-e89b-12d3-a456-426614174000'
      }
    )
  })
})

describe('splitWorktreeIdForFilesystem', () => {
  it('strips folder workspace instance suffixes from the parsed path', () => {
    bothStates(
      () =>
        splitWorktreeIdForFilesystem(
          'repo::/folder::workspace:123e4567-e89b-12d3-a456-426614174000'
        ),
      { repoId: 'repo', worktreePath: '/folder' }
    )
  })
})

describe('getWorktreePathBasenameFromId', () => {
  it('returns the path basename for POSIX worktree ids', () => {
    bothStates(
      () => getWorktreePathBasenameFromId('repo-123::/abs/path/nightly-checks'),
      'nightly-checks'
    )
  })

  it('returns the path basename for Windows worktree ids', () => {
    bothStates(
      () => getWorktreePathBasenameFromId('repo-123::C:\\workspaces\\nightly-checks'),
      'nightly-checks'
    )
  })

  it('returns the real folder basename for folder workspace instance ids', () => {
    bothStates(
      () =>
        getWorktreePathBasenameFromId(
          'repo-123::/abs/project::workspace:123e4567-e89b-12d3-a456-426614174000'
        ),
      'project'
    )
  })

  it('returns null when no worktree path is available', () => {
    bothStates(() => getWorktreePathBasenameFromId('repo-123'), null)
    bothStates(() => getWorktreePathBasenameFromId('repo-123::'), null)
  })
})

describe('worktree-id parsing across the dispatch seam', () => {
  it('really consults the seam rather than always answering from the fallback', () => {
    // The fallback IS the ready answer, so every assertion above would still pass
    // if the dispatch were dead. Bind a probe that cannot be confused with a real
    // answer and watch each function take it.
    const calls: string[] = []
    setOrcaDispatchBinding((module, fn, inputJson) => {
      calls.push(`${module}.${fn}(${inputJson})`)
      return fn === 'getRepoIdFromWorktreeId'
        ? '"FROM-THE-CORE"'
        : '{"repoId":"FROM-THE-CORE","worktreePath":"/from/the/core"}'
    })

    expect(getRepoIdFromWorktreeId('repo::/abs/path')).toBe('FROM-THE-CORE')
    expect(splitWorktreeId('repo::/abs/path')).toEqual({
      repoId: 'FROM-THE-CORE',
      worktreePath: '/from/the/core'
    })
    expect(splitWorktreeIdForFilesystem('repo::/abs/path')).toEqual({
      repoId: 'FROM-THE-CORE',
      worktreePath: '/from/the/core'
    })
    // The basename composes over the dispatched split, so it moves with it.
    expect(getWorktreePathBasenameFromId('repo::/abs/path')).toBe('core')

    expect(calls).toEqual([
      'worktree-id.getRepoIdFromWorktreeId("repo::/abs/path")',
      'worktree-id.splitWorktreeId("repo::/abs/path")',
      'worktree-id.splitWorktreeIdForFilesystem("repo::/abs/path")',
      'worktree-id.splitWorktreeIdForFilesystem("repo::/abs/path")'
    ])
  })

  it('propagates a core failure envelope instead of returning it as an id', () => {
    setOrcaDispatchBinding(() => '{"__dispatch_error__":"unknown module"}')
    expect(() => getRepoIdFromWorktreeId('repo::/abs/path')).toThrow(/failed in the Rust core/)
  })

  it('answers a codec-refused id instead of throwing', () => {
    // A Windows directory name can hold an unpaired UTF-16 surrogate, which
    // JSON.stringify emits as `"\ud800"` — valid JSON text that is not valid
    // UTF-8, so the codec refuses the payload. The deleted twin answered without
    // crossing anything, and so does the fallback.
    bindWasm()
    expect(getRepoIdFromWorktreeId('repo-\ud800::/abs/path')).toBe('repo-\ud800')
    expect(splitWorktreeId('repo::/abs/pa\ud800th')).toEqual({
      repoId: 'repo',
      worktreePath: '/abs/pa\ud800th'
    })
    expect(getWorktreePathBasenameFromId('repo::/abs/pa\ud800th')).toBe('pa\ud800th')
  })

  it("keeps the twin's JS trim for the basename, which the core does not share", () => {
    // U+FEFF is JS whitespace and not Rust whitespace; U+0085 is the reverse. The
    // basename is composed in the shim over the dispatched split for exactly this
    // reason, so both seam states answer what the deleted TS answered. Wiring it
    // straight to `orca_core::worktree_id::get_worktree_path_basename_from_id`
    // turns these red.
    bothStates(() => getWorktreePathBasenameFromId('repo::/abs/path/name\ufeff'), 'name')
    bothStates(() => getWorktreePathBasenameFromId('repo::/abs/path/name\u0085'), 'name\u0085')
    bothStates(() => getWorktreePathBasenameFromId('repo::\u0085'), '\u0085')
  })
})
