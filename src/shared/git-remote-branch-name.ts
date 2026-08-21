// `splitRemoteBranchName` moved to `git-remote-branch-split.ts` on the
// orca-dispatch seam. The two predicates below still call it — both run at most
// twice per operation, so routing their internal use costs nothing measurable.
import { splitRemoteBranchName } from './git-remote-branch-split'

export { splitRemoteBranchName }

export function gitRefTargetsBranchName(
  refName: string | null | undefined,
  branchName: string
): boolean {
  const trimmed = refName?.trim()
  if (!trimmed || !branchName) {
    return false
  }
  const headsPrefix = 'refs/heads/'
  if (trimmed.startsWith(headsPrefix)) {
    return trimmed.slice(headsPrefix.length) === branchName
  }
  const remotesPrefix = 'refs/remotes/'
  if (trimmed.startsWith(remotesPrefix)) {
    return splitRemoteBranchName(trimmed.slice(remotesPrefix.length))?.branchName === branchName
  }
  return trimmed === branchName || splitRemoteBranchName(trimmed)?.branchName === branchName
}

export function gitRefTargetsBranchOnRemote(
  refName: string | null | undefined,
  remoteName: string,
  branchName: string
): boolean {
  const trimmed = refName?.trim()
  if (!trimmed || !remoteName || !branchName) {
    return false
  }
  // Why: fork reviews can target fork/main while the saved base is origin/main.
  // Remote-qualified refs must match both pieces, not only the branch leaf.
  if (
    trimmed === `${remoteName}/${branchName}` ||
    trimmed === `remotes/${remoteName}/${branchName}` ||
    trimmed === `refs/remotes/${remoteName}/${branchName}`
  ) {
    return true
  }
  if (trimmed.startsWith('refs/remotes/') || trimmed.startsWith('remotes/')) {
    return false
  }
  const headsPrefix = 'refs/heads/'
  if (trimmed.startsWith(headsPrefix)) {
    return trimmed.slice(headsPrefix.length) === branchName
  }
  return trimmed === branchName
}
