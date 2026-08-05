import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as DaemonInit from './daemon-init'

// Why a REAL filesystem: the sibling daemon-init runtime-dir test mocks `fs`
// wholesale, so it can only see the calls it stages itself — never that chmod
// follows a symlink, nor that a chmod running before the guard erases the very
// mode bits the guard refuses on. Only real dirs, real modes, and real symlinks
// can tell an adopted hostile dir from a refused one (authority model §8 item 2).

// Assigned per test to a fresh temp dir; read lazily inside the mock.
let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => userDataPath,
    getAppPath: () => '/fake/app',
    getVersion: () => '1.2.3'
  }
}))

async function importDaemonInit(): Promise<typeof DaemonInit> {
  vi.resetModules()
  return import('./daemon-init')
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-daemon-runtime-dir-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

// POSIX mode bits only; the win32 branch is ACL-hardened and covered by the mocked sibling.
describe.skipIf(process.platform === 'win32')('daemon runtime dir on a real filesystem', () => {
  it('creates a missing runtime dir 0700', async () => {
    const mod = await importDaemonInit()

    mod.getDaemonEndpointPaths()

    expect(modeOf(join(userDataPath, 'daemon'))).toBe(0o700)
  })

  it('refuses a pre-existing world-writable dir instead of adopting it', async () => {
    const dir = join(userDataPath, 'daemon')
    mkdirSync(dir)
    chmodSync(dir, 0o777)
    const mod = await importDaemonInit()

    expect(() => mod.getDaemonEndpointPaths()).toThrow(/group\/other-writable/)
    // Whatever a stranger already put in there is not ours; correcting the mode
    // would only hide that, so the dir must be left exactly as found.
    expect(modeOf(dir)).toBe(0o777)
  })

  it('refuses a symlinked runtime path without chmodding through it', async () => {
    const planted = join(userDataPath, 'planted')
    mkdirSync(planted)
    chmodSync(planted, 0o777)
    symlinkSync(planted, join(userDataPath, 'daemon'))
    const mod = await importDaemonInit()

    expect(() => mod.getDaemonEndpointPaths()).toThrow(/must be a directory/)
    // chmod follows symlinks: tightening before the guard would have reached the
    // link's target, acting through the path it had not yet decided to trust.
    expect(modeOf(planted)).toBe(0o777)
  })

  it('tightens a merely-readable dir it owns', async () => {
    const dir = join(userDataPath, 'daemon')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    const mod = await importDaemonInit()

    mod.getDaemonEndpointPaths()

    expect(modeOf(dir)).toBe(0o700)
  })
})
