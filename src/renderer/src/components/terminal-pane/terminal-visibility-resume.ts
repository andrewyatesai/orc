import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'
import {
  flushTerminalOutput,
  requestTerminalBacklogRecovery
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  resetAllTerminalWebglAtlases,
  resetAndRefreshAllTerminalWebglAtlases
} from '@/lib/pane-manager/pane-manager-registry'
import {
  beginSuppressScrollIntentWrites,
  endSuppressScrollIntentWrites,
  enforceTerminalCurrentScrollIntent,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'
import { resetTerminalLinkifierHoverState } from '@/lib/pane-manager/terminal-linkifier-hover-reset'
import { focusActivePane } from './pane-helpers'
import { scheduleTabRevealWebglAtlasRecovery } from './terminal-webgl-atlas-recovery'

// Re-anchor schedule after a resume: two rAFs + an 80ms backstop, matching
// restoreScrollStateAfterLayout / syncTerminalScrollIntentSoon, so the durable pin is
// re-applied once the cold-restore replay flood has settled. The write-freeze is held
// until the backstop fires.
const RESUME_REANCHOR_BACKSTOP_MS = 80

const VISIBLE_RESUME_FLUSH_CHARS = 256 * 1024
const WINDOW_WAKE_FLUSH_CHARS = 64 * 1024

export type TerminalHiddenReason = 'surface' | 'tab'

type ResumeTerminalVisibilityArgs = {
  manager: PaneManager
  isActive: boolean
  wasVisible: boolean
  shouldUseLightTabResume: boolean
  captureViewportPositions: (useRememberedSnapshots: boolean) => Map<number, ScrollState>
  /** Optional caller-supplied freeze. The fork owns a depth-counted module-level
   *  intent-write freeze instead, so this is only honored (and composed) when a
   *  legacy caller still passes it. */
  withSuppressedScrollTracking?: (callback: () => void) => void
}

/** Deferred half of a heavy reveal: the backlog drain and cross-manager present
 *  the caller runs AFTER the reveal frame paints. `run` takes the live manager
 *  because lifecycle effects can replace it between layout and this pass. */
export type TerminalVisibilityPostPaintRecovery = {
  run: (manager: PaneManager) => void
}

type HideTerminalVisibilityArgs = {
  manager: PaneManager
  wasVisible: boolean
  wasWorktreeActive: boolean
  isWorktreeActive: boolean
  hasCompletedVisibleResume: boolean
  captureViewportPositions: (useRememberedSnapshots: boolean) => Map<number, ScrollState>
}

type HideTerminalVisibilityResult = {
  hiddenReason: TerminalHiddenReason | null
  renderingSuspended: boolean
}

type RecoverVisibleTerminalWindowWakeArgs = {
  manager: PaneManager
  isActive: boolean
  clearGlyphAtlases: boolean
}

export function resumeTerminalVisibility({
  manager,
  isActive,
  wasVisible,
  shouldUseLightTabResume,
  captureViewportPositions,
  withSuppressedScrollTracking
}: ResumeTerminalVisibilityArgs): TerminalVisibilityPostPaintRecovery | null {
  // Why: the link input short-circuits same-cell mousemoves, and hidden panes
  // keep ingesting output; without this reset a link stays dead/stale when the
  // pointer returns to the same cell on reveal (upstream #9061).
  for (const pane of manager.getPanes()) {
    resetTerminalLinkifierHoverState(pane.terminal)
  }
  // Latch intent BEFORE the freeze/resume/fit: those can move the viewport and
  // would otherwise re-latch a pinned viewport as followOutput.
  syncTerminalViewportIntents(manager)
  // Why: WebGL resume can disturb xterm's viewport bookkeeping before the
  // post-resume fit runs. Capture numeric viewport positions first; the
  // restore path avoids content matching so duplicate agent log lines do
  // not jump to the wrong history entry.
  captureViewportPositions(!wasVisible)
  // FREEZE intent writes across the WHOLE resume window — the synchronous flush/fit/
  // enforce AND the async cold-restore replay flood that follows. The replay clears
  // and regrows the buffer; without the freeze a transient empty/regrowing buffer (and
  // the syncTerminalScrollIntentSoon timers landing mid-replay) overwrite the durable
  // ABSOLUTE pin with a position relative to the rebuilt bottom, so the restore lands
  // on the wrong content (the worktree-switch scroll-jump). enforce* still SCROLLS
  // while frozen, so the pin is re-anchored, not lost. Released on a bounded backstop
  // (and via finally) so a throw can never strand the freeze on.
  beginSuppressScrollIntentWrites()
  let released = false
  const release = (): void => {
    if (!released) {
      released = true
      endSuppressScrollIntentWrites()
    }
  }
  try {
    if (shouldUseLightTabResume) {
      // Why: intra-worktree tab switches only toggle the overlay. Still request
      // hidden-output recovery: agent TUIs can suppress hidden bytes until the
      // pane is foregrounded.
      requestLightTabBacklogRecovery(manager)
      // Why: reveal recovery must be immediate, not the terminal-output debounce
      // — a background agent streaming in another pane must not defer this tab's
      // atlas rebuild.
      scheduleTabRevealWebglAtlasRecovery()
      if (isActive) {
        focusActivePane(manager)
      }
    } else {
      resumeTerminalVisibilityBeforePaint(manager, isActive)
    }
    enforceTerminalViewportIntents(manager)
  } finally {
    // Re-anchor the durable absolute pin AFTER the replay flood settles (two rAFs +
    // an 80ms backstop), THEN release the write-freeze. Scheduled from `finally` so a
    // throw in the resume body still releases the freeze on the backstop. rAF is
    // guarded (absent in headless/test environments) and falls back to a timer; the
    // 80ms setTimeout backstop ALWAYS fires, so the freeze is guaranteed released.
    const raf = (cb: () => void): void => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(cb)
      } else {
        setTimeout(cb, 0)
      }
    }
    const reanchor = (): void => enforceTerminalViewportIntents(manager)
    raf(() => {
      reanchor()
      raf(reanchor)
    })
    setTimeout(() => {
      reanchor()
      release()
    }, RESUME_REANCHOR_BACKSTOP_MS)
  }
  if (shouldUseLightTabResume) {
    return null
  }
  return {
    run: (currentManager) => {
      // Why: lifecycle effects can swap the PaneManager between the reveal layout
      // pass and this post-paint pass, so the drain/present must be re-aimed at
      // the live manager — the pre-paint pass only reached the old one.
      withScrollIntentWritesFrozen(withSuppressedScrollTracking, () => {
        drainVisibleTerminalBacklog(currentManager)
        enforceTerminalViewportIntents(currentManager)
        // Why: the cross-manager re-present touches every live pane, so it stays
        // out of the reveal's pre-paint critical path.
        resetAllTerminalWebglAtlases()
      })
    }
  }
}

