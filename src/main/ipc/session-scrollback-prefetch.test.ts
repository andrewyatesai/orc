import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeHandlers, syncHandlers } = vi.hoisted(() => ({
  invokeHandlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  syncHandlers: new Map<string, (event: { returnValue?: unknown }, args?: unknown) => void>()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => join(tmpdir(), 'orca-session-prefetch-unused-legacy-root')) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      invokeHandlers.set(channel, handler)
    }),
    on: vi.fn(
      (channel: string, handler: (event: { returnValue?: unknown }, args?: unknown) => void) => {
        syncHandlers.set(channel, handler)
      }
    )
  }
}))

import type { Store } from '../persistence'
import {
  makeTerminalScrollbackSnapshotRef,
  writeTerminalScrollbackSnapshotSync
} from '../terminal-scrollback-snapshots'
import { readTerminalScrollbackSnapshotTailSync } from '../terminal-scrollback-snapshot-deep-read'
import type { WorkspaceSessionState } from '../../shared/types'
import { registerSessionHandlers, resetTerminalScrollbackRestorePrefetchForTest } from './session'

const PREFETCH_CHANNEL = 'session:prefetch-restore-terminal-scrollback-tails'
const SYNC_TAIL_CHANNEL = 'session:read-terminal-scrollback-tail-sync'

// Multibyte-heavy so a UTF-8-aligned tail read is actually exercised.
function buildBuffer(lines: number): string {
  return `log \u{1F980} café 你好 ${'x'.repeat(60)}\r\n`.repeat(lines)
}

describe('session scrollback restore prefetch handler', () => {
  let snapshotRoot: string
  let session: WorkspaceSessionState
  let store: Store

  function writeSnapshot(tabId: string, leafId: string, buffer: string): string {
    const ref = writeTerminalScrollbackSnapshotSync({
      tabId,
      leafId,
      buffer,
      storage: { snapshotRoot }
    })
    expect(ref).toBe(makeTerminalScrollbackSnapshotRef(tabId, leafId))
    return ref!
  }

  function readSyncTail(ref: string): unknown {
    const event: { returnValue?: unknown } = {}
    syncHandlers.get(SYNC_TAIL_CHANNEL)!(event, { ref })
    return event.returnValue
  }

  async function prefetch(): Promise<Record<string, { text: string }>> {
    return (await invokeHandlers.get(PREFETCH_CHANNEL)!({})) as Record<string, { text: string }>
  }

  beforeEach(() => {
    invokeHandlers.clear()
    syncHandlers.clear()
    resetTerminalScrollbackRestorePrefetchForTest()
    snapshotRoot = mkdtempSync(join(tmpdir(), 'orca-scrollback-prefetch-'))
    session = {
      activeRepoId: null,
      activeWorktreeId: 'worktree-1',
      activeTabId: 'tab-1',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    store = {
      getWorkspaceSession: () => session,
      readTerminalScrollbackSnapshotTail: (ref: string) =>
        readTerminalScrollbackSnapshotTailSync(ref, { snapshotRoot })
    } as unknown as Store
    registerSessionHandlers(store)
  })

  afterEach(() => {
    rmSync(snapshotRoot, { recursive: true, force: true })
  })

  it('prefetches the active tab tails byte-for-byte identically to the sync read', async () => {
    const activeRef = writeSnapshot('tab-1', 'leaf-a', buildBuffer(40))
    const siblingRef = writeSnapshot('tab-1', 'leaf-b', buildBuffer(9_000))
    session.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        scrollbackRefsByLeafId: { 'leaf-a': activeRef, 'leaf-b': siblingRef }
      }
    }

    const tails = await prefetch()

    expect(Object.keys(tails)).toEqual([activeRef, siblingRef])
    expect(tails[activeRef]).toEqual(readSyncTail(activeRef))
    expect(tails[siblingRef]).toEqual(readSyncTail(siblingRef))
  })

  it('omits refs whose snapshot is missing, exactly as the sync read returns null', async () => {
    const presentRef = writeSnapshot('tab-1', 'leaf-a', buildBuffer(10))
    const missingRef = makeTerminalScrollbackSnapshotRef('tab-1', 'leaf-gone')
    session.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        scrollbackRefsByLeafId: { 'leaf-a': presentRef, 'leaf-gone': missingRef }
      }
    }

    const tails = await prefetch()

    expect(readSyncTail(missingRef)).toBeNull()
    expect(missingRef in tails).toBe(false)
    expect(tails[presentRef]).toEqual(readSyncTail(presentRef))
  })

  it('serves the prefetch once per app run so later windows use the sync path', async () => {
    const ref = writeSnapshot('tab-1', 'leaf-a', buildBuffer(10))
    session.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        scrollbackRefsByLeafId: { 'leaf-a': ref }
      }
    }

    expect(Object.keys(await prefetch())).toEqual([ref])
    expect(await prefetch()).toEqual({})
    // The fallback still answers the second window with the same bytes.
    expect(readSyncTail(ref)).not.toBeNull()
  })

  it('returns nothing when the restored session has no scrollback refs', async () => {
    expect(await prefetch()).toEqual({})
  })
})
