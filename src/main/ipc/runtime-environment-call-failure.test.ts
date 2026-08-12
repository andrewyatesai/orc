import { describe, expect, it } from 'vitest'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../shared/runtime-rpc-call-queue'
import { runtimeEnvironmentCallFailure } from './runtime-environment-call-failure'

describe('runtimeEnvironmentCallFailure', () => {
  it('converts a queue-overload rejection into a code-carrying failure envelope', () => {
    expect(
      runtimeEnvironmentCallFailure('session.tabs.list', new RuntimeRpcCallQueueOverloadError('selector'))
    ).toEqual({
      id: 'session.tabs.list',
      ok: false,
      error: {
        code: 'runtime_rpc_queue_overloaded',
        message: 'Remote runtime call queue is full; retry after current calls finish.'
      },
      _meta: { runtimeId: null }
    })
  })

  it('converts a remote-runtime client rejection into a code-carrying failure envelope', () => {
    expect(
      runtimeEnvironmentCallFailure(
        'repo.list',
        new RemoteRuntimeClientError('remote_runtime_unavailable', 'not connected')
      )
    ).toEqual({
      id: 'repo.list',
      ok: false,
      error: { code: 'remote_runtime_unavailable', message: 'not connected' },
      _meta: { runtimeId: null }
    })
  })

  it('passes untyped rejections through (null) so the handler rethrows them', () => {
    expect(runtimeEnvironmentCallFailure('repo.list', new Error('boom'))).toBeNull()
    expect(runtimeEnvironmentCallFailure('repo.list', 'boom')).toBeNull()
  })
})
