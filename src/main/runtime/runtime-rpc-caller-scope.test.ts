import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  clearScopedCallerTokensForTest,
  getCallerScope,
  registerScopedCallerToken,
  type RuntimeCallerScope
} from './runtime-caller-scope'
import type { OrcaRuntimeService } from './orca-runtime'

const dirs: string[] = []

afterEach(() => {
  clearScopedCallerTokensForTest()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

type ServerInternals = {
  authToken: string
  parseAndAuth: (raw: string) => { scope?: RuntimeCallerScope; error?: unknown }
  handleMessage: (raw: string) => Promise<unknown>
}

function createServer(observe: () => void): {
  server: OrcaRuntimeRpcServer
  internals: ServerInternals
} {
  const dir = mkdtempSync(join(tmpdir(), 'orca-rpc-scope-'))
  dirs.push(dir)
  const runtime = {
    getRuntimeId: () => 'rt-1',
    getStartedAt: () => 0,
    recordFeatureInteraction: () => {},
    // The method under test only needs one reachable handler that reports scope.
    getStatus: () => {
      observe()
      return { ok: true }
    }
  } as unknown as OrcaRuntimeService
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath: dir })
  return { server, internals: server as unknown as ServerInternals }
}

describe('runtime RPC caller scope', () => {
  it('treats the shared runtime token as a local, unrestricted caller', () => {
    const { internals } = createServer(() => {})
    const parsed = internals.parseAndAuth(
      JSON.stringify({ id: '1', method: 'status.get', authToken: internals.authToken })
    )
    expect(parsed.scope).toEqual({ kind: 'local' })
  })

  it('maps a scoped token back to the SSH caller that minted it', () => {
    const { internals } = createServer(() => {})
    const scoped = registerScopedCallerToken({ kind: 'ssh', connectionId: 'ssh_target_a' })
    const parsed = internals.parseAndAuth(
      JSON.stringify({ id: '1', method: 'status.get', authToken: scoped.token })
    )
    expect(parsed.scope).toEqual({ kind: 'ssh', connectionId: 'ssh_target_a' })
  })

  it('rejects a disposed scoped token instead of falling back to unrestricted', () => {
    const { internals } = createServer(() => {})
    const scoped = registerScopedCallerToken({ kind: 'ssh', connectionId: 'ssh_target_a' })
    scoped.dispose()
    const parsed = internals.parseAndAuth(
      JSON.stringify({ id: '1', method: 'status.get', authToken: scoped.token })
    )
    expect(parsed.scope).toBeUndefined()
    expect(parsed.error).toBeDefined()
  })

  it('runs the dispatch inside the scope the token carried', async () => {
    let observed: RuntimeCallerScope | null = null
    const { internals } = createServer(() => {
      observed = getCallerScope()
    })
    const scoped = registerScopedCallerToken({ kind: 'ssh', connectionId: 'ssh_target_a' })
    await internals.handleMessage(
      JSON.stringify({ id: '1', method: 'status.get', authToken: scoped.token })
    )
    expect(observed).toEqual({ kind: 'ssh', connectionId: 'ssh_target_a' })
  })

  it('leaves a shared-token dispatch unscoped', async () => {
    let observed: RuntimeCallerScope | null = null
    const { internals } = createServer(() => {
      observed = getCallerScope()
    })
    await internals.handleMessage(
      JSON.stringify({ id: '1', method: 'status.get', authToken: internals.authToken })
    )
    expect(observed).toEqual({ kind: 'local' })
  })
})