export function hideTerminalVisibility({
  manager,
  wasVisible,
  wasWorktreeActive,
  isWorktreeActive,
  hasCompletedVisibleResume,
  captureViewportPositions
}: HideTerminalVisibilityArgs): HideTerminalVisibilityResult {
  const surfaceBecameHidden = wasWorktreeActive && !isWorktreeActive
  if (wasVisible) {
    // Why: hidden DOM/layout churn can mutate the viewport before the pane
    // becomes visible again. Preserve the last visible position.
    captureViewportPositions(false)
  }
  if (!isWorktreeActive && (wasVisible || surfaceBecameHidden)) {
    // Pause draw scheduling while hidden: engines keep ingesting PTY bytes
    // but paint no frames (and hold no GPU work) until resumed.
    manager.suspendRendering()
    return { hiddenReason: 'surface', renderingSuspended: true }
  }
  if (!hasCompletedVisibleResume && wasVisible && wasWorktreeActive && isWorktreeActive) {
    // Why: the visibility hook starts wasVisible=true so terminal tabs that
    // first mount hidden still stop painting instead of drawing offscreen.
    manager.suspendRendering()
    return { hiddenReason: 'tab', renderingSuspended: true }
  }
  if (wasVisible && isWorktreeActive) {
    return { hiddenReason: 'tab', renderingSuspended: false }
  }
  if (!isWorktreeActive) {
    return { hiddenReason: 'surface', renderingSuspended: false }
  }
  return { hiddenReason: null, renderingSuspended: false }
}

