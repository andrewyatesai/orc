import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseAppModeId, type AppModeId } from '../../shared/app-mode/app-mode-id'
import { writeFileAtomicSync } from '../atomic-file-write'

// Why a sidecar and not orca-data.json: that file is written compact with no indent, is multi-MB on
// a heavy install, and mixes settings with terminal layouts and orca-safestorage-v1: encrypted
// secrets. Asking a parent to hand-edit it would be malpractice. This one is ~40 bytes and stable.
export const APP_MODE_SIDECAR_FILENAME = 'app-mode.json'

export type AppModePin = {
  appMode?: unknown
  lock?: unknown
}

export type AppModeSidecarRead = {
  /** Raw parsed contents, or null when the file is absent/unreadable/not an object. */
  pin: AppModePin | null
  /** Set when the file exists and names a mode that parseAppModeId rejects. */
  unrecognizedMode: string | null
}

/**
 * Derived from the data file so it is per-Orca-profile automatically, and so it never re-resolves
 * app.getPath('userData') late (the ordering hazard documented in persistence.ts initDataPath).
 */
export function getAppModeSidecarPath(dataFile: string): string {
  return join(dirname(dataFile), APP_MODE_SIDECAR_FILENAME)
}

export function parseAppModeSidecar(contents: string): AppModeSidecarRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return { pin: null, unrecognizedMode: null }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { pin: null, unrecognizedMode: null }
  }
  const pin = parsed as AppModePin
  // Why surface the bad value instead of silently coercing: in an agent-orchestration IDE this file
  // was probably written by an agent, so coercing would mean the human never learns it was discarded.
  const unrecognizedMode =
    typeof pin.appMode === 'string' && parseAppModeId(pin.appMode) === null ? pin.appMode : null
  return { pin, unrecognizedMode }
}

export function readAppModeSidecar(dataFile: string): AppModeSidecarRead {
  const path = getAppModeSidecarPath(dataFile)
  if (!existsSync(path)) {
    return { pin: null, unrecognizedMode: null }
  }
  try {
    return parseAppModeSidecar(readFileSync(path, 'utf8'))
  } catch (err) {
    console.warn(`[app-mode] failed to read ${APP_MODE_SIDECAR_FILENAME}:`, err)
    return { pin: null, unrecognizedMode: null }
  }
}

export function serializeAppModeSidecar(mode: AppModeId, lock = false): string {
  // Pretty-printed with a trailing newline: this file is meant to be opened and edited by a person.
  return `${JSON.stringify({ appMode: mode, lock }, null, 2)}\n`
}

/**
 * The single writer behind all three selection surfaces (menu bar, Settings pane, CLI).
 * Absent by default — nothing creates it until a user actually chooses a mode.
 */
export function writeAppModeSidecar(dataFile: string, mode: AppModeId, lock = false): void {
  writeFileAtomicSync(getAppModeSidecarPath(dataFile), serializeAppModeSidecar(mode, lock))
}

/**
 * Watch for external edits (a user opening the file in an editor). Fires only when the pin actually
 * changes, so a re-save with no edit is a no-op.
 */
export function watchAppModeSidecar(
  dataFile: string,
  onPinChanged: (read: AppModeSidecarRead) => void
): () => void {
  const directory = dirname(getAppModeSidecarPath(dataFile))
  let lastSerialized = JSON.stringify(readAppModeSidecar(dataFile).pin)
  let watcher: FSWatcher | null = null
  // Why debounce: editors write in several syscalls, so one save can emit multiple change events.
  let timer: ReturnType<typeof setTimeout> | null = null

  const reread = (): void => {
    const read = readAppModeSidecar(dataFile)
    const serialized = JSON.stringify(read.pin)
    if (serialized === lastSerialized) {
      return
    }
    lastSerialized = serialized
    onPinChanged(read)
  }

  try {
    // Why watch the directory, not the file: editors replace-on-save (write temp + rename), which
    // breaks an inode-bound file watch after the first edit. writeFileAtomicSync does the same.
    watcher = watch(directory, (_event, filename) => {
      if (filename !== null && filename !== APP_MODE_SIDECAR_FILENAME) {
        return
      }
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(reread, 50)
    })
  } catch (err) {
    console.warn(`[app-mode] cannot watch ${directory}; external edits need a restart:`, err)
  }

  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    watcher?.close()
    watcher = null
  }
}
