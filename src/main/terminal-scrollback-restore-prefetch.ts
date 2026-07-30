import type { TerminalLayoutSnapshot, WorkspaceSessionState } from '../shared/types'

/** Each prefetched tail can carry the full 512KB replay limit, so the budget is
 *  deliberately small: only the panes that actually mount during restore. */
export const TERMINAL_SCROLLBACK_PREFETCH_MAX_REFS = 8

/** The session fields that decide which panes paint first on a cold start. */
export type RestoreScrollbackPrefetchSession = Pick<
  WorkspaceSessionState,
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'tabGroups'
  | 'terminalLayoutsByTabId'
>

function pushUnique(ids: string[], id: string | null | undefined): void {
  if (id && !ids.includes(id)) {
    ids.push(id)
  }
}

/** Tabs whose panes mount at restore: the active workspace's focused tab first,
 *  then the active tab of every other split group (those mount simultaneously).
 *  Keys may be a canonical WorkspaceKey or a legacy raw worktree id, and folder
 *  workspaces use the same maps, so both lookups are tried. */
function restoreTabIdsInMountOrder(session: RestoreScrollbackPrefetchSession): string[] {
  const workspaceKeys = [session.activeWorkspaceKey, session.activeWorktreeId].filter(
    (key): key is string => typeof key === 'string' && key.length > 0
  )
  const tabIds: string[] = []
  for (const key of workspaceKeys) {
    pushUnique(tabIds, session.activeTabIdByWorktree?.[key])
  }
  pushUnique(tabIds, session.activeTabId)
  for (const key of workspaceKeys) {
    for (const group of session.tabGroups?.[key] ?? []) {
      pushUnique(tabIds, group.activeTabId)
    }
  }
  return tabIds
}

/** Focused leaf first — it is the pane the user watches for the first frame. */
function layoutRefsInPaintOrder(layout: TerminalLayoutSnapshot): string[] {
  const refsByLeafId = layout.scrollbackRefsByLeafId
  if (!refsByLeafId) {
    return []
  }
  const activeRef = layout.activeLeafId ? refsByLeafId[layout.activeLeafId] : undefined
  const rest = Object.entries(refsByLeafId)
    .filter(([leafId]) => leafId !== layout.activeLeafId)
    .map(([, ref]) => ref)
  return activeRef ? [activeRef, ...rest] : rest
}

/**
 * Snapshot refs worth reading before the renderer asks for them. Mirrors the
 * mount order the restore replays in, so a truncated (capped) list still covers
 * the panes that block the first terminal frame; anything left out falls back
 * to the existing synchronous read.
 */
export function resolveRestoreScrollbackPrefetchRefs(
  session: RestoreScrollbackPrefetchSession,
  maxRefs: number = TERMINAL_SCROLLBACK_PREFETCH_MAX_REFS
): string[] {
  if (maxRefs <= 0) {
    return []
  }
  const layouts = session.terminalLayoutsByTabId ?? {}
  const refs: string[] = []
  const seen = new Set<string>()
  for (const tabId of restoreTabIdsInMountOrder(session)) {
    const layout = layouts[tabId]
    if (!layout) {
      continue
    }
    for (const ref of layoutRefsInPaintOrder(layout)) {
      if (!ref || seen.has(ref)) {
        continue
      }
      seen.add(ref)
      refs.push(ref)
      if (refs.length >= maxRefs) {
        return refs
      }
    }
  }
  return refs
}
