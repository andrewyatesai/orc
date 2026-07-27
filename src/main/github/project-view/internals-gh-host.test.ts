import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../../git/runner'

const { ghExecFileAsyncMock, hostAuthenticatedMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  hostAuthenticatedMock: vi.fn()
}))

vi.mock('../gh-utils', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))
// Why: #1715 pinning now lands inside the runner (applyGhHostToArgs), not in
// internals' argv. Keep the real qualifier so these assertions still see the
// exact argv gh receives instead of internals' pre-host-qualification args.
vi.mock('../../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return {
    ...actual,
    ghExecFileAsync: (args: string[], options?: { host?: string }) =>
      ghExecFileAsyncMock(actual.applyGhHostToArgs(args, options?.host), options)
  }
})
vi.mock('../rate-limit', () => ({
  rateLimitGuard: () => ({ blocked: false }),
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))
vi.mock('../github-enterprise-repository', () => ({
  isGitHubHostAuthenticatedForGlobalCli: hostAuthenticatedMock
}))

import { runGraphql, runRest } from './internals'

describe('projects gh host pinning through internals (#1715)', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset().mockResolvedValue({
      stdout: JSON.stringify({ data: { ok: true } }),
      stderr: ''
    })
    hostAuthenticatedMock.mockReset().mockResolvedValue(true)
  })

  it('runGraphql pins --hostname for a GHES host', async () => {
    await runGraphql<unknown>('query { viewer { login } }', {}, { host: 'ghe.corp.example' })
    const args = ghExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(args.slice(0, 4)).toEqual(['api', '--hostname', 'ghe.corp.example', 'graphql'])
  })

  // Why: github.com is pinned explicitly too, so an ambient GH_HOST cannot
  // redirect a default-host project query to an Enterprise server.
  it('runGraphql pins --hostname for an explicit github.com host', async () => {
    await runGraphql<unknown>('query { viewer { login } }', {}, { host: 'github.com' })
    const args = ghExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(args.slice(0, 4)).toEqual(['api', '--hostname', 'github.com', 'graphql'])
    expect(hostAuthenticatedMock).not.toHaveBeenCalled()
  })

  it('runGraphql omits --hostname when no host is pinned', async () => {
    await runGraphql<unknown>('query { viewer { login } }', {})
    const args = ghExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(args).not.toContain('--hostname')
  })

  it('runRest pins --hostname before the endpoint args', async () => {
    await runRest<unknown>(['-X', 'GET', 'repos/acme/app/labels'], undefined, 'core', {
      host: 'ghe.corp.example'
    })
    const args = ghExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(args).toEqual([
      'api',
      '--hostname',
      'ghe.corp.example',
      '-X',
      'GET',
      'repos/acme/app/labels'
    ])
  })

  it('runRest omits --hostname without a host option', async () => {
    await runRest<unknown>(['-X', 'GET', 'repos/acme/app/labels'])
    const args = ghExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(args).not.toContain('--hostname')
  })
})
