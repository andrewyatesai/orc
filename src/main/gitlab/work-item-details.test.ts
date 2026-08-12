import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  glabExecFileAsyncMock,
  getGlabKnownHostsMock,
  resolveIssueSourceMock,
  glabRepoExecOptionsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  glabRepoExecOptionsMock: vi.fn(
    (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions: { wslDistro?: string } = {}
    ) => (connectionId ? {} : { cwd: repoPath, ...localGitOptions })
  ),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  getGlabKnownHosts: getGlabKnownHostsMock,
  resolveIssueSource: resolveIssueSourceMock,
  glabExecFileAsync: glabExecFileAsyncMock,
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: glabRepoExecOptionsMock
}))

import { getMRChecks, getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    resolveIssueSourceMock.mockReset()
    glabRepoExecOptionsMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    })
  })

  it('caps MR detail discussions, jobs, and file diffs to one API page', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'Bound detail payloads',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'feature/bounds',
            target_branch: 'main',
            description: 'MR body',
            sha: 'head-sha',
            diff_refs: { base_sha: 'base-sha', start_sha: 'start-sha' },
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 'discussion-1',
              notes: [
                {
                  id: 1,
                  body: 'Review note',
                  created_at: '2026-05-31T12:01:00Z',
                  author: { username: 'alice', avatar_url: 'https://example.com/a.png' }
                }
              ]
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              name: 'verify',
              stage: 'test',
              status: 'success',
              allow_failure: true,
              web_url: 'https://gitlab.com/g/p/-/jobs/10',
              duration: 12
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              new_path: 'src/app.ts',
              old_path: 'src/app.ts',
              diff: '@@ -1 +1 @@\n-old\n+new'
            }
          ])
        }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')

    expect(details?.comments).toHaveLength(1)
    expect(details?.pipelineJobs).toHaveLength(1)
    // allow_failure must survive the mapping — the checks classifier splits
    // manual jobs on it (blocking → action_required, optional → neutral).
    expect(details?.pipelineJobs?.[0]).toMatchObject({ allowFailure: true })
    expect(details?.files).toHaveLength(1)
    expect(details?.files?.[0]).toMatchObject({
      path: 'src/app.ts',
      additions: 1,
      deletions: 1
    })
    expect(glabExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'api',
      'projects/g%2Fp/merge_requests/12/diffs?per_page=100'
    ])
    expect(glabExecFileAsyncMock.mock.calls.flatMap(([args]) => args)).not.toContain('--paginate')
  })

  it('expands bridge child-pipeline jobs into the checks list', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'Bridge pipeline',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'feature/bridges',
            target_branch: 'main',
            description: 'MR body',
            sha: 'head-sha',
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              name: 'semgrep-sast',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/10',
              duration: 12
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 50,
              name: 'trigger-ci',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/50',
              downstream_pipeline: {
                id: 200,
                status: 'failed',
                web_url: 'https://gitlab.com/g/p/-/pipelines/200'
              }
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/200/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 300,
              name: 'unit',
              stage: 'test',
              status: 'failed',
              web_url: 'https://gitlab.com/g/p/-/jobs/300',
              duration: 40
            },
            {
              id: 301,
              name: 'lint',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/301',
              duration: 20
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return { stdout: '[]' }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')
    const names = (details?.pipelineJobs ?? []).map((job) => job.name).sort()
    expect(names).toEqual(['lint', 'semgrep-sast', 'trigger-ci', 'unit'])
    // Child-pipeline job keeps its own pipelineId + status (the failing `unit`).
    expect(details?.pipelineJobs?.find((job) => job.name === 'unit')).toMatchObject({
      id: 300,
      status: 'failed',
      pipelineId: 200
    })
    // Bridge rollup row: no positive id (no trace/retry) and the child's status.
    expect(details?.pipelineJobs?.find((job) => job.name === 'trigger-ci')).toMatchObject({
      id: 0,
      status: 'failed',
      pipelineId: 99
    })
  })

  // Why: each fetch spawns a `glab` binary (a remote exec over SSH) and this runs on the Checks
  // poll timer, so a bridge-heavy MR must trickle its children rather than burst them.
  it('bounds concurrent child-pipeline fetches', async () => {
    const BRIDGE_COUNT = 25
    let inFlightJobPages = 0
    let peakJobPages = 0

    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1) as string
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            iid: 12,
            title: 'Fan out',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'f',
            target_branch: 'main',
            sha: 'head-sha',
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return {
          stdout: JSON.stringify(
            Array.from({ length: BRIDGE_COUNT }, (_, i) => ({
              id: 500 + i,
              name: `trigger-${i}`,
              stage: 'trigger',
              status: 'success',
              downstream_pipeline: {
                id: 1000 + i,
                status: 'running',
                web_url: `https://gitlab.com/g/p/-/pipelines/${1000 + i}`
              }
            }))
          )
        }
      }
      if (/pipelines\/\d+\/jobs/.test(endpoint)) {
        inFlightJobPages += 1
        peakJobPages = Math.max(peakJobPages, inFlightJobPages)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlightJobPages -= 1
        return { stdout: '[]' }
      }
      if (endpoint.endsWith('/approvals')) {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint.endsWith('/approval_state')) {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      return { stdout: '[]' }
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')
    // Parent page can overlap the capped child pool, so allow one above the child limit.
    expect(peakJobPages).toBeLessThanOrEqual(5)
    // Every bridge still gets a rollup row even past the 20-child expansion cap.
    expect(details?.pipelineJobs).toHaveLength(BRIDGE_COUNT)
  })

  it('routes local WSL MR detail fetches through project resolution and glab options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'WSL detail',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-06-16T00:00:00Z',
            description: 'MR body',
            sha: 'head-sha',
            head_pipeline: null,
            reviewers: []
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return { stdout: '[]' }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails(
      '/repo',
      12,
      'mr',
      undefined,
      null,
      undefined,
      localGitOptions
    )

    expect(details?.item.number).toBe(12)
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo',
      undefined,
      ['gitlab.com'],
      null,
      localGitOptions
    )
    expect(glabExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })
})

