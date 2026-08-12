import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'

export type SimulatorTabPaletteActivationFailure = 'missing-tab' | 'missing-worktree'

export type SimulatorTabPaletteActivationResult =
  | { status: 'activated'; tabId: string }
  | { status: 'failed'; reason: SimulatorTabPaletteActivationFailure }

export type SimulatorTabPaletteActivationTarget = {
  tabId: string
  worktreeId: string
}

export function activateSimulatorTabPaletteResult({
  tabId,
  worktreeId
}: SimulatorTabPaletteActivationTarget): SimulatorTabPaletteActivationResult {
  const initialState = useAppStore.getState()
  const tab = (initialState.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId && candidate.contentType === 'simulator'
  )
  if (!tab) {
    return { status: 'failed', reason: 'missing-tab' }
  }

  const worktree = initialState.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  // Fork note: this build's activateAndRevealWorktree resolves the host itself
  // (no executionHostId option), so the Cmd+J paths pass only the worktree id.
  const activated = activateAndRevealWorktree(worktree.id)
  if (!activated) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const state = useAppStore.getState()
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id)
  state.setActiveTab(tab.id)
  state.setActiveTabType('simulator')
  return { status: 'activated', tabId: tab.id }
}
