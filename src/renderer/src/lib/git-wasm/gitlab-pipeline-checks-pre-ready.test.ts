// Deliberately does NOT import './init-git-wasm-for-test' at the top: this file
// exists to observe the shim BEFORE the core is ready, which is the state the
// repo-badge-color revert proved is the whole risk surface of a cut-over.
import { describe, expect, it } from 'vitest'
import { getGitWasmAvailability } from './git-wasm-availability'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import type { GitLabPipelineJob } from '../../../../shared/gitlab-types'

const failingPipeline: GitLabPipelineJob[] = [
  {
    id: 1,
    name: 'unit',
    stage: 'test',
    status: 'failed',
    webUrl: 'https://gitlab.com/g/p/-/jobs/1',
    duration: null
  },
  {
    id: 2,
    name: 'release gate',
    stage: 'deploy',
    status: 'manual',
    webUrl: 'https://gitlab.com/g/p/-/jobs/2',
    duration: null,
    allowFailure: false
  }
]

describe('gitLabPipelineJobsToPRChecks pre-ready value', () => {
  it('returns the null sentinel — never [] — while the core is still pending', () => {
    expect(getGitWasmAvailability()).toBe('pending')
    // [] is the one value that must never come back here: ChecksList renders an
    // empty list as "No checks configured", so a failing pipeline would read clean.
    expect(gitLabPipelineJobsToPRChecks(failingPipeline)).toBeNull()
    expect(gitLabPipelineJobsToPRChecks([])).toBeNull()
  })

  it('answers with the mapped rows once the core lands, so the sentinel was hiding a real answer', async () => {
    await import('./init-git-wasm-for-test')
    expect(getGitWasmAvailability()).toBe('ready')

    expect(gitLabPipelineJobsToPRChecks(failingPipeline)).toEqual([
      {
        name: 'test: unit',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://gitlab.com/g/p/-/jobs/1',
        checkRunId: 1
      },
      {
        name: 'deploy: release gate',
        status: 'completed',
        conclusion: 'action_required',
        url: 'https://gitlab.com/g/p/-/jobs/2',
        checkRunId: 2
      }
    ])
    // The empty input's ready answer is [] — which is exactly why the pre-ready
    // value has to be a sentinel and not [].
    expect(gitLabPipelineJobsToPRChecks([])).toEqual([])
  })
})
