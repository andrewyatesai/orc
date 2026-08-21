import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import type { AtermRainPulse } from '../../../../shared/aterm-rain-signal'
import { registerRendererMemoryProfileContributor } from '../renderer-memory-profile'
import type { PaneRenderingDiagnostics } from './pane-manager-types'

type RegisteredPaneManager = {
  resetWebglTextureAtlases?: () => void
  fitAllPanes?: () => void
  refreshAllPanes?: () => void
  getRenderingDiagnostics?: () => PaneRenderingDiagnostics[]
  getPanes?: (limit?: number) => { id: number; terminal: unknown }[]
  getPaneCount?: () => number
}

// Omit: the base getPanes (desync-sentinel shape) would otherwise win overload
// resolution in the intersection, breaking pane.leafId reads on the tab shape.
type TabPaneManager = Omit<RegisteredPaneManager, 'getPanes'> & {
  getPanes: () => {
    leafId: string
    /** The .pane element; window-level overlays (spill geometry) measure it. */
    container?: HTMLElement
    atermController?: {
      noteMatrixRainPulse?: (pulse: AtermRainPulse) => void
      /** Federated search reads each pane's engine-host seam through here. */
      federatedSearchTarget?: () => unknown
    } | null
  }[]
}

const liveManagers = new Set<RegisteredPaneManager>()
const managerIds = new WeakMap<RegisteredPaneManager, number>()
let nextManagerId = 1
// React can briefly overlap the old and replacement TerminalPane lifecycle for
// one durable tab. Retain both identities until their own cleanup runs so a
// hook pulse cannot disappear into whichever mount happened to register last.
const managersByTabId = new Map<string, Set<TabPaneManager>>()

type TabPaneManagerLifecycleObserver = {
  managerRegistered: (tabId: string) => void
}

let tabLifecycleObserver: TabPaneManagerLifecycleObserver | null = null

/** Install the single semantic-effects observer. Kept callback-shaped so this
 * registry stays independent of the aterm delivery module (no import cycle). */
export function setTabPaneManagerLifecycleObserver(
  observer: TabPaneManagerLifecycleObserver
): void {
  tabLifecycleObserver = observer
}

export function registerLivePaneManager(manager: RegisteredPaneManager): void {
  if (!managerIds.has(manager)) {
    managerIds.set(manager, nextManagerId++)
  }
  liveManagers.add(manager)
}

export function unregisterLivePaneManager(manager: RegisteredPaneManager): void {
  liveManagers.delete(manager)
}

/** Register the stable tab identity separately from the global repaint set.
 * PaneManager itself does not own a tab id; the TerminalPane lifecycle does. */
export function registerTabPaneManager(tabId: string, manager: TabPaneManager): void {
  let managers = managersByTabId.get(tabId)
  if (!managers) {
    managers = new Set()
    managersByTabId.set(tabId, managers)
  }
  managers.add(manager)
  try {
    tabLifecycleObserver?.managerRegistered(tabId)
  } catch {
    // Registration owns terminal lifecycle; a best-effort visual effect must
    // never prevent the manager from becoming reachable.
  }
}

export function unregisterTabPaneManager(tabId: string, manager: TabPaneManager): void {
  const managers = managersByTabId.get(tabId)
  managers?.delete(manager)
  if (managers?.size === 0) {
    managersByTabId.delete(tabId)
  }
}

export function getLivePaneManagersForTab(tabId: string): readonly TabPaneManager[] {
  return [...(managersByTabId.get(tabId) ?? [])]
}

/** Read-only snapshot of every tabId with a live pane manager. Window-level
 * overlays (the spill geometry tracker) enumerate ALL panes through this plus
 * getLivePaneManagersForTab; it grants no mutation access to the registry. */
export function getRegisteredTabPaneManagerTabIds(): readonly string[] {
  return [...managersByTabId.keys()]
}

/** Resolve the durable tab identity at the exact async controller-attach edge.
 * This bounded live-manager scan is cold-path only (once per controller build). */
