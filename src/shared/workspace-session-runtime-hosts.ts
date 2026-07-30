import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { Repo } from './types'

/** Collect the distinct runtime hosts owning any persisted repo.
 *
 *  Shared so the renderer's boot-time session merge and main's startup-snapshot
 *  handler enumerate the same per-host session partitions. */
export function listKnownRuntimeHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const repo of repos) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (parsed?.kind === 'runtime') {
      hostIds.add(parsed.id)
    }
  }
  return [...hostIds]
}
