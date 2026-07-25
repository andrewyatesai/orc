# Design: `orca://` deep links (#4384)

- **Issue**: [#4384 — Clickable orca:// deep-links to focus a terminal/worktree](https://github.com/stablyai/orca/issues/4384) (P1, size/m)
- **Audit verdict**: `still-applies`, high confidence — no `setAsDefaultProtocolClient`/`protocols` entry anywhere; `terminal-osc-link-routing.ts` routes only `http:`/`https:`/`file:`; the only `orca://` grammar in the tree is the web-pairing URL (`src/shared/pairing.ts`).
- **Engine work**: **YES** — aterm's OSC-8 scheme allowlist rejects `orca:` at parse time, so terminal-minted links never exist in the grid. Per fork policy this is fixed in the engine (host-mintable scheme capability), not with JS glue. See §7.
- **Effort**: L overall; the issue's v1 scope (focus-by-handle + registration + routing) is M. Split into two PRs (§10).

---

## 1. Goals / non-goals

**Goals**

1. `orca://focus/<terminal-handle>` clicked anywhere (terminal OSC-8 link, browser, another app) focuses that exact Orca pane.
2. OS-level `orca://` scheme registration on macOS / Windows / Linux, with single-instance routing into the running app.
3. Worktree/tab navigation links, `orca://pair` handoff, and consent-gated `orca://run` as the v2 grammar.
4. Terminal-minted links route **in-app** (never a round-trip through the OS), preserving origin information.

**Non-goals**

- Notifications (explicitly excluded by the issue).
- Auto-linkifying *plain-text* `orca://…` in the terminal. The engine's smart-selection URL detector is not extended; delivery vehicle is OSC-8 (issue's accepted limitation). Plain-text `term_<uuid>` handles already linkify via the existing provider (`src/renderer/src/components/terminal-pane/terminal-handle-links.ts:149`) and are untouched.
- Deep links in `orca serve` / headless mode (registration is skipped when `isServeMode`).

---

## 2. URL grammar

One shared parser is the single source of truth for main, renderer, and tests:

**New file** `src/shared/orca-deep-link.ts` (naming rule: concrete concept, no `utils`):

```ts
export type OrcaDeepLink =
  | { kind: 'focus'; handle: string }                                  // v1
  | { kind: 'worktree'; worktreeId: string; tabId?: string }           // v2
  | { kind: 'pair'; code: string }                                     // v2 (desktop routing of existing grammar)
  | { kind: 'run'; worktreeId: string; command: string; title?: string } // v2, consent-gated

export type OrcaDeepLinkOrigin =
  | { source: 'os' }                                    // open-url / argv — outside world
  | { source: 'terminal'; worktreeId: string }          // OSC-8 click inside a pane

export const MAX_ORCA_DEEP_LINK_LENGTH = 2048
export const TERMINAL_HANDLE_PATTERN = /^term_[A-Za-z0-9-]{1,128}$/

export function parseOrcaDeepLink(raw: string): OrcaDeepLink | null
```

Grammar (host = action, matching the strict `hostname === 'pair'` precedent at `src/shared/pairing.ts:37-41`):

| URL | Action | Gate |
|---|---|---|
| `orca://focus/term_<uuid>` | Focus pane by runtime handle (from `orca terminal list --json`, `src/cli/help.ts:218,245`; handles minted as `` `term_${randomUUID()}` `` at `src/main/runtime/orca-runtime.ts:23685,23741`) | none (navigation) |
| `orca://worktree/<pct-encoded worktreeId>` | Activate worktree (id is `repoId::worktreePath` — `src/shared/worktree-id.ts:20-29`; **must** be percent-encoded, `::` and `/` survive `encodeURIComponent`) | none (navigation) |
| `orca://worktree/<id>?tab=<tabId>` | Activate worktree + specific terminal tab | none (navigation) |
| `orca://pair?code=<base64url>` | Existing pairing grammar (`src/shared/pairing.ts:19,30-47`) — desktop routes it to the Mobile/pairing settings pane instead of dropping it | pairing UI's own confirm |
| `orca://run?worktree=<pct id>&cmd=<pct command>&title=<pct>` | Create a terminal in that worktree running `cmd` | **modal consent, always** (§6) |

