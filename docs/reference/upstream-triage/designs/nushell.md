# Design: Nushell as a first-class shell (#8928)

- **Issue**: [#8928 — Add Nushell as a first-class supported shell](https://github.com/stablyai/orca/issues/8928) (`enhancement`, `os:Windows`; folds in #7715 — SSH relay Node detection under a nu login shell)
- **Audit verdict**: `still-applies`, high confidence — the only nu references in the fork are two "unsupported" comments (`src/main/pty/shell-startup-env.ts:64`, `src/main/agent-hooks/wsl-hook-relay-launch.ts:131`) plus `'nu'` already present in `SHELL_NAMES` (`src/shared/shell-process-detection.ts:5`). No spawn branch, no UI listing, no probe dialect.
- **aterm engine surface**: **None required.** The engine already parses everything nu emits (§9). One *optional* upstream-aterm follow-up is flagged there (Trust conventions apply if taken).
- **Effort**: **L** overall. Phase 1 (spawn + integration + settings, closes the headline ask) is M; Phase 2 (SSH dialect / #7715 + Windows surface + agent-startup quoting) is the rest.

---

## 1. Current architecture (research summary — do not re-derive)

| Concern | Seam |
|---|---|
| POSIX default-shell setting (#5097 port) | `src/shared/posix-terminal-shell.ts:9` `POSIX_TERMINAL_SHELL_CHOICES = ['zsh','bash','fish']`; resolver `src/main/posix-default-shell.ts:74` (`resolvePosixShellSettingPath`), availability probe `:99` (`detectPosixTerminalShells`, IPC `posixShells:detect` in `src/main/ipc/app.ts:268`, runtime RPC `src/main/runtime/rpc/methods/host-capabilities.ts:36`); static candidate dirs `:18` |
| POSIX spawn fold | `src/main/providers/local-pty-provider.ts:664-675` (shellOverride ∥ getPosixShell ∥ $SHELL ∥ /bin/zsh, args `['-l']`); wrapper selection `:785-823`; startup-command write + `bracketedPasteSafe` gate (bash/zsh only) `:1021-1034`; `getSpawnedShellName` `:395` |
| Shell-ready wrappers (copy 1, in-process) | `src/main/providers/local-pty-shell-ready.ts` — wrapper file list `:55-63`, zsh/bash/PowerShell launch-config switch `getWrappedShellLaunchConfig` `:359-408` (unknown shells → `{args:null, supportsReadyMarker:false}` `:403`), wrapper generation `ensureShellReadyWrappersAt` `:274`, stdin delivery `writeStartupCommandWhenShellReady` `:420` |
| Shell-ready wrappers (copy 2, daemon) | `src/main/daemon/shell-ready.ts` — wrapper paths `:74`, launch-config switch `:369`, **barrier gate `shellPathSupportsPtyStartupBarrier` `:352` (zsh∣bash only)**; consumed by `src/main/daemon/pty-subprocess.ts:8-11` and pre-computed for the Rust daemon by `src/main/daemon/daemon-shell-launch-config.ts:48` (daemon spawns verbatim) |
| Ready-marker scanners | TS `src/main/shell-ready-marker-scanner.ts:1-2` (**BEL-terminated only**, `\x1b]777;orca-shell-ready\x07`); Rust `rust/crates/orca-daemon/src/shell_ready_barrier.rs:19` (same prefix, BEL). Byte-level, shell-agnostic |
| OSC 133 consumers | engine drains `take_osc_events` (`src/renderer/src/lib/pane-manager/aterm/aterm_wasm.d.ts:912`, consumer `use-terminal-pane-lifecycle.ts`); C/D lifecycle `src/renderer/src/components/terminal-pane/terminal-command-lifecycle.ts:7,19`; shared scanner `src/shared/terminal-osc133-command-finished.ts:16-21` handles **BEL and ST** |
| OSC 7 consumers | `src/main/daemon/osc7-uri-extraction.ts` (BEL **and** ST, `:19-27`), used by `src/main/runtime/orca-runtime.ts:6313` |
| Windows shell family | sentinel + family classifier `src/shared/windows-terminal-shell.ts:3-37` (`git-bash` sentinel model); launch args `src/main/providers/windows-shell-args.ts:144-222` (cmd/PS/git-bash/wsl branches; unknown exe → no args `:217`); PS-only fallback chain `src/main/providers/windows-shell-fallback-chain.ts` (returns `[]` for non-PS); Git Bash resolution model `src/main/git-bash.ts:94-139`; win32 spawn fold `local-pty-provider.ts:599-663` + daemon mirror `pty-subprocess.ts` |
| Windows shell UI | `+` menu entries `src/renderer/src/components/tab-bar/TabBar.tsx:524-575` (gated by `windowsTerminalCapabilities.gitBashAvailable/wslAvailable`); icons `src/renderer/src/components/tab-bar/shell-icons.tsx:129-150`; Settings `TerminalWindowsShellSection.tsx:15-118`; onboarding `WindowsTerminalStep.tsx`; capability plumbing `src/main/ipc/preflight-remote-windows-terminal-capabilities.ts:4-15`, `src/preload/api-types.ts:662`, `src/preload/index.ts:2014`, `src/renderer/src/web/web-preload-api.ts:2611` |
| Startup-command quoting union | `AgentStartupShell = 'posix'∣'powershell'∣'cmd'` `src/shared/tui-agent-startup-shell.ts:3` + `tokenizeStartupCommand :61`, `resolveStartupShell :70` (platform-only!), `quoteStartupArg :77`, `buildShellCommandFromArgv :87`, `clearEnvCommand :98`, `commandSeparator :108`, `planAgentCliArgsSuffix :114`; Windows family mapper `windows-terminal-shell.ts:17`; consumers: `src/shared/setup-runner-command.ts:10`, renderer `launch-agent-in-new-tab.ts`, `launch-agent-background-session.ts`, `setup-runner.ts`, `folder-workspace-composer-submit.ts`, `useComposerState.ts`, `source-control-agent-action-plan.ts`, `ai-vault-resume-command.ts`, `github-work-item-background-request.ts`, `git-wasm/tui-agent-startup.ts` |
| PATH hydration | `src/main/startup/hydrate-shell-path.ts:95-115` spawns `$SHELL ['-lc', <POSIX printf>]`; static rc scan `src/main/startup/shell-startup-path.ts:67-95` (zsh/bash/fish; fallback `~/.profile`) |
| Startup-env peek | `src/main/pty/shell-startup-env.ts:51-68` — zsh/bash only, other shells deliberately scan nothing (`:64`) |
| History | `src/main/terminal-history.ts:21` local `ShellKind = 'zsh'∣'bash'∣'fish'∣'pwsh'∣'powershell'∣'cmd'∣'unknown'`; HISTFILE only for zsh/bash `:64-71,144` |
| Shell/agent status detection | `src/shared/shell-process-detection.ts:4-23` — **`nu` already in `SHELL_NAMES`** |
| SSH exec plumbing | login-shell command builder `src/main/ssh/ssh-login-shell-command.ts:6-11` (`<shell> -lc '<cmd>'`, csh gets `-c`); POSIX wrapper `wrapRemoteCommandForPosixShell` `src/main/ssh/ssh-connection-utils.ts:142-151` (**`exec /bin/sh -c … orca-command <chunks>`**; chunks are pre-escaped so they never contain `'`/`\`/`!` — `:114`); default-wrapped at `src/main/ssh/ssh-connection.ts:183`; node resolution `src/main/ssh/ssh-remote-node-resolution.ts:61` (wrapped strategy-1 script), `:143-156` (login-shell strategy → `command -v node` — **the #7715 failure**); `wrapCommand:false` raw sites: `ssh-connection.ts:840` (`echo ORCA-SYSTEM-SSH-OK`), `ssh-remote-platform-detection.ts:55` (PowerShell probe, Windows remotes), `ssh-relay-deploy.ts:1408` (Windows), `ssh-remote-node-resolution.ts:156/232/265` |
| WSL launch | `src/shared/wsl-login-shell-command.ts` — command path `buildWslLoginShellCommand :20-37` (known POSIX shells get `-ilc`, **unknown → `/bin/sh -lc` fallback, which is safe for nu**); interactive path `buildWslInteractiveLoginShellCommand :39-67` (bash/zsh wrapper cases `:53-64`, then `exec "$shell" -l` — a nu login shell *is* honored, just without integration) |
| macOS TCC | `src/main/providers/macos-tcc-login-shell.ts` wraps any shell path via `/usr/bin/login` — shell-agnostic pass-through |
| Quick Commands | `src/shared/terminal-quick-commands.ts:256-273` — multiline flattened with `'; '` (valid nu separator); delivery is a PTY stdin write |

---

## 2. Vocabulary: one nu-classification module

**New file `src/shared/nushell-shell.ts`** (concrete name per AGENTS.md — detection + dialect strings only, no spawn logic):

```ts
/** 'nu' / 'nu.exe' / versioned 'nu-0.104' basenames, path or bare, either slash. */
export function isNushellExecutableName(shellPathOrName: string): boolean

export const WINDOWS_NUSHELL_SHELL = 'nushell' // settings/menu sentinel, mirrors WINDOWS_GIT_BASH_SHELL

/** nu double-quoted literal: escapes \ and " ; $ is NOT interpolated in plain "…". */
export function quoteNuDoubleQuoted(value: string): string

/** `source "<path>"` payload for `-e`. */
export function buildNuSourceCommand(integrationFilePath: string): string

export const NUSHELL_INTEGRATION_MIN_VERSION = '0.96.0' // shell_integration record + all syntax in §4
```

Every branch below calls `isNushellExecutableName` — no site re-implements basename matching.

**Version gate.** **New file `src/main/pty/nushell-capability-probe.ts`**: `probeNushellIntegrationSupport(shellPath): Promise<boolean>` runs `<shellPath> --version` (bare semver line), compares against `NUSHELL_INTEGRATION_MIN_VERSION`; `getCachedNushellIntegrationSupport(shellPath): boolean | undefined` is the sync read used at spawn time. Semantics (mirrors the `GitCapabilityCache` philosophy from AGENTS.md — probe once, never re-run a known answer):

- Cache key = executable path; process-lifetime memo (same convention as `shell-startup-env.ts:124`); `__reset` test hook.
- `undefined` (never probed) → spawn **without** integration (plain `-l`, `supportsReadyMarker:false`) and fire the probe so the *next* spawn upgrades. Conservative-first: a below-floor nu must never receive `-e "source …"`, because a parse error in the sourced file aborts the whole source and (on some versions) the `-e` startup.
- Host isolation: this cache serves **local** spawns only. The WSL path version-checks inside the distro (§7), SSH injects nothing (§6). Tests must cover first-spawn-degraded → second-spawn-integrated, concurrent probes, and per-path isolation.

---

## 3. Spawn & launch config (POSIX + Windows)

### 3.1 POSIX (in-process + daemon copies)

`getWrappedShellLaunchConfig` — **both** copies (`local-pty-shell-ready.ts:359`, `daemon/shell-ready.ts:369`) gain, before the PowerShell branch:

```ts
if (isNushellExecutableName(shellName) && getCachedNushellIntegrationSupport(shellPath) === true) {
  ensureShellReadyWrappers()
  return {
    args: ['-l', '-e', buildNuSourceCommand(`${getShellReadyWrapperRoot()}/nu/integration.nu`)],
    env: { ORCA_SHELL_READY_MARKER: options.emitReadyMarker ? '1' : '0' },
    supportsReadyMarker: options.emitReadyMarker
  }
}
```

Rationale for `-l -e "source …"` (and not a config-dir override):

- nu runs `-e` **after** `env.nu`/`config.nu`(/`login.nu` with `-l`) and then enters the REPL, with env/config mutations from `-e` preserved — exactly the "after user rc files" slot the zsh `.zlogin`/bash `--rcfile` wrappers occupy.
- An `XDG_CONFIG_HOME` wrapper dir (ZDOTDIR-style) was rejected: nu resolves `$nu.default-config-dir` from it at startup, so user scripts that reference `$nu.default-config-dir` would silently point into Orca's wrapper dir, and the redirect leaks to non-nu children until restored.
- nu rejects combined short flags (`-lc`, `-le`) — always pass them split. This is load-bearing everywhere in this design.

Also: `daemon/shell-ready.ts:352` `shellPathSupportsPtyStartupBarrier` adds `|| (isNushellExecutableName(shellName) && getCachedNushellIntegrationSupport(shellPath) === true)` so the Rust daemon's stdin barrier (`shell_ready_barrier.rs`) engages for nu command sessions. `daemon-shell-launch-config.ts` and `pty-subprocess.ts` need **no** edits — they flow through the shared switch (plain sessions keep the `['-l']` default at `daemon-shell-launch-config.ts:91` / `local-pty-provider.ts:672`).

Wrapper generation: add `${root}/nu/integration.nu` to the file lists (`local-pty-shell-ready.ts:55-63` + `:316-322`; `daemon/shell-ready.ts:74`) with content from §4. Keep the two copies byte-identical and pin with a parity test (§10) — the header of `daemon-shell-launch-config.ts:1-13` explains why a third copy is forbidden.

### 3.2 Default-shell setting + detection (macOS/Linux)

- `src/shared/posix-terminal-shell.ts:9` → `['zsh','bash','fish','nu']`. The Settings segmented control (`TerminalPosixShellSection.tsx:47`) picks it up from the shared list; add the `nushell` search keyword in `terminal-posix-shell-search.ts` (i18n `englishOnly`, like `zsh`).
- `src/main/posix-default-shell.ts:37-67` (`getPosixShellCandidatePaths`): nu is commonly a cargo install — add home-relative candidates (`$HOME/.cargo/bin`, `$HOME/.local/bin`) resolved against `env.HOME`, appended after PATH-derived candidates. `/etc/shells` rarely lists nu; the existing PATH + static-dir fallback already covers brew/apt.
- Spawn fold: no change — `resolveLocalPosixShellOverride` (`posix-default-shell.ts:122`) already folds any resolved choice into `shellOverride`.

### 3.3 Windows

Mirror the `git-bash` sentinel end-to-end:

1. `src/shared/windows-terminal-shell.ts`: add `WINDOWS_NUSHELL_SHELL` re-export to the `BuiltInWindowsTerminalShell` union (`:5-9`); `resolveWindowsShellStartupFamily` (`:17`) returns the new `'nushell'` family for the sentinel / `nu.exe` basenames (§8).
2. **New file `src/main/windows-nushell.ts`** (mirror of `git-bash.ts:94-139`): `resolveWindowsNushellPath()` probes, in order: `%ProgramFiles%\nu\bin\nu.exe` (winget machine), `%LOCALAPPDATA%\Programs\nu\bin\nu.exe` (winget user), `%USERPROFILE%\scoop\shims\nu.exe`, `%ProgramData%\chocolatey\bin\nu.exe`, `%USERPROFILE%\.cargo\bin\nu.exe`, and **last** `%LOCALAPPDATA%\Microsoft\WindowsApps\nu.exe` (Store execution alias — same CreateProcessW-stub risk that motivated the pwsh fallback chain, `windows-shell-fallback-chain.ts:44-49`). `isNushellAvailable()`, `resolveWindowsNushellShellPath(shell)` (sentinel or explicit path → absolute exe).
3. `local-pty-provider.ts:608` + the `pty-subprocess.ts` win32 mirror: resolve the sentinel exactly where `resolveWindowsGitBashShellPath` is consulted (`:608`, `:623-625`), before PowerShell-family normalization, with the same "missing → powershell.exe" fallback as git-bash (`:625-626`).
4. `windows-shell-args.ts:144`: new branch before the default —
   ```ts
   if (isNushellExecutableName(shellBasename)) {
     return integrationSupported
       ? { shellArgs: ['-l', '-e', buildNuSourceCommand(nuIntegrationPath)], effectiveCwd: nativeCwd, validationCwd: nativeCwd }
       : { shellArgs: ['-l'], effectiveCwd: nativeCwd, validationCwd: nativeCwd }
   }
   ```
   Startup commands stay on stdin delivery (no `startupCommandDeliveredInShellArgs`) — §5. The integration path contains backslashes; `buildNuSourceCommand` double-quote-escapes them.
5. Capabilities: add `nushellAvailable` beside `gitBashAvailable` at all four plumbing points (`preflight-remote-windows-terminal-capabilities.ts:4-15`, `preload/api-types.ts:662`, `preload/index.ts:2014`, `web-preload-api.ts:2611`).
6. UI: `TabBar.tsx:545-550` — add a `Nushell` entry gated on `windowsTerminalCapabilities.nushellAvailable`; `shell-icons.tsx:129` — `NushellIcon` (styleguide tokens; keep the `GenericTerminalIcon` B/W palette convention `:98`); `TerminalWindowsShellSection.tsx` — option gated on `nushellAvailable` with the same "keep selected-but-missing visible" rule as git-bash (`:32`); `WindowsTerminalStep.tsx` onboarding mirrors the settings section.
7. macOS/Linux `+` menu: the fork has no POSIX shell submenu (menu visibility is `shouldShowWindowsShellMenu`, `windows-shell-menu-visibility.ts:1`). Adding one is **out of scope** here; the Settings default (§3.2) plus the existing per-tab `shellOverride` plumbing satisfies the issue's POSIX ask. Flagged as an optional follow-up issue.

---

## 4. The integration file (`shell-ready/nu/integration.nu`)

Generated by both wrapper writers; floor nu ≥ 0.96 (gate in §2 — every construct below exists there: `$env.FOO?` optional access, `try`, `def --env`, `shell_integration` record, `char esep`). Exact content:

```nu
# Orca nu shell-ready integration (generated - do not edit).
# Sourced via `nu -l -e "source ..."`: runs AFTER env.nu/config.nu/login.nu,
# mirroring the zsh .zlogin / bash --rcfile wrapper slot. Every section is
# guarded so one failure cannot take down the shell.

# -- Orca-managed env restoration (parity with the zsh/bash wrappers) --
def --env __orca_prepend_path [dir: string] {
  if ($dir | is-empty) { return }
  # Why: $env.PATH is a list under default ENV_CONVERSIONS but a plain string
  # when the user removed the conversion; normalize before editing.
  let parts = if (($env.PATH | describe) | str starts-with "list") {
    $env.PATH
  } else {
    $env.PATH | split row (char esep)
  }
  $env.PATH = ($parts | where {|p| $p != $dir } | prepend $dir)
}
try { __orca_prepend_path ($env.ORCA_ATTRIBUTION_SHIM_DIR? | default "") }
try { __orca_prepend_path ($env.ORCA_AGENT_TEAMS_SHIM_DIR? | default "") }
try { if $env.ORCA_OPENCODE_CONFIG_DIR? != null { $env.OPENCODE_CONFIG_DIR = $env.ORCA_OPENCODE_CONFIG_DIR } }
try { if $env.ORCA_MIMOCODE_HOME? != null { $env.MIMOCODE_HOME = $env.ORCA_MIMOCODE_HOME } }
try { if $env.ORCA_CODEX_HOME? != null { $env.CODEX_HOME = $env.ORCA_CODEX_HOME } }

# -- OSC 133 / OSC 7 via nu's native shell integration --
# Why: force-enable regardless of user config, matching the zsh/bash wrappers
# which unconditionally install Orca's OSC 133 hooks. nu emits 133;A/B/C/D
# (D with exit code) and OSC 7, ST-terminated; the engine accepts BEL and ST.
try {
  if (($env.config.shell_integration | describe) | str starts-with "record") {
    $env.config.shell_integration.osc133 = true
    $env.config.shell_integration.osc7 = true
  } else {
    $env.config.shell_integration = true   # pre-0.96 boolean (gate bypass safety net)
  }
}

# -- OSC 777 shell-ready marker at first prompt --
# Why a STRING hook: string hooks evaluate in the REPL context, so the
# once-guard env var persists across prompts; closure hooks would re-fire.
# Why BEL: both marker scanners (shell-ready-marker-scanner.ts,
# shell_ready_barrier.rs) accept ONLY the \x07 terminator.
try {
  $env.config.hooks.pre_prompt = (
    ($env.config.hooks.pre_prompt? | default [])
    | append 'if ($env.ORCA_SHELL_READY_MARKER? == "1") and ($env.__ORCA_SHELL_READY_SENT? == null) { $env.__ORCA_SHELL_READY_SENT = "1"; print -n $"(char esc)]777;orca-shell-ready(char bel)" }'
  )
}
```

Notes for the implementer:

- The hook string contains **no single quotes** by construction (nu single-quoted strings have no escape mechanism). Keep it one line.
- No `ORCA_OMP_STATUS_EXTENSION` section: `getPosixOmpShellWrapper()` is POSIX-syntax (`omp-shell-wrapper.ts`) and does not translate. nu + OMP users keep OMP's own `oh-my-posh init nu`; Orca's status-extension injection is a documented nu gap (degradation table §8).
- Marker timing parity: nu's pre_prompt hooks run before the prompt paints, i.e. the same "marker → prompt bytes follow" shape the scanner's `postMarkerBytesObserved` settle logic expects (`local-pty-shell-ready.ts:469-492`). No scanner change.

---

## 5. Startup-command delivery and quoting

- **Delivery**: unchanged stdin path (`writeStartupCommandWhenShellReady`, `local-pty-shell-ready.ts:420`) on all platforms. Do **not** embed the command in `-e` — running it pre-REPL would change job-control/session semantics vs. every other shell.
- **Bracketed paste**: `local-pty-provider.ts:1024` currently allows bash/zsh. Phase 2: extend to `spawnedShellName === 'nu'` when `getCachedNushellIntegrationSupport` is true (reedline has bracketed paste on by default ≥ 0.96 on non-Windows; the existing `process.platform !== 'win32'` guard stays). Until then multiline agent prompts to nu take the raw path — same as fish today.
- **Dialect for generated commands** (`AgentStartupShell`): add a `'nushell'` member at `tui-agent-startup-shell.ts:3`. TS exhaustiveness will surface every switch. Implementations:
  - `quoteStartupArg`: `"` + escape `\`→`\\`, `"`→`\"` (plain `"…"` does not interpolate `$` in nu).
  - `buildShellCommandFromArgv`: prefix `^` before the quoted head (`^"claude" "-p" "…"`) — nu requires the caret to run a quoted string as an external.
  - `clearEnvCommand`: `hide-env -i <name>`.
  - `commandSeparator`: `'; '`.
  - `tokenizeStartupCommand`: route to the POSIX tokenizer initially (single/double-quote splitting is compatible enough for templates; nu-specific escapes are a named follow-up).
  - Resolution: `resolveStartupShell` (`:70`) is platform-only — add `resolveLocalPosixAgentStartupShell({ platform, isRemote, terminalPosixShell })` in `posix-terminal-shell.ts` (POSIX mirror of `resolveLocalWindowsAgentStartupShell`, `windows-terminal-shell.ts:39`) returning `'nushell'` when the resolved default is nu, and wire it through the same renderer call sites that consume the Windows variant (list in §1). SSH stays `'posix'` (remote shell kind unknown; documented limitation).

---

## 6. SSH (#7715) — probes under a nu remote login shell

sshd runs every exec-channel command through `$SHELL -c`, so a nu login shell parses whatever we send. Three changes:

1. **Make the universal wrapper nu-parseable** — `wrapRemoteCommandForPosixShell` (`ssh-connection-utils.ts:150`): drop the leading `exec ` →
   `` `/bin/sh -c ${shellEscape(decodeAndRun)} orca-command ${chunkArguments}` ``.
   Why this is sufficient: `exec` is a nu builtin whose flag parsing intercepts `-c`; a bare absolute path (`/bin/sh`) is an external call in nu and unknown flags pass through. The argument strings are guaranteed quote-free — `encodeRemoteCommandForPrintf` octal-escapes `!`, `'`, `\` *before* quoting (`:114`) — so no POSIX `'…'\''…'` adjacency (which nu cannot parse) ever occurs, and nu/fish/csh/sh all read plain `'…'` literals identically. Cost: one extra `sh` process per exec on POSIX remotes. This single change fixes every default-wrapped probe (node strategy-1 script `ssh-remote-node-resolution.ts:61`, relay toolchain loops `ssh-relay-build-toolchain.ts:56-58`, uname probe `ssh-remote-platform-detection.ts:31`, `$SHELL` echo `ssh-remote-node-resolution.ts:145`, deploy/gc/lock commands).
2. **Login-shell strategy dialect** — `buildSshLoginShellCommand` (`ssh-login-shell-command.ts:6`): add a nu branch. Output for a nu shell:
   ```
   ^'<shell>' -l -c "^sh -c 'command -v node'"
   ```
   — caret + single-quoted head (nu can't exec a bare quoted path), **split** `-l -c`, and the probe body delegated to `sh` so the nu login config's PATH still applies (nu -l loads env/config/login, exports the ENV_CONVERSIONS-converted PATH to the `sh` child). Generalization: the nu branch takes the POSIX probe text and wraps it `^sh -c '<text>'`; assert the text contains no single quotes (true for the only caller, `ssh-remote-node-resolution.ts:155`) and fall back to the `/bin/sh` form otherwise.
3. **Raw (`wrapCommand:false`) sites** audit: `echo ORCA-SYSTEM-SSH-OK` (`ssh-connection.ts:840`) parses in nu (`echo` exists) — no change; the remaining raw sites are Windows/PowerShell probes (`ssh-remote-platform-detection.ts:55`, `ssh-relay-deploy.ts:1408`) — a nu `DefaultShell` on Windows OpenSSH is out of scope (documented). `ssh-remote-node-resolution.ts:232/265` execute a discovered absolute node binary — verify they go through the wrapper or a plain argv exec; if raw, they get the same `/bin/sh -c` treatment.

No shell-integration injection for SSH terminals — parity with remote zsh/bash, which also get no wrappers (no `shell-ready` references anywhere under `src/main/ssh/`).

---

## 7. WSL

`buildWslInteractiveLoginShellCommand` (`wsl-login-shell-command.ts:39-67`) already honors a nu login shell (`exec "$_orca_wsl_shell" -l`) — the issue's "unconditionally drops into bash" claim does not hold in the fork. Add a `nu)` case beside bash/zsh (`:53-64`):

```sh
nu)
  if [ -n "${_orca_shell_ready_root:-}" ] && [ -f "${_orca_shell_ready_root}/nu/integration.nu" ]; then
    _orca_nu_ver=$("$_orca_wsl_shell" --version 2>/dev/null | head -n1)
    if [ -n "$_orca_nu_ver" ] && [ "$(printf '%s\n0.96.0\n' "$_orca_nu_ver" | sort -V | head -n1)" = "0.96.0" ]; then
      exec "$_orca_wsl_shell" -l -e "source \"${_orca_shell_ready_root}/nu/integration.nu\""
    fi
  fi
  ;;
```

- The version gate runs **in-distro** (host isolation — the local capability cache must not answer for a WSL nu; `sort -V` is coreutils, present in every supported distro).
- The integration path is Linux-side (no backslashes), so the nu double-quoted source string needs no escaping.
- `ORCA_SHELL_READY_MARKER` must cross wsl.exe: add it to `addWslEnvKeys` where the launch env is assembled (`local-pty-provider.ts:744` cluster) — same mechanism as `CLAUDE_CONFIG_DIR` (`:763-766`).
- `buildWslLoginShellCommand` (`:20-37`) **stays unchanged on purpose**: its payload is POSIX text, and the `*) exec /bin/sh -lc` fallback is the correct behavior for nu (same reasoning as `wsl-hook-relay-launch.ts:131`).

---

## 8. Degradation matrix (hookless / old nu)

| Situation | Behavior | Mechanism |
|---|---|---|
| nu < 0.96 (local) | Plain `nu -l`; no marker, no forced OSC 133/7 | §2 gate → `supportsReadyMarker:false`; startup command falls back to the existing `STARTUP_COMMAND_READY_MAX_WAIT_MS` (1500 ms) timer (`local-pty-shell-ready.ts:35`) |
| nu < 0.96 (WSL) | Plain `nu -l` | in-distro `sort -V` gate (§7) |
| First-ever nu spawn (cache cold) | Same as < 0.96 for that one PTY | conservative-first probe (§2) |
| Integration file fails to write | PTY usable, no marker | existing wrapper-writer catch (`local-pty-shell-ready.ts:331-341`) |
| `source` runtime error inside a section | Shell up, remaining sections still run | per-section `try {}` (§4) |
| nu ≥ 0.96 with user-disabled `shell_integration` | Orca re-enables osc133/osc7 (documented; parity with unconditional bash/zsh hooks) | §4 |
| Agent status without integration | 133;C/D absent → existing slow path (process-name polling via `isShellProcess`, 30-min stale-status TTL) | `shell-process-detection.ts` (nu already listed) |
| oh-my-posh status extension | Not injected for nu | §4 note |
| History scoping | No HISTFILE injection (nu's history path is not env-overridable) | §9 table row `terminal-history.ts` |
| Remote nu login shell (SSH terminal) | Works, no integration (like remote zsh/bash) | §6 |
| Windows OpenSSH `DefaultShell = nu` | Unsupported, unchanged | §6.3 |

---

## 9. Engine boundary (aterm)

**No required engine work.** Verified surfaces:

- OSC parser accepts BEL **and** ST/0x9C terminators (`rust/aterm/crates/aterm-parser/src/dispatch.rs:49-66`, `action.rs:186,238`) — nu terminates its OSC 133/7 with ST; zsh/bash wrappers use BEL; both land in `take_osc_events` (`aterm_wasm.d.ts:912`) identically.
- The daemon ready-barrier is a shell-agnostic byte scan (`rust/crates/orca-daemon/src/shell_ready_barrier.rs:19`); the nu hook emits the required BEL-terminated marker (§4).
- The Rust daemon spawns client-computed argv verbatim (`daemon-shell-launch-config.ts:1-13`, `rpc.rs:538-631`) — the nu branch rides the existing wire shape (`shellOverride`/`shellArgs`/`env`), no protocol change.
- The fork does not wire `aterm-shell-integration`'s nonce path (`ATERM_SHELL_NONCE` has zero hits in `src/`), so nu's un-nonced OSC 133 is accepted like every other shell's.

**Optional follow-up (upstream aterm, not needed for #8928):** `aterm-shell-integration` (`rust/aterm/crates/aterm-shell-integration/src/lib.rs:66-107`) embeds zsh/bash/fish/PowerShell scripts for the standalone aterm apps; a `ShellType::Nushell` variant + embedded `aterm_shell_integration.nu` (argv-override injection, `-l -e source`, nonce-aware `133;A;id=` marks per #7960/#7987) would give the aterm GUI nu parity. If taken, it follows Trust conventions: the injection preparer is stateless (no `ty_model!` needed unless the prepare cache in `lib.rs:42` grows a nu-specific state machine), `spec_xref` registration for the new script constants and `ShellType` arm, macOS bundle byte-parity test extension (`lib.rs:46-50`), and adversarial review on the injected script (quoting, nonce echo, marker forgery).

---

## 10. Complete enumeration: every shell-classification site

Sites needing a **nu branch** (change):

| # | Site | Change |
|---|---|---|
| 1 | `src/shared/posix-terminal-shell.ts:9` | add `'nu'` to choices |
| 2 | `src/main/posix-default-shell.ts:37` | home-relative candidates (`~/.cargo/bin`, `~/.local/bin`) |
| 3 | `src/main/providers/local-pty-shell-ready.ts:359` | nu launch-config branch (§3.1) |
| 4 | `src/main/providers/local-pty-shell-ready.ts:55,316` | generate `nu/integration.nu` |
| 5 | `src/main/daemon/shell-ready.ts:369` | nu launch-config branch (copy 2) |
| 6 | `src/main/daemon/shell-ready.ts:74` | wrapper path list (copy 2) |
| 7 | `src/main/daemon/shell-ready.ts:352` | `shellPathSupportsPtyStartupBarrier` + nu (gated) |
| 8 | `src/main/providers/local-pty-provider.ts:1024` | `bracketedPasteSafe` + nu (Phase 2, gated) |
| 9 | `src/main/startup/hydrate-shell-path.ts:101-106` | nu: spawn `['-l','-c', '^sh -c \'printf %s%s%s __ORCA_SHELL_PATH__ "$PATH" __ORCA_SHELL_PATH__\'']` (split flags; `sh` child prints the ENV_CONVERSIONS-converted PATH — no version gate needed, parses on all nu) |
| 10 | `src/main/startup/shell-startup-path.ts:67-95` | nu: return `[]` (no static scan — nu PATH edits are code, not parseable exports; live probe #9 covers it). Must NOT fall into the `~/.profile` default |
| 11 | `src/main/terminal-history.ts:21,33-46,64` | classify `'nu'` explicitly → no HISTFILE injection (today it lands in `unknown`; make it deliberate + tested) |
| 12 | `src/shared/tui-agent-startup-shell.ts:3,61,70,77,87,98,108,114` | `'nushell'` member + five dialect fns (§5) |
| 13 | `src/shared/windows-terminal-shell.ts:5-9,17` | sentinel union member + `'nushell'` startup family |
| 14 | `src/shared/posix-terminal-shell.ts` (new fn) | `resolveLocalPosixAgentStartupShell` (§5) + its renderer call sites (§1 consumers row) |
| 15 | `src/main/windows-nushell.ts` (new) | Windows exe resolution (§3.3) |
| 16 | `src/main/providers/local-pty-provider.ts:608-635` + `pty-subprocess.ts` win32 mirror | sentinel resolution before PS-family normalization |
| 17 | `src/main/providers/windows-shell-args.ts:144` | `nu.exe` launch-args branch |
| 18 | `src/main/ipc/preflight-remote-windows-terminal-capabilities.ts:4-15` + `preload/api-types.ts:662` + `preload/index.ts:2014` + `web-preload-api.ts:2611` | `nushellAvailable` |
| 19 | `src/renderer/src/components/tab-bar/TabBar.tsx:545` | `+` menu entry (Windows) |
| 20 | `src/renderer/src/components/tab-bar/shell-icons.tsx:129` | `NushellIcon` |
| 21 | `src/renderer/src/components/settings/TerminalWindowsShellSection.tsx:32` | picker option |
| 22 | `src/renderer/src/components/onboarding/WindowsTerminalStep.tsx` | onboarding option |
| 23 | `src/renderer/src/components/settings/terminal-posix-shell-search.ts` | `nushell` keyword |
| 24 | `src/main/ssh/ssh-connection-utils.ts:150` | drop `exec ` from the wrapper (§6.1) |
| 25 | `src/main/ssh/ssh-login-shell-command.ts:6` | nu dialect branch (§6.2) |
| 26 | `src/shared/wsl-login-shell-command.ts:53-64` | `nu)` interactive case (§7) |
| 27 | `src/main/providers/local-pty-provider.ts:744` cluster | `ORCA_SHELL_READY_MARKER` in WSLENV (§7) |
| 28 | `src/main/pty/nushell-capability-probe.ts` (new) + `src/shared/nushell-shell.ts` (new) | §2 |

Sites verified **no change** (deliberate — record in PR description so nobody "fixes" them):

| Site | Why no change |
|---|---|
| `src/shared/shell-process-detection.ts:5` | `'nu'` already in `SHELL_NAMES`; add a regression test only |
| `src/main/pty/shell-startup-env.ts:64` | scanning zero files for nu is correct (nu has no `export X=` syntax); update the comment from "unsupported" to "nu: intentionally none" |
| `src/shared/wsl-login-shell-command.ts:20-37` | command payloads are POSIX text; `/bin/sh -lc` fallback is the right dialect |
| `src/main/agent-hooks/wsl-hook-relay-launch.ts:86,131` | deliberately routes via `sh`, comment already names nu |
| `src/main/providers/macos-tcc-login-shell.ts` | `/usr/bin/login` wrap is argv pass-through; nu args survive (test pins it) |
| `src/main/daemon/daemon-shell-launch-config.ts` / Rust daemon | flows through the shared switch; daemon spawns verbatim |
| `src/shared/terminal-quick-commands.ts:256-273` | `'; '` join is valid nu |
| `src/main/shell-ready-marker-scanner.ts`, `shell_ready_barrier.rs` | byte scans; nu hook emits the exact BEL marker |
| `src/shared/terminal-osc133-command-finished.ts:16-21`, `osc7-uri-extraction.ts:19-27` | both already accept BEL + ST |
| `src/main/attribution/terminal-attribution.ts:244,471`, `codex/hook-service.ts:824`, `cli/wsl-cli-*` | `command -v` lives inside `#!/bin/sh`-executed script bodies, not the user shell |
| `-lc` sites in `claude-accounts`/`codex-accounts`/`local-worktree-filesystem`/`rate-limits` | explicitly spawn `bash`/`sh`, never `$SHELL` |
| `src/shared/shell-process-detection.ts:29` (`isPowerShellProcess`) | PS-only Ctrl+L repaint nudge; nu prompt repaint not needed |
| aterm engine | §9 |

---

## 11. Named tests

Unit (colocated `.test.ts`, existing suites extended):

- `posix-default-shell.test.ts`: "detects nu from PATH and ~/.cargo/bin candidates"; "nu choice resolves an explicit path setting".
- `local-pty-shell-ready.test.ts`: "nu launch config uses split -l -e flags and sources the integration file"; "nu below the integration floor spawns plain -l with no ready marker"; "nu integration file emits a single BEL-terminated OSC 777 marker string" (static content assert against `SHELL_READY_MARKER` constant).
- `shell-ready parity`: "daemon and local nu integration files are byte-identical" (mirrors the aterm bundle-parity pattern).
- `nushell-capability-probe.test.ts`: "cold cache degrades first spawn and upgrades the next"; "concurrent probes coalesce"; "cache is per executable path".
- `hydrate-shell-path.test.ts`: "nu login shell probe uses split flags and sh-delegated PATH print"; "nu probe output parses through the delimiter scanner".
- `shell-startup-path.test.ts`: "nu returns no static startup files (and not ~/.profile)".
- `terminal-history.test.ts`: "nu is classified and receives no HISTFILE".
- `tui-agent-startup-shell.test.ts`: "nushell quoting escapes backslashes and double quotes"; "nushell argv command carries the external caret"; "clearEnvCommand uses hide-env -i".
- `windows-nushell.test.ts`: "resolution order prefers winget/scoop/choco/cargo over the WindowsApps alias"; "sentinel and explicit path both resolve".
- `windows-shell-args.test.ts`: "nu.exe launches -l -e with native cwd and stdin startup delivery".
- `windows-terminal-shell.test.ts`: "nushell sentinel maps to the nushell startup family".
- `ssh-login-shell-command.test.ts`: "nu login shell gets caret-quoted head, split flags, sh-delegated probe (#7715)".
- `ssh-connection-utils` test: "wrapped remote command has no exec prefix and chunk args never contain quote bytes".
- `wsl-login-shell-command.test.ts`: "nu login shell sources integration only when the in-distro version gate passes"; "pre-0.96 nu falls back to plain nu -l"; "command path still routes unknown shells through /bin/sh".
- Component: `TerminalPosixShellSection.test.tsx` "offers nu when detected"; `TerminalWindowsShellSection` + TabBar menu gating on `nushellAvailable`.
- `macos-tcc-login-shell` test: "login(1) wrap preserves nu -l -e argv".

Integration (real binaries, version matrix `0.96.0` + latest, mirroring `omp-shell-wrapper.node-pty.test.ts` and the Git real-binary CI contract from AGENTS.md):

- **new `nushell-integration.node-pty.test.ts`** (skips when `nu` absent): spawns the real launch config; asserts (a) OSC 777 BEL marker exactly once, (b) OSC 133 A/C/D observed around a command, (c) `-e` env/hook mutations survive into the REPL (the load-bearing `-e` semantics), (d) startup command echoes once post-marker, (e) `ORCA_ATTRIBUTION_SHIM_DIR` is PATH-front after startup.
- **`wrapRemoteCommandForPosixShell` matrix test**: the wrapped string executes correctly under `sh -c`, `fish -c`, and `nu -c` (adversarial: quote-bearing payloads, `!`/octal chunks, >1 KiB chunk splits).
- Adversarial review items: marker forgery from user config (pre-existing for bash/zsh — nu adds nothing new since the scanner is first-match); hook-string injection via userData path containing quotes (`buildNuSourceCommand` escaping test); Store-alias spawn failure fallback.

---

## 12. Phasing

- **PR 1 (M)** — §2 vocabulary+probe, §3.1/3.2 POSIX spawn + settings, §4 integration file, table rows 1–11, 23, 28; unit + node-pty integration tests. Ships the issue's headline: nu as default/available shell with OSC 133/7 + ready marker on macOS/Linux.
- **PR 2 (S)** — §6 SSH dialect (rows 24–25) + matrix test. Closes #7715.
- **PR 3 (M)** — §3.3 Windows surface + §7 WSL (rows 13, 15–22, 26–27).
- **PR 4 (S/M)** — §5 `AgentStartupShell 'nushell'` + `resolveLocalPosixAgentStartupShell` (rows 12, 14) and the bracketed-paste gate (row 8).
- Docs: `docs/reference/nushell-compatibility.md` (version floor, degradation table §8) — follows the `git-compatibility.md` pattern.

---

## Critic notes

Spot-checked 2026-07-22. Verified exactly as cited: `POSIX_TERMINAL_SHELL_CHOICES = ['zsh','bash','fish']` (:9), `getWrappedShellLaunchConfig` both copies (local-pty-shell-ready.ts:359, daemon/shell-ready.ts:369), `shellPathSupportsPtyStartupBarrier` (:351 — design says :352, one-line drift), `'nu'` already in `SHELL_NAMES` (shell-process-detection.ts:5), `wrapRemoteCommandForPosixShell` byte-for-byte as described (ssh-connection-utils.ts:142-151 — `exec /bin/sh -c ${shellEscape(decodeAndRun)} orca-command ${chunks}`; `decodeAndRun` contains no single quotes, so the post-`exec`-drop string is nu-parseable as claimed), `buildSshLoginShellCommand` with the csh/`COMMAND_ONLY_SHELLS` set (:3-8), `bracketedPasteSafe` bash/zsh-only gate (local-pty-provider.ts:~1021-1034). The complete-enumeration table is the strongest part of this design. Issues:

1. **§6.1 is a behavior change for every POSIX remote, not just nu** — dropping `exec` means the login shell survives as the parent of the `sh` child. Signal/timeout/cleanup paths that today signal an exec'd `sh` will now signal the login shell, and its signal-forwarding behavior varies by shell. The design costs this as "one extra sh process"; it must also regression-test the kill/timeout paths (relay exec abort, `execNonInteractive` timeouts) against bash/fish remotes, not only run the parse matrix.
2. **Cold-cache config can outlive the cold cache.** Daemon sessions spawn from a launch config pre-computed in main (`daemon-shell-launch-config`), and the Rust daemon replays stored configs on restart-recovery. A config computed while `getCachedNushellIntegrationSupport` was cold (plain `-l`) persists for that session's lifetime including daemon-side respawn. Acceptable, but add it to the §8 degradation table explicitly — "first spawn degraded" can actually mean "this session degraded until closed".
3. **§7 WSL version compare is fragile as sketched**: `nu --version` prints a bare version, but the sketch compares the *whole first line* against `0.96.0` via `sort -V`; a future `nu 0.104.0 (abc)`-style line would silently fail the gate (degrading safely, but wrongly). Strip to the leading `[0-9.]*` token first (`${_orca_nu_ver%% *}` or a `tr`-based cut).
4. **Row 9 (hydrate-shell-path)**: the proposed nu probe nests single quotes inside a single-quoted argv element as written in the table — recheck the exact quoting when implementing (the pattern is right: `-l -c` split flags, `^sh -c '…printf…'`; the inner printf body must avoid `'`).
5. §5's `resolveLocalPosixAgentStartupShell` fans out to ~10 renderer call sites (§1 consumers row) — that is the real cost of PR 4; keep it phased as designed and do not fold it into PR 1.

Effort L and the phasing stand. Engine claim (none required; optional upstream `ShellType::Nushell` correctly flagged with Trust obligations) is accurate — dispatch.rs BEL/ST acceptance verified.
