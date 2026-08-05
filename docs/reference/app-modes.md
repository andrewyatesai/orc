# Orca Modes — Design

**Status:** approved architecture, not yet built. This is the document the team builds from.
**Home:** `docs/reference/app-modes.md` (the only tracked docs path that will survive — `.gitignore:120-133` ignores `docs/**` except `docs/assets/`, `docs/readme/`, `docs/reference/**`, `docs/STYLEGUIDE.md`, `docs/rust-migration/**`, and `docs/mobile-terminal-shortcut-bar.md`).

> **Reading note on line references.** `src/renderer/src/App.tsx` was 2,774 lines when this design was surveyed; it has since been decomposed into `src/renderer/src/app-shell/` and is now 395 lines (§5.3 Step 0). Any `App.tsx:NNNN` citation below points at the *pre-extraction* file — the behavior it describes is intact, but the code now lives in the module named in the §5.3 map. Citations to every other file are current.

---

## 1. Overview

A **mode** is a named, runtime-selected description of which of Orca's existing surfaces are visible, which component occupies three named layout slots, which CSS custom properties are remapped on the workspace subtree, and which i18n keys are swapped for other i18n keys. That is the complete list. A mode is data plus, at most, three lazily-mounted components.

| Mode | One sentence |
| --- | --- |
| **Orca Classic** | Today's product, unchanged to the byte — the baseline every other mode is defined as a subtraction from. |
| **ALab** | A supervisory console over a fleet of agent terminals: missions, an exceptions queue, a fleet roster, and evidence — with files, diffs and tabs hidden but live. |
| **Story World** | A three-band stage for a child: a picture list of worlds, a real agent terminal framed in plain language, and a live window rendering the JavaScript game as the agent writes it. |

### The invariant that makes this one app

> **Modes gate, place, and reword. Modes never own, mutate, or destroy engine state.**

"Engine state" is everything below the shell:

- **Process/daemon state** — PTYs, aterm instances, agent hook subscriptions, the orchestration SQLite store, coordinator runs, browser `<webview>` guests, SSH relays.
- **Persisted user state** — `WorkspaceSessionState` (tabs, tab groups, split layouts, open files, browser pages, sleeping agents), `PersistedUIState` (right-sidebar route, `statusBarVisible`, `statusBarItems`, seen-ids), `GlobalSettings`, `Repo`, `WorktreeMeta`.

A mode reads all of it and decides what to render. It writes none of it. Concretely this means a `Classic → mode → Classic` round trip is bit-lossless, and it means `<Terminal/>` is **mounted in every mode**, hidden with CSS in the modes that do not show it. Unmounting the workbench destroys every aterm instance, detaches the CSS-anchor-positioned overlay layers, recreates every `<webview>` guest, forces cold PTY reattach, and drops the `shutdownBufferCaptures` registry that the single `beforeunload` checkpoint at `src/renderer/src/App.tsx:1339-1359` reads.

### Honest reach accounting

"Modes are data" is true of the *variation surface* and false of the *product*. State this to anyone who reads only the overview:

| Mode | Expressible in the manifest | New code |
| --- | --- | --- |
| Classic | ~100% | 0 |
| ALab | ~55% | Console capsule + `Phase 0` engine wiring (incl. a Rust column and a worker-contract edit) |
| Story World | ~35% | Loopback preview server, watch lease, snapshot/restore, chromeless browser pane, approval overlay, composer, ~20 modules |

A fourth mode that is purely subtractive is genuinely one table row. A fourth mode that needs a new surface is not.

---

## 2. The mode model

Five shared modules. All pure data or pure functions. No Electron, no React, no store — so main, renderer, popout, runtime and CLI agree by construction.

### 2.1 The id

```ts
// src/shared/app-mode/app-mode-id.ts
export const APP_MODE_OPTIONS = [
  { id: 'classic', labelKey: 'appMode.classic' },
  { id: 'alab', labelKey: 'appMode.alab' },
  { id: 'story-world', labelKey: 'appMode.storyWorld' }
] as const

export type AppModeId = (typeof APP_MODE_OPTIONS)[number]['id']
export const DEFAULT_APP_MODE_ID: AppModeId = 'classic'

// hasOwn (not `in`) so a hand-edited "__proto__" cannot pass — mirrors isTopLevelView.
const APP_MODE_LOOKUP: Record<AppModeId, true> = { classic: true, alab: true, 'story-world': true }

/** Rung evaluation. null = "this rung has no valid opinion"; the ladder falls through. */
export function parseAppModeId(value: unknown): AppModeId | null {
  return typeof value === 'string' && Object.hasOwn(APP_MODE_LOOKUP, value)
    ? (value as AppModeId)
    : null
}

/** Terminal fallback ONLY. Never use for rung evaluation. */
export function normalizeAppModeId(value: unknown): AppModeId {
  return parseAppModeId(value) ?? DEFAULT_APP_MODE_ID
}
```

The parse/normalize split is load-bearing. A single coercing function would make an unknown value in a *high-precedence* rung silently win that rung as `classic`, overriding the user's real lower-precedence choice. `parseAppModeId` falls through instead.

**Frozen at the top of this file, as a comment:** `app.setName`, `appId`, `appUserModelId` and the packaged `productName` may never vary by mode. `app.setName` derives the macOS Keychain item `"<appName> Safe Storage"` and resolves `app.getPath('userData')` — the directory `app-mode.json` itself lives in. Varying it would orphan every `safeStorage` secret and split the data directory, so a mode switch would present as a settings wipe. (`productName` additionally may not contain a colon: `config/electron-builder.config.cjs:37-39` — electron-builder strips `:` from bundle filenames but not `CFBundleName`, and Electron FATALs resolving `<CFBundleName> Helper.app`.)

### 2.2 The surface union — frozen

This union is **frozen by this document**. It is the shared vocabulary; adding a member is a compile error in all three manifests, and the membership itself is asserted by the neutrality test. No mode may add a member unilaterally.

```ts
// src/shared/app-mode/app-mode-surfaces.ts
export type AppSurfaceId =
  // Right sidebar
  | 'rightSidebar'
  | 'rightSidebar.explorer'
  | 'rightSidebar.sourceControl'
  | 'rightSidebar.checks'
  | 'rightSidebar.ports'
  | 'rightSidebar.agents'
  | 'rightSidebar.vault'
  // Workbench chrome
  | 'statusBar'
  | 'titlebarTabs'
  | 'tabBar'
  | 'splitAffordances'
  | 'worktreeHistoryControls'
  | 'floatingTerminal'
  // Left nav
  | 'nav.tasks'
  | 'nav.automations'
  | 'nav.mobile'
  | 'nav.agents'
  | 'nav.agentDashboard'
  | 'nav.setupGuide'
  // Top-level views (settings is deliberately NOT here — see §2.6)
  | 'view.tasks'
  | 'view.activity'
  | 'view.automations'
  | 'view.space'
  | 'view.skills'
  | 'view.mobile'
  // Editing + panes
  | 'editorTabs'
  | 'diffSurfaces'
  | 'browserPaneChrome'
  // Shell entry points
  | 'devTools'
  | 'coordinatorWindow'
  | 'deepLink.runCommand'
  // Education
  | 'featureTips'
  | 'contextualTours'
  | 'featureWall'
```

**Surfaces are boolean. There is no partial-surface vocabulary and none will be added.** A mode may not "reduce the status bar to two segments" — `statusBarItems` is a user-configured list in `PersistedUIState` (`src/shared/types.ts:3439-3440`) with its own one-shot migration flags, and silently filtering it is a mode overriding a user choice. If a class of status-bar segment genuinely needs mode gating, it becomes its own union member (`statusBar.ports`, …) with the union-growth cost paid openly.

### 2.3 The manifest

```ts
// src/shared/app-mode/app-mode-manifest.ts
export type AppModeSlotId = 'workspace-body' | 'left-sidebar-body' | 'titlebar-strip'
export type AppModeCapsuleId = 'alab.mission-control' | 'alab.mission-strip'
  | 'story-world.stage' | 'story-world.worlds-list' | 'story-world.strip-header'

export type AppModeManifest = {
  readonly manifestVersion: 1
  readonly id: AppModeId
  readonly labelKey: string
  readonly descriptionKey: string
  /** Exhaustive by construction. */
  readonly surfaces: Readonly<Record<AppSurfaceId, boolean>>
  readonly capsules: Readonly<Partial<Record<AppModeSlotId, AppModeCapsuleId>>>
  /** CSS custom properties applied to the workspace subtree root. undefined = Classic no-op. */
  readonly styleVariables: Readonly<Record<string, string>> | undefined
  /** i18n KEY -> i18n KEY. Never key -> English literal. */
  readonly copyKeyRemap: Readonly<Record<string, string>> | null
  readonly appIcon: AppIconId
  /** Appended to the macOS app-menu label only. Never app.setName. */
  readonly appMenuLabelSuffix: string | null
  readonly errorBoundarySurface: ReactErrorBoundarySurface
}
```

**Anti-DSL guard.** No expression, no condition on runtime state, no template string, no `$ref`, no `extends`. Enforced by a type-level test asserting `AppModeManifest extends JsonValue`. When a mode needs to compute, it names a capsule. The first `when: { activeWorktreeHasAgents: true }` field is the end of this design and it is a one-line PR that will look reasonable in review; the type test is the only mechanical stop.

Three built-in manifests, written out in full in `src/shared/app-mode/app-mode-registry.ts`. No inheritance, no merge — three explicit records diff better than two plus a merge.

### 2.4 The only sanctioned reader

```ts
// src/shared/app-mode/app-mode-capability.ts

// Every export takes `mode: unknown` and normalizes internally. The registry is never
// indexed with a caller-supplied value — this is what turns the web-localStorage,
// pre-hydration-null, and unknown-Repo-value cases from crashes into silent Classic.
export function isSurfaceEnabled(mode: unknown, surface: AppSurfaceId): boolean {
  return APP_MODE_REGISTRY[normalizeAppModeId(mode)].surfaces[surface]
}

export function resolveModeCapsule(mode: unknown, slot: AppModeSlotId): AppModeCapsuleId | null {
  return APP_MODE_REGISTRY[normalizeAppModeId(mode)].capsules[slot] ?? null
}

export function resolveModeStyleVariables(mode: unknown): Readonly<Record<string, string>> | undefined {
  return APP_MODE_REGISTRY[normalizeAppModeId(mode)].styleVariables
}
```

**Containment rule.** `mode === 'story-world'` and `mode === 'alab'` comparisons are forbidden outside `src/shared/app-mode/*`. Enforced by `src/shared/app-mode/app-mode-comparison-containment.test.ts`, which walks `git ls-files '*.ts' '*.tsx'` (the idiom `config/scripts/check-max-lines-ratchet.mjs` uses) and fails on any such literal, on any bare `settings?.appMode` read outside the sanctioned renderer accessor, and on any `APP_MODE_REGISTRY[` index outside the module. With that rule the mode diff is grep-auditable to a fixed file set and a fourth mode costs one manifest.

This test runs under **`pnpm test` (vitest)**. It does *not* run under `pnpm lint` and it does *not* run in pre-commit. See §11 for what the lint chain actually enforces.

### 2.5 No settings overlay

**A mode never overrides a settings value.** There is no `settingDefaults`, no `APP_MODE_OVERLAY_KEYS`, no `appModeSettingOptOuts`, no `settingsUserValues`.

The reason is concrete, not stylistic: the renderer's own settings slice does read-modify-write. `src/renderer/src/store/slices/settings.ts` reads `get().settings?.visibleTaskProviders` during normalization and writes it back, and force-writes `agentYoloDefaultsMigrated`. Any overlaid value in `state.settings` would eventually be persisted as the user's own choice, permanently and silently, surviving the return to Classic. That is the exact failure the governing invariant exists to prevent, and it is invisible in Classic.

Where a mode wants a different presentation of a *user-owned* preference, it gates at the render site and never writes. `statusBarVisible` renders as `persisted && isSurfaceEnabled(mode, 'statusBar')`.

Where a mode genuinely needs a new behavior knob, that knob becomes a real settings key with a real default that a Classic user can also toggle.

### 2.6 Settings is not a surface

`view.settings` is deliberately absent from `AppSurfaceId`. Settings reachability is **structural**: the workspace-body branch (§5) is

```tsx
{modeBody
  ? (activeView === 'settings' ? classicSettingsView : modeBody)
  : /* the existing seven-line activeView chain, untouched */}
```

so no mode can gate itself out of mode selection. `src/shared/app-mode/app-mode-escape-hatch.test.ts` asserts the union contains no member matching `/^view\.settings$|^menu\./` and that the branch above yields Settings for `activeView === 'settings'` in every mode.

### 2.7 Persisted shape

```ts
// src/shared/types.ts — GlobalSettings, declared beside appIcon (~2710)
appMode?: AppModeId
appModeSettings?: AppModeSettings   // namespaced, see below
```

`appMode` is **optional and is NOT added to `getDefaultSettings()`**. This is not a style choice — `src/main/persistence.ts:3419` merges `{ ...defaults.settings, ...parsed.settings }` at load and `buildStateToSave()` at 3970-3973 spreads `this.state.settings` into the payload, so *any key present in `getDefaultSettings()` lands in `orca-data.json` on the first save*. Adding a default would destroy the byte-unchanged guarantee that the whole Classic north star rests on. `normalizeAppModeId(undefined)` already yields `classic`, so no default is needed.

Mode-private settings are namespaced under one key rather than adding 22 members to an already-flat ~430-key type:

```ts
// src/shared/app-mode/app-mode-settings.ts
export type AppModeSettings = {
  readonly storyWorld?: StoryWorldSettings
  readonly alab?: AlabSettings
}
```

They render in the Settings pane only in their own mode; the mode pane's search entries carry the mode as a keyword so Cmd+J can still find them.

**Authority is a sidecar, not `orca-data.json`.**

```
<profileDir>/app-mode.json
{
  "appMode": "story-world",
  "lock": false
}
```

~40 bytes, pretty-printed, genuinely hand-editable, **absent by default** — nothing writes it until a user chooses a mode. Path derived as `join(dirname(this.dataFile), 'app-mode.json')` so it is per-Orca-profile automatically and never re-resolves `app.getPath('userData')` late (the ordering hazard documented at `persistence.ts:400-402`).

Deliberately not `orca-data.json`: that file is written compact with no indent (`persistence.ts:3986`), is multi-MB on a heavy install, and mixes settings with terminal layouts and `orca-safestorage-v1:`-prefixed encrypted secrets. Asking a parent to hand-edit it would be malpractice.

