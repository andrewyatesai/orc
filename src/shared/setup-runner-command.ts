// PARTIALLY CUT OVER to the Rust `orca_core::setup_runner_command` core.
//
// `getSetupRunnerCommandPlatformForPath` is gone from here — main reaches it
// through `src/main/rust-setup-runner-command-platform.ts` (napi) and the
// renderer through `src/renderer/src/lib/git-wasm/setup-runner-command-platform.ts`
// (wasm). Its `SetupRunnerCommandPlatform` type stays as the shared vocabulary.
//
// `resolveSetupRunnerCommand` and the WSL UNC pair below are NOT cut over and
// must not be: orca-core's `build_setup_runner_command` predates #6896/#8928, so
// it has no `terminalShellFamily` parameter and cannot emit the Git Bash
// (`MSYS_NO_PATHCONV=…`) or nushell (`\`-escaped) deliveries, and it has no
// counterpart at all for the `runnerScriptPathForShell`/`shell` fields that
// `setup-agent-sequencing` builds its completion marker from. Dispatching these
// would EXECUTE a cmd.exe wrapper at a Git Bash prompt. Unported, not un-cut-over.
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { quoteNuDoubleQuoted } from './nushell-shell'
import type { AgentStartupShell } from './tui-agent-startup-shell'

export type SetupRunnerCommandPlatform = 'windows' | 'posix'
export type SetupRunnerCommandShell = 'posix' | 'windows'

export type SetupRunnerCommandResolution = {
  command: string
  runnerScriptPathForShell: string
  shell: SetupRunnerCommandShell
}

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  terminalShellFamily?: AgentStartupShell
): string {
  return resolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily).command
}

export function resolveSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  terminalShellFamily?: AgentStartupShell
): SetupRunnerCommandResolution {
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
    if (terminalShellFamily === 'posix') {
      // Why: Git Bash history-expands `!` inside double quotes and MSYS-converts /c to C:\ (#6896);
      // single-quote the .cmd path, disable path conversion, and keep sequencing in POSIX form.
      return {
        command: `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c ${quotePosixArg(runnerScriptPath)}`,
        runnerScriptPathForShell: runnerScriptPath.replace(/\\/g, '/'),
        shell: 'posix'
      }
    }
    if (terminalShellFamily === 'nushell') {
      // Why: nu double-quoted strings treat \ as an escape, so the .cmd path must be nu-escaped or the typed command errors.
      return {
        command: `cmd.exe /c ${quoteNuDoubleQuoted(runnerScriptPath)}`,
        runnerScriptPathForShell: runnerScriptPath,
        shell: 'windows'
      }
    }
    return {
      command: `cmd.exe /c ${quoteWindowsArg(runnerScriptPath)}`,
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

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
