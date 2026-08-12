import { isClipboardTextByteLengthOverLimit } from './clipboard-text'

export const GITHUB_WORK_ITEMS_QUERY_MAX_BYTES = 8 * 1024

/**
 * GitHub's Search API only pages through the first 1000 matches; beyond that it
 * 422s with "Only the first 1000 search results are available". Matching that
 * free-text wording is the ONLY signal separating a permanently unreachable page
 * from a transient failure (#11485), so the phrase is pinned here rather than
 * inlined: if GitHub rewords it, window 422s silently demote to generic
 * failures and the advertised page count stops being capped.
 * `gh-utils.test.ts` asserts the classified message still carries this phrase.
 */
export const GITHUB_SEARCH_RESULT_WINDOW_ERROR_PATTERN = /first 1000 search results/i

export function isGitHubWorkItemsQueryTooLarge(
  query: string,
  maxBytes = GITHUB_WORK_ITEMS_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}
