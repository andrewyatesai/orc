# Terminal / Daemon Upstream Issue Audit — ALab Fork

Audit of 154 upstream `stablyai/orca` terminal- and daemon-related issues against the fork at HEAD: 100 from the core terminal/daemon triage areas (sections below) plus 54 surfaced by a completeness keyword sweep over the rest of the open-issue corpus (see [Completeness sweep](#completeness-sweep)). Verdicts + full evidence: [`terminal-audit-verdicts.json`](./terminal-audit-verdicts.json) (sweep entries tagged `"source": "sweep"`).

## Headline

| Outcome | Count (core + sweep) |
| --- | --- |
| **Resolved by the fork** | **63** (48 + 15) |
| — by the aterm engine swap | 18 (18 + 0) |
| — by fork port commits | 32 (25 + 7) |
| — by upstream merges already in the fork | 13 (5 + 8) |
| Partially addressed (named gaps remain) | 37 (25 + 12) |
| Still applies | 37 (18 + 19) |
| Needs repro to decide | 17 (9 + 8) |

## Resolved by the fork — core audit

### Addressed by the aterm engine (18)

| Issue | Evidence (one line) |
| --- | --- |
| [#5024](https://github.com/stablyai/orca/issues/5024) | aterm file-path links: kind-2 link resolution, worktree/runtime/SSH-aware open (6393ce6d0) |
| [#5096](https://github.com/stablyai/orca/issues/5096) | Long-session agent-TUI slowdown: v0.56 flood-freeze fix; xterm/WebGL removed; cat-flood perf pins |
| [#5345](https://github.com/stablyai/orca/issues/5345) | Scroll corruption: engine-grid full-band repaint; xterm stale-frame duplication class gone |
| [#5919](https://github.com/stablyai/orca/issues/5919) | Large-paste hang: chunked, yielding, timeout-bounded paste pipeline replaces unchunked path |
| [#6491](https://github.com/stablyai/orca/issues/6491) | Transparency flicker: opacity baked into engine framebuffer; putImageData replaces pixels, no alpha stacking |
| [#6691](https://github.com/stablyai/orca/issues/6691) | Claude Code flood pins CPU/freezes UI: v0.56 DEC-2026 sync-hold + blocking-lock fixes |
| [#6905](https://github.com/stablyai/orca/issues/6905) | IME failures: composition overlay, Vietnamese/Telex native-text forwarder, commit-ordering fixes |
| [#7118](https://github.com/stablyai/orca/issues/7118) | Sidebar-toggle scroll yank: engine reflow preserves display_offset; transactional viewport ownership |
| [#7240](https://github.com/stablyai/orca/issues/7240) | Stale pixels on reveal: every frame is a full-canvas blit; reveal resumes with latest-state repaint |
| [#7951](https://github.com/stablyai/orca/issues/7951) | Hidden-pane garble: parked panes remount with fresh measurement; fits refuse unmeasurable containers |
| [#8038](https://github.com/stablyai/orca/issues/8038) | IME Enter race: composition owns keys; deferred/absorbed Enter (terminal-ime-deferred-newline) |
| [#8291](https://github.com/stablyai/orca/issues/8291) | Selection bleed into side panels: engine-internal canvas selection, no DOM selection can anchor |
| [#8399](https://github.com/stablyai/orca/issues/8399) | Option+L on German layout: composed printables flow as text unless kitty flag-8 negotiated |
| [#8563](https://github.com/stablyai/orca/issues/8563) | Wheel arrow-synthesis on inline TUIs: arrows only when engine `is_alt_screen`; normal buffer always scrolls |
| [#8733](https://github.com/stablyai/orca/issues/8733) | macOptionIsMeta "resets": option read live per event; engine owns kitty/modifyOtherKeys bytes |
| [#8754](https://github.com/stablyai/orca/issues/8754) | Frozen active tab (Windows): all sync holds bounded; re-attach marks full damage; scheduler force-release |
| [#9115](https://github.com/stablyai/orca/issues/9115) | Blank pane on focus cycle: xterm repaint path gone; focus/wake recovery re-presents engine frame |
| [#9116](https://github.com/stablyai/orca/issues/9116) | Links stop being clickable: links resolved live at click time against engine buffer; hover-cache reset ported |

### Addressed by fork port commits (25)

| Issue | Evidence (one line) |
| --- | --- |
| [#5097](https://github.com/stablyai/orca/issues/5097) | Configurable POSIX default shell + settings UI (5b6b70a7f) |
| [#5657](https://github.com/stablyai/orca/issues/5657) | Startup PATH probe: 5s timeout, static rc fallback, process-group SIGKILL (85d6db620) |
| [#6011](https://github.com/stablyai/orca/issues/6011) | `terminal wait --for tui-idle` requires 3s sustained output quiescence (81841fbf1) |
| [#6106](https://github.com/stablyai/orca/issues/6106) | Alt-screen snapshot split over remote wire keeps SSH Codex pre-TUI scrollback (cb205d50c) |
| [#6154](https://github.com/stablyai/orca/issues/6154) | Reflow surviving terminal on split collapse (88da2a14f) + prune unbound ghost leaves (233eea289) |
| [#6698](https://github.com/stablyai/orca/issues/6698) | Out-of-order Telex IME commits forwarded, duplicate echoes absorbed (015aead87) |
| [#7469](https://github.com/stablyai/orca/issues/7469) | Login shell spawn + configured POSIX shell + real rc sourcing on every local path |
| [#7777](https://github.com/stablyai/orca/issues/7777) | Paste OS-copied files as full shell-escaped paths, per-target-shell escaping (2832cd173) |
| [#7783](https://github.com/stablyai/orca/issues/7783) | `orca status` daemon visibility + `terminal stop --all` without the app (edc1f2033) |
| [#7936](https://github.com/stablyai/orca/issues/7936) | Rust daemon SIGTERM/SIGHUP teardown — macOS logout cannot orphan PTYs (3be477edf) |
| [#8104](https://github.com/stablyai/orca/issues/8104) | Input-undeliverable self-heal remount + fixes for each known concrete cause (9924b07bc et al.) |
| [#8156](https://github.com/stablyai/orca/issues/8156) | WSL worktree POSIX file links mapped to \\wsl.localhost UNC paths (eba15f8b4) |
| [#8335](https://github.com/stablyai/orca/issues/8335) | Mouse modes resynced from daemon engine's authoritative state on reveal/reattach (e69a5ce3e) |
| [#8362](https://github.com/stablyai/orca/issues/8362) | node-pty master FD_CLOEXEC patch, also delivered to SSH relay hosts (1197149fb) |
| [#8459](https://github.com/stablyai/orca/issues/8459) | Orphan bulk kill: confirm dialog + fresh-inventory re-verify + hydration gate (550e2acc5) |
| [#8860](https://github.com/stablyai/orca/issues/8860) | X11 middle-click double paste: native primary paste suppressed while fork write lands (2c0eb831b) |
| [#8871](https://github.com/stablyai/orca/issues/8871) | Stale mirror pty-exit becomes stream error — cannot kill live host sessions (f717aaf59) |
| [#8985](https://github.com/stablyai/orca/issues/8985) | macOS login(1) TCC preflight awaited at daemon-adapter spawn boundary, fail-closed (d6db3afff) |
| [#9057](https://github.com/stablyai/orca/issues/9057) | NODE_ENV scrubbed from all spawn-env builders incl. SSH relay (6607f1f9c) |
| [#9138](https://github.com/stablyai/orca/issues/9138) | Legacy daemon generations adopted at startup; sessions visible, routed, killable |
| [#9155](https://github.com/stablyai/orca/issues/9155) | Claude child-session env markers scrubbed in every spawn-env builder (6607f1f9c) |
| [#9352](https://github.com/stablyai/orca/issues/9352) | Stale runtime-host PTY tab bindings pruned on runtimeId churn (09e345a73) |
| [#9530](https://github.com/stablyai/orca/issues/9530) | Detached descendants swept on plain-terminal teardown, PID-reuse-guarded (5ffdc59b4) |
| [#9569](https://github.com/stablyai/orca/issues/9569) | Dead legacy daemon ENOENT tolerated during destructive worktree removal (d775566d3) |
| [#9585](https://github.com/stablyai/orca/issues/9585) | Same churn-prune as #9352 + Rust daemon reaps killed sessions from memory (09e345a73) |

### Addressed by upstream merges already in the fork (5)

| Issue | Evidence (one line) |
| --- | --- |
| [#2989](https://github.com/stablyai/orca/issues/2989) | Hidden automation worktrees background-mounted before launch (eb89255e8, #6568) |
| [#5352](https://github.com/stablyai/orca/issues/5352) | Customizable keybindings; Ctrl+Shift+C/V + Shift+Insert terminal defaults (6408e49db, #2581) |
| [#6914](https://github.com/stablyai/orca/issues/6914) | Floating Workspace already provides a project-less global terminal (406304c5e, #1724) |
| [#8457](https://github.com/stablyai/orca/issues/8457) | Serve desktop-activation gating; `orca open` fails closed on blocked desktop (1d2aaf1bf, #8646) |
| [#9079](https://github.com/stablyai/orca/issues/9079) | Transactional viewport ownership; scroll intent restored only after replay parses (69c14fadc, #8674) |

## Partially addressed — core audit (25)

| Issue | What landed | Remaining gap |
| --- | --- | --- |
| [#1308](https://github.com/stablyai/orca/issues/1308) | Windows hook mangling fixed; spawn-env partly centralized | Cross-layer hook-ownership refactor not done (~10 per-agent hook services) |
| [#5611](https://github.com/stablyai/orca/issues/5611) | Selection replaced; no false success hint | Failed Windows clipboard write still silent (empty `.catch`) |
| [#6635](https://github.com/stablyai/orca/issues/6635) | PTY SIGABRT fixed; PTYs isolated in Rust daemon | Non-PTY native-module Napi abort can still kill the serve process |
| [#6874](https://github.com/stablyai/orca/issues/6874) | Windows aterm + CPU default renderer + hardened pipe transport | Workspace-activation hang trigger (WSL UNC I/O) unpinned |
| [#6880](https://github.com/stablyai/orca/issues/6880) | OSC 1337/sixel inline images; XTGETTCAP; TERM_PROGRAM + FORCE_HYPERLINK | Hardcoded-allowlist TUIs (pi-tui); no published capability doc |
| [#6977](https://github.com/stablyai/orca/issues/6977) | Daemon sessions survive disconnect on the serve host | No multi-client RDP-style desktop attach to remote serve |
| [#7084](https://github.com/stablyai/orca/issues/7084) | Native chat composer (slash/@-mention/skill, attachments) | No Warp-style rich editor for shell command composition |
| [#7147](https://github.com/stablyai/orca/issues/7147) | `--serve-port` honored; graceful bind fallback | Desktop launch still hardcodes WS port 6768, no setting |
| [#7175](https://github.com/stablyai/orca/issues/7175) | Shared worker + QoS + flood drain + ACK backpressure | Windows main-process "Not responding" half and OOM unproven |
| [#7425](https://github.com/stablyai/orca/issues/7425) | Composer shipped; engine has sub-row scroll APIs | Smooth scrolling unwired (row-quantized); no in-terminal rich input |
| [#7441](https://github.com/stablyai/orca/issues/7441) | Daemon survival + persisted `codex resume` cold-restore machinery | OS-reboot resume path unverified end-to-end |
| [#7443](https://github.com/stablyai/orca/issues/7443) | Reattach/kill race + write-throw + self-heal fixes | ConnectionRefused loop + false sandbox report unexplained |
| [#7467](https://github.com/stablyai/orca/issues/7467) | Wide pwsh discovery incl. registry PATH merge | No free-text custom shell binary path setting |
| [#7596](https://github.com/stablyai/orca/issues/7596) | Restored scrollback shows last command; blank-restore class fixed | No prefill/offer to re-run the last command |
| [#7779](https://github.com/stablyai/orca/issues/7779) | Default-shell settings on all local platforms | No per-SSH-remote shell override (explicitly local-only) |
| [#7870](https://github.com/stablyai/orca/issues/7870) | PATH probe + static rc recovery + login-shell agent spawns | Non-PATH rc env vars miss direct main-process spawns |
| [#8275](https://github.com/stablyai/orca/issues/8275) | Rust daemon replaces crashing Node daemon; targeted fixes | No Windows batch `worktree rm --force` repro test; daemon death still fatal to sessions |
| [#8367](https://github.com/stablyai/orca/issues/8367) | Automatic locale-aware OS font fallback injection | No user-configurable ordered fallback list |
| [#8594](https://github.com/stablyai/orca/issues/8594) | Descendant sweep on teardown; physical-stop before removal | Dev Electron staged inside worktree; removal doesn't await 2s kill grace |
| [#8977](https://github.com/stablyai/orca/issues/8977) | No false-success toast; copy routed via main-process clipboard | Windows 10 clipboard write success unverified |
| [#9195](https://github.com/stablyai/orca/issues/9195) | Empty-daemon retirement (#9277) merged; disconnect-only quit | Rust daemon lacks `shutdownIfIdle` — empty daemon can linger after quit |
| [#9229](https://github.com/stablyai/orca/issues/9229) | Safety half: confirm, fail-closed listing, exit gating, descendant sweep | No survivor provenance/classification UI; CLI dials only current-generation socket |
| [#9329](https://github.com/stablyai/orca/issues/9329) | Engine mouse encoding + mode resync + atomic conin writes + Codex scrollback | SSH-relay → Windows ConPTY wheel-report leg unproven |
| [#9454](https://github.com/stablyai/orca/issues/9454) | Logout teardown fixed; TCC/PAM preflight hardened | Per-tab manual `claude /resume` still required; no auto-resume on daemon death |
| [#9562](https://github.com/stablyai/orca/issues/9562) | Alt-screen snapshot split fixes the main blank-restore class | Remote snapshots >2 MiB dropped wholesale → no history on reattach |

## Still applies — core audit (18), ordered by importance for a terminal-focused fork

| # | Issue | Why it matters / what's missing |
| --- | --- | --- |
| 1 | [#9156](https://github.com/stablyai/orca/issues/9156) | Every viewing renderer auto-answers CPR/DA queries — host + desktop viewer both reply, corrupting the PTY stream; election is mobile-only |
| 2 | [#8652](https://github.com/stablyai/orca/issues/8652) | SSH/remote panes are excluded from hidden-view parking — per-hidden-tab memory scales unbounded for SSH-heavy workflows |
| 3 | [#9169](https://github.com/stablyai/orca/issues/9169) | `send` returns accepted:true against cached flags (no live-pid check); `read`/`show` disagree on liveness — breaks automation |
| 4 | [#9163](https://github.com/stablyai/orca/issues/9163) | Renderer reload re-mints terminal handles; messages to stale handles silently become inbox-only |
| 5 | [#9193](https://github.com/stablyai/orca/issues/9193) | `closeTerminal` vs `closeTerminalTab` liveness models diverge — floating-terminal handles hit `terminal_tab_not_found` on a live PTY |
| 6 | [#9584](https://github.com/stablyai/orca/issues/9584) | Linux port attribution silently degrades to "Unknown process" on EACCES/ptrace_scope /proc reads; no diagnostics |
| 7 | [#7934](https://github.com/stablyai/orca/issues/7934) | minimumContrastRatio hardcoded 4.5 and pushed into the engine; Settings UI explicitly refuses to make it configurable |
| 8 | [#8595](https://github.com/stablyai/orca/issues/8595) | Bold color persisted, shown in Settings, imported from Ghostty — but aterm theme bridge/engine have no bold-color slot |
| 9 | [#8516](https://github.com/stablyai/orca/issues/8516) | Per-pane font zoom is unpersisted ref state — lost on any remount (view switch, cold-parking) |
| 10 | [#9279](https://github.com/stablyai/orca/issues/9279) | No right-click link/path context-menu actions (open/copy/reveal); link activation stays modifier-click only |
| 11 | [#9338](https://github.com/stablyai/orca/issues/9338) | No user-defined send-text/escape-sequence keybindings; sendInput sequences hardcoded |
| 12 | [#8928](https://github.com/stablyai/orca/issues/8928) | No Nushell support — named only in "unsupported" comments; POSIX `command -v` probes survive |
| 13 | [#6034](https://github.com/stablyai/orca/issues/6034) | No terminal compose box for drafting multi-line input (bracketed-paste primitive exists, unbuilt) |
| 14 | [#8481](https://github.com/stablyai/orca/issues/8481) | Quick Commands can't be defined in project orca.yaml — local settings only |
| 15 | [#7333](https://github.com/stablyai/orca/issues/7333) | Pasted clipboard images still written to the temp-directory root (local and SSH), no orca subdirectory |
| 16 | [#4384](https://github.com/stablyai/orca/issues/4384) | No orca:// protocol handler — no OS scheme registration, OSC link routing only http/https/file |
| 17 | [#8381](https://github.com/stablyai/orca/issues/8381) | Session-scoped macOS TCC AppData prompt untouched (largely OS-side policy) |
| 18 | [#9033](https://github.com/stablyai/orca/issues/9033) | Herdr integration entirely absent — large external feature request |

## Needs repro — core audit (9)

| Issue | Deciding experiment |
| --- | --- |
| [#5157](https://github.com/stablyai/orca/issues/5157) | macOS fork build: press Cmd+D in a terminal tab, verify the split persists; compare Cmd+Shift+D and CLI split |
| [#6186](https://github.com/stablyai/orca/issues/6186) | Copy/paste a `.opencode` path through an aterm pane, hex-dump for `e2 80 8d`; separately inspect agent tool-call Read bytes |
| [#6634](https://github.com/stablyai/orca/issues/6634) | Determine whether typing fails terminal-only (kitty-protocol app → likely covered by engine input cutover) or app-wide |
| [#6795](https://github.com/stablyai/orca/issues/6795) | Check whether app-wide latency tracks an active flooding terminal session (covered) or occurs with none (uncovered) |
| [#7038](https://github.com/stablyai/orca/issues/7038) | At a live Claude Code 1/2/3 prompt, instrument PTY input bytes on click-to-focus: `\x1b[I` vs SGR mouse report vs real `\r` |
| [#7442](https://github.com/stablyai/orca/issues/7442) | Windowless worktree: `orca terminal create --command "claude ..."` ~7 times; watch for 0%-CPU kevent64 hangs pre-paint |
| [#7705](https://github.com/stablyai/orca/issues/7705) | macOS fork build: Cmd+V and menu Edit > Paste in a plain shell and a bracketed-paste TUI pane |
| [#7848](https://github.com/stablyai/orca/issues/7848) | Seed a stale bootstrap file while the app runs; run `status` → `open` → `terminal show` → `status` (non-ASCII path) and watch for flap |
| [#8751](https://github.com/stablyai/orca/issues/8751) | Windows fork build: close/reopen with live agent tabs; compare any error surface against the Discord screenshot |

## Completeness sweep

To close coverage gaps, all open upstream issues that keyword-match terminal/PTY/daemon/relay concerns but were triaged into *other* areas (mobile, remote-runtime, agents, settings, …) were relevance-swept: **241 candidates** triaged, of which **54 are genuinely terminal-stack** and received full verdicts (below, tagged `"source": "sweep"` in the JSON). The remaining 187 are terminal-adjacent only (the terminal keyword is incidental to a non-terminal defect). Sweep verdicts are folded into the headline counts above.

### Sweep: addressed by upstream merges already in the fork (8)

| Issue | Evidence (one line) |
| --- | --- |
| [#5111](https://github.com/stablyai/orca/issues/5111) | WSL vs PowerShell per project: per-project Windows runtime selection wired into terminal spawn (0ec3882cb, #5519); per-project *host-shell* pick still global |
| [#6150](https://github.com/stablyai/orca/issues/6150) | Terminals on remote hosts: SSH remote support is first-class upstream — relay PTYs, multi-host workbench, Windows SSH hosts (cc66e120e #590 et al.) |
| [#6995](https://github.com/stablyai/orca/issues/6995) | Android Hangul jamo decomposition: capture-field rework + Hangul mirror model (4f0a14195 #7011, e8c2b79a9 #7273) |
| [#7350](https://github.com/stablyai/orca/issues/7350) | Codex under the mobile prompt: height-refit series stops over-fitting PTY rows before the live-input dock lays out (e04ca97dc #8647, 8e17e75a3 #8707) |
| [#7372](https://github.com/stablyai/orca/issues/7372) | Focus lost switching projects: all three active-tab fallbacks now honor per-worktree remembered selection (1a4232fe9, #7385) |
| [#7495](https://github.com/stablyai/orca/issues/7495) | Chinese IME unusable on mobile: default-keyboard + textContentType fixes restore IME selection (423c2befe #5876, 9bd439ccb #6176); mirror still Korean-gated |
| [#7830](https://github.com/stablyai/orca/issues/7830) | iOS keyboard can't be hidden: explicit dismiss control in the terminal command dock, outside the customizable key path (60037d60a, #5917) |
| [#8363](https://github.com/stablyai/orca/issues/8363) | Terminal-cwd test failure on main: store double now stubs getRepo (via 8ed8f0d10); vitest run passes 4/4 in the fork |

### Sweep: addressed by fork port commits (7)

| Issue | Evidence (one line) |
| --- | --- |
| [#8585](https://github.com/stablyai/orca/issues/8585) | Orphaned detached relays: pidfile + ownership-verified kill -TERM before relaunch after failed --connect (9f652b5f7, port #8618) |
| [#8608](https://github.com/stablyai/orca/issues/8608) | Relay CLI shadowed by host `orca`: wrappers strip + prepend ORCA_REMOTE_CLI_BIN_DIR after user rc files run (a01894a6e) |
| [#8711](https://github.com/stablyai/orca/issues/8711) | Dead Codex hooks in SSH worktrees: CODEX_HOME/ORCA_CODEX_HOME pinned into every relay spawn + wrapper re-export + remote managed-hook install (d13dcd218, e9549a37c) |
| [#8878](https://github.com/stablyai/orca/issues/8878) | Duplicate TUIs from remote-client resume: runtime-owner gate on sleeping-session resume, with repro test (8c573b466, port #9098) |
| [#9045](https://github.com/stablyai/orca/issues/9045) | Windows worktree deletion blocked by orphans: RestartManager handle sweep + teardown descendant-kill layers (9eb34d87e, 40d015992, 5ffdc59b4) |
| [#9151](https://github.com/stablyai/orca/issues/9151) | Disconnect misread as agent completion: unavailable-inspection + no_connected_pty→disconnected, exit confirmed via terminal.wait (354973c29, 5989c657c) |
| [#9586](https://github.com/stablyai/orca/issues/9586) | AttachConsole crash on Windows SSH relay: patched ConPTY console-list agent bundled and delivered over npm install (node-pty patch, 1197149fb, 9261d73f4) |

### Sweep: partially addressed (12)

| Issue | What landed | Remaining gap |
| --- | --- | --- |
| [#2323](https://github.com/stablyai/orca/issues/2323) | Resize-ownership arbitration + reattach/restore cluster (merges + ports) | Presence UI has no renderer consumer; no explicit `claude --resume` affordance |
| [#7074](https://github.com/stablyai/orca/issues/7074) | Windows built-in shells + WSL + ported POSIX default-shell setting (5b6b70a7f) | Embedding the Windows Terminal app unsupported; no custom shell binary paths |
| [#7094](https://github.com/stablyai/orca/issues/7094) | Keystrokes as ordered binary frames (359f5d171) + IME composition merges | Diff-based hidden-TextInput capture unchanged; no Android device repro |
| [#7427](https://github.com/stablyai/orca/issues/7427) | Mid-composition clear removed; verbatim echo + erase/append delta mirror | Composition-hold is Hangul-only; Japanese pre-edit still streams to the PTY |
| [#7433](https://github.com/stablyai/orca/issues/7433) | `terminal read --help` now documents cursor-based paging | Full `--json` result schema still undocumented in help |
| [#8180](https://github.com/stablyai/orca/issues/8180) | Bounded-backoff resubscribe + event-driven rebind; timeout-reset amplifier deleted (6be4e2939) | Socket liveness still kills a healthy socket on the first post-sleep tick |
| [#8591](https://github.com/stablyai/orca/issues/8591) | Worktree resync + idempotent notification replay on reconnect (8e0977d29) | Stuck mobile terminal-driver input lock (#4500) and error classification (#6784) unfixed |
| [#9414](https://github.com/stablyai/orca/issues/9414) | Stale-exit-waiter + exit-confirmation ports close the main kill vector (f717aaf59, 5989c657c) | Close-intent schema, CLAUDE_CONFIG_DIR hook install, RC2 recognition inversion unshipped |
| [#9450](https://github.com/stablyai/orca/issues/9450) | Stale-mirror exit gating + runtimeId-churn/headless tab prunes | Phantom un-closable FILE tabs unaddressed; 3-way desync undiagnosed |
| [#9479](https://github.com/stablyai/orca/issues/9479) | Ownership-scoped reap of hidden automation tab/PTY at run completion (1cd1a6783) | Headless/serve dispatcher never retires terminals; cross-reload reconciliation unproven |
| [#9490](https://github.com/stablyai/orca/issues/9490) | 50 ms mobile-aware server-side output flush window (661e33f77) | No cap/stagger on home-screen reconnect probes |
| [#9576](https://github.com/stablyai/orca/issues/9576) | aterm 0%-idle guarantees + spinner clock stop (4d25de383) + polling duty-cycle | No powermetrics verification; opt-in vibrancy blur path remains |

### Sweep: still applies (19)

| Issue | Why it still applies (one line) |
| --- | --- |
| [#1693](https://github.com/stablyai/orca/issues/1693) | Pre-bundled node-pty for the relay explicitly unimplemented (`TODO(#1693)` in ssh-relay-deploy.ts:686); remote npm install and its failure class remain |
| [#7093](https://github.com/stablyai/orca/issues/7093) | Android terminal cursor: mobile xterm WebView stays unfocused with cursorInactiveStyle 'none' — no cursor rendered, no caret overlay exists |
| [#7209](https://github.com/stablyai/orca/issues/7209) | CONFIRMED: relay attach() never resizes to the client's cols/rows (pty-handler.ts:972) while resize() does; drift invisible to renderer reassertion |
| [#7345](https://github.com/stablyai/orca/issues/7345) | Mobile Close → resurrection chain intact: handle-only close, pending-handle republish, auto-materialize respawn; #8958 closeTab infra exists but unwired |
| [#7400](https://github.com/stablyai/orca/issues/7400) | CONFIRMED: single overloaded snapshotVersion counter unchanged — live bumps can permanently out-race structural snapshots and pin a stale one-tab view |
| [#8263](https://github.com/stablyai/orca/issues/8263) | Only splitRight/splitDown + next/previous focus exist; no spatial/directional pane actions anywhere in the repo |
| [#8313](https://github.com/stablyai/orca/issues/8313) | iPhone caret: same mobile WebView cursorInactiveStyle 'none' config; fork cursor work targets desktop aterm only |
| [#8537](https://github.com/stablyai/orca/issues/8537) | Onboarding persists wsl.exe while Settings maps it to powershell.exe and hides WSL — mismatch locked in by test |
| [#8771](https://github.com/stablyai/orca/issues/8771) | RuntimeTerminalSummary (list/show payload) has no surface field; surface exists only on create |
| [#8793](https://github.com/stablyai/orca/issues/8793) | Cursor .cmd argv-prompt block intact: UnsafeWindowsBatchArgumentsError guard + argv preset; no stdin fallback or .ps1 rerouting |
| [#8795](https://github.com/stablyai/orca/issues/8795) | prepareClaudeAuth gated on `!args.connectionId` in both spawn paths; zero CLAUDE_CONFIG_DIR handling in the SSH relay |
| [#8801](https://github.com/stablyai/orca/issues/8801) | Mobile WebView font stack hardcoded; no font embedding/assets/setting; Nerd Font bundling is desktop-only |
| [#8818](https://github.com/stablyai/orca/issues/8818) | Mobile input is touch-synthesis only; no pointerType handling for external Bluetooth mice |
| [#8962](https://github.com/stablyai/orca/issues/8962) | OMP absent from RESUMABLE_TUI_AGENTS; extractAgentProviderSession returns null for omp — cold restore never builds `omp --resume` |
| [#9034](https://github.com/stablyai/orca/issues/9034) | SSH lease upsert dedupes only by (targetId, ptyId); replacement PTYs for one pane accumulate with no supersede-expiry |
| [#9092](https://github.com/stablyai/orca/issues/9092) | Shared-control reconnect still caps at ~31s then permanently finishes; no wake-triggered runtime resubscribe |
| [#9194](https://github.com/stablyai/orca/issues/9194) | Phantom pane still unclosable: 15s no-handle banner, console.warn-only close failure, 10s close-intent TTL lets the tab reappear |
| [#9276](https://github.com/stablyai/orca/issues/9276) | Pre-report paired-client SSH-state fixes predate the reporter's 1.4.144; nothing since targets proxying a hub's SSH worktree terminals to paired desktops |
| [#9327](https://github.com/stablyai/orca/issues/9327) | Relay Windows default shell hardcodes PowerShell 5.1; never reads OpenSSH DefaultShell nor prefers pwsh (pty-shell-utils.ts:23-50) |

### Sweep: needs repro (8)

| Issue | Evidence (one line) |
| --- | --- |
| [#4364](https://github.com/stablyai/orca/issues/4364) | 23-33% idle renderer CPU reported against upstream xterm.js; fork renders via aterm with engineered idle guarantees — profile an idle fork build to confirm |
| [#6787](https://github.com/stablyai/orca/issues/6787) | Screenshot-only board-view background report; fork board renders no terminal preview and nothing citable maps to the screenshot |
| [#6863](https://github.com/stablyai/orca/issues/6863) | Android scroll fix (nestedScrollEnabled + scroll routing, 4f4d52014) predates the report; app version unknown — device repro needed |
| [#6878](https://github.com/stablyai/orca/issues/6878) | Screenshot-only Claude-login networking failure; nearest artifact (env-marker scrub 6607f1f9c) is untied to OAuth |
| [#7905](https://github.com/stablyai/orca/issues/7905) | One-sentence OpenCode blank-terminal report; no artifact ties any fix to an agent-specific blank pane |
| [#8368](https://github.com/stablyai/orca/issues/8368) | No diagnostics; broad remote-reliability hardening landed (c9919e57b et al.) but neither symptom maps to a specific fix |
| [#9299](https://github.com/stablyai/orca/issues/9299) | Windows multiplexers: ConPTY-fidelity ports plausibly help but no concrete failing Windows-build/shell matrix exists to verify against |
| [#9464](https://github.com/stablyai/orca/issues/9464) | Manual new-terminal no-op on remote server: dispatch path intact in fork; upstream never root-caused the env-specific failure |
