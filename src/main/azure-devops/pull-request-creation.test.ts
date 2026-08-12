import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAzureDevOpsPullRequest,
  isAzureDevOpsReviewCreationAuthenticated
} from './pull-request-creation'
import { _resetAzureDevOpsPreviewApiVersionCache } from './azure-devops-api-request'
import { _resetAzureDevOpsRepoRefCache } from './repository-ref'

const { gitExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('../source-control/pull-request-template', () => ({
  readHostedPullRequestTemplate: vi.fn(async () => 'Template body')
}))

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

describe('Azure DevOps pull request creation', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://dev.azure.com/acme/Project/_git/repo\n',
      stderr: ''
    })
    _resetAzureDevOpsRepoRefCache()
    _resetAzureDevOpsPreviewApiVersionCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetAzureDevOpsRepoRefCache()
    _resetAzureDevOpsPreviewApiVersionCache()
  })

  it('treats token-only auth as sufficient for repo-scoped creation', () => {
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    expect(isAzureDevOpsReviewCreationAuthenticated()).toBe(true)
  })

  it('posts a pull request create body to the repository REST endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/acme/Project/_apis/git/repositories/repo/pullRequests')
      expect(url.searchParams.get('api-version')).toBe('7.1')
      expect(init).toBeDefined()
      const requestInit = init!
      expect(requestInit.method).toBe('POST')
      expect((requestInit.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
      expect(JSON.parse(String(requestInit.body))).toEqual({
        sourceRefName: 'refs/heads/feature/azure',
        targetRefName: 'refs/heads/main',
        title: 'Add Azure create',
        description: 'Body',
        isDraft: true
      })
      return Response.json({
        pullRequestId: 37,
        title: 'Add Azure create',
        status: 'active',
        isDraft: true,
        creationDate: '2026-06-01T00:00:00Z',
        _links: {
          web: {
            href: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/37'
          }
        }
      })
    })
    globalThis.fetch = fetchMock as never

    await expect(
      createAzureDevOpsPullRequest('/repo', {
        provider: 'azure-devops',
        base: 'origin/main',
        head: 'refs/heads/feature/azure',
        title: 'Add Azure create',
        body: 'Body',
        draft: true
      })
    ).resolves.toEqual({
      ok: true,
      number: 37,
      url: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/37'
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('retries PR creation with -preview when the Server rejects the api-version (STA-3494)', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://ado.example.com:8443/tfs/MyCollection/MyProject/_git/my-repo\n',
      stderr: ''
    })
    const versions: (string | null)[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe(
        '/tfs/MyCollection/MyProject/_apis/git/repositories/my-repo/pullRequests'
      )
      versions.push(url.searchParams.get('api-version'))
      if (!url.searchParams.get('api-version')?.endsWith('-preview')) {
        return new Response(
          JSON.stringify({
            message: 'The requested version "7.1" of the resource is under preview.',
            typeKey: 'VssInvalidPreviewVersionException'
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return Response.json({
        pullRequestId: 51,
        title: 'Server create',
        status: 'active',
        creationDate: '2026-06-01T00:00:00Z',
        _links: {
          web: {
            href: 'https://ado.example.com:8443/tfs/MyCollection/MyProject/_git/my-repo/pullrequest/51'
          }
        }
      })
    })
    globalThis.fetch = fetchMock as never

    await expect(
      createAzureDevOpsPullRequest('/repo', {
        provider: 'azure-devops',
        base: 'main',
        head: 'feature/server',
        title: 'Server create',
        body: 'Body'
      })
    ).resolves.toEqual({
      ok: true,
      number: 51,
      url: 'https://ado.example.com:8443/tfs/MyCollection/MyProject/_git/my-repo/pullrequest/51'
    })
    expect(versions).toEqual(['7.1', '7.1-preview'])
  })

  it('does not retry PR creation when only the error message names the preview exception', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { message: 'Validation failed near VssInvalidPreviewVersionException' },
        { status: 400 }
      )
    )
    globalThis.fetch = fetchMock as never

    await expect(
      createAzureDevOpsPullRequest('/repo', {
        provider: 'azure-devops',
        base: 'main',
        head: 'feature/azure',
        title: 'Do not retry'
      })
    ).resolves.toMatchObject({ ok: false, code: 'validation' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('resolves Azure DevOps remotes through the SSH git provider', async () => {
    const remoteGit = {
      exec: vi.fn(async () => ({
        stdout: 'git@ssh.dev.azure.com:v3/acme/Project/repo.git\n',
        stderr: ''
      }))
    }
    getSshGitProviderMock.mockReturnValue(remoteGit)
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        pullRequestId: 38,
        title: 'Remote Azure create',
        status: 'active',
        creationDate: '2026-06-01T00:00:00Z'
      })
    ) as never

    await expect(
      createAzureDevOpsPullRequest(
        '/remote/repo',
        {
          provider: 'azure-devops',
          base: 'main',
          head: 'feature/azure',
          title: 'Remote Azure create'
        },
        'ssh-1'
      )
    ).resolves.toMatchObject({
      ok: true,
      number: 38
    })
    expect(remoteGit.exec).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/remote/repo')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('threads WSL localGitExecOptions into the origin remote lookup for local projects', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        pullRequestId: 39,
        title: 'WSL Azure create',
        status: 'active',
        creationDate: '2026-06-01T00:00:00Z'
      })
    ) as never

    await expect(
      createAzureDevOpsPullRequest(
        '/repo',
        {
          provider: 'azure-devops',
          base: 'main',
          head: 'feature/azure',
          title: 'WSL Azure create'
        },
        null,
        { localGitExecOptions: { wslDistro: 'Ubuntu' } }
      )
    ).resolves.toMatchObject({ ok: true, number: 39 })
    // Why: pins the parity gap — a dropped options param resolves origin on the
    // Windows host instead of the WSL distro, yielding a false unsupported_provider.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
  })

  describe('write-path token-to-host binding', () => {
    function stubFetchCapturingAuth(): { authorizations: (string | null)[] } {
      const authorizations: (string | null)[] = []
      globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get('authorization'))
        return Response.json({
          pullRequestId: 7,
          title: 'PR',
          status: 'active',
          creationDate: '2026-06-01T00:00:00Z'
        })
      }) as never
      return { authorizations }
    }

    async function createOnRemote(remoteUrl: string): Promise<(string | null)[]> {
      gitExecFileAsyncMock.mockResolvedValue({ stdout: `${remoteUrl}\n`, stderr: '' })
      _resetAzureDevOpsRepoRefCache()
      const { authorizations } = stubFetchCapturingAuth()
      await createAzureDevOpsPullRequest('/repo', {
        provider: 'azure-devops',
        base: 'main',
        head: 'feature/azure',
        title: 'PR'
      })
      return authorizations
    }

    it('does not attach the PAT over cleartext http to a repo-derived Server host', async () => {
      delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
      const auths = await createOnRemote('http://attacker.internal/col/proj/_git/repo')
      expect(auths.length).toBeGreaterThan(0)
      // The PAT must never be POSTed in cleartext to a remote-controlled host.
      expect(auths.every((a) => a === null)).toBe(true)
    })

    it('does not attach the PAT to an unconfigured https Server host (wrong-host exfil)', async () => {
      delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
      const auths = await createOnRemote('https://attacker.example/proj/_git/repo')
      expect(auths.length).toBeGreaterThan(0)
      expect(auths.every((a) => a === null)).toBe(true)
    })

    it('attaches Basic auth over https to a Microsoft cloud host', async () => {
      delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
      const auths = await createOnRemote('https://dev.azure.com/acme/Project/_git/repo')
      expect(auths[0]).toMatch(/^Basic /)
    })

    it('attaches auth to an explicitly configured https base URL that matches the request host', async () => {
      process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'https://tfs.corp.example/tfs/col/proj'
      const auths = await createOnRemote('https://tfs.corp.example/tfs/col/proj/_git/repo')
      expect(auths[0]).toMatch(/^Basic /)
    })
  })

  it('classifies auth failures without retrying shell commands', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ message: 'Unauthorized' }, { status: 401 })
    ) as never

    await expect(
      createAzureDevOpsPullRequest('/repo', {
        provider: 'azure-devops',
        base: 'main',
        head: 'feature/azure',
        title: 'Add Azure create'
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'auth_required'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })
})
