import { logRendererStartupDiagnostic } from '@/startup/startup-diagnostics'
import type { AtermPaneBuildQueueTrace } from './aterm-pane-build-queue'

// Time-to-first-usable-terminal was unmeasured: every startup milestone ends at
// workspace-ready, but the aterm engine cold boot lands AFTER it. This fire-once
// marker ('renderer-first-terminal-frame' on the shared startup-diagnostics
// channel) makes that phase visible to the startup bench.
let fired = false

/** The pane that presented the first frame, as it identifies itself. `laneId` is
 *  the terminal tab id (one PaneManager per tab); `paneId` is that tab's leaf. */
export type TerminalPaneBootFrameOrigin = {
  laneId: string
  paneId: string
  /** What this pane's engine build waited for; absent if it never built. */
  queue?: AtermPaneBuildQueueTrace
}

/** Who is reporting a boot phase. Tab-scoped phases omit `paneId` because no pane
 *  object exists when they fire; the two PTY phases carry it and are pane-exact. */
export type TerminalPaneBootLane = {
  laneId: string
  paneId?: string
}

/** Stamp the first presented terminal frame. Fire-once and cheap: a boolean
 *  check on every later frame. Worker-path panes stamp at the draw post — the
 *  worker presents within the same frame budget.
 *
 *  `getOrigin` is a GETTER, invoked only on the one frame this fires, so the
 *  paint path pays nothing per frame. It also RESOLVES the pane-boot lane (see
 *  markTerminalPaneBootPhase): the pane that painted defines whose timeline the
 *  bench reads. */
export function markFirstAtermTerminalFramePresented(
  getOrigin?: () => TerminalPaneBootFrameOrigin | null
): void {
  if (fired) {
    return
  }
  fired = true
  logRendererStartupDiagnostic('first-terminal-frame')
  // Off the paint path: this runs INSIDE doPresent, and the frame it stamps is
  // the one being measured — flushing ~8 IPC sends here would perturb it. The
  // microtask still lands well inside the bench's linger window.
  queueMicrotask(() => {
    resolvePaneBootLaneFromFrame(getOrigin)
  })
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

/** The booting pane's own stages — the other half of the opaque
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

type BufferedBootPhase = {
  phase: TerminalPaneBootPhase
  paneId?: string
  rendererT: number
}

// A restore mounts every tab, so the buffer is bounded against a pathological
// session rather than sized for the common one; it is cleared at resolution.
const MAX_BUFFERED_LANES = 16
const MAX_BUFFERED_PHASES_PER_LANE = 32

const bufferedLanes = new Map<string, Map<string, BufferedBootPhase>>()
const firedPaneBootPhases = new Set<TerminalPaneBootPhase>()
let laneResolved = false
let resolvedLaneId: string | null = null
let resolvedPaneId: string | null = null

function rendererNowMs(): number {
  // Match the channel's own clock exactly, so a flushed phase is
  // indistinguishable from one that had been emitted where it happened.
  return Math.round(performance.now())
}

/** Stamp one pane-boot stage ('renderer-pane-<phase>').
 *
 *  RECORD, THEN RESOLVE. Phases do not emit when they happen: they are buffered
 *  per lane and flushed — with their original timestamps — once the first frame
 *  names the pane that painted. Picking the lane up front cannot work. The old
 *  first-to-boot-start latch subtracted two different objects on any multi-tab
 *  restore, and picking the *visible* pane instead is not sound either: a pane
 *  can present while hidden (the context-loss rebuild wires a fresh scheduler
 *  that starts unsuspended, and an Activity-portal slot is unsuspended but
 *  invisible). Resolving from the frame makes "every phase describes the pane
 *  whose frame ended the timeline" true by construction, and makes the lane
 *  impossible to leave unclaimed while a frame is reported.
 *
 *  GRANULARITY, stated honestly: boot-start / layout-replayed /
 *  scrollback-restored / boot-settled / fit-measured are TAB-scoped — they fire
 *  before any pane object exists, so on a split tab they may describe work done
 *  for a sibling pane in the winning tab. The two PTY phases are pane-exact.
 *
 *  PII-free: the phase name and a clock. Lane ids are join keys held in memory
 *  and never emitted. */
export function markTerminalPaneBootPhase(
  phase: TerminalPaneBootPhase,
  lane: TerminalPaneBootLane
): void {
  try {
    if (!laneResolved) {
      bufferPaneBootPhase(phase, lane)
      return
    }
    if (lane.laneId !== resolvedLaneId) {
      return
    }
    // A sibling pane inside the winning tab is not the pane that painted.
    if (lane.paneId !== undefined && lane.paneId !== resolvedPaneId) {
      return
    }
    // 'pty-bound' legitimately lands after the first frame — the bench derives a
    // negative delta from it — so the resolved lane keeps emitting live.
    emitPaneBootPhase(phase, rendererNowMs())
  } catch {
    // 'pty-bound' sits on the PTY spawn/attach chokepoint: a host whose
    // startupDiagnostic isn't promise-returning must not break the bind.
  }
}

function bufferPaneBootPhase(phase: TerminalPaneBootPhase, lane: TerminalPaneBootLane): void {
  let phases = bufferedLanes.get(lane.laneId)
  if (phases === undefined) {
    if (bufferedLanes.size >= MAX_BUFFERED_LANES) {
      return
    }
    phases = new Map()
    bufferedLanes.set(lane.laneId, phases)
  }
  const key = `${phase}|${lane.paneId ?? ''}`
  if (!phases.has(key) && phases.size >= MAX_BUFFERED_PHASES_PER_LANE) {
    return
  }
  // Last write wins: a remount (StrictMode, re-restore) replaces the discarded
  // mount's stamp, so the surviving pane's own clock is the one flushed.
  phases.set(key, { phase, paneId: lane.paneId, rendererT: rendererNowMs() })
}

function emitPaneBootPhase(phase: TerminalPaneBootPhase, rendererT: number): void {
  if (firedPaneBootPhases.has(phase)) {
    return
  }
  firedPaneBootPhases.add(phase)
  logRendererStartupDiagnostic(`pane-${phase}`, { rendererT })
}

function resolvePaneBootLaneFromFrame(
  getOrigin?: () => TerminalPaneBootFrameOrigin | null
): void {
  try {
    const origin = getOrigin?.() ?? null
    laneResolved = true
    if (origin === null) {
      bufferedLanes.clear()
      // Tell "no lane" apart from "line lost": a frame with no attributable
      // pane means the phases below it are missing on purpose.
      logRendererStartupDiagnostic('pane-boot-lane-unresolved')
      return
    }
    resolvedLaneId = origin.laneId
    resolvedPaneId = origin.paneId
    if (origin.queue !== undefined) {
      // Emitted ONLY for the winning pane: the parser takes the first match by
      // name, so one event per build would silently resolve to the wrong pane.
      logRendererStartupDiagnostic('pane-build-queue', { ...origin.queue })
    }
    const phases = bufferedLanes.get(origin.laneId)
    bufferedLanes.clear()
    if (phases === undefined) {
      return
    }
    const winning = Array.from(phases.values())
      .filter((record) => record.paneId === undefined || record.paneId === origin.paneId)
      .sort((left, right) => left.rendererT - right.rendererT)
    for (const record of winning) {
      emitPaneBootPhase(record.phase, record.rendererT)
    }
  } catch {
    // Diagnostics are best-effort and must never perturb startup behavior.
  }
}
