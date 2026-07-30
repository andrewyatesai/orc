import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { resolveRestoreScrollbackPrefetchRefs } from '../terminal-scrollback-restore-prefetch'
import type { WorkspaceSessionPatch, WorkspaceSessionState } from '../../shared/types'

type TerminalScrollbackTailRead = NonNullable<
  ReturnType<Store['readTerminalScrollbackSnapshotTail']>
>

// Why once per app run: the restore replay happens in the first window to load,
// and each answered ref hands out up to the 512KB replay limit. A reload or a
// later popout gets an empty map and falls back to the sync read below.
let restoreTailPrefetchServed = false

export function resetTerminalScrollbackRestorePrefetchForTest(): void {
  restoreTailPrefetchServed = false
}

/** Yield the loop between reads so a multi-pane prefetch can never stall the
 *  startup IPC main is answering concurrently. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function registerSessionHandlers(store: Store): void {
  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  ipcMain.handle('session:set', (_event, args: WorkspaceSessionState, hostId?: string | null) => {
    store.setWorkspaceSession(args, hostId)
  })

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    store.patchWorkspaceSession(args, hostId)
  })

  ipcMain.handle('session:flush', () => {
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    store.flushOrThrow()
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    store.setWorkspaceSession(args, hostId)
    store.flush()
    event.returnValue = true
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )

  // P5 deep restore: sync tail (bounded, renderer-blocking like the legacy read)
  // plus offsets, then the older region streams through the async chunk handle.
  ipcMain.on(
    'session:read-terminal-scrollback-tail-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshotTail(args.ref) : null
    }
  )

  // Restore prefetch: the preload pulls this while the renderer bundle is still
  // parsing (src/preload/terminal-scrollback-tail-prefetch.ts), so the panes that
  // mount first read their tail from memory instead of blocking on this process.
  // Same Store call as the sync channel above — identical bytes, caps, and
  // missing/corrupt handling (null is simply omitted from the map).
  ipcMain.handle('session:prefetch-restore-terminal-scrollback-tails', async () => {
    if (restoreTailPrefetchServed) {
      return {}
    }
    restoreTailPrefetchServed = true
    const tails: Record<string, TerminalScrollbackTailRead> = {}
    for (const ref of resolveRestoreScrollbackPrefetchRefs(store.getWorkspaceSession())) {
      await yieldToEventLoop()
      const tail = store.readTerminalScrollbackSnapshotTail(ref)
      if (tail) {
        tails[ref] = tail
      }
    }
    return tails
  })

  ipcMain.handle(
    'session:read-terminal-scrollback-older-chunk',
    (
      _event,
      args: { ref?: unknown; cursor?: unknown; endOffset?: unknown; fingerprint?: unknown }
    ) => {
      if (
        typeof args?.ref !== 'string' ||
        typeof args.cursor !== 'number' ||
        typeof args.endOffset !== 'number' ||
        typeof args.fingerprint !== 'string'
      ) {
        return null
      }
      return store.readTerminalScrollbackSnapshotOlderChunk({
        ref: args.ref,
        cursor: args.cursor,
        endOffset: args.endOffset,
        fingerprint: args.fingerprint
      })
    }
  )
}
