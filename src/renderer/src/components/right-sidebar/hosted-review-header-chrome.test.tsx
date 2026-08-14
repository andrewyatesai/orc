import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostedReviewIcon } from './hosted-review-header-chrome'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'

const baseReview: HostedReviewInfo = {
  provider: 'github',
  number: 7,
  title: 'Header review',
  state: 'open',
  url: 'https://example.test/pr/7',
  status: 'success',
  updatedAt: '2026-08-11T00:00:00Z',
  mergeable: 'MERGEABLE'
}

describe('HostedReviewIcon', () => {
  // Why: #13088 — draft and closed differed only by a near-identical muted tone on
  // the same PR glyph, so a draft header icon read as closed.
  it('gives draft and closed their own glyphs instead of the shared PR icon', () => {
    const draft = renderToStaticMarkup(
      <HostedReviewIcon review={{ ...baseReview, state: 'draft' }} className="size-3" />
    )
    const closed = renderToStaticMarkup(
      <HostedReviewIcon review={{ ...baseReview, state: 'closed' }} className="size-3" />
    )

    expect(draft).toContain('lucide-git-pull-request-draft')
    expect(closed).toContain('lucide-git-pull-request-closed')
    expect(draft).not.toBe(closed)
  })

  it('renders merged reviews with the merge glyph', () => {
    const merged = renderToStaticMarkup(
      <HostedReviewIcon review={{ ...baseReview, state: 'merged' }} className="size-3" />
    )

    expect(merged).toContain('lucide-git-merge')
  })

  // Why: a closed GitLab MR used to fall back to the merge glyph, which read as
  // "already merged".
  it('overrides the GitLab provider glyph for a closed merge request', () => {
    const closed = renderToStaticMarkup(
      <HostedReviewIcon
        review={{ ...baseReview, provider: 'gitlab', state: 'closed' }}
        className="size-3"
      />
    )

    expect(closed).toContain('lucide-git-pull-request-closed')
    expect(closed).not.toContain('lucide-git-merge')
  })
})