**Migration: none.** `SCHEMA_VERSION` stays 1 — it has never been bumped and this does not justify the first. **No one-shot `*Migrated` stamp**: all ~10 existing stamps exist to *change* an inherited default, the exact opposite of what Classic needs, and adding one is the single most likely way to regress an existing install. A downgrade to a pre-mode build ignores an unknown sidecar entirely.

### 2.8 Precedence ladder

Evaluated top-down by one pure function; the first rung that `parseAppModeId` accepts wins.

| # | Rung | Durability | Notes |
| --- | --- | --- | --- |
| 1 | `ORCA_APP_MODE` env var | session only, never persisted | Testing, kiosk provisioning, a parent scripting a launcher. Disables the UI selectors with an explanatory label. |
| 2 | `app-mode.json` **when `lock: true`** | durable, per profile | Promotes the sidecar above the per-project rung and renders the menu radio + Settings control read-only, with a "Reveal settings file" escape. |
| 3 | `Repo.appMode` | durable, per project | **Phase 3.** `repoOverride ?? default`, following the `Repo.sourceControlAi` convention. Covers folder workspaces and SSH because `Repo` does. |
| 4 | `app-mode.json` unlocked | durable, per profile | What the menu, the Settings pane and the CLI all write. |
| 5 | `'classic'` | built-in | Terminal fallback and the target of every parse failure. |

```ts
// src/shared/app-mode/resolve-app-mode.ts
export type AppModeSource = 'env' | 'lock' | 'project' | 'default' | 'built-in'

export function resolveAppMode(input: {
  envMode?: unknown
  pinned?: { appMode?: unknown; lock?: unknown } | null
  repoOverride?: unknown
  isWebClient?: boolean
}): { mode: AppModeId; source: AppModeSource } {
  if (input.isWebClient === true) return { mode: DEFAULT_APP_MODE_ID, source: 'built-in' }
  const env = parseAppModeId(input.envMode)
  if (env) return { mode: env, source: 'env' }
  const pinnedMode = parseAppModeId(input.pinned?.appMode)
  if (pinnedMode && input.pinned?.lock === true) return { mode: pinnedMode, source: 'lock' }
  const repo = parseAppModeId(input.repoOverride)
  if (repo) return { mode: repo, source: 'project' }
  if (pinnedMode) return { mode: pinnedMode, source: 'default' }
  return { mode: DEFAULT_APP_MODE_ID, source: 'built-in' }
}
```

**Conflict rule:** the three required selection surfaces (menu, Settings pane, settings file) are **not three rungs — they are three writers to rung 4**. Last write wins. There is no "which of them wins" question. Pin-always-wins semantics are explicitly rejected: a user who flips the menu radio and finds it reverted on restart has had two of the three required selectors degraded into decorations. `lock: true` is the deliberate, opt-in exception and it makes that visible in both UIs.

**Unknown mode name:** `parseAppModeId` returns null, the rung falls through, the app boots into full Classic. The bad file is **not overwritten** — a user who mistyped one character does not lose their file. A dismissible launch toast names the value ("Your settings file names an unrecognized mode (`kids`). Orca is running in Classic.") with a **Fix** action opening Settings ▸ Mode, and the pane carries an inline notice. In an agent-orchestration IDE the file was probably written by an agent, so silently coercing would mean the human never learns their configuration was discarded.

**Rejected rungs, with reasons:**

- `WorktreeMeta.appMode` — `gcStaleWorktreeMeta` (`persistence.ts:431`) reaps local-host entries after a 30-day idle grace. A mode must never be silently reapable.
- `orca.yaml appMode:` as authority — a cloned repo silently reskinning the user's IDE is a hostile-input vector. If ever added, a one-time confirmed *suggestion* only.
- `hostSettingOverrides.appMode` — nearly free (the resolver family is generic, 89 lines) but no demand. Every unused rung is permanent explanation cost.
- Per-tab / per-pane mode — never. Mode is a property of the workspace and the window.

---

## 3. Selection: menu bar, Settings, settings file

### 3.1 One writer

```ts
// src/main/persistence.ts — Store
setAppMode(value: unknown, opts?: { originWebContentsId?: number }): AppModeId {
  const next = normalizeAppModeId(value)
  const prev = this.appModePreference.get()
  if (next === prev) return next
  this.appModePreference.set(next)
  this.invalidateSettingsProjection()
  // NOTE: notifySettingsChanged takes TWO parameters (updates, originWebContentsId).
  // The settings object is supplied to listeners from inside (persistence.ts:5653-5656).
  this.notifySettingsChanged({ appMode: next }, opts?.originWebContentsId)
  return next
}
```

`updateSettings` strips `appMode` out of durable updates and routes it here, byte-for-byte mirroring what `updateUI` already does for `activeView` at `persistence.ts:5880`:

```ts
const { appMode, ...durableUpdates } = sanitizedUpdates
const appModeChanged = appMode !== undefined && this.setAppMode(appMode) !== previousMode
// ...merge only durableUpdates into this.state.settings...
if (appModeChanged) changedUpdates.appMode = this.appModePreference.get()
```

Consequences: `appMode` can never enter `state.settings` from **any** writer (renderer, CLI, main, mobile); `orca-data.json` stays byte-unchanged; and no IPC-layer interception is needed, so `'appMode' in sanitizedArgs` is still true inside the `settings:set` handler and its side-effect branch fires normally.

### 3.2 The projection — and its one new requirement

```ts
getSettings(): GlobalSettings {
  // Memoized. Invalidated when state.settings changes OR the sidecar changes.
  return this.settingsProjection ??= { ...this.state.settings, appMode: this.appModePreference.get() }
}
```

**Memoization is a new requirement, not an inherited one.** `getSettings()` today returns `this.state.settings` **by reference** (`persistence.ts:5636-5638`) across ~177 call sites, and silently making it allocate would break any identity comparison or `useMemo` dep. The `getUI()` precedent this design borrows the *strip-and-project shape* from does **not** carry reference stability — `getUI()` allocates a fresh object on every call. So the projection must be memoized and the memo must invalidate on *both* inputs. Phase 0 includes an audit of `getSettings()` callers that compare by identity.

**The load-bearing return-value fixes** (and only these two — the third commonly-proposed fix is a no-op):

1. `updateSettings` must return `this.getSettings()`, not raw `this.state.settings` (5821). `src/renderer/src/store/slices/settings.ts:139` replaces its entire settings object with this return value, so without the fix a mode is wiped on **every** settings write — invisible in Classic, therefore guaranteed to ship undetected.
2. `settings:get` and `settings:get-sync` must return the projection.
3. *Not* needed: "notifySettingsChanged must pass `getSettings()` to listeners." The broadcast at `src/main/ipc/settings.ts` is `(updates, _settings, originWebContentsId) => webContents.send('settings:changed', updates)` — it discards the settings argument entirely and sends only the partial. `appMode` rides the broadcast as long as it appears in `changedUpdates`, and both renderer consumers (`useIpcEvents.ts:1303-1318`, `popout.tsx:70-75`) merge partials correctly.

### 3.3 (a) Native menu bar

New module `src/main/menu/app-mode-menu-section.ts` exporting `buildAppModeSubmenu(current, source, onSelect)` → three `type: 'radio'` items (Electron enforces mutual exclusion within a contiguous radio run), plus a disabled informational item when a higher rung wins.

**Its own module is mandatory.** `src/main/menu/register-app-menu.ts` is 345 raw / **277 counted** against a 300 cap, is verified **absent** from `config/max-lines-baseline.txt`, `AGENTS.md` forbids a disable, and `config/scripts/check-max-lines-ratchet.mjs` fails `pnpm lint` on any new baseline entry — enforced locally by `.husky/pre-commit → lint-staged → oxlint`, with no CI to catch it later. `register-app-menu.ts` gains only two `RegisterAppMenuOptions` fields and one spread line (~5 of the 23 available).

Placement: **View ▸ Mode, below Appearance, after a separator.** Not a seventh top-level menu — the template at `register-app-menu.ts:318-325` is the most visible thing in the app. Below Appearance, not above, because Appearance is a five-item checkbox group where a stray click costs one toggle and a one-row misclick into the mode radios reconfigures the product.

**No accelerator.** This file's repeated convention (196-210, 271-278) is display-only `\t` hints, because a real menu accelerator intercepts the chord in main before the renderer's `before-input-event` carve-outs run. If one is ever wanted it must be `CmdOrCtrl`.

Handler at `src/main/index.ts:2426` is a copy of `onToggleAppearance` (2475-2489): `store.setAppMode(id); applyAppModeChange(before, after)`.

Platform placement is correct for free: every window sets `autoHideMenuBar: true` so Alt reveals it on Windows/Linux, and the renderer's `···` button routes through `menu:popup` → `Menu.getApplicationMenu()?.popup()`.

**Menu template budget.** The template must now absorb four independent mode-conditional restructurings: the Mode submenu; Story World's conditional hiding of `View ▸ Toggle DevTools`, `Window ▸ Coordinator`, Tasks/Automations/Mobile plus two renames; ALab's new top-level `Fleet` menu; and ALab moving `Window ▸ Coordinator` into it. Phase 1 splits the template into `src/main/menu/view-menu-section.ts`, `window-menu-section.ts` and `fleet-menu-section.ts` before any of that lands. Budget it as its own task.

### 3.4 (b) Settings UI

- `'mode'` added to `SettingsNavTarget` (`src/renderer/src/lib/settings-navigation-types.ts`, a closed union of 31 targets) in the `interface` group beside Appearance.
- `AppModePane.tsx`, **lazily imported** — `Settings.tsx` is 1,815 lines and baselined; never inline it.
- Built from `SettingsSegmentedControl<AppModeId>` inside `SearchableSetting`, cloning `AgentDashboardExperimentalSetting.tsx:75-99` (the only existing multi-value enum picker).
- A **"What each mode changes"** disclosure that renders the diff by diffing `CLASSIC_SURFACES` against the target manifest — generated from the same data that drives behavior, so the explanation cannot drift.
- A **"Reveal mode file"** button reusing the `keybindings:openFile` pattern (`shell.openPath` + `authorizeExternalPath`, required because the file lives outside any workspace).
- The coerced-unknown-value notice.

**Mandatory and easy to miss:** `src/renderer/src/components/settings/app-mode-search.ts` must be imported by `src/renderer/src/hooks/useSettingsNavigationMetadata.ts`. That module's own header says it exists so "Cmd+J and Settings visibility cannot drift", and `WorktreeJumpPalette.tsx:817-819` builds Cmd+J results from it. Omitting the import breaks the recovery route a confused user is most likely to try. Keyword set deliberately includes symptom phrasing — "sidebar missing", "where are my diffs", "restore", "classic" — because at the moment of confusion the user does not have the word "mode".

**What the other 30 Settings panes do in a non-Classic mode:** nothing. Settings is deliberately mode-invariant, with two exceptions: the Shortcuts pane filters by `isSurfaceEnabled` (§10.6), and mode-private panes appear only in their own mode. A Story World parent who reaches Settings sees the full professional surface, and that is correct — they are an adult performing an adult task.

### 3.5 (c) The settings file

`src/main/app-mode-preference.ts` — a 1:1 clone of `src/main/active-view-preference.ts` (136 lines): synchronous validated read in the constructor so the value exists before any `BrowserWindow`, 100 ms debounced generation-guarded tmp+rename write, `flushOrThrow()`, `waitForPendingWrite()`.

**Two deliberate deviations from the clone, both required:**

1. `set()` returns early when the incoming value equals the current value **and nothing is persisted yet**. `ActiveViewPreference`'s guard is `value !== this.persistedActiveView`, and `persistedActiveView` is `null` on a fresh install — so a no-op `set('terminal')` creates the file. For modes that would create `app-mode.json` for every Classic user and break the north star.
2. `flushOrThrow` is guarded on `Store`'s `writesFrozen`. `flushActiveViewPreferenceOrThrow` (`persistence.ts:4113-4114`) has no such guard and could write into a vacated profile directory after a transfer.

**Wiring checklist (all three are required and are easy to omit):** field beside `activeViewPreference` (`persistence.ts:2832`), construction from `this.dataFile` (2871), awaited in `waitForPendingWrite` (3926), and flushed in the quit path (4113-4114, called at 7162). Without the flush, a mode chosen immediately before quit is lost to the 100 ms debounce — the exact failure the sidecar was chosen to avoid.

**Live editing (Phase 2, not Phase 1).** `src/main/app-mode-file-watcher.ts` copies `transcript-native-watcher.ts:40-70`: watch the **parent directory** (a file watch detaches on the tmp+rename our own writer performs), filter by filename, suppress for 500 ms after an internal write or the debounced save echoes into a loop, `unref()` so it never keeps a headless `orca serve` alive, rebind on error, degrade to a silent no-op where `fs.watch` is unsupported (network-mounted userData). Phase 1 applies the file at launch, which satisfies requirement (c) literally at zero risk.

### 3.6 How every window learns

`src/main/ipc/app-mode-side-effects.ts` — the single owner of mode side effects, called from all three write paths. Its own module because `src/main/ipc/settings.ts` is 274 raw / 213 counted against 300 and should not absorb it:

```ts
export function applyAppModeChange(before: AppModeId, after: AppModeId): void {
  rebuildAppMenu()                                   // Electron menus are not reactive
  applyAppIcon(APP_MODE_REGISTRY[after].appIcon)
  recordCrashBreadcrumb('mode_changed', { from: before, to: after })
}
```

Fan-out rides the existing broadcast at `src/main/ipc/settings.ts:59-67` → `preload settings.onChanged` → `useIpcEvents.ts:1303-1318` (main window) and `popout.tsx:70-75` (dashboard popout, which uses `preload/index.js`). **Zero new IPC channels.**

Two details that silently desync if missed:

- Menu-, file- and CLI-originated writes pass **no** `originWebContentsId`, or the excluded window (`ipc/settings.ts:61-63`) is left stale. Only the Settings-pane path passes it, because that renderer applies the `settings:set` return value itself.
- `rebuildAppMenu()` must fire on **every** path. `APPEARANCE_MENU_KEYS` is consulted only inside the `settings:set` handler body (`ipc/settings.ts:169`), so it could never fire for the menu or watcher paths. Do not use it; use `applyAppModeChange`.

**There are exactly three user-facing `BrowserWindow`s**, which makes the per-window story tractable:

