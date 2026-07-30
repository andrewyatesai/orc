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

/** The warm-path phases that precede the first frame, in the order the engine
 *  reaches them. They split the otherwise opaque workspace-ready→first-frame
 *  pool into: idle before the warm starts, main-thread wasm compile + primary
 *  font fetch, worker spawn + font handoff, then pane mount → present. */
export type AtermWarmPhase = 'warm-start' | 'wasm-ready' | 'worker-ready'

const firedWarmPhases = new Set<AtermWarmPhase>()

/** Stamp one warm phase ('renderer-aterm-<phase>'). Fire-once per phase and
 *  PII-free — the phase name only; the diagnostics channel adds the renderer
 *  clock and no-ops entirely unless startup diagnostics are enabled. */
export function markAtermWarmPhase(phase: AtermWarmPhase): void {
  if (firedWarmPhases.has(phase)) {
    return
  }
  firedWarmPhases.add(phase)
  logRendererStartupDiagnostic(`aterm-${phase}`)
}
