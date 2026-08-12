import { useEffect, useMemo } from 'react'
import { useAppStore } from '../store'
import { installWindowVisibilityInterval } from '../lib/window-visibility-interval'
import {
  getLandingPreflightIssues,
  hasGitHubBackedProject,
  type PreflightIssue
} from './landing-preflight-issues'

/** Drives the landing preflight banner through the runtime-aware preflight
 * slice. Only the slice consults getActiveRuntimeTarget, so reading it here
 * probes the ACTIVE remote host instead of the renderer's local client, and the
 * mount/focus/poll paths share the slice's deduped in-flight request. */
export function useLandingPreflightRuntime(): { preflightIssues: PreflightIssue[] } {
  const repos = useAppStore((s) => s.repos)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const invalidatePreflightStatus = useAppStore((s) => s.invalidatePreflightStatus)
  // Why: a compact, session-scoped key so the refresh effect re-fires only on a
  // real runtime change (env id, connection generation, or reachability flip).
  const activeRuntimeState = useAppStore((s) => {
    const environmentId = s.settings?.activeRuntimeEnvironmentId?.trim()
    if (!environmentId) {
      return 'local'
    }
    const runtimeStatus = s.runtimeStatusByEnvironmentId.get(environmentId)
    const reachability = runtimeStatus
      ? runtimeStatus.status === null
        ? 'unreachable'
        : 'reachable'
      : 'unknown'
    return `${environmentId}:${runtimeStatus?.connectionGeneration ?? 0}:${reachability}`
  })

  const hasGitHubProject = useMemo(() => hasGitHubBackedProject(repos), [repos])
  const preflightIssues = useMemo(
    () =>
      preflightStatus
        ? getLandingPreflightIssues(preflightStatus, {
            hasGitHubBackedProject: hasGitHubProject
          })
        : [],
    [preflightStatus, hasGitHubProject]
  )

  useEffect(() => {
    // Why: an active remote runtime that is unreachable/unknown must not show the
    // client machine's stale banner, so drop the cached result until it recovers.
    if (activeRuntimeState !== 'local' && !activeRuntimeState.endsWith(':reachable')) {
      invalidatePreflightStatus()
      return
    }

    void refreshPreflightStatus()
    // Why: users often install/authenticate gh outside Orca. Re-check when the
    // window becomes active again so the landing warning clears without relaunch.
    const handleWindowActive = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshPreflightStatus({ force: true })
      }
    }
    document.addEventListener('visibilitychange', handleWindowActive)
    window.addEventListener('focus', handleWindowActive)
    return () => {
      document.removeEventListener('visibilitychange', handleWindowActive)
      window.removeEventListener('focus', handleWindowActive)
    }
  }, [activeRuntimeState, invalidatePreflightStatus, refreshPreflightStatus])

  useEffect(() => {
    if (preflightIssues.length === 0) {
      return
    }
    // Why: some users complete `gh auth login` without leaving the Orca window.
    // Poll only while a warning is visible so the banner self-clears — and only
    // while the WINDOW is visible, so a backgrounded Landing screen stops
    // spawning gh/glab auth-status probes every 30s. The effect above
    // force-refreshes on re-show, so runOnVisible stays a no-op.
    return installWindowVisibilityInterval({
      run: () => void refreshPreflightStatus({ force: true }),
      runOnVisible: () => {},
      intervalMs: 30000
    })
  }, [preflightIssues.length, refreshPreflightStatus])

  return { preflightIssues }
}
