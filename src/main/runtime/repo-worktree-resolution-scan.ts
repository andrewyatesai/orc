import type { GitWorktreeInfo } from '../../shared/types'
import { listWorktreesStrict } from '../git/worktree'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: GitWorktreeInfo[] }

// Why: listWorktreesStrict throws on a spawn/git failure instead of swallowing it into a
// zero-row success, so a degraded local scan degrades honestly instead of masquerading as empty.
export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions
): Promise<RuntimeWorktreeScanResult> {
  try {
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees }
  } catch {
    return { ok: false, worktrees: [] }
  }
}
