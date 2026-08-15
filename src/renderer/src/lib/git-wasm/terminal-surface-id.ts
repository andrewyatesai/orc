// Renderer web-terminal surface-id mapping, driven by the Rust
// `orca_core::terminal_surface_id` core (the shared TS twin is now constants
// only). Host session surfaces are addressed as `tab::leaf`, but renderer pane
// keys reserve `:`, so the host id travels percent-encoded behind the
// `web-terminal-` prefix.
//
// PRE-READY CONTRACT — all three are `parity`, not sentinels, and that is
// forced: these functions ARE the tab identity. `toWebTerminalSurfaceTabId`
// keys `tabsByWorktree`/`terminalLayoutsByTabId` and feeds `makePaneKey()`;
// `toHostSessionTabId` is compared against the host's live surface keys in
// `web-session-terminal-orphan-recovery.ts`, which REAPS the terminals that do
// not match. A null/'' sentinel there would mint a second identity for a live
// surface and kill it. So each fallback rebuilds the deleted TS verbatim from
// the kept constant plus the same JS builtin the twin used, which makes
// pre-ready equal ready for every input the ready core agrees with the twin on
// (see the one pinned exception in `terminal-surface-id-pre-ready.test.ts`).
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import { WEB_TERMINAL_SURFACE_TAB_PREFIX } from '../../../../shared/terminal-surface-id'

export function toWebTerminalSurfaceTabId(hostSurfaceId: string): string {
  // Why: identity — a sentinel here would key the store under a tab id no other
  // call site can reproduce, so the fallback re-encodes exactly as the twin did.
  if (!isGitWasmReady()) {
    return `${WEB_TERMINAL_SURFACE_TAB_PREFIX}${encodeURIComponent(hostSurfaceId)}`
  }
  return dispatchToWasmCore(
    'terminal-surface-id',
    'toWebTerminalSurfaceTabId',
    hostSurfaceId
  ) as string
}

export function toHostSessionTabId(tabId: string): string {
  // Why: identity — orphan recovery treats a non-matching host id as a dead
  // surface and reaps it, so the fallback is the twin's body verbatim (including
  // the catch that returns the WHOLE tabId, which the Rust core does not — the
  // pinned divergence).
  if (!isGitWasmReady()) {
    if (!tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)) {
      return tabId
    }
    try {
      return decodeURIComponent(tabId.slice(WEB_TERMINAL_SURFACE_TAB_PREFIX.length))
    } catch {
      return tabId
    }
  }
  return dispatchToWasmCore('terminal-surface-id', 'toHostSessionTabId', tabId) as string
}

export function isWebTerminalSurfaceTabId(tabId: string): boolean {
  // Why: `false` from a predicate is indistinguishable from a real answer, and
  // this one gates mirrored-tab publication — so the fallback is the prefix test
  // itself, over the constant the twin kept.
  if (!isGitWasmReady()) {
    return tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)
  }
  return dispatchToWasmCore('terminal-surface-id', 'isWebTerminalSurfaceTabId', tabId) as boolean
}
