import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/host/app' }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import {
  HostCliUnavailableError,
  runHostOrcaCliPassthrough
} from './ssh-remote-cli-host-passthrough'
import {
  createScopedCallerMetadataDir,
  resolveRemoteCallerScope
} from './ssh-remote-cli-caller-scope'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import {
  clearScopedCallerTokensForTest,
  getCallerScope,
  resolveScopedCallerToken
} from '../runtime/runtime-caller-scope'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

const TARGET = 'ssh_target_a'
const dirs: string[] = []

function plantHostMetadata(authToken = 'shared-host-token'): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-userdata-'))
  dirs.push(dir)
  writeFileSync(
    getRuntimeMetadataPath(dir),
    JSON.stringify({
      runtimeId: 'rt-1',
      pid: 1,
      transports: [{ kind: 'unix', endpoint: '/tmp/o-1-abc.sock' }],
      authToken,
      startedAt: 0
    })
  )
  return dir
}

afterEach(() => {
  clearScopedCallerTokensForTest()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveRemoteCallerScope', () => {
  it('uses the session target, and refuses to guess when there is none', () => {
    expect(resolveRemoteCallerScope({ connectionId: TARGET })).toEqual({
      kind: 'ssh',
      connectionId: TARGET
    })
    expect(resolveRemoteCallerScope({})).toEqual({ kind: 'unattributed' })
  })
})

describe('createScopedCallerMetadataDir', () => {
  it('gives the subprocess a token that maps back to the caller, not the shared one', () => {
    const hostDir = plantHostMetadata()
    const scoped = createScopedCallerMetadataDir({ kind: 'ssh', connectionId: TARGET }, hostDir)
    dirs.push(scoped.userDataPath)

    const planted = JSON.parse(
      readFileSync(getRuntimeMetadataPath(scoped.userDataPath), 'utf8')
    ) as { authToken: string; transports: unknown }
    expect(planted.authToken).not.toBe('shared-host-token')
    expect(planted.transports).toEqual([{ kind: 'unix', endpoint: '/tmp/o-1-abc.sock' }])
    expect(resolveScopedCallerToken(planted.authToken)).toEqual({
      kind: 'ssh',
      connectionId: TARGET
    })

    scoped.dispose()
    expect(resolveScopedCallerToken(planted.authToken)).toBeNull()
  })

  it('refuses to mint a scope from incomplete host metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-host-userdata-'))
    dirs.push(dir)
    writeFileSync(getRuntimeMetadataPath(dir), JSON.stringify({ authToken: 'x' }))
    expect(() => createScopedCallerMetadataDir({ kind: 'ssh', connectionId: TARGET }, dir)).toThrow(
      /incomplete/
    )
  })
})

describe('runHostOrcaCliPassthrough scoping', () => {
  it('points the subprocess at the scoped metadata and disposes the token afterwards', async () => {
    const hostDir = plantHostMetadata()
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: { end: () => void; on: () => void }
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { end: () => {}, on: () => {} }
    child.kill = () => {}
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      { argv: ['terminal', 'list'], cwd: '/home/a/wt', env: {}, connectionId: TARGET },
      {
        execPath: '/host/electron',
        cliEntryPath: '/host/app/out/cli/index.js',
        userDataPath: hostDir,
        entryExists: () => true,
        spawn: spawn as never
      }
    )
    await Promise.resolve()
    const env = (
      spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]
    )[2].env
    const scopedDir = env.ORCA_USER_DATA_PATH!
    expect(scopedDir).not.toBe(hostDir)
    const scopedToken = (
      JSON.parse(readFileSync(getRuntimeMetadataPath(scopedDir), 'utf8')) as { authToken: string }
    ).authToken
    expect(resolveScopedCallerToken(scopedToken)).toEqual({ kind: 'ssh', connectionId: TARGET })

    child.emit('close', 0)
    await resultPromise
    // Why: a single-use credential that outlives its invocation is a standing key.
    expect(resolveScopedCallerToken(scopedToken)).toBeNull()
  })

  it('carries the scope into the in-process fallback the failure falls back to', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'orca-host-userdata-'))
    dirs.push(emptyDir)
    let observed: unknown = null
    const runtime = {
      getRuntimeId: () => 'rt-1',
      recordFeatureInteraction: () => {},
      listTerminals: async () => {
        observed = getCallerScope()
        return { terminals: [] }
      }
    } as never

    await runRemoteOrcaCli(
      runtime,
      { argv: ['terminal', 'list', '--json'], cwd: '/', env: {}, connectionId: TARGET },
      {
        execPath: '/host/electron',
        cliEntryPath: '/host/app/out/cli/index.js',
        userDataPath: emptyDir,
        entryExists: () => true
      }
    )
    expect(observed).toEqual({ kind: 'ssh', connectionId: TARGET })
  })

  it('fails closed to the in-process fallback when it cannot scope the subprocess', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'orca-host-userdata-'))
    dirs.push(emptyDir)
    await expect(
      runHostOrcaCliPassthrough(
        { argv: ['terminal', 'list'], cwd: '/', env: {}, connectionId: TARGET },
        {
          execPath: '/host/electron',
          cliEntryPath: '/host/app/out/cli/index.js',
          userDataPath: emptyDir,
          entryExists: () => true,
          spawn: (() => {
            throw new Error('must not spawn an unscoped CLI')
          }) as never
        }
      )
    ).rejects.toThrow(HostCliUnavailableError)
  })
})
