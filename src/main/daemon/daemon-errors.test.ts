import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDaemonEndpointGoneError, TerminalHostGoneError } from './daemon-errors'
import { mapRuntimeError } from '../runtime/rpc/errors'

function socketError(code: string, syscall: string): Error & { code: string; syscall: string } {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall })
}

describe('isDaemonEndpointGoneError', () => {
  it('recognizes a missing Windows named pipe', () => {
    const err = Object.assign(
      new Error('connect ENOENT \\\\?\\pipe\\orca-terminal-host-v30-14cb7f94b511'),
      { code: 'ENOENT', syscall: 'connect' }
    )
    expect(isDaemonEndpointGoneError(err)).toBe(true)
  })

  it('recognizes a refused socket', () => {
    expect(isDaemonEndpointGoneError(socketError('ECONNREFUSED', 'connect'))).toBe(true)
  })

  it('ignores a missing token file, which does not prove the endpoint is gone', () => {
    expect(isDaemonEndpointGoneError(socketError('ENOENT', 'open'))).toBe(false)
  })

  it('ignores connect failures that are not proof of absence', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EACCES', 'EBUSY']) {
      expect(isDaemonEndpointGoneError(socketError(code, 'connect'))).toBe(false)
    }
  })

  it('ignores non-socket errors and non-objects', () => {
    expect(isDaemonEndpointGoneError(new Error('Connection lost'))).toBe(false)
    expect(isDaemonEndpointGoneError('connect ENOENT')).toBe(false)
    expect(isDaemonEndpointGoneError(null)).toBe(false)
    expect(isDaemonEndpointGoneError(undefined)).toBe(false)
  })

  // Reachability: the daemon client dials its endpoint with net.connect(socketPath); when the
  // owning daemon has exited that socket is gone, so prove the predicate matches the real error
  // Node throws — not just a hand-assembled { code, syscall } double.
  it('matches the error a real connect throws against a dead endpoint', async () => {
    const deadPath = join(tmpdir(), `orca-daemon-gone-${process.pid}-${Date.now()}.sock`)
    const err = await new Promise<unknown>((resolve) => {
      const socket = connect(deadPath)
      socket.on('error', (error) => {
        socket.destroy()
        resolve(error)
      })
    })
    expect(isDaemonEndpointGoneError(err)).toBe(true)
  })

  it('keeps the host-gone marker across runtime RPC error mapping', () => {
    const response = mapRuntimeError(
      'req-1',
      { runtimeId: 'runtime-1' },
      new TerminalHostGoneError()
    )

    expect(response.error).toEqual({ code: 'runtime_error', message: 'terminal_host_gone' })
  })
})
