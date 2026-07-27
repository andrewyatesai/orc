import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AppState } from '@/store/types'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { selectWorktreeAgentOrchestration } from './worktree-agent-orchestration-index'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import {
  getLiveEntriesByWorktree,
  getMigrationUnsupportedByWorktree,
  getRetainedEntriesByWorktree,
  type RuntimeAgentOrchestrationState,
  type WorktreeAgentRowsState
} from './worktree-agent-index-cache'

const EMPTY_LIVE_ENTRIES: AgentStatusEntry[] = []
const EMPTY_MIGRATION_UNSUPPORTED_ENTRIES: MigrationUnsupportedPtyEntry[] = []
const EMPTY_RETAINED: RetainedAgentEntry[] = []
// Why: selector unit tests often pass partial store mocks; production state
// owns these maps, but missing mock maps should behave like empty slices.
const EMPTY_RECORD = {}

export function selectLiveAgentStatusEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): AgentStatusEntry[] {
  return getLiveEntriesByWorktree(state).get(worktreeId) ?? EMPTY_LIVE_ENTRIES
}

export function selectMigrationUnsupportedEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): MigrationUnsupportedPtyEntry[] {
  return (
    getMigrationUnsupportedByWorktree(state).get(worktreeId) ?? EMPTY_MIGRATION_UNSUPPORTED_ENTRIES
  )
}

export function selectRetainedAgentEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): RetainedAgentEntry[] {
  return getRetainedEntriesByWorktree(state).get(worktreeId) ?? EMPTY_RETAINED
}

// Why: reads a shared worktree-keyed index instead of rescanning every
// orchestration context. Zustand re-runs each mounted card's selector on every
// publication, so the old per-card scan was O(cards x contexts) on unrelated
// traffic; only the first card through a given store version now pays a build.
export function selectRuntimeAgentOrchestrationForWorktree(
  state: RuntimeAgentOrchestrationState,
  worktreeId: string
): Record<string, AgentStatusOrchestrationContext> {
  return selectWorktreeAgentOrchestration(state, worktreeId)
}

export function selectTerminalLayoutsForWorktree(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  worktreeId: string
): Record<string, TerminalLayoutSnapshot | undefined> {
  const out: Record<string, TerminalLayoutSnapshot | undefined> = {}
  for (const tab of (state.tabsByWorktree ?? EMPTY_RECORD)[worktreeId] ?? []) {
    out[tab.id] = (state.terminalLayoutsByTabId ?? EMPTY_RECORD)[tab.id]
  }
  return out
}
