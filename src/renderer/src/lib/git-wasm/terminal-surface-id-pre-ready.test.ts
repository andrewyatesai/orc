// Deliberately does NOT import './init-git-wasm-for-test' at the top: this file
// exists to observe the shim BEFORE the core is ready.
//
// These three functions are TAB IDENTITY, so the usual escape hatch is closed —
// there is no spare state. `web-session-terminal-orphan-recovery.ts` builds
// `${toHostSessionTabId(tab.id)}\0${leafId}` and REAPS every local surface whose
// key is absent from the host's live set, and `toWebTerminalSurfaceTabId` keys
// `tabsByWorktree`/`terminalLayoutsByTabId` and feeds `makePaneKey()`. A `null`,
// `''` or `false` sentinel would therefore either kill live terminals or fork the
// store under a second id for the same surface. So the contract here is `parity`:
// the fallback rebuilds the deleted TS verbatim from the kept constant.
import { describe, expect, it } from 'vitest'
import { getGitWasmAvailability } from './git-wasm-availability'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from './terminal-surface-id'
import { WEB_TERMINAL_SURFACE_TAB_PREFIX } from '../../../../shared/terminal-surface-id'

const HOST_SURFACE = 'host-tab-1::leaf-9'
const WRAPPED = 'web-terminal-host-tab-1%3A%3Aleaf-9'

describe('terminal-surface-id pre-ready value', () => {
  it('answers exactly as the deleted TS did while the core is pending', () => {
    expect(getGitWasmAvailability()).toBe('pending')

    // The sentinels that are NOT available here, pinned by name: each one is a
    // second identity for a live surface.
    expect(toWebTerminalSurfaceTabId(HOST_SURFACE)).toBe(WRAPPED)
    expect(toWebTerminalSurfaceTabId(HOST_SURFACE)).not.toBeNull()
    expect(toWebTerminalSurfaceTabId(HOST_SURFACE)).not.toBe('')
    expect(toWebTerminalSurfaceTabId(HOST_SURFACE)).not.toBe(WEB_TERMINAL_SURFACE_TAB_PREFIX)

    expect(toHostSessionTabId(WRAPPED)).toBe(HOST_SURFACE)
    expect(toHostSessionTabId('plain-tab')).toBe('plain-tab')
    expect(toHostSessionTabId('host-tab::leaf')).toBe('host-tab::leaf')

    expect(isWebTerminalSurfaceTabId(WRAPPED)).toBe(true)
    expect(isWebTerminalSurfaceTabId('host-tab::leaf')).toBe(false)

    // The `::` separator must never survive raw into a pane key.
    expect(toWebTerminalSurfaceTabId(HOST_SURFACE).slice(WEB_TERMINAL_SURFACE_TAB_PREFIX.length))
      .not.toContain(':')

    // The twin's catch: a prefixed id with a malformed escape came back WHOLE.
    expect(toHostSessionTabId('web-terminal-%zz')).toBe('web-terminal-%zz')
    expect(toHostSessionTabId('web-terminal-trailing%2')).toBe('web-terminal-trailing%2')
  })

  it('matches the ready core input-for-input once the wasm lands', async () => {
    await import('./init-git-wasm-for-test')
    expect(getGitWasmAvailability()).toBe('ready')

    expect(toWebTerminalSurfaceTabId(HOST_SURFACE)).toBe(WRAPPED)
    expect(toWebTerminalSurfaceTabId('host-tab-1::/repo/path leaf')).toBe(
      'web-terminal-host-tab-1%3A%3A%2Frepo%2Fpath%20leaf'
    )
    expect(toHostSessionTabId(toWebTerminalSurfaceTabId(HOST_SURFACE))).toBe(HOST_SURFACE)
    expect(toHostSessionTabId('plain-tab')).toBe('plain-tab')
    expect(toHostSessionTabId('host-tab::leaf')).toBe('host-tab::leaf')
    expect(isWebTerminalSurfaceTabId(WRAPPED)).toBe(true)
    expect(isWebTerminalSurfaceTabId('host-tab::leaf')).toBe(false)

    // Round-trip over non-ASCII, which the twin's encodeURIComponent also handled.
    expect(toHostSessionTabId(toWebTerminalSurfaceTabId('café::leaf'))).toBe('café::leaf')

    // THE ONE PINNED DIVERGENCE (tools/parity/vectors/terminal-surface-id.json
    // carries it as `allowDivergence`): on a malformed escape the twin's catch
    // returned the WHOLE tabId, the Rust core returns the decoded slice. Only
    // reachable for a `web-terminal-` id that was not minted by
    // toWebTerminalSurfaceTabId, since encodeURIComponent output always decodes.
    expect(toHostSessionTabId('web-terminal-%zz')).toBe('%zz')
    expect(toHostSessionTabId('web-terminal-trailing%2')).toBe('trailing%2')
  })
})
