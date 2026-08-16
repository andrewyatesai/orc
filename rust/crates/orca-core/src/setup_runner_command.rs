//! Setup-runner command builder, ported from `src/shared/setup-runner-command.ts`.
//!
//! Builds the shell command that runs a worktree's setup-runner script,
//! cross-platform: WSL UNC paths (`\\wsl.localhost\<distro>\…`, either slash
//! style) are rewritten to their Linux path and run under `bash`; POSIX and
//! POSIX-style paths run under `bash` unless they look Windows-absolute
//! (`//server/…`); other Windows paths run under `cmd.exe /c`. Pure
//! (hand-rolled WSL/quoting; no regex).
//!
//! The command produced here is TYPED INTO A LIVE SHELL, so the delivery has to
//! match the shell that receives it (`terminal_shell_family`): Git Bash needs
//! MSYS path-conversion disabled and POSIX quoting (#6896), and nu treats `\` as
//! an escape inside `"…"` (#8928). `resolve_setup_runner_command` also reports
//! the path SPELLING the receiving shell will see, which is what
//! `setup-agent-sequencing` builds its completion marker from — a mismatch there
//! silently never completes.

use crate::cross_platform_path::is_windows_absolute_path_like;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupRunnerCommandPlatform {
    Windows,
    Posix,
}

/// The shell that will RECEIVE the built command, mirroring the twin's
/// `AgentStartupShell` (`src/shared/tui-agent-startup-shell.ts`). Kept here
/// rather than in a `tui_agent_startup_shell` module because only this delivery
/// decision consumes it so far; move it when that twin is ported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStartupShell {
    Posix,
    Powershell,
    Cmd,
    Nushell,
}

/// Which quoting dialect `runner_script_path_for_shell` is spelled in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupRunnerCommandShell {
    Posix,
    Windows,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupRunnerCommandResolution {
    pub command: String,
    pub runner_script_path_for_shell: String,
    pub shell: SetupRunnerCommandShell,
}

/// Pick the shell flavour to build the runner command for, from the script path
/// alone: Windows-absolute-like paths win (so WSL UNC paths reach the converter),
/// then POSIX-absolute paths, else the caller's fallback for ambiguous/relative
/// paths.
pub fn get_setup_runner_command_platform_for_path(
    runner_script_path: &str,
    fallback_platform: SetupRunnerCommandPlatform,
) -> SetupRunnerCommandPlatform {
    if is_windows_absolute_path_like(runner_script_path) {
        return SetupRunnerCommandPlatform::Windows;
    }
    if runner_script_path.starts_with('/') {
        return SetupRunnerCommandPlatform::Posix;
    }
    fallback_platform
}

pub fn build_setup_runner_command(
    runner_script_path: &str,
    platform: SetupRunnerCommandPlatform,
    terminal_shell_family: Option<AgentStartupShell>,
) -> String {
    resolve_setup_runner_command(runner_script_path, platform, terminal_shell_family).command
}

