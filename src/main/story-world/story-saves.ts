/**
 * The child's undo — `docs/reference/app-modes.md` §7.7.
 *
 * **Snapshots are taken BEFORE every prompt submission**, not after a failure.
 * That ordering is the whole design: a recovery-conditioned trigger can only
 * produce a restore point once something has already broken, which is exactly
 * one save too late. Taking one before each turn guarantees a good state exists
 * before the first breakage.
 *
 * Saves live in userData, never in the workspace: `.orca/` is appended to the
 * repo's .gitignore precisely so it is never committed, and a child's snapshots
 * are Orca-authored telemetry rather than project content. The world definition
 * itself (`story-world.json`) stays at the workspace root, tracked, because a
 * parent should be able to commit and share it.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Files over this size are agent output nobody needs a copy of. */
const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024
/** Never snapshot these: large, regenerable, and not the child's work. */
const SKIPPED_ENTRIES = new Set(['node_modules', '.git', '.orca', 'dist', 'out', 'build'])

export type StorySaveEntry = { id: string; path: string }

export function getStorySavesRoot(userDataPath: string, workspaceKey: string): string {
  return join(userDataPath, 'story-world', workspaceKey, 'saves')
}

/** Newest first — the restore button always means "the last good one". */
export function listStorySaves(userDataPath: string, workspaceKey: string): StorySaveEntry[] {
  const root = getStorySavesRoot(userDataPath, workspaceKey)
  if (!existsSync(root)) {
    return []
  }
  return readdirSync(root)
    .filter((id) => statSync(join(root, id)).isDirectory())
    .sort((left, right) => right.localeCompare(left))
    .map((id) => ({ id, path: join(root, id) }))
}

function shouldCopy(entry: string, absolute: string): boolean {
  if (entry.startsWith('.') || SKIPPED_ENTRIES.has(entry)) {
    return false
  }
  try {
    const stats = statSync(absolute)
    return stats.isDirectory() || stats.size <= MAX_SNAPSHOT_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * Takes a snapshot. `stamp` is injected rather than read from the clock so the
 * caller owns ordering and the function stays testable.
 *
 * Bounded by `keep`: 0 disables saving entirely, and the caller must then also
 * hide the restore button rather than leave it present-and-failing (§7.7).
 */
export function captureStorySave(args: {
  workspaceRoot: string
  userDataPath: string
  workspaceKey: string
  stamp: string
  keep: number
}): StorySaveEntry | null {
  if (args.keep <= 0) {
    return null
  }
  const root = getStorySavesRoot(args.userDataPath, args.workspaceKey)
  const destination = join(root, args.stamp)
  mkdirSync(destination, { recursive: true })

  for (const entry of readdirSync(args.workspaceRoot)) {
    const source = join(args.workspaceRoot, entry)
    if (!shouldCopy(entry, source)) {
      continue
    }
    cpSync(source, join(destination, entry), { recursive: true })
  }

  pruneStorySaves(args.userDataPath, args.workspaceKey, args.keep)
  return { id: args.stamp, path: destination }
}

/** Oldest pruned first, so the newest `keep` survive. */
export function pruneStorySaves(userDataPath: string, workspaceKey: string, keep: number): void {
  const saves = listStorySaves(userDataPath, workspaceKey)
  for (const save of saves.slice(Math.max(0, keep))) {
    rmSync(save.path, { recursive: true, force: true })
  }
}

/**
 * Restores over the workspace. Additive: files the save does not know about are
 * left alone, because deleting a child's newer work in order to undo a break
 * would be a worse outcome than the break.
 */
export function restoreStorySave(args: { workspaceRoot: string; savePath: string }): boolean {
  if (!existsSync(args.savePath)) {
    return false
  }
  for (const entry of readdirSync(args.savePath)) {
    cpSync(join(args.savePath, entry), join(args.workspaceRoot, entry), { recursive: true })
  }
  return true
}