| Window | Created at | Learns of a mode change? |
| --- | --- | --- |
| Main | `createMainWindow.ts:262` | Yes, via `settings:changed`. |
| Dashboard popout | `dashboard-popout-window.ts:154` | Yes — uses `preload/index.js` and seeds from `settings.getSync()` at `popout.tsx:35-45`. **But it renders `<DashboardPopoutRoot view={...}/>` — the Classic kanban — in every mode.** That is a deliberate v1 decision: the popout is a Classic surface. ALab's console is main-window-only in Phases 1-2; a fleet popout view is Phase 3. |
| Coordinator | `coordinator-window.ts:33` | **No.** `src/preload/coordinator.ts` is 28 lines whose header forbids inheriting the per-feature IPC surface; it receives `settings:changed` into the void. Mode reaches it as a load-URL query param (`coordinator.html?mode=alab`, mirroring `popout.html?view=`), so a flip while it is open reflects only on next open. Stated, not hidden. |

**Pre-first-paint (Phase 1).** `src/renderer/src/main.tsx` (91 lines) currently calls `applyDocumentTheme('system')` at line 42 and does **no** synchronous settings read. It gains a module-scope `window.api.settings.getSync()` seed before `renderApp()`, exactly as `popout.tsx:35-45` already does. Without it, any non-Classic mode flashes Classic chrome on every launch.

---

## 4. Switch semantics

**Live. No relaunch. Ever.** Relaunch is the orca-profiles model (`runBeforeProfileRelaunch → store.flush() → scheduleProfileRelaunch → app.quit()`) and adopting it would violate the runtime-selection requirement by construction.

### Order of operations

1. `store.setAppMode(id)` → sidecar write scheduled (100 ms debounce).
2. `applyAppModeChange` → `rebuildAppMenu`, `applyAppIcon`, crash breadcrumb.
3. `notifySettingsChanged({ appMode })` → `settings:changed` to every non-origin window.
4. Renderer merges the partial into zustand; the manifest is memoized on the id.
5. `applyDocumentAppMode` writes the style-variable bag and `data-app-mode` on the **workspace subtree root** — inside the two-frame `theme-transition-disabled` suppression from `document-theme.ts:67-97`. Mandatory: a mode flips strictly more variables than a theme swap and would otherwise stagger visibly.
6. Surface gates recompute; the workspace-body capsule mounts (lazy, inside `useTransition` + `Suspense` so React 19 keeps the outgoing tree painted rather than blanking the window).
7. Classic is **statically imported**, so switching *back* is always synchronous and the escape hatch never depends on a chunk load that could fail.

### What survives

| | |
| --- | --- |
| PTYs, aterm instances, alt-screen TUI state, scrollback | Untouched. `<Terminal/>` stays mounted; `App.tsx:536-544` latches `hasMountedTerminalWorkbenchRef` and `Terminal.tsx` renders every mounted worktree absolutely-positioned with `hidden`/`opacity-0`. |
| Running agents, orchestration dispatches, coordinator runs, hook subscriptions | Untouched — all main-process or daemon state, independent of which shell is mounted. The coordinator keeps ticking through the switch. |
| Tabs, tab groups, split layouts, open files, browser pages | **Hidden, never pruned.** ALab filters editor/diff tabs at the tab-strip visibility layer only. Pruning would orphan live PTYs and webview guests and silently destroy the Classic workspace. |
| Right-sidebar route | Left untouched on disk. `resolveRightSidebarEffectiveTab` (in `right-sidebar-effective-tab.ts`, called at `right-sidebar/index.tsx:171` with the no-overwrite rationale at 158-161) already renders a visible fallback without overwriting the stored route. Reuse; do not reimplement. |
| `statusBarVisible`, `statusBarItems` | Gated for display, never written. |
| `activeView` | Preserved. Because the mode body replaces the center region wholesale (§2.6), a view a mode does not render simply is not reached — no coercion, no blank pane, and `App.tsx`'s seven-line chain is untouched. |

### What is remounted, and is accepted

The right sidebar, the left sidebar body, and the center region. Their component state — scroll position, disclosure state, an in-flight inline rename — resets. This is a deliberate user-initiated action so a remount is honest; it is the same cost as toggling the right sidebar closed and open today. Hoist the worktree-list scroll memory into a module singleton first (`App.tsx:510` already treats it as needing to survive remounts).

`resetKey` on the mode-body boundary is `${mode}` only. **`appMode` must never enter a boundary that also keys on workspace identity** — `App.tsx:2211` warns that `activeWorktreeId` in a reset key remounts whole surfaces during wake, and the phase-3 per-project rung would make mode change on every sidebar click.

### What is explicitly out of scope for every mode

**Window chrome.** `titleBarStyle`, `frame`, `trafficLightPosition` and `backgroundMaterial` are `BrowserWindow` constructor options (`createMainWindow.ts:256-292`) and cannot change live. `windowBackgroundBlur` already ships a "Restart required" banner for exactly this. The manifest has **no window-chrome field** — better no field than a field that lies.

**A mode switch never launches an agent, never writes a layout, and never spends money.** `layoutPreset` is not in the manifest. Layout recipes (Story World's stage, ALab's fleet grid) are reachable only from an explicit button, run at most once per workspace per mode (recorded in `PersistedUIState`), are existence-checked and idempotent (shaped like `ensure-simulator-tab.ts`), and never close or move a pane the user created. `layoutByWorktree` and `terminalLayoutsByTabId` are the **only** persisted copy — there is no per-mode namespace and no snapshot/restore, so auto-rewriting on switch is irreversible data loss.

**No confirmation dialog** — nothing is destroyed. A toast fires unconditionally on every switch with an **Undo** action (see §6). `getOrcaProfileSwitchLiveWorkSummary` (already counts live PTYs, working/blocked/waiting agents, browser tabs) supplies a second informational line when live work exists; it is not a gate, and it is not the primary feedback — it returns `hasLiveWork: false` in exactly the idle state where accidental menu clicks happen.

**Degraded boot guard.** If `hydrationSucceeded` is false the app runs in no-save mode with a sticky toast; a mode switch in that window must not write and must not be read as intent to reshape a session that never loaded.

**Agent permissions do not change live, and no mode may imply otherwise.** Launch flags are baked into the PTY command line at spawn by `resolveTuiAgentLaunchArgs`, and `buildSleepingAgentLaunchConfig` persists `agentArgs`/`agentEnv` so a resumed pane returns with its captured posture. Compounding this, Orca's managed hooks **observe** `PermissionRequest` and `exit 0` — there is no `permissionDecision` anywhere in `src/main/agent-hooks`, so Orca cannot deny a tool at all. **No manifest field named anything like `childSafe` or `permissionPreset` will exist.** See §7.6 for what Story World can honestly offer.

---

## 5. What the shell shares vs what a mode owns

### 5.1 The boundary

**The core host builds; a mode places.** `App.tsx` remains the core host: it constructs `<Terminal/>`, `WindowControls`, `StatusBar`, `Toaster`, `WorkspacePortScanner`, all four zero-height gates, and all ~40 modals, and it owns their lifetime. A mode may hide one with CSS; it may never conditionally render one away and never move one between DOM parents.

Two elements are **structurally unplaceable**, not merely discouraged:

- **`WindowControls`** stays the last DOM child of the App root, rendered by `App.tsx` after any mode-varying subtree (`App.tsx:2769`). Electron's drag hit-test is DOM-order based and ignores z-index, so a mode that reorders root children breaks window dragging on Windows and Linux only — invisible from a macOS dev machine.
- **`<Terminal/>`** stays a sibling in the main pane column. Guarded in dev by `useTerminalWorkbenchSlotGuard`, which captures `parentElement` on mount and errors on identity change. This failure is the highest-severity one in the feature and it is invisible to types.

### 5.2 The three slots, and the pane portal

A mode body is **not** the parent of the workbench. `<Terminal/>` and the `activeView` page chain are **siblings** inside the main pane column, so a component mounted at the page-chain position cannot lay out a band containing the terminal. A mode that wants a terminal *inside* its layout uses the second mechanism.

| Mechanism | What it is | Used by |
| --- | --- | --- |
| **Capsule slots** (3) | `workspace-body`, `left-sidebar-body`, `titlebar-strip`. Each mounts a lazy component inside its own `RecoverableRenderErrorBoundary`; an unknown id drops silently. | All non-Classic layout. |
| **Pane portal** | `src/renderer/src/app-mode/mode-pane-portal.ts` — generalizes the existing `activity-terminal-portal.ts` + `Terminal.tsx`'s `createPortal` path with `isolatedPaneKey`. The pane's React tree position never changes; only the portal target does, so no remount. | Story World's centre terminal band; ALab's `OrchestratorPane`. |

**Build the pane portal once, in Phase 1, in shared code.** ALab needs it (a permanently-mounted `AgentTerminalPreview` would hold the fleet's most important TUI agent at ~45 columns for the whole session, because its header documents that it claims the PTY grid for the dialog's own box). Story World needs it (its centre band is a real terminal). It is the third named mechanism and it belongs in the architecture, not inside one mode's spec.

`AgentTerminalPreview` remains correct for **transient peek** (`AgentTerminalDialog`), where claiming the grid for the dialog's lifetime is acceptable and is surfaced in the UI.

### 5.3 App.tsx extraction work, in order

**Step 0 — DONE.** `src/renderer/src/App.tsx` has been decomposed into `src/renderer/src/app-shell/` (20 modules, 3,098 raw lines) and is now **395 raw lines**. The inline `/* eslint-disable max-lines */` is gone and `config/max-lines-baseline.txt` shrank 357 → 356 entries; the ratchet gate passes. Every new module is under its own budget (300 `.ts` / 400 `.tsx`) with no suppressions.

> **Correction to an earlier draft of this section.** A survey pass read the tree while this extraction was mid-flight — the modules existed but `App.tsx` had not yet been rewired — and concluded `app-shell/` was a dead parallel extraction that should be deleted. That is now false and acting on it would delete the live shell. `App.tsx` has 16 `app-shell/` imports, `useAppKeyboardShortcuts` is called at `App.tsx:217`, and `WindowControls` is no longer defined inline. Verified: renderer typecheck clean, full-repo `oxlint` clean, `app-startup-routing.test.ts` 21/21, renderer suite 17,882 passed.

The extraction map, for orientation:

| Module | Role |
| --- | --- |
| `use-app-shell-view-model.ts` | every non-action store read + derived layout state |
| `use-app-store-actions.ts` | the single `useShallow` action subscription |
| `app-startup-hydration.ts` + `-ssh-reconnect` + `-recovery` | the startup chain, split at its natural seams |
| `use-app-session-persistence.ts` | session writer, runtime-graph sync, shutdown checkpoint |
| `use-app-view-persistence.ts` | debounced durable-UI writer, `activeView` narrow writer, theme, font |
| `app-shortcut-dispatch.ts` + `use-app-keyboard-shortcuts.ts` | shortcut decision (pure) + DOM wiring |
| `AppWorkspaceShell.tsx`, `AppOverlayHost.tsx`, `AppPageRouter.tsx`, `AppTitlebarControls.tsx` | the render tree |
| `app-lazy-surfaces.ts` | every `lazy()` route/overlay import |

**This changes the mode work in three ways.** (1) `resolveAppShellChrome` belongs in `app-shell/`, not a new `app-mode/` directory — the sibling concepts already live there, and `use-app-shell-view-model.ts` already computes the five booleans Step 1 wanted to absorb, so Step 1 is now "add `mode` to a function that exists". (2) The three layout slots (§5.2) land in `AppWorkspaceShell.tsx` and `AppPageRouter.tsx`, which are already prop-driven — no further extraction is a prerequisite. (3) `app-shortcut-dispatch.ts:127`'s `canShowRightSidebarForView` call is a **live** fifth call site, so §5.4's exception for that predicate holds with one more caller than listed.

**Step 1 — `src/renderer/src/app-mode/app-shell-chrome-state.ts`.** A pure `resolveAppShellChrome({ mode, activeView, sidebarOpen, workspaceChromeActive, creationLayoutActive })` absorbing the five inline booleans at `App.tsx:1544-1562` (`showSidebar`, `stackedSidebarOpen`, `leftTitlebarChromeLayout`, `showRightSidebarControls`, `showProfileSwitcherInSidebarFooter`/`InTopRight`). These five now live in `app-shell/use-app-shell-view-model.ts`, so this step is adding a `mode` argument to an existing pure derivation rather than a new extraction. None of the five is pinned by `app-startup-routing.test.ts`.

**Step 2 — the mode-body branch.** One conditional above the seven-line `activeView === 'x' ? <X/> : null` chain (`App.tsx:2358-2364` — seven lines: settings, skills, tasks, automations, activity, space, mobile; the two terminal-view sub-branches `WorktreeCreationPanel` and `Landing` are separate). The chain's own lines are not edited.

**Step 3 — the titlebar-strip slot.** `titlebarMainStrip` (`App.tsx:2133-2166`) becomes a slot whose Classic occupant is today's content verbatim.

**Step 4 — the left-sidebar-body slot.** `components/sidebar/index.tsx:177-201`. The container, `useSidebarResize`, `useSidebarProjectDrop`, drop affordance, drawers and persisted width all stay shared.

**Step 5 — the pane portal** (§5.2).

**Tripwire.** `src/renderer/src/app-startup-routing.test.ts` is 461 lines with **152 `expect(` calls** and is a source-**text** test. It now reads each extracted module rather than `App.tsx` alone, and pins `<WorkspacePortScanner enabled={vm.workspaceSessionReady} />`, `vm.statusBarVisible ? (`, the exactly-one-`beforeunload` assertion (against `use-app-session-persistence.ts`), the #9002 narrow-writer guard, lazy-import spellings, and `shouldMountTerminalWorkbench ?`. Steps 1-4 are designed so that the pinned strings mostly do not move; any that do are updated in the same commit and the diff is the reviewable artifact.

### 5.4 Predicates that gain one argument

All already exported, pure, and unit-tested. Blast radius 1-5 lines each.

