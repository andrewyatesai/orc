import type { GitHubPrStartPoint, GitPushTarget, IssueSourcePreference } from '../../shared/types'
import { fetchCompareBaseRefWithLocalFallback } from '../git/compare-base-ref-fetch'
import {
  isMissingRemoteRefGitError,
  isTransientReviewHeadFetchError
} from '../git/fetch-error-classification'
import { getPullRequestPushTarget, getWorkItem } from './client'
import {
  githubPullRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from '../../shared/review-head-tracking-ref'

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

type ResolveGitHubPrStartPointArgs = {
  repoPath: string
  prNumber: number
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  issueSourcePreference?: IssueSourcePreference
  connectionId?: string | null
  localGitOptions?: { wslDistro?: string }
  gitExec: GitExec
  fetchRemoteTrackingRef: (remote: string, branch: string) => Promise<void>
  // Why: returns the durable local ref the fetch wrote so resolve can rev-parse
  // that exact path instead of re-hashing remote identity.
  fetchPullRequestHeadRef: (remote: string, prNumber: number) => Promise<string>
  resolveRemote: () => Promise<string>
  // Why: when the primary remote (e.g. an upstream fork alias) lacks the
  // branch, walking additional remotes is the only way to recover. Callers
  // are expected to exclude `resolveRemote()`'s value from this list.
  resolveRemoteAlternatives: () => Promise<string[]>
}

type ResolveGitHubPrStartPointResult = GitHubPrStartPoint | { error: string }

export async function resolveGitHubPrStartPoint(
  args: ResolveGitHubPrStartPointArgs
): Promise<ResolveGitHubPrStartPointResult> {
  let headRefName = args.headRefName?.trim() ?? ''
  let baseRefName = args.baseRefName?.trim() ?? ''
  let isCrossRepository = args.isCrossRepository === true
  let pushTarget: GitPushTarget | undefined
  let maintainerCanModify: boolean | undefined

  const resolvePushTarget = async (): Promise<void> => {
    if (pushTarget) {
      return
    }
    try {
      const resolved = await getPullRequestPushTarget(
        args.repoPath,
        args.prNumber,
        args.connectionId ?? null,
        args.localGitOptions ?? {},
        args.issueSourcePreference
      )
      pushTarget = resolved?.pushTarget
      maintainerCanModify = resolved?.maintainerCanModify
    } catch {
      // Why: deleted/inaccessible fork metadata can prevent push-target
      // discovery, but GitHub still exposes the PR head ref for checkout.
      pushTarget = undefined
    }
  }

  if (!headRefName) {
    const item = await getWorkItem(
      args.repoPath,
      args.prNumber,
      'pr',
      args.connectionId ?? null,
      args.localGitOptions ?? {},
      args.issueSourcePreference
    )
    if (!item || item.type !== 'pr') {
      return { error: `PR #${args.prNumber} not found.` }
    }
    headRefName = (item.branchName ?? '').trim()
    baseRefName = (item.baseRefName ?? '').trim()
    if (!headRefName) {
      return { error: `PR #${args.prNumber} has no head branch.` }
    }
    if (item.isCrossRepository === true) {
      isCrossRepository = true
    }
  }

  if (isCrossRepository) {
    await resolvePushTarget()
  }

  let primary: string
  try {
    primary = await args.resolveRemote()
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
  }
  let alternatives: string[]
  try {
    alternatives = await args.resolveRemoteAlternatives()
  } catch {
    // Why: enumeration failures shouldn't block the primary path; fall back to
    // single-remote behavior so existing happy-path flows keep working.
    alternatives = []
  }
  // Why: ordering matters — the primary is tried first to keep existing
  // single-remote behavior identical. A Set dedupes callers that hand back
  // the primary again, preserving insertion order.
  const remoteCandidates = Array.from(new Set([primary, ...alternatives]))

  // Why: only "missing ref" is a candidate to walk remotes. Network, auth, or
  // SSH failures on the primary remote must surface immediately so users get
  // the real error rather than a confusing fall-through to refs/pull.
  const fetchBranchFromAnyRemote = async (
    branch: string
  ): Promise<{ remote: string } | { error: string } | null> => {
    for (const remote of remoteCandidates) {
      try {
        await args.fetchRemoteTrackingRef(remote, branch)
        return { remote }
      } catch (error) {
        if (isMissingRemoteRefGitError(error)) {
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          error: `Failed to fetch ${remote}/${branch}: ${message.split('\n')[0]}`
        }
      }
    }
    return null
  }

  // Why: compare-base is optional — losing it makes worktree create fall back to
  // the base branch (the review head itself for fork reviews), so Source Control
  // diffs the worktree against itself. Walk remotes when one lacks the branch,
  // and keep a locally-resolvable ref when the fetch dies in transport.
  const resolveCompareBaseRef = async (preferredRemote: string): Promise<string | undefined> => {
    if (!baseRefName) {
      return undefined
    }
    const baseBranch = baseRefName
    // Why: the base branch usually lives on the same remote as the head; prefer
    // it first so the original compareBaseRef shape is preserved when the head
    // remote is healthy. Walk the rest only on missing-ref.
    const orderedRemotes = Array.from(
      new Set([preferredRemote, ...remoteCandidates.filter((r) => r !== preferredRemote)])
    )
    let localOnlyRef: string | undefined
    for (const remote of orderedRemotes) {
      const compareBaseRef = `refs/remotes/${remote}/${baseBranch}`
      let fetchError: unknown
      const usable = await fetchCompareBaseRefWithLocalFallback({
        compareBaseRef,
        fetchCompareBaseRef: async () => {
          try {
            await args.fetchRemoteTrackingRef(remote, baseBranch)
          } catch (error) {
            fetchError = error
            throw error
          }
        },
        gitExec: args.gitExec,
        logLabel: '[github:resolvePrStartPoint]',
        logContext: { remote, baseRefName: baseBranch, prNumber: args.prNumber }
      })
      if (!usable) {
        continue
      }
      if (fetchError !== undefined && isMissingRemoteRefGitError(fetchError)) {
        // Why: this remote simply doesn't carry the branch, so its stale local
        // copy is a last resort — behind any remote that still publishes it.
        localOnlyRef ??= compareBaseRef
        continue
      }
      return compareBaseRef
    }
    return localOnlyRef
  }

  const fetchPullRequestHeadShaFromAnyRemote = async (): Promise<
    { remote: string; sha: string } | { error: string } | { notFoundAnywhere: true }
  > => {
    const pullRef = `refs/pull/${args.prNumber}/head`
    // Why: soft-keep needs identity when the fetch throws before returning a path.
    // Success uses the path returned by the fetch itself (writer-authoritative).
    const softKeepLocalRef = async (remote: string): Promise<string | null> => {
      try {
        const { stdout } = await args.gitExec(['remote', 'get-url', remote])
        const remoteUrl = stdout.trim()
        if (!remoteUrl) {
          return null
        }
        return githubPullRequestHeadLocalRef(
          reviewHeadRemoteRefComponent(remote, remoteUrl),
          args.prNumber
        )
      } catch {
        return null
      }
    }
    const resolveDurableHeadSha = async (localRef: string | null): Promise<string | null> => {
      if (!localRef) {
        return null
      }
      try {
        const { stdout } = await args.gitExec(['rev-parse', '--verify', `${localRef}^{commit}`])
        return stdout.trim() || null
      } catch {
        return null
      }
    }
    for (const remote of remoteCandidates) {
      try {
        const localRef = await args.fetchPullRequestHeadRef(remote, args.prNumber)
        const sha = await resolveDurableHeadSha(localRef)
        if (!sha) {
          return { error: `Could not resolve fork PR #${args.prNumber} head after fetch.` }
        }
        return { remote, sha }
      } catch (error) {
        if (isMissingRemoteRefGitError(error)) {
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        // Why: mirror compare-base — a transient transport failure must not fail
        // the resolve when a prior fetch already pinned the durable head ref. A
        // missing remote ref (deleted PR/fork), auth failure, or stale-relay
        // error must fail hard: serving the durable ref there would check out a
        // dead or unauthorized tip and mask the actionable error.
        if (isTransientReviewHeadFetchError(error)) {
          const localSha = await resolveDurableHeadSha(await softKeepLocalRef(remote))
          if (localSha) {
            console.warn(
              '[github:resolvePrStartPoint] PR head fetch failed; using durable local ref',
              {
                remote,
                prNumber: args.prNumber,
                error: message.split('\n')[0]
              }
            )
            return { remote, sha: localSha }
          }
        }
        return {
          error: `Failed to fetch ${pullRef}: ${message.split('\n')[0]}`
        }
      }
    }
    // Why: separate a genuine "missing everywhere" case from a hard failure
    // (auth/network/SSH). Only the former gets the synthesized not-found
    // message; a hard error is surfaced verbatim so the user sees the real
    // cause instead of a misleading "ref not found" message.
    return { notFoundAnywhere: true }
  }

  // Why: fork PR heads live on a remote we don't have configured, so
  // `git fetch <remote> <headRefName>` would fail. GitHub exposes every
  // PR head (fork or same-repo) as refs/pull/<N>/head on the upstream repo.
  if (isCrossRepository) {
    const headResult = await fetchPullRequestHeadShaFromAnyRemote()
    if ('notFoundAnywhere' in headResult) {
      return {
        error: `Failed to fetch refs/pull/${args.prNumber}/head from any configured remote (${remoteCandidates.join(', ')}).`
      }
    }
    if ('error' in headResult) {
      return headResult
    }
    const compareBaseRef = await resolveCompareBaseRef(headResult.remote)
    // Why: adopt the contributor's branch name locally (mirroring the same-repo
    // return below) so fork-PR worktrees aren't renamed with the maintainer's
    // branch prefix (e.g. `me/866`). The push refspec still targets the fork.
    return {
      baseBranch: headResult.sha,
      ...(compareBaseRef ? { compareBaseRef } : {}),
      headSha: headResult.sha,
      branchNameOverride: headRefName,
      ...(pushTarget ? { pushTarget } : {}),
      ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
    }
  }

  const headRemoteResult = await fetchBranchFromAnyRemote(headRefName)
  if (headRemoteResult === null) {
    // Why: missing fork metadata can make a fork PR look like a same-repo
    // branch. Only that missing-ref case should fall back to refs/pull.
    const headResult = await fetchPullRequestHeadShaFromAnyRemote()
    if ('notFoundAnywhere' in headResult) {
      return {
        error: `Failed to fetch ${headRefName} (or refs/pull/${args.prNumber}/head) from any configured remote (${remoteCandidates.join(', ')}).`
      }
    }
    // Why: the branch fetch missed and the pull-head fallback is what actually
    // failed, so surface its (more actionable) error rather than the branch miss.
    if ('error' in headResult) {
      return headResult
    }
    await resolvePushTarget()
    const compareBaseRef = await resolveCompareBaseRef(headResult.remote)
    return {
      baseBranch: headResult.sha,
      ...(compareBaseRef ? { compareBaseRef } : {}),
      headSha: headResult.sha,
      branchNameOverride: headRefName,
      ...(pushTarget ? { pushTarget } : {}),
      ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
    }
  }
  if ('error' in headRemoteResult) {
    return headRemoteResult
  }

  const headRemote = headRemoteResult.remote
  const remoteRef = `${headRemote}/${headRefName}`
  let headSha: string
  try {
    const { stdout } = await args.gitExec(['rev-parse', '--verify', remoteRef])
    headSha = stdout.trim()
  } catch {
    return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
  }
  if (!headSha) {
    return { error: `Empty SHA resolving PR #${args.prNumber} head.` }
  }
  const compareBaseRef = await resolveCompareBaseRef(headRemote)

  return {
    baseBranch: headSha,
    ...(compareBaseRef ? { compareBaseRef } : {}),
    headSha,
    branchNameOverride: headRefName,
    pushTarget: { remoteName: headRemote, branchName: headRefName }
  }
}
