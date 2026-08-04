import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import { resolveLocalPosixAgentStartupShell } from '../../../shared/posix-terminal-shell'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { AppState } from '@/store/types'

/**
 * Shell dialect an AI-vault resume command must be quoted for.
 *
 * Why: the local shell settings describe only the local host — a remote host
 * runs its own default, so the caller states what it knows about that host via
 * `remoteWindowsShell` instead of leaking the local choice onto it.
 */
export function resolveAiVaultResumeShellFamily(args: {
  executionHostId?: string | null
  settings: AppState['settings']
  platform: NodeJS.Platform
  /** Dialect to assume for a remote Windows host; undefined leaves it unquoted. */
  remoteWindowsShell?: AgentStartupShell
}): AgentStartupShell | undefined {
  const isLocalSession = !args.executionHostId || args.executionHostId === LOCAL_EXECUTION_HOST_ID
  if (!isLocalSession) {
    return args.platform === 'win32' ? args.remoteWindowsShell : undefined
  }
  if (args.platform === 'win32') {
    return resolveWindowsShellStartupFamily(args.settings?.terminalWindowsShell)
  }
  return resolveLocalPosixAgentStartupShell({
    platform: args.platform,
    clientPlatform: CLIENT_PLATFORM,
    isRemote: false,
    terminalPosixShell: args.settings?.terminalPosixShell
  })
}
