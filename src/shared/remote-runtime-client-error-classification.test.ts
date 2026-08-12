import { describe, expect, it } from 'vitest'
import {
  isRecoverableRemoteRuntimeConnectionError,
  isRuntimeRpcQueueOverloadError,
  toRemoteRuntimeClientErrorLike
} from './remote-runtime-client-error-classification'

describe('remote runtime client error classification', () => {
  it.each([
    'remote_runtime_unavailable',
    'runtime_rpc_queue_overloaded',
    'runtime_timeout',
    'runtime_unavailable',
    'reconnecting'
  ])('treats %s as recoverable', (code) => {
    expect(isRecoverableRemoteRuntimeConnectionError({ code, message: 'transport failed' })).toBe(
      true
    )
  })

  it('classifies a queue-overload rejection by its structured code', () => {
    expect(
      isRuntimeRpcQueueOverloadError({ code: 'runtime_rpc_queue_overloaded', message: 'busy' })
    ).toBe(true)
  })

  it('classifies a queue-overload rejection whose code was lost crossing IPC', () => {
    const error = toRemoteRuntimeClientErrorLike(
      new Error(
        "Error invoking remote method 'runtimeEnvironments:call': RuntimeRpcCallQueueOverloadError: Remote runtime call queue is full; retry after current calls finish."
      )
    )
    expect(isRuntimeRpcQueueOverloadError(error)).toBe(true)
  })

  it('trusts a structured recovery code before legacy message fragments', () => {
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'unauthorized',
        message: 'Remote Orca runtime closed the connection.'
      })
    ).toBe(false)
  })

  it('trusts a structured queue code before legacy message fragments', () => {
    expect(
      isRuntimeRpcQueueOverloadError({
        code: 'remote_runtime_unavailable',
        message: 'Remote runtime call queue is full; retry after current calls finish.'
      })
    ).toBe(false)
  })

  it('does not retry authentication or protocol failures', () => {
    expect(
      isRecoverableRemoteRuntimeConnectionError({ code: 'unauthorized', message: 'bad token' })
    ).toBe(false)
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'invalid_runtime_response',
        message: 'bad frame'
      })
    ).toBe(false)
  })

  it.each([
    'Could not connect to the remote Orca runtime.',
    'Remote Orca runtime closed the connection.',
    'Remote Orca runtime connection closed.',
    'Remote Orca runtime is not connected.',
    "Error invoking remote method 'runtimeEnvironments:call': RuntimeRpcCallQueueOverloadError: Remote runtime call queue is full; retry after current calls finish.",
    'Remote runtime subscription closed before it started.'
  ])('normalizes unstructured connection failure: %s', (message) => {
    const error = toRemoteRuntimeClientErrorLike(new Error(message))
    expect(isRecoverableRemoteRuntimeConnectionError(error)).toBe(true)
  })
})
