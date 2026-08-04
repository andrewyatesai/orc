import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import * as runtimeMetadataModule from './runtime-metadata'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

// Why: the pairing/WebSocket subsystem can stall unboundedly (an OS keychain prompt with no
// window to answer it is the shipped example), so it stands in here as a start() that never
// settles — the descriptor and a racing stop() must both be correct without it.
const wsControl = vi.hoisted(() => ({
  instances: [] as { resolvedPort: number; stopCount: number }[],
  settleStart: null as (() => void) | null
}))

vi.mock('./rpc/ws-transport', () => {
  class StalledWebSocketTransport {
    readonly resolvedPort = 45671
    stopCount = 0
    constructor() {
      wsControl.instances.push(this)
    }
    onMessage(): void {}
    onConnectionClose(): void {}
    setClientId(): void {}
    terminateClientConnections(): number {
      return 0
    }
    start(): Promise<void> {
      return new Promise<void>((resolve) => {
        wsControl.settleStart = resolve
      })
    }
    async stop(): Promise<void> {
      this.stopCount += 1
    }
  }
  return { WebSocketTransport: StalledWebSocketTransport }
})

const dirs: string[] = []

function makeServer(): { server: OrcaRuntimeRpcServer; userDataPath: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-stalled-pairing-'))
  dirs.push(userDataPath)
  return {
    server: new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    }),
    userDataPath
  }
}

async function waitForStalledWsBind(): Promise<{ resolvedPort: number; stopCount: number }> {
  await vi.waitFor(() => expect(wsControl.instances).toHaveLength(1))
  return wsControl.instances[0]!
}

afterEach(async () => {
  wsControl.settleStart?.()
  wsControl.settleStart = null
  wsControl.instances.length = 0
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runtime startup with a stalled pairing subsystem', () => {
  it('has the descriptor on disk before start() resolves', async () => {
    const { server, userDataPath } = makeServer()
    const started = server.start()
    await waitForStalledWsBind()

    // The invariant the hang broke: discovery must not wait on the pairing/WebSocket path.
    // Read before awaiting start() — start() cannot complete while the WS bind is stalled.
    const published = readRuntimeMetadata(userDataPath)
    expect(published).not.toBeNull()
    expect(published!.transports).toHaveLength(1)
    expect(['unix', 'named-pipe']).toContain(published!.transports[0]!.kind)
    expect(published!.authToken).toBeTruthy()

    wsControl.settleStart!()
    await started
    await server.stop()
  })

  it('lets a stop() landing mid-start win instead of republishing a dead endpoint', async () => {
    const { server, userDataPath } = makeServer()
    const write = vi.spyOn(runtimeMetadataModule, 'writeRuntimeMetadata')
    const started = server.start()
    const wsTransport = await waitForStalledWsBind()
    const writesBeforeStop = write.mock.calls.length

    await server.stop()
    wsControl.settleStart!()
    await started

    // The unix socket is already unlinked, so a second publish would advertise a dead endpoint.
    expect(write.mock.calls.length).toBe(writesBeforeStop)
    expect(readRuntimeMetadata(userDataPath)!.transports).toHaveLength(1)
    // stop() never saw this transport: only the resumed start() can close it.
    expect(wsTransport.stopCount).toBe(1)

    // And no ownership watch may be armed, or it rewrites the stale descriptor every poll.
    server.checkRuntimeMetadataOwnership()
    expect(write.mock.calls.length).toBe(writesBeforeStop)
  })
})
