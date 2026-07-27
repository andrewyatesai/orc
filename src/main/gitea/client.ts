import {
  deriveGiteaCommitStatus,
  mapGiteaPullRequest,
  mapGiteaPullRequestState,
  type GiteaPullRequestInfo,
  type RawGiteaCombinedStatus,
  type RawGiteaPullRequest
} from './pull-request-mappers'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'
import { getGiteaRepoRef, type GiteaRepoRef } from './repository-ref'
import { invalidateGiteaPullRequestScan, scanGiteaPullRequests } from './pull-request-scan-cache'
import {
  configuredApiBaseUrl,
  getAuthConfig,
  requestJson,
  requestJsonAtBase
} from './gitea-api-request'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'

export { normalizeGiteaApiBaseUrl } from './gitea-api-request'

// Why: self-hosted Forgejo can take ~5s to serve one /pulls page (it loads
// reviewer data per PR). The default 5s cap aborted responses right as they
// completed, so the work was discarded and retried on the next refresh (#8807).
const PULL_REQUEST_LIST_TIMEOUT_MS = 15_000
const PULL_REQUEST_PAGE_LIMIT = 50
const MAX_PULL_REQUEST_PAGES = 5

export type GiteaAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

function encodedRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}

function giteaPullRequestScanKey(repo: GiteaRepoRef): string {
  return `${configuredApiBaseUrl(repo)}/${encodedRepoPath(repo)}`
}

/** Invalidate the shared /pulls scan after Orca itself creates a PR so the
 *  next worktree-card refresh sees it instead of a cached miss. */
export function invalidateGiteaPullRequestScanForRepo(repo: GiteaRepoRef): void {
  invalidateGiteaPullRequestScan(giteaPullRequestScanKey(repo))
}

async function getCommitStatus(
  repo: GiteaRepoRef,
  headSha: string | undefined
): Promise<ReturnType<typeof deriveGiteaCommitStatus>> {
  if (!headSha) {
    return 'neutral'
  }
  const data = await requestJson<RawGiteaCombinedStatus>(
    repo,
    `/repos/${encodedRepoPath(repo)}/commits/${encodeURIComponent(headSha)}/status`
  )
  return deriveGiteaCommitStatus(data)
}

async function normalizePullRequest(
  repo: GiteaRepoRef,
  raw: RawGiteaPullRequest
): Promise<GiteaPullRequestInfo | null> {
  const status = await getCommitStatus(repo, raw.head?.sha?.trim())
  return mapGiteaPullRequest(raw, status)
}

function matchesBranch(raw: RawGiteaPullRequest, branchName: string): boolean {
  const ref = raw.head?.ref?.trim()
  if (ref === branchName) {
    return true
  }
  const label = raw.head?.label?.trim()
  return label === branchName || label?.endsWith(`:${branchName}`) === true
}

export async function getGiteaAuthStatus(): Promise<GiteaAuthStatus> {
  const config = getAuthConfig()
  const tokenConfigured = config.token !== null
  if (!config.apiBaseUrl && !tokenConfigured) {
    return {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
  }
  if (!config.apiBaseUrl) {
    return {
      configured: true,
      authenticated: true,
      account: null,
      baseUrl: null,
      tokenConfigured
    }
  }

  if (!tokenConfigured) {
    const version = await requestJsonAtBase<{ version?: string }>(config.apiBaseUrl, '/version', {
      timeoutMs: 4000
    })
    return {
      configured: version !== null,
      authenticated: false,
      account: null,
      baseUrl: config.apiBaseUrl,
      tokenConfigured
    }
  }

  const user = await requestJsonAtBase<{
    login?: string | null
    username?: string | null
    full_name?: string | null
  }>(config.apiBaseUrl, '/user', { timeoutMs: 4000 })
  return {
    configured: true,
    authenticated: user !== null,
    account: user?.login ?? user?.username ?? user?.full_name ?? null,
    baseUrl: config.apiBaseUrl,
    tokenConfigured
  }
}

export async function getGiteaPullRequest(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaPullRequestInfo | null> {
  const repo = await getGiteaRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return null
  }
  const raw = await requestJson<RawGiteaPullRequest>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}`
  )
  return raw ? normalizePullRequest(repo, raw) : null
}

export async function getGiteaPullRequestForBranch(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  throwOnFailure = false
): Promise<GiteaPullRequestInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedPRNumber == null) {
    return null
  }

  const repo = await getGiteaRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return null
  }

  if (branchName) {
    const pullRequests = await scanGiteaPullRequests(
      // Why: throwing scans keep a separate cache namespace so they never reuse a
      // prior swallowing scan's cached-empty from a failed page fetch, which would
      // otherwise let a real lookup failure masquerade as "no PR".
      throwOnFailure ? `${giteaPullRequestScanKey(repo)}::strict` : giteaPullRequestScanKey(repo),
      (page) =>
        requestJson<RawGiteaPullRequest[]>(
          repo,
          `/repos/${encodedRepoPath(repo)}/pulls`,
          {
            searchParams: {
              state: 'all',
              sort: 'recentupdate',
              page,
              limit: PULL_REQUEST_PAGE_LIMIT
            },
            timeoutMs: PULL_REQUEST_LIST_TIMEOUT_MS
          },
          throwOnFailure
        ),
      PULL_REQUEST_PAGE_LIMIT,
      MAX_PULL_REQUEST_PAGES
    )
    const raw = pullRequests.find((item) => matchesBranch(item, branchName))
    if (raw) {
      // Why (#9171): discard a non-open implicit branch match on the repo
      // default branch and fall through to the linked-number fallback below.
      const hideOnDefaultBranch = await shouldHideNonOpenReviewOnDefaultBranch({
        state: mapGiteaPullRequestState(raw),
        reviewNumber: raw.number ?? null,
        linkedReviewNumber: linkedPRNumber,
        branchName,
        repoPath,
        connectionId,
        localGitOptions: getHostedReviewLocalGitOptions(options)
      })
      if (!hideOnDefaultBranch) {
        return normalizePullRequest(repo, raw)
      }
    }
    // Why: Gitea has no head-branch filter, so we scan recent /pulls pages. A scan
    // that filled every page up to the cap may have hidden an older PR; in the
    // strict lookup treat that as unavailable (not a definitive miss) so
    // createHostedReview cannot open a duplicate PR (design invariant 8).
    const scanTruncated = pullRequests.length >= PULL_REQUEST_PAGE_LIMIT * MAX_PULL_REQUEST_PAGES
    if (throwOnFailure && typeof linkedPRNumber !== 'number' && scanTruncated) {
      throw new Error('Gitea pull request scan hit the page cap without matching the branch')
    }
  }

  if (typeof linkedPRNumber !== 'number') {
    return null
  }
  const raw = await requestJson<RawGiteaPullRequest>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(linkedPRNumber))}`,
    {},
    throwOnFailure
  )
  return raw ? normalizePullRequest(repo, raw) : null
}

/**
 * Existing-review lookup that surfaces transport/auth failures instead of
 * collapsing them to null, so a failed lookup becomes
 * `reviewLookupOutcome: 'unavailable'` rather than a false "No pull request found".
 */
export function getGiteaPullRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaPullRequestInfo | null> {
  return getGiteaPullRequestForBranch(repoPath, branch, linkedPRNumber, connectionId, options, true)
}

export async function getGiteaRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options))
}
