// Why: the implementation moved to src/shared so the main process can reuse it for
// orchestration banners, which are written into a live PTY. Re-exported here so CLI
// formatters keep their existing import path and the two layers cannot drift.
export {
  escapeUntrustedTerminalText,
  sanitizeUntrustedTerminalText
} from '../shared/terminal-safe-text'
