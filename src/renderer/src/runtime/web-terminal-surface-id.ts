// The renderer's single entry point for web-terminal surface ids: the three
// mappings now come from the git-wasm shim over the Rust core, the two id
// constants from the shared types/data twin.
export {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from '../../../shared/terminal-surface-id'
export {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '@/lib/git-wasm/terminal-surface-id'
