import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/types'

/**
 * Re-runs the setup-script prompt inspection when a shared `orca.yaml` setup hook
 * can have become effective outside SetupScriptPromptCard's reactive inputs, so a
 * stale "Add a setup script" prompt clears without a full sidebar reopen.
 */
export function useSetupScriptPromptRevalidation(input: {
  activeRepo: Repo | null
  isDismissed: boolean
  sidebarOpen: boolean
  promptState: SetupScriptPromptInspection | null
  requestRevalidation: () => void
}): void {
  const { activeRepo, isDismissed, sidebarOpen, promptState, requestRevalidation } = input
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  // Why: revalidate while the prompt shows no effective setup or a failed inspection —
  // both can be stale. An unreadable orca.yaml now reports `error` (not a status-less
  // false negative), so re-inspecting recovers instead of pinning the failed verdict.
  // `forbidden` is permanent and an effective setup has nothing to clear, so neither is
  // worth an RPC (notably over SSH).
  const promptBelongsToActiveRepo = promptState?.repoId === activeRepo?.id
  const promptNeedsRevalidation =
    promptBelongsToActiveRepo &&
    (promptState?.status === 'error' ||
      (promptState?.status === 'ok' && !promptState.hasEffectiveSetup))

  // Why: orca.yaml is edited on disk or the hook runs in a terminal outside React
  // state. Re-inspect on window focus so returning to Orca detects it (mirrors
  // useInstalledAgentSkills' focus revalidation).
  useEffect(() => {
    if (
      !sidebarOpen ||
      !activeRepo ||
      !isGitRepoKind(activeRepo) ||
      isDismissed ||
      !promptNeedsRevalidation
    ) {
      return
    }
    window.addEventListener('focus', requestRevalidation)
    return () => {
      window.removeEventListener('focus', requestRevalidation)
    }
  }, [activeRepo, isDismissed, requestRevalidation, promptNeedsRevalidation, sidebarOpen])

  // Why: the setup hook runs during worktree creation, so activating a worktree in
  // this repo can make the setup effective after a negative result was cached. Fire
  // only on an actual activation change, not on mount/remount with a seeded id —
  // the initial inspection already covers the mounted worktree.
  const previousWorktreeIdRef = useRef(activeWorktreeId)
  useEffect(() => {
    const changed = previousWorktreeIdRef.current !== activeWorktreeId
    previousWorktreeIdRef.current = activeWorktreeId
    if (changed && promptNeedsRevalidation) {
      requestRevalidation()
    }
  }, [activeWorktreeId, requestRevalidation, promptNeedsRevalidation])
}
