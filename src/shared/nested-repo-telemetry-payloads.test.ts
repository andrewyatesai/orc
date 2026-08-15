// The deleted twin's own cases, moved verbatim onto the shim. `config/
// vitest-orca-dispatch-seam.ts` binds the seam for every test file, so these run
// against the Rust core through the same path production takes.
import { describe, expect, it } from 'vitest'
import { NESTED_REPO_TELEMETRY_MAX_REPO_COUNT } from './nested-repo-telemetry'
import {
  bucketNestedRepoTelemetryCount,
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry,
  buildNestedRepoScanTelemetry,
  capNestedRepoTelemetryCount,
  shouldEmitNestedRepoImportSubmitTelemetry
} from './nested-repo-telemetry-payloads'
import { isOrcaDispatchReady } from './orca-dispatch-seam'
import type { NestedRepoScanResult, ProjectGroupImportResult } from './types'

const scanResult: NestedRepoScanResult = {
  selectedPath: '/workspace/platform',
  selectedPathKind: 'non_git_folder',
  repos: [
    { path: '/workspace/platform/apps/web', displayName: 'web', depth: 2 },
    { path: '/workspace/platform/services/api', displayName: 'api', depth: 2 },
    { path: '/workspace/platform/services/billing', displayName: 'billing', depth: 2 }
  ],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 42,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
}
const attemptId = '2fbac1e3-5094-45b4-80a6-90281e6e9e09'
const nextAttemptId = 'd22bb9e0-b7f8-480a-8a2a-9b34f84f2c42'

