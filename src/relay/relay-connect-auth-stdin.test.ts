import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { readConnectAuthLine } from './relay-connect-auth-stdin'
import { encodeJsonRpcFrame } from './protocol'

describe('--connect credential on stdin', () => {
  it('reads the first line as the token', async () => {
    const stdin = new PassThrough()
    const pending = readConnectAuthLine(stdin)
    stdin.write(`${'a'.repeat(64)}\n`)

    const { token, leftover } = await pending
    expect(token).toBe('a'.repeat(64))
    expect(leftover).toHaveLength(0)
  })

  it('joins a token split across chunks', async () => {
    const stdin = new PassThrough()
    const pending = readConnectAuthLine(stdin)
    stdin.write('a'.repeat(30))
    stdin.write(`${'a'.repeat(34)}\n`)

    expect((await pending).token).toBe('a'.repeat(64))
  })

  // Why: the host may pipeline protocol frames behind the credential line; the
  // caller owes them to the socket, so losing them here would truncate a frame.
  it('hands back bytes that arrived after the newline', async () => {
    const stdin = new PassThrough()
    const pending = readConnectAuthLine(stdin)
    const frame = encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, method: 'relay.status' }, 1, 0)
    stdin.write(Buffer.concat([Buffer.from(`${'a'.repeat(64)}\n`), frame]))

    const { leftover } = await pending
    expect(leftover.equals(frame)).toBe(true)
  })

  it('rejects when stdin closes before a credential arrives', async () => {
    const stdin = new PassThrough()
    const pending = readConnectAuthLine(stdin)
    stdin.end()

    await expect(pending).rejects.toThrow(/closed before the relay credential/)
  })

  it('rejects an unterminated line past the size cap instead of buffering forever', async () => {
    const stdin = new PassThrough()
    const pending = readConnectAuthLine(stdin)
    stdin.write('x'.repeat(8192))

    await expect(pending).rejects.toThrow(/size cap/)
  })

  it('times out rather than waiting on a peer that sends nothing', async () => {
    const stdin = new PassThrough()
    await expect(readConnectAuthLine(stdin, 20)).rejects.toThrow(/within 20ms/)
  })
})
