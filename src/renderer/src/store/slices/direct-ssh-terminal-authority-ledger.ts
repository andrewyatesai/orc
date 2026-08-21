import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import type { TerminalTab } from '../../../../shared/types'
import type {
  DirectSshLivePtyBinding,
  DirectSshTerminalBindingState
} from './direct-ssh-terminal-recovery-types'

export function directSshAuthoritiesEqual(
  left: DirectSshAuthority,
  right: DirectSshAuthority
): boolean {
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}

export function withoutTabIds<T>(
  source: Record<string, T>,
  tabIds: ReadonlySet<string>
): Record<string, T> {
  let next = source
  for (const tabId of tabIds) {
    if (!(tabId in next)) {
      continue
    }
    if (next === source) {
      next = { ...source }
    }
    delete next[tabId]
  }
  return next
}

/** Drop ledger rows captured for a superseded authority of the SAME target; other targets are untouched. */
export function pruneObsoleteAuthorityState(
  state: DirectSshTerminalBindingState,
  authority: DirectSshAuthority
): Pick<
  DirectSshTerminalBindingState,
  | 'directSshPaneRetryByTabId'
  | 'directSshLivePtyBindingByTabId'
  | 'directSshPaneRetryHistoryByTabId'
> {
  const prune = <T extends { authority: DirectSshAuthority }>(
    source: Record<string, T>
  ): Record<string, T> => {
    const obsoleteIds = Object.entries(source)
      .filter(
        ([, value]) =>
          value.authority.targetId === authority.targetId &&
          !directSshAuthoritiesEqual(value.authority, authority)
      )
      .map(([tabId]) => tabId)
    return withoutTabIds(source, new Set(obsoleteIds))
  }
  return {
    directSshPaneRetryByTabId: prune(state.directSshPaneRetryByTabId),
    directSshLivePtyBindingByTabId: prune(state.directSshLivePtyBindingByTabId),
    directSshPaneRetryHistoryByTabId: prune(state.directSshPaneRetryHistoryByTabId)
  }
}

export function liveBindingMatches(
  tab: TerminalTab,
  binding: DirectSshLivePtyBinding | undefined,
  authority: DirectSshAuthority
): boolean {
  return Boolean(
    binding &&
    directSshAuthoritiesEqual(binding.authority, authority) &&
    binding.tabGeneration === (tab.generation ?? 0) &&
    (binding.ptyId === tab.ptyId || (tab.ptyId == null && Boolean(tab.pendingActivationSpawn)))
  )
}
