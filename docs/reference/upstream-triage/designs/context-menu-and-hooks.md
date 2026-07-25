# Design: Richer Terminal Context Menu (#9279) + orca.yaml Hooks/Quick Commands (#8481)

Sources: `upstream-triage/issues-open.json` (bodies for #9279, #8481), `upstream-triage/terminal-audit-verdicts.json` (`n:9279` still-applies, `n:8481` still-applies). All file:line references verified against the working tree on 2026-07-22.

> **Scope correction for Item B (read first).** The triage framing of #8481 as "orca.yaml preCreate hook" is a misreading of the audit verdict. Issue #8481's actual body requests **project-level Quick Commands in `orca.yaml`**. The verdict's evidence sentence ("parseOrcaYaml recognizes only scripts.preCreate/setup/archive … no quickCommands key") names preCreate only to show what IS recognized. Verification below shows **`scripts.preCreate` is fully implemented and executed** on every worktree-creation path (local, WSL, SSH, remote runtime) with tests. Item B therefore has two parts: (B1) the verification record proving no preCreate work is needed, and (B2) the design for the real #8481 gap — `quickCommands` in `orca.yaml` — which the verdict correctly marks still-applies.

---

## Item A — #9279: Richer terminal context menu

### Current state

- Menu component: `src/renderer/src/components/terminal-pane/TerminalContextMenu.tsx` — items today: Copy (:197), Paste (:202), Quick Commands submenu (:207-265), Fork Agent Session (:266), Copy Context (:273), chat toggle (:280), Split Right/Down (:296-311), Equalize (:312), Expand (:324), Set Title (:340), Clear Pane Title (:354), Copy Terminal ID (:366), Copy Pane ID (:373), Close Pane (:380), Clear Screen (:394-400).
- Action hook: `src/renderer/src/components/terminal-pane/use-terminal-pane-context-menu.ts` — `openContextMenu` (:466-512) receives the right-click `MouseEvent` (has `clientX/clientY`), resolves the clicked pane via `contextPaneIdRef` (:482), and `resolveMenuPane()` (:139-150) resolves the target `ManagedPane` for each action. Note the `rightClickToPaste` early-return (:486-506): when that setting is on, right-click never opens the menu (Ctrl+right-click still does) — all new items are simply unreachable in that mode, which is existing accepted behavior.
- Wiring: `TerminalPane.tsx:2610` (`useTerminalPaneContextMenu`), `:3079-3100` (menu props).
- Link activation today is modifier-click only: `src/renderer/src/lib/pane-manager/aterm/aterm-link-input.ts:108-111` (`isLinkActivation`: Cmd on Mac / Ctrl elsewhere), engine hit-test `term.link_at(row, col)` (:247, :360), worker async variant `linkAtAsync` (`aterm-worker-query-channel.ts:28,74,218`), provider fallback `resolveProviderLinkAt` (`aterm-provider-link-hit.ts`).

### Proposed menu layout (new items marked ★)

```
Copy                              ⌘C
★ Copy Last Command Output              (hidden when no completed OSC-133 block)
Paste                             ⌘V
★ Search for "<selection…>"             (hidden when no selection)
─────────────────────────────
★ Open Link / Open File                 (link-target group, hidden when no link under cursor)
★ Copy Link / Copy Path
★ Reveal in Finder / File Manager       (file-path targets on local panes only)
─────────────────────────────
Quick Commands ▸ … (unchanged)
… existing split/expand/title/id items unchanged …
─────────────────────────────
Clear Screen & Scrollback               (relabel of today's "Clear Screen", see A4)
★ Terminal Settings…
```

Link-target items render at the top of the menu only when a target was resolved at menu-open time (see A2); Radix `DropdownMenuItem` + lucide icons per STYLEGUIDE; labels via `translate('auto.components.terminal.pane.TerminalContextMenu.<descriptiveKey>', …)` following the existing `clearPaneTitle`/`copyTerminalId` descriptive-key style.

### A1 — Search Selection

Seams:
- Selection text: `pane.atermController?.selectionText() ?? pane.terminal.getSelection()` — exact pattern already used at `use-terminal-pane-context-menu.ts:159` and `:495-496`. Controller surface: `aterm-pane-controller-types.ts:38`.
- Search UI: `src/renderer/src/components/TerminalSearch.tsx` (opened by `TerminalPane.tsx:370` `searchOpen` state, rendered at `:3027-3029`); search state shared with keyboard nav via `searchStateRef` (`keyboard-handlers.ts:109-113` `SearchState = { query, caseSensitive, regex }`).
- Precedent for normalizing a selection into a query: `normalizeSelectedTextForFileSearch` (`@/lib/file-search-selection`, imported at `keyboard-handlers.ts:30`).

Design:
1. `TerminalSearch.tsx` gains an optional prop `seedQueryRef?: React.RefObject<string | null>`. On the `isOpen` false→true transition (existing `useEffect` on `isOpen`), if `seedQueryRef?.current` is non-empty: `setQuery(seed)`, run the debounce-bypassed find (same path as the Enter bypass, `armedFindRef`/`runFind`), then null the ref. One-shot; typing afterwards behaves exactly as today.
2. `TerminalPane.tsx` creates `const searchSeedRef = useRef<string | null>(null)` next to `searchOpen` (:370) and passes it to `TerminalSearch` (:3027).
3. New hook dep `onSearchSelection: (selection: string) => void` in `UseTerminalPaneContextMenuDeps` (`use-terminal-pane-context-menu.ts:57-75`); implementation in `TerminalPane.tsx`: `searchSeedRef.current = firstLineTrimmed(selection); setSearchOpen(true)`. Normalize: take the first line, trim, cap at the find-query bound (`getFindRequestQuery` / `isFindQueryTooLarge` from `@/lib/find-query-bounds`, already imported by `TerminalSearch.tsx:7`).
4. New menu action `onSearchSelection` in the hook: `resolveMenuPane()` → read selection (pattern above) → no-op when empty. Menu item hidden when `!menuHasSelection` — add `menuHasSelection: boolean` to `TerminalMenuState` computed like `menuPaneId` (:544), i.e. only while `open`, from `resolveMenuPane()?.atermController?.selectionText()`.

Data shape: no protocol change. Tests (named):
- `TerminalSearch.test.tsx` (or extend nearest): `seeds the query from seedQueryRef on open and runs an immediate find`.
- `TerminalContextMenu.test.tsx`: `shows Search Selection only while the pane has a selection`.

Effort: S. Engine work: none.

### A2 — Open Link / Copy Link / Reveal under cursor

The engine already does link detection (`link_at`, kinds 0=osc8 1=url 2=file_path — `aterm-link-input.ts:63-66`; wasm binding `rust/aterm/crates/aterm-wasm/src/lib.rs:1390`), plus xterm-style provider links (`aterm-provider-link-hit.ts`). What's missing is a way to resolve a target at the **right-click point** at menu-open time and act on it from the menu.

New resolver (renderer, no engine change):
1. Export from `aterm-link-input.ts` a point resolver reusing the private `pointToCell` (:84-94) and the exact click-path resolution order (:326-365):
   ```ts
   export type AtermContextLinkTarget =
     | { kind: 'url' | 'osc8'; url: string }
     | { kind: 'file'; rawPathText: string }
     | { kind: 'provider'; text: string; activate: (ev: MouseEvent) => void }
   export function resolveLinkTargetAtPoint(
     deps: AtermLinkDeps, clientX: number, clientY: number
   ): Promise<AtermContextLinkTarget | null>
   ```
   Resolution order (mirrors `onClick`): alt-screen / mouse-tracking → null (:332-334); engine hit via `linkAtAsync` when the worker facade exposes it, else sync `link_at` (:352-364); provider fallback via `resolveProviderLinkAt(providers, absoluteLine, col + 1)` (:187).
2. Expose on the controller: `contextLinkTargetAt(clientX, clientY): Promise<AtermContextLinkTarget | null>` — add to `AtermPaneController` (`aterm-pane-controller-types.ts`, next to `linkAt` :40), implement in `aterm-pane-wiring.ts` (same late-binding block as `setFileLinkOpener` :384), delegate in `aterm-pane-stable-controller.ts` (pattern at :45).
3. Capture at menu open: in `openContextMenu` (`use-terminal-pane-context-menu.ts:466`), before `setOpen(true)`, fire `clickedPane?.atermController?.contextLinkTargetAt(event.clientX, event.clientY)` and store the result in new state `const [menuLinkTarget, setMenuLinkTarget] = useState<AtermContextLinkTarget | null>(null)` (cleared on every open; the promise resolves within a frame on the worker path — items appear when resolved; gate on a menu-open sequence number so a late resolve for a closed menu is dropped).

Menu actions:
- **Open Link** (`kind: 'url' | 'osc8'`): route through the pane's existing opener so the in-app/system-browser preference is honored — `createAtermUrlOpener` (`aterm-url-link-routing.ts:19-35`); the wiring already holds the opener, so expose `openUrlTarget(url, { forceSystemBrowser: boolean })` alongside `contextLinkTargetAt` rather than duplicating routing. Shift semantics: plain select = preference routing, add an explicit second item "Open in System Browser" only if desired later (not in v1).
- **Open File** (`kind: 'file'`): invoke the pane's late-bound file opener — expose `openFileLinkRaw(rawPathText, openWithSystemDefault: boolean)` on the controller calling the closure installed by `installAtermFileLinkOpener` (`use-terminal-pane-lifecycle.ts:747-773`), which resolves via `extractTerminalFileLinkCandidates` + `resolveTerminalFileLink` against the pane cwd/home and opens via `openDetectedFilePath` with worktree/runtime context.
- **Provider target** (`kind: 'provider'`): call `target.activate(new MouseEvent('click'))` — provider activates carry their own routing (term_/task_ handles).
- **Copy Link / Copy Path**: `window.api.ui.writeClipboardText(target.url ?? target.rawPathText ?? target.text)` + `toast.success` (pattern `use-terminal-pane-context-menu.ts:178-183`).
- **Reveal in Finder / File Manager** (issue's first-class folder ask): for `kind: 'file'` only. Resolve the absolute path with the same `extractTerminalFileLinkCandidates`/`resolveTerminalFileLink` pair used by the lifecycle closure, then `window.api.shell.openInFileManager(path)` (preload `src/preload/index.ts:2133` → IPC `shell:openInFileManager` → `src/main/ipc/shell.ts:53-66`, reveal semantics via `shell.showItemInFolder` :62 with absolute-path + existence validation :40-51). **SSH/remote gating**: hide the item when the pane belongs to an SSH connection or remote runtime — check `getConnectionId(worktreeId)` (already imported, `use-terminal-pane-context-menu.ts:7`) and `getRuntimeEnvironmentIdForWorktree` (:8); the shell IPC validates local existence and would correctly fail, but hiding is the honest UX. Label per platform: `Reveal in Finder` on Mac / `Reveal in File Explorer` on Windows / `Reveal in File Manager` on Linux (use `isMacPlatform()` already imported by `TerminalContextMenu.tsx:39`; Windows via `navigator.userAgent.includes('Windows')` per AGENTS cross-platform rule).

Also covers the issue's discoverability ask without changing plain-click: the menu is the non-modifier path. (Plain-click activation is out of scope — it conflicts with selection-drag and mouse-reporting apps.)

Tests (named):
- `aterm-link-input.test.ts`: `resolveLinkTargetAtPoint returns the engine hit at the right-clicked cell`, `resolveLinkTargetAtPoint falls back to provider links when the engine reports none`, `resolveLinkTargetAtPoint returns null on alt-screen and under mouse tracking`.
- `TerminalContextMenu.test.tsx`: `renders Open/Copy link items only when a link target resolved`, `hides Reveal in File Manager for SSH and remote-runtime panes`, `Copy Path copies the raw matched span`.

Effort: M. Engine work: none (engine `link_at` + worker `linkAtAsync` already exist).

### A3 — Copy Last Command Output (OSC 133) — **aterm engine surface**

Facts established:
- The engine already has a complete OSC-133 block model: `rust/aterm/crates/aterm-core/src/terminal/blocks_api.rs` — `output_blocks()` :83, `current_block()` :95, `last_successful_block()` :251, `last_failed_block()` :268, `block_command_text()` :536, `block_output_text()` :576 returning `BlockText::{Text, Evicted, NotAvailable}` (:27-64, eviction-honest by design, "B-1 / DL-1"). OSC 133 parsing: `aterm-core/src/terminal/handler.rs:556` (+ nonce gating :188-190).
- The **wasm facade does not expose blocks**: no `block`-related method in `src/renderer/src/lib/pane-manager/aterm/aterm_wasm.d.ts` (grep confirms). This is the gap, and per fork policy it is fixed **in the engine bindings**, not by re-scanning bytes in TS.
- **Daemon fact relay is not a substitute** (task asked to check): `src/main/daemon/daemon-background-transient-facts.ts` relays only compact facts — `bell`, `command-finished` with `exitCode`, pr-link — scanned by the shared TS scanners (`shared/terminal-output-side-effects`); it carries **no output spans**. It exists so notification-bearing facts survive keep-tail thinning while a pane is backgrounded; it cannot produce command output text.
- **Reattach limitation is real and must be surfaced honestly**: blocks are excluded from engine checkpoints (`aterm-core/src/terminal/checkpoint.rs:38` — "OSC133 blocks … out of scope") and the daemon snapshot (`rust/crates/orca-daemon/src/rpc.rs:899` `build_snapshot`: ansi/cwd/modes/oscLinks only). A snapshot-rehydrated pane has no blocks until the next command completes.

Engine work (follows Trust conventions — `ty_model!` where stateful, `spec_xref` registration, adversarial review):
1. `rust/aterm/crates/aterm-wasm/src/lib.rs` (near `selection_text` :1376 / `serialize_scrollback` :1494): new binding
   ```rust
   /// Last completed OSC-133 block's output as JSON, following the
   /// take_osc_events JSON-drain convention:
   ///   {"status":"ok","text":"…","exitCode":0}
   ///   {"status":"evicted"}         // rows scrolled past the scrollback cap
   ///   undefined                    // no completed block (incl. post-reattach)
   pub fn last_command_output(&self) -> Option<String>
   ```
   Pure read over `output_blocks().last()` + `block_output_text` — stateless accessor, so no new `ty_model!` state; register the binding's contract via `spec_xref` against the blocks-api spec entry (aterm-spec/aterm-spec-models), and route through adversarial review because it exposes buffer content across the wasm boundary. Add `last_command_text()` later only if a "Copy Last Command" item is wanted; not v1.
2. Regenerate wasm blobs + artifact pin (`aterm_wasm_bg.wasm`, `aterm_wasm_artifact_pin.json` — same chore flow as commit `c22158d9d`).

Renderer plumbing (fork TS):
3. Controller: `lastCommandOutputAsync(): Promise<{ text: string; exitCode: number | null } | { evicted: true } | null>` on `AtermPaneController` (`aterm-pane-controller-types.ts`); in-process implementation parses the JSON binding directly; worker path adds a query op next to `linkAtAsync` (`aterm-worker-query-channel.ts:218` pattern) with the handler in `aterm-worker-terminal-query.ts`.
4. Menu action `onCopyLastCommandOutput` in `use-terminal-pane-context-menu.ts`: resolve pane → `lastCommandOutputAsync()` → `writeClipboardText(text)` + `toast.success('Command output copied')`; on `{evicted:true}` → `toast.error('Output scrolled past the scrollback limit')`; on `null` → item should not have been enabled (defensive no-op).
5. Enablement: add `menuHasCommandOutput` computed at menu open (same open-only pattern as `paneCount` :543): fire `lastCommandOutputAsync` when the menu opens and enable/disable the item on resolve. Hidden (not merely disabled) when the pane never produced a block — covers non-integrated shells and freshly-reattached panes.

Explicit non-goals / phase 2: a daemon RPC (`session.lastCommandOutput`) reading the daemon's headless aterm engine blocks (`orca-daemon/Cargo.toml:23` deps aterm-core; `HeadlessTerminal` in `rpc.rs:899`) would survive renderer reattach — defer until users hit the reattach gap; it is fork-Rust (orca-daemon), not aterm-engine work.

Tests (named):
- Engine (`aterm-wasm/src/lib.rs` tests mod, pattern `serialize_scrollback_is_history_only` :2085): `last_command_output_returns_latest_block_output_json`, `last_command_output_reports_evicted_after_scrollback_cap`, `last_command_output_is_none_without_shell_integration`.
- Renderer: `aterm-worker-block-query.test.ts`: `lastCommandOutputAsync round-trips the worker and preserves the evicted marker`; `TerminalContextMenu.test.tsx`: `Copy Last Command Output is hidden when the engine reports no completed block`.

Effort: M (Rust binding S + pin/regen chore + TS plumbing S-M, but Trust review adds overhead). Engine work: **yes**.

### A4 — Clear Scrollback

Already implemented, mislabeled. Today's "Clear Screen" item (`TerminalContextMenu.tsx:394-400`) → `onClearScreen` (`use-terminal-pane-context-menu.ts:386-391`) → `clearPaneScrollback` (`TerminalPane.tsx:1064-1078`) which (a) clears engine screen+scrollback via `clearTerminalScrollbackAndFollowOutput` (`src/renderer/src/lib/pane-manager/terminal-scrollback-clear.ts:9-17`, `terminal.clear()` + follow-output reset), (b) clears the remote-host buffer (`clearWebRuntimeTerminalBuffer`) or the local/daemon/SSH PTY buffer (`window.api.pty.clearBuffer`, :1073) so a later snapshot doesn't replay cleared content, and (c) persists the layout snapshot. The keyboard path shares it (`keyboard-handlers.ts:545`).

Design: relabel the item to **"Clear Screen & Scrollback"** (one translate-key change, key `…TerminalContextMenu.clearScreenAndScrollback`) and show the existing binding via `formatPrimaryShortcutLabel` if one exists for the clear action. Do **not** add a separate screen-only clear — no user ask, and it would need a new engine mode.

Test: `TerminalContextMenu.test.tsx`: `Clear Screen & Scrollback routes to onClearScreen` (label assertion update).

Effort: XS. Engine work: none.

### A5 — Terminal Settings jump

Seam exists: app-store UI slice `openSettingsTarget` (`src/renderer/src/store/slices/ui.ts:742,1459`) with target shape `{ pane: SettingsNavTarget; repoId: string | null; sectionId?: string; intent?: 'add-quick-command' }` (:736-741), plus `openSettingsPage()`. `SettingsNavTarget` includes `'terminal'` and `'terminal-engine'` (`src/renderer/src/lib/settings-navigation-types.ts:13+`). Working precedent: `WorktreeJumpPalette.tsx:904-906` (`{ pane: 'quick-commands', repoId: null, intent: 'add-quick-command' }` then `openSettingsPage()`), `use-add-repo-hosted-controller.ts:68-69`.

Design: menu item **"Terminal Settings…"** (icon `Settings2`) at the menu bottom; action in `use-terminal-pane-context-menu.ts`:
```ts
const onOpenTerminalSettings = (): void => {
  useAppStore.getState().openSettingsTarget({ pane: 'terminal', repoId: quickCommandRepoIdOrNull })
  useAppStore.getState().openSettingsPage()
}
```
(“per-pane” today means the terminal settings that govern this pane; there is no pane-scoped settings model, so `pane:'terminal'` + the pane's repo id is the deepest existing target. If the pane is on the aterm engine settings surface, `sectionId` can later target the appearance accordion via `setAppearanceAccordionDeepLink('terminal')`, ui.ts:748+ — not v1.) Close the menu first via `onOpenChange(false)` (the same overlay-guard pattern as Set Title, `TerminalContextMenu.tsx:340-346`).

Test: `TerminalContextMenu.test.tsx`: `Terminal Settings item sets the settings navigation target and opens the settings page`.

Effort: XS. Engine work: none.

---

## Item B — #8481

### B1 — Verification: `scripts.preCreate` IS executed (audit-framing premise is false)

Parse seam (as the triage note says): `src/shared/orca-yaml.ts:142,152,165` (`parseOrcaYaml`), type `src/shared/types.ts:2045` (`preCreate?: string // Runs in the primary repo before git worktree add (#4566…)`).

Effective-hooks policy: `src/main/hooks.ts:205-239` `getEffectiveHooksFromConfig` — preCreate is yaml-only (no local Settings slot), and a `'local'` command-source policy suppresses it (:220-226). Trust/run gate shared with setup: `shouldRunSetupForCreate` (:250-264; `'ask'` policy throws until the caller supplies a decision).

Execution seams — all three worktree-creation paths run it **before `git worktree add`**, and all three hard-fail creation on hook failure:

| Path | Call site | Runner | Failure semantics | Timeout |
|---|---|---|---|---|
| Local desktop (incl. WSL) | `src/main/ipc/worktree-remote.ts:2326-2340` in `createLocalWorktree` (fn at :1971), timed as `pre_create_hook` | `runHook('preCreate', repo.path, …)` → `src/main/hooks.ts:541+`; WSL branch translates env to Linux paths + `wsl.exe -- bash -c` (:557-620) | throws `"orca.yaml preCreate hook failed; worktree was not created."` + hook output | `HOOK_TIMEOUT = 120_000` (`hooks.ts:25`) |
| SSH host | `src/main/ipc/worktree-remote.ts:1745-1770` in `createRemoteWorktree` (fn at :1552) | `provider.execNonInteractive('bash', ['-lc', script], repo.path, …)` — headless in the primary repo via the relay; hooks read remotely via `readRemoteEffectiveHooks` (:1746) | non-zero exit → same throw with stdout+stderr | `PRE_CREATE_HOOK_TIMEOUT_MS = 120_000` (:1532) |
| Remote runtime (web/server) | `src/main/runtime/orca-runtime.ts:16835-16847` | `runHook('preCreate', repo.path, …)`; decision from `args.runHooks ? 'run' : (args.setupDecision ?? 'inherit')` | same throw | `HOOK_TIMEOUT` |

Tests already pinning this: `src/main/ipc/worktrees.test.ts:6317` (`runs the preCreate hook in the primary repo before git worktree add`), `:6343` (`does not run the preCreate hook when the setup decision skips hooks`), `:6365` (`fails the create when the preCreate hook fails`); parse/policy tests `src/main/hooks.test.ts:56, 308-330`.

**Verdict for triage**: change the internal tracking for "preCreate unimplemented" to **addressed** (implemented per #4566 with SSH + WSL + runtime coverage and failure semantics exactly as this task asked to be designed). Keep `n:8481` **still-applies** — but for its real subject, quickCommands (B2).

Residual gap worth one test, not a design: there is no `worktree-remote.test.ts` (`ls src/main/ipc` confirms), so the **SSH** preCreate branch (:1745-1770) is untested — the timeout constant, `bash -lc` invocation, and the non-zero-exit throw are pinned only by the local-path tests. Named test to add wherever the SSH create path is next given a harness: `runs the preCreate hook over the SSH relay before git worktree add and aborts create on non-zero exit`.

### B2 — The real #8481: project-level Quick Commands in `orca.yaml`

Current state (verdict-confirmed): Quick Commands are local-settings-only — `settings.terminalQuickCommands` filtered per repo/global scope in `TerminalPane.tsx:867-875`; types `src/shared/types.ts:2532-2560` (`TerminalQuickCommand` = base `{id, label, scope?}` + `terminal-command` (`command`, `appendEnter`) | `agent-prompt` variants); `parseOrcaYaml` has no `quickCommands` key.

#### YAML shape (matches the issue's proposal)

```yaml
quickCommands:
  - label: Dev server          # required, non-empty after trim
    command: npm run dev       # terminal-command variant: required
    appendEnter: true          # optional, default true (issue's "Insert" = false)
  - label: Investigate
    action: agent-prompt       # agent variant
    agent: claude              # required for agent-prompt
    prompt: Investigate the current branch and summarize findings
```

v1 supports both variants (the issue's open question) because dispatch for both already exists (`runQuickCommandInNewTab` / `sendTerminalQuickCommandToPane`, `use-terminal-pane-context-menu.ts:415-431`). Cap at 30 entries; excess and invalid entries produce diagnostics, not failures (mirror `environmentRecipeDiagnostics`, `orca-yaml.ts:100-123`).

#### Parse + types

- `src/shared/types.ts`: extend `OrcaHooks` (:2043-2053) with `quickCommands?: OrcaProjectQuickCommand[]` and `quickCommandDiagnostics?: OrcaVmRecipeDiagnostic[]`-style entries, where
  ```ts
  export type OrcaProjectQuickCommand =
    | { label: string; command: string; appendEnter?: boolean }
    | { label: string; action: 'agent-prompt'; agent: string; prompt: string }
  ```
  (No `id` in yaml; a stable id is derived — see merge.)
- `src/shared/orca-yaml.ts` `parseOrcaYaml` (:127-175): parse `record.quickCommands` with the same `asRecord`/`asTrimmedString` guards; include in the "any content" emptiness check (:151-159).

#### Delivery to the renderer

Reuse the existing hooks pipe — **no new IPC**: `parseOrcaYaml` output already flows through `loadHooks`/`getEffectiveHooks` (`hooks.ts:241-243`) and reaches the renderer via `window.api.hooks.check` / runtime RPC `repo.hooksCheck` (`src/renderer/src/runtime/runtime-hooks-client.ts:22-37`, `HookCheckResult.hooks: OrcaHooks | null`). SSH repos already read via `readRemoteEffectiveHooks` (`worktree-remote.ts:1746`), so SSH projects get them with zero extra transport work. Renderer: a small store/query hook (`useProjectQuickCommands(repoId)`) that calls `checkRuntimeHooks` on repo open and caches per repo; invalidate on the existing hooks-refresh path (`RepositoryHooksSection.tsx` uses the same client).

#### Merge + provenance (issue's open question)

- Derived id: `orcaYaml:<repoId>:<index>` — stable across reloads, never collides with settings ids.
- Union with local commands; the Quick Commands submenu (`TerminalContextMenu.tsx:215-264`) shows project entries under the existing repo-label group with a `GitFork`-style "shared" glyph or `(project)` suffix; **local wins on duplicate label within the repo scope** (local override, per the issue's "local overrides remain possible").
- Settings UI (`quick-commands` pane) lists project entries read-only with a "defined in orca.yaml" caption — no editing, edits go through git.

#### Trust gating (issue's open question — yes, same model as defaultTabs)

Quick commands are user-invoked per click, but they inject bytes into a shell, so gate identically to other shared orca.yaml commands:
- Suppress entirely when the repo's command-source policy resolves `'local-only'` — reuse `canRunSharedCommands` (`hooks.ts:296-299`).
- Include their command/prompt text in the trust-content hash so the existing `OrcaYamlTrustDialog` (`src/renderer/src/components/sidebar/OrcaYamlTrustDialog.tsx`) re-prompts when a teammate changes them: extend `getDefaultTabCommandTrustContent` (`hooks.ts:266-277`) with a `# quickCommands[n] <label>` section (rename to `getSharedCommandTrustContent` at that seam; keep the old export as an alias if call sites are wide).
- Until trusted, project entries render disabled with a "Review orca.yaml trust" hint item.

#### Tests (named)

- `src/main/hooks.test.ts` (or a shared orca-yaml test file): `parses quickCommands terminal and agent variants and drops incomplete entries`, `caps quickCommands and reports diagnostics for the overflow`, `local-only command source policy suppresses orca.yaml quick commands`, `quick command text changes the shared trust content hash`.
- `TerminalContextMenu.test.tsx`: `renders project quick commands under the repo group with provenance and disables them until trusted`.
- `TerminalPane`-level: `local quick command overrides a project quick command with the same label`.

Effort: M. Engine work: none.

---

## Summary

| Item | What | Effort | Engine (aterm) work |
|---|---|---|---|
| A1 | Search selection → seeded TerminalSearch | S | no |
| A2 | Link/path target at right-click point + open/copy/reveal | M | no (engine link_at + worker linkAtAsync exist) |
| A3 | Copy last command output | M | **yes** — expose `last_command_output()` JSON binding in aterm-wasm over the existing blocks_api; Trust conventions + wasm pin regen |
| A4 | Clear scrollback | XS (relabel; already implemented) | no |
| A5 | Terminal settings jump | XS | no |
| B1 | preCreate verification | done — implemented on all paths; add one SSH-path test when a harness exists | no |
| B2 | orca.yaml quickCommands (real #8481) | M | no |

Combined implementation effort: **L** (dominated by A2 + A3 + B2; A3 carries Trust-review overhead).

## Critic notes

Spot-checked 2026-07-22. Verified exactly as cited: menu item layout and `openContextMenu` (:466, callers :528/:537), `resolveMenuPane` (:139), blocks API (`output_blocks` blocks_api.rs:83, `last_successful_block` :251, `last_failed_block` :268, `block_command_text` :536, `block_output_text` :576), zero block exposure in `aterm_wasm.d.ts` (the two grep hits are cursor-style comments), preCreate execution on the local path (worktree-remote.ts ~:2326-2340) and SSH path (~:1745-1770, `bash -lc`, `readRemoteEffectiveHooks`), `parseOrcaYaml` preCreate at orca-yaml.ts:142 with no `quickCommands` key, `openSettingsTarget` (ui.ts:742/:1459), `shell:openInFileManager` (shell.ts:150), `link_at`/`linkAtAsync` seams, `pointToCell` (aterm-link-input.ts:84). B1's verification record is correct and endorsed. Corrections:

1. **A3 binding signature is wrong as written.** `pub fn last_command_output(&self)` cannot compile against the blocks API: `output_blocks()` takes `&mut self` (blocks_api.rs:83-84, it calls `make_contiguous()` on the VecDeque). Declare the wasm binding `&mut self` (consistent with other wasm accessors that thread `&mut`), or read via the non-contiguous accessor path. Everything else about A3 (facade gap, daemon-facts non-substitute, checkpoint/snapshot exclusion) checks out.
2. **A2's `resolveLinkTargetAtPoint(deps, clientX, clientY)` needs a small refactor the design doesn't name**: `pointToCell(event, deps)` takes a `MouseEvent` (:84). Either generalize `pointToCell` to accept `{clientX, clientY}` or synthesize a coordinate object — trivial, but the stated signature implies it and the implementer shouldn't discover it mid-PR.
3. **B2 "reuse `canRunSharedCommands`"**: that name is a local const inside `getEffectiveHooksFromConfig`-adjacent code (hooks.ts:297), not an exported helper — the reuse requires extracting it (or the policy check around it) first. Same shape as the proposed `getSharedCommandTrustContent` rename; fold both into one refactor commit.
4. Minor: A1's `menuHasSelection` computed "only while `open`" must also recompute on the open *event*, not render — selection can be cleared between right-click and menu paint; compute it inside `openContextMenu` alongside `menuPaneId` (the design's cited pattern at :544 does exactly this, so just follow it literally).

Effort table stands; A3's engine flag (Trust conventions, wasm pin regen) is correctly scoped.
