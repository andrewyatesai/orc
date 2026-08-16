// TS dispatch for the setup-runner-command parity module.
//
// The module is HALF cut over, so this adapter is too:
//   * `resolveSetupRunnerCommand` (and `buildSetupRunnerCommand`, its `.command`
//     field) still have a live TS oracle, so these vectors compare the live
//     reference against the Rust port. The Rust core now carries the #6896 Git
//     Bash and #8928 nushell deliveries and the two resolution fields, so
//     `terminalShellFamily` cases are a real differential, not a blind spot.
//   * `isWslUncPath` / `wslUncToLinuxPath` are imported from THIS twin on
//     purpose. `wsl-unc-paths.ts` exports a same-named predicate over a
//     different pattern (it requires a non-empty distro and rejects
//     line-terminator tails); comparing against that shim would be comparing the
//     port to the wrong function.
//   * `getSetupRunnerCommandPlatformForPath` was DELETED from the TS twin (main
//     drives it via napi, the renderer via wasm), so it drives the same wasm the
//     production surfaces run and the TS-vs-Rust diff degenerates to
//     wasm-vs-binary.
import {
  buildSetupRunnerCommand,
  isWslUncPath,
  resolveSetupRunnerCommand,
  wslUncToLinuxPath,
  type SetupRunnerCommandPlatform
} from '../../../src/shared/setup-runner-command'
import type { AgentStartupShell } from '../../../src/shared/tui-agent-startup-shell'
import { gitWasmOracle } from './orca-git-wasm-oracle'

type CommandInput = {
  runnerScriptPath: string
  platform: SetupRunnerCommandPlatform
  terminalShellFamily?: AgentStartupShell
}

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    // Why the arity split: `parity:twin-derived` measures the argument encoding
    // from the calls this adapter makes, and an explicit trailing `undefined`
    // records as `null`, which matches no key and makes the function UNDERIVABLE.
    // Omitting the argument is also what the twin's real callers do.
    case 'buildSetupRunnerCommand': {
      const { runnerScriptPath, platform, terminalShellFamily } = input as CommandInput
      return terminalShellFamily === undefined
        ? buildSetupRunnerCommand(runnerScriptPath, platform)
        : buildSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily)
    }
    case 'resolveSetupRunnerCommand': {
      const { runnerScriptPath, platform, terminalShellFamily } = input as CommandInput
      return terminalShellFamily === undefined
        ? resolveSetupRunnerCommand(runnerScriptPath, platform)
        : resolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily)
    }
    case 'isWslUncPath':
      return isWslUncPath((input as { path: string }).path)
    case 'wslUncToLinuxPath':
      return wslUncToLinuxPath((input as { windowsPath: string }).windowsPath)
    case 'getSetupRunnerCommandPlatformForPath':
      return JSON.parse(
        gitWasmOracle().orcaDispatch('setup-runner-command', fn, JSON.stringify(input ?? null))
      )
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
