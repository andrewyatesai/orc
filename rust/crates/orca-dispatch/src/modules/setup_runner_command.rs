//! Parity dispatch for `orca_core::setup_runner_command` vs
//! `src/shared/setup-runner-command.ts`.
//!
//! `resolveSetupRunnerCommand` is the module's real entry point —
//! `buildSetupRunnerCommand` is its `.command` field — and what it returns is
//! TYPED INTO A LIVE SHELL, so an arm that answers the 2-argument answer to a
//! 3-argument call delivers a `cmd.exe` wrapper to a Git Bash prompt. The
//! `terminalShellFamily` key is therefore read on BOTH command arms, and an
//! unrecognised id is a loud `__parity_error__` rather than a silent
//! fall-through to the cmd.exe default.
//!
//! One arm per function name, each on its own line: the twin-derived scanner
//! reads this `match` textually to decide whether an export is routed at all.

use orca_core::setup_runner_command::{
    build_setup_runner_command, get_setup_runner_command_platform_for_path, is_wsl_unc_path,
    resolve_setup_runner_command, wsl_unc_to_linux_path, AgentStartupShell,
    SetupRunnerCommandPlatform, SetupRunnerCommandResolution, SetupRunnerCommandShell,
};
use serde_json::{json, Value};

pub fn dispatch(function: &str, input: &Value) -> Value {
    match function {
        "buildSetupRunnerCommand" => match command_arguments(input) {
            // TS returns a plain `string`; mirror it directly.
            Ok((path, platform, family)) => {
                Value::String(build_setup_runner_command(path, platform, family))
            }
            Err(error) => error,
        },
        "resolveSetupRunnerCommand" => match command_arguments(input) {
            Ok((path, platform, family)) => {
                resolution_to_json(resolve_setup_runner_command(path, platform, family))
            }
            Err(error) => error,
        },
        "getSetupRunnerCommandPlatformForPath" => {
            let runner_script_path = input.get("runnerScriptPath").and_then(Value::as_str).unwrap_or("");
            match input.get("fallbackPlatform").and_then(Value::as_str).and_then(platform_from_id) {
                // TS returns the `SetupRunnerCommandPlatform` string union.
                Some(fallback) => Value::String(
                    platform_to_id(get_setup_runner_command_platform_for_path(runner_script_path, fallback))
                        .to_string(),
                ),
                None => json!({ "__parity_error__": "unknown SetupRunnerCommandPlatform in input.fallbackPlatform" }),
            }
        }
        // This module's OWN WSL pair, NOT `wsl-paths`': this one accepts an empty
        // distro and its converter answers `/` where the other answers a parse
        // failure, so they disagree on which shell an executed command lands in.
        "isWslUncPath" => Value::Bool(is_wsl_unc_path(
            input.get("path").and_then(Value::as_str).unwrap_or(""),
        )),
        "wslUncToLinuxPath" => Value::String(wsl_unc_to_linux_path(
            input.get("windowsPath").and_then(Value::as_str).unwrap_or(""),
        )),
        other => json!({ "__parity_error__": format!("unknown function {other}") }),
    }
}

/// The `(runnerScriptPath, platform, terminalShellFamily?)` argument list both
/// command functions take, or the `__parity_error__` naming the bad key.
fn command_arguments(
    input: &Value,
) -> Result<(&str, SetupRunnerCommandPlatform, Option<AgentStartupShell>), Value> {
    let runner_script_path = input.get("runnerScriptPath").and_then(Value::as_str).unwrap_or("");
    // Vectors only carry known platform ids; an unknown one is a vector bug.
    let Some(platform) = input.get("platform").and_then(Value::as_str).and_then(platform_from_id) else {
        return Err(json!({ "__parity_error__": "unknown SetupRunnerCommandPlatform in input.platform" }));
    };
    // Absent/null is the twin's omitted third argument. An unknown id is NOT
    // folded into that: the twin would fall through to the cmd.exe default, and
    // guessing which of the two the caller meant is exactly the silent wrong
    // answer this boundary must not produce.
    let family = match input.get("terminalShellFamily") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_str().and_then(startup_shell_from_id) {
            Some(shell) => Some(shell),
            None => {
                return Err(
                    json!({ "__parity_error__": "unknown AgentStartupShell in input.terminalShellFamily" }),
                )
            }
        },
    };
    Ok((runner_script_path, platform, family))
}

/// The TS `SetupRunnerCommandResolution` object literal, key for key.
fn resolution_to_json(resolution: SetupRunnerCommandResolution) -> Value {
    json!({
        "command": resolution.command,
        "runnerScriptPathForShell": resolution.runner_script_path_for_shell,
        "shell": match resolution.shell {
            SetupRunnerCommandShell::Posix => "posix",
            SetupRunnerCommandShell::Windows => "windows",
        },
    })
}

/// Maps the TS `SetupRunnerCommandPlatform` string ids to the Rust enum.
fn platform_from_id(id: &str) -> Option<SetupRunnerCommandPlatform> {
    match id {
        "windows" => Some(SetupRunnerCommandPlatform::Windows),
        "posix" => Some(SetupRunnerCommandPlatform::Posix),
        _ => None,
    }
}

/// Maps the Rust enum back to the TS `SetupRunnerCommandPlatform` string id.
fn platform_to_id(platform: SetupRunnerCommandPlatform) -> &'static str {
    match platform {
        SetupRunnerCommandPlatform::Windows => "windows",
        SetupRunnerCommandPlatform::Posix => "posix",
    }
}

/// Maps the TS `AgentStartupShell` string ids to the Rust enum.
fn startup_shell_from_id(id: &str) -> Option<AgentStartupShell> {
    match id {
        "posix" => Some(AgentStartupShell::Posix),
        "powershell" => Some(AgentStartupShell::Powershell),
        "cmd" => Some(AgentStartupShell::Cmd),
        "nushell" => Some(AgentStartupShell::Nushell),
        _ => None,
    }
}