pub fn resolve_setup_runner_command(
    runner_script_path: &str,
    platform: SetupRunnerCommandPlatform,
    terminal_shell_family: Option<AgentStartupShell>,
) -> SetupRunnerCommandResolution {
    if platform == SetupRunnerCommandPlatform::Windows {
        // Why (#6298): WSL UNC must win before the POSIX-style branch so
        // forward-slash `//wsl.localhost/...` is rewritten, and `//server/...`
        // UNC-like paths fall through to cmd.exe instead of bash.
        if is_wsl_unc_path(runner_script_path) {
            let linux_path = wsl_unc_to_linux_path(runner_script_path);
            return SetupRunnerCommandResolution {
                command: format!("bash {}", quote_posix_arg(&linux_path)),
                runner_script_path_for_shell: linux_path,
                shell: SetupRunnerCommandShell::Posix,
            };
        }
        if runner_script_path.starts_with('/') && !is_windows_absolute_path_like(runner_script_path) {
            return SetupRunnerCommandResolution {
                command: format!("bash {}", quote_posix_arg(runner_script_path)),
                runner_script_path_for_shell: runner_script_path.to_string(),
                shell: SetupRunnerCommandShell::Posix,
            };
        }
        if terminal_shell_family == Some(AgentStartupShell::Posix) {
            // Why: Git Bash history-expands `!` inside double quotes and MSYS-converts /c to C:\ (#6896);
            // single-quote the .cmd path, disable path conversion, and keep sequencing in POSIX form.
            return SetupRunnerCommandResolution {
                command: format!(
                    "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c {}",
                    quote_posix_arg(runner_script_path)
                ),
                runner_script_path_for_shell: runner_script_path.replace('\\', "/"),
                shell: SetupRunnerCommandShell::Posix,
            };
        }
        if terminal_shell_family == Some(AgentStartupShell::Nushell) {
            // Why: nu double-quoted strings treat \ as an escape, so the .cmd path must be nu-escaped or the typed command errors.
            return SetupRunnerCommandResolution {
                command: format!("cmd.exe /c {}", quote_nu_double_quoted(runner_script_path)),
                runner_script_path_for_shell: runner_script_path.to_string(),
                shell: SetupRunnerCommandShell::Windows,
            };
        }
        return SetupRunnerCommandResolution {
            command: format!("cmd.exe /c {}", quote_windows_arg(runner_script_path)),
            runner_script_path_for_shell: runner_script_path.to_string(),
            shell: SetupRunnerCommandShell::Windows,
        };
    }

    SetupRunnerCommandResolution {
        command: format!("bash {}", quote_posix_arg(runner_script_path)),
        runner_script_path_for_shell: runner_script_path.to_string(),
        shell: SetupRunnerCommandShell::Posix,
    }
}

/// `/^\/\/(wsl\.localhost|wsl\$)\//i` over the backslash-normalised path.
///
/// Deliberately NOT `wsl_paths::is_wsl_unc_path`, and deliberately not the
/// `wsl-unc-paths.ts` shim over it. That pattern additionally requires a
/// non-empty distro segment, so it answers false for `//wsl.localhost/` where
/// this answers true; the shim on top of it also folds line-terminator tails to
/// "not a WSL path", which this does not. Both differences decide whether an
/// EXECUTED command is `bash …` or `cmd.exe /c …`. Two predicates, on purpose.
pub fn is_wsl_unc_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    normalized.starts_with("//wsl.localhost/") || normalized.starts_with("//wsl$/")
}

/// The characters JS `.` cannot match, which is what makes the twin's
/// `(\/.*)?$` tail fail on a Linux filename holding a newline (legal) or a path
/// lifted off a terminal stream keeping a stray CR.
fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i` -> group 2, else `/`.
pub fn wsl_unc_to_linux_path(windows_path: &str) -> String {
    let normalized = windows_path.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    let prefix = if lower.starts_with("//wsl.localhost/") {
        "//wsl.localhost/"
    } else if lower.starts_with("//wsl$/") {
        "//wsl$/"
    } else {
        return "/".to_string();
    };
    // After the prefix: `<distro>(/<path>)?`. The distro is up to the first `/`;
    // the path (from that `/` to the end) is the Linux path, else `/`.
    // `to_ascii_lowercase` preserves byte length, so `prefix.len()` is always a
    // boundary here; `get`/`split_once` say so totally instead of asserting it.
    let Some(after) = normalized.get(prefix.len()..) else {
        return "/".to_string();
    };
    match after.split_once('/') {
        // A line terminator in the tail makes the WHOLE twin regex fail (JS `.`
        // excludes them), and a failed match is `/` — not the tail. Measured
        // against the twin, not inferred: `//wsl$/Ubuntu/a\nb` is `/` there and
        // was `/a\nb` here.
        Some((distro, tail)) if !distro.is_empty() && !tail.chars().any(is_js_line_terminator) => {
            let mut linux_path = String::from("/");
            linux_path.push_str(tail);
            linux_path
        }
        _ => "/".to_string(),
    }
}

