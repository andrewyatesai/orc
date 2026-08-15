import { useCallback } from 'react'
import { track } from '@/lib/telemetry'
import { buildNestedRepoScanTelemetry } from '../../../../shared/nested-repo-telemetry-payloads'
import type { NestedRepoScanResult } from '../../../../shared/types'

export function useAddRepoRemoteNestedScan({
  setActiveNestedScanId,
  showNestedRepoReview
}: {
  setActiveNestedScanId: (scanId: string | null) => void
  showNestedRepoReview: (options: {
    scan: NestedRepoScanResult
    selectedPath: string
    connectionId: string
    attemptId: string
    runtimeKind: 'ssh'
    inProgress: boolean
    scanId: string | null
  }) => void
}) {
  const showRemoteNestedRepoReview = useCallback(
    (
      scan: NestedRepoScanResult,
      selectedPath: string,
      connectionId: string,
      attemptId: string,
      inProgress: boolean,
      scanId: string | null
    ) => {
      setActiveNestedScanId(inProgress ? scanId : null)
      showNestedRepoReview({
        scan,
        selectedPath,
        connectionId,
        attemptId,
        runtimeKind: 'ssh',
        inProgress,
        scanId
      })
    },
    [setActiveNestedScanId, showNestedRepoReview]
  )

  const trackRemoteNestedScanResult = useCallback(
    (scan: NestedRepoScanResult | null, attemptId: string) => {
      // null = Rust core not ready; drop this scan's event rather than guess one.
      const scanTelemetry = buildNestedRepoScanTelemetry({
        attemptId,
        surface: 'sidebar',
        runtimeKind: 'ssh',
        scan
      })
      if (scanTelemetry) {
        track('add_repo_nested_scan_result', scanTelemetry)
      }
    },
    []
  )

  return { showRemoteNestedRepoReview, trackRemoteNestedScanResult }
}
