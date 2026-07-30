/** One snapshot tail read — mirrors PreloadApi['session'].readTerminalScrollbackTail. */
export type TerminalScrollbackTailRead = {
  text: string
  olderChunkCursor: number
  olderEndOffset: number
  fingerprint: string
}

/** Answered by registerSessionHandlers (src/main/ipc/session.ts), once per app run. */
export const TERMINAL_SCROLLBACK_TAIL_PREFETCH_CHANNEL =
  'session:prefetch-restore-terminal-scrollback-tails'

/** Prefetched tails past this age are dropped unread: the restore they were read
 *  for is long over, and a pane mounting this late (a deferred SSH host, say)
 *  should re-read rather than replay bytes the snapshot file may have outgrown. */
export const TERMINAL_SCROLLBACK_TAIL_PREFETCH_TTL_MS = 60_000

/** Cap on refs remembered while the prefetch is still in flight. Beyond it a
 *  duplicate is harmless (both paths read the same file), just not prevented. */
const MAX_TRACKED_EARLY_READS = 32

export type TerminalScrollbackTailPrefetchDeps = {
  /** Fires the prefetch pull; anything thenable (or nothing) is tolerated. */
  requestPrefetch: () => unknown
  /** The existing renderer-blocking read, used whenever no prefetch is resident. */
  readTailSync: (args: { ref: string }) => TerminalScrollbackTailRead | null
  now?: () => number
  scheduleExpiry?: (run: () => void, delayMs: number) => void
}

export type TerminalScrollbackTailReader = {
  read: (args: { ref: string }) => TerminalScrollbackTailRead | null
  /** Drop the prefetch before a session write that may rewrite snapshot files. */
  noteSessionWrite: (session: unknown) => void
  /** Resident prefetched tails — for tests and leak assertions. */
  cachedRefCount: () => number
}

/** Main rewrites a ref's snapshot file only for layouts that carry serialized
 *  buffers (a park/sleep/close capture), so only those writes can stale a
 *  prefetched tail. Ref-only writes — every write a restore itself makes — must
 *  not invalidate, or the prefetch would be discarded before any pane mounts. */
function sessionWriteCanRewriteSnapshots(session: unknown): boolean {
  const layouts = (
    session as {
      terminalLayoutsByTabId?: Record<string, { buffersByLeafId?: Record<string, string> } | null>
    } | null
  )?.terminalLayoutsByTabId
  if (!layouts || typeof layouts !== 'object') {
    return false
  }
  for (const layout of Object.values(layouts)) {
    if (layout?.buffersByLeafId && Object.keys(layout.buffersByLeafId).length > 0) {
      return true
    }
  }
  return false
}

function isTailRead(value: unknown): value is TerminalScrollbackTailRead {
  const tail = value as TerminalScrollbackTailRead | null
  return (
    !!tail &&
    typeof tail === 'object' &&
    typeof tail.text === 'string' &&
    typeof tail.olderChunkCursor === 'number' &&
    typeof tail.olderEndOffset === 'number' &&
    typeof tail.fingerprint === 'string'
  )
}

/**
 * Serves restored panes their scrollback tail without blocking the renderer.
 *
 * Why a prefetch and not an async read at mount: the layout must already carry
 * its buffers when PaneManager builds the grid, otherwise panes paint empty and
 * reflow when the bytes land. So the read stays synchronous at the call site and
 * moves EARLIER instead — this pull runs during preload evaluation, before the
 * renderer bundle parses, and the mount-time read becomes a map lookup.
 *
 * Delivery is exactly once per ref: a hit is removed as it is handed out (a
 * resident tail can be the full 512KB replay limit), and a ref the sync fallback
 * already answered is dropped from the prefetch when it lands.
 */
export function createTerminalScrollbackTailReader(
  deps: TerminalScrollbackTailPrefetchDeps
): TerminalScrollbackTailReader {
  const now = deps.now ?? ((): number => Date.now())
  const scheduleExpiry =
    deps.scheduleExpiry ??
    ((run: () => void, delayMs: number): void => {
      setTimeout(run, delayMs)
    })

  const prefetched = new Map<string, TerminalScrollbackTailRead>()
  const readBeforePrefetchLanded = new Set<string>()
  let prefetchSettled = false
  let prefetchedAt = 0
  let snapshotRewriteObservedInFlight = false

  const finishPrefetch = (payload: unknown): void => {
    prefetchSettled = true
    prefetchedAt = now()
    if (snapshotRewriteObservedInFlight) {
      // A snapshot-rewriting session write landed while this read was in
      // flight, so the payload may predate it — drop it whole rather than
      // serve a pane bytes that are already stale on disk.
      readBeforePrefetchLanded.clear()
      return
    }
    if (payload && typeof payload === 'object') {
      for (const [ref, tail] of Object.entries(payload as Record<string, unknown>)) {
        if (readBeforePrefetchLanded.has(ref) || !isTailRead(tail)) {
          continue
        }
        prefetched.set(ref, tail)
      }
    }
    readBeforePrefetchLanded.clear()
    if (prefetched.size > 0) {
      scheduleExpiry(() => prefetched.clear(), TERMINAL_SCROLLBACK_TAIL_PREFETCH_TTL_MS)
    }
  }

  try {
    void Promise.resolve(deps.requestPrefetch()).then(finishPrefetch, () => finishPrefetch(null))
  } catch {
    // No prefetch available (no handler, closing window): the sync path covers it.
    prefetchSettled = true
  }

  const read = (args: { ref: string }): TerminalScrollbackTailRead | null => {
    const ref = typeof args?.ref === 'string' ? args.ref : null
    if (ref) {
      const hit = prefetched.get(ref)
      if (hit) {
        prefetched.delete(ref)
        if (now() - prefetchedAt <= TERMINAL_SCROLLBACK_TAIL_PREFETCH_TTL_MS) {
          return hit
        }
      } else if (!prefetchSettled && readBeforePrefetchLanded.size < MAX_TRACKED_EARLY_READS) {
        readBeforePrefetchLanded.add(ref)
      }
    }
    return deps.readTailSync(args)
  }

  const noteSessionWrite = (session: unknown): void => {
    if (!sessionWriteCanRewriteSnapshots(session)) {
      return
    }
    if (!prefetchSettled) {
      // Before the payload lands there is nothing to clear, so record the
      // rewrite — finishPrefetch discards a payload that raced it.
      snapshotRewriteObservedInFlight = true
      return
    }
    prefetched.clear()
  }

  return { read, noteSessionWrite, cachedRefCount: () => prefetched.size }
}
