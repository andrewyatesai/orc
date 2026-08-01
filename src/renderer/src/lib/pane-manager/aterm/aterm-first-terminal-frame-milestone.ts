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

/** The FIRST booting pane's own stages — the other half of the opaque
 *  worker-ready→first-frame tail, which the warm phases above cannot see because
 *  it is React mount + pane wiring, not engine boot. In the order the lifecycle
 *  reaches them, EXCEPT that 'fit-measured' and 'pty-connect-start' are both
 *  rAF-scheduled and either can land first — derive both from 'boot-settled',
 *  never from each other. */
export type TerminalPaneBootPhase =
  | 'boot-start'
  | 'layout-replayed'
  | 'scrollback-restored'
  | 'boot-settled'
  | 'fit-measured'
  | 'pty-connect-start'
  | 'pty-bound'

const firedPaneBootPhases = new Set<TerminalPaneBootPhase>()
let timedPaneId: string | null = null

/** Stamp one pane-boot stage ('renderer-pane-<phase>'). Latched to ONE pane: the
 *  first to reach 'boot-start' claims the lane and every later phase from any
 *  other pane is dropped. Per-phase latching alone was not enough — a multi-tab
 *  restore boots several panes concurrently, so the phases could interleave and
 *  describe different panes, producing a timeline that reads coherent but is
 *  arithmetic across two objects. PII-free (phase name only). */
export function markTerminalPaneBootPhase(phase: TerminalPaneBootPhase, paneId?: string): void {
  if (paneId !== undefined) {
    if (timedPaneId === null && phase === 'boot-start') {
      timedPaneId = paneId
    } else if (timedPaneId !== paneId) {
      return
    }
  }
  if (firedPaneBootPhases.has(phase)) {
    return
  }
  firedPaneBootPhases.add(phase)
  try {
    logRendererStartupDiagnostic(`pane-${phase}`)
  } catch {
    // 'pty-bound' sits on the PTY spawn/attach chokepoint: a host whose
    // startupDiagnostic isn't promise-returning must not break the bind.
  }
}
