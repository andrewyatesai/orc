# Partial-completion designs — five upstream issues, finish-line work only

Scope: each section closes the *remaining* gap of an issue the fork already mostly
addresses (verdicts: `upstream-triage/terminal-audit-verdicts.json`). Every seam is
cited file:line against the current tree. Policy check: **none of the five designs
requires aterm engine changes** — the engine already stores OSC 8 hyperlinks, exposes
the fallback-font chain API, and parses OSC 633;E command lines. Optional engine
follow-ups are flagged inline and are strictly additive.

Efforts: #6880 **S**, #8367 **M**, #7467 **M**, #7596 **M**, #5611/#8977 **M**.

---

## #6880 — Finish OSC 8 hyperlinks: scheme-aware routing on the aterm surface (S)

**Verdict:** `partially-addressed` (high). Engine side is done: OSC 8 links are
stored, hit-tested (`link_at`, kind 0 = osc8), hover-underlined, tooltipped, and
DA1/XTGETTCAP capability reporting plus `TERM_PROGRAM=Orca` + `FORCE_HYPERLINK=1`
env exports already ship (`src/main/providers/local-pty-provider.ts:686-690`).

**Remaining gap (the linkifier/surface half):** the aterm pane's OSC 8 *click*
routing treats every OSC 8 target as an http URL. `openHit` sends kind 0 and kind 1
through the same opener (`src/renderer/src/lib/pane-manager/aterm/aterm-link-input.ts:308-312`),
which is `createAtermUrlOpener` (`aterm-url-link-routing.ts:19-35`) →
`openTerminalHttpLink`/`openHttpLink` — a helper explicitly scoped "http(s) URLs only"
(`src/renderer/src/lib/http-link-routing.ts:61-66`). The scheme-aware router the xterm
pane used — `handleOscLink`, which handles `file://` URIs (the form `ls --hyperlink`
and gcc/ripgrep emit), Windows absolute paths, and raw path text
(`src/renderer/src/components/terminal-pane/terminal-osc-link-routing.ts:27-111`) —
is only wired to the legacy xterm `linkHandler` (`use-terminal-pane-lifecycle.ts:1330`)
and the plain-text-URL `onLinkClick` (`:1671`). Net effect: clicking a `file://` OSC 8
link in an aterm pane hands the file URI to the browser-tab/`shell.openUrl` path
instead of `openDetectedFilePath`.

### Design

1. **Extend the pane link context** (`aterm-url-link-routing.ts:10-13`):

   ```ts
   export type AtermLinkContext = {
     worktreeId?: string | null
     requestOpenLinksInAppPreference?: (url: string) => boolean | Promise<boolean> | null | undefined
     // NEW — OSC 8 scheme routing (mirrors LinkHandlerDeps):
     worktreePath?: string
     terminalHomePath?: string
     /** Live pane cwd — read per click (split panes change cwd after bind). */
     getStartupCwd?: () => string
     getRuntimeEnvironmentId?: () => string | null
   }
   ```

