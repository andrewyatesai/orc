import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { terminalPtyParkSnapshotClass } from './terminal-park-snapshot-class'
import type { TerminalTab } from '../../../../shared/types'

// Why: re-export so the parking policy's callers keep one import surface; the
// class-resolver split only serves the max-lines budget.
export {
  isSnapshotBackedTerminalPty,
  terminalPtyParkSnapshotClass,
  type SnapshotBackedTerminalPtyOptions,
  type TerminalParkSnapshotClass
} from './terminal-park-snapshot-class'

// Why: cold-park hysteresis keeps a hidden pane mounted for 30s so quick tab
// flips never pay a re-hydrate; hot-retain keeps a bounded recently-visible
// working set warm for 15 minutes beyond that. The cap (not the clock) is the
// primary evictor — 8 worktrees covers the ordinary working set at ~4-5MB
// renderer floor each, so parking only engages for the many-worktree tail it
// was built for. Reveal cost is a flat ~170ms remount regardless of buffer
// size, so cutting remount *frequency* beats shaving replay.
export const TERMINAL_WORKTREE_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_WORKTREE_HOT_RETAIN_MS = 15 * 60_000
export const TERMINAL_WORKTREE_HOT_RETAIN_LIMIT = 8
export const TERMINAL_WORKTREE_PARK_DELAY_MS = TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
export const TERMINAL_TAB_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_TAB_HOT_RETAIN_MS = 15 * 60_000
export const TERMINAL_TAB_HOT_RETAIN_LIMIT = 12

// Why: tests override these per call (instead of process.env reads inside the
// module) to shrink the 30s hysteresis to test-friendly durations.
export type TerminalColdParkPolicyOverrides = {
  coldParkDelayMs?: number
  hotRetainMs?: number
  hotRetainLimit?: number
  retentionTtlMs?: number
  retentionLimit?: number
}

export type ColdParkableTerminalTab = Pick<TerminalTab, 'id' | 'ptyId' | 'pendingActivationSpawn'>

export type TerminalWorktreeColdParkCandidate = {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
  /** Post-measure cool-down: hiddenSince survives a measure window (TTL/rank
   *  clock stays honest), but re-park waits for this deadline — else every ~3s
   *  measure lease on a past-deadline worktree thrashes remount → re-park. */
  parkCooldownUntilMs?: number | null
}

export type TerminalTabColdParkCandidate = ColdParkableTerminalTab & {
  isVisible: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
}

function getPendingActivationSpawnCount(value: boolean | number | undefined): number {
  if (value === true) {
    return 1
  }
  return typeof value === 'number' && value > 0 ? value : 0
}

function hasPendingActivationSpawn(tab: ColdParkableTerminalTab): boolean {
  return (
    getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0 &&
    (!tab.ptyId || !isRemoteRuntimePtyId(tab.ptyId))
  )
}

export type TerminalParkRestorePolicy = {
  /** settings.terminalSshViewParking !== false — the C1 SSH-parking kill switch. */
  sshParkingEnabled?: boolean
  /** Exact paired environments whose host advertises bounded snapshot restore. */
  pairedRuntimeParkingEnvironmentIds?: ReadonlySet<string>
}

export function selectPairedRuntimeParkingEnvironmentIds(
  statuses: ReadonlyMap<string, { status: { capabilities?: readonly string[] } | null | undefined }>
): Set<string> {
  const capable = new Set<string>()
  for (const [environmentId, entry] of statuses) {
    if (entry.status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY)) {
      capable.add(environmentId)
    }
  }
  return capable
}

// Why: SSH uses local main's model; paired PTYs are eligible only when their
// exact host advertises authoritative bounded restore.
export function isParkRestorableTerminalPty(
  ptyId: string | null,
  worktreeId: string,
  policy?: TerminalParkRestorePolicy
): boolean {
  const snapshotClass = terminalPtyParkSnapshotClass(ptyId, worktreeId)
  if (snapshotClass === 'daemon') {
    return true
  }
  if (snapshotClass === 'remote-wire') {
    const environmentId = ptyId === null ? null : getRemoteRuntimePtyEnvironmentId(ptyId)
    return (
      environmentId !== null &&
      policy?.pairedRuntimeParkingEnvironmentIds?.has(environmentId) === true
    )
  }
  return snapshotClass === 'ssh-main-model' && policy?.sshParkingEnabled === true
}