export function recoverVisibleTerminalWindowWake({
  manager,
  isActive,
  clearGlyphAtlases
}: RecoverVisibleTerminalWindowWakeArgs): void {
  // Why: macOS screensaver/display wake can leave the pane visible but with a
  // stale renderer/input surface; Orca's own hidden-state resume never runs.
  // Order: latch intent -> resume drawing -> fit metrics -> drain -> enforce.
  // Intent must be latched before resume/fit (they can move the viewport and
  // would re-latch a pin as followOutput), and the fit must precede the flush so
  // recovered backlog lands on the settled grid rather than the pre-fit one.
  syncTerminalViewportIntents(manager)
  manager.resumeRendering()
  // Why: the wobble-resistant reveal fit — a sync fitAllPanes on a mid-transition
  // container reflows the grid and garbles diff-painting inline TUIs.
  manager.fitAllRevealedPanes()
  for (const pane of manager.getPanes()) {
    // Why: window blur fires mouseleave which clears the current link but not
    // the hovered-cell cache, so on refocus/wake with a stationary pointer the
    // same-cell short-circuit leaves the link dead until a scroll. Reset here
    // to match the reveal path (upstream #9659).
    resetTerminalLinkifierHoverState(pane.terminal)
    requestTerminalBacklogRecovery(pane.terminal)
    flushTerminalOutput(pane.terminal, { maxChars: WINDOW_WAKE_FLUSH_CHARS })
  }
  // Why no post-flush re-sync: flushTerminalOutput only submits the engine write and
  // returns before parse callbacks, so a same-tick re-sync would read pre-parse
  // geometry (possibly disturbed by resume/fit) and overwrite the pre-resume pin.
  // Enforce the pre-resume latched intent instead.
  if (isActive) {
    focusActivePane(manager)
  }
  enforceTerminalViewportIntents(manager)
  if (clearGlyphAtlases) {
    // Why: only a genuine display wake takes the heavy path — reset AND refresh
    // every pane's aterm grid, since a real wake can corrupt the GPU surface.
    // Plain refocus (alt-tab) is frequent and must not pay this cross-manager cost.
    resetAndRefreshAllTerminalWebglAtlases()
  } else {
    // Why: a plain refocus just re-presents the current aterm frame — the
    // atlas-preserving equivalent that avoids re-arming the heavy refresh churn.
    resetAllTerminalWebglAtlases()
  }
}

function requestLightTabBacklogRecovery(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    requestTerminalBacklogRecovery(pane.terminal)
  }
}

function resumeTerminalVisibilityBeforePaint(manager: PaneManager, isActive: boolean): void {
  // Resume draw scheduling before paint so the reveal frame shows the last-known
  // state (panes may have been suspended while hidden, or created suspended via
  // initialRenderingSuspended). The backlog drain is deferred to the post-paint
  // pass so a hidden pane's accumulated burst cannot beachball the reveal.
  manager.resumeRendering()
  // Why: reveal must not refit unconditionally — a sync fitAllPanes on a
  // mid-transition container applies a transient one-column-off grid and garbles
  // diff-painting inline TUIs. fitRevealedPane fits only on a real pixel change.
  manager.fitAllRevealedPanes()
  if (isActive) {
    focusActivePane(manager)
  }
}

function drainVisibleTerminalBacklog(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    requestTerminalBacklogRecovery(pane.terminal)
    flushTerminalOutput(pane.terminal, { maxChars: VISIBLE_RESUME_FLUSH_CHARS })
  }
}

/** Always take the fork's depth-counted intent-write freeze (it nests inside the
 *  resume-window freeze, which the backstop may already have released by the time
 *  the post-paint pass runs), composing the caller's legacy freeze around it when
 *  a legacy caller still supplies one. */
function withScrollIntentWritesFrozen(
  withSuppressedScrollTracking: ((callback: () => void) => void) | undefined,
  run: () => void
): void {
  const frozen = (): void => {
    beginSuppressScrollIntentWrites()
    try {
      run()
    } finally {
      endSuppressScrollIntentWrites()
    }
  }
  if (withSuppressedScrollTracking) {
    withSuppressedScrollTracking(frozen)
    return
  }
  frozen()
}

function enforceTerminalViewportIntents(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    enforceTerminalCurrentScrollIntent(pane.terminal)
  }
}

function syncTerminalViewportIntents(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    // Why: native scrollback trimming moves a pinned viewport content-stably.
    // Capture that live position before resume/fit can disturb it.
    syncTerminalScrollIntentFromViewport(pane.terminal)
  }
}