Parse rules (all enforced in `parseOrcaDeepLink`, table-tested):

- Reject when `raw.length > MAX_ORCA_DEEP_LINK_LENGTH`.
- Reject unless `new URL(raw)` succeeds, `protocol === 'orca:'`, and `hostname` is exactly one of `focus | worktree | pair | run` (unknown hosts → `null`, caller logs + toasts "Unrecognized Orca link").
- Reject any URL carrying `username`/`password` components.
- `focus`: single path segment, must match `TERMINAL_HANDLE_PATTERN` (kills traversal shapes, oversized handles, and injection into the RPC layer before it happens).
- `run`: `cmd` decoded but **never** interpreted by the parser; empty `cmd` or missing `worktree` → `null`.
- Case-insensitive scheme/host; percent-decoding via `URL`/`searchParams` only (no hand-rolled decoding).

**Named tests** — `src/shared/orca-deep-link.test.ts`: `parses focus handle`, `rejects focus with path traversal segments`, `rejects non-term handles`, `round-trips worktree ids containing :: and /`, `rejects oversized urls`, `rejects credentialed urls`, `rejects unknown hosts (orca://pairing precedent)`, `run requires worktree and cmd`.

---

## 3. Protocol registration & packaging

### 3.1 electron-builder (`config/electron-builder.config.cjs`)

Add a top-level `protocols` entry (electron-builder propagates it per-platform):

```js
protocols: [{ name: 'Orca deep link', schemes: ['orca'], role: 'Viewer' }],
```

- **macOS** (`mac:` block starts at `config/electron-builder.config.cjs:307`): builder injects `CFBundleURLTypes` into Info.plist alongside the existing `extendInfo` (:317). No entitlement needed; works under hardened runtime.
- **Windows** (`win:` :261, `nsis:` :297): NSIS target auto-writes `HKCU\Software\Classes\orca` → `shell\open\command "<exe>" "%1"`. Per-user install (current NSIS config) means no elevation issues. The uninstaller include (`config/nsis/daemon-host-uninstall.nsh`, wired at :305) needs **no** change — electron-builder's generated uninstaller removes the class key.
- **Linux** (`linux:` :395, `deb:` :435): builder adds `MimeType=x-scheme-handler/orca;` to the generated `orca-ide.desktop` (merging with the existing `desktop.entry` at :402-408). deb: `update-desktop-database` runs via dpkg triggers; no change to `resources/linux/packaging/after-install.sh` required, but add `xdg-mime default orca-ide.desktop x-scheme-handler/orca || true` there so KDE/older GNOME resolves without a re-login. AppImage: desktop integration (and thus scheme handling) only exists when AppImageLauncher/appimaged is installed — **degrade documented, not worked around**: in-terminal clicks still work because they never hit the OS (§5.3).

### 3.2 Fork identity collision

Fork builds are `com.stablyai.orca.staging` / "Orca ALab Edition"; `ORCA_PUBLIC_IDENTITY=1` builds are `com.stablyai.orca` (:17-29). Both register the **same** `orca` scheme — the issue's grammar is the contract and CLI/agents can't know which build is installed. If both apps are installed, LaunchServices/registry picks one handler for OS-routed links (last registered wins on Windows; macOS is nondeterministic). Accepted: terminal-clicked links never leave the app (§5.3), so the collision affects only browser-clicked links, and upstream currently registers nothing. Flag in the PR description; do **not** invent an `orca-staging` scheme.

### 3.3 Runtime registration (`src/main/index.ts`)

New module **`src/main/startup/deep-link-scheme-registration.ts`**:

```ts
export function registerOrcaProtocolClient(app: App, opts: { isServeMode: boolean }): void
```

