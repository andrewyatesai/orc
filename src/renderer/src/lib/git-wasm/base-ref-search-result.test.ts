// Re-pointed from the deleted src/shared/base-ref-search-result.test.ts: the
// derivation now lives in Rust, so these cases pin the wasm-backed shim.
import { describe, expect, it, vi } from 'vitest'
import './init-git-wasm-for-test'
import { legacyBaseRefSearchResults } from './base-ref-search-result'

describe('legacyBaseRefSearchResults (orca-git wasm)', () => {
  it('derives local branch names for common remote refs returned by older runtimes', () => {
    expect(legacyBaseRefSearchResults(['origin/feature/something', 'upstream/release/1.2'])).toEqual(
      [
        { refName: 'origin/feature/something', localBranchName: 'feature/something' },
        { refName: 'upstream/release/1.2', localBranchName: 'release/1.2' }
      ]
    )
  })

  it('keeps local branch refs unchanged when a remote prefix is not known', () => {
    expect(legacyBaseRefSearchResults(['feature/something'])).toEqual([
      { refName: 'feature/something', localBranchName: 'feature/something' }
    ])
  })

  it('never yields an empty localBranchName for a bare remote prefix', () => {
    // Stripping `origin/` off `origin/` would hand the composer '' as a branch name.
    expect(legacyBaseRefSearchResults(['origin/'])).toEqual([
      { refName: 'origin/', localBranchName: 'origin/' }
    ])
  })

  it('round-trips a ref name with an emoji (matched surrogate pair) through the codec', () => {
    expect(legacyBaseRefSearchResults(['origin/feature/🚀-launch'])).toEqual([
      { refName: 'origin/feature/🚀-launch', localBranchName: 'feature/🚀-launch' }
    ])
  })

  it('answers an empty ref list with an empty row list', () => {
    // `[]` is the real "nothing matched" answer, which is why it cannot double as
    // the not-ready signal below.
    expect(legacyBaseRefSearchResults([])).toEqual([])
  })
})

describe('legacyBaseRefSearchResults before the core is ready', () => {
  it('returns null, never [] and never an unstripped identity row', async () => {
    // A fresh registry re-arms git-wasm-availability at `pending`; that is the
    // same state a terminally `unavailable` core leaves callers in.
    vi.resetModules()
    const { legacyBaseRefSearchResults: preReady } = await import('./base-ref-search-result')

    const preReadyRows = preReady(['origin/main', 'feature/x'])
    expect(preReadyRows).toBeNull()
    // The two values that would read as real answers: an empty result set, and
    // the identity row that seeds `origin/main` as a local branch name.
    expect(preReadyRows).not.toEqual([])
    expect(preReadyRows).not.toEqual([
      { refName: 'origin/main', localBranchName: 'origin/main' },
      { refName: 'feature/x', localBranchName: 'feature/x' }
    ])
  })
})
