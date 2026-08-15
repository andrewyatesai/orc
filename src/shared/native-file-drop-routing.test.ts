// The drag-gate + target-path router after the cut-over to
// `orca_core::native_file_drop`. Both cases the twin's tests covered are here,
// asserted in BOTH seam states: preload owns the real drop listeners and can
// bind neither binding, so its seam is unbound for the whole session — the
// unbound answer is production behaviour for every OS file drop, not a boot blip.
import { afterEach, describe, expect, it } from 'vitest'
import { NATIVE_FILE_DROP_TARGET, ORCA_INTERNAL_FILE_DRAG_TYPE } from './native-file-drop'
import type { NativeDropResolution, NativeFileDropPathEntry } from './native-file-drop'
import { hasNativeFileDragTypes, resolveNativeFileDropPath } from './native-file-drop-routing'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function bindWasmSeam(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

function inBothSeamStates<T>(call: () => T): { bound: T; unbound: T } {
  setOrcaDispatchBinding(null)
  const unbound = call()
  bindWasmSeam()
  return { bound: call(), unbound }
}

const DRAG_TYPE_CASES: readonly (readonly [readonly string[], boolean])[] = [
  [['Files'], true],
  [['Files', ORCA_INTERNAL_FILE_DRAG_TYPE], false],
  [['text/uri-list'], false],
  [['text/plain'], false],
  [[], false]
]

const PATH_CASES: readonly (readonly [
  readonly NativeFileDropPathEntry[],
  NativeDropResolution | null
])[] = [
  [
    [{ nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.projectSidebar }],
    { target: NATIVE_FILE_DROP_TARGET.projectSidebar }
  ],
  [
    [
      { terminalPaneLeafId: 'leaf-1' },
      { nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.terminal, terminalTabId: 'tab-1' }
    ],
    { target: NATIVE_FILE_DROP_TARGET.terminal, tabId: 'tab-1', paneLeafId: 'leaf-1' }
  ],
  [
    [
      { nativeFileDropDir: '/repo/src' },
      {
        nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.fileExplorer,
        nativeFileDropDir: '/repo'
      }
    ],
    { target: NATIVE_FILE_DROP_TARGET.fileExplorer, destinationDir: '/repo/src' }
  ],
  [[{ nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.fileExplorer }], { target: 'rejected' }],
  [[{ nativeFileDropDir: '/repo' }], null]
]

afterEach(() => setOrcaDispatchBinding(null))

describe('hasNativeFileDragTypes', () => {
  it('accepts native OS file drags and rejects internal moves in both seam states', () => {
    const { bound, unbound } = inBothSeamStates(() =>
      DRAG_TYPE_CASES.map(([types]) => hasNativeFileDragTypes(types))
    )

    expect(unbound).toEqual(DRAG_TYPE_CASES.map(([, expected]) => expected))
    expect(bound).toEqual(unbound)
  })

  it('reads a DataTransfer-style list rather than only a plain array', () => {
    bindWasmSeam()
    expect(hasNativeFileDragTypes(new Set(['Files']))).toBe(true)
    expect(hasNativeFileDragTypes(null)).toBe(false)
  })
})

describe('resolveNativeFileDropPath', () => {
  it('routes every surface identically in both seam states', () => {
    const { bound, unbound } = inBothSeamStates(() =>
      PATH_CASES.map(([path]) => resolveNativeFileDropPath(path))
    )

    expect(unbound).toEqual(PATH_CASES.map(([, expected]) => expected))
    expect(bound).toEqual(unbound)
  })

  it('keeps the pane leaf id the Rust core does not carry', () => {
    // Why this matters: without paneLeafId the drop falls back to the ACTIVE
    // pane, so a file dropped on one split pastes into another.
    bindWasmSeam()
    expect(
      resolveNativeFileDropPath([
        { terminalPaneLeafId: 'leaf-2' },
        { nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.terminal }
      ])
    ).toEqual({ target: NATIVE_FILE_DROP_TARGET.terminal, paneLeafId: 'leaf-2' })
  })

  it('routes a codec-refused path instead of throwing inside the drop listener', () => {
    // A Windows filename can hold an unpaired UTF-16 surrogate, which the codec
    // refuses (JSON.stringify emits it as text serde cannot read as UTF-8). The
    // deleted twin routed it without crossing, and so does this.
    bindWasmSeam()
    expect(
      resolveNativeFileDropPath([
        { nativeFileDropDir: '/repo/\ud800' },
        { nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.fileExplorer }
      ])
    ).toEqual({
      target: NATIVE_FILE_DROP_TARGET.fileExplorer,
      destinationDir: '/repo/\ud800'
    })
  })

  it('encodes an absent dataset attribute as absent, not as a rejected undefined', () => {
    // Preload builds every entry from `element.dataset.*`, so most keys arrive
    // explicitly undefined; the codec rejects those unless the shim opts in.
    bindWasmSeam()
    expect(
      resolveNativeFileDropPath([
        {
          nativeFileDropTarget: undefined,
          nativeFileDropDir: undefined,
          terminalTabId: undefined,
          terminalPaneLeafId: undefined
        },
        { nativeFileDropTarget: NATIVE_FILE_DROP_TARGET.composer }
      ])
    ).toEqual({ target: NATIVE_FILE_DROP_TARGET.composer })
  })
})
