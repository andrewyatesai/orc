import { logRendererStartupDiagnostic } from '@/startup/startup-diagnostics'

// Time-to-first-usable-terminal was unmeasured: every startup milestone ends at
// workspace-ready, but the aterm engine cold boot lands AFTER it. This fire-once
// marker ('renderer-first-terminal-frame' on the shared startup-diagnostics
// channel) makes that phase visible to the startup bench. On a cold restore the
// first presenting pane IS the restored one.
let fired = false

/** Stamp the first presented terminal frame. Fire-once and cheap: a boolean
 *  check on every later frame. Worker-path panes stamp at the draw post — the
 *  worker presents within the same frame budget. */
export function markFirstAtermTerminalFramePresented(): void {
  if (fired) {
    return
  }
  fired = true
  logRendererStartupDiagnostic('first-terminal-frame')
}
