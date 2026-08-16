// The setup-runner command builder on the Rust `orca_core::setup_runner_command`
// core. `src/shared/setup-runner-command.ts` keeps only the vocabulary; the
// bodies live here, one crossing per call.
//
// It sits on `orca-dispatch-seam` rather than in one tree's binding directory
// because the same command is built on THREE surfaces: main (napi, via
// worktree-remote and orca-runtime), the renderer (wasm at ready, via
// setup-runner / launch-worktree-background-terminals / worktree-activation),
// and `setup-agent-sequencing`, a src/shared module both of those call. A
// tree-local shim would have forced that shared module to pick a tree.
//
// WHAT THIS RETURNS IS TYPED INTO A LIVE SHELL AND RUNS. A wrong `command` does
// not render wrong, it executes wrong — `cmd.exe /c "/home/…/run.sh"` at a bash
// prompt, or an unescaped `C:\…` that nu rejects. `runnerScriptPathForShell` is
// worse than cosmetic too: `setup-agent-sequencing` appends `.<nonce>.done` to it
// and both the setup command and the startup gate poll that marker, so a
// spelling the receiving shell does not agree with never completes and the agent
// waits out its two-hour timeout.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED.
//
// Why no sentinel exists. `resolveSetupRunnerCommand` returns a total record and
// `buildSetupRunnerCommand` a bare string that is immediately concatenated into a
// spawn; `isWslUncPath` is a boolean read inside an `if`. There is no spare state
// (ported-modules.md, "Signal at the level that has a spare state"), and a
// sentinel lifted into the return type would have to be branched on by
// `createSequencedSetupAgentCommands`, whose only honest branch is "do not run
// the user's setup script" — a silent no-op on the one action the user asked for.
// A plausible constant is out of the question: the value is EXECUTED.
//
// So each fallback rebuilds the deleted twin's body verbatim over primitives the
// twin still keeps (`isWindowsAbsolutePathLike` in `cross-platform-path.ts`,
// which is deliberately not cut over for exactly this reason, and
// `quoteNuDoubleQuoted` in `nushell-shell.ts`), which makes pre-ready equal ready
// for every input.
//
// Measured, not asserted: 1,853,544 comparisons of these fallbacks against the
// shipped wasm core, 0 divergences. Exhaustive to length 4 over
// `[/ \ w s l . $ U a \n : C]` (22,620 strings) crossed with both platforms and
// all five terminal-shell families; exhaustive to length 6 over the WSL-shaped
// alphabet `[/ \ w s $ U \n .]`; all 2,985 code points whose JS case mapping is
// not plain ASCII folding (the entire risk surface of JS `/i` vs the core's
// `to_ascii_lowercase`), each spliced into the share, host, distro and tail
// positions; 43 quoting/line-terminator/astral hazards through 12 path shapes;
// 120,000 random paths over a wide alphabet; and 36 curated real macOS / Windows
// / WSL / UNC / degenerate shapes. Then 505,620 more over the SHIPPED shim
// itself, calling each export unbound and bound and comparing the two — the
// bound-vs-unbound check the fallback-vs-core one cannot make — over the same
// exhaustive corpus plus lone surrogates and every argument class the guard
// below refuses. `pnpm parity` re-checks the claim on every run:
// `tools/parity/dispatch/setup-runner-command.ts` drives THIS module with the
// seam unbound, so the corpus vectors compare these fallbacks against Rust.
//
// The WSL pair below is NOT `wsl-unc-paths.ts`. That module's same-named
// predicate is a different function: it requires a non-empty distro segment (so
// it answers false for `//wsl.localhost/`, where this answers true) and it folds
// a line-terminator tail to "not a WSL path", which this does not. Both
// differences decide whether the built command is `bash …` or `cmd.exe /c …`, so
// routing these to `wsl-paths` would have been a silent behaviour change dressed
// as a de-duplication. The core keeps two predicates on purpose; so does this.
//
// RESIDUAL — inputs answered by the fallback with the seam BOUND. `commandPayload`
// refuses three argument classes rather than dispatching them, because for these
// the core does not fail, it answers something ELSE:
//   * a non-string `runnerScriptPath` (these reach the app from persisted JSON
//     and over the runtime RPC). `Value::as_str().unwrap_or("")` turns it into an
//     EMPTY path, so `resolve(undefined, 'posix')` would build `bash ''` where
//     the twin built `bash undefined`. Both are wrong; only one is the twin's.
//   * a `platform` outside the two-member union — the core answers
//     `__parity_error__`, which decodes as a throw, where the twin fell through
//     to its POSIX branch.
//   * a `terminalShellFamily` outside `AgentStartupShell` — same throw, where the
//     twin fell through to the cmd.exe default. Both resolvers that feed this
//     (`windows-terminal-shell.ts`, `posix-terminal-shell.ts`) are total over the
//     union today, so this guard is a floor, not a live path; it exists so a
//     future settings value cannot turn a queued setup command into an aborted
//     worktree creation.
// The fallback is the twin's body, so these are the twin's answers — but they are
// answered in TS on every surface, and the core is never proven on them.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { quoteNuDoubleQuoted } from './nushell-shell'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type {
  SetupRunnerCommandPlatform,
  SetupRunnerCommandResolution
} from './setup-runner-command'

