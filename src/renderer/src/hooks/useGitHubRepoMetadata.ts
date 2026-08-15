import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { GitHubAssignableUser } from '../../../shared/types'
import { clearMetadataRequestStore, createMetadataRequestStore } from './metadata-request-cache'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

type GitHubMetadataOptions = {
  runtimeEnvironmentId?: string | null
  activeRuntimeEnvironmentId?: string | null
}

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function clearGitHubMetadataCache(): void {
  clearMetadataRequestStore(ghLabelStore)
  clearMetadataRequestStore(ghAssigneeStore)
}

export function useRepoLabels(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<string> {
  const runtimeEnvironmentId =
    options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
  const repoSelector = repoId ?? repoPath ?? ''
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
        : repoSelector
      : null

  return useMetadataListRequest({
    cacheKey,
    store: ghLabelStore,
    errorFallback: 'Failed to load labels',
    load: () =>
      runtimeEnvironmentId
        ? callRuntimeRpc<string[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listLabels',
            { repo: repoSelector },
            { timeoutMs: 15_000 }
          )
        : window.api.gh
            .listLabels({ repoPath: repoPath ?? '', repoId: repoId ?? undefined })
            .then((labels) => labels as string[])
  })
}

export function useRepoAssignees(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<GitHubAssignableUser> {
  const runtimeEnvironmentId =
    options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
  const repoSelector = repoId ?? repoPath ?? ''
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
        : repoSelector
      : null

  return useMetadataListRequest({
    cacheKey,
    store: ghAssigneeStore,
    errorFallback: 'Failed to load assignees',
    load: () =>
      runtimeEnvironmentId
        ? callRuntimeRpc<GitHubAssignableUser[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listAssignableUsers',
            { repo: repoSelector },
            { timeoutMs: 15_000 }
          )
        : window.api.gh
            .listAssignableUsers({ repoPath: repoPath ?? '', repoId: repoId ?? undefined })
            .then((users) => users as GitHubAssignableUser[])
  })
}