// Why: two kill switches scope the same non-daemon classes (scoped remote-pane,
// C1 ssh/paired) and each is a veto — never a back-door around the other, or
// turning either off silently parks what the user just excluded.
function isParkEligibleTerminalPty(
  ptyId: string | null,
  worktreeId: string,
  args: { remoteParkingEnabled?: boolean; restorePolicy?: TerminalParkRestorePolicy }
): boolean {
  const snapshotClass = terminalPtyParkSnapshotClass(ptyId, worktreeId)
  if (snapshotClass === 'daemon') {
    return true
  }
  if (snapshotClass === null || args.remoteParkingEnabled === false) {
    return false
  }
  // Why: with no capability evidence to weigh, the scoped switch alone decides
  // the remote classes; a supplied policy always decides.
  return args.restorePolicy === undefined
    ? args.remoteParkingEnabled === true
    : isParkRestorableTerminalPty(ptyId, worktreeId, args.restorePolicy)
}

export function canParkTerminalWorktreeRenderers(args: {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  // Why: callers pass settings.terminalHiddenViewParking !== false — the
  // design-doc kill switch that disables parking entirely.
  parkingEnabled: boolean
  remoteParkingEnabled?: boolean
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
  parkCooldownUntilMs?: number | null
  nowMs: number
  coldParkDelayMs?: number
  restorePolicy?: TerminalParkRestorePolicy
}): boolean {
  if (
    !args.parkingEnabled ||
    args.isVisible ||
    args.shouldMeasureHiddenWorktree ||
    args.hasActivityTerminalPortal ||
    args.hiddenSinceMs === null ||
    (args.parkCooldownUntilMs != null && args.nowMs < args.parkCooldownUntilMs)
  ) {
    return false
  }
  if (
    args.nowMs - args.hiddenSinceMs <
    (args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS)
  ) {
    return false
  }
  return args.terminalTabs.every((tab) => {
    if (args.pendingStartupByTabId[tab.id] !== undefined) {
      return false
    }
    if (hasPendingActivationSpawn(tab)) {
      return false
    }
    return isParkEligibleTerminalPty(tab.ptyId, args.worktreeId, args)
  })
}

export function canParkTerminalTabRenderer(args: {
  worktreeId: string
  terminalTab: TerminalTabColdParkCandidate
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  parkingEnabled: boolean
  remoteParkingEnabled?: boolean
  nowMs: number
  coldParkDelayMs?: number
  /** Worktree-scoped post-measure cool-down (measure windows are per-worktree). */
  parkCooldownUntilMs?: number | null
  restorePolicy?: TerminalParkRestorePolicy
}): boolean {
  const tab = args.terminalTab
  if (
    !args.parkingEnabled ||
    tab.isVisible ||
    tab.hasActivityTerminalPortal ||
    tab.hiddenSinceMs === null ||
    (args.parkCooldownUntilMs != null && args.nowMs < args.parkCooldownUntilMs)
  ) {
    return false
  }
  if (args.nowMs - tab.hiddenSinceMs < (args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS)) {
    return false
  }
  if (args.pendingStartupByTabId[tab.id] !== undefined) {
    return false
  }
  if (hasPendingActivationSpawn(tab)) {
    return false
  }
  return isParkEligibleTerminalPty(tab.ptyId, args.worktreeId, args)
}

export type ColdParkRetainCandidate = { id: string; hiddenSinceMs: number }

// Why: the single most-recently-hidden candidate is the view the user just
// switched away from; keeping it warm regardless of the TTL or cap means
// switching back after any absence (a meeting, coffee) is always instant, the
// remount cost users actually notice. Ties break by id for determinism.
function selectLastActiveRetainedId(candidates: ColdParkRetainCandidate[]): string | null {
  let lastActive: ColdParkRetainCandidate | null = null
  for (const candidate of candidates) {
    if (
      lastActive === null ||
      candidate.hiddenSinceMs > lastActive.hiddenSinceMs ||
      (candidate.hiddenSinceMs === lastActive.hiddenSinceMs &&
        candidate.id.localeCompare(lastActive.id) < 0)
    ) {
      lastActive = candidate
    }
  }
  return lastActive?.id ?? null
}

