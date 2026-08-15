// Types, enum tables and the count cap for the nested-repo telemetry funnel.
// The payload logic is cut over to `orca_core::nested_repo_telemetry`; the
// builders live in `./nested-repo-telemetry-payloads.ts`, which is what
// production imports.
import type { NestedRepoScanResult, ProjectGroupImportMode } from './types'

export const NESTED_REPO_TELEMETRY_MAX_REPO_COUNT = 500

export const NESTED_REPO_TELEMETRY_SURFACES = ['onboarding', 'sidebar'] as const
export type NestedRepoTelemetrySurface = (typeof NESTED_REPO_TELEMETRY_SURFACES)[number]

export const NESTED_REPO_TELEMETRY_RUNTIME_KINDS = ['local', 'runtime', 'ssh'] as const
export type NestedRepoTelemetryRuntimeKind = (typeof NESTED_REPO_TELEMETRY_RUNTIME_KINDS)[number]

export const NESTED_REPO_SCAN_RESULTS = [
  'review_shown',
  'git_repo',
  'no_nested_repos',
  'scan_failed'
] as const
export type NestedRepoScanTelemetryResult = (typeof NESTED_REPO_SCAN_RESULTS)[number]

export const NESTED_REPO_IMPORT_ACTIONS = [
  'import_group',
  'import_separate',
  'open_as_folder',
  'back'
] as const
export type NestedRepoImportTelemetryAction = (typeof NESTED_REPO_IMPORT_ACTIONS)[number]

export const NESTED_REPO_IMPORT_OUTCOMES = ['success', 'partial_failure', 'failed'] as const
export type NestedRepoImportTelemetryOutcome = (typeof NESTED_REPO_IMPORT_OUTCOMES)[number]

export const NESTED_REPO_COUNT_BUCKETS = ['0', '1', '2-3', '4-7', '8-15', '16+'] as const
export type NestedRepoCountBucket = (typeof NESTED_REPO_COUNT_BUCKETS)[number]

type NestedRepoTelemetryBase = {
  attempt_id: string
  surface: NestedRepoTelemetrySurface
  runtime_kind: NestedRepoTelemetryRuntimeKind
}

export type NestedRepoScanTelemetry = NestedRepoTelemetryBase & {
  result: NestedRepoScanTelemetryResult
  selected_path_kind?: NestedRepoScanResult['selectedPathKind']
  found_count: number
  found_count_bucket: NestedRepoCountBucket
  truncated: boolean
  timed_out: boolean
}

export type NestedRepoImportActionTelemetry = NestedRepoTelemetryBase & {
  action: NestedRepoImportTelemetryAction
  found_count: number
  found_count_bucket: NestedRepoCountBucket
  selected_count: number
  selected_count_bucket: NestedRepoCountBucket
  all_selected: boolean
}

export type NestedRepoImportResultTelemetry = NestedRepoTelemetryBase & {
  mode: ProjectGroupImportMode
  outcome: NestedRepoImportTelemetryOutcome
  found_count: number
  found_count_bucket: NestedRepoCountBucket
  selected_count: number
  selected_count_bucket: NestedRepoCountBucket
  imported_count: number
  imported_count_bucket: NestedRepoCountBucket
  already_known_count: number
  already_known_count_bucket: NestedRepoCountBucket
  failed_count: number
  failed_count_bucket: NestedRepoCountBucket
  all_selected: boolean
}

/** The entropy EDGE, deliberately left in TypeScript: `orca_core`'s counterpart
 *  is a pure formatter of caller-supplied bytes and `orca-dispatch` exposes no
 *  arm for it, so routing 16 random bytes through wasm would buy no logic while
 *  adding a not-ready failure mode to a value that gates the Import button. */
export function createNestedRepoTelemetryAttemptId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  // Why: keep the fallback schema-compatible without deriving from any stable repo input.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
