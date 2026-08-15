// Logic moved to the Rust `orca_core::terminal_surface_id` core: the renderer
// reaches it through src/renderer/src/lib/git-wasm/terminal-surface-id.ts (and
// src/renderer/src/runtime/web-terminal-surface-id.ts re-exports that). Only the
// two id constants stay in TS — the wasm shim's pre-ready fallback and the
// tree-agnostic src/shared/terminal-tab-id.ts both compose from them.
export const WEB_TERMINAL_SURFACE_TAB_PREFIX = 'web-terminal-'
export const HOST_TERMINAL_SURFACE_SEPARATOR = '::'
