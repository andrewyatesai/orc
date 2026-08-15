import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { getSelectedNestedRepoPathsInScanOrder } from '@/lib/nested-repo-selected-paths'
import type { NestedRepoTelemetryRuntimeKind } from '../../../../shared/nested-repo-telemetry'
import {
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry,
  shouldEmitNestedRepoImportSubmitTelemetry
} from '../../../../shared/nested-repo-telemetry-payloads'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { NestedRepoScanResult, ProjectGroupImportResult } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export function useAddRepoNestedImportFlow({
  nestedAttemptId,
  nestedScan,
  nestedSelectedPaths,
  nestedRuntimeKind,
  nestedConnectionId,
  nestedGroupName,
  nestedImportScanId,
  activeRuntimeEnvironmentId,
  closeModal,
  fetchWorktrees,
  importNestedRepos,
  getNestedRepoRuntimeKind,
  onGitRepoReady,
  setIsAdding
}: {
  nestedAttemptId: string | null
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  nestedRuntimeKind: NestedRepoTelemetryRuntimeKind | null
  nestedConnectionId: string | null
  nestedGroupName: string
  nestedImportScanId: string | null
  activeRuntimeEnvironmentId: string | null | undefined
  /** Why: hosted (composer-nested) mode routes this to closing only the
   *  nested dialog; store-modal mode routes it to the activeModal slot. */
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: { requireAuthoritative?: boolean }) => Promise<unknown>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
  onGitRepoReady: (repoId: string, source: AddRepoExistingWorkspaceSource) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
}): {
  handleImportNestedRepos: (mode: 'group' | 'separate') => Promise<void>
  handleOpenNestedRootFolder: () => Promise<void>
  resetNestedImportFlow: () => void
  trackNestedBackAction: () => void
} {
  const nestedImportGenRef = useRef(0)

  const resetNestedImportFlow = useCallback((): void => {
    nestedImportGenRef.current++
  }, [])

  const trackNestedBackAction = useCallback((): void => {
    if (!nestedScan || !nestedAttemptId) {
      return
    }
    // null = Rust core not ready; drop this step rather than guess a payload.
    const actionTelemetry = buildNestedRepoImportActionTelemetry({
      attemptId: nestedAttemptId,
      surface: 'sidebar',
      runtimeKind: nestedRuntimeKind ?? getNestedRepoRuntimeKind(nestedConnectionId),
      action: 'back',
      foundCount: nestedScan.repos.length,
      selectedCount: nestedSelectedPaths.size
    })
    if (actionTelemetry) {
      track('add_repo_nested_import_action', actionTelemetry)
    }
  }, [
    getNestedRepoRuntimeKind,
    nestedAttemptId,
    nestedConnectionId,
    nestedRuntimeKind,
    nestedScan,
    nestedSelectedPaths.size
  ])

  const handleImportNestedRepos = useCallback(
    async (mode: 'group' | 'separate'): Promise<void> => {
      const attemptId = nestedAttemptId
      if (
        !nestedScan ||
        !attemptId ||
        !shouldEmitNestedRepoImportSubmitTelemetry({
          attemptId,
          selectedCount: nestedSelectedPaths.size
        })
      ) {
        return
      }
      const foundCount = nestedScan.repos.length
      const selectedCount = nestedSelectedPaths.size
      const selectedProjectPaths = getSelectedNestedRepoPathsInScanOrder(
        nestedScan,
        nestedSelectedPaths
      )
      const runtimeKind = nestedRuntimeKind ?? getNestedRepoRuntimeKind(nestedConnectionId)
      const gen = ++nestedImportGenRef.current
      setIsAdding(true)
      // null = Rust core not ready; drop the funnel step, never the import.
      const actionTelemetry = buildNestedRepoImportActionTelemetry({
        attemptId,
        surface: 'sidebar',
        runtimeKind,
        action: mode === 'group' ? 'import_group' : 'import_separate',
        foundCount,
        selectedCount
      })
      if (actionTelemetry) {
        track('add_repo_nested_import_action', actionTelemetry)
      }
      let resultTracked = false
      try {
        const result = await importNestedRepos({
          parentPath: nestedScan.selectedPath,
          groupName: nestedGroupName,
          // Why: Set insertion order can drift after deselect/reselect; import
          // ordering should match the visible scan order users reviewed.
          projectPaths: selectedProjectPaths,
          ...(nestedConnectionId ? { connectionId: nestedConnectionId } : {}),
          ...(nestedImportScanId ? { scanId: nestedImportScanId } : {}),
          mode
        })
        // Why before the emit: this flag means "the result step is settled for
        // this attempt". Set after, a builder that throws would leave it false
        // and the `finally` would re-emit the step as `result: null` — a second,
        // FALSIFIED "failed" outcome for an import that actually succeeded.
        resultTracked = true
        track(
          'add_repo_nested_import_result',
          buildNestedRepoImportResultTelemetry({
            attemptId,
            surface: 'sidebar',
            runtimeKind,
            mode,
            foundCount,
            selectedCount,
            result
          })
        )
        if (!result) {
          return
        }
        const importedRepoIds = result.projects
          .map((entry) => entry.projectId)
          .filter((projectId): projectId is string => typeof projectId === 'string')
        const firstRepoId = importedRepoIds[0]
        if (!firstRepoId) {
          const firstFailure = result.projects.find((entry) => entry.status === 'failed')?.error
          if (gen === nestedImportGenRef.current) {
            toast.error(
              translate(
                'auto.components.sidebar.useAddRepoNestedImportFlow.1b33c5f090',
                'No repositories imported'
              ),
              {
                description: firstFailure ?? undefined
              }
            )
          }
          return
        }
        for (const projectId of importedRepoIds) {
          // Why: imported repos are already persisted; non-authoritative SSH
          // refreshes should not block revealing the first imported project.
          await fetchWorktrees(projectId, { requireAuthoritative: true })
        }
        if (gen !== nestedImportGenRef.current) {
          return
        }
        if (result.failedCount > 0) {
          toast.warning(
            translate(
              'auto.components.sidebar.useAddRepoNestedImportFlow.cbfbc7a797',
              'Some repositories could not be imported'
            ),
            {
              description: translate(
                'auto.components.sidebar.useAddRepoNestedImportFlow.680cac2c82',
                '{{value0}} failed',
                { value0: result.failedCount }
              )
            }
          )
        }
        const repo = useAppStore.getState().repos.find((entry) => entry.id === firstRepoId)
        if (repo) {
          const source: AddRepoExistingWorkspaceSource = nestedConnectionId
            ? 'ssh_remote_path'
            : activeRuntimeEnvironmentId?.trim()
              ? 'runtime_server_path'
              : 'local_folder_picker'
          await onGitRepoReady(repo.id, source)
        }
      } catch (err) {
        if (gen === nestedImportGenRef.current) {
          toast.error(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!resultTracked) {
          track(
            'add_repo_nested_import_result',
            buildNestedRepoImportResultTelemetry({
              attemptId,
              surface: 'sidebar',
              runtimeKind,
              mode,
              foundCount,
              selectedCount,
              result: null
            })
          )
        }
        if (gen === nestedImportGenRef.current) {
          setIsAdding(false)
        }
      }
    },
    [
      activeRuntimeEnvironmentId,
      fetchWorktrees,
      importNestedRepos,
      nestedAttemptId,
      nestedConnectionId,
      nestedGroupName,
      nestedImportScanId,
      nestedRuntimeKind,
      nestedScan,
      nestedSelectedPaths,
      getNestedRepoRuntimeKind,
      onGitRepoReady,
      setIsAdding
    ]
  )

  const handleOpenNestedRootFolder = useCallback(async (): Promise<void> => {
    if (!nestedScan) {
      return
    }
    const gen = ++nestedImportGenRef.current
    const path = nestedScan.selectedPath
    if (nestedAttemptId) {
      // null = Rust core not ready; drop this step rather than guess a payload.
      const actionTelemetry = buildNestedRepoImportActionTelemetry({
        attemptId: nestedAttemptId,
        surface: 'sidebar',
        runtimeKind: nestedRuntimeKind ?? getNestedRepoRuntimeKind(nestedConnectionId),
        action: 'open_as_folder',
        foundCount: nestedScan.repos.length,
        selectedCount: nestedSelectedPaths.size
      })
      if (actionTelemetry) {
        track('add_repo_nested_import_action', actionTelemetry)
      }
    }
    setIsAdding(true)
    try {
      const state = useAppStore.getState()
      if (nestedConnectionId) {
        // Why: the non-git confirm dialog is a store-modal handoff that ends
        // in folder-workspace activation; close this add flow (nested dialog
        // or store modal) before handing over.
        closeModal()
        state.openModal('confirm-non-git-folder', {
          folderPath: path,
          connectionId: nestedConnectionId
        })
        return
      }
      const repo = await state.addNonGitFolder(path, {
        runtimeEnvironmentId: activeRuntimeEnvironmentId?.trim() || null
      })
      if (gen !== nestedImportGenRef.current) {
        return
      }
      if (repo) {
        closeModal()
      }
    } catch (err) {
      if (gen === nestedImportGenRef.current) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (gen === nestedImportGenRef.current) {
        setIsAdding(false)
      }
    }
  }, [
    activeRuntimeEnvironmentId,
    closeModal,
    getNestedRepoRuntimeKind,
    nestedAttemptId,
    nestedConnectionId,
    nestedRuntimeKind,
    nestedScan,
    nestedSelectedPaths.size,
    setIsAdding
  ])

  return {
    handleImportNestedRepos,
    handleOpenNestedRootFolder,
    resetNestedImportFlow,
    trackNestedBackAction
  }
}