describe('nested repo telemetry payloads', () => {
  it('reaches the Rust core rather than passing on an unbound seam', () => {
    expect(isOrcaDispatchReady()).toBe(true)
  })

  it('caps and buckets repo counts for low-cardinality breakdowns', () => {
    expect(capNestedRepoTelemetryCount(-1)).toBe(0)
    expect(capNestedRepoTelemetryCount(2.9)).toBe(2)
    expect(capNestedRepoTelemetryCount(Number.NaN)).toBe(0)
    expect(capNestedRepoTelemetryCount(999)).toBe(NESTED_REPO_TELEMETRY_MAX_REPO_COUNT)

    expect(bucketNestedRepoTelemetryCount(0)).toBe('0')
    expect(bucketNestedRepoTelemetryCount(1)).toBe('1')
    expect(bucketNestedRepoTelemetryCount(3)).toBe('2-3')
    expect(bucketNestedRepoTelemetryCount(7)).toBe('4-7')
    expect(bucketNestedRepoTelemetryCount(15)).toBe('8-15')
    expect(bucketNestedRepoTelemetryCount(16)).toBe('16+')
  })

  // Every value the codec REFUSES to encode, and which main's superRefine can
  // still hand this function off an IPC payload: each must answer as the twin
  // did instead of throwing a DispatchPayloadError into the validator.
  it('answers the un-encodable numbers the twin accepted', () => {
    expect(capNestedRepoTelemetryCount(Number.POSITIVE_INFINITY)).toBe(0)
    expect(capNestedRepoTelemetryCount(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(capNestedRepoTelemetryCount(-0)).toBe(0)
    expect(bucketNestedRepoTelemetryCount(Number.NaN)).toBe('0')
    expect(bucketNestedRepoTelemetryCount(Number.POSITIVE_INFINITY)).toBe('0')
    expect(bucketNestedRepoTelemetryCount(-0)).toBe('0')
    expect(bucketNestedRepoTelemetryCount(1e21)).toBe('16+')
  })

  // Regression: the submit predicate asks only `> 0`, but the adapter reads the
  // count with serde's `as_i64`, which answers 0 for a fraction — a floor here
  // flipped the twin's `true` to `false`, and this predicate GATES THE IMPORT.
  it('keeps the twin submit verdict for counts the core cannot read as an integer', () => {
    expect(shouldEmitNestedRepoImportSubmitTelemetry({ attemptId, selectedCount: 0.5 })).toBe(true)
    expect(
      shouldEmitNestedRepoImportSubmitTelemetry({
        attemptId,
        selectedCount: Number.POSITIVE_INFINITY
      })
    ).toBe(true)
    expect(
      shouldEmitNestedRepoImportSubmitTelemetry({
        attemptId,
        selectedCount: Number.NEGATIVE_INFINITY
      })
    ).toBe(false)
    expect(shouldEmitNestedRepoImportSubmitTelemetry({ attemptId, selectedCount: -0 })).toBe(false)
  })

  // The known boundary, pinned so it is a recorded fact and not a surprise: the
  // adapter reads counts with `as_i64`, so the shim clamps at 2^53-1 and two
  // DISTINCT counts above it compare equal in `all_selected` where the twin said
  // false. Unreachable — both counts are an Array length / a Set size — and the
  // largest reachable value round-trips exactly, which is what this asserts.
  it('is exact at the largest reachable count and clamps only beyond it', () => {
    const reachable = 2 ** 32 - 1
    expect(
      buildNestedRepoImportActionTelemetry({
        attemptId,
        surface: 'sidebar',
        runtimeKind: 'local',
        action: 'import_group',
        foundCount: reachable,
        selectedCount: reachable
      })?.all_selected
    ).toBe(true)
    expect(
      buildNestedRepoImportActionTelemetry({
        attemptId,
        surface: 'sidebar',
        runtimeKind: 'local',
        action: 'import_group',
        foundCount: reachable,
        selectedCount: reachable - 1
      })?.all_selected
    ).toBe(false)
  })

  it('classifies a scan that should show nested repo review', () => {
    expect(
      buildNestedRepoScanTelemetry({
        attemptId,
        surface: 'onboarding',
        runtimeKind: 'local',
        scan: scanResult
      })
    ).toEqual({
      attempt_id: attemptId,
      surface: 'onboarding',
      runtime_kind: 'local',
      result: 'review_shown',
      selected_path_kind: 'non_git_folder',
      found_count: 3,
      found_count_bucket: '2-3',
      truncated: false,
      timed_out: false
    })
  })

  // The candidate paths never cross the boundary (the core reads the length), so
  // an unpaired surrogate out of a Windows filename cannot fail the encode and
  // throw into the add-repo flow.
  it('builds a scan payload even when a candidate path holds a lone surrogate', () => {
    expect(
      buildNestedRepoScanTelemetry({
        attemptId,
        surface: 'sidebar',
        runtimeKind: 'local',
        scan: {
          ...scanResult,
          selectedPath: '/workspace/pl\ud800atform',
          repos: [{ path: '/workspace/\ud800', displayName: '\ud800', depth: 1 }]
        }
      })
    ).toEqual({
      attempt_id: attemptId,
      surface: 'sidebar',
      runtime_kind: 'local',
      result: 'review_shown',
      selected_path_kind: 'non_git_folder',
      found_count: 1,
      found_count_bucket: '1',
      truncated: false,
      timed_out: false
    })
  })

  it('classifies a failed scan and omits selected_path_kind', () => {
    expect(
      buildNestedRepoScanTelemetry({
        attemptId,
        surface: 'sidebar',
        runtimeKind: 'ssh',
        scan: null
      })
    ).toEqual({
      attempt_id: attemptId,
      surface: 'sidebar',
      runtime_kind: 'ssh',
      result: 'scan_failed',
      found_count: 0,
      found_count_bucket: '0',
      truncated: false,
      timed_out: false
    })
  })

  it('records import action selection without raw path details', () => {
    expect(
      buildNestedRepoImportActionTelemetry({
        attemptId,
        surface: 'sidebar',
        runtimeKind: 'ssh',
        action: 'import_group',
        foundCount: 3,
        selectedCount: 2
      })
    ).toEqual({
      attempt_id: attemptId,
      surface: 'sidebar',
      runtime_kind: 'ssh',
      action: 'import_group',
      found_count: 3,
      found_count_bucket: '2-3',
      selected_count: 2,
      selected_count_bucket: '2-3',
      all_selected: false
    })
  })

  it('computes all_selected from raw counts before caps are applied', () => {
    const action = buildNestedRepoImportActionTelemetry({
      attemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      action: 'import_group',
      foundCount: 600,
      selectedCount: 500
    })
    const result = buildNestedRepoImportResultTelemetry({
      attemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      mode: 'group',
      foundCount: 600,
      selectedCount: 500,
      result: { importedCount: 500, alreadyKnownCount: 0, failedCount: 0, projects: [] }
    })

    expect(action?.found_count).toBe(500)
    expect(action?.selected_count).toBe(500)
    expect(action?.all_selected).toBe(false)
    expect(result.all_selected).toBe(false)
  })

  it('keeps exact imported counts on import result payloads', () => {
    const result: ProjectGroupImportResult = {
      importedCount: 2,
      alreadyKnownCount: 1,
      failedCount: 1,
      projects: [
        { path: '/workspace/platform/apps/web', projectId: 'web', status: 'imported' },
        { path: '/workspace/platform/services/api', projectId: 'api', status: 'imported' },
        {
          path: '/workspace/platform/services/billing',
          projectId: 'billing',
          status: 'already-known'
        },
        { path: '/workspace/platform/tools/cli', status: 'failed', error: 'Not a git repo' }
      ]
    }

    expect(
      buildNestedRepoImportResultTelemetry({
        attemptId,
        surface: 'onboarding',
        runtimeKind: 'runtime',
        mode: 'group',
        foundCount: 4,
        selectedCount: 4,
        result
      })
    ).toMatchObject({
      attempt_id: attemptId,
      surface: 'onboarding',
      runtime_kind: 'runtime',
      mode: 'group',
      outcome: 'partial_failure',
      found_count: 4,
      selected_count: 4,
      imported_count: 2,
      already_known_count: 1,
      failed_count: 1,
      all_selected: true
    })
  })

  it('threads one attempt id across scan, action, and result and allows a new scan id', () => {
    const scan = buildNestedRepoScanTelemetry({
      attemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      scan: scanResult
    })
    const action = buildNestedRepoImportActionTelemetry({
      attemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      action: 'import_separate',
      foundCount: 3,
      selectedCount: 3
    })
    const result = buildNestedRepoImportResultTelemetry({
      attemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      mode: 'separate',
      foundCount: 3,
      selectedCount: 3,
      result: { importedCount: 3, alreadyKnownCount: 0, failedCount: 0, projects: [] }
    })
    const nextScan = buildNestedRepoScanTelemetry({
      attemptId: nextAttemptId,
      surface: 'sidebar',
      runtimeKind: 'local',
      scan: scanResult
    })

    expect(action?.attempt_id).toBe(scan?.attempt_id)
    expect(result.attempt_id).toBe(scan?.attempt_id)
    expect(nextScan?.attempt_id).not.toBe(scan?.attempt_id)
  })

  it('prevents zero-selection submit telemetry', () => {
    expect(
      shouldEmitNestedRepoImportSubmitTelemetry({
        attemptId,
        selectedCount: 0
      })
    ).toBe(false)
    expect(
      shouldEmitNestedRepoImportSubmitTelemetry({
        attemptId,
        selectedCount: 1,
        isBusy: true
      })
    ).toBe(false)
    expect(
      shouldEmitNestedRepoImportSubmitTelemetry({
        attemptId,
        selectedCount: 1
      })
    ).toBe(true)
    expect(
      shouldEmitNestedRepoImportSubmitTelemetry({
        attemptId: null,
        selectedCount: 5
      })
    ).toBe(false)
  })
})