- Skip entirely when `opts.isServeMode`.
- Packaged: `app.setAsDefaultProtocolClient('orca')`.
- Dev (`process.defaultApp`): `app.setAsDefaultProtocolClient('orca', process.execPath, [resolve(process.argv[1])])` — required on Windows/Linux so the dev Electron shim is invoked with the URL. Linux dev registration is best-effort (no desktop file) — log, don't throw.
- Call site: `src/main/index.ts`, immediately after the single-instance lock block (after :616) and **before** `app.whenReady()` (:1649) — macOS can deliver `open-url` before ready.

---

## 4. Single-instance routing

### 4.1 Seams

- Lock + `second-instance`: `src/main/startup/single-instance-lock.ts:29-35` (`acquireSingleInstanceLock`), called at `src/main/index.ts:604` with `requestDesktopActivation` (:500), which drives `desktopActivationGate` → `focusExistingMainWindow` (`src/main/window/focus-existing-window.ts:67-100`).
- macOS URL event: `app.on('open-url')` — **not registered today anywhere**.
- Windows/Linux: URL arrives in `process.argv` (first launch) or the second instance's `argv` (relayed through the `second-instance` event).

### 4.2 Changes

**`acquireSingleInstanceLock` signature** (`single-instance-lock.ts:29`) becomes:

```ts
export function acquireSingleInstanceLock(
  app: App,
  onSecondInstance: (argv: string[]) => void
): boolean
// app.on('second-instance', (_event, argv) => onSecondInstance(argv))
```

Extend `src/main/startup/single-instance-lock.test.ts` (existing cases at :35-70): `forwards second-instance argv to the callback`.

**New module `src/main/startup/deep-link-routing.ts`** — parse, queue, dispatch:

```ts
export function extractDeepLinkFromArgv(argv: string[]): string | null
// last arg matching /^orca:\/\//i, length-capped BEFORE parse; everything else in argv is ignored
// (Windows argv is attacker-influenceable junk — Chromium switches, file paths — never interpret it)

export type DeepLinkDispatcher = (link: OrcaDeepLink, origin: OrcaDeepLinkOrigin) => void

export function createDeepLinkRouter(opts: {
  dispatch: DeepLinkDispatcher
  isWindowReady: () => boolean       // desktopActivationGate.getState() === 'ready' && mainWindow != null
  requestActivation: () => void      // existing requestDesktopActivation, src/main/index.ts:500
  maxQueued?: number                 // default 4; older entries dropped (rate limit, §6.4)
}): { routeRaw: (raw: string, origin: OrcaDeepLinkOrigin) => void; drainQueued: () => void }
```

Wiring in `src/main/index.ts`:

1. Before ready: `app.on('open-url', (e, url) => { e.preventDefault(); router.routeRaw(url, { source: 'os' }) })` (macOS).
2. `acquireSingleInstanceLock(app, (argv) => { requestDesktopActivation(); const raw = extractDeepLinkFromArgv(argv); if (raw) router.routeRaw(raw, { source: 'os' }) })`.
3. First launch (win32/linux): `extractDeepLinkFromArgv(process.argv)` once, queued until ready.
4. `drainQueued()` from the same place the renderer's startup barrier resolves — the `app:awaitFirstWindowStartupServices` handler (`src/main/index.ts:654-657`) is the existing "renderer listeners are attached" signal; drain after it resolves so `ui:*` sends aren't lost pre-mount.

**Named tests** — `src/main/startup/deep-link-routing.test.ts`: `extracts orca url from windows argv noise`, `ignores non-orca argv entries`, `queues links until window ready then drains in order`, `drops queue overflow beyond maxQueued`, `open-url before ready is not lost`.

### 4.3 Dispatch (main process)

`DeepLinkDispatcher` implementation lives in **`src/main/ipc/deep-links.ts`** (sibling of `src/main/ipc/notifications.ts`), given the runtime + window accessors index.ts already holds:

