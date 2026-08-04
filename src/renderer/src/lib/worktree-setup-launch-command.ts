import { useAppStore } from '@/store'
import { getWorktreeSetupTerminalShellFamily } from '@/lib/setup-runner'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../../shared/setup-runner-command'
import type { WorktreeSetupLaunch } from '../../../shared/types'

/** The command that runs a workspace's setup runner script in a terminal pane. */
export function buildWorktreeSetupLaunchCommand(
  setup: WorktreeSetupLaunch,
  worktreeId: string
): string {
  const state = useAppStore.getState()
  return buildSetupRunnerCommand(
    setup.runnerScriptPath,
    getSetupRunnerCommandPlatformForPath(setup.runnerScriptPath, 'posix'),
    // Why: the recorded shell wins because a queued tab can launch long after the runner
    // was written; without one, fall back to the pane's configured shell so Git Bash gets
    // POSIX delivery instead of a cmd.exe wrapper (#6896).
    setup.shell ??
      getWorktreeSetupTerminalShellFamily(
        state,
        worktreeId,
        state.settings?.terminalWindowsShell,
        state.settings?.terminalPosixShell
      )
  )
}