| File | Change | Call sites |
| --- | --- | --- |
| `components/sidebar/SidebarNav.tsx:31-62` | The four `shouldShowXButton(Pick<GlobalSettings,…>)` predicates take `mode`. | 342 raw / 320 counted / 400 cap — room. |
| `components/right-sidebar/right-sidebar-activity-visibility.ts` | `ActivityBarItem` gains `surface?: AppSurfaceId` beside `gitOnly`/`folderOnly`/`sshOnly`; one filter clause, composing as `modeAllows && workspaceKindAllows`. | 24 lines. |
| `lib/titlebar-worktree-history-controls.ts` | Takes `mode`. | 5 lines. |
| `lib/titlebar-left-chrome.ts` | Takes `mode`. | 24 lines. |
| `lib/right-sidebar-visibility.ts` | **Unchanged — stays mode-free.** | See below. |

`canShowRightSidebarForView` is the deliberate exception. It has **five** direct call sites (`App.tsx:1560`, `App.tsx:1652`, `useIpcEvents.ts:1345`, `app-shell/app-shortcut-dispatch.ts:127` — live — and an internal call inside `rightSidebarShowsPullRequestData` at line 32), and `rightSidebarShowsPullRequestData` gates PR/check **data fetching** at `WorktreeList.tsx:1474` and `github.ts:4352/4652`. Threading mode into it would suspend a data feed as a side effect of a visibility flag. Right-sidebar mode gating lives exclusively in `resolveAppShellChrome`, at the render site.

### 5.5 Two component props

| Prop | Where | Consumed by | Notes |
| --- | --- | --- | --- |
| `locked: boolean` | `TabGroupSplitLayout` → `TabGroupPanel` | **Both** non-Classic modes | `TabGroupPanel.tsx:228` renders `{tabBar}` unconditionally and `useTabDragSplit`/`useDroppable` are always wired. Derived from `isSurfaceEnabled(mode,'tabBar') && isSurfaceEnabled(mode,'splitAffordances')`. Genuinely shared; build once. |
| `chrome: 'full' \| 'minimal' \| 'none'` | `BrowserOverlaySlot` → `BrowserPane` → `BrowserPagePane` | **Story World only** | The "shared cost" rationale is false — ALab never uses it. Requires extracting `browser-pane-chrome-header.tsx` from a 5,750-line max-lines-disabled file: extraction, never growth. **Critically, it must gate the `document.body` context-menu portal too** — `BrowserPane.tsx:4888` renders the 'Inspect Page' item inside a `createPortal(..., document.body)` that **closes at 4893, before** `chromeHeaderRef` opens at 4896. A header-only gate leaves right-click → Inspect Page fully reachable by a six-year-old. |

Both props default to today's behavior (`locked={false}`, `chrome="full"`), and `src/renderer/src/app-mode/default-props-are-inert.test.ts` asserts the default render is structurally identical to the pre-change render.

---

## 6. Mode: Orca Classic

Classic's definition is a proof obligation: `CLASSIC_SURFACES` maps every member of `AppSurfaceId` to `true`, `capsules` is `{}`, `styleVariables` is `undefined`, `copyKeyRemap` is `null`, `appIcon` is `DEFAULT_APP_ICON_ID`, `appMenuLabelSuffix` is `null`.

### The non-regression guarantee

Three machine-checked properties, all vitest, all under `pnpm test`:

| Test | Asserts |
| --- | --- |
| `app-mode-classic-is-neutral.test.ts` | `CLASSIC_MANIFEST` deep-equals a programmatically constructed neutral manifest — strictly stronger than iterate-and-assert-true, because it also fails when a *new* non-boolean field lands with a non-neutral Classic value. Also asserts the frozen `AppSurfaceId` membership. |
| `persistence-app-mode-not-persisted.test.ts` | Snapshot `orca-data.json`, boot a `Store`, `setAppMode('alab')`, flush, assert the bytes are unchanged and specifically that `JSON.parse(payload).settings` has no own `appMode` key. Also asserts `store.getSettings() === store.updateSettings({})` so the projection stays reference-stable. |
| `app-mode-round-trip.test.ts` + `tests/e2e/app-mode-round-trip.spec.ts` | Classic → ALab → Classic leaves `WorkspaceSessionState`, `PersistedUIState` and `GlobalSettings` deep-equal. The E2E companion exists because a store-level driver cannot observe the real switch path; given zero visual snapshots repo-wide, it is the only end-to-end evidence the reversibility promise has. It drives keyboard chords as well as clicks (§10.6). |

Plus `tests/e2e/app-shell-region-order.spec.ts`: serializes the App root's direct-child sequence and asserts `WindowControls` is last, the four zero-height gates precede the workspace shell, and the columns appear in order. Platform-stable, unlike pixel snapshots. **It needs a handful of `data-testid` attributes on `App.tsx`'s region divs** — a small, real addition to Classic's DOM that will then be depended upon. Budgeted in Phase 0; the alternative (asserting on class names) is more brittle for the one test protecting the invariant nobody can see fail on macOS.

### First-run explanation

One feature tip, `app-modes`, **inserted at index 0** of `FEATURE_TIPS`. `getFeatureTipsAppOpenDecision` allows one tip per launch and `getOrderedUnseenFeatureTips` preserves array order within priority; `FEATURE_TIPS` is currently `[orca-cli, cmd-j-palette, voice-dictation]`, so an appended tip lands third and may never fire. It outranks evergreen tips because it is the only one describing something that changed under the user. The View ▸ Mode submenu also carries a one-time **New** marker on first release.

No feature-wall screen. `resources/onboarding` is at its hard 11 MiB `MAX_BYTES` cap in `config/scripts/check-feature-wall-assets.mjs`, and the modal's copy says "14 guided screens" across five catalogs, pinned by `feature-wall-workflows.test.ts` (exactly 14 steps across six workflow ids) and by 16 anchors in `src/shared/repository-endpoints.ts`. Modes earn a screen once two of them are real; §10.9 budgets the doc edits.

### Feedback on every switch

`src/renderer/src/app-mode/app-mode-switch-notice.ts` fires an **unconditional** toast — "Switched to ALab mode" with an **Undo** action calling `setAppMode(previous)`. The root `<Toaster/>` is statically imported deliberately, so a toast enqueued before a lazy subscriber mounts is never dropped. A misclicking user reads it and clicks Undo: one click, no vocabulary required.

`AppModeScopeBadge` renders in the titlebar iff `mode !== DEFAULT_APP_MODE_ID` — regardless of source, so it is visible for menu-selected modes, which is the most common case. Clicking it opens Settings ▸ Mode.

---

## 7. Mode: Story World

### 7.1 Layout

Three vertical bands under a two-row titlebar. `WindowControls` unmoved.