const MODULE = 'setup-runner-command'

/** `AgentStartupShell`'s members, as a runtime guard — the type is erased by the
 *  time a persisted setting or an RPC argument reaches this seam. */
const KNOWN_STARTUP_SHELLS = new Set<string>(['posix', 'powershell', 'cmd', 'nushell'])

type CommandPayload = {
  runnerScriptPath: string
  platform: SetupRunnerCommandPlatform
  terminalShellFamily?: AgentStartupShell
}

/**
 * The dispatch payload, or `null` when an argument is one the core would answer
 * differently from the twin (see RESIDUAL in the header) and the fallback must
 * take the call instead.
 *
 * The key is omitted rather than set to `undefined` so the codec's default
 * `undefinedProperties: 'reject'` stays in force — an absent key is the twin's
 * omitted third argument and serde's `None`.
 */
function commandPayload(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  terminalShellFamily?: AgentStartupShell
): CommandPayload | null {
  if (typeof runnerScriptPath !== 'string') {
    return null
  }
  if (platform !== 'windows' && platform !== 'posix') {
    return null
  }
  if (terminalShellFamily === undefined || terminalShellFamily === null) {
    return { runnerScriptPath, platform }
  }
  return KNOWN_STARTUP_SHELLS.has(terminalShellFamily as string)
    ? { runnerScriptPath, platform, terminalShellFamily }
    : null
}

export function buildSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  terminalShellFamily?: AgentStartupShell
): string {
  const payload = commandPayload(runnerScriptPath, platform, terminalShellFamily)
  if (!payload) {
    return legacyResolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily).command
  }
  try {
    // `null` here is the unbound seam, never a core answer: this arm returns a
    // JSON string on every input the guard above lets through.
    const answer = tryOrcaDispatch(MODULE, 'buildSetupRunnerCommand', payload, {
      root: 'runnerScriptPath'
    })
    return answer === null
      ? legacyResolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily).command
      : (answer as string)
  } catch (error) {
    if (isUnencodablePath(error)) {
      return legacyResolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily)
        .command
    }
    throw error
  }
}

export function resolveSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  terminalShellFamily?: AgentStartupShell
): SetupRunnerCommandResolution {
  const payload = commandPayload(runnerScriptPath, platform, terminalShellFamily)
  if (!payload) {
    return legacyResolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily)
  }
  try {
    // As above: this arm returns a JSON object, so `null` is only the unbound seam.
    const answer = tryOrcaDispatch(MODULE, 'resolveSetupRunnerCommand', payload, {
      root: 'runnerScriptPath'
    })
    return answer === null
      ? legacyResolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily)
      : (answer as SetupRunnerCommandResolution)
  } catch (error) {
    if (isUnencodablePath(error)) {
      return legacyResolveSetupRunnerCommand(runnerScriptPath, platform, terminalShellFamily)
    }
    throw error
  }
}

export function isWslUncPath(path: string): boolean {
  if (typeof path !== 'string') {
    return legacyIsWslUncPath(path)
  }
  try {
    const answer = tryOrcaDispatch(MODULE, 'isWslUncPath', { path }, { root: 'path' })
    return answer === null ? legacyIsWslUncPath(path) : (answer as boolean)
  } catch (error) {
    if (isUnencodablePath(error)) {
      return legacyIsWslUncPath(path)
    }
    throw error
  }
}

export function wslUncToLinuxPath(windowsPath: string): string {
  if (typeof windowsPath !== 'string') {
    return legacyWslUncToLinuxPath(windowsPath)
  }
  try {
    const answer = tryOrcaDispatch(
      MODULE,
      'wslUncToLinuxPath',
      { windowsPath },
      { root: 'windowsPath' }
    )
    return answer === null ? legacyWslUncToLinuxPath(windowsPath) : (answer as string)
  } catch (error) {
    if (isUnencodablePath(error)) {
      return legacyWslUncToLinuxPath(windowsPath)
    }
    throw error
  }
}

// Why the catch: a runner path is built from a Windows worktree path, which is
// UTF-16 off the filesystem and may carry an unpaired surrogate. The codec
// refuses it (it is not valid UTF-8, so it cannot cross into Rust at all) and
// the twin answered it without crossing anything, so the fallback is that same
// answer. Only the encode rejection is folded back; a DispatchCoreError — the
// core reached and failed — still propagates.
function isUnencodablePath(error: unknown): boolean {
  return error instanceof DispatchPayloadError
}

// ---- the deleted twin's body, verbatim ----

function legacyIsWslUncPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return /^\/\/(wsl\.localhost|wsl\$)\//i.test(normalized)
}

function legacyWslUncToLinuxPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i)
  return match?.[2] || '/'
}

function legacyResolveSetupRunnerCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  terminalShellFamily?: AgentStartupShell
): SetupRunnerCommandResolution {
  if (platform === 'windows') {
    if (legacyIsWslUncPath(runnerScriptPath)) {
      const linuxPath = legacyWslUncToLinuxPath(runnerScriptPath)
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

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
