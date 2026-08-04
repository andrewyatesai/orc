// TS twin of the Rust orca-core `gitlab_pipeline_checks` status mappers
// (rust/crates/orca-core/src/gitlab_pipeline_checks.rs), which desktop reaches over napi/wasm
// and mobile (Hermes, no WebAssembly/napi) cannot load; keep this table in step with that arm.
import type { PRCheckDetail } from '../../../src/shared/types'

const QUEUED_STATUSES = new Set([
  'created',
  'pending',
  'scheduled',
  'waiting_for_callback',
  'waiting_for_resource',
  'preparing'
])

// Why: a Map, not an object literal — an unknown status must miss, and `constructor`/`toString`
// would hit an object's prototype.
const TERMINAL_CONCLUSIONS = new Map<string, PRCheckDetail['conclusion']>([
  ['success', 'success'],
  ['failed', 'failure'],
  ['canceled', 'cancelled'],
  ['canceling', 'cancelled'],
  ['skipped', 'skipped'],
  ['action_required', 'action_required']
])

export function mapGitLabPipelineJobStatusToCheckStatus(status: string): PRCheckDetail['status'] {
  const s = status.toLowerCase()
  if (QUEUED_STATUSES.has(s)) {
    return 'queued'
  }
  return s === 'running' ? 'in_progress' : 'completed'
}

export function mapGitLabPipelineJobStatusToConclusion(
  status: string,
  allowFailure: boolean
): PRCheckDetail['conclusion'] {
  const s = status.toLowerCase()
  const terminal = TERMINAL_CONCLUSIONS.get(s)
  if (terminal !== undefined) {
    return terminal
  }
  // Why: a manual gate waits on a human — an optional one (allow_failure) is neutral, but a
  // blocking one gates the whole pipeline, so it must read action_required, never a silent pass.
  if (s === 'manual' || s === 'blocked') {
    return allowFailure ? 'neutral' : 'action_required'
  }
  if (s === 'running' || QUEUED_STATUSES.has(s)) {
    return 'pending'
  }
  return null
}
