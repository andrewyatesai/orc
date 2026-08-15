// The GitLab pipeline job → check-row mapping now lives in the Rust orca-core
// `gitlab_pipeline_checks` module (parity-proven), driven in the renderer through
// the orca-git wasm (the shared TS impl was deleted).
//
// PRE-READY VALUE: `null`, a declared not-ready SENTINEL — never an answer. The
// deleted TS returned one row per job, so its answer depends on the input and no
// constant is honest (ported-modules.md case 3); `[]` in particular is the
// dangerous direction, because the panel renders an empty list as "No checks
// configured" and a failing pipeline would read clean. Do NOT `?? []` this.
// Handled by ChecksPanel.fetchGitLabDetails: it skips that poll's setChecks,
// holds the spinner while the core is still `pending` (the ready edge refetches),
// and hides the checks list entirely once availability is terminal.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { GitLabPipelineJob } from '../../../../shared/gitlab-types'
import type { PRCheckDetail } from '../../../../shared/types'

// Why 'omit': `GitLabPipelineJob.allowFailure`/`pipelineId` are optional and an
// absent allowFailure is documented as "false — a blocking gate", so the key must
// be allowed to stay off rather than force a rejection.
function op(fn: string, input: unknown): unknown | null {
  if (!isGitWasmReady()) {
    return null
  }
  return dispatchToWasmCore('gitlab-pipeline-checks', fn, input, { undefinedProperties: 'omit' })
}

export function gitLabPipelineJobsToPRChecks(jobs: GitLabPipelineJob[]): PRCheckDetail[] | null {
  return op('gitLabPipelineJobsToPRChecks', jobs) as PRCheckDetail[] | null
}
