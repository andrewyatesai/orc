import { toast } from 'sonner'
import { basename, dirname, joinPath } from '@/lib/path'
import { commitFileExplorerOp } from '@/components/right-sidebar/fileExplorerUndoRedo'
import { executeOpenEditorPathMove } from '@/lib/execute-open-editor-path-move'
import { recordSelfMoveForOpenTabs } from '@/components/editor/record-self-move-for-open-tabs'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from '@/components/right-sidebar/file-explorer-operation-owner'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'

/**
 * Electron's ipcRenderer.invoke wraps errors as:
 *   "Error invoking remote method 'channel': Error: actual message"
 * Strip the wrapper so users see only the meaningful part.
 */
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

type RenameFileArgs = {
  oldPath: string
  /** just the new filename (no directory) */
  newName: string
  worktreeId: string
  worktreePath: string
  operationOwner?: FileExplorerOperationOwner
  /** refresh the parent directory in the explorer tree, if caller tracks one */
  refreshDir?: (dirPath: string) => Promise<void>
}

/**
 * Rename a file or directory on disk. Handles:
 *   - no-op when the name is unchanged
 *   - the open-editor move transaction (quiesce + rename + rekey) via the coordinator
 *   - committing an undo/redo pair via the file-explorer undo stack
 *   - unwrapped toast on IPC failure
 *
 * Used by the file-explorer inline rename and by double-click-rename
 * from an editor tab. Both go through here so the move behavior stays consistent.
 */
export async function renameFileOnDisk(args: RenameFileArgs): Promise<void> {
  const { oldPath, newName, worktreeId, worktreePath, refreshDir } = args
  const trimmed = newName.trim()
  if (!trimmed) {
    return
  }
  const existingName = basename(oldPath)
  if (trimmed === existingName) {
    return
  }
  const parentDir = dirname(oldPath)
  const newPath = joinPath(parentDir, trimmed)
  const operationGuard = captureFileExplorerOperationGuard(
    worktreeId,
    args.operationOwner ?? getFileExplorerOperationOwner(worktreeId)
  )
  const operationRoute = operationGuard.route
  const connectionId = operationRoute.connectionId
  const fileContext = {
    settings: operationRoute.settings,
    worktreeId,
    worktreePath,
    connectionId,
    expectedExecutionHostId: operationRoute.expectedExecutionHostId,
    expectedSshTargetId: operationRoute.expectedSshTargetId,
    expectedSshConnectionGeneration: operationRoute.expectedSshConnectionGeneration
  }

  // Assigned once the owner guard passes; the catch retracts whatever was stamped.
  let retractSelfMove = (): void => {}
  try {
    operationGuard.assertCurrent()
    // Why: stamp the move before the on-disk rename so the watcher's own
    // delete(old)+create(new) echo isn't mistaken for an external write on the
    // re-homed dirty tab (#9506); retract if the rename never happens. Stamped
    // after the owner guard so a stale-owner throw leaves no live stamp.
    retractSelfMove = recordSelfMoveForOpenTabs({
      fromPath: oldPath,
      toPath: newPath,
      connectionId
    })
    await executeOpenEditorPathMove({
      context: fileContext,
      fromPath: oldPath,
      toPath: newPath,
      worktreeId,
      worktreePath
    })
    // Re-stamp after the rename resolves: a slow SSH/runtime rename can outlive
    // the pre-rename TTL, so restart the window from when the file actually moved.
    recordSelfMoveForOpenTabs({ fromPath: oldPath, toPath: newPath, connectionId })
    commitFileExplorerOp({
      undo: async () => {
        operationGuard.assertCurrent()
        recordSelfMoveForOpenTabs({ fromPath: newPath, toPath: oldPath, connectionId })
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: newPath,
          toPath: oldPath,
          worktreeId,
          worktreePath
        })
        recordSelfMoveForOpenTabs({ fromPath: newPath, toPath: oldPath, connectionId })
        if (refreshDir) {
          await refreshDir(parentDir)
        }
      },
      redo: async () => {
        operationGuard.assertCurrent()
        recordSelfMoveForOpenTabs({ fromPath: oldPath, toPath: newPath, connectionId })
        await executeOpenEditorPathMove({
          context: fileContext,
          fromPath: oldPath,
          toPath: newPath,
          worktreeId,
          worktreePath
        })
        recordSelfMoveForOpenTabs({ fromPath: oldPath, toPath: newPath, connectionId })
        if (refreshDir) {
          await refreshDir(parentDir)
        }
      }
    })
  } catch (err) {
    retractSelfMove()
    toast.error(extractIpcErrorMessage(err, `Failed to rename '${existingName}'.`))
  }
  if (refreshDir) {
    await refreshDir(parentDir)
  }
}