/// `src/shared/nushell-shell.ts` `quoteNuDoubleQuoted`: nu `"…"` escapes `\` and
/// `"` (and does NOT interpolate `$`). Inlined rather than imported because
/// `nushell-shell.ts` has no core module yet; move it when that twin is ported.
fn quote_nu_double_quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn quote_posix_arg(value: &str) -> String {
    if !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | ':' | '-'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn quote_windows_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use SetupRunnerCommandPlatform::{Posix, Windows};

    #[test]
    fn uses_bash_for_wsl_unc_runner_scripts_regardless_of_host_casing() {
        assert_eq!(
            build_setup_runner_command(
                r"\\WSL.LOCALHOST\Ubuntu\home\jin\repo\.git\worktrees\feature\orca\setup-runner.sh",
                Windows,
                None,
            ),
            "bash /home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh"
        );
    }

    #[test]
    fn uses_bash_on_posix() {
        assert_eq!(
            build_setup_runner_command("/home/me/orca/setup-runner.sh", Posix, None),
            "bash /home/me/orca/setup-runner.sh"
        );
    }

    #[test]
    fn single_quotes_posix_paths_with_unsafe_characters() {
        assert_eq!(
            build_setup_runner_command("/home/me/my repo/setup-runner.sh", Posix, None),
            "bash '/home/me/my repo/setup-runner.sh'"
        );
    }

    #[test]
    fn uses_cmd_for_plain_windows_paths() {
        assert_eq!(
            build_setup_runner_command(r"C:\Users\me\orca\setup-runner.cmd", Windows, None),
            "cmd.exe /c \"C:\\Users\\me\\orca\\setup-runner.cmd\""
        );
    }

    #[test]
    fn uses_bash_for_posix_style_paths_on_windows() {
        assert_eq!(
            build_setup_runner_command("/mnt/c/orca/setup-runner.sh", Windows, None),
            "bash /mnt/c/orca/setup-runner.sh"
        );
    }

    #[test]
    fn rewrites_forward_slash_wsl_unc_before_the_posix_branch() {
        assert_eq!(
            build_setup_runner_command("//wsl.localhost/Ubuntu/home/jin/run.sh", Windows, None),
            "bash /home/jin/run.sh"
        );
        assert_eq!(build_setup_runner_command("//WSL$/Ubuntu/home/x.sh", Windows, None), "bash /home/x.sh");
        assert_eq!(build_setup_runner_command("//wsl$/Ubuntu", Windows, None), "bash /");
    }

    #[test]
    fn platform_for_path_prefers_absolute_flavour_then_fallback() {
        // Absolute POSIX path wins POSIX even from a Windows client.
        assert_eq!(
            get_setup_runner_command_platform_for_path("/remote/repo/.git/orca/setup-runner.sh", Windows),
            Posix
        );
        // Native Windows drive path wins Windows even from a POSIX client.
        assert_eq!(
            get_setup_runner_command_platform_for_path(r"C:\repo\.git\orca\setup-runner.cmd", Posix),
            Windows
        );
        // WSL UNC (both slash styles) stays Windows so it can be converted.
        assert_eq!(
            get_setup_runner_command_platform_for_path(
                r"\\wsl.localhost\Ubuntu\home\jin\repo\.git\orca\setup-runner.sh",
                Posix,
            ),
            Windows
        );
        assert_eq!(
            get_setup_runner_command_platform_for_path("//server/share/repo/x.cmd", Posix),
            Windows
        );
        // Relative/ambiguous paths fall back to the caller's platform.
        assert_eq!(
            get_setup_runner_command_platform_for_path("orca/setup-runner.sh", Windows),
            Windows
        );
        assert_eq!(
            get_setup_runner_command_platform_for_path("./scripts/setup-runner.sh", Posix),
            Posix
        );
    }

    #[test]
    fn sends_forward_slash_windows_unc_like_paths_to_cmd() {
        assert_eq!(
            build_setup_runner_command("//server/share/x.cmd", Windows, None),
            "cmd.exe /c \"//server/share/x.cmd\""
        );
        assert_eq!(
            build_setup_runner_command("//wsl.localhost", Windows, None),
            "cmd.exe /c \"//wsl.localhost\""
        );
    }

    // ---- src/shared/setup-runner-command.test.ts, translated verbatim ----

    #[test]
    fn uses_bash_with_linux_paths_for_forward_slash_wsl_unc_runner_scripts() {
        assert_eq!(
            build_setup_runner_command(
                "//wsl.localhost/Ubuntu/home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh",
                Windows,
                None,
            ),
            "bash /home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh"
        );
    }

    #[test]
    fn keeps_generic_forward_slash_unc_runner_scripts_on_cmd_exe() {
        assert_eq!(
            build_setup_runner_command("//server/share/repo/.git/orca/setup-runner.cmd", Windows, None),
            "cmd.exe /c \"//server/share/repo/.git/orca/setup-runner.cmd\""
        );
    }

    #[test]
    fn delivers_native_windows_runners_through_posix_quoting_for_git_bash_terminals() {
        // #6896.
        assert_eq!(
            build_setup_runner_command(
                r"C:\repo\.git\orca\setup-runner.cmd",
                Windows,
                Some(AgentStartupShell::Posix),
            ),
            r"MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c 'C:\repo\.git\orca\setup-runner.cmd'"
        );
    }

    #[test]
    fn nu_escapes_the_cmd_path_for_nushell_terminals() {
        // #8928 PR4. Why: nu double-quoted strings treat \ as an escape;
        // unescaped C:\… errors when typed into nu.
        assert_eq!(
            build_setup_runner_command(
                r"C:\repo\.git\orca\setup-runner.cmd",
                Windows,
                Some(AgentStartupShell::Nushell),
            ),
            r#"cmd.exe /c "C:\\repo\\.git\\orca\\setup-runner.cmd""#
        );
    }

    #[test]
    fn keeps_cmd_exe_delivery_for_cmd_and_powershell_terminals() {
        assert_eq!(
            build_setup_runner_command(
                r"C:\repo\.git\orca\setup-runner.cmd",
                Windows,
                Some(AgentStartupShell::Cmd),
            ),
            r#"cmd.exe /c "C:\repo\.git\orca\setup-runner.cmd""#
        );
        assert_eq!(
            build_setup_runner_command(
                r"C:\repo\.git\orca\setup-runner.cmd",
                Windows,
                Some(AgentStartupShell::Powershell),
            ),
            r#"cmd.exe /c "C:\repo\.git\orca\setup-runner.cmd""#
        );
    }

    #[test]
    fn keeps_bash_delivery_for_wsl_unc_runners_regardless_of_terminal_shell_family() {
        assert_eq!(
            build_setup_runner_command(
                r"\\wsl.localhost\Ubuntu\home\jin\repo\.git\orca\setup-runner.sh",
                Windows,
                Some(AgentStartupShell::Posix),
            ),
            "bash /home/jin/repo/.git/orca/setup-runner.sh"
        );
    }

    // ---- resolve_setup_runner_command: the two fields build() throws away ----

    #[test]
    fn git_bash_delivery_reports_the_forward_slash_spelling_the_shell_will_see() {
        // setup-agent-sequencing builds its completion marker from this field, so
        // it must be the .cmd path as GIT BASH spells it, not as cmd.exe does.
        assert_eq!(
            resolve_setup_runner_command(
                r"C:\repo\.git\orca\setup-runner.cmd",
                Windows,
                Some(AgentStartupShell::Posix),
            ),
            SetupRunnerCommandResolution {
                command: r"MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c 'C:\repo\.git\orca\setup-runner.cmd'"
                    .to_string(),
                runner_script_path_for_shell: "C:/repo/.git/orca/setup-runner.cmd".to_string(),
                shell: SetupRunnerCommandShell::Posix,
            }
        );
    }

    #[test]
    fn nushell_delivery_keeps_the_backslash_spelling_and_the_windows_shell() {
        assert_eq!(
            resolve_setup_runner_command(
                r"C:\repo\.git\orca\setup-runner.cmd",
                Windows,
                Some(AgentStartupShell::Nushell),
            ),
            SetupRunnerCommandResolution {
                command: r#"cmd.exe /c "C:\\repo\\.git\\orca\\setup-runner.cmd""#.to_string(),
                runner_script_path_for_shell: r"C:\repo\.git\orca\setup-runner.cmd".to_string(),
                shell: SetupRunnerCommandShell::Windows,
            }
        );
    }

    #[test]
    fn wsl_delivery_reports_the_rewritten_linux_path_not_the_unc_one() {
        assert_eq!(
            resolve_setup_runner_command(
                r"\\wsl.localhost\Ubuntu\home\jin\run.sh",
                Windows,
                Some(AgentStartupShell::Nushell),
            ),
            SetupRunnerCommandResolution {
                command: "bash /home/jin/run.sh".to_string(),
                runner_script_path_for_shell: "/home/jin/run.sh".to_string(),
                shell: SetupRunnerCommandShell::Posix,
            }
        );
    }

    #[test]
    fn posix_platform_ignores_the_terminal_shell_family_entirely() {
        for family in [
            None,
            Some(AgentStartupShell::Posix),
            Some(AgentStartupShell::Cmd),
            Some(AgentStartupShell::Powershell),
            Some(AgentStartupShell::Nushell),
        ] {
            assert_eq!(
                resolve_setup_runner_command("/home/me/orca/setup-runner.sh", Posix, family),
                SetupRunnerCommandResolution {
                    command: "bash /home/me/orca/setup-runner.sh".to_string(),
                    runner_script_path_for_shell: "/home/me/orca/setup-runner.sh".to_string(),
                    shell: SetupRunnerCommandShell::Posix,
                }
            );
        }
    }

    // ---- the two WSL predicates this module owns ----

    #[test]
    fn wsl_unc_predicate_only_needs_the_share_prefix() {
        assert!(is_wsl_unc_path(r"\\WSL$\Ubuntu\x"));
        assert!(is_wsl_unc_path("//wsl.localhost/Ubuntu/x"));
        // No distro at all still satisfies THIS predicate (wsl_paths' does not).
        assert!(is_wsl_unc_path("//wsl.localhost/"));
        assert!(!is_wsl_unc_path("//wsl.localhost"));
        assert!(!is_wsl_unc_path("///wsl$/Ubuntu/x"));
        assert!(!is_wsl_unc_path(r"C:\Users\jin\repo"));
        assert!(!is_wsl_unc_path("/home/jin/repo"));
        // JS `/i` in non-unicode mode folds ASCII only: U+017F never matches `s`.
        assert!(!is_wsl_unc_path("//w\u{17f}l.localhost/x"));
    }

    #[test]
    fn wsl_unc_to_linux_path_falls_back_to_root_for_every_non_match() {
        assert_eq!(wsl_unc_to_linux_path(r"\\wsl$\Ubuntu\home\jin"), "/home/jin");
        assert_eq!(wsl_unc_to_linux_path("//wsl$/Ubuntu"), "/");
        assert_eq!(wsl_unc_to_linux_path("//wsl$/Ubuntu/"), "/");
        assert_eq!(wsl_unc_to_linux_path("//wsl.localhost/"), "/");
        // Empty distro: `[^/]+` cannot match, so the whole regex fails.
        assert_eq!(wsl_unc_to_linux_path("//wsl$//foo"), "/");
        assert_eq!(wsl_unc_to_linux_path(r"C:\x"), "/");
    }

    #[test]
    fn a_line_terminator_in_the_tail_fails_the_whole_match_like_js_dot_does() {
        for terminator in ['\n', '\r', '\u{2028}', '\u{2029}'] {
            assert_eq!(wsl_unc_to_linux_path(&format!("//wsl$/Ubuntu/a{terminator}b")), "/");
            // …and the command that gets EXECUTED follows it.
            assert_eq!(
                build_setup_runner_command(&format!("//wsl$/Ubuntu/a{terminator}b"), Windows, None),
                "bash /"
            );
        }
        // In the DISTRO it is fine — `[^/]` matches a line terminator.
        assert_eq!(wsl_unc_to_linux_path("//wsl$/Ub\nuntu/x"), "/x");
    }
}
