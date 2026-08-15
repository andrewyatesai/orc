// Native OS file-drop routing on the Rust core (`orca_core::native_file_drop`),
// replacing the deleted bodies in `src/shared/native-file-drop.ts` (which keeps
// the ids, limits, types and the still-unported payload builders/validators).
//
// WHY THE SHARED SEAM AND NOT A TREE SHIM: the dominant consumer is
// `src/preload/index.ts`, which owns the document-level `dragover`/`drop`
// listeners because `webUtils.getPathForFile` only exists in the preload world.
// Preload can bind NEITHER binding — napi lives in main, wasm in renderer/relay —
// so `dispatchToRustCore`/`dispatchToWasmCore` are both unreachable there, and a
// second copy of this logic for `useSidebarProjectDrop` (the one renderer caller,
// which does reach wasm) would be the duplication the cut-over exists to remove.
// One shim, on `orca-dispatch-seam`, for both trees.
//
// PRE-READY CONTRACT — `parity`, and it has to be. Preload has no binding at all
// today, so its seam is unbound for the whole session: the fallback IS the
// behaviour of every OS file drop, not a boot blip. Neither function has a spare
// state to signal with — `hasNativeFileDragTypes` is a bare boolean consumed
// inside `if (!…) return`, and `resolveNativeFileDropPath`'s `null` is a REAL
// answer ("no surface claimed it", which `createNativeFileDropPayload` turns into
// an editor drop). So both fallbacks rebuild the twin's body inline from the
// constants kept in the data twin, and pre-ready equals ready for every input.
//
// `paneLeafId` IS NOT PORTED. `orca_core`'s `NativeFileDropPathEntry` has no
// `terminal_pane_leaf_id`, so the core's terminal resolution carries only
// `tabId`. The field is therefore composed here, in TS, on BOTH paths — dropping
// it would send a drop aimed at one split to `manager.getActivePane()`
// (`terminal-drop-pane-resolution.ts`), i.e. paste the paths into a different
// pane than the one under the cursor.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { isOrcaDispatchReady, tryOrcaDispatch } from './orca-dispatch-seam'
import {
  NATIVE_FILE_DROP_TARGET,
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  type NativeDropResolution,
  type NativeFileDropPathEntry
} from './native-file-drop'

/** True for a genuine OS file drag: carries `Files` and is not one of Orca's own
 *  internal file moves (which also set the internal drag type). */
export function hasNativeFileDragTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): boolean {
  // Why materialize first: `DataTransfer.types` is a DOMStringList in preload —
  // an exotic object the codec rejects — and the fallback needs the same view.
  const values = types ? Array.from(types) : []
  const fallback = values.includes('Files') && !values.includes(ORCA_INTERNAL_FILE_DRAG_TYPE)
  try {
    const answer = tryOrcaDispatch('native-file-drop', 'hasNativeFileDragTypes', values, {
      root: 'dragTypes'
    })
    return answer === null ? fallback : (answer as boolean)
  } catch (error) {
    // Why the catch: MIME strings never carry a lone surrogate today, but a
    // rejected encode inside a `dragover` listener would throw ~60×/s through
    // the drag; the twin answered without crossing, so answer as the twin did.
    if (error instanceof DispatchPayloadError) {
      return fallback
    }
    throw error
  }
}

/** Resolve where a native file drop should go by walking the event target path
 *  innermost-first. `null` means no surface claimed it (an editor drop). */
export function resolveNativeFileDropPath(
  path: readonly NativeFileDropPathEntry[]
): NativeDropResolution | null {
  const resolution = resolveDropSurface(path)
  if (resolution?.target !== NATIVE_FILE_DROP_TARGET.terminal) {
    return resolution
  }
  const paneLeafId = nearestTerminalPaneLeafId(path)
  return paneLeafId === undefined ? resolution : { ...resolution, paneLeafId }
}

function resolveDropSurface(path: readonly NativeFileDropPathEntry[]): NativeDropResolution | null {
  // Why `isOrcaDispatchReady` and not `answer === null`: the core returns null
  // for an unclaimed drop, so null cannot double as the unbound signal here.
  if (isOrcaDispatchReady()) {
    try {
      return tryOrcaDispatch('native-file-drop', 'resolveNativeFileDropPath', path, {
        root: 'dropPath',
        // Why: every entry is built from `element.dataset.*`, so an absent
        // attribute is an explicit `undefined` the codec refuses by default —
        // and Rust reads each field as an absent-is-None `Option<String>`.
        undefinedProperties: 'omit'
      }) as NativeDropResolution | null
    } catch (error) {
      // Why: a Windows filename may hold an unpaired UTF-16 surrogate, and this
      // runs inside the native `drop` listener after preventDefault — a throw
      // there loses the drop silently. The twin routed it without crossing.
      if (!(error instanceof DispatchPayloadError)) {
        throw error
      }
    }
  }
  return resolveDropSurfaceFromEntries(path)
}

function resolveDropSurfaceFromEntries(
  path: readonly NativeFileDropPathEntry[]
): NativeDropResolution | null {
  let foundExplorer = false
  let destinationDir: string | undefined

  for (const entry of path) {
    const target = entry.nativeFileDropTarget
    if (target === NATIVE_FILE_DROP_TARGET.terminal) {
      return { target, tabId: entry.terminalTabId }
    }
    if (
      target === NATIVE_FILE_DROP_TARGET.editor ||
      target === NATIVE_FILE_DROP_TARGET.composer ||
      target === NATIVE_FILE_DROP_TARGET.projectSidebar
    ) {
      return { target }
    }
    if (target === NATIVE_FILE_DROP_TARGET.fileExplorer) {
      foundExplorer = true
    }

    // Pick the nearest (innermost) destination directory marker.
    if (destinationDir === undefined && entry.nativeFileDropDir) {
      destinationDir = entry.nativeFileDropDir
    }
  }

  if (foundExplorer) {
    if (!destinationDir) {
      return { target: 'rejected' }
    }
    return { target: NATIVE_FILE_DROP_TARGET.fileExplorer, destinationDir }
  }

  return null
}

/** The twin accumulated the leaf id while walking and returned it from the
 *  terminal entry, so the scan stops there — an outer pane's marker must not
 *  win over the pane that was actually dropped on. */
function nearestTerminalPaneLeafId(path: readonly NativeFileDropPathEntry[]): string | undefined {
  let paneLeafId: string | undefined
  for (const entry of path) {
    paneLeafId ??= entry.terminalPaneLeafId
    if (entry.nativeFileDropTarget === NATIVE_FILE_DROP_TARGET.terminal) {
      break
    }
  }
  return paneLeafId
}
