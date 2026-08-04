import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runE2EESecretHelper } from './e2ee-secret-unseal-host'
import {
  encodeE2EESecretHelperReply,
  E2EE_SECRET_HELPER_ENV_FLAG
} from './e2ee-secret-unseal-protocol'

/**
 * A child that behaves like the real one: it accepts a request on stdin and may or may not ever
 * reply. The point of the whole module is that a child which never replies gets KILLED — an
 * in-process timeout is impossible, because a blocking safeStorage call stops timers from firing.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stdin = new PassThrough()
  readonly signals: (string | number | undefined)[] = []
  killed = false
  request = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.request += chunk.toString('utf-8')
    })
  }

  kill(signal?: string | number): boolean {
    this.signals.push(signal)
    this.killed = true
    return true
  }
}

let child: FakeChild
let spawnCalls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[]

function spawnHelper(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv }
) {
  spawnCalls.push({ command, args, env: options.env ?? {} })
  return child as never
}

const launch = () => ({ command: '/fake/electron', args: ['/fake/app'] })

beforeEach(() => {
  vi.useFakeTimers()
  child = new FakeChild()
  spawnCalls = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runE2EESecretHelper', () => {
  it('kills the child on timeout instead of awaiting it forever', async () => {
    const result = runE2EESecretHelper(
      { op: 'unseal', ciphertextB64: 'AAAA' },
      { timeoutMs: 1_000, spawnHelper, resolveLaunch: launch }
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(2)

    // SIGKILL specifically: a process parked in the keychain syscall never runs a SIGTERM handler.
    expect(child.signals).toEqual(['SIGKILL'])
    expect(await result).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('returns the unsealed secret when the child answers', async () => {
    const result = runE2EESecretHelper(
      { op: 'unseal', ciphertextB64: 'AAAA' },
      { timeoutMs: 1_000, spawnHelper, resolveLaunch: launch }
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(JSON.parse(child.request)).toEqual({ op: 'unseal', ciphertextB64: 'AAAA' })
    child.stdout.write(
      encodeE2EESecretHelperReply({ ok: true, op: 'unseal', secretKeyB64: 'c2VjcmV0' })
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(await result).toEqual({ ok: true, op: 'unseal', secretKeyB64: 'c2VjcmV0' })
  })

  it('ignores Electron chatter sharing the child stdout', async () => {
    const result = runE2EESecretHelper(
      { op: 'seal', secretKeyB64: 'c2VjcmV0' },
      { timeoutMs: 1_000, spawnHelper, resolveLaunch: launch }
    )
    await vi.advanceTimersByTimeAsync(0)

    child.stdout.write('[12345:0101/000000.000000:WARNING:some_gpu_thing.cc(1)] noise\n')
    child.stdout.write(encodeE2EESecretHelperReply({ ok: true, op: 'seal', ciphertextB64: 'Y3Q=' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(await result).toEqual({ ok: true, op: 'seal', ciphertextB64: 'Y3Q=' })
  })

  it('reports a child that exits without a reply as helper_unavailable, never as a decrypt failure', async () => {
    const result = runE2EESecretHelper(
      { op: 'unseal', ciphertextB64: 'AAAA' },
      { timeoutMs: 1_000, spawnHelper, resolveLaunch: launch }
    )
    await vi.advanceTimersByTimeAsync(0)
    child.emit('close', 1, null)

    // Conflating this with "the ciphertext is bad" would regenerate the identity and orphan
    // every paired device.
    expect(await result).toMatchObject({ ok: false, reason: 'helper_unavailable' })
  })

  it('surfaces the child-reported keychain failure verbatim', async () => {
    const result = runE2EESecretHelper(
      { op: 'unseal', ciphertextB64: 'AAAA' },
      { timeoutMs: 1_000, spawnHelper, resolveLaunch: launch }
    )
    await vi.advanceTimersByTimeAsync(0)
    child.stdout.write(
      encodeE2EESecretHelperReply({
        ok: false,
        reason: 'encryption_unavailable',
        message: 'no OS encryption'
      })
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(await result).toMatchObject({ ok: false, reason: 'encryption_unavailable' })
  })

  it('runs the child as real Electron, never as node', async () => {
    const result = runE2EESecretHelper(
      { op: 'unseal', ciphertextB64: 'AAAA' },
      { timeoutMs: 1_000, spawnHelper, resolveLaunch: launch }
    )
    await vi.advanceTimersByTimeAsync(0)

    // safeStorage does not exist under ELECTRON_RUN_AS_NODE, so an inherited flag would produce a
    // child that can never answer — indistinguishable from a wedged keychain.
    expect(spawnCalls[0]!.env[E2EE_SECRET_HELPER_ENV_FLAG]).toBe('1')
    expect(spawnCalls[0]!.env.ELECTRON_RUN_AS_NODE).toBeUndefined()

    child.stdout.write(
      encodeE2EESecretHelperReply({ ok: true, op: 'unseal', secretKeyB64: 'AA==' })
    )
    await vi.advanceTimersByTimeAsync(0)
    await result
  })

  it('refuses without spawning when no Electron runtime can be located', async () => {
    const result = await runE2EESecretHelper(
      { op: 'unseal', ciphertextB64: 'AAAA' },
      { spawnHelper, resolveLaunch: () => null }
    )

    expect(spawnCalls).toHaveLength(0)
    expect(result).toMatchObject({ ok: false, reason: 'helper_unavailable' })
  })
})
