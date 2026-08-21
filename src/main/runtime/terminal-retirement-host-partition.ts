import type { ExecutionHostId } from '../../shared/execution-host'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'

/**
 * Partition retired surfaces by the host that owns each surface's worktree.
 * A pane's absence must be persisted in its OWNING host session, never the local one —
 * a remote-host surface written to the local partition is never durably retired and resurrects.
 */
export function groupRetiredSurfacesByOwningHost(
  surfaces: readonly RetiredTerminalSurface[],
  hostIdForWorktree: (worktreeId: string) => ExecutionHostId
): Map<ExecutionHostId, RetiredTerminalSurface[]> {
  const byHostId = new Map<ExecutionHostId, RetiredTerminalSurface[]>()
  for (const surface of surfaces) {
    const hostId = hostIdForWorktree(surface.worktreeId)
    const bucket = byHostId.get(hostId)
    if (bucket) {
      bucket.push(surface)
    } else {
      byHostId.set(hostId, [surface])
    }
  }
  return byHostId
}