- **Titlebar.** `titlebar-left` keeps the traffic-light pad and gains one **Back to my worlds** button. The `titlebar-strip` capsule renders `StoryStripHeader`: world name, a state chip, spacer, **Show a Grown-Up**. The `#titlebar-tabs` portal target is not mounted (`titlebarTabs: false`). **The world-name pill doubles as `AppModeScopeBadge`** — tapping it opens `GrownUpPanel`, which contains the mode picker. The one mode aimed at a user who cannot read must not be the one mode with no in-window escape.
- **Left band (240px, resizable)** — `left-sidebar-body` capsule: `MyWorldsList`. Picture-led world cards with a captured thumbnail, name, "played 2 days ago"; one **+ Make a new world**. No delete affordance. Container, resize and drop machinery shared.
- **Centre band (flex-1, min 480px, always widest)** — inside the `workspace-body` capsule: `TalkToClaudeFrame` header → **a real `TerminalPane` relocated via the pane portal** (§5.2), output uncovered → `StoryWorldApprovalOverlay` (mounts above the composer only when there is an interactive prompt) → `WorldPartsStrip` (64px tiles) → `StoryComposer`.
- **Right band (40%, min 360px)** — `LiveWorldWindow`: a `TabContentType: 'browser'` tab through the existing `BrowserPaneOverlayLayer` on a dedicated registry-registered session partition (`persist:orca-story-world-<workspaceId>`, never the user's browsing session), with `chrome="none"`.
- Below a 900px window the right band moves to the bottom rather than squeezing the terminal.
- **Bottom:** nothing. Status bar, floating terminal panel and right sidebar all gated off.

### 7.2 The composer — a correction worth stating

Story World does **not** reuse `TerminalComposeBox`. That component is portaled *into* the pane as `absolute inset-x-2 bottom-2 z-40`, `submit()` calls `onClose()` so it vanishes after every send, it opens only via a chord or a right-click, it is gated on `settings?.terminalComposeBox !== false`, and its draft cache is a bare `Map` with no subscribers read once via lazy `useState` — so writing to it while the box is open changes nothing on screen.

`StoryComposer` is an always-mounted controlled composer whose draft lives in a real store slice (`src/renderer/src/store/slices/story-world.ts`), so the parts strip writes into it and the child watches the words appear. It calls the genuinely reusable piece — `sendComposeBoxDraft()` from `terminal-compose-box-send.ts`, a standalone async function that owns the bracketed-paste plan and the separate protocol-encoded submit Enter that agent TUIs require.

### 7.3 Live preview plumbing — honest about SSH and Windows

**Local (Phase 2, the shipped path).** A per-workspace loopback static server, `src/main/story-world/play-server.ts`. Not `file://`: a `file://` page has an opaque origin and cannot load ES modules or `fetch()` its own assets — exactly what a kid's game hits. Not an iframe: the packaged CSP (`build-plugins/renderer-content-security-policy.ts`) sets `frame-src 'self' https:` with no `unsafe-eval`, deliberately, and must not be relaxed.

The server is modeled on `static-web-client-handler.ts` **for its content-type map only**. Its real boundary — `isAllowedStaticWebPath` — cannot survive a workspace-rooted server, and what remains is a lexical `relative(root, abs).startsWith('..')` check with no `realpath`. **Containment is modeled on `filesystem-auth.ts`'s `resolveAuthorizedPath` instead:** lexical guard, then `realpath` containment, plus a `Host` header allowlist, a random per-session path prefix, `Cache-Control: no-store`, `Range` support for `<audio>`/`<video>`, and an extension allowlist shared with the renderer's reload filter via `src/shared/story-world-play-extensions.ts` so the two cannot disagree.

**Windows hardening is a Phase 2 line item, not an open question.** The server must reject device names (`CON`, `NUL.js`), NTFS alternate data streams (`game.js::$DATA`), and trailing-dot/space filenames — the reused sanitizer rejects only NUL bytes, backslashes and `..`. A packaged Electron app also triggers a Defender/firewall prompt on first bind; the first-run flow must show it coming. This is the largest new attack surface in the design and it has an owner.

**Reload-on-save** requires arming a watch, which nothing does for us. On local workspaces `subscribeRuntimeFileChanges` only listens to `window.api.fs.onFsChanged` — it arms nothing. The sole renderer arming site is `useEditorExternalWatch.ts:312`, whose targets are open editor files plus the active worktree *only when the right sidebar shows Explorer-files or Source Control* — both of which Story World gates off. So `src/renderer/src/story-world/worktree-watch-lease.ts` is a **Phase 2 prerequisite**: a refcounted per-worktree lease over `window.api.fs.watchWorktree`/`unwatchWorktree`, with `useEditorExternalWatch` refactored to consume it rather than owning the IPC.

`story-world-play-reload.ts` then: acquires a lease, ignores Orca-owned paths, consults a self-write registry (modeled on `editor-self-write-registry.ts`), waits a 750 ms trailing settle (an agent writes several files non-atomically per turn; a shorter debounce reloads against a half-written tree), reloads only when the agent is not mid-turn, and skips entirely when a real dev server owns the URL.

**SSH (Phase 3).** `getWorkspaceFileBrowserOpenTarget` hard-refuses remote worktrees today, and `file://` resolves on the *local* machine — so a naive path silently previews the wrong filesystem. Two honest options, in order of preference: (a) let the remote runtime own the Chromium page via `browser.tabCreate` and paint it locally through the existing CDP screencast — the remote resolves `localhost` itself, so no forwarding at all; (b) run the play server on the runtime host and `window.api.ssh.addPortForward` it. Until then, `story-world-play-target.ts` branches on `getConnectionId(worktreeId)` and shows an honest card — "Your game lives on another computer" — while still giving terminal and parts. It does not silently preview the local filesystem.

**Storage rule (this resolves an ambiguity that would otherwise bite in Classic).** `.orca/` is appended to the repo's `.gitignore` by `ensureOrcaGitignored` (`hooks.ts:172-187`) precisely so it is never committed — so the child's world definition must not live there.

| Artifact | Location | Rationale |
| --- | --- | --- |
| World parts (the child's nouns) | `story-world.json` at the **workspace root**, tracked | Agent-authored project content. A parent can commit it, share it, and see it in Classic as an ordinary file. |
| Screenshots, session log, Story Saves | `<userData>/story-world/<workspaceKey>/` | Orca-authored telemetry, not project content. Never pollutes the repo. |

In Classic, a Story World workspace looks like a normal folder containing `index.html`, `game.js` and `story-world.json`. That is the whole difference.

### 7.4 World parts and the cold start

`WorldPartsStrip` renders `SEEDED_STARTER_PARTS` (*make something · add one · make it bigger · make it move · change the color*) when `story-world.json` is absent, so a brand-new world is never an empty strip. This closes the circular dependency where the palette is populated only by an agent that can only be reached through the palette.

Tapping a tile composes a plain-English sentence into the store draft. Long-press opens a three-item sheet. As the agent writes `story-world.json`, the strip grows the child's own nouns (🐱, 🌳).

**`StoryWorldFirstPrompt`** is the only path that launches an agent: six illustrated starters ("a cat that jumps", "a place to explore", "a game with points", "something silly", "a maze", "surprise me"), each calling `launchAgentInNewTab({ agent, worktreeId, groupId, prompt, promptDelivery: 'submit-after-ready' })`. **Entering the mode never launches an agent** (§4).

### 7.5 Failure and black-screen handling

Detection is inverted from the obvious approach, because the obvious approach misses the common case.

1. **Primary: `console-message`.** The webview event already handled at `BrowserPane.tsx:3912`. This catches top-level throws and syntax errors in `game.js`, which execute *before* `dom-ready` and are therefore invisible to an `executeJavaScript`-after-`dom-ready` trap — the single most common way a six-year-old's game breaks.
2. **Enrichment: CDP `Page.addScriptToEvaluateOnNewDocument`** via the guest debugger, the approach `src/main/browser/anti-detection.ts` already uses. Adds stack/line data and survives a page CSP.
3. **Silent failure: a post-load paint heartbeat.** A 404 on a `<script src>` produces no main-frame `did-fail-load`, and a canvas that never draws throws nothing — yet "your game got stuck" is exactly that case.

`StuckCard` covers the game at the floating tier: illustration, "Your game got stuck.", exactly two buttons, no stack trace, no path, no line number. **Suppressed entirely while the agent status is `working`** — a mid-turn reload against a half-written tree is normal, and showing the scary card three times per request trains the child to ignore it.

- **Tell Claude** (primary) — composes "My game is not working. It says: `<message>`. Please fix it." into the composer draft and submits. A six-year-old cannot describe a bug, so the app describes it and she only has to agree.
- **Go back to the last good one** (secondary) — restores the most recent Story Save. Hidden entirely (never present-and-failing) when no saves exist or over SSH.

`AgentAsleepCard` is a first-class state with one **Wake Claude up** button. Claude Code sessions end routinely; a dead shell must never be left accepting a child's English.

`▶ Play again` calls `loadURL(homeUrl)`, not `reload()` — with no address bar and no back button, any `<a href>` in a generated game would otherwise strand her permanently.

### 7.6 Parent guardrails — and what they honestly are

**First run is parent-facing and has three screens, the third of which blocks.**

1. **Pick a folder.** A plain folder workspace with no git is the expected case and is first-class throughout. This screen **states** that selecting a folder marks it trusted for the chosen agent by writing outside Orca (`~/.copilot/config.json` `trustedFolders`, `~/.codex/config.toml` `trust_level`) and that **Orca has no revoke path** — `folder-workspace-composer-submit.ts:148` calls `agentTrust.markTrusted` and no untrust function exists anywhere in the repo.
2. **Pick an agent,** with metered/unmetered status shown inline. Only `claude-usage`, `codex-usage` and `opencode-usage` exist, against 24 agents in `YOLO_TUI_AGENT_ARGS`.
3. **Permission posture — blocking, no skip, no default.** `DEFAULT_TUI_AGENT_ARGS = YOLO_TUI_AGENT_ARGS`, so an untouched install launches Claude with `--dangerously-skip-permissions`. Story World will not open a world until the parent chooses. The screen states plainly that the agent runs with the parent's full filesystem and network access **either way**, and that Ask-me-first is a prompt, not a sandbox.

The choice writes **`Repo.agentPermissionMode`** — a new per-project override on `Repo` (not `GlobalSettings`), resolved `repoOverride ?? global` at the `resolveTuiAgentLaunchArgs` call site, following the `Repo.sourceControlAi` convention. Without per-project scope the toggle is machine-wide, penalizes the parent's own repos, and will predictably be reverted — silently removing the child's only protection with no signal in Story World.

**`StoryWorldApprovalOverlay`** is what makes Ask-me-first usable at all. `NativeChatApprovalCard`'s only mount point is `NativeChatView.tsx:420`, gated on `experimentalNativeChat` (default false) **and** `Tab.viewMode === 'chat'` — so it can never render in Story World's terminal-mode centre band. The overlay instead composes two decoupled primitives directly: `parseApprovalFromStatus` (a pure function over an `AgentStatusEntry`) and `useNativeChatInteractiveSend(tabId, paneKey, ptyId, agent)` (four primitive args). Without it, choosing Ask-me-first leaves a non-reader facing the agent's raw TUI menu ("1. Yes 2. Yes, don't ask again 3. No") as scrolling text, which makes the guardrail decorative.

**`GrownUpPanel`** (press-and-hold 800 ms): posture with its scope named ("Ask-me-first, for Kitty World only"), an honest spend panel labelled "This is a meter, not a limit" that renders "No cost data available for Gemini" rather than a false `$0.00`, Story Saves with restore, world delete, mode picker, Settings link. There is no spend cap anywhere in the product and the panel says so.

### 7.7 Save, resume, show off

**Story Saves** are the child's undo and the only real safety mechanism the mode can offer. `src/main/story-world/story-saves.ts` snapshots story files into `<userData>/story-world/<workspaceKey>/saves/<ts>/` **before every prompt submission** and after every clean load following a completed turn — so a restore point exists *before* the first breakage, which a recovery-conditioned trigger cannot produce. Bounded by `storyWorldAutoSaveCount` (default 8); `0` disables and also hides the restore button rather than leaving it present-and-failing.

Snapshot scope: everything at the workspace root except dotdirs, `node_modules`, and files over 5 MB, with a total cap.

**`ShowOffView`**: game large, "Made by …", parts row, "What we did today", **Save a picture** (`webview.capturePage()`). Unmissable 48 px close control.

### 7.8 Copy rules

One typed bag, `src/renderer/src/i18n/story-world-copy.ts`, shaped like `hosted-review-localized-copy.ts` — key-to-key remap only, never key-to-English-literal, under a hand-authored `storyWorld.*` namespace so the `auto.*` extractor never rewrites it. ~130 strings; budget as a five-locale cost per string.

1. **Five words maximum per button**, four preferred.
2. **Every control carries an icon and a word.** lucide-react only; emoji appear only as content the child chose.
3. **Banned from every child-facing surface:** file paths, git terms, hashes, port numbers, stack traces, and the words *error*, *failed*, *exception*, *null*, *undefined*. Also banned: the compose box's shell footer (`⇧↩ newline · ⌘↩ stage · ↩ send`) and its bracketed-paste warning — which is why `StoryComposer` exists.
4. **Five status words: Working · Your turn · Done · Stuck · Ready.** `AgentDotState` has **eight** members (`working, blocked, waiting, interrupted, failed, done, idle, permission`); "Ready" covers `idle` and no-status-yet, which is the state of a world the child just opened. Every status word is paired with a distinct sound cue via `window.api.notifications.playSound` — a non-reader under excitement will not read any of them.
5. **Never a question with more than two answers.**
6. **Speak the outcome, not the mechanism.**
7. **Never assert a boundary the runtime cannot enforce.** Approval copy names the action without implying scope: "Claude wants to change a file. Is that OK?" — not "…in your world".

**Voice dictation is a parent setup step, not a given.** `getDefaultVoiceSettings()` returns `{ enabled: false, sttModel: '' }`, so tapping the mic on a default install produces an unreadable toast. Story World renders the mic **disabled with a tooltip** until a model is installed, and `GrownUpPanel` links to the setup. The mic button must `preventDefault` on `mousedown` — `captureInsertionTarget` reads `document.activeElement` at start and insertion aborts if focus moved.

---

## 8. Mode: ALab

### 8.1 Phase 0: the engine, now wired up (landed `2ebbe5f8f` 2026-07-28, `1bef9915a` 2026-07-30)

The supervision surfaces are recomposition. The human-in-the-loop escalation path was not. Three verified breaks had to be fixed before any UI was worth building — **all three are fixed at HEAD**, the RPC/Rust/preamble halves in `2ebbe5f8f`, the CLI tail in `1bef9915a`. They are kept below as written because the reason each was a break is the acceptance criterion for the surface that consumes it (§8.3–§8.5); each now carries what landed.

1. **`orchestration.ask` never creates a gate.** It builds its payload as `JSON.stringify({ question, options })` (`orchestration.ts:624`) with no task field; `AskParams` has none; the CLI's `allowedFlags` are `to, question, options, timeout-ms, from`. `Coordinator.handleDecisionGateMessage` then hard-rejects it: `if (!payload.taskId || !payload.question) { … return }` (`coordinator.ts:313-316`). A queue built on `gateList` renders "Nothing is waiting on you" while a worker is blocked.
   *Landed:* `2ebbe5f8f` added `AskParams.task`, the `taskId` payload fold and a direct `db.createGate({ …, originMessageId })` in the ask handler (`src/main/runtime/rpc/methods/orchestration.ts:615-646`) plus the `task` flag on the spec (`src/cli/specs/orchestration.ts:116`) — but the CLI *handler* still dropped the flag, so no CLI-originated ask opened a gate until `1bef9915a` forwarded it (`src/cli/handlers/orchestration.ts:636`).
2. **Resolving a gate strands the worker.** `gateResolve` calls `db.resolveGate` and returns the row; it inserts no message. The blocked worker wakes only on `getThreadMessagesFor`, whose sole producer is `orchestration.reply`. The *task* does resume (`resolve_gate` runs `UPDATE tasks SET status = 'ready'`), so the board clears while the worker hangs to its timeout — the worst possible failure, because it looks fixed.
   *Landed in `2ebbe5f8f`:* `origin_message_id` as schema v7→v8 (`rust/crates/orca-runtime/src/orchestration_schema.rs:239-248`), answered by `deliverGateResolutionToOrigin` called from `gateResolve` (`src/main/runtime/rpc/methods/orchestration-gates.ts:213`), which returns `answeredOrigin` so the caller can tell a coupled gate from a `gateCreate` one.
3. **The coordinator's entire diagnostic stream is discarded.** `onLog` defaults to `() => {}` (`coordinator.ts:97`) and the only production construction site (`orchestration-gates.ts:87`) supplies none. The 10-minute stale-heartbeat warning — the *only* hang detector in the codebase — the circuit-breaker retry counter, terminal-creation failures (followed by a bare `return`, so a mission can stall silently forever), lifecycle rejections and "Stuck: N tasks blocked" are all generated and thrown away.
   *Landed:* `2ebbe5f8f` attached a bounded per-run ring at construction (`orchestration-gates.ts:104-111`) and exposed `orchestration.runLog` (`:221`); the reader `orca orchestration run-log` arrived only in `1bef9915a` — until then the spec had a path and no handler, which is exactly what `registry-parity.test.ts` failed on.

Phase 0 fixes:

| Change | Files | Status |
| --- | --- | --- |
| `task: OptionalString` on `AskParams`, `'task'` in the CLI `allowedFlags`, folded into the payload as `taskId`; create the `DecisionGateRow` directly in the ask handler stamped with `originMessageId` (do not wait for the coordinator tick — when the addressed handle is an orchestrator *agent* the message goes into its PTY and no gate is ever created). | `rpc/methods/orchestration.ts`, `cli/specs/orchestration.ts` | `2ebbe5f8f`; CLI handler forwarding `1bef9915a` |
| Nullable `origin_message_id` on `decision_gates`; `gateResolve` looks up the origin and inserts the thread reply, then `deliverPendingMessagesForHandle` + `notifyMessageArrived` — the same three calls `orchestration.reply` already makes. | `rust/crates/orca-runtime/src/orchestration.rs` + `GATE_COLUMNS`, `orchestration/gate-reply-coupling.ts` | `2ebbe5f8f` (schema v7→v8) |
| `onLog` wired to a bounded per-run ring (500 entries), exposed as `orchestration.runLog`. | `orchestration/coordinator-run-log.ts`, `orchestration-gates.ts:87` | `2ebbe5f8f`; CLI reader `1bef9915a` |
| `preamble.ts`: teach `--task-id`, correct `--timeout-ms 600000` to the 30-minute `ASK_MAX_TIMEOUT_MS` the code actually allows. | `orchestration/preamble.ts` | `2ebbe5f8f`, with one deviation (below) |
| `mission-progress.ts` + split counters on `runList`. | new | **not landed** |

**What remains.** Only the last row — and it has no seat to sit in yet: there is no `orchestration.runList` method (`run`, `runStop`, `runLog` are the run methods), so §8.3's `MissionStrip` split counters have nothing to read. The preamble deviation: it teaches `--task` and *documents* the 30-minute clamp rather than raising the printed example, which stays `--timeout-ms 600000` — a budget a worker can afford to wait (`orchestration/preamble.ts:114-125`). `1bef9915a` also closed three defects this section never listed: restart-orphaned dispatches held `maxConcurrent` slots forever, the dispatch loop would drive the human's own shells, and dispatch raced agent startup. Those, and the follow-on engine work this mode ultimately needs — durable ownership, verified submit, transactional gates, account routing — are [`alab-auto-mode-design.md`](./alab-auto-mode-design.md) (§11 catalogues the repairs; §9 supersedes the roadmap's Phase-2 surface list).

**Two of these were shared-core changes driven by one mode, and were reviewed as such, not slipped in as UI tasks:**

- **The Rust column.** `decision_gates` gained a nullable column (v7→v8). Migration story: the column is nullable and read defensively, so gates created by an older build read `origin_message_id = null` and skip the reply insert (behaving exactly as today). A downgrade sees an unknown column and ignores it. State this in the migration comment; the design spends real effort on `orca-data.json` downgrade safety and the orchestration DB deserves the same.
- **`preamble.ts` is the worker behavioral contract**, pinned by an 89-line snapshot at `src/main/runtime/orchestration/__snapshots__/preamble.test.ts.snap`. The regenerated snapshot diff *is* the reviewable artifact. Already-running fleets keep their injected preamble until their workers restart.

### 8.2 Two orchestrators, one word

The `Coordinator` **class** (`coordinator.ts:78-525`) is a deterministic dispatch autopilot with no LLM in it. The **orchestrator agent** is an AI in a terminal holding the `orchestration` skill, which builds the task DAG and may hand off to the autopilot. `orchestration.run --from <handle>` makes an agent's handle the coordinator handle, so one identifier names both.

Every surface addresses one or the other explicitly. `MissionStrip` addresses the class (stop dispatching, stop and interrupt). `OrchestratorPane` addresses the agent (a composer sending a structured `orchestration.send`, not raw keystrokes, so the exchange is durable and auditable).

Relatedly: **`ask` and gates are disjoint subsystems that share a vocabulary.** `ask` is agent↔agent — it blocks on a *reply*, which only another agent produces; the `Coordinator` class has no reply path, so `ask --to <autopilot-handle>` runs to timeout today. Gates are the human checkpoint. Phase 0 made `ask --task` also reach a human, which is better but means `ask` has two possible answerers — see §13. That is live at HEAD, CLI included, so the question is no longer hypothetical.

### 8.3 Layout

Three columns inside the `workspace-body` capsule, plus a `left-sidebar-body` capsule and a `titlebar-strip` capsule.

- **Titlebar strip:** `AppModeScopeBadge` reading "ALab", a compact `BurnMeterChip` showing a **derivative, not a level** — `claude 62% ↓14%/hr · ~4h left`. The `#titlebar-tabs` target is empty.
- **Left (`left-sidebar-body`):** `MissionStrip` — one row per coordinator run with **split counters, never a fraction** (`6 done · 2 failed · 1 blocked · 2 dispatched`), amber on any failure, a `[Log]` affordance, and two stop verbs. `checkConvergence` counts `failed` toward "all done", so a single fraction would launder two failures into a success. Pinned bottom: the full `BurnMeter` with per-provider bars, burn rate, projected exhaustion, today's estimated cost, and the honest line "account-wide, not per-mission".
- **Centre, three stacked bands:**
  - **`LandingBand`** (collapsed when empty) — `merge_ready` tasks with claimed files, CI state, `[Review diff]`. `merge_ready` is a declared `MessageType` that the coordinator currently **drops** (`case 'merge_ready': break`, `coordinator.ts:243-246`) and no renderer references. For a mode whose purpose is unattended production of landable work, the handoff to review had no representation at either end.
  - **`ExceptionsQueue`** (~34% height, 2-row minimum, always mounted) — **one row per task**, collapsed on `task_id` before ordering, because a deterministic failure produces escalation → retry → escalation → retry → escalation → circuit_broken within ~10 s. Each row: kind badge, question or subject, worker handle and task title, retry counter from `DispatchContextRow.failure_count`, age, inline resolution, and an **[Ack]** control distinct from resolve. Six sources: pending gates; `escalation` messages; `circuit_broken` dispatches; lifecycle rejections; attention-bucket agent rows without a gate; unanswered asks.
  - **`FleetBoard`** — grouped by **mission** (`coordinatorHandle ?? orchestrationRunId ?? 'unassigned'`), not worktree, with sticky group headers carrying counts *and CI state*. Subagent rows **kept** (the kanban board drops them at `build-dashboard-snapshot.ts:149`). Every row renders `last_heartbeat_at` directly — "no heartbeat in 14m" — because agent-hook status alone cannot distinguish wedged from finished (`AGENT_STATUS_STALE_AFTER_MS` decays a non-`done` entry to `idle` at 30 minutes, rendering a wedged worker identically to a cleanly-finished one). A final `unassigned` group so a human's hand-started agent is never silently hidden.
- **Right (~380px, collapsible):** `OrchestratorPane` — the orchestrator agent's **real pane, relocated via the pane portal** (§5.2) — plus a composer and `[Take over]`.

**No `view.fleet`.** ALab's console is the `workspace-body` capsule. Adding a `TopLevelView` would touch every persistence boundary (`src/shared/top-level-view.ts` carries an explicit comment saying so), widen `ActiveViewPreference`'s validated union, add an eighth line to `App.tsx`'s chain — which Classic guarantees is untouched — and risk a blank main pane, since the chain has no default branch. The capsule mechanism is already required for Story World and costs none of that.

### 8.4 The evidence surfaces — not polish

De-emphasis means removing *workflow mechanics*. It does not mean removing the only signals capable of contradicting an agent. Without these four, completion is 100% self-attestation:

| Surface | Why |
| --- | --- |
| **Right sidebar Checks/CI stays enabled** | The only signal that can disagree with a worker. Caveat: `right-sidebar/index.tsx:124` marks `'checks'` `gitOnly` and `'pr-checks'` `folderOnly`, and `getVisibleRightSidebarActivityItems` filters on workspace kind **before** any mode gate. On a plain folder workspace it is already absent — the mission header must say "CI unavailable: folder workspace" rather than showing nothing. |
| **`TaskDetail`** | The worker's 3-sentence body, the claimed `filesModified` list (already persisted in `TaskRow.result`), the `reportPath` artifact (already parsed), dispatch history with `failure_count` and completing pane. |
| **`task-claim-reconciliation`** | Compares self-reported `filesModified` against worktree status. `lifecycle-reconciliation.ts` stores the array unvalidated. A task claiming 3 files where git shows 0 is the highest-signal alert an autonomous fleet can produce and nothing computes it today. Degrades to "unknown" — never "mismatch" — on folder workspaces. |
| **`MissionDiffOverlay`** | A **read-only** aggregated diff across a mission's worktrees, opened in one gesture from a landing row. Review is the supervisor's dominant morning activity; treating it as "switch to Classic" makes it an exit from the mode rather than a function of it. Read-only keeps the de-emphasis honest; `[Take over]` remains the escalation to editing. |

Plus **`MissionLog`** — the coordinator's `onLog` stream (Phase 0) merged with that handle's message rows, filterable by type. Answers "why did the fleet do that" *after* the fact, which the exceptions queue structurally cannot: every lane in it is a pre-failure or at-failure signal.

### 8.5 Escalation and notification (Phase 2)

The weakest link, and it needs real new plumbing.

- **`registerCoreHandlers` is called inside `createWindow`** (`index.ts:1253`, with the window-only caveat at 2234), so a headless `orca serve` fleet — or one with the window closed — produces **zero** desktop and **zero** mobile notifications. Fix: extract the dispatch body (settings gating, cooldown, mobile fan-out, native `Notification`) into `src/main/notifications/notification-dispatch-service.ts` and register it at app bootstrap. **A split, never growth** — `ipc/notifications.ts` is 724 lines with a max-lines disable. Guard the native leg on `Notification.isSupported()`; keep the mobile leg unconditional.
- **Orchestration is notification-silent.** `dispatchMobileNotification` has exactly one call site. Fix: `src/main/runtime/orchestration/orchestration-event-bus.ts` (~40 lines, shaped like `store.onSettingsChanged`), attached at the ask/gateCreate paths, at `Coordinator.processEscalations` — an **empty stub whose own comment names "external notify" as its purpose** — and at `warnStaleDispatches`.
- **The dedupe key collapses a fleet.** It is `worktreeId ?? worktreeLabel ?? 'global'` with a 5 s cooldown, in both the desktop and mobile maps. Fix: per-exception key.
- **The payload carries no orchestration identity.** Fix: `MobileNotificationDispatchEvent` gains optional `gateId`, `taskId`, `agentHandle`, `paneKey`, `priority`. All optional → additive → no protocol bump → old phones ignore them.
- **Mobile cannot answer.** `MOBILE_RPC_METHOD_ALLOWLIST` contains zero `orchestration.*` methods, so a phone can only type free text into a PTY, which resolves neither an ask nor a gate. Fix: **resolve-only** — allow `gateList`, `gateResolve`, plus read-only `inbox`/`taskList`/`runList`; deny `runStop` and `taskUpdate`. A phone is a lost/stolen device class and the allowlist is keyed by device scope, not by mode.
- **Routing has nowhere to land.** `getNotificationNavigationPath` emits only `/h/<host>` or `/h/<host>/session/<worktreeId>`. Fix: `/h/<hostId>/gate/<gateId>`, rendered by a **new file** `mobile/app/h/[hostId]/gate/[gateId].tsx` — never growing `app/h/*/index.tsx`, which sits at 1,642 against a 1,603 cap the ratchet forbids raising.

**The honest limit that cannot be fixed here.** There is no APNs/FCM: no push token registration, no `UIBackgroundModes`, no Android foreground-service permission, and `mobile-endpoint-supervisor.ts` deliberately suspends the relay on `setForeground(false)` ("background phones must not hold billed relay data splices"). **A locked phone receives nothing until the app is reopened.** `MobileNotificationReplayBuffer` + `notifications.getMissedSince(lastSeenSeq)` then delivers the missed gate exactly once on wake. Real push is a new cloud service, not a code change. See §13.

### 8.6 What is de-emphasized

Hidden: Explorer, Source Control, the file tree, editable editor/diff/conflict-review surfaces, the titlebar tab strip, `TabGroupPanel`'s tab bar and split-drag affordances, Tasks / Automations / Mobile nav entries, worktree cards, the Activity page (a per-agent conversation view and a self-declared 2,034-line prototype; two competing fleet surfaces would be worse than one).

**The status bar is kept exactly as the user configured it.** ALab does not reduce it to two segments — surfaces are boolean and `statusBarItems` is a user choice (§2.2).

Automations are kept and renamed in-mode to **Standing Orders** (nav entry hidden; entry moves to Fleet ▸ Standing Orders). A recurring mission launch is what an unattended fleet wants, and `AutomationService` already handles missed-run grace, prechecks, headless dispatch and per-run cost attribution — the only per-run cost attribution anywhere in the product.

**ALab adds no sandbox and no safety boundary.** Its only real control is the decision gate, which agents reach *voluntarily* because the preamble tells them to. No field or label may imply otherwise, and the New Mission dialog states the launch posture workers will inherit.

---

## 9. Design system compliance

`docs/STYLEGUIDE.md` (314 lines) plus `src/renderer/src/assets/main.css` (3,521 lines) are canonical. Modes stay inside them by **remapping authored tokens on a scoped subtree**, never by inventing values.

### 9.1 The mechanism

`src/renderer/src/app-mode/document-app-mode.ts`, a sibling to `document-theme.ts`, stamps `data-app-mode` and applies `manifest.styleVariables` as a `style` prop **on the workspace-shell subtree root** — not on `documentElement`.

Two reasons, and the second is why it is not negotiable: it matches the house pattern (`resolveLeftSidebarStyleVariables` returns a `Record<string,string>` built with `color-mix()` over existing tokens, spread at three subtree roots, returning `undefined` for the no-op case), and **a root class physically cannot express two workspaces in two modes**, which the phase-3 per-project rung requires.

Applied from all three renderer roots — `main.tsx`, `popout.tsx`'s `applyPopoutAppearance`, `coordinator/main.tsx` — inside `document-theme.ts:67-97`'s two-frame `theme-transition-disabled` suppression.

### 9.2 What is legal today

**Radius.** `--radius: 0.625rem` at `main.css:131` is the only authored radius; `--radius-sm..4xl` are declared **only inside `@theme inline`** (42-121). Custom properties do not re-derive on descendants — the reason a subtree override works is that `@theme inline` makes Tailwind **inline the expression** into the utility. Verified in the built CSS: `.rounded-md{border-radius:calc(var(--radius) * .8)}`, `.rounded-lg{border-radius:var(--radius)}`, `.rounded-xl{border-radius:calc(var(--radius) * 1.4)}`. So one reassignment on the subtree rounds every Card, Button, Input and Popover with zero component edits.

*State the mechanism this way in the code comment.* If a future Tailwind config change stops inlining the calc, Story World's highest-leverage approved lever silently goes inert.

**Surfaces.** Reassign existing color roles via `color-mix(in srgb, …)` against existing tokens, exactly as `left-sidebar-appearance.ts:49-90` does. This is in-repo precedent (three call sites, shipped) and it keeps light/dark parity automatic. *(An earlier draft cited a STYLEGUIDE blessing at lines 76-82; that citation is not supported by the file and is dropped. The precedent is the code.)*

**Font family.** `--app-font-family` is already a runtime-writable root variable.

**Icon.** `applyAppIcon` already swaps the Dock and every `BrowserWindow` icon live, fully on macOS, window+tray only on Windows, effectively not at all on Linux (the `.desktop` entry and `StartupWMClass` are frozen at install).

**App-menu label.** `options.appMenuLabel ?? app.name` at `register-app-menu.ts:137`, re-read on every rebuild.

### 9.3 What requires a documented token addition — and product-owner sign-off

Per STYLEGUIDE.md's resolution order (309-314), step 4 is *ask before inventing*. Three additions are needed and none is an agent's call:

| Addition | Why it cannot be a remap |
| --- | --- |
| `--app-font-scale` (`:root` + `.dark`, exposed in `@theme inline`) | There is **no** `--text-*`, `--font-weight-*`, `--tracking-*` or `--leading-*` family. Sizes come from Tailwind utility classes on hundreds of components. |
| A three-value motion set (`--motion-duration-fast/base/slow` + `--motion-ease-*`) | There is **no** motion token family. ~40 bespoke `@keyframes` and ~60 hardcoded `transition` declarations, with only 7 `prefers-reduced-motion` guards — a "playful" skin multiplies that debt against STYLEGUIDE.md:267. |
| A `touch` size variant on `components/ui/button.tsx` (`h-12` / `size-12`) | The CVA maxes out at `lg h-10` / `icon-lg size-10` = **40px**. Story World's 44px and 48px controls are new sizes, not existing ones — the same class of invention as the missing type scale, but load-bearing for the mode's core usability. Must land in the CVA and the STYLEGUIDE component table, **not** as per-component `className="h-12"` overrides. |

**Story World's visual phase does not start until these are approved.** Radius and surface remaps need no approval and carry most of the "different app" feeling on their own.

### 9.4 Per-mode footprint

| Mode | `styleVariables` |
| --- | --- |
| Classic | `undefined` |
| ALab | `undefined` or near-`undefined`. ALab is de-emphasis, not restyling; fleet state maps onto `--status-success(-background)(-border)`, `--destructive`, `--ai-action-accent`, `--chart-1..5` and the existing Badge/Progress/Tooltip primitives. **Discipline note:** STYLEGUIDE.md:62 forbids reusing `--git-decoration-*` outside git status, so agent lifecycle must not borrow added/modified/deleted even though they map temptingly. |
| Story World | `--radius` (rounder), warmer surface roles via `color-mix()`, `--app-font-family`, and — after sign-off — `--app-font-scale`. |

Monaco and xterm/aterm read the resolved theme independently, so a mode skin does not automatically reach embedded editors or the terminal. Do not attempt it in v1.

---

## 10. Cross-cutting

### 10.1 CLI

There is **no** settings or config command family today — none of the 20 spec files under `src/cli/specs/` declares one, and `agent-hooks.ts` is a hooks handler, not a settings writer. So there is no shape to clone, and adding one is not free: `src/cli/registry-parity.test.ts` asserts bidirectional parity between `COMMAND_SPECS` and `HANDLER_COMMAND_KEYS`, and `src/cli/vocabulary-policy.ts` enforces canonical verb families.

**Decision: ship both halves in Phase 1.**

```
orca mode show [--json]      # canonical 'show' verb; prints { mode, source, lock }
orca mode set <classic|alab|story-world>
```

with a real `CommandSpec` + handler pair, budgeted for registry-parity and vocabulary-policy compliance. `set` follows the RPC-first / file-fallback shape (try `settings.update` against a running app, fall back to a direct sidecar write, reporting `appliedBy: 'runtime' | 'offline'`).

**Additionally, `appMode` is added to `orca status --json`.** This is the more important half and it is easy to skip: this is an agent-orchestration IDE, and without it an agent can silently *change* the human's product but cannot *observe* which mode it is running under.

Both `set` and a raw file write apply silently and always fire the launch/switch toast, so the human always learns.

### 10.2 Multi-window

Three user-facing windows (§3.6). Main follows live; dashboard popout follows the mode for theme but renders the Classic kanban (Phase 3 may add a fleet view); coordinator gets its mode from a load-URL query param.

**Genuinely independent per-window modes are out of scope**, and this should be stated to the owner rather than implied. `let mainWindow: BrowserWindow | null = null` is a singleton (`index.ts:273`) and `registerCoreHandlers` is called *inside* `openMainWindow`. Lifting both is a real project, not a rung. Everything in Phases 0-3 delivers the product without it.

**Concurrent modes are designed for but not exercised in v1.** The subtree style bag and the mount-inside-`app.workspace-shell` rule keep the door open. Two things must not regress that: module-scope state must be keyed per workspace (Story World's play-server registry already is; ALab's shared poll must be), and `appMode` must never enter a reset key that also keys on workspace identity.

### 10.3 Mobile and relay

Phase 2, read-only awareness plus resolve-only orchestration control (§8.5).

The sanctioned advertisement channel is `RUNTIME_CAPABILITIES` (additive, no protocol bump) — add `'app-mode.v1'` and return `appMode` on `status.get()`. Mobile ships 24-48 h behind desktop via the App Store, so a phone must be able to knowingly degrade: in `story-world` it refuses to render the Classic diff/PR/source-control IA rather than silently showing a child-hostile IDE.

If `appMode` is ever to be readable or writable via `settings.get`/`settings.update`, it must be added to **both** the `getClientSettings`/`updateClientSettings` `Pick<>` allowlists (`orca-runtime.ts:3199/3244`) **and** the `.strict()` `SettingsUpdate` zod schema (`client-ui-schemas.ts:131-170`) — a strict schema rejects unlisted keys outright. Prefer `status.get()`.

Mobile never sets the mode. Pairing state (`device-registry.json`, relay bindings, revoke outbox) must survive mode changes untouched.

### 10.4 Crash reporting

Near-free and worth doing in Phase 0:

- `app_mode` in `CrashReportRecord.details` — already `Record<string, string|number|boolean|null>` and printed by `formatCrashReportText`, so it appears in the dialog preview, the copied text and the submitted report with zero UI change.
- `recordCrashBreadcrumb('mode_changed', { from, to })` — a 30-entry ring, so the switch itself lands in the pre-crash trail, which is exactly where a mode-transition bug shows up.
- New members on the closed `ReactErrorBoundarySurface` union for each mode capsule, or their boundary reports mislabel as `app-root`.

A Story World preview crash and an ALab orchestration crash have completely different repro paths and `processType`/`reason` alone will not separate them.

**Telemetry: do not whitelist `appMode`.** `SETTINGS_CHANGED_WHITELIST` is typed `readonly BooleanGlobalSettingsKey[]` and `ipc/settings.ts:186-203` explicitly `continue`s on non-booleans with a comment demanding the schema's `value_kind` enum be extended in lockstep — and this fork does not transmit (`IS_OFFICIAL_BUILD` is false).

### 10.5 i18n

Renderer copy is a **typed bag**, never a catalog fork: `src/renderer/src/i18n/app-mode-copy.ts` (shared) plus `story-world-copy.ts` and `alab-copy.ts`, each shaped like `hosted-review-localized-copy.ts:23-54` — key-to-key remap only, memoized through `createLocalizedCatalog` extended to key on `(locale, mode)`, under hand-authored `storyWorld.*` / `alab.*` namespaces so the `auto.*` extractor never rewrites them. Forking `en.json` (12,192 keys × 5 locales × 3 modes) would break the pinned-key tests and is off the table.

Every visible string — including `translateMain` menu labels — hits `verify:localization-coverage`. Budget copy as a **five-locale cost per string**: ~150 for ALab, ~130 for Story World, ~14 for Classic.

**Main-process copy needs a mechanism that does not exist.** Story World renames `File ▸ New Workspace` → "New World" and `Help ▸ Explore Orca` → "How Story World Works", but `copyKeyRemap` and `createLocalizedCatalog` are renderer-side. Fix: `src/main/i18n/main-app-mode-copy.ts` — a small key-remap consulted by `translateMain` call sites in the menu builders, seeded from the manifest. Without it, the menu renames are undeliverable and should be dropped.

### 10.6 Keyboard shortcuts — the seam the surface table cannot see

Today `globalShortcutStateRef` (`App.tsx:1575-1601`) carries `activeView`, `activeWorktreeId`, `actions`, `keybindings`, `terminalShortcutPolicy`, `workspaceChromeActive`, `creationLayoutActive` — **none of the chrome booleans** — and the dispatcher computes its own `canRevealRightSidebar` at `App.tsx:1652`. So in a mode that hides the right sidebar, `sidebar.sourceControl.toggle` still fires and writes `rightSidebarTab`/`rightSidebarOpen` into `PersistedUIState`. That is a mode-caused **write** to the exact state the design promises is only ever gated at read time, and it is invisible because the surface it rewrites is hidden.

**Decision: shortcuts are surface-aware.**

```ts
// src/shared/app-mode/keybinding-action-surfaces.ts
export const KEYBINDING_ACTION_SURFACES: Partial<Record<KeybindingActionId, AppSurfaceId>> = {
  'sidebar.right.toggle': 'rightSidebar',
  'sidebar.explorer.toggle': 'rightSidebar.explorer',
  'sidebar.sourceControl.toggle': 'rightSidebar.sourceControl',
  'sidebar.checks.toggle': 'rightSidebar.checks',
  'sidebar.ports.toggle': 'rightSidebar.ports',
  'terminal.splitRight': 'splitAffordances',
  'terminal.splitDown': 'splitAffordances',
  'worktree.history.back': 'worktreeHistoryControls',
  'worktree.history.forward': 'worktreeHistoryControls',
  // …editor.*, tab.newBrowser, devtools, etc.
}
```

Consulted **once** inside `dispatchShortcutInput`, before any store mutation: an action mapped to a disabled surface early-returns. Three companion edits, all required or the fix is partial:

1. `src/shared/custom-keybindings.ts` — users can rebind, so the gate must key on action id, not chord (it does).
2. The Settings ▸ Shortcuts pane filters its list by `isSurfaceEnabled`, or it lists ~150 chords for surfaces that do not exist.
3. `createMainWindow.ts:495-536`'s `before-input-event` carve-outs are unaffected (they are about letting chords *through* to the renderer), but the audit must confirm no main-side accelerator targets a gateable surface. None does today, because the Mode submenu deliberately has no accelerator.

The round-trip E2E spec drives chords, not only clicks. A store-level test cannot observe this.

### 10.7 Deep links

`RunCommandConsentDialog` is mounted at `App.tsx:2767` as a root-level sibling, outside the workspace shell and outside every provider, so it renders identically in all modes. Per `docs/reference/deep-links.md`, `orca://run?...` always raises it showing the full shell command, target workspace, execution host, and an untrusted-origin provenance label, with no "always allow" and no bypass.

**Decisions:**

| Link | Classic | ALab | Story World |
| --- | --- | --- | --- |
| `orca://run` | Consent dialog, verbatim | Consent dialog, verbatim | **Ignored.** `deepLink.runCommand: false`; the router logs and toasts "That link isn't available here." Suppressing the *command* is safer than softening a security dialog, and softening it is forbidden. |
| `orca://worktree/<id>` | Activate | Activate | Activate |
| `orca://focus/term_<uuid>` | Focus pane | Focus pane (tab strip locked, so focus reveals rather than switches) | Ignored |
| `orca://pair` | Settings ▸ Mobile | Settings ▸ Mobile | Settings ▸ Mobile (Settings is mode-invariant; the parent may legitimately be pairing) |

The dialog copy is never mode-remapped. It is the boundary.

### 10.8 Accessibility

Neither non-Classic mode inherits an accessibility floor from STYLEGUIDE.md — the file's only accessibility content is one tooltip-trigger note (164) and one `aria-invalid` note (219). There is no contrast rule, no hit-target rule, no color-alone rule, no reduced-motion rule (those live only as seven `@media` blocks in `main.css`). Repo baseline: 31 files use `aria-live`, 31 use `sr-only`, 396 use `aria-label`, 192 use `role=`. There is **no** `speechSynthesis` usage anywhere in `src/` or `mobile/`.

**Each mode ships an accessibility contract.** Minimum, enforced by review:

| | Story World | ALab |
| --- | --- | --- |
| Text equivalent for every status conveyed by color or sound | Required. The five status words are the visible text equivalent for the chimes; each `AgentDotState` maps to one and only one word, and all **eight** members are covered. | Required. `AgentStateDot` gets an adjacent text label in `FleetBoard` rows, not a tooltip. |
| Live region | `LiveWorldWindow` state changes announce politely. `StuckCard` is `role="alertdialog"`. | **`ExceptionsQueue` is an `aria-live="polite"` region.** It is a queue that mutates unattended at 2am; a supervisor using a screen reader must hear a gate open. |
| Hit targets | The `touch` variant (§9.3) is the mechanism. No per-component overrides. | Default sizes; ALab's user is an adult at a desk. |
| Read-aloud | **Out of scope for v1** and stated as such — it is new infrastructure, not reuse. The chime + icon + word triad is the v1 answer for a non-reader. | N/A |
| Reduced motion | Story World's animating creature honors `prefers-reduced-motion` (a static illustration + the chime). | N/A |

### 10.9 Documentation

Four real edits, budgeted:

| Doc | Change | Constraint |
| --- | --- | --- |
| `docs/reference/app-modes.md` | This document. | The only tracked path that survives `.gitignore:120-133`. |
| `docs/STYLEGUIDE.md` | Document the two new mechanisms (mode-scoped CSS-variable bag on a subtree root; key-to-key copy remap) and the `touch` button variant. | Its own resolution order says to ask before inventing; these are the approved inventions. |
| `FEATURE_WALKTHROUGH.md` | A modes section. | 739 lines, with 16 section anchors exported by `src/shared/repository-endpoints.ts` and asserted by `repository-endpoints.test.ts`; `feature-wall-workflows.test.ts` asserts exactly 14 steps across six workflow ids. Add a section without renumbering the pinned anchors. |
| `README.md` | A modes paragraph. | 226 lines, no modes section today. |

### 10.10 Cross-platform, SSH, folder workspaces

- Menu placement is correct on all three platforms for free (the template already branches on `isMac`, every window sets `autoHideMenuBar: true`, and the renderer's `···` button popups the application menu on Windows/Linux). No accelerator means no `metaKey` hazard; if one is ever added it is `CmdOrCtrl`.
- Every path uses `path.join`. The Story World play server's Windows-specific rejections are §7.3.
- **Folder workspaces are first-class, not a caveat.** Story World's driving case is a plain folder with no git. ALab's CI and claim-reconciliation surfaces degrade explicitly ("CI unavailable: folder workspace") rather than silently.
- **SSH:** `app-mode.json` lives in local userData, so mode resolution is host-independent. Story World's live preview over SSH is Phase 3 with an honest card until then. ALab is host-agnostic — agent status carries `connectionId`, terminal handles are host-scoped, and a coordinator and its workers can live on different hosts.

---

## 11. Testing and non-regression strategy

### 11.1 What actually enforces what

**Correct this before anyone plans around it.** `config/scripts/check-reliability-gates.mjs` contains no `child_process`, `spawn`, `execFile` or `execSync`. It is a **JSONC manifest schema validator** — it checks `maturity`, `protection`, `redGreenEvidence.status`, `flakeHistory.status`, `evidenceRuns[].result`/`runner`. **It never executes the `commands` array.**

| Gate | Runs | Enforces |
| --- | --- | --- |
| `.husky/pre-commit` → `lint-staged` | on commit, staged files | `oxlint`, `oxlint --config config/oxlint-react-doctor.json`, `oxfmt --write` |
| `pnpm lint` | manually | 12 steps incl. `check:max-lines-ratchet` (real), `check:reliability-gates` (**manifest validation only**), `verify:localization-catalog`, `verify:localization-coverage` |
| `pnpm test` | manually | vitest — **every mode test lives here** |
| `pnpm test:e2e` | manually | 194 Playwright specs |

There is **no GitHub Actions CI**. Every gate is invoked deliberately by a human or an agent.

So: **the mode invariants are vitest tests, and they are described as vitest tests.** Declaring them in `config/reliability-gates.jsonc` is optional heavyweight *documentation* — that file is 6,722 lines, each gate requires ~15 fields including `invariant`, `oracle`, `coverageNotes`, `motivatingLinks`, `assertionRefs` with per-assertion prose, dated `evidenceRuns`, `runtimeBudget`, `promotionCriteria`, `knownGaps` and `demotionRule`, and the policy block imposes `minimumSoakRuns: 100` / `minimumSoakDays: 14` before blocking promotion. If gate records are wanted they are their own line item, not free rigor.

### 11.2 Covering three modes without tripling the suite

The leverage is Classic's all-true table: **the existing 3,703 unit files and 194 e2e specs *are* the Classic suite**, and they pass unmodified because they run with no mode set. What is added is deliberately small.

| Layer | Addition |
| --- | --- |
| **Mode leakage** | A fourth vitest `setupFile`, `config/vitest-app-mode-classic-default.ts`, pinning Classic per test file. Mode state cannot leak between the (max 4) workers. |
| **Classic proof** | The three tests in §6 plus `app-shell-region-order.spec.ts`, `app-mode-escape-hatch.test.ts`, `app-mode-startup-view.test.ts`, `app-mode-comparison-containment.test.ts`, and a `AppModeManifest extends JsonValue` type test. |
| **Per-mode unit matrix** | Table-driven `it.each(APP_MODE_OPTIONS)` over every widened predicate, following `appearance-search.test.ts:17`'s five-locale idiom (32 lines for five variants). This is the idiomatic answer here — `it.each` appears 416 times repo-wide. |
| **Per-mode E2E** | **Do not fan 194 specs across three modes** (fresh Electron per test, 120 s budget, `retries: 0`, 4 local workers). Copy `config/scripts/run-aterm-worker-on-e2e.mjs`: a curated runner, `config/scripts/run-app-mode-e2e.mjs`, spawning a hand-picked subset (~8-12 specs whose user-visible behavior genuinely differs) plus each mode's own dedicated specs, with the mode seeded. Add `test:e2e:app-mode` to `package.json`. |
| **Opt-in** | A test-scoped `orcaAppMode` fixture on `tests/e2e/helpers/orca-app.ts` defaulting to `'classic'`, backed by `tests/e2e/helpers/e2e-app-mode-profile.ts` seeding `app-mode.json` into the per-test userData dir. Whole-spec opt-in via `test.use({ orcaAppMode: 'alab' })`, mirroring `orca-profiles.spec.ts:5`. |
| **Store-level** | `createTestStore()` gains an optional overlay. All 75 existing call sites keep passing no argument and stay Classic. |
| **Default-prop inertness** | `default-props-are-inert.test.ts` for `locked={false}` and `chrome="full"`, protecting the two files that require component surgery. |
| **Snapshots** | `preamble.test.ts` — if ALab ever varies the preamble per mode, convert the single `it` to `it.each(MODES)` so vitest writes distinct named snapshots into the same file and Classic's 89 lines stay byte-identical. Phase 0's edit changes Classic's snapshot once, deliberately. |

**Known coverage floor, stated so nobody assumes otherwise.** There are **zero** visual snapshots (`toHaveScreenshot` appears nowhere under `tests/`, no `*-snapshots` directories, no baseline PNGs) and only ~29% of `.tsx` components have any co-located test. Classic's *layout* is essentially unpinned; `app-shell-region-order.spec.ts` is the deliberate, platform-stable substitute and it is the only automated protection for DOM-order regressions.

E2E specs require `electron-vite build --mode e2e` (globalSetup does this); reusing a plain `out/` build makes every spec hang on `waitForFunction(() => Boolean(window.__store))`. And per `tests/e2e/AGENTS.md`, the final `expect` must be user-observable — `expect(store.appMode).toBe('alab')` proves nothing.

---

## 12. Build order

One spine, one numbering. **ALab is the first non-Classic mode.** It needs the least new shared surface, its Phase 0 is independently valuable (decision gates today create no gate, resolving one strands the worker, and the coordinator's diagnostics are discarded), and it builds the pane portal that Story World then reuses.

### Phase 0 — Plumbing. Ships invisible. Classic-only, and pinned.

`resolveAppMode` is **hard-pinned** to `{ mode: 'classic', source: 'built-in' }` and there is no selector. This enforces the durable rule:

> **No build may ever contain a way to ENTER a mode that it does not also contain a way to LEAVE.**

Without the pin, a Phase 0 build would read `{"appMode":"alab"}` from disk and apply it with no in-app undo — in an IDE whose purpose is orchestrating agents that write JSON files.

- ~~Delete `src/renderer/src/app-shell/`~~ — **Step 0 is DONE and this line was wrong.** It
  survived from the draft §5.3 corrects: a survey read the tree mid-extraction and took
  `app-shell/` for a dead parallel copy. It is the live shell (`App.tsx` imports 16 modules
  from it). Do not delete it; there is nothing to do for Step 0.
- `src/shared/app-mode/*`: id, surfaces (frozen), manifest, all three registry records, capability reader, resolver (pinned), keybinding-action surface map.
- `src/main/app-mode-preference.ts` + full wiring (constructor, `waitForPendingWrite`, quit flush, `writesFrozen` guard).
- The `updateSettings` strip, the memoized `getSettings()` projection, the `updateSettings`/`settings:get`/`settings:get-sync` return fixes, and the **`getSettings()` caller identity audit**.
- `appMode?: AppModeId` and `appModeSettings?` on `GlobalSettings`, **absent from `getDefaultSettings()`**.
- Web client: `resolveAppMode` returns Classic unconditionally when `__ORCA_WEB_CLIENT__`; `appMode` normalized in `getStoredSettings`/`mergeSettings`.
- App.tsx Steps 1-4 (§5.3) + `data-testid` region attributes.
- The pane portal (Step 5).
- Crash attribution (§10.4).
- All Classic tests from §6 and §11.2.

**Done when:** `pnpm test` and `pnpm test:e2e` pass with zero test-file changes outside the new files and `app-startup-routing.test.ts`; `App.tsx` is shorter; `orca-data.json` is byte-identical; `resolveAppMode({ envMode: 'alab', pinned: { appMode: 'alab' } }).mode === 'classic'`.

### Phase 1 — Selector + ALab.

The selector and ALab's manifest land together; ALab's *features* arrive behind it incrementally. Remove the pin.

- **ALab Phase 0 engine wiring** (§8.1) — five changes, incl. the Rust column and the preamble snapshot. *Four landed ahead of this phase (`2ebbe5f8f`, `1bef9915a`); only `mission-progress.ts` + `runList` counters remain.*
- Menu template split + `app-mode-menu-section.ts` + `fleet-menu-section.ts`; `app-mode-side-effects.ts`.
- `AppModePane.tsx` + `app-mode-search.ts` + the `useSettingsNavigationMetadata.ts` import; `AppModeScopeBadge`; the switch toast with Undo; the `app-modes` feature tip at index 0.
- `orca mode show`/`set` + `appMode` in `orca status --json`.
- The pre-first-paint `getSync()` seed in `main.tsx`.
- Surface-aware shortcut dispatch + Settings ▸ Shortcuts filtering (§10.6); deep-link gating (§10.7).
- `locked` prop; `runtime-orchestration-client.ts`; `use-fleet-orchestration-poll.ts` (one shared 2 s poll with visibility gating — six panes independently polling would compete with workers for the ask long-poll budget).
- ALab console: `MissionStrip`, `LandingBand`, `ExceptionsQueue` (six sources, per-task collapse, ack/snooze), `FleetBoard`, `OrchestratorPane` (via the pane portal), `BurnMeter`, `TaskDetail`, `task-claim-reconciliation`, `MissionDiffOverlay`, `MissionLog`, `fleet-supervisory-actions.ts`.
- `alab-copy.ts`; `alabDefaultMaxConcurrent` clamped to the runtime's reported ask long-poll cap (`LONG_POLL_CAP 16 × ASK_LONG_POLL_SHARE 0.5 = 8`, enforced with `runtime_busy` — a larger fleet has workers whose questions are refused, and BEHAVIOR RULE #1 forbids their only fallback).
- Per-mode unit matrix + curated E2E runner + ALab specs.

**Done when:** a human supervises a fleet all day in ALab, verifies what it produced, reconstructs why it did what it did, and returns to Classic with every tab, pane, PTY and preference intact — proven by the round-trip unit + E2E pair. She cannot yet leave the room.

### Phase 2 — Story World, and ALab unattended.

*Story World prerequisites (nothing child-facing ships before these):* `worktree-watch-lease.ts` + the `useEditorExternalWatch` refactor; `Repo.agentPermissionMode`; `StoryWorldApprovalOverlay`.

*Story World:* parent first-run (3 screens, blocking permission choice); `StoryComposer` + store slice; seeded starter parts + `StoryWorldFirstPrompt`; `AgentAsleepCard`; the three-band stage; the play server with realpath containment, Host allowlist, token prefix, stable port and **Windows hardening**; `story-world-play-target` with the `getConnectionId` guard; `story-world-play-reload`; console-message-primary error detection + paint heartbeat; `StuckCard`; `story-saves.ts`; sound cues; `chrome` prop + `browser-pane-chrome-header.tsx` extraction; the surface gates; `story-world-copy.ts`; the radius + `color-mix` skin (type/motion/touch pending sign-off); `ShowOffView`; `GrownUpPanel`.

*ALab unattended:* extract `notification-dispatch-service.ts`; `orchestration-event-bus.ts` + notifier with per-exception dedupe; enriched `MobileNotificationDispatchEvent`; `'alab.fleet.v1'` capability + `appMode` on `status.get()`; mobile resolve-only allowlist + `/h/<hostId>/gate/<gateId>` route + gate card; coordinator window promoted with `?mode=alab`.

*Shared:* the `app-mode.json` fs watcher; main-process copy remap.

**Done when:** on a plain folder workspace with no git, a non-reading child opens a brand-new empty world, sends a first sentence, sees a game appear, changes it, and recovers from a black screen — without an adult. And an ALab supervisor's phone receives a gate notification, resolves it, and the worker continues.

### Phase 3 — Scope and policy.

`Repo.appMode` + the scope badge's source label; Story World SSH preview + Story Saves over SSH; ALab gate-timeout standing orders (finally calling the already-implemented, never-called `timeout_gate`), the budget gate at `dispatchReadyTasks`, a `stalled` terminal phase (`checkConvergence` currently logs "Stuck: N tasks blocked" and returns false forever — an overnight blocked fleet produces ~14,400 log lines and never reaches a terminal status), coordinator run durability across restart, Standing Orders; a fleet view for the dashboard popout.

**Deferred with reasons:** AI decomposition (a product question — `Coordinator.decompose()` throws unless tasks pre-exist); per-mission cost attribution (needs `providerSession`→dispatch attribution); outbound alert channels beyond mobile (no webhook/Slack/email/ntfy exists anywhere — new surface with its own secrets story); per-window mode (blocked on the `mainWindow` singleton); read-aloud for Story World.

---

## 13. Open questions for the owner

Only genuine decisions. Each with a recommendation.

**1. Parental lock semantics.** The architecture deliberately rejected pin-always-wins so the menu radio never lies. `lock: true` is the opt-in exception (§2.8) — it disables the UI selectors and hoists the sidecar above the per-project rung. A child who finds View ▸ Mode without the lock can leave Story World.
*Recommendation:* ship `lock` as designed. It is opt-in, it is visible in both UIs, and "she can leave and you can put her back" is the right default for a machine the parent also uses.

**2. Story World's agent is not sandboxed. Is that acceptable on a child's machine?**
**Partially resolved in core (2026-07-28).** The permission model now has a third preset,
`safe` = OS-confined + prompts off (`SAFE_TUI_AGENT_ARGS` in
`src/shared/tui-agent-permissions.ts`: codex `--sandbox workspace-write
--ask-for-approval never`, gemini `--sandbox --approval-mode yolo`), selectable in
Settings ▸ Agents and stored as `GlobalSettings.agentPermissionPreset` so intent survives
compilation. Agents with no OS confinement fall back to their own prompts under `safe`,
never to a bypass flag, and the fail-closed refusal is LIVE for unattended
work: `decideUnattendedAgentDispatch` (`src/shared/unattended-agent-dispatch.ts`) gates
`Coordinator.dispatchTask` — under the Safe preset a fleet only drives workers whose
ACTUAL launch (via `getTerminalAgentLaunchProfile`, never stored intent) verifies as
confined + silent; everything else is refused before the circuit breaker with the reason
in the run log. `agentSupportsConfinedLaunch()` is the same allowlist Story World's agent
picker consults when its UI lands. What remains mode-scoped: the lock (a child must not
be able to flip the preset), the picker filtering itself, and the Codex `sandbox_mode`
config path (excluded from `PROMOTED_CODEX_SETTING_KEYS`) if config-level enforcement is
ever wanted over launch flags.

**3. Type scale, motion tokens, and the `touch` button variant.** Three documented additions (§9.3), each in both `:root` and `.dark`, exposed in `@theme inline`, documented in STYLEGUIDE.md. Story World's visual phase is blocked on this.
*Recommendation:* approve all three as one decision. `--app-font-scale` and `touch` are usability requirements for a six-year-old; the motion set is the smaller of the three and pays for itself immediately by giving the 7 existing `prefers-reduced-motion` guards something to key on.

**4. `ask` with two possible answerers.** After Phase 0, `orca orchestration ask --to <handle>` reaches a human via a gate when the handle names the autopilot, and reaches an agent via a reply when it names an orchestrator agent. Same verb, two meanings.
*Recommendation:* keep one verb. Two verbs (`ask` vs `escalate --gate`) is more precise but harder for agents to use correctly, and the preamble already tells workers to ask when blocked regardless of who answers. Decide **before** Phase 0 lands — changing it later is another snapshot-pinned contract change.

**5. The 2am problem cannot be fully solved in this repo.** No APNs/FCM; a locked phone receives nothing until the app is reopened (§8.5). Options: (a) accept it — the gate waits, the run continues on unblocked tasks, `getMissedSince` delivers on wake; (b) add one outbound channel (even a 30-line ntfy POST is new surface with its own configuration and secret-storage story).
*Recommendation:* (a) for v1, plus Phase 3 standing orders so an unanswered gate falls through to a pre-declared human default rather than blocking indefinitely. Evaluate (b) separately as a product feature, not as part of modes.

**6. Should mobile get orchestration control at all?** Adding `gateList`/`gateResolve` to `MOBILE_RPC_METHOD_ALLOWLIST` widens the surface for every user, since the allowlist is keyed by device scope, not by mode.
*Recommendation:* resolve-only (allow `gateResolve` + `gateList` + read-only queries; deny `runStop`, `taskUpdate`). A phone can unblock but never restructure. A new `'supervisor'` `DeviceScope` is cleaner but is a larger change than the value justifies today.

**7. AI decomposition.** `Coordinator.decompose()` throws unless tasks pre-exist, so Phase 1 routes the spec to the orchestrator *agent*, which builds the DAG via the bundled `orchestration` skill. Mission-launch quality then depends entirely on how well that agent drives a CLI.
*Recommendation:* ship agent-writes-the-DAG in Phase 1 and make New Mission a prompt box with live task-appearance feedback, not a form. Revisit an opinionated scaffolder once there is evidence of what agents get wrong.

**8. ALab on folder workspaces loses its verification surface.** `checks` is `gitOnly` and `task-claim-reconciliation` needs git status, so the "only signal that can contradict a worker" is unavailable on exactly the workspace kind Story World declares first-class.
*Recommendation:* document the limit for v1 and surface it explicitly in the mission header ("CI unavailable: folder workspace"), rather than silently showing nothing. A non-`gitOnly` checks path is a real feature with its own design.

**9. What is the unit of the fleet — `coordinatorHandle` or `orchestrationRunId`?** A handle can host sequential runs; a run has exactly one handle. Grouping by handle keeps a mission's history together across restarts; grouping by run fragments the board after any restart.
*Recommendation:* `coordinatorHandle ?? orchestrationRunId ?? 'unassigned'` as specified. Decide before `FleetBoard`'s group headers are written — it changes what "a mission" means to the user.

**10. Coordinator runs do not survive a main-process restart.** `activeCoordinators` is a module-level in-memory `Map`; a restart strands rows marked `running`, reaped only lazily. `MissionStrip` will display a lie after any crash or update.
*Recommendation:* minimum fix in Phase 1 — mark all active runs failed at startup with a visible "interrupted by restart" state. Resuming the loop from durable state is Phase 3 or later.

**11. Should `FleetBoard` show a per-agent "launched yolo" marker?** Honest, and probably alarming — Orca ships yolo by default and back-filled existing users.
*Recommendation:* yes, as a small neutral badge on the row, plus the launch posture stated in the New Mission dialog. A supervisor deserves to know what her fleet is allowed to do, and hiding it does not make it safer.