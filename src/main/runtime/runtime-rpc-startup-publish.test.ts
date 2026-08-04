import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodePairingOffer } from '../../shared/pairing'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { E2EESecretHelperResult } from './e2ee-secret-unseal-host'
import type { E2EESecretHelperRequest } from './e2ee-secret-unseal-protocol'
import { resolveE2EEIdentity, type E2EEKeychainContext } from './e2ee-keypair'
import type { MobileSocketTransport } from './rpc/mobile-socket-wiring'
import type { WebSocket } from 'ws'

/**
 * Stands in for the child Electron process that owns every safeStorage call. Mocking it here is
 * also the invariant: if any keychain work moved back onto the runtime's main thread, these tests
 * would keep passing while the shipped binary wedged — so `calls` doubles as the "did the runtime
 * ask?" ledger, and `answer` reproduces the shipped macOS wedge as the host reports it.
 */
const helperControl = vi.hoisted(() => ({
  calls: [] as E2EESecretHelperRequest[],
  answer: null as
    | ((
        request: E2EESecretHelperRequest
      ) => Promise<E2EESecretHelperResult> | E2EESecretHelperResult)
    | null
}))

vi.mock('./e2ee-secret-unseal-host', () => ({
  runE2EESecretHelper: async (request: E2EESecretHelperRequest) => {
    helperControl.calls.push(request)
    return await (helperControl.answer?.(request) ?? {
      ok: false,
      reason: 'helper_unavailable',
      message: 'no helper'
    })
  }
}))

function workingKeychain(request: E2EESecretHelperRequest): E2EESecretHelperResult {
  return request.op === 'seal'
    ? {
        ok: true,
        op: 'seal',
        ciphertextB64: Buffer.from(`enc:${request.secretKeyB64}`, 'utf-8').toString('base64')
      }
    : {
        ok: true,
        op: 'unseal',
        secretKeyB64: Buffer.from(request.ciphertextB64, 'base64')
          .toString('utf-8')
          .replace(/^enc:/, '')
      }
}

/** What the host reports after it SIGKILLs a child parked in the macOS keychain syscall. */
const killedKeychain = (): E2EESecretHelperResult => ({
  ok: false,
  reason: 'timeout',
  message: 'The OS keychain did not answer within 5000ms; the helper was terminated.'
})

/** Just enough of a mobile socket to drive the real wiring the runtime built at bind time. */
class FakeMobileSocket {
  readonly send = vi.fn()
  readonly close = vi.fn()
}

class FakeMobileTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(): void {}

  receive(ws: FakeMobileSocket, message: string): void {
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }
}

const dirs: string[] = []

function makeUserDataPath(): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-startup-publish-'))
  dirs.push(userDataPath)
  return userDataPath
}

function makeServer(
  keychainContext?: E2EEKeychainContext,
  userDataPath: string = makeUserDataPath()
): {
  server: OrcaRuntimeRpcServer
  userDataPath: string
} {
  return {
    server: new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      ...(keychainContext ? { keychainContext } : {})
    }),
    userDataPath
  }
}

function readKeypairFile(userDataPath: string): { secretKeyFormat?: string; publicKeyB64: string } {
  return JSON.parse(readFileSync(join(userDataPath, E2EE_KEYPAIR_FILENAME), 'utf-8'))
}

beforeEach(() => {
  helperControl.calls.length = 0
  helperControl.answer = workingKeychain
})

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('runtime startup publication', () => {
  it('publishes the local socket first, then adds the WebSocket endpoint', async () => {
    const { server, userDataPath } = makeServer()
    try {
      await server.start()

      const published = readRuntimeMetadata(userDataPath)!
      expect(published.transports.map((transport) => transport.kind)).toContain('websocket')
      expect(published.transports.length).toBeGreaterThan(1)
      // The republish must not re-identify the runtime, or clearRuntimeMetadataIfOwned stops matching on quit.
      expect(published.pid).toBe(process.pid)
      expect(published.runtimeId).toBeTruthy()
    } finally {
      await server.stop()
    }
  })

  it('completes start() without waiting on the keychain helper at all', async () => {
    // The D1 shape: the helper never answers. Before the fix this was a synchronous safeStorage
    // call on the main thread and nothing after it — including "Orca server ready" — ever ran.
    const pending: { release: (() => void) | null } = { release: null }
    helperControl.answer = () =>
      new Promise<E2EESecretHelperResult>((resolve) => {
        pending.release = () => resolve(killedKeychain())
      })
    const { server, userDataPath } = makeServer()
    try {
      await server.start()

      expect(pending.release).not.toBeNull()
      expect(
        readRuntimeMetadata(userDataPath)?.transports.map((transport) => transport.kind)
      ).toContain('websocket')
      expect(server.getWebSocketEndpoint()).toBeTruthy()
    } finally {
      pending.release?.()
      await server.stop()
    }
  })

  it('reports the pairing offer unsealable — not missing — when the helper was killed', async () => {
    // Seal an identity the way a GUI run would, then make every later unseal time out.
    const userDataPath = makeUserDataPath()
    const seeded = await resolveE2EEIdentity(userDataPath)
    expect(seeded.ok).toBe(true)
    const sealedOnDisk = readFileSync(join(userDataPath, E2EE_KEYPAIR_FILENAME), 'utf-8')

    helperControl.answer = killedKeychain
    const { server } = makeServer('headless', userDataPath)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await server.start()

      // Startup finished, and the refusal names WHICH failure: an identity exists, we could not
      // open it. `e2ee_key_unavailable` would tell an operator to recreate it and lose every device.
      const offer = await server.createPairingOffer({ address: '100.64.1.20' })
      expect(offer).toMatchObject({ available: false, reason: 'e2ee_key_unsealable' })
      expect((offer as { guidance: string }).guidance).toContain('keychain')
      // And the sealed identity is untouched: paired devices survive the stall.
      expect(readFileSync(join(userDataPath, E2EE_KEYPAIR_FILENAME), 'utf-8')).toBe(sealedOnDisk)
      // Nothing may serve traffic on an identity we could not produce.
      expect(server.getE2EEKeypair()).toBeNull()
    } finally {
      consoleWarn.mockRestore()
      await server.stop()
    }
  })

  it('still mints and pairs normally when the helper answers', async () => {
    const { server, userDataPath } = makeServer()
    try {
      await server.start()

      const offer = await server.createPairingOffer({ address: '100.64.1.20' })
      expect(offer.available).toBe(true)
      expect(readKeypairFile(userDataPath).secretKeyFormat).toBe('electron-safe-storage-v1')
      expect(helperControl.calls.some((call) => call.op === 'seal')).toBe(true)
      // The warm secret is what the WebSocket path will use, so it must be populated by now.
      expect(server.getE2EEKeypair()?.secretKey.length).toBe(32)
    } finally {
      await server.stop()
    }
  })

  it('mints the headless pairing identity without spawning the helper', async () => {
    const { server, userDataPath } = makeServer('headless')
    try {
      await server.start()
      const offer = await server.createPairingOffer({ address: '100.64.1.20' })

      // Sealing has a lossless fallback, so `orca serve` never spends the helper budget on a
      // prompt it has no window to answer.
      expect(offer.available).toBe(true)
      expect(helperControl.calls).toHaveLength(0)
      expect(readKeypairFile(userDataPath).secretKeyFormat).toBe('plaintext')
    } finally {
      await server.stop()
    }
  })

  it('advertises the public key of the keypair it can actually decrypt', async () => {
    // A previous run sealed its identity in the keychain...
    const userDataPath = makeUserDataPath()
    const seeded = await resolveE2EEIdentity(userDataPath)
    const staleOnDisk = seeded.ok ? seeded.keypair.publicKeyB64 : ''
    // ...which this run finds genuinely undecryptable, so the stored public key is unbacked.
    helperControl.answer = (request) =>
      request.op === 'seal'
        ? workingKeychain(request)
        : { ok: false, reason: 'keychain_error', message: 'rotated' }
    const { server } = makeServer(undefined, userDataPath)
    try {
      await server.start()

      const offer = await server.createPairingOffer({ address: '100.64.1.20' })
      expect(offer.available).toBe(true)
      const advertised = decodePairingOffer(
        (offer as { pairingUrl: string }).pairingUrl
      ).publicKeyB64
      // The phone derives X25519 against whatever this says, and the first frame it sends
      // regenerates the desktop secret — so an offer may only carry the resolved public half.
      expect(advertised).not.toBe(staleOnDisk)
      expect(advertised).toBe(server.getE2EEKeypair()!.publicKeyB64)
      expect(readKeypairFile(userDataPath).publicKeyB64).toBe(advertised)
    } finally {
      await server.stop()
    }
  })

  it('holds a phone that connects between the WS bind and the warm, instead of refusing it', async () => {
    // The interval nothing else covers: the listener is up and the warm is a cold child-Electron
    // boot behind it. A 4001 here reads as "pairing revoked" on the phone, which burns its retry
    // budget in ~1.5s and latches auth-failed — on every desktop launch.
    const userDataPath = makeUserDataPath()
    const seeded = await resolveE2EEIdentity(userDataPath)
    const pendingUnseal: { release: (() => void) | null } = { release: null }
    helperControl.answer = (request) =>
      new Promise<E2EESecretHelperResult>((resolve) => {
        pendingUnseal.release = () => resolve(workingKeychain(request))
      })
    const { server } = makeServer(undefined, userDataPath)
    try {
      await server.start()
      const wiring = server.getMobileSocketWiring()!
      const transport = new FakeMobileTransport()
      wiring.attachTransport(transport)
      const ws = new FakeMobileSocket()

      expect(pendingUnseal.release).not.toBeNull()
      expect(server.getE2EEKeypair()).toBeNull()
      transport.receive(ws, JSON.stringify({ type: 'e2ee_hello', publicKeyB64: 'x'.repeat(43) }))
      expect(ws.close).not.toHaveBeenCalled()

      pendingUnseal.release?.()
      await vi.waitFor(() => expect(wiring.channelCount).toBe(1))

      // Admitted on the identity that was already paired — no re-mint, no re-pair.
      expect(ws.close).not.toHaveBeenCalled()
      expect(server.getE2EEKeypair()?.publicKeyB64).toBe(seeded.ok && seeded.keypair.publicKeyB64)
    } finally {
      pendingUnseal.release?.()
      await server.stop()
    }
  })

  it('still binds the WebSocket listener when the E2EE identity cannot be produced, and pairs no one', async () => {
    const userDataPath = makeUserDataPath()
    // No identity exists and none can be written: the other half of the named-refusal contract.
    mkdirSync(join(userDataPath, E2EE_KEYPAIR_FILENAME))
    const { server } = makeServer(undefined, userDataPath)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await server.start()

      // Surface change: this listener used to be skipped when the keypair failed to load.
      // It now binds, and every path that would hand out a key refuses instead.
      expect(
        readRuntimeMetadata(userDataPath)?.transports.map((transport) => transport.kind)
      ).toContain('websocket')
      expect(server.getWebSocketEndpoint()).toBeTruthy()
      expect(server.getE2EEKeypair()).toBeNull()
      expect(await server.createPairingOffer({ address: '100.64.1.20' })).toMatchObject({
        available: false,
        reason: 'e2ee_key_unavailable'
      })
    } finally {
      consoleWarn.mockRestore()
      await server.stop()
    }
  })
})
