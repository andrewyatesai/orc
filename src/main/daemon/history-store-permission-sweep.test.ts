import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import {
  HISTORY_DIR_MODE,
  HISTORY_FILE_MODE,
  tightenDaemonSessionStorePermissions
} from './history-store-layout'
import {
  cancelPendingSessionTreeRemovalRetries,
  flushPendingSessionTreeRemovals,
  schedulePendingSessionTreeRemovals
} from './terminal-history-session-tombstone'

const itOnPosix = process.platform === 'win32' ? it.skip : it

function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

function unsealDirectories(dir: string): void {
  try {
    chmodSync(dir, 0o700)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        unsealDirectories(join(dir, entry.name))
      }
    }
  } catch {
    // Best-effort teardown only.
  }
}

/** The sweep walks the same root the tombstone queue and the recovery quarantine nest under, so it
 *  must stay mode-aware per entry type: a directory left at 0o600 is undeletable (EACCES on drain). */
describe('daemon session store permission sweep', () => {
  let sessionsRoot: string

  beforeEach(() => {
    sessionsRoot = mkdtempSync(join(tmpdir(), 'history-permission-sweep-'))
  })

  afterEach(() => {
    cancelPendingSessionTreeRemovalRetries()
    // A failing assertion can leave a directory sealed at 0o600, which rm cannot enter.
    unsealDirectories(sessionsRoot)
    rmSync(sessionsRoot, { recursive: true, force: true })
  })

  function seedLooseTree(dir: string, fileName: string): string {
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, fileName)
    writeFileSync(filePath, '{}')
    // Older builds wrote at umask defaults; that is what the sweep exists to fix.
    chmodSync(dir, 0o755)
    chmodSync(filePath, 0o644)
    return filePath
  }

  itOnPosix('leaves a queued tombstone private and still removable', async () => {
    const tombstone = join(sessionsRoot, '.pending-delete', 'a1b2c3d4-tombstone')
    const checkpoint = seedLooseTree(tombstone, 'checkpoint.json')
    chmodSync(join(sessionsRoot, '.pending-delete'), 0o755)

    tightenDaemonSessionStorePermissions(sessionsRoot)

    expect(fileMode(join(sessionsRoot, '.pending-delete'))).toBe(HISTORY_DIR_MODE)
    expect(fileMode(tombstone)).toBe(HISTORY_DIR_MODE)
    expect(fileMode(checkpoint)).toBe(HISTORY_FILE_MODE)

    // The drain a HistoryManager construction runs right after the sweep.
    schedulePendingSessionTreeRemovals(sessionsRoot)
    await flushPendingSessionTreeRemovals()

    expect(existsSync(tombstone)).toBe(false)
  })

  itOnPosix('tightens the nested quarantine tree without sealing its directories', () => {
    const generation = join(sessionsRoot, '.recovery-quarantine', 'abcd1234', 'ef567890-generation')
    const checkpoint = seedLooseTree(generation, 'checkpoint.json')

    tightenDaemonSessionStorePermissions(sessionsRoot)

    expect(fileMode(join(sessionsRoot, '.recovery-quarantine', 'abcd1234'))).toBe(HISTORY_DIR_MODE)
    expect(fileMode(generation)).toBe(HISTORY_DIR_MODE)
    expect(fileMode(checkpoint)).toBe(HISTORY_FILE_MODE)
  })

  itOnPosix('still tightens a plain session dir', () => {
    const sessionDir = join(sessionsRoot, encodeURIComponent('wt::/a@@12345678'))
    const checkpoint = seedLooseTree(sessionDir, 'checkpoint.json')

    tightenDaemonSessionStorePermissions(sessionsRoot)

    expect(fileMode(sessionsRoot)).toBe(HISTORY_DIR_MODE)
    expect(fileMode(sessionDir)).toBe(HISTORY_DIR_MODE)
    expect(fileMode(checkpoint)).toBe(HISTORY_FILE_MODE)
  })
})
