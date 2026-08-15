// TS dispatch for the setup-runner-command parity module.
//
// The module is HALF cut over, so this adapter is too:
//   * `buildSetupRunnerCommand` still has a live TS oracle — orca-core's
//     `build_setup_runner_command` predates the #6896 Git Bash / #8928 nushell
//     deliveries and has no `terminalShellFamily`, so the TS impl stays and these
//     vectors keep comparing the live reference against the Rust port (all of them
//     are shell-family-free, which is exactly the sub-domain the port covers).
//   * `getSetupRunnerCommandPlatformForPath` was DELETED from the TS twin (main
//     drives it via napi, the renderer via wasm), so it drives the same wasm the
//     production surfaces run and the TS-vs-Rust diff degenerates to wasm-vs-binary.
import {
  buildSetupRunnerCommand,
  type SetupRunnerCommandPlatform
} from '../../../src/shared/setup-runner-command'
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'buildSetupRunnerCommand': {
      const { runnerScriptPath, platform } = input as {
        runnerScriptPath: string
        platform: SetupRunnerCommandPlatform
      }
      return buildSetupRunnerCommand(runnerScriptPath, platform)
    }
    case 'getSetupRunnerCommandPlatformForPath':
      return JSON.parse(
        gitWasmOracle().orcaDispatch('setup-runner-command', fn, JSON.stringify(input ?? null))
      )
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
