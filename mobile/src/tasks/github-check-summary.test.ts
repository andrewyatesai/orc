import { describe, expect, it } from 'vitest'
import { buildGitHubCheckSummary, type GitHubCheckLike } from './github-check-summary'
import { buildGitLabCheckSummary, type GitLabPipelineJobLike } from './gitlab-check-summary'
import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/types'

describe('buildGitHubCheckSummary', () => {
  it('returns none for empty check lists', () => {
    expect(buildGitHubCheckSummary([])).toEqual({
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      neutral: 0
    })
  })

  it('prioritizes failed checks over pending checks', () => {
    expect(
      buildGitHubCheckSummary([
        { status: 'completed', conclusion: 'success' },
        { status: 'queued', conclusion: null },
        { status: 'completed', conclusion: 'timed_out' }
      ])
    ).toEqual({
      state: 'failure',
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1,
      neutral: 0
    })
  })

  it('keeps neutral and unknown terminal conclusions out of passed without demoting the PR', () => {
    expect(
      buildGitHubCheckSummary([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'neutral' }
      ])
    ).toEqual({
      state: 'success',
      total: 2,
      passed: 1,
      failed: 0,
      pending: 0,
      neutral: 1
    })
  })

  it('rolls up GitLab jobs with unknown terminal statuses as neutral', () => {
    expect(buildGitLabCheckSummary([{ status: 'success' }, { status: 'future_status' }])).toEqual({
      state: 'success',
      total: 2,
      passed: 1,
      failed: 0,
      pending: 0,
      neutral: 1
    })
  })
})

type ParityCase = {
  name: string
  checks: GitHubCheckLike[]
  expected: Omit<ProviderCheckSummary, 'total'>
}

const completed = (conclusion: string): GitHubCheckLike => ({ status: 'completed', conclusion })

const PARITY_CASES: ParityCase[] = [
  {
    name: 'all success',
    checks: [completed('success'), completed('success')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus skipped',
    checks: [completed('success'), completed('skipped')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'all skipped',
    checks: [completed('skipped'), completed('skipped')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus neutral',
    checks: [completed('success'), completed('neutral')],
    expected: { state: 'success', passed: 1, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'all neutral',
    checks: [completed('neutral')],
    expected: { state: 'neutral', passed: 0, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'success plus failure',
    checks: [completed('success'), completed('failure')],
    expected: { state: 'failure', passed: 1, failed: 1, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus running',
    checks: [completed('success'), { status: 'in_progress', conclusion: null }],
    expected: { state: 'pending', passed: 1, failed: 0, pending: 1, neutral: 0 }
  },
  {
    name: 'genuine action_required',
    checks: [completed('success'), completed('action_required')],
    expected: { state: 'failure', passed: 1, failed: 1, pending: 0, neutral: 0 }
  }
]

describe('mobile / desktop check classification parity', () => {
  it.each(PARITY_CASES)('$name matches the shared desktop classifier', ({ checks, expected }) => {
    const summary = { ...expected, total: checks.length }
    expect(buildGitHubCheckSummary(checks)).toEqual(summary)
    expect(summarizeProviderChecks(checks)).toEqual(summary)
  })

  it.each([
    {
      name: 'optional GitLab manual gate only',
      jobs: [{ status: 'manual', allowFailure: true }],
      expected: { state: 'neutral', passed: 0, failed: 0, pending: 0, neutral: 1 }
    },
    {
      name: 'optional GitLab manual gate alongside a green pipeline',
      jobs: [{ status: 'manual', allowFailure: true }, { status: 'success' }],
      expected: { state: 'success', passed: 1, failed: 0, pending: 0, neutral: 1 }
    },
    {
      // Why: a required manual gate blocks the pipeline, so it reads action_required here just as
      // it does in the desktop Rust job mapper — a green-looking mobile row would contradict it.
      name: 'blocking GitLab manual gate alongside a green pipeline',
      jobs: [{ status: 'manual' }, { status: 'success' }],
      expected: { state: 'failure', passed: 1, failed: 1, pending: 0, neutral: 0 }
    }
  ] satisfies {
    name: string
    jobs: GitLabPipelineJobLike[]
    expected: Omit<ProviderCheckSummary, 'total'>
  }[])('$name matches the desktop GitLab job mapper', ({ jobs, expected }) => {
    expect(buildGitLabCheckSummary(jobs)).toEqual({ ...expected, total: jobs.length })
  })
})