describe('getMRChecks', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    resolveIssueSourceMock.mockReset()
    glabRepoExecOptionsMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    })
  })

  it('fetches ONLY pipeline jobs + discussions — never diffs, reviewers, or approvals', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            sha: 'head-sha',
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 'discussion-1',
              notes: [
                {
                  id: 1,
                  body: 'Review note',
                  created_at: '2026-05-31T12:01:00Z',
                  author: { username: 'alice', avatar_url: 'https://example.com/a.png' }
                }
              ]
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              name: 'verify',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/10',
              duration: 12
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return { stdout: '[]' }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const checks = await getMRChecks('/repo', 12)

    expect(checks?.comments).toHaveLength(1)
    expect(checks?.pipelineJobs).toHaveLength(1)
    // Raw payload omits allow_failure → fail closed to blocking (false).
    expect(checks?.pipelineJobs?.[0]).toMatchObject({ allowFailure: false })
    expect(checks?.headSha).toBe('head-sha')

    const endpoints = glabExecFileAsyncMock.mock.calls.map(([args]) => args.at(-1))
    expect(endpoints).toEqual(
      expect.arrayContaining([
        'projects/g%2Fp/merge_requests/12',
        'projects/g%2Fp/merge_requests/12/discussions?per_page=100',
        'projects/g%2Fp/pipelines/99/jobs?per_page=100',
        'projects/g%2Fp/pipelines/99/bridges?per_page=100'
      ])
    )
    // The wasteful dialog-bundle calls must NOT run on the checks poll.
    expect(endpoints).not.toContain('projects/g%2Fp/merge_requests/12/diffs?per_page=100')
    expect(endpoints).not.toContain('projects/g%2Fp/merge_requests/12/reviewers')
    expect(endpoints).not.toContain('projects/g%2Fp/merge_requests/12/approvals')
    expect(endpoints).not.toContain('projects/g%2Fp/merge_requests/12/approval_state')
    // MR detail + discussions + pipeline jobs + bridges (no child fan-out here).
    expect(glabExecFileAsyncMock.mock.calls).toHaveLength(4)
  })

  it('omits pipelineJobs when the MR has no head pipeline', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/7') {
        return { stdout: JSON.stringify({ id: 70, iid: 7, sha: 'sha-7', head_pipeline: null }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/7/discussions?per_page=100') {
        return { stdout: '[]' }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const checks = await getMRChecks('/repo', 7)

    expect(checks).toEqual({ comments: [], headSha: 'sha-7' })
    // No pipeline → no jobs fetch: exactly the MR detail + discussions calls.
    expect(glabExecFileAsyncMock.mock.calls).toHaveLength(2)
  })
})
