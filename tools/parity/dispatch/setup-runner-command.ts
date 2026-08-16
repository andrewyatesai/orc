// TS dispatch for the setup-runner-command parity module. The module is now
// fully cut over, so no TS twin is left to import.
//
//   * `buildSetupRunnerCommand`, `resolveSetupRunnerCommand` and the module's own
//     WSL pair come from the SHIM, and the harness keeps a real TS-vs-Rust
//     differential rather than degenerating to wasm-vs-binary:
//     config/vitest.parity.config.ts installs no setup file, so the
//     orca-dispatch seam is unbound here and the shim answers from its `parity`
//     fallback — which is exactly the deleted body, and exactly the code the
//     pre-wasm renderer runs. Every case below is therefore a standing re-check
//     of the pre-ready contract as well as of the port.
//   * `isWslUncPath` / `wslUncToLinuxPath` come from the shim on purpose, not
//     from `wsl-unc-paths.ts`. That module exports a same-named predicate over a
//     different pattern (it requires a non-empty distro and rejects
//     line-terminator tails); comparing against it would be comparing the port to
//     the wrong function.
//   * `getSetupRunnerCommandPlatformForPath` has no shared shim — main drives it
//     via napi and the renderer via wasm — so it stays on the wasm oracle and its
//     diff is wasm-vs-binary.
import {
  buildSetupRunnerCommand,
  isWslUncPath,
  resolveSetupRunnerCommand,
  wslUncToLinuxPath
} from '../../../src/shared/setup-runner-command-resolution'
import type { SetupRunnerCommandPlatform } from '../../../src/shared/setup-runner-command'
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