export function getRegisteredTabIdsForController(
  leafId: string,
  controller: object
): readonly string[] {
  const tabIds: string[] = []
  for (const [tabId, managers] of managersByTabId) {
    let matched = false
    for (const manager of managers) {
      try {
        matched = manager
          .getPanes()
          .some((pane) => pane.leafId === leafId && (pane.atermController as object) === controller)
      } catch {
        // An overlapping manager may already be tearing down; inspect siblings.
      }
      if (matched) {
        tabIds.push(tabId)
        break
      }
    }
  }
  return tabIds
}

/** Force a fresh full repaint of every pane across all live managers. The aterm
 *  GPU drawer re-presents the engine grid each frame (no shared glyph atlas to
 *  invalidate), so this re-rasterizes the current frame — the honest aterm
 *  equivalent of the old cross-manager xterm-WebGL atlas reset. */
export function resetAllTerminalWebglAtlases(): void {
  for (const manager of liveManagers) {
    try {
      manager.resetWebglTextureAtlases?.()
    } catch {
      // Why: best-effort during pane teardown; one disposed manager should not
      // prevent sibling terminals from repainting.
    }
  }
}

export function resetAndRefreshAllTerminalWebglAtlases(): void {
  // Why: the atlas wipe is the heavy recovery path; recording it lets a freeze
  // report show whether a post-wake repaint actually ran. Silent breadcrumb.
  recordTerminalWebglDiagnostic('webgl-atlas-reset', { managers: liveManagers.size })
  const resetManagers: RegisteredPaneManager[] = []
  for (const manager of liveManagers) {
    try {
      manager.resetWebglTextureAtlases?.()
      resetManagers.push(manager)
    } catch {
      // Why: recovery is best-effort during pane teardown; a disposed manager
      // should not block sibling terminals from rebuilding and repainting.
    }
  }
  for (const manager of resetManagers) {
    try {
      manager.refreshAllPanes?.()
    } catch {
      // Why: a pane can unmount between atlas reset and repaint; later
      // managers still need to repaint from their xterm buffers.
    }
  }
}

/** Repaint every live pane from its current buffer WITHOUT the heavy
 *  re-rasterize reset. Used while the rate-cap suppresses a full atlas recovery:
 *  the live grid still presents, but the cross-manager scheduleDraw storm is
 *  skipped so a sustained stream can't churn every pane each settle. */
export function presentAllTerminalPanesWithoutAtlasClear(): void {
  for (const manager of liveManagers) {
    try {
      manager.refreshAllPanes?.()
    } catch {
      // A disposing manager must not block sibling panes from presenting.
    }
  }
}

/**
 * Per-pane WebGL renderer state across all live managers, for the one-paste
 * freeze report. Lets a post-wake garble report show, per pane, whether it
 * held a live WebGL addon or had fallen back after a context loss — the state
 * that distinguishes "missed repaint" from "atlas corrupted".
 */
export function getAllPaneRenderingDiagnostics(): PaneRenderingDiagnostics[] {
  const all: PaneRenderingDiagnostics[] = []
  for (const manager of liveManagers) {
    try {
      const diagnostics = manager.getRenderingDiagnostics?.()
      if (diagnostics) {
        all.push(...diagnostics)
      }
    } catch {
      // Why: best-effort during teardown; one manager must not sink the report.
    }
  }
  return all
}

/**
 * Live pane census: managers (≈ terminal tabs) and the panes they hold.
 *
 * Why: this is the population number crash reports have been inferring from
 * breadcrumb multiplicity, which never worked — `pane.id` restarts at 1 per
 * manager, so N panes and one looping pane are indistinguishable in the ring.
 * Measure it instead.
 */
export function getLivePaneCensus(): { managers: number; panes: number } {
  let panes = 0
  for (const manager of liveManagers) {
    try {
      panes += manager.getPaneCount?.() ?? manager.getPanes?.().length ?? 0
    } catch {
      // Why: a manager mid-teardown must not sink the count for the rest.
    }
  }
  return { managers: liveManagers.size, panes }
}

/**
 * Iterates every live pane for the render-desync sentinel. Weakly-held manager
 * ids stay stable when an earlier manager unregisters without retaining it.
 */
