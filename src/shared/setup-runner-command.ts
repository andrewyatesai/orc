// CUT OVER to the Rust `orca_core::setup_runner_command` core. This file keeps
// the vocabulary only; every body moved out.
//
// `getSetupRunnerCommandPlatformForPath` went first — main reaches it through
// `src/main/rust-setup-runner-command-platform.ts` (napi) and the renderer
// through `src/renderer/src/lib/git-wasm/setup-runner-command-platform.ts`
// (wasm), because both callers already sit in one tree.
//
// `buildSetupRunnerCommand`, `resolveSetupRunnerCommand` and the module's own WSL
// UNC pair now live in `src/shared/setup-runner-command-resolution.ts`, on the
// surface-agnostic `orca-dispatch-seam`: `setup-agent-sequencing.ts` is a
// src/shared module that builds these commands for main AND the renderer, so
// there is no one tree for them to live in. The header there carries the
// pre-ready contract, the measurement behind it, and why the WSL pair is
// deliberately not `wsl-unc-paths.ts`.
//
// The earlier note here that the Rust predated #6896/#8928 and could not emit the
// Git Bash or nushell deliveries is out of date: the core carries both, plus the
// `runnerScriptPathForShell`/`shell` fields `setup-agent-sequencing` builds its
// completion marker from.

/** Shell flavour the runner command is built FOR. */
export type SetupRunnerCommandPlatform = 'windows' | 'posix'

/** Quoting dialect `runnerScriptPathForShell` is spelled in. */
export type SetupRunnerCommandShell = 'posix' | 'windows'

export type SetupRunnerCommandResolution = {
  command: string
  runnerScriptPathForShell: string
  shell: SetupRunnerCommandShell
}
