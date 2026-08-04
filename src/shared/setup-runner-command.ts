import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { quoteNuDoubleQuoted } from './nushell-shell'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import {
  buildWindowsCmdRunnerDelayedLaunchCommand,
  windowsRunnerPathNeedsCmdGuard
} from './windows-cmd-runner-delayed-launch'

export type SetupRunnerCommandPlatform = 'windows' | 'posix'
export type SetupRunnerShellFamily = 'posix' | 'cmd'
export type SetupRunnerCommandShell = 'posix' | 'windows'
export type SetupRunnerShell = {
  family: SetupRunnerShellFamily
  executable?: string
}

// Why: main records the executable-carrying descriptor alongside the runner script, while the
// renderer only knows the pane's startup-shell family (which also covers nushell, #8928).
export type SetupRunnerShellArg = AgentStartupShell | SetupRunnerShell

type ResolvedSetupRunnerShell = { family: AgentStartupShell; executable?: string }

export type SetupRunnerCommandResolution = {
  command: string
  runnerScriptPathForShell: string
  shell: SetupRunnerCommandShell
}

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  shell?: SetupRunnerShellArg
): string {
  return resolveSetupRunnerCommand(runnerScriptPath, platform, shell).command
}

export function getSetupRunnerCommandPlatformForPath(
  runnerScriptPath: string,
  fallbackPlatform: SetupRunnerCommandPlatform
): SetupRunnerCommandPlatform {
  if (isWindowsAbsolutePathLike(runnerScriptPath)) {
    return 'windows'
  }
  if (runnerScriptPath.startsWith('/')) {
    return 'posix'
  }
  return fallbackPlatform
}

export function resolveSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  shell?: SetupRunnerShellArg
): SetupRunnerCommandResolution {
  const requestedShell = normalizeSetupRunnerShell(shell)
  if (platform === 'windows') {
    if (isWslUncPath(runnerScriptPath)) {
      const linuxPath = wslUncToLinuxPath(runnerScriptPath)
      return {
        command: `bash ${quotePosixArg(linuxPath)}`,
        runnerScriptPathForShell: linuxPath,
        shell: 'posix'
      }
    }
    if (runnerScriptPath.startsWith('/') && !isWindowsAbsolutePathLike(runnerScriptPath)) {
      return {
        command: `bash ${quotePosixArg(runnerScriptPath)}`,
        runnerScriptPathForShell: runnerScriptPath,
        shell: 'posix'
      }
    }
    const isPosixRunnerScript = /\.sh$/i.test(runnerScriptPath)
    if (requestedShell?.family === 'posix' || isPosixRunnerScript) {
      // Why: WSL shells need /mnt/... paths, while Git Bash expects /c/... when replaying deferred setup scripts.
      if (isWslExecutable(requestedShell?.executable)) {
        const wslPath = nativeWindowsPathToWslShellPath(runnerScriptPath)
        return {
          command: `bash ${quotePosixArg(wslPath)}`,
          runnerScriptPathForShell: wslPath,
          shell: 'posix'
        }
      }
      // Why: bash cannot run a batch file, so a native .cmd runner still launches through cmd
      // from Git Bash — which history-expands `!` inside double quotes and MSYS-converts /c to
      // C:\ (#6896), hence the single quotes and the disabled path conversion.
      if (!isPosixRunnerScript && isWindowsAbsolutePathLike(runnerScriptPath)) {
        return {
          command: `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c ${quotePosixArg(runnerScriptPath)}`,
          runnerScriptPathForShell: runnerScriptPath.replace(/\\/g, '/'),
          shell: 'posix'
        }
      }
      // Why: queued setup launches can outlive the process that generated them, so convert native paths before handing off to POSIX shells.
      const posixPath = nativeWindowsPathToPosixShellPath(runnerScriptPath)
      return {
        command: `bash ${quotePosixArg(posixPath)}`,
        runnerScriptPathForShell: posixPath,
        shell: 'posix'
      }
    }
    if (requestedShell?.family === 'nushell') {
      // Why: nu double-quoted strings treat \ as an escape, so the .cmd path must be nu-escaped or the typed command errors.
      return {
        command: `cmd.exe /c ${quoteNuDoubleQuoted(runnerScriptPath)}`,
        runnerScriptPathForShell: runnerScriptPath,
        shell: 'windows'
      }
    }
    return {
      // Why: some path characters survive no amount of quoting on a cmd command line, so those
      // paths take a delayed-expansion launcher instead. Every other path keeps the plain form.
      command: windowsRunnerPathNeedsCmdGuard(runnerScriptPath)
        ? buildWindowsCmdRunnerDelayedLaunchCommand(runnerScriptPath)
        : `cmd.exe /c ${quoteWindowsArg(runnerScriptPath)}`,
      runnerScriptPathForShell: runnerScriptPath,
      shell: 'windows'
    }
  }

  return {
    command: `bash ${quotePosixArg(runnerScriptPath)}`,
    runnerScriptPathForShell: runnerScriptPath,
    shell: 'posix'
  }
}

export function isWslUncPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return /^\/\/(wsl\.localhost|wsl\$)\//i.test(normalized)
}

export function wslUncToLinuxPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i)
  return match?.[2] || '/'
}

function normalizeSetupRunnerShell(
  shell: SetupRunnerShellArg | undefined
): ResolvedSetupRunnerShell | undefined {
  if (shell === undefined) {
    return undefined
  }
  return typeof shell === 'string' ? { family: shell } : shell
}

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function nativeWindowsPathToPosixShellPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (driveMatch) {
    return `/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
  }
  return value.replace(/\\/g, '/')
}

function nativeWindowsPathToWslShellPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
  }
  return value.replace(/\\/g, '/')
}

function isWslExecutable(value: string | undefined): boolean {
  const basename = value?.trim().replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  return basename === 'wsl.exe' || basename === 'wsl'
}