// Why: hot-retain keeps the most recently hidden ids warm up to the limit;
// ids hidden past hotRetainMs or beyond the limit cold-park. The last-active
// id is exempt from both so returning to it never pays a remount. Ties sort by
// id so the selection is deterministic.
export function selectIdsBeyondHotRetain(
  candidates: ColdParkRetainCandidate[],
  args: { nowMs: number; hotRetainMs: number; hotRetainLimit: number }
): Set<string> {
  const lastActiveId = selectLastActiveRetainedId(candidates)
  const coldParkedIds = new Set<string>()
  const retainedCandidates: ColdParkRetainCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.id === lastActiveId) {
      continue
    }
    if (args.nowMs - candidate.hiddenSinceMs >= args.hotRetainMs) {
      coldParkedIds.add(candidate.id)
    } else {
      retainedCandidates.push(candidate)
    }
  }
  retainedCandidates.sort((a, b) => {
    const recencyDelta = b.hiddenSinceMs - a.hiddenSinceMs
    return recencyDelta === 0 ? a.id.localeCompare(b.id) : recencyDelta
  })
  // Why: the last-active id already holds one slot in the warm working set, so
  // the cap counts it out — the remaining candidates fill hotRetainLimit-1.
  const remainingLimit = lastActiveId === null ? args.hotRetainLimit : args.hotRetainLimit - 1
  for (const candidate of retainedCandidates.slice(Math.max(0, remainingLimit))) {
    coldParkedIds.add(candidate.id)
  }
  return coldParkedIds
}

export function selectColdParkedTerminalWorktrees(
  args: {
    worktrees: readonly TerminalWorktreeColdParkCandidate[]
    pendingStartupByTabId: Readonly<Record<string, unknown>>
    parkingEnabled: boolean
    remoteParkingEnabled?: boolean
    nowMs: number
    restorePolicy?: TerminalParkRestorePolicy
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const candidates: ColdParkRetainCandidate[] = []
  for (const worktree of args.worktrees) {
    if (
      worktree.hiddenSinceMs === null ||
      !canParkTerminalWorktreeRenderers({
        ...worktree,
        pendingStartupByTabId: args.pendingStartupByTabId,
        parkingEnabled: args.parkingEnabled,
        remoteParkingEnabled: args.remoteParkingEnabled === true,
        nowMs: args.nowMs,
        coldParkDelayMs,
        ...(args.restorePolicy ? { restorePolicy: args.restorePolicy } : {})
      })
    ) {
      continue
    }
    candidates.push({ id: worktree.worktreeId, hiddenSinceMs: worktree.hiddenSinceMs })
  }
  return selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS,
    hotRetainLimit: args.hotRetainLimit ?? TERMINAL_WORKTREE_HOT_RETAIN_LIMIT
  })
}

export function selectColdParkedTerminalTabs(
  args: {
    worktreeId: string
    terminalTabs: readonly TerminalTabColdParkCandidate[]
    pendingStartupByTabId: Readonly<Record<string, unknown>>
    parkingEnabled: boolean
    remoteParkingEnabled?: boolean
    nowMs: number
    parkCooldownUntilMs?: number | null
    restorePolicy?: TerminalParkRestorePolicy
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS
  const candidates: ColdParkRetainCandidate[] = []
  for (const tab of args.terminalTabs) {
    if (
      tab.hiddenSinceMs === null ||
      !canParkTerminalTabRenderer({
        worktreeId: args.worktreeId,
        terminalTab: tab,
        pendingStartupByTabId: args.pendingStartupByTabId,
        parkingEnabled: args.parkingEnabled,
        remoteParkingEnabled: args.remoteParkingEnabled === true,
        nowMs: args.nowMs,
        coldParkDelayMs,
        parkCooldownUntilMs: args.parkCooldownUntilMs,
        ...(args.restorePolicy ? { restorePolicy: args.restorePolicy } : {})
      })
    ) {
      continue
    }
    candidates.push({ id: tab.id, hiddenSinceMs: tab.hiddenSinceMs })
  }
  return selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS,
    hotRetainLimit: args.hotRetainLimit ?? TERMINAL_TAB_HOT_RETAIN_LIMIT
  })
}