- **`focus`** → `runtime.focusTerminal(handle)` (`src/main/runtime/orca-runtime.ts:20482-20510`) — the *same canonical action* behind the `terminal.focus` RPC (`src/main/runtime/rpc/methods/terminal.ts:1464-1470`). It resolves handle → leaf and emits `ui:focusTerminal` via the notifier (`src/main/window/attach-main-window-services.ts:324-325` → preload listener `src/preload/index.ts:3578`) or revives a sleeping session via `revealTerminalSession`. No new focus logic. Errors (`terminal_handle_stale`, `terminal_exited`) → renderer toast "Terminal is no longer running".
- **`worktree`** → mirror the notification-click path (`src/main/ipc/notifications.ts:522-556`): validate `worktreeId.includes('::')`, `getRepoIdFromWorktreeId` (`src/shared/worktree-id.ts:15-18`), send `ui:activateWorktree { repoId, worktreeId }` (listener at `src/preload/index.ts:3446`); with `?tab=`, follow with `ui:focusTerminal { tabId, worktreeId, leafId: null }`. Unknown worktree → renderer toast (renderer already tolerates unknown ids in `ui:activateWorktree`).
- **`pair`** / **`run`** → forward to renderer over a **new channel `ui:deepLink`** `{ link: OrcaDeepLink, origin: OrcaDeepLinkOrigin }` (preload: `window.api.deepLink.onDeepLink(cb)`, pattern of :3578); renderer shows the consent surface (§6).
- Every OS dispatch is preceded by `focusExistingMainWindow` (already implied by `requestDesktopActivation` on second-instance; call it explicitly for `open-url`).

---

## 5. Terminal-minted links (OSC-8 seam)

### 5.1 Click routing today

aterm (not xterm) does link detection: engine `link_at(row,col)` returns `LinkHit { kind: 0=osc8, … }` (`src/renderer/src/lib/pane-manager/aterm/aterm_wasm.d.ts:121-125`), hit-tested in `src/renderer/src/lib/pane-manager/aterm/aterm-link-input.ts:63-66,247`. OSC-8 clicks reach `handleOscLink` two ways: the facade `linkHandler.activate` (`src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts:1327-1341`) and the controller `onLinkClick` (:1666-1685). `handleOscLink` (`src/renderer/src/components/terminal-pane/terminal-osc-link-routing.ts:27-111`) currently handles `http:`/`https:` (:81) and `file:` (:90) and returns `false` for everything else.

### 5.2 Renderer branch

Add to `terminal-osc-link-routing.ts` after the http branch (:88):

```ts
if (parsed.protocol === 'orca:') {
  routeTerminalOrcaDeepLink(parsed.toString(), deps.worktreeId)
  return true
}
```

**New file** `src/renderer/src/components/terminal-pane/terminal-orca-deep-links.ts`:

```ts
export function routeTerminalOrcaDeepLink(raw: string, worktreeId: string): boolean
```

1. `parseOrcaDeepLink(raw)`; `null` → toast "Unrecognized Orca link", return `true` (still consumed — never fall through to file-path detection).
2. `focus`: try `focusRendererTerminalHandle(handle, runtimeEnvironmentId)` first (`terminal-handle-links.ts:125-147` — already does `setActiveWorktree` → `activateTabAndFocusPane`, `src/renderer/src/lib/activate-tab-and-focus-pane.ts:13-50`, and understands remote-runtime pty ids via `parseRemoteRuntimePtyId`). On miss, fall back to the runtime RPC `terminal.focus` via `callRuntimeRpc` (same client the handle-link provider imports, `terminal-handle-links.ts:7`) so handles for sleeping/other-window sessions still resolve.
3. `worktree` → store actions directly (`setActiveWorktree`/`revealWorktreeInSidebar`, as :135-145).
4. `pair`/`run` → open the consent surface locally with `origin: { source: 'terminal', worktreeId }`.

Clicks stay behind the existing modifier gate (`isDesktopOscLinkActivation`, routing file :15-25; aterm-side `isLinkActivation`, `aterm-link-input.ts:108-111`) — Cmd/Ctrl+click, same as http/file. **Never** hand `orca://` to `shell.openExternal` / the OS: it would bounce through the (hijackable) OS handler and erase the origin.

