// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefDetails,
  searchRuntimeRepoBaseRefs
} from './runtime-repo-client'
import type * as RuntimeRpcClient from './runtime-rpc-client'

// Why: the legacy `refs`-only reply path needs a stubbed RPC; the rest of the
// module (target resolution) must stay real so the existing cases still route.
const callRuntimeRpcMock = vi.fn()
vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpcMock(...args)
}))

const getBaseRefDefault = vi.fn()
const searchBaseRefs = vi.fn()
const searchBaseRefDetails = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  getBaseRefDefault.mockReset()
  searchBaseRefs.mockReset()
  searchBaseRefDetails.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: {
        getBaseRefDefault,
        searchBaseRefs,
        searchBaseRefDetails
      },
      runtimeEnvironments: {
        call: runtimeCall
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runtime repo client search bounds', () => {
  it('rejects oversized local base-ref searches before IPC', async () => {
    await expect(
      searchRuntimeRepoBaseRefs(null, 'repo-1', 'x'.repeat(3 * 1024), 20)
    ).resolves.toEqual([])

    expect(searchBaseRefs).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('rejects oversized runtime base-ref detail searches before RPC', async () => {
    await expect(
      searchRuntimeRepoBaseRefDetails(
        { activeRuntimeEnvironmentId: 'env-1' },
        'repo-1',
        'secret-token-value'.repeat(256),
        20
      )
    ).resolves.toEqual([])

    expect(searchBaseRefDetails).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('forwards the selected SSH host to base-ref IPC', async () => {
    getBaseRefDefault.mockResolvedValue({ defaultBaseRef: 'origin/main', remoteCount: 1 })
    searchBaseRefs.mockResolvedValue(['origin/main'])

    await getRuntimeRepoBaseRefDefault(null, 'same-repo', 'ssh:server')
    await searchRuntimeRepoBaseRefs(null, 'same-repo', 'main', 20, 'ssh:server')

    expect(getBaseRefDefault).toHaveBeenCalledWith({
      repoId: 'same-repo',
      hostId: 'ssh:server'
    })
    expect(searchBaseRefs).toHaveBeenCalledWith({
      repoId: 'same-repo',
      query: 'main',
      limit: 20,
      hostId: 'ssh:server'
    })
  })
})

describe('legacy refs-only replies when the derivation core is unavailable', () => {
  it('rejects rather than resolving to rows the picker would read as real', async () => {
    // No init-git-wasm-for-test import in this file, so the core is not ready —
    // the same state a terminally failed wasm load leaves the renderer in.
    callRuntimeRpcMock.mockResolvedValue({ refs: ['origin/main'], truncated: false })

    await expect(
      searchRuntimeRepoBaseRefDetails({ activeRuntimeEnvironmentId: 'env-1' }, 'repo-1', 'main', 20)
    ).rejects.toThrow(/git core failed to load/)
  })

  it('does not degrade into the empty result set that means "no branches matched"', async () => {
    callRuntimeRpcMock.mockResolvedValue({ refs: ['origin/main'], truncated: false })

    const outcome = await searchRuntimeRepoBaseRefDetails(
      { activeRuntimeEnvironmentId: 'env-1' },
      'repo-1',
      'main',
      20
    ).then(
      (results) => ({ resolved: results }),
      () => ({ resolved: null })
    )

    expect(outcome.resolved).toBeNull()
  })
})
