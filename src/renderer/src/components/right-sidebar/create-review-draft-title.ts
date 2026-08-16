import { humanizeBranchSlug } from '../../../../shared/branch-leaf-naming'
import { normalizeHostedReviewHeadRef } from '@/lib/git-wasm/hosted-review-refs'

export function resolveCreateReviewDraftTitle({
  branch,
  eligibilityTitle
}: {
  branch: string
  eligibilityTitle?: string | null
}): string {
  const title = eligibilityTitle?.trim()
  if (title) {
    return title
  }
  const normalizedBranch = normalizeHostedReviewHeadRef(branch)
  const branchLeaf = normalizedBranch.split('/').pop()?.replace(/_/g, '-') ?? ''
  return humanizeBranchSlug(branchLeaf) || normalizedBranch
}
