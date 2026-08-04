import {
  mapGitLabPipelineJobStatusToCheckStatus,
  mapGitLabPipelineJobStatusToConclusion
} from './gitlab-pipeline-job-status'
import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/types'

// Why: an absent allowFailure fails closed (blocking), matching src/main/gitlab/work-item-details.ts,
// so the same manual gate cannot read red on desktop and green on mobile.
export type GitLabPipelineJobLike = { status: string; allowFailure?: boolean }

export function buildGitLabCheckSummary(jobs: GitLabPipelineJobLike[]): ProviderCheckSummary {
  return summarizeProviderChecks(
    jobs.map((job) => ({
      status: mapGitLabPipelineJobStatusToCheckStatus(job.status),
      conclusion: mapGitLabPipelineJobStatusToConclusion(job.status, job.allowFailure === true)
    }))
  )
}
