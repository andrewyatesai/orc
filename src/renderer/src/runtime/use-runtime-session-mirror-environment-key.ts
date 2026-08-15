import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getRuntimeSessionMirrorEnvironmentIds } from '@/lib/runtime-session-mirror-owners'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

export type RuntimeSessionMirrorKeyInputs = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
> & {
  activeRuntimeEnvironmentId: string | null
}

// Only the state the ownership scan reads — a shallow-stable slice keeps hot writes off the scan.
export function selectRuntimeSessionMirrorKeyInputs(
  state: AppState
): RuntimeSessionMirrorKeyInputs {
  return {
    activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId ?? null,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
  }
}

export function buildRuntimeSessionMirrorEnvironmentKey(
  inputs: RuntimeSessionMirrorKeyInputs
): string {
  return getRuntimeSessionMirrorEnvironmentIds({
    settings: { activeRuntimeEnvironmentId: inputs.activeRuntimeEnvironmentId },
    repos: inputs.repos,
    worktreesByRepo: inputs.worktreesByRepo,
    detectedWorktreesByRepo: inputs.detectedWorktreesByRepo,
    projectGroups: inputs.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: inputs.restoredRuntimeHostIdByWorkspaceSessionKey
  })
    .map((environmentId) => {
      const status = inputs.runtimeStatusByEnvironmentId.get(environmentId)
      const environment = inputs.runtimeEnvironments.find(
        (candidate) => candidate.id === environmentId
      )
      const pairingRevision = environment
        ? (environment.pairingRevision ?? environment.createdAt)
        : ''
      return `${environmentId}\u0001${status?.status?.runtimeId ?? ''}\u0001${status?.connectionGeneration ?? 0}\u0001${pairingRevision}`
    })
    .join('\u0000')
}

export function useRuntimeSessionMirrorEnvironmentKey(): string {
  // Why: agent/tab writes are hot; scan host ownership only when one of its sources changes.
  const {
    activeRuntimeEnvironmentId,
    repos,
    worktreesByRepo,
    detectedWorktreesByRepo,
    projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId
  } = useAppStore(useShallow(selectRuntimeSessionMirrorKeyInputs))
  return useMemo(
    () =>
      buildRuntimeSessionMirrorEnvironmentKey({
        activeRuntimeEnvironmentId,
        repos,
        worktreesByRepo,
        detectedWorktreesByRepo,
        projectGroups,
        restoredRuntimeHostIdByWorkspaceSessionKey,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId
      }),
    [
      activeRuntimeEnvironmentId,
      repos,
      worktreesByRepo,
      detectedWorktreesByRepo,
      projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId
    ]
  )
}
