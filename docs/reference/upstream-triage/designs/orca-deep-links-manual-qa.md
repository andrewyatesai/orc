# Deep-links PR1 manual-QA matrix (wave-gate artifact)

Registration cannot be unit-tested (design `orca-deep-links.md` §10); the Wave-3 gate executes
this checklist against a packaged build of the `w3-deep-links` branch. PR1 scope: only
`orca://focus/term_<handle>` dispatches; `worktree`/`pair`/`run` must parse but toast
"This Orca link type is not supported yet".

Setup for every row: get a live handle via `orca terminal list --json` (field `handle`,
shape `term_<uuid>`). "cold" = app not running when the link is opened; "warm" = app running.

## macOS (packaged .dmg install)

- [ ] `open "orca://focus/term_<handle>"` **warm**: app surfaces, exact pane focused, no new instance.
- [ ] `open "orca://focus/term_<handle>"` **cold**: app launches; after startup the link is not lost
      (queued through the startup barrier). A stale handle from a previous run toasts
      "Terminal is no longer running" — the queue itself must still drain.
- [ ] `open "orca://worktree/x"` warm: toast "not supported yet", window surfaced, nothing else.
- [ ] `open "orca://bogus/x"` warm: toast "Unrecognized Orca link"; no focus change beyond surfacing.
- [ ] Fork-identity note (§3.2): with both ALab and public builds installed, note (don't fail)
      which app LaunchServices picked — record in the gate log.

## Windows (packaged NSIS per-user install)

- [ ] `start "" "orca://focus/term_<handle>"` **warm**: second instance exits, running app surfaces
      and focuses the pane (argv relay through the single-instance lock).
- [ ] Same **cold**: first-launch argv path picks up the URL; pane focused after startup.
- [ ] Second-instance junk argv: `start "" "orca://focus/term_<handle>"` while a file path and
      flags are also present in the shortcut args — only the orca:// arg is interpreted.
- [ ] `reg query HKCU\Software\Classes\orca` shows the class key; uninstall removes it.

## Linux

- [ ] deb install: `xdg-open "orca://focus/term_<handle>"` warm + cold (GNOME); on KDE confirm the
      after-install `xdg-mime default` made resolution work without re-login.
- [ ] `xdg-mime query default x-scheme-handler/orca` → `orca-ide.desktop`.
- [ ] AppImage **without** appimaged/AppImageLauncher (negative case): `xdg-open` fails to resolve —
      expected/documented degrade; verify a Cmd/Ctrl+click on an OSC-8 `orca://focus/...` link
      inside a pane still focuses the target (in-app path never touches the OS handler).

## Dev mode (`process.defaultApp`), all three platforms

- [ ] Without `ORCA_DEV_REGISTER_DEEP_LINKS=1`: `pnpm dev` performs **no** OS registration
      (a dev run must not steal the scheme from the installed app — Critic note 3).
- [ ] With `ORCA_DEV_REGISTER_DEEP_LINKS=1`: registration points at the dev shim and OS-routed
      links reach the dev instance.

## In-terminal OSC-8 path (any platform, packaged or dev)

- [ ] `printf '\e]8;;orca://focus/term_<handle>\e\\click me\e]8;;\e\\\n'` in a pane: link is
      underlined on hover (engine minted the scheme), Cmd/Ctrl+click focuses the target pane,
      plain click does nothing.
- [ ] Same sequence over an **SSH** worktree pane: click resolves in the local app; handle from the
      remote runtime resolves via the terminal.focus RPC fallback.
- [ ] `printf '\e]8;;orca://run?worktree=x&cmd=rm\e\\danger\e]8;;\e\\\n'`: Cmd/Ctrl+click toasts
      "not supported yet" — **must not** execute anything (PR2 owns run + consent).
- [ ] `javascript:`/`file:` OSC-8 links remain unlinkified (never-allow set untouched by the mint).
