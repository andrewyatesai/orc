// Re-pointed from the gutted src/shared/git-publish-target-status.ts: the
// `remote/branch` formatter now lives in Rust (orca-git::push_target), so these
// cases pin the wasm-backed shim — including the pre-ready value, which gates an
// outward-facing push.
import { describe, expect, it, vi } from 'vitest'
import './init-git-wasm-for-test'
import { getPublishTargetDisplayName } from './git-publish-target-status'
import { hasUsableHostedReviewPushTarget } from '../../components/right-sidebar/source-control-hosted-review-push-target'

describe('getPublishTargetDisplayName (orca-git wasm)', () => {
  it('joins remote and branch with a slash', () => {
    expect(getPublishTargetDisplayName({ remoteName: 'origin', branchName: 'main' })).toBe(
      'origin/main'
    )
  })

  it('keeps a slashed branch verbatim and ignores remoteUrl', () => {
    expect(
      getPublishTargetDisplayName({
        remoteName: 'upstream',
        branchName: 'feature/foo',
        remoteUrl: 'git@github.com:me/repo.git'
      })
    ).toBe('upstream/feature/foo')
  })

  it('tolerates the optional fields arriving explicitly undefined off the store', () => {
    // The codec rejects an explicitly-undefined property unless the shim opts in.
    expect(
      getPublishTargetDisplayName({
        remoteName: 'origin',
        branchName: 'main',
        remoteUrl: undefined,
        remoteCreated: undefined
      })
    ).toBe('origin/main')
  })

  it('round-trips a branch name with an emoji (matched surrogate pair)', () => {
    expect(getPublishTargetDisplayName({ remoteName: 'origin', branchName: '🚀-launch' })).toBe(
      'origin/🚀-launch'
    )
  })
})

describe('getPublishTargetDisplayName before the core is ready', () => {
  it('returns the same remote/branch join the deleted TS returned, not a sentinel', async () => {
    // A fresh registry re-arms git-wasm-availability at `pending`; that is the
    // same state a terminally `unavailable` core leaves callers in.
    vi.resetModules()
    const { getPublishTargetDisplayName: preReady } = await import('./git-publish-target-status')

    expect(preReady({ remoteName: 'origin', branchName: 'main' })).toBe('origin/main')
    expect(preReady({ remoteName: 'upstream', branchName: 'feature/foo' })).toBe(
      'upstream/feature/foo'
    )
  })

  it('does not let a linked review push at a target the upstream never matched', async () => {
    vi.resetModules()
    const { hasUsableHostedReviewPushTarget: preReadyCaller } = await import(
      '../../components/right-sidebar/source-control-hosted-review-push-target'
    )
    const pushTarget = { remoteName: 'fork', branchName: 'feature/foo' }

    // A null/'' pre-ready value would compare EQUAL to an absent upstreamName here
    // and unlock "Push linked review" against the wrong remote/branch.
    expect(
      preReadyCaller({ pushTarget, upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 } })
    ).toBe(false)
    expect(
      preReadyCaller({
        pushTarget,
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'fork/feature/foo',
          ahead: 1,
          behind: 0
        }
      })
    ).toBe(true)
  })
})

describe('hasUsableHostedReviewPushTarget with the core ready', () => {
  it('matches the pre-ready verdict for the same inputs', () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature/foo' }
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
      })
    ).toBe(false)
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget,
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'fork/feature/foo',
          ahead: 1,
          behind: 0
        }
      })
    ).toBe(true)
  })
})