**Named tests** — extend `terminal-osc-link-routing` tests: `routes orca links in-app and consumes the click`, `orca link without modifier is ignored`, `malformed orca link toasts and does not fall through to path detection`; new `terminal-orca-deep-links.test.ts`: `focus prefers renderer-local handle target`, `falls back to terminal.focus rpc for unknown local handle`, `run link opens consent with terminal origin`.

### 5.3 Why in-app routing is a security property

Terminal output is attacker-influenced (any program can print OSC-8). Routing terminal clicks internally (a) keeps the true origin (`worktreeId` of the minting pane) for consent labeling, (b) is immune to OS-level `orca://` handler hijack by another installed app, (c) works on Linux AppImage without desktop integration.

### 5.4 Emission contract (docs)

Document in the PR + `docs/`: agents emit
`ESC ] 8 ; ; orca://focus/term_<uuid> ESC \ label ESC ] 8 ; ; ESC \`
with the handle from `orca terminal list --json` (`src/cli/help.ts:218`). Markdown `[label](orca://focus/…)` rendered by agent TUIs already lands as OSC-8.

---

## 6. SECURITY model

### 6.1 No command execution without explicit confirm

`run` links **always** raise a modal consent dialog. There is no bypass, no setting to disable the prompt, and **no "always allow"** (a remembered grant converts a one-time click into a persistent RCE primitive for anything that can mint a link).

**New component** `src/renderer/src/components/terminal-pane/RunCommandConsentDialog.tsx` (shadcn `AlertDialog` from `src/renderer/src/components/ui/`, tokens per `docs/STYLEGUIDE.md`; pattern: `CloseTerminalDialog.tsx`):

- Shows: full decoded command in a monospace scrollable block (no truncation of the executed text — what is shown is exactly what runs), target worktree display name + path, origin label (§6.2).
- Default-focused button is **Cancel**; Enter must not confirm; confirm is a destructive-styled button labeled "Run command".
- Confirm → the existing `terminal.create` action (`src/main/runtime/rpc/methods/terminal.ts:1393-1412` / notifier `ui:createTerminal`, `attach-main-window-services.ts:260-313`) with `{ worktree, command, focus: true, activate: true }`. The command runs in a **new** tab — never injected into an existing PTY's stdin (no write-to-foreground-agent primitive).
- Test `RunCommandConsentDialog.test.tsx`: `renders full command and worktree`, `enter key does not confirm`, `labels terminal origin as untrusted output`, `no always-allow control rendered`.

`pair` reuses the pairing pane's existing review/accept flow (`src/renderer/src/web/WebConnect.tsx` grammar shared via `src/shared/pairing.ts`); a deep link only pre-fills the input — it never auto-pairs on desktop.

### 6.2 Origin labeling

Consent and toasts always state provenance; origin is assigned by the **transport**, never parsed from the URL:

- `{ source: 'os' }` → "Opened from outside Orca (a browser or another application)".
- `{ source: 'terminal', worktreeId }` → "Clicked in terminal output of *\<worktree name\>* — terminal output is untrusted".

Main-process dispatch stamps `os` on everything from `open-url`/argv; the renderer stamps `terminal` only on the `handleOscLink` path. `ui:deepLink` is a main→renderer channel only; no renderer→main IPC accepts an origin claim.

### 6.3 Navigation links (focus/worktree) run without confirm — bounded

Focus/activate cannot execute code and matches the notification-click precedent (`notifications.ts:522-556`). Bounds:

- Handle regex + worktree `::` validation before any RPC (§2).
- **Rate limit** OS-routed navigation: max 1 dispatch per 300 ms, queue depth 4 (`createDeepLinkRouter.maxQueued`) — a malicious web page looping `location.href = 'orca://focus/…'` cannot thrash focus or DoS the runtime resolver. Terminal-origin links are naturally rate-limited (each requires a physical modifier+click).
- While a consent dialog is open, navigation dispatches are deferred (renderer holds them until the dialog closes) — a focus link must not re-target the UI under a user's pointer mid-consent (clickjack hardening).

### 6.4 Other hardening

- Length cap before parse (`MAX_ORCA_DEEP_LINK_LENGTH`) on every entry path (argv, open-url, OSC-8 — the engine additionally caps at `MAX_HYPERLINK_URL_BYTES`).
- argv scraping takes only `^orca://`-matching args (§4.2); everything else in a second instance's argv is untouched.
- Only `pair` may carry secrets; its strict `hostname === 'pair'` + `code` extraction is reused verbatim (`src/shared/pairing.ts:30-47`). `focus`/`worktree`/`run` URLs are logged; `pair` URLs are logged **redacted**.
- No new remote surface: deep links do nothing on the relay/mobile web client beyond the pairing hash flow that already exists (`src/renderer/src/web/web-pairing.ts:35-59` is untouched).

---

## 7. aterm engine work (flagged — Trust conventions apply)

### 7.1 The gap

`handle_osc_8` (`rust/aterm/crates/aterm-core/src/terminal/handler_osc.rs:344-427`) accepts a URI only if `is_allowed_scheme(uri)` (:393-401 gate; fn at :818-845) passes, and `SAFE_SCHEMES` is hardcoded `["http","https","mailto","sftp","tel"]` (:820). An `orca://` OSC-8 sequence is dropped at parse time — no grid hyperlink, `link_at` never reports it, the renderer branch (§5.2) is unreachable. The allowlist is deliberately hostile to custom schemes (F01-4 / #7919: attacker-registered URL handlers reachable via `NSWorkspace.open`), so the fix must not simply append `orca` for every aterm embedder.

### 7.2 Design: host-minted extra schemes

`hyperlink_auth.rs` already documents this exact extension (module doc, "admits future extension to a capability that carries an explicit `Vec<SchemeId>`… v1 keeps the allowlist unchanged"). Implement it:

- `HyperlinkAuth` gains `extra_schemes: Vec<Box<str>>` (stateful → **`ty_model!` registration** per Trust conventions, and a **`spec_xref`** anchor tying it to the OSC-8 acceptance spec; the spec-xref gate lives in aterm-gui's test build per `rust/aterm/crates/aterm-core/src/terminal/mod.rs:81-83`).
- New host API in `state_accessors.rs`, beside `authorize_hyperlinks`/`revoke_hyperlinks` (:597/:608):
  ```rust
  pub fn authorize_hyperlink_scheme(&mut self, scheme: &str) -> bool  // false = refused
  pub fn revoke_hyperlink_scheme(&mut self, scheme: &str)
  ```
  Validation inside `authorize`: RFC 3986 scheme shape (reuse the char-walk in `is_allowed_scheme` :828-839), ASCII-lowercased for storage, hard-refuse a never-allow set (`javascript`, `data`, `file`, `vbscript`, `about`, `blob`) even when the host asks, bounded count (≤4) and length (≤32).
- `is_allowed_scheme(uri)` → `is_allowed_scheme(uri, extra: &[Box<str>])`; call site :393 threads `&self.hyperlink_auth`. Comparison stays `eq_ignore_ascii_case`. The orthogonal predicates in `handle_osc_8` — byte cap (`MAX_HYPERLINK_URL_BYTES`), control-char scan, BiDi-override rejection (:393-401) — run **unchanged** for extra schemes; the capability mint (`try_mint_capability`, :404) still gates acceptance, so `revoke_hyperlinks` also kills orca links.
- wasm export in `rust/aterm/crates/aterm-wasm/src/notifications_api.rs`-style module (pattern: `authorize_notifications` at :123):
  ```rust
  pub fn authorize_hyperlink_scheme(&mut self, scheme: &str) -> bool
  ```
- **Adversarial review focus** (per Trust process): scheme-smuggling (`orca\t:`, `ORCA%3A`, empty scheme, scheme with `+.-` prefix tricks), interaction with URI-reconstruction of literal semicolons (:356-365), that a *revoked* extra scheme can't survive `reset.rs`, and that the never-allow set can't be evaded by case or trailing chars.

**Named engine tests** (in `handler_osc.rs` tests + `aterm-conformance` where the OSC-8 cases live):
`osc_8_custom_scheme_rejected_without_host_mint`, `osc_8_custom_scheme_accepted_after_authorize_hyperlink_scheme`, `authorize_hyperlink_scheme_refuses_javascript_data_file`, `authorize_hyperlink_scheme_refuses_malformed_scheme_shapes`, `revoke_hyperlink_scheme_restores_default_allowlist`, `osc_8_extra_scheme_still_rejects_bidi_and_control_chars`, `osc_8_extra_scheme_still_capped_by_max_url_bytes`, `reset_clears_extra_schemes_is_a_host_choice` (document chosen semantics: extra schemes are terminal-instance state, surviving soft reset like other host authorizations).

### 7.3 Glue plumbing (mechanical, all existing seams)

Regenerate wasm blobs + artifact pin (`src/renderer/src/lib/pane-manager/aterm/aterm_wasm_artifact_pin.json`; convention: `chore(aterm): regenerate wasm blobs + artifact pin`, see recent history c22158d9d). Then thread one method through the worker/facade chain:

| Seam | File:line |
|---|---|
| Worker method allowlist | `src/renderer/src/lib/pane-manager/aterm/aterm-worker-engine-build.ts:128` (add `'authorize_hyperlink_scheme'`) |
| Worker dispatch case | `aterm-worker-pane-dispatch.ts:284-289` (new `setHyperlinkSchemeAuthorized` case) |
| Worker-side term facade | `aterm-worker-term.ts:344-347` (post message) |
| In-process mapping | `aterm-worker-terminal.ts:313` area (`(scheme) => e.authorize_hyperlink_scheme(scheme)`) |
| Pane wiring | `aterm-pane-wiring.ts:409` area |
| Stable controller | `aterm-pane-stable-controller.ts:75-76` (add `authorizeHyperlinkScheme`) |
| Install point | `use-terminal-pane-lifecycle.ts:803-838` — `installAtermEngineAuthorizations` calls `controller.authorizeHyperlinkScheme('orca')` alongside the OSC-52/notification gates; the existing bounded-poll installer (:823) covers the async controller |

Test at the drain layer mirroring `aterm-notification-drain.test.ts:182-190`: `authorize_hyperlink_scheme posts the setHyperlinkSchemeAuthorized command`.

---

## 8. SSH / remote runtimes

- Handles are runtime-scoped; the renderer resolver already carries `runtimeEnvironmentId` (`terminal-handle-links.ts:98-123`, `parseRemoteRuntimePtyId`). A link minted inside an SSH-hosted pane and clicked there resolves in the connected desktop app (renderer path, §5.2) — no OS involvement on the remote host, so nothing to register over SSH.
- `terminal.focus` RPC fallback executes on whichever runtime issued the handle; stale-handle errors surface as toasts (predicate precedent: `terminal.resizeForClient`'s `terminal_handle_stale`, `rpc/methods/terminal.ts:1444-1447`).
- `run` consent displays the execution host (worktree's `executionHostId`) so "Run command" is never ambiguous about *where*.
- No Git invocation anywhere in this feature; Git-compat rules are untouched.

---

## 9. Data shapes / protocol changes (summary)

- **New** `src/shared/orca-deep-link.ts` — `OrcaDeepLink`, `OrcaDeepLinkOrigin`, `parseOrcaDeepLink`, constants (§2).
- **Changed** `acquireSingleInstanceLock` callback: `() => void` → `(argv: string[]) => void` (`src/main/startup/single-instance-lock.ts:29`).
- **New IPC** main→renderer `ui:deepLink { link, origin }`; preload `window.api.deepLink.onDeepLink` (beside :3578's `ui:focusTerminal` listener). No new renderer→main channels for v1 (focus/worktree ride existing `ui:focusTerminal`/`ui:activateWorktree`; renderer fallback uses the existing runtime RPC client).
- **New engine API** `Terminal::authorize_hyperlink_scheme` / `revoke_hyperlink_scheme` + wasm export + `is_allowed_scheme(uri, extra)` (§7).
- **electron-builder** top-level `protocols` entry (§3.1).
- No persisted-state or settings-schema changes in v1 (no toggle: the scheme authorization is unconditional, the security boundary is the consent gate, not linkification).

## 10. Phasing & effort

**PR 1 — v1, matches the issue's minimal scope (M):** engine extra-scheme capability + wasm regen (§7), scheme registration + packaging (§3), single-instance/open-url routing (§4) for `focus` only, renderer `orca:` branch (§5), grammar parser with `worktree`/`pair`/`run` **parsed but dispatched as "unsupported yet" toast** (grammar is forward-fixed from day one).

**PR 2 — v2 (M):** `worktree` navigation dispatch, `pair` pre-fill routing, `run` + `RunCommandConsentDialog`, consent-deferral of navigation (§6.3).

Manual QA matrix (registration can't be unit-tested): macOS `open orca://focus/…` cold+warm, Windows `start orca://…` cold+warm+second-instance, Linux deb `xdg-open` + AppImage-without-integration negative case, dev-mode `process.defaultApp` variant on all three.

---

## Critic notes

Spot-checked 2026-07-22. Verified exactly as cited: `SAFE_SCHEMES` (handler_osc.rs:820), the `is_allowed_scheme` gate (:394, fn :818), `try_mint_capability` (:404), `authorize_hyperlinks`/`revoke_hyperlinks` (state_accessors.rs:597/:608), the hyperlink_auth module doc promising exactly this extension (`Vec<SchemeId>`, :52-53), strict pairing hostname check (pairing.ts:39), `acquireSingleInstanceLock(app, onSecondInstance: () => void)` (:29 — signature change is as described), `handleOscLink` http/file branches (:81/:90), `runtime.focusTerminal(handle)` (orca-runtime.ts:20482), and no `protocols` entry in electron-builder.config.cjs today. The engine design (§7) is precise and correctly scoped for Trust review. One blocking defect and two notes:

1. **BLOCKING — §5.1/§5.2 route through code that aterm panes never reach.** The claim "OSC-8 clicks reach `handleOscLink` two ways" is false for the shipping aterm surface: the engine click path sends kind-0 (OSC-8) hits through `openUrl` (aterm-link-input.ts:308-312 → `createAtermUrlOpener`, which is http(s)-only); `pane.terminal.options.linkHandler` (use-terminal-pane-lifecycle.ts:1327) is a facade option bag that nothing in the aterm pane-manager ever invokes (only type declarations reference it — terminal-types.ts:141/:228); and `onLinkClick` (:1666) serves provider/plain-text link clicks, not engine OSC-8 hits. So even after the engine mints the `orca` scheme, adding the `orca:` branch to `terminal-osc-link-routing.ts` is dead code for aterm panes. **Fix: PR 1 has a hard dependency on #6880 (partial-completions.md), whose `createAtermOscLinkOpener` reroutes kind-0 clicks through `handleOscLink`** — land #6880 first (it is S), or alternatively put the `orca:` branch directly in the kind-0 opener. The BUILD-PLAN sequences #6880 ahead of deep-links PR 1 for this reason.
2. §6.3's consent-time navigation deferral: dispatches arrive via main→renderer `ui:focusTerminal`/`ui:activateWorktree`, but consent state lives in the renderer. Specify that the *renderer listeners* hold/queue navigation while a consent dialog is open (simplest, no new IPC); as written the deferral's owner is ambiguous.
3. §3.2's collision analysis is honest and correct; also note dev-mode `setAsDefaultProtocolClient` with args mutates the OS handler to point at the dev shim — gate dev registration behind an env opt-in so a dev run doesn't steal the scheme from the installed app on Windows/Linux.

Effort M/L per PR stands once the #6880 dependency is added.