2. **New opener for kind 0** in `aterm-url-link-routing.ts`:
   `createAtermOscLinkOpener(getContext)` returns
   `(url: string, event: MouseEvent) => void` that calls `handleOscLink(url, event, {
   worktreeId, worktreePath, startupCwd: getStartupCwd?.(), terminalHomePath,
   runtimeEnvironmentId: getRuntimeEnvironmentId?.() ?? null,
   requestOpenLinksInAppPreference })`. `handleOscLink` already routes http(s) through
   the same in-app/system-browser preference (`terminal-osc-link-routing.ts:81-88`),
   so http behavior is unchanged; `file:` and Windows-path targets now reach
   `openDetectedFilePath` (`:90-109`, `:64-72`). Unroutable schemes (`mailto:`,
   unknown) return false → **no-op**, byte-parity with the xterm pane at
   `use-terminal-pane-lifecycle.ts:1330` (deliberately not `shell.openUrl` — arbitrary
   custom-protocol launch is the #4384 surface, out of scope here).

3. **Split kinds in `openHit`** (`aterm-link-input.ts:308-324`): kind 0 → new
   `deps.openOscUrl(hit.url, event)`; kind 1 stays on `openUrl`. Both preventDefault
   the same way (the sync `hovered`-span guard at `:336-340` already covers the
   worker's async `linkAtAsync` click path). Wire the new dep where `openUrl` is
   built (`aterm-pointer-input-bundle.ts:110-135`).

4. **Bind the context in the lifecycle**: `installAtermFileLinkOpener`
   (`use-terminal-pane-lifecycle.ts:747-771`) already calls
   `controller.setUrlLinkContext({ worktreeId, requestOpenLinksInAppPreference })`
   (`:753`) inside the bounded controller poll; extend that object with
   `worktreePath`, `terminalHomePath` (both in scope at `:700-712`),
   `getStartupCwd: () => getPaneLinkCwd(pane.id)` and
   `getRuntimeEnvironmentId: () => linkDeps.getRuntimeEnvironmentIdForPane?.(pane.id) ?? null`.
   Update the inline `AtermLinkBindablePane` type (`:733-739`), the controller type
   (`aterm-pane-controller-types.ts:83` neighborhood), and the shared-wiring setter
   (`aterm-pane-wiring.ts:385`, storage at `aterm-pane-wiring-types.ts:46-47`).
   GPU→CPU rebuilds keep it automatically (context lives in `shared`).

5. **Capability doc (issue ask 3, tiny):** add `docs/reference/terminal-capabilities.md`
   documenting OSC 8: yes; iTerm2 OSC 1337 inline images: yes
   (`rust/aterm/crates/aterm-core/src/render.rs:858-864`); sixel: yes (wasm build,
   `rust/aterm/crates/aterm-wasm/Cargo.toml:21`); kitty graphics: scaffolded, off;
   truecolor: yes; detection signals (`TERM_PROGRAM=Orca`, `TERM_PROGRAM_VERSION`,
   `FORCE_HYPERLINK=1`, DA1 code 4, XTGETTCAP). The pi-tui allowlist PR (ask 1) is an
   ecosystem PR outside this repo — link it from the doc, do not block on it.

### Tests

- `aterm-link-input.test.ts`: "kind-0 OSC 8 hit routes through the OSC opener, not the
  HTTP opener"; "kind-1 URL hit still uses the HTTP opener".
- new `aterm-url-link-routing.test.ts`: "file:// OSC 8 target opens via
  openDetectedFilePath with line/column"; "C:\\ path target routes as a path before
  URL parsing (Windows)"; "mailto:/unknown scheme is a no-op"; "startupCwd getter is
  read per click, not captured at bind".
- lifecycle: extend the file-link-opener binding test with "setUrlLinkContext carries
  worktreePath/home/runtime getters".

**Engine work:** none. **Effort: S.**

---

## #8367 — User-configurable font-fallback stacks (M)

**Verdict:** `partially-addressed` (high). Automatic OS fallback injection ships:
locale-aware CJK + script chain + symbol + emoji tiers discovered in
`src/main/terminal-fallback-fonts.ts` (types `:20-41`, `loadTextFonts` `:342-371`,
process-lifetime cache `:258`, IPC `fonts:getTerminalFallbackFonts` at
`src/main/ipc/settings.ts:220-222`), injected in-process via
`inject-terminal-fallback-fonts.ts` (`applyTextClass:70-92` — engine semantics:
`set_fallback_font_registered` RESETS the chain, `add_…` APPENDS) and on the worker
path via `aterm-shared-render-worker.ts:295-307` → `aterm-worker-font-registry.ts`.
**Gap:** no way to express `primary → user-defined fallbacks → defaults`.

### Design

1. **Setting** (`src/shared/types.ts` next to `terminalFontFamily:2655`):

   ```ts
   /** Ordered user fallback families consulted after the primary font and
    *  before Orca's locale-derived OS fallbacks. Family names as returned by
    *  fonts:listSystemFontFamilies. Empty/unset = current behavior. */
   terminalFontFallbackFamilies?: string[]
   ```

   Default `[]` in `src/shared/constants.ts` (settings defaults block, near `:270`).

2. **Main resolution** (`terminal-fallback-fonts.ts`): `getTerminalFallbackFonts`
   (`:383-393`) gains `userFamilies?: readonly string[]` (threaded by the IPC handler,
   which reads the live setting). Each family resolves through the existing
   family→bytes seam `resolveTerminalFontFaceBytes` (`src/main/system-fonts.ts:118`,
   weight 400); unresolvable families are skipped (issue requirement: unavailable font
   → preserve current behavior). New result field:

   ```ts
   export type TerminalFallbackFonts = {
     user: { family: string; bytes: Uint8Array }[]  // NEW, ordered, may be []
     cjk?: { bytes: Uint8Array; region: CjkRegion }
     emoji?: Uint8Array
     symbol?: Uint8Array
     chain: FallbackChainEntry[]
   }
   ```

   De-dup user faces against `cjk`/`chain` via the existing `usedPaths` set
   (`loadTextFonts:363-366`) so e.g. picking "Microsoft YaHei" doesn't ship
   `msyh.ttc` twice. Cache: keep `cachedText` for the OS half; memoize the user half
   in a `Map<string /* families.join('\n') */, Promise<…>>` so a settings change
   naturally misses the cache — no invalidation hook needed.

3. **In-process apply order** (`inject-terminal-fallback-fonts.ts`):
   `TextClassHandles` (`:32`) gains `user: number[]`; `registerTextClass` (`:49-57`)
   registers user faces first. `applyTextClass` (`:70-92`) becomes: `set(user[0])`,
   `add(user[1..])`, then `add(cjk)` (only demoted to `add` when a user stack exists;
   otherwise `set(cjk)` exactly as today), then `add(chain…)`, symbol unchanged.
   Per-face try/catch already tolerates unparseable faces.

4. **Worker path** (`aterm-shared-render-worker.ts:295-307`): unshift
   `user[i].bytes` into the `fallbacks` array before the CJK face. No protocol change —
   `AtermWorkerFonts.fallbacks` is already an ordered `Uint8Array[]`, and
   `ensureModuleHandles` (`aterm-worker-font-registry.ts:48-60`) registers/applies in
   array order. Ordering hazard to document in code: the registry appends
   incrementally by index, so a *changed* stack cannot reorder an already-delivered
   class within a live worker generation.

5. **Apply semantics (v1):** the stack takes effect for **new terminal panes / next
   worker generation** — same lifecycle as a `terminalFontFamily` change requiring
   pane wiring (`aterm-pane-wiring.ts:273`). The lazy-injection latch
   (`inject-terminal-fallback-fonts.ts:117`, `requested` bits) and worker-resident
   fonts are per-generation, so no live re-injection machinery is needed. The
   settings row states "Applies to new terminal panes."

6. **Settings UI**: new row under Font Family in
   `TerminalAppearanceSection.tsx:221-235` (or inside
   `TerminalAdvancedTypographyControls.tsx`), component
   `TerminalFallbackFontsRow.tsx`: ordered chip list with add-via-`FontAutocomplete`
   (reuses `fonts:listSystemFontFamilies`, `src/main/ipc/settings.ts:210`, and the
   existing suggestion plumbing at `TerminalAppearanceSection.tsx:228-232`),
   drag/arrow reorder, remove. Follow `docs/STYLEGUIDE.md` tokens + shadcn primitives.

### Tests

- `terminal-fallback-fonts.test.ts`: "user families resolve in order and land in
  `user` before the CJK face"; "unresolvable family is skipped, later ones survive";
  "user face de-dups against CJK/chain by resolved path"; "user-half memo misses when
  the family list changes".
- new `inject-terminal-fallback-fonts.test.ts`: "apply order: set(user0), add(rest),
  add(cjk), add(chain); empty stack keeps set(cjk)".
- `aterm-shared-render-worker.test.ts`: "text fontClass delivery carries user faces
  before CJK".
- `TerminalFallbackFontsRow.test.tsx`: add/reorder/remove writes
  `terminalFontFallbackFamilies` in order.

**Engine work:** none — `set_fallback_font_registered`/`add_fallback_font_registered`
already express arbitrary ordered chains. **Effort: M.**

---

## #7467 — Explicit custom shell paths (M)

**Verdict:** `partially-addressed` (high). Discovery is wide (PATH + registry PATH +
winget/dotnet + Store-alias resolution, `src/main/providers/windows-powershell-executable.ts:99-224`),
and the POSIX *resolver* already accepts explicit paths
(`src/main/posix-default-shell.ts:87-89`). **Gap:** no UI to enter a path, no
validation, and one Windows correctness hole for path-shaped settings.

### Design

1. **Storage: no new settings.** `terminalWindowsShell` (`src/shared/types.ts:2732`,
   default `'powershell.exe'` at `src/shared/constants.ts:270`) and
   `terminalPosixShell` (`types.ts:2734`) start accepting absolute executable paths as
   values. Downstream classifiers are already basename-tolerant:
   `resolveWindowsShellStartupFamily` (`src/shared/windows-terminal-shell.ts:17-37`),
   `isWslShellName` (`src/shared/local-windows-terminal-runtime.ts:13-16`), and the
   folding sites pass the raw string through (`src/main/ipc/pty.ts:2739`, `:3558`).

2. **Windows spawn fix (the correctness core):** two seams currently clobber an
   absolute custom path whose basename is `pwsh.exe`/`powershell.exe`:
   - `LocalPtyProvider.spawn` win32 branch
     (`src/main/providers/local-pty-provider.ts:600-636`): re-enters family
     resolution whenever `getWindowsPowerShellImplementation()` is set
     (`shouldResolvePowerShellFamily`, `:622-623`). Change: when
     `pathWin32.isAbsolute(shellFamily)`, skip `resolveEffectiveWindowsPowerShell`
     and keep the path verbatim.
   - `buildWindowsPowerShellSpawnAttempts`
     (`src/main/providers/windows-shell-fallback-chain.ts:55-71`, called at
     `local-pty-provider.ts:637`): **discards** the incoming `shellPath` and rebuilds
     the chain from its basename via discovery
     (`resolveWindowsPowerShellSpawnChain`, `windows-powershell-executable.ts:206-224`)
     — the primary attempt then overwrites `shellPath`
     (`local-pty-provider.ts:645-651`). Change: when `args.shellPath` is absolute and
     `isRealExecutable`, prepend it verbatim as attempt 0 (de-duped against the
     discovered chain); the discovered inbox PowerShell + `cmd.exe` links remain as
     fallbacks, so a stale custom path still opens a terminal instead of a dead pane.
   Absolute paths with non-PowerShell basenames (e.g. a custom `nu.exe`) already
   bypass the attempts builder (`windows-shell-fallback-chain.ts:64-66` returns `[]`)
   and launch directly via `resolveWindowsShellLaunchArgs`
   (`local-pty-provider.ts:653-660`) — unchanged.

3. **Validation IPC:** new `src/main/terminal-shell-path-validation.ts` + handler
   `terminal:validateShellPath` (registered in `src/main/ipc/pty.ts` beside the shell
   detection handlers):

   ```ts
   type ShellPathValidation =
     | { ok: true; resolvedPath: string }
     | { ok: false; reason: 'not-absolute' | 'not-found' | 'is-directory' | 'not-executable' }
   ```

   POSIX: `path.isAbsolute` + `accessSync(X_OK)` (reuse the probe at
   `posix-default-shell.ts:20-27`). Windows: `isAbsolute` + `stat.isFile()` +
   extension ∈ {`.exe`,`.cmd`,`.bat`,`.com`}, plus the Store-alias hazard check
   (`isWindowsAppExecutionAliasPath`, `windows-powershell-executable.ts`) → treat an
   alias reparse point as `not-executable` with its resolved target in `resolvedPath`
   when recoverable. All `path` ops via `node:path` per platform — no separator
   assumptions.

4. **UI:** `TerminalWindowsShellSection.tsx` (`:70-90` segmented control) gains a
   `Custom…` option that reveals a free-text `SettingsRow` input (value =
   `terminalWindowsShell` verbatim) with debounced inline validation via the IPC and
   a destructive-tone error line on `ok:false`. `TerminalPosixShellSection.tsx`
   already displays a hand-edited path as a deselectable choice (`:50-51`,
   `:125-130`); add the same `Custom…` input writing `terminalPosixShell` (the
   resolver path `posix-default-shell.ts:74-96` needs zero changes).

5. **Scope guards:** SSH keeps the remote login shell (`posix-default-shell.ts:117-121`
   gate) — custom paths are local-host only; the WSL branch
   (`local-pty-provider.ts:606`) and per-tab `shellOverride` precedence (`:600-605`)
   are unchanged.

### Tests

- `local-pty-provider.test.ts`: "absolute terminalWindowsShell spawns verbatim even
  with a PowerShell implementation preference set"; "missing custom path falls back
  to inbox PowerShell then cmd.exe".
- `windows-shell-fallback-chain` tests (beside `windows-powershell-executable.test.ts`):
  "absolute shellPath is attempt 0 and is not replaced by the discovered install";
  "non-executable absolute path drops to the discovered chain".
- new `terminal-shell-path-validation.test.ts`: full reason matrix on win32 + posix
  (mock fs), Store-alias case.
- `posix-default-shell.test.ts`: extend "explicit path resolves iff executable".
- `TerminalWindowsShellSection.test.tsx`: "Custom path persists and surfaces
  validation errors"; matching POSIX section test.

**Engine work:** none. **Effort: M.**

---

## #7596 — "Re-run last command" affordance on restored terminals (M)

**Verdict:** `partially-addressed` (medium). Restore itself is solved (daemon
history + cold-restore replay; blank-pane glitch class fixed). **Gap:** nothing
captures or offers the last-ran command.

Key inventory: aterm already parses **OSC 633;E** command lines into shell marks
(`rust/aterm/crates/aterm-core/src/terminal/handler_osc_shell.rs:252-292`, size-capped
`:277`) and exposes `command_marks()` / `last_completed_command()`
(`shell_api.rs:50`, `:134`) — but Orca's own shell hooks emit only bare
`133;A/C/D` (bash `src/main/daemon/shell-ready.ts:130-166`, zsh `:247-261`, mirrors
in `src/main/providers/local-pty-shell-ready.ts:158-167`/`:261-267`, PowerShell
`src/main/powershell-osc133-bootstrap.ts:65`), so no command text exists anywhere.
The raw bytes DO persist: `HistoryManager` logs raw PTY output
(`src/main/daemon/history-manager.ts:150-177`) and `HistoryReader` replays it through
a scratch `HeadlessEmulator` that already runs OSC scanners
(`src/main/daemon/history-reader.ts:118-150`, `headless-emulator.ts:11`
`TerminalOscCwdTitleScanner`).

### Design

1. **Emit the command text from Orca's own hooks** (local + daemon spawn paths):
   - bash (`shell-ready.ts:148-166` and `local-pty-shell-ready.ts:158-167`): in
     `__orca_osc133_preexec`, immediately before `printf "\033]133;C\007"`, emit
     `printf "\033]633;E;%s\007" "$(__orca_osc633_escape "$BASH_COMMAND")"` with a
     helper doing VS Code escaping (`\` → `\\`, `;` → `\x3b`, newline → `\x0a`) and a
     2 KB truncation (engine cap is larger, `MAX_COMMANDLINE_BYTES`; 2 KB keeps the
     prompt path cheap).
   - zsh (`shell-ready.ts:255-256`, `local-pty-shell-ready.ts:261-262`): preexec gets
     the command as `$1` — same emission.
   - PowerShell (`powershell-osc133-bootstrap.ts:65` neighborhood): the hook that
     emits `133;C` has the read line in hand; emit `633;E` with the same escaping.
   Emitting the VS Code sequence (not a private one) also lights up the engine's
   existing command-mark features for free.

2. **Restore-time capture (no Rust changes):** new shared incremental scanner
   `src/shared/terminal-osc633-commandline.ts` (mirror the chunk-safe pattern of
   `src/shared/terminal-osc133-command-finished.ts`): feeds raw chunks, retains the
   **last complete** `ESC ] 633;E;<payload> (BEL|ST)`, unescapes, exposes
   `lastCommandline(): string | null`. `HeadlessEmulator` runs it alongside the
   cwd/title scanner; `HistoryReader.restoreFromIncrementalLog`
   (`history-reader.ts:122+`) surfaces it as a new optional field:

   ```ts
   export type ColdRestoreInfo = { …existing (history-reader.ts:10-19); lastCommand?: string }
   ```

   Degradation is honest: a command older than the current log window (5 MB cap /
   post-checkpoint reset, `history-manager.ts:27`) simply yields no affordance.

3. **Plumbing (each hop adds `lastCommand?: string`):**
   `ColdRestorePayload` (`daemon-pty-adapter.ts:46-52`) via `buildColdRestorePayload`
   (`:716`) → spawn-result forwarding (`src/main/ipc/pty.ts:4102-4110`) → preload
   shape (`src/preload/api-types.ts:1334`) → renderer restore handling
   (`pty-transport.ts:794-815`).

4. **UX — extend the existing restored banner** (`SessionRestoredBanner.tsx`,
   `SessionRestoredBannerPortals.tsx`, `session-restored-banner-pane-state.ts`,
   mounted from `TerminalPane.tsx:77`): pane-id `Set<number>` becomes
   `Map<number, { lastCommand: string | null }>`. When `lastCommand` is present the
   banner renders `--- session restored · last ran: npm run dev ---` plus a
   `Type it again` button. Activation **types the command without executing**: route
   through the pane's paste seam (`pane.terminal.paste`, wired at
   `aterm-pane-open.ts:176-179` — bracketed-paste-safe, so a shell with 2004 on
   can't auto-run it) and never append `\r`; the user confirms with Enter. This is a
   deliberate safety stance: a restored command can be stale or destructive.
   Existing dismiss-on-keypress behavior covers cleanup.

5. **Gating:** offer only for plain terminals — agent panes relaunch their own CLIs
   (`pty-connection.ts:5068-5136` cold-restore override path); skip multiline
   commands and commands > 200 chars (banner ellipsis is not a shell).

6. **Optional engine-backed follow-up (flagged, NOT required):** live capture via the
   daemon's headless engine `command_marks()` instead of log scanning would need an
   `orca-daemon` protocol field + `orca-terminal` accessor — Trust conventions apply
   (`ty_model!` if any new stateful surface, `spec_xref` registration, adversarial
   review). The log-scan design intentionally avoids this.

### Tests

- `shell-ready.test.ts` + `powershell-osc133-bootstrap.test.ts`: "preexec emits
  OSC 633;E (escaped) before 133;C"; "escaping round-trips `;`, `\`, newline".
- new `terminal-osc633-commandline.test.ts`: sequence split across chunk boundaries;
  keeps last of many; ignores truncated tail.
- `history-reader.test.ts`: "cold restore surfaces lastCommand from the replayed
  log"; "no 633;E → lastCommand undefined".
- `terminal-history-incremental-restore.test.ts`: end-to-end restore carries it.
- renderer banner test: "Type it again pastes without trailing newline"; "agent panes
  never show the affordance".

**Engine work:** none required. **Effort: M.**

---

## #5611 / #8977 — OSC 52 & selection-copy UX: no more invisible clipboard failures (M)

**Verdicts:** both `partially-addressed` (medium). The fork already: gates OSC 52
behind `terminalAllowOsc52Clipboard` (default false,
`src/shared/constants.ts:288`) with a **dual gate** — engine authorization
(`use-terminal-pane-lifecycle.ts:810-812` `setClipboardWriteAuthorized`, engine
capability ceremony in `rust/aterm/crates/aterm-core/src/terminal/clipboard_auth.rs`)
plus the JS handler (`:989-993`) — and shows a loud blocked-write toast with an
Open Setting deep link (`osc52-clipboard-blocked-toast.ts:8-45`, anchor row at
`TerminalInteractionSection.tsx:336`). **Gap:** every *allowed* write path still
swallows failures, so the Windows "says copied, clipboard empty" family stays
invisible:

- `osc52-clipboard.ts:47-49` — `.catch(() => {/* ignore */})`
- `keyboard-handlers.ts:524-526` — same
- `use-terminal-pane-context-menu.ts:161` and `:498-501` — fire-and-forget, then
  immediate selection clear
- `aterm-clipboard-copy.ts:6-9` — engine-selection / copy-on-select path
  (wired at `aterm-pointer-input-bundle.ts:74`)
- main writes never verify: `clipboard-ipc-handlers.ts:180-186` returns
  `clipboard.writeText(...)` (void, unchecked)

### Design

1. **Verified write in main** (`src/main/window/clipboard-ipc-handlers.ts:180-186`):
   `clipboard:writeText` (and `:writeSelectionText`, `:184`) become
   `Promise<boolean>`: write, then read back `clipboard.readText()` and compare; on
   mismatch retry once after ~150 ms (the classic Win32 open-clipboard contention —
   the leading suspect for the Windows 10 reports) and return the final comparison.
   Bounded verify: for payloads > 256 KiB compare length + first/last 4 KiB instead
   of full text. Log a structured warning on persistent mismatch so the
   never-identified upstream root cause becomes observable. Preload passthrough
   (`src/preload/index.ts:3712`, `api-types.ts`) narrows `Promise<void>` →
   `Promise<boolean>`; existing `void`-callers keep compiling.

2. **Single renderer outcome seam** — new
   `src/renderer/src/components/terminal-pane/terminal-copy-outcome.ts`:

   ```ts
   export type TerminalCopySource = 'shortcut' | 'context-menu' | 'copy-on-select' | 'osc52'
   export function reportTerminalCopyOutcome(ok: boolean, source: TerminalCopySource): void
   ```

   `ok === false` → `toast.error('Copy failed — clipboard unchanged', …)`, deduped
   once per session per source (same latch pattern as
   `osc52-clipboard-blocked-toast.ts:6-12`); for `source === 'osc52'` include the
   Open Setting action targeting `OSC52_CLIPBOARD_SETTING_ID`
   (`osc52-clipboard-setting-anchor.ts:1`). Host-initiated copies stay silent on
   success (the user performed them; noise adds nothing — this matches upstream's own
   ask: *no success signal unless the clipboard really changed*).

3. **Visible outcome for silent OSC 52 writes:** `Osc52ClipboardRequestOptions`
   (`osc52-clipboard.ts:25-29`) gains `onWriteResult?: (ok: boolean) => void`; the
   handler awaits the verified write instead of `.catch(ignore)`. Lifecycle
   registration (`use-terminal-pane-lifecycle.ts:986-995`) passes
   `onWriteResult: (ok) => reportTerminalCopyOutcome(ok, 'osc52')` **plus** a
   one-time-per-session passive success toast ("Terminal copied to clipboard") for
   the *first* successful OSC 52 write — a TUI-initiated copy is otherwise
   indistinguishable from the gated/silent-failure cases the two issues describe.
   Subsequent successes stay silent.

4. **Convert the fire-and-forget sites** to the seam:
   `keyboard-handlers.ts:524` (`source: 'shortcut'`);
   `use-terminal-pane-context-menu.ts:161` and `:498` (`'context-menu'`, and only
   clear the selection after the promise resolves `ok` — the issue's exact
   complaint); `aterm-clipboard-copy.ts:6` (`'copy-on-select'` — keep the
   `__atermLastCopied` e2e field). The copy-on-select variant additionally rate-limits
   failure toasts (drag-selection can fire repeatedly).

5. **Setting surface:** already exists (row + anchor + deep link). Only change:
   the row's description gains a line noting blocked TUI copies surface a toast, so
   the setting is discoverable from both directions. Keep the engine gate and JS gate
   toggled together exactly as today (`installAtermEngineAuthorizations`,
   `use-terminal-pane-lifecycle.ts:803-819`).

6. **Deciding experiment from the verdict**, now automatable: Windows fork build,
   OpenCode/Claude Code TUI copy with the setting enabled, paste in Notepad — with
   step 1's verification, a repro produces a logged mismatch instead of a mystery.

### Tests

- new `clipboard-write-verification.test.ts` (main): "write verifies by read-back";
  "one retry on transient mismatch"; "returns false when the clipboard stays
  unchanged"; "large payload uses bounded compare".
- `osc52-clipboard.test.ts`: "allowed write failure invokes onWriteResult(false)";
  "blocked write still fires onBlockedWrite, never onWriteResult".
- new `terminal-copy-outcome.test.ts`: per-source dedup; osc52 failure toast carries
  Open Setting.
- `keyboard-handlers.test.ts`: "copySelection surfaces a failed clipboard write".
- context-menu test: "selection clears only after a verified write".

**Engine work:** none (engine OSC 52 authorization unchanged). **Effort: M.**

---

## Critic notes

Spot-checked 2026-07-22. Verified: #6880 — `openHit` merges kind 0/1 into `openUrl` (aterm-link-input.ts:308-312), `createAtermUrlOpener` (:19), `handleOscLink` wired only at use-terminal-pane-lifecycle.ts:1330 (facade `options.linkHandler`, never invoked by the aterm pane-manager) and :1671 (`onLinkClick`, plain-text/provider path) — the diagnosis is exactly right. #8367 — `getTerminalFallbackFonts` (:383), `applyTextClass` (:70), `registerTextClass` (:49). #7467 — `buildWindowsPowerShellSpawnAttempts` really does discard the incoming `shellPath` and rebuild from basename (windows-shell-fallback-chain.ts:63-67), and non-PowerShell basenames return `[]` (:64-66). #7596 — `__orca_osc133_preexec` bash (daemon shell-ready.ts:148-166) and zsh (:255-267) plus local mirrors and the PowerShell bootstrap all exist as cited; engine 633;E parse with `MAX_COMMANDLINE_BYTES` cap confirmed. #5611 — `clipboard:writeText`/`writeSelectionText` handlers (clipboard-ipc-handlers.ts:180-189), `osc52-clipboard.ts` catch-ignore (:47-49). Notes:

1. **#6880 has program-level priority beyond its S size**: orca-deep-links §5 is dead code on aterm panes until this lands (see that design's critic notes). Schedule #6880 before deep-links PR 1.
2. **#7596 nonce interaction is safe but should be pinned**: OSC 133/633 parsing is nonce-gated only when a capability nonce is set (handler_osc_shell.rs:189-192) and the fork sets none — add one test asserting un-nonced 633;E is accepted, so a future nonce adoption doesn't silently kill the feature. Also, bash's `$BASH_COMMAND` in a DEBUG trap fires per simple command; the existing 133;C once-per-prompt guard must wrap the 633;E emission too (the design implies this by co-locating them — make it explicit).
3. **#5611 read-back caveats**: (a) `clipboard:writeSelectionText` must verify with `clipboard.readText('selection')`, not the default clipboard; (b) a clipboard manager can rewrite contents between write and read-back — one retry covers the Win32 contention case, but treat persistent mismatch as "unverified", not necessarily "failed", in the structured log wording; (c) the bounded compare must bound the *read* too (readText of a >256 KiB payload just to compare 8 KiB defeats the purpose — read once, compare bounded).
4. #8367 v1 "applies to new panes" is the right honest scope; the worker-registry append-only ordering hazard the design flags (item 4) is real — keep the code comment it mandates.
5. #7467: the validation IPC's Store-alias probe (`isWindowsAppExecutionAliasPath`) — confirm export exists before citing in the PR; the fallback-chain hazard comment (:44-49 claimed) matches the module's design.

All five efforts (S/M/M/M/M) are credible; engine-work-none claims verified for all five.
