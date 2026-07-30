import { acquireAtermSharedWorkerPane } from './aterm-shared-render-worker'
import { loadAterm } from './load-aterm'
import { markAtermWarmPhase } from './aterm-first-terminal-frame-milestone'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import { e2eConfig } from '@/lib/e2e-config'

// Idle-time prewarm of the SHARED render worker so the FIRST pane of a session
// opens hot instead of paying the documented multi-second cold boot (wasm
// compile + font fetch/IPC + worker spawn — see aterm-worker-loader's
// 4s-boot/15s-first-frame window). Acquiring a slot runs the whole warm path:
// loadAterm (main-thread wasm compile + primary font fetch), the OS fallback
// font IPC, worker spawn/script parse, and the resident-fonts post.
//
// The manager's steady-state policy is memory-over-warmth (terminate on last
// release); prewarm deliberately trades a BOUNDED hold window against it: the
// hold releases the moment a real pane owns the worker, or after HOLD_MS if no
// terminal ever opens. The renderer-side font/wasm caches persist either way,
// so even an expired prewarm leaves the next open warm.
const PREWARM_HOLD_MS = 90_000
// Wait out startup crunch + a quiet input window before spending idle time.
const PREWARM_IDLE_DELAY_MS = 1500
const PREWARM_IDLE_QUIET_MS = 750
const PREWARM_IDLE_TIMEOUT_MS = 8000

export type AtermWorkerPrewarmHold = { release: () => void }

export type AtermWorkerPrewarmDeps = {
  acquire: () => Promise<AtermWorkerPrewarmHold>
  /** The main-thread half of the warm (wasm compile + primary font fetch), run
   *  BEFORE acquire so each half gets its own milestone. Free: acquire's own
   *  font load awaits the very same cached promise. */
  loadEngineAssets: () => Promise<unknown>
  /** Schedule the idle prewarm attempt; returns a canceller. */
  schedule: (run: () => void) => () => void
  holdMs: number
}

export type AtermWorkerPrewarm = {
  arm: () => void
  /** Warm NOW, skipping the idle delay — for a restore that is known to mount
   *  panes imminently (the idle prewarm always loses that race). */
  warmNow: () => void
  notePaneAcquired: () => void
}

/** Factory (deps injected) so unit tests can drive the lifecycle with fakes;
 *  production uses the module-level singleton below. */
export function createAtermWorkerPrewarm(deps: AtermWorkerPrewarmDeps): AtermWorkerPrewarm {
  let armed = false
  let warmStarted = false
  let paneSeen = false
  let hold: AtermWorkerPrewarmHold | null = null
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let cancelSchedule: (() => void) | null = null

  const releaseHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    hold?.release()
    hold = null
  }

  // ONE warm per prewarm (idle-scheduled or immediate): a second acquire would
  // overwrite `hold` and leak the first slot, keeping the worker alive forever.
  const startWarm = (): void => {
    if (paneSeen || warmStarted) {
      return
    }
    warmStarted = true
    markAtermWarmPhase('warm-start')
    deps
      .loadEngineAssets()
      .then(() => {
        markAtermWarmPhase('wasm-ready')
        return deps.acquire()
      })
      .then((pane) => {
        // Stamped before the race check: the worker IS warm either way, and the
        // real-pane branch below is exactly the case worth timing.
        markAtermWarmPhase('worker-ready')
        if (paneSeen) {
          // A real pane raced ahead and owns the worker now — the warm-up
          // already happened; drop the redundant slot immediately.
          pane.release()
          return
        }
        hold = pane
        holdTimer = setTimeout(releaseHold, deps.holdMs)
      })
      .catch(() => {
        // Best-effort: a prewarm failure is invisible; the first real pane
        // open runs the same path and surfaces any real error itself.
      })
  }

  return {
    arm: (): void => {
      if (armed) {
        return
      }
      armed = true
      cancelSchedule = deps.schedule(() => {
        cancelSchedule = null
        startWarm()
      })
    },
    warmNow: (): void => {
      // A still-pending idle attempt would fire into startWarm's no-op; drop it.
      cancelSchedule?.()
      cancelSchedule = null
      startWarm()
    },
    notePaneAcquired: (): void => {
      paneSeen = true
      cancelSchedule?.()
      cancelSchedule = null
      // Safe order: the caller's slot is already registered, so releasing the
      // hold can never drop the worker's pane count to zero here.
      releaseHold()
    }
  }
}

const productionPrewarm = createAtermWorkerPrewarm({
  acquire: acquireAtermSharedWorkerPane,
  loadEngineAssets: loadAterm,
  schedule: (run) =>
    scheduleAfterInputQuiet(run, {
      delayMs: PREWARM_IDLE_DELAY_MS,
      quietMs: PREWARM_IDLE_QUIET_MS,
      idleTimeoutMs: PREWARM_IDLE_TIMEOUT_MS
    }),
  holdMs: PREWARM_HOLD_MS
})

/** Called by the worker loader's boot path when a REAL pane acquires a slot:
 *  releases the prewarm hold (the real pane keeps the worker alive) and stops
 *  any future prewarm — demand now owns the worker lifecycle. */
export function noteRealAtermWorkerPaneAcquired(): void {
  productionPrewarm.notePaneAcquired()
}

export type AtermPrewarmEnvironment = {
  hasWindow: boolean
  hasWorker: boolean
  mode: string | undefined
  e2eExposeStore: boolean
}

/** Skipped under unit tests and e2e (exposeStore): specs assert on lazy worker
 *  creation/termination and must not see a background worker they didn't open.
 *  Pure so the skip decision is testable despite MODE always being 'test' here. */
export function shouldSkipAtermEnginePrewarm(env: AtermPrewarmEnvironment): boolean {
  return !env.hasWindow || !env.hasWorker || env.mode === 'test' || env.e2eExposeStore
}

const prewarmSkipped = shouldSkipAtermEnginePrewarm({
  hasWindow: typeof window !== 'undefined',
  hasWorker: typeof Worker !== 'undefined',
  mode: import.meta.env?.MODE,
  e2eExposeStore: e2eConfig.exposeStore
})

// Self-arm with the renderer bundle (this module loads via the static pane-open
// import chain, long before any pane exists).
if (!prewarmSkipped) {
  productionPrewarm.arm()
}

/** Session-restore warm: a LOCAL restored terminal pane is known to be imminent,
 *  so run the whole warm path NOW (acquire = loadAterm wasm compile + font fetch
 *  + worker spawn + resident-fonts post) instead of waiting out the idle delay a
 *  cold-restore pane always races ahead of. Same bounded hold + release-on-real-
 *  pane lifecycle as the idle prewarm, so memory-over-warmth still holds. */
export function warmAtermSharedWorkerForImminentPane(): void {
  if (prewarmSkipped) {
    return
  }
  productionPrewarm.warmNow()
}
