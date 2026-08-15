import { parseWslUncPath } from '../../../src/shared/wsl-unc-paths'
import type { MobileAiVaultResumeTargetStatus } from '../agent-history/agent-history-resume-target'

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
])

export function readMobileRuntimeHostPlatform(statusResult: unknown): NodeJS.Platform | null {
  if (!statusResult || typeof statusResult !== 'object') {
    return null
  }
  const hostPlatform = (statusResult as { hostPlatform?: unknown }).hostPlatform
  return typeof hostPlatform === 'string' && NODE_PLATFORMS.has(hostPlatform as NodeJS.Platform)
    ? (hostPlatform as NodeJS.Platform)
    : null
}

export function readMobileRuntimeTerminalWindowsShell(statusResult: unknown): string | null {
  if (!statusResult || typeof statusResult !== 'object') {
    return null
  }
  const shell = (statusResult as { terminalWindowsShell?: unknown }).terminalWindowsShell
  return typeof shell === 'string' && shell.trim().length > 0 ? shell : null
}

export function resolveMobileAiVaultResumePlatform(
  targetStatus: MobileAiVaultResumeTargetStatus,
  hostPlatform: NodeJS.Platform | null,
  workspacePath?: string | null,
  terminalPlatform?: NodeJS.Platform | null
): NodeJS.Platform | null {
  if (targetStatus === 'ssh') {
    // Why: desktop builds SSH resume commands for the remote POSIX execution
    // host instead of the phone or local desktop platform.
    return 'linux'
  }
  if (targetStatus === 'local') {
    if (terminalPlatform === 'linux' && hostPlatform === 'win32') {
      // Why: Windows-hosted WSL project terminals run a POSIX shell even when
      // the visible workspace path is a normal Windows path.
      return 'linux'
    }
    if (workspacePath && parseWslUncPath(workspacePath)) {
      // Why: a WSL UNC workspace on a Windows host runs in a Linux shell.
      return 'linux'
    }
    return hostPlatform
  }
  return null
}
