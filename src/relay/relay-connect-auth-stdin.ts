// The host writes the relay secret as the first line of the `--connect` exec
// channel's stdin.
//
// Why stdin and not argv or env: argv is world-readable in `ps` on every POSIX
// host, and a child's environment is readable by the remote account through
// /proc/<pid>/environ — both would publish the secret to the very principal the
// token exists to exclude. The exec channel is already authenticated by SSH and
// its bytes never touch the remote filesystem or process table.

import type { Readable } from 'node:stream'

export const CONNECT_AUTH_TIMEOUT_MS = 10_000
// Generous next to a 64-char token, but bounded so a stuck peer can't grow the buffer.
const MAX_AUTH_LINE_BYTES = 4096

export type ConnectAuthLine = {
  token: string
  /** Bytes that arrived in the same chunk after the newline; the caller owes them to the socket. */
  leftover: Buffer
}

export function readConnectAuthLine(
  stdin: Readable,
  timeoutMs: number = CONNECT_AUTH_TIMEOUT_MS
): Promise<ConnectAuthLine> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    let settled = false

    const finish = (err: Error | null, value?: ConnectAuthLine): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
      stdin.pause()
      if (err) {
        reject(err)
      } else {
        resolve(value!)
      }
    }

    const timer = setTimeout(
      () => finish(new Error(`No relay credential on stdin within ${timeoutMs}ms`)),
      timeoutMs
    )

    const onData = (chunk: Buffer): void => {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline === -1) {
        if (buffered.length > MAX_AUTH_LINE_BYTES) {
          finish(new Error('Relay credential line exceeded its size cap'))
        }
        return
      }
      const token = buffered.subarray(0, newline).toString('utf-8').trim()
      finish(null, { token, leftover: Buffer.from(buffered.subarray(newline + 1)) })
    }
    const onEnd = (): void => finish(new Error('stdin closed before the relay credential arrived'))
    const onError = (err: Error): void => finish(err)

    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.on('error', onError)
    stdin.resume()
  })
}
