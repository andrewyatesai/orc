import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-polling'

// Why: branch switches and commits made in the primary checkout rewrite these
// top-level files (linked-worktree equivalents live under `worktrees/`).
// Deliberately excludes FETCH_HEAD-style churn that carries no status change.
async function snapshotPrimaryCheckoutMetadata(
  commonDirPath: string
): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>()
  for (const name of PRIMARY_CHECKOUT_METADATA_FILES) {
    const filePath = join(commonDirPath, name)
    try {
      mtimes.set(filePath, (await stat(filePath)).mtimeMs)
    } catch {
      // Missing file (e.g. no packed-refs yet) diffs into a create later.
    }
  }
  return mtimes
}

function diffMtimeMap(
  prev: Map<string, number>,
  next: Map<string, number>
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  for (const [path, mtime] of next) {
    const prevMtime = prev.get(path)
    if (prevMtime === undefined) {
      events.push({ type: 'create', path })
    } else if (prevMtime !== mtime) {
      events.push({ type: 'update', path })
    }
  }
  for (const path of prev.keys()) {
    if (!next.has(path)) {
      events.push({ type: 'delete', path })
    }
  }
  return events
}

// The darwin narrow watch covers `worktrees/`; the primary checkout's shallow
// branch/index files are covered by this snapshot-diff poll (a native stream
// would have to span the whole common dir, objects included).
export async function startGitCommonPrimaryMetadataPoll(
  commonDirPath: string,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let snapshot = await snapshotPrimaryCheckoutMetadata(commonDirPath)
  let timer: ReturnType<typeof setTimeout> | null = null
  let parkedWhileHidden = false

  const tick = async (): Promise<void> => {
    timer = null
    if (disposed) {
      return
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return
    }
    if (ticking) {
      return
    }
    ticking = true
    // Why: measure from tick start so cadence is start-to-start, not gap-after-completion (which would
    // land each visible refresh a full scan-duration late every tick).
    const startedAt = Date.now()
    onFullScan?.()
    try {
      const next = await snapshotPrimaryCheckoutMetadata(commonDirPath)
      if (disposed) {
        return
      }
      const events = diffMtimeMap(snapshot, next)
      snapshot = next
      if (events.length > 0) {
        onEvents(events)
      }
    } catch {
      // Transient fs error: keep the previous snapshot and retry next tick.
    } finally {
      ticking = false
    }
    if (!disposed) {
      // Why: clamp to [0, pollIntervalMs]. Date.now() is not monotonic — a backward wall-clock jump (NTP) would
      // otherwise make elapsed negative and push the next tick out by the adjustment (suppressing refreshes for
      // minutes); the upper clamp caps the wait at one interval, the lower clamp keeps a long scan from going negative.
      const nextDelay = Math.max(
        0,
        Math.min(pollIntervalMs, pollIntervalMs - (Date.now() - startedAt))
      )
      timer = setTimeout(() => void tick(), nextDelay)
      timer.unref?.()
    }
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    void tick()
  })

  timer = setTimeout(() => void tick(), pollIntervalMs)
  timer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribeVisibility()
    }
  }
}
