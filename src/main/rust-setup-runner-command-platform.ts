// Main-process setup-runner platform resolution, driven by the Rust
// `orca_core::setup_runner_command` core via napi (the shared TS twin no longer
// implements it) — the same core the renderer runs through wasm, so a worktree
// created from either side picks the same shell.
//
// There is no pre-ready window here: napi binds synchronously at bootstrap. The
// fallback below exists for the ONE input class the codec refuses (see the catch),
// and it rebuilds the deleted twin's body verbatim, so it is the twin's answer.
// Only this resolver is cut over — `buildSetupRunnerCommand` /
// `resolveSetupRunnerCommand` have no current Rust counterpart and stay in TS.
import { dispatchToRustCore } from './rust-core-dispatch'
import { DispatchPayloadError } from '../shared/dispatch-payload-codec'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { SetupRunnerCommandPlatform } from '../shared/setup-runner-command'

export function getSetupRunnerCommandPlatformForPath(
  runnerScriptPath: string,
  fallbackPlatform: SetupRunnerCommandPlatform
): SetupRunnerCommandPlatform {
  try {
    return dispatchToRustCore('setup-runner-command', 'getSetupRunnerCommandPlatformForPath', {
      runnerScriptPath,
      fallbackPlatform
    }) as SetupRunnerCommandPlatform
  } catch (error) {
    // Why the catch: the runner path is derived from a Windows worktree path,
    // which is UTF-16 and may carry a lone surrogate the codec cannot encode.
    // Both call sites are inside worktree create/launch, where a throw aborts the
    // whole workspace creation. Only the encode rejection is caught; a
    // DispatchCoreError still propagates.
    if (error instanceof DispatchPayloadError) {
      return legacySetupRunnerCommandPlatformForPath(runnerScriptPath, fallbackPlatform)
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
