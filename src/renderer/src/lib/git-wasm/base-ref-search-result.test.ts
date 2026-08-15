// Re-pointed from the deleted src/shared/base-ref-search-result.test.ts: the
// derivation now lives in Rust, so these cases pin the wasm-backed shim.
import { describe, expect, it, vi } from 'vitest'
import './init-git-wasm-for-test'
import { legacyBaseRefSearchResult } from './base-ref-search-result'

describe('legacyBaseRefSearchResult (orca-git wasm)', () => {
  it('derives local branch names for common remote refs returned by older runtimes', () => {
    expect(legacyBaseRefSearchResult('origin/feature/something')).toEqual({
      refName: 'origin/feature/something',
      localBranchName: 'feature/something'
    })
    expect(legacyBaseRefSearchResult('upstream/release/1.2')).toEqual({
      refName: 'upstream/release/1.2',
      localBranchName: 'release/1.2'
    })
  })

  it('keeps local branch refs unchanged when a remote prefix is not known', () => {
    expect(legacyBaseRefSearchResult('feature/something')).toEqual({
      refName: 'feature/something',
      localBranchName: 'feature/something'
    })
  })

  it('never yields an empty localBranchName for a bare remote prefix', () => {
    // Stripping `origin/` off `origin/` would hand the composer '' as a branch name.
    expect(legacyBaseRefSearchResult('origin/')).toEqual({
      refName: 'origin/',
      localBranchName: 'origin/'
    })
  })

  it('round-trips a ref name with an emoji (matched surrogate pair) through the codec', () => {
    expect(legacyBaseRefSearchResult('origin/feature/🚀-launch')).toEqual({
      refName: 'origin/feature/🚀-launch',
      localBranchName: 'feature/🚀-launch'
    })
  })
})

describe('legacyBaseRefSearchResult before the core is ready', () => {
  it('returns the identity row, not null, so a refs.map picker list has no holes', async () => {
    // A fresh registry re-arms git-wasm-availability at `pending`; that is the
    // same state a terminally `unavailable` core leaves callers in.
    vi.resetModules()
    const { legacyBaseRefSearchResult: preReady } = await import('./base-ref-search-result')

    expect(preReady('origin/main')).toEqual({
      refName: 'origin/main',
      localBranchName: 'origin/main'
    })
    expect(['origin/main', 'feature/x'].map(preReady).every((row) => row !== null)).toBe(true)
  })
})
