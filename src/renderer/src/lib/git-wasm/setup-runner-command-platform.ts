// Renderer setup-runner platform resolution, driven by the Rust
// `orca_core::setup_runner_command` core in the orca-git wasm module (the shared
// TS twin no longer implements it). Only this resolver is cut over: orca-core's
// `build_setup_runner_command` predates the Git Bash / nushell deliveries, so
// `buildSetupRunnerCommand` and `resolveSetupRunnerCommand` stay TypeScript.
//
// PRE-READY CONTRACT — `parity`. This answer picks the shell that will EXECUTE a
// worktree's setup runner: a wrong 'windows' types `cmd.exe /c "/home/…/run.sh"`
// at a bash prompt, a wrong 'posix' types `bash 'C:\…\setup-runner.cmd'`. The
// union has exactly two values and both are real answers, so there is no spare
// state a sentinel could occupy and no caller could branch on one. The fallback
// therefore rebuilds the deleted twin's body verbatim from the kept
// `isWindowsAbsolutePathLike` primitive, so pre-ready equals ready for every input.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import { DispatchPayloadError } from '../../../../shared/dispatch-payload-codec'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { SetupRunnerCommandPlatform } from '../../../../shared/setup-runner-command'

export function getSetupRunnerCommandPlatformForPath(
  runnerScriptPath: string,
  fallbackPlatform: SetupRunnerCommandPlatform
): SetupRunnerCommandPlatform {
  const legacy = legacySetupRunnerCommandPlatformForPath(runnerScriptPath, fallbackPlatform)
  if (!isGitWasmReady()) {
    return legacy
  }
  try {
    return dispatchToWasmCore('setup-runner-command', 'getSetupRunnerCommandPlatformForPath', {
      runnerScriptPath,
      fallbackPlatform
    }) as SetupRunnerCommandPlatform
  } catch (error) {
    // Why the catch: a Windows runner path is UTF-16 off the filesystem and may
    // carry a lone surrogate, which the codec refuses because it cannot cross
    // into Rust. The twin answered that path without crossing anything and the
    // fallback computes the same answer, so worktree activation degrades instead
    // of throwing. Only the encode rejection is caught; DispatchCoreError propagates.
    if (error instanceof DispatchPayloadError) {
      return legacy
    }
    throw error
  }
}

function legacySetupRunnerCommandPlatformForPath(
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