export function forEachLivePaneForDesyncSentinel(
  visit: (paneKey: string, pane: { id: number; terminal: unknown }) => void
): void {
  for (const manager of liveManagers) {
    const managerId = managerIds.get(manager)
    if (managerId == null) {
      continue
    }
    let panes: { id: number; terminal: unknown }[] = []
    try {
      panes = manager.getPanes?.() ?? []
    } catch {
      continue
    }
    for (const pane of panes) {
      try {
        visit(`m${managerId}:p${pane.id}`, pane)
      } catch {
        // Why: one pane's failure must not stop sentinel coverage of the rest.
      }
    }
  }
}

export function refitAndRefreshAllTerminalPanes(): void {
  for (const manager of liveManagers) {
    try {
      // Why: after bulk desktop restore, background panes may have correct
      // cols/rows but a stale xterm renderer until focus forces a repaint.
      manager.fitAllPanes?.()
      manager.refreshAllPanes?.()
    } catch {
      // Why: restore-all is best-effort across live managers during teardown.
    }
  }
}

// Rough aterm grid-cell cost (packed cell + object overhead); ranking matters,
// not accuracy.
const BYTES_PER_TERMINAL_CELL = 16
const BYTES_PER_KILOBYTE = 1024
const MANAGER_SAMPLE_LIMIT = 64
const PANE_SAMPLE_LIMIT = 256

type BufferedTerminal = {
  cols?: number
  buffer?: { active?: { length?: number } }
}

/**
 * Memory-profile census over live pane managers. Mounted panes are the
 * dominant highwater cost the store census can't see (97b9e86d: heap ~1.3GB
 * while all store slices summed to ~15MB) — eviction-exempt panes accumulate
 * mounted forever, each retaining rows x cols of scrollback.
 */
export function getLivePaneMemoryProfileCounts(): Record<string, number> {
  let sampledManagers = 0
  let paneCount = 0
  let sampledPanes = 0
  let sampledBufferBytes = 0
  for (const manager of liveManagers) {
    if (sampledManagers >= MANAGER_SAMPLE_LIMIT) {
      break
    }
    sampledManagers += 1
    const remainingPaneSamples = Math.max(0, PANE_SAMPLE_LIMIT - sampledPanes)
    let managerPanes: { id: number; terminal: unknown }[] = []
    try {
      if (remainingPaneSamples > 0) {
        managerPanes = manager.getPanes?.(remainingPaneSamples) ?? []
      }
    } catch {
      managerPanes = []
    }
    let managerPaneCount: number | undefined
    try {
      managerPaneCount = manager.getPaneCount?.()
    } catch {
      managerPaneCount = undefined
    }
    paneCount +=
      typeof managerPaneCount === 'number' && Number.isFinite(managerPaneCount)
        ? Math.max(0, managerPaneCount)
        : managerPanes.length
    const panesToInspect = Math.min(managerPanes.length, remainingPaneSamples)
    for (let index = 0; index < panesToInspect; index += 1) {
      const pane = managerPanes[index]
      const terminal = pane.terminal as BufferedTerminal | null | undefined
      const rows = terminal?.buffer?.active?.length
      const cols = terminal?.cols
      if (
        typeof rows === 'number' &&
        Number.isFinite(rows) &&
        rows > 0 &&
        typeof cols === 'number' &&
        Number.isFinite(cols) &&
        cols > 0
      ) {
        sampledBufferBytes += rows * cols * BYTES_PER_TERMINAL_CELL
      }
    }
    sampledPanes += panesToInspect
  }
  const managerScale = sampledManagers === 0 ? 0 : liveManagers.size / sampledManagers
  const estPanes = Math.round(paneCount * managerScale)
  const paneScale = sampledPanes === 0 ? 0 : estPanes / sampledPanes
  return {
    managers: liveManagers.size,
    estPanes,
    estBufferKB: Math.round((sampledBufferBytes * paneScale) / BYTES_PER_KILOBYTE)
  }
}

// Why here: contributors push in (crash-diagnostics stays a leaf); same-name
// re-registration on dev HMR overwrites, so no disposal hook is needed.
registerRendererMemoryProfileContributor('terminals', getLivePaneMemoryProfileCounts)
