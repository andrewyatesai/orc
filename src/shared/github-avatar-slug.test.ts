import { describe, expect, it } from 'vitest'
import { githubAvatarSlug } from './github-avatar-slug'

describe('githubAvatarSlug', () => {
  const upstream = { owner: 'upstream-org', repo: 'rocket' }

  it('keeps the upstream owner for a same-name fork, case-insensitively', () => {
    expect(githubAvatarSlug({ owner: 'acme', repo: 'rocket' }, upstream)).toEqual(upstream)
    expect(githubAvatarSlug({ owner: 'acme', repo: 'RocKet' }, upstream)).toEqual(upstream)
  })

  it('keeps the fork own owner once it has been renamed', () => {
    const origin = { owner: 'acme', repo: 'rocket-pro' }
    expect(githubAvatarSlug(origin, upstream)).toEqual(origin)
  })

  it('falls back to whichever identity is known', () => {
    const origin = { owner: 'acme', repo: 'rocket-pro' }
    expect(githubAvatarSlug(origin, null)).toEqual(origin)
    expect(githubAvatarSlug(null, upstream)).toEqual(upstream)
    expect(githubAvatarSlug(null, undefined)).toBeNull()
  })
})
