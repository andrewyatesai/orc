# Design: User-Defined Keybinding Actions (#9338)

**Issue:** [#9338] iTerm2-style key bindings — map a key/shortcut to arbitrary text or escape sequences (P2)
**Verdict:** `still-applies` (high confidence) — `sendInput` is hardcoded in `terminal-shortcut-policy.ts`, the action union is closed, no Settings surface.
**Scope:** send-text macros (text / escape sequences), palette invocations (bind a chord to a Quick Command), and an evaluated-then-deferred answer for per-terminal overrides. All existing `KeybindingActionId` members, defaults, and override semantics are untouched.
**aterm engine surface:** **None.** See "Engine boundary" below.

---

## 1. Current architecture (research summary — do not re-derive)

| Concern | Seam |
|---|---|
| Fixed action union | `src/shared/keybindings.ts:28` (`KeybindingActionId`), registry `KEYBINDING_DEFINITIONS` `:197`, `DEFINITIONS_BY_ID` `:1078`, `isKeybindingActionId` `:1113` |
| Override shape | `KeybindingOverrides = Partial<Record<KeybindingActionId, string[]>>` `src/shared/keybindings.ts:115` |
| Chord grammar / validation | `parseKeybinding` `:1294`, `normalizeKeybindingWithOptions` `:1377` (module-private; options `NormalizeKeybindingOptions` `:181` with `allowBareKeybindings` restricted by `isSafeBareKey` `:1351` to F-keys/nav keys), canonical form `canonicalizeParsedKeybinding` `:1327` |
| Event matching | `keybindingMatchesInput` `src/shared/keybindings.ts:2018` — logical-key first, physical-code fallback only when `key ∈ PHYSICAL_CODE_FALLBACK_KEYS` (`:1557`) or non-Latin-layout chord (`:1598`); AltGr guard `:1940`; macOS Option composition fallbacks `:1864`, `:1878` |
| Conflict detection | `findKeybindingConflicts` `src/shared/keybindings.ts:2235`; identity `keybindingConflictIdentityForParsed` `:2043`; result type `KeybindingConflict` `:188`; group = `conflictGroup ?? scope` |
| Persisted file | `~/.orca/keybindings.json` — `src/main/keybindings/keybinding-file.ts` (`FILE_VERSION = 1` `:21`, `ROOT_KEYS` `:23`, `readKeybindingFile` `:248`, load-time conflict pruning `removeConflictingOverrides` `:212`, single write-assembly path `writeActivePlatformSection` `:385`, `writeKeybindingOverride` `:426`) |
| Snapshot | `KeybindingFileSnapshot` `src/shared/keybindings.ts:124` → service `src/main/keybindings/keybinding-service.ts:29` → IPC `src/main/ipc/keybindings.ts:16` (broadcast `keybindings:changed` `:7`) → preload `src/preload/index.ts:1881` / `src/preload/api-types.ts:2182` / `src/renderer/src/web/web-preload-api.ts` → store slice `src/renderer/src/store/slices/keybindings.ts:34` |
| Terminal dispatch | `resolveTerminalShortcutAction` `src/renderer/src/components/terminal-pane/terminal-shortcut-policy.ts:78`; action union `TerminalShortcutAction` `:31` already has `{ type: 'sendInput'; data: string }` `:43` (hardcoded emitters: Shift+Enter `:166-180`, Ctrl+Enter `:182`, Ctrl/Alt+Backspace `:196/:246`, word-nav `:259/:272`, Cmd chords `:209`) |
| Terminal keydown host | `useTerminalKeyboardShortcuts` `src/renderer/src/components/terminal-pane/keyboard-handlers.ts:233`; `onKeyDown` `:325`; policy invocation `:413`; `sendInput` handling incl. IME Enter deferral `:438-480`; `encodeKey` (engine encode via `atermController.encodeKeyForHost`) `:489-505`; native-only companion/`beforeinput` suppression pattern `:697-716` (tracker: `terminal-native-only-shortcut.ts`) |
| App/window dispatch | `resolveWindowShortcutAction` `src/shared/window-shortcut-policy.ts:168` — **explicit allowlist** for main-process `before-input-event` interception (`src/main/window/createMainWindow.ts:874`); comment `:288-292` forbids widening it casually |
| Quick Commands ("palette") | Types `TerminalQuickCommand` `src/shared/types.ts:2561` (persisted at `settings.terminalQuickCommands` `:2721`, repo/global scope `:2533`); dispatch `sendTerminalQuickCommandToPane` `src/renderer/src/components/terminal-pane/terminal-quick-command-dispatch.ts:20` → `buildTerminalQuickCommandInput` `src/renderer/src/lib/git-wasm/terminal-quick-commands.ts:79` (`command + optional \r`); agent-prompt commands return `false` `:31` |
| Settings UI | `ShortcutsPane.tsx:57` (rows from `groupDefinitions` `shortcut-groups.ts:23`; conflict map `:98-114`; save/conflict-block `:166-218`; chord recorder state `:73-91` incl. `setShortcutRecorderFocused` suspension `:88`) |
| PTY transport | `PtyTransport.sendInput(data: string): boolean` (`pty-transport-types.ts`), same interface for local IPC, SSH, and remote-runtime panes (`remote-runtime-terminal-multiplexer.ts`) — a custom sendText automatically reaches remote hosts |
| PTY host identity | `resolveTerminalInputHostPlatform` (used at `keyboard-handlers.ts:312-323`) — client OS vs PTY-host OS split already exists |
| IME | composition guards: `keyboard-handlers.ts:468` (deferred Enter), `terminal-ime-native-text-forwarder.ts:115` (`isComposing` bail) |

---

## 2. Data model (new shared module)

**New file: `src/shared/custom-keybindings.ts`** (concrete name per AGENTS.md; no `utils`/`helpers`). Everything additive; nothing in `src/shared/keybindings.ts` changes semantics for existing ids.

```ts
import type { KeybindingInput, KeybindingValidationResult } from './keybindings'

/** Ids live in a reserved namespace so they can never collide with the fixed union. */
export type CustomKeybindingActionId = `custom.${string}` // `custom.` + 12-char base36 nanoid

export type CustomKeybindingActionSpec =
  | { type: 'sendText'; text: string }                 // RAW string incl. escapes, decoded at parse time
  | { type: 'runQuickCommand'; quickCommandId: string } // id of a TerminalQuickCommand (types.ts:2561)

export type CustomKeybinding = {
  id: CustomKeybindingActionId
  title: string                 // shown in Settings + conflict messages
  action: CustomKeybindingActionSpec
  bindings: string[]            // canonical chord strings (same grammar as overrides)
  /** Match the chord's key token against event.code (physical key) even when the
   *  IME rewrote event.key to a composed char (full-width 。，). Default false. */
  matchPhysicalKey?: boolean
  // `when` is RESERVED (parsed+preserved, not evaluated in v1) — see §8.
  when?: { hostPlatform?: 'darwin' | 'linux' | 'win32'; connection?: 'local' | 'ssh' | 'wsl' }
}

/** Parse-time enrichment; this is what the snapshot ships to the renderer. */
export type ResolvedCustomKeybinding = CustomKeybinding & {
  /** Present iff action.type === 'sendText' and escapes decoded cleanly. */
  decodedText?: string
}
```

### Escape decoding

```ts
export function decodeCustomSendText(raw: string):
  | { ok: true; text: string }
  | { ok: false; error: string }
```

Supported: `\e` (=`\x1b`), `\xNN`, `\uNNNN`, `\u{...}` (validated ≤ 0x10FFFF), `\n`, `\r`, `\t`, `\0`, `\\`. Unknown `\<char>` → error (not pass-through — silent pass-through is how iTerm2 configs rot). Empty decoded result → error. Decoding happens once in the main-process parser (§4) so renderer and main never re-implement it; `decodedText` rides the JSON snapshot (control chars are valid JSON string content).

### Chord validation for custom entries

Existing `normalizeKeybindingWithOptions` (`keybindings.ts:1377`) is module-private and its `allowBareKeybindings` path is gated by `isSafeBareKey` (`:1351`, F-keys/nav only). Do **not** loosen `isSafeBareKey` — every fixed action flows through it. Instead:

1. Add an internal option `allowPrintableBareKeys?: boolean` to `NormalizeKeybindingOptions` (`keybindings.ts:181`) honored inside `normalizeKeybindingWithOptions` (`:1400-1409` modifier requirement: also satisfied when `options.allowPrintableBareKeys === true` and `parsed.key` is a letter/digit/punctuation token or Shift+printable).
2. Export one new function from `keybindings.ts`:

```ts
export function normalizeCustomKeybindingChord(binding: string): KeybindingValidationResult
// = normalizeKeybindingWithOptions(binding, { allowBareKeybindings: true,
//     allowShiftOnlyKeybindings: true, allowPrintableBareKeys: true })
// + reject parsed.doubleTapModifier with
//   'Double-tap shortcuts are not supported for custom shortcuts.'
```

DoubleTap is rejected because double-tap synthetic inputs are only produced by the window-level detector (`createMainWindow.ts:832`) and never reach the terminal keydown path — a DoubleTap custom chord would silently never fire.

### Matching

```ts
export function matchCustomKeybinding(
  entries: readonly ResolvedCustomKeybinding[],
  input: KeybindingInput,
  platform: NodeJS.Platform
): ResolvedCustomKeybinding | null
```

- Per binding, delegate to `keybindingMatchesInput` (`keybindings.ts:2018`) — reusing all layout/AltGr/Option guards for free.
- When `entry.matchPhysicalKey === true` and the normal match fails, retry with a synthetic input `{ ...input, key: '' }`: an empty `key` is in `PHYSICAL_CODE_FALLBACK_KEYS` (`keybindings.ts:1557`), which flips the shared matcher into its existing physical-code path (`physicalCodeKeyTokenFromInput` `:1627`) without touching the matcher itself. This is what makes a bare `Period` binding fire when a CJK IME reports `key: '。', code: 'Period'` (the exact #9338 case — the composed char has no logical token, so today's matcher returns null).
- First entry wins; Settings-side conflict detection (§5) makes ordering ambiguity unrepresentable for saved configs.

---

## 3. Terminal dispatch changes

### `terminal-shortcut-policy.ts`

1. `TerminalShortcutEvent` (`:4`) gains `isComposing?: boolean` (policy stays pure/testable; the DOM event's flag is threaded in by the caller).
2. `TerminalShortcutAction` (`:31`):
   - `sendInput` variant (`:43`) gains an optional flag: `{ type: 'sendInput'; data: string; suppressTextInsertion?: boolean }`. Set `true` when the matched custom chord has no non-Shift modifiers (bare/Shift-only printable) — the handler must also swallow the companion `keypress`/`beforeinput` (see below).
   - New variant: `{ type: 'runQuickCommand'; quickCommandId: string }`.
3. `resolveTerminalShortcutAction` (`:78`) gains one trailing param: `customKeybindings?: readonly ResolvedCustomKeybinding[]`.
4. **Insertion point & precedence** — insert the custom check *between* the built-in configurable block (ends `:153`) and the first hardcoded rewrite (Shift+Enter, `:166`):

```ts
// After the built-in action ladder, before hardcoded byte rewrites.
if (event.isComposing !== true && customKeybindings?.length) {
  const custom = matchCustomKeybinding(customKeybindings, event, platform)
  if (custom) {
    if (custom.action.type === 'runQuickCommand') {
      if (!event.repeat) return { type: 'runQuickCommand', quickCommandId: custom.action.quickCommandId }
    } else if (custom.decodedText !== undefined) {
      return { type: 'sendInput', data: custom.decodedText,
               suppressTextInsertion: chordHasNoNonShiftModifiers(custom /* matched binding */) }
    }
  }
}
```

Rationale:
- **Built-in configurable actions win** over custom entries on the same chord (defense in depth; write-time conflict blocking should prevent this state anyway). Deterministic, matches how `removeConflictingOverrides` treats user config as the droppable side.
- **Custom entries beat the hardcoded rewrites** — this is the whole point of #9338: a user binding Shift+Enter or Ctrl+Backspace to their own bytes must override the built-in `\x1b[13;2u` / `\x17`.
- **`sendText` fires on key repeat** (it substitutes for typing — a held remapped `.` must auto-repeat, mirroring the existing repeat-transparent `sendInput` rewrites); `runQuickCommand` is `!event.repeat`-gated like the command-like built-ins (`:105`).
- **`isComposing` hard-gate**: no custom binding ever matches mid-composition (issue requirement: don't break CJK input). Note this is a *different* choice from the built-in Shift+Enter deferral (`keyboard-handlers.ts:468`), which intentionally fires-and-defers; for user macros, not firing is the only predictable contract. macOS IMEs that insert full-width punctuation *without* an open composition report `isComposing: false`, so the target use case still works.

### `keyboard-handlers.ts`

1. `KeyboardHandlersDeps` (`:195`) gains `customKeybindings?: readonly ResolvedCustomKeybinding[]`; `Terminal.tsx` supplies it from the store (same subscription pattern as `keybindings`, `:224`); add to the effect dep array (`:738`).
2. Thread `e.isComposing` and `customKeybindings` into the policy call (`:413`, wrapper `resolveTerminalKeyboardShortcutAction` `:47` grows the same trailing params).
3. `sendInput` branch (`:438`): unchanged except — when `action.suppressTextInsertion`, arm a suppression for this physical key before sending. Reuse the mechanics of `createTerminalNativeOnlyShortcutTracker` (`terminal-native-only-shortcut.ts`, wired at `:284`, `:697-716`): `preventDefault` on keydown stops normal insertion, but IME direct-insertions can arrive via `beforeinput` without a cancelable keydown default — the existing `onNativeOnlyBeforeInput` (`:710`) shows exactly how to swallow only that key's companion events without harming a concurrent IME commit. New module: `src/renderer/src/components/terminal-pane/terminal-custom-sendtext-suppression.ts` (a second tracker instance with `suppress keypress + beforeinput, allow keydown default-cancel` semantics; do not overload the native-only tracker whose contract is the inverse — allow OS default, block all companions).
4. New `runQuickCommand` branch after `encodeKey` (`:489`):

```ts
if (action.type === 'runQuickCommand') {
  e.preventDefault(); e.stopImmediatePropagation()
  const pane = activePane
  if (!pane) return
  const command = (useAppStore.getState().settings?.terminalQuickCommands ?? [])
    .find((c) => c.id === action.quickCommandId)
  if (!command) return // stale reference; Settings shows the dangling state (§6)
  sendTerminalQuickCommandToPane({ command, pane, tabId,
    transport: paneTransportsRef.current.get(pane.id) })
  return
}
```

`sendTerminalQuickCommandToPane` (`terminal-quick-command-dispatch.ts:20`) already handles `recordTerminalUserInputForLeaf`, focus, and returns `false` for agent-prompt commands — v1 supports **terminal-command** quick commands only; the Settings picker filters with `isTerminalAgentQuickCommand` and explains why (agent-prompt dispatch needs the agent-launch flow, a separate follow-up).

**SSH/remote**: nothing extra — both branches write through `PtyTransport.sendInput`, the same abstraction SSH and remote-runtime panes implement, satisfying the issue's transport requirement by construction.

**No main-process/window changes**: custom entries are terminal-scope in v1 and are deliberately *not* added to the `resolveWindowShortcutAction` allowlist (`window-shortcut-policy.ts:288-292` documents why that list must stay closed). They fire only in the renderer terminal keydown path. `rebuildAppMenu` (`ipc/keybindings.ts:13`) is unaffected — custom actions never become menu accelerators.

### Engine boundary (fork policy check)

No aterm engine work. `sendText` injects literal bytes at the transport layer — the same layer as the existing hardcoded `sendInput` rewrites and Quick Commands — so there is no engine gap to fix and no glue workaround being smuggled in. The window-capture keydown handler (`keyboard-handlers.ts:722-724`, `capture: true` + `stopImmediatePropagation`) runs before the aterm textarea encoder ever sees the event, so the engine's keyboard pipeline is untouched. Two deliberate non-goals, documented for the reviewer:

- Custom bytes are sent **verbatim regardless of the pane's negotiated key protocol** (`atermAppKeyProtocolNegotiated`, `keyboard-handlers.ts:405-411`). That is the user's explicit intent (iTerm2 semantics). A future "encode this key through the negotiated protocol" action type would reuse the existing `encodeKey` action + `atermController.encodeKeyForHost` (`:498`) glue — still no new engine surface (`ty_model!`/`spec_xref` untouched).
- No engine-side keybinding table: matching stays in shared TS where the fixed-action matcher already lives; pushing it into the engine would duplicate the layout/AltGr/IME logic that only the DOM can observe.

---

## 4. Persisted-schema evolution (`~/.orca/keybindings.json`)

**No version bump.** Add one root section, `"custom"`, to file version 1:

```jsonc
{
  "version": 1,
  "keybindings": { /* unchanged */ },
  "platforms": { /* unchanged */ },
  "custom": [
    {
      "id": "custom.k3v9x2m1q8za",
      "title": "ASCII period (CJK remap)",
      "action": { "type": "sendText", "text": "." },
      "bindings": ["Period"],
      "matchPhysicalKey": true
    },
    {
      "id": "custom.p0f4h7n2w6yb",
      "title": "Kitty Shift+Enter",
      "action": { "type": "sendText", "text": "\\x1b[13;2u" },
      "bindings": ["Shift+Enter"]
    },
    {
      "id": "custom.d8s1r5c3j9te",
      "title": "Run: rebuild",
      "action": { "type": "runQuickCommand", "quickCommandId": "qc-rebuild" },
      "bindings": ["Mod+Alt+B"]
    }
  ]
}
```

Compatibility analysis (why no bump is safe):

- **Old build reads new file**: `readKeybindingFile` (`keybinding-file.ts:248`) only parses `keybindings`/`platforms`; the legacy root-shape parse (root keys as action ids, `:275`) triggers only when `document.keybindings === undefined`, and every file this feature ever touches is written through `writeActivePlatformSection` (`:385`) which always materializes `keybindings` — so old builds silently ignore `custom`, no diagnostics.
- **Old build writes new file**: `writeActivePlatformSection` spreads the parsed document (`:398`) and only overwrites `version`/`keybindings`/`platforms` (`:413-421`) — the `custom` section survives a downgrade's Settings edits verbatim. This is the load-bearing property that makes the no-bump choice safe; the new parser must preserve it symmetrically (see write path below).
- **New build reads old file**: missing `custom` → `[]`.

Changes in `src/main/keybindings/keybinding-file.ts`:

1. `ROOT_KEYS` (`:23`) += `'custom'` (affects only legacy root-shape skip logic).
2. New `parseCustomSection(document.custom, diagnostics): ResolvedCustomKeybinding[]`, mirroring `parseBindingSection` (`:129`) diagnostics style (`section: 'custom'`, entry index or id in `actionId` field). Per entry, **drop with an `error` diagnostic** on: non-object; `id` not matching `/^custom\.[a-z0-9]{4,32}$/`; duplicate id; empty/missing `title` (>64 chars truncated with `warning`); malformed `action`; `sendText` whose `decodeCustomSendText` fails or decodes to `''` or exceeds 4 KiB decoded (paste-bomb guard — large payloads belong in Quick Commands, which already chunk via the input write queue); any binding failing `normalizeCustomKeybindingChord`; unknown entry keys other than `when` → `warning`, key preserved on rewrite.
3. `KeybindingFileSnapshot` (`shared/keybindings.ts:124`) gains `custom: ResolvedCustomKeybinding[]` (empty array when absent — additive, existing consumers unaffected).
4. Load-time conflict pruning: extend the `removeConflictingOverrides` loop (`:212`) — see §5 for semantics.
5. Write path — two new functions sharing `writeActivePlatformSection`'s read-mutate-write-reread discipline (refactor its document assembly into `assembleKeybindingDocument` so both callers share one shape):
   - `upsertCustomKeybinding(path, platform, entry: CustomKeybinding): KeybindingFileSnapshot` — validates via the same predicates as the parser, **throws** on a blocking conflict (mirrors `writeKeybindingOverride` `:445-452`), replaces-or-appends by id, preserves all unrecognized root keys and entry keys.
   - `removeCustomKeybinding(path, platform, id: string): KeybindingFileSnapshot`.
   - Stored `bindings` are the canonical normalized chords; the raw (escaped) `action.text` is stored as typed, never the decoded bytes.

Service (`keybinding-service.ts`): `upsertCustom(entry)` / `removeCustom(id)` following `setActionBindings` (`:84`) — write, cache snapshot, return.

IPC (`src/main/ipc/keybindings.ts`, register at `:16`): `keybindings:customUpsert` and `keybindings:customRemove`, both funneling through `broadcastKeybindingsChanged` (`:7`) so every window (and the floating terminal) refreshes atomically. Preload: `src/preload/index.ts:1881` block += `customUpsert(entry)` / `customRemove(id)`; mirror types in `src/preload/api-types.ts:2182` and the web fallback in `src/renderer/src/web/web-preload-api.ts` (no-op rejects, same as other keybinding writes there).

Store slice (`store/slices/keybindings.ts:11`): `customKeybindings: ResolvedCustomKeybinding[]` populated in `applySnapshot` (`:25`) from `snapshot.custom`; actions `upsertCustomKeybinding` / `removeCustomKeybinding` following `setKeybindingOverride` (`:66`).

---

## 5. Conflict detection

Extend `findKeybindingConflicts` (`shared/keybindings.ts:2235`) with a trailing optional param:

```ts
export function findKeybindingConflicts(
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: FindKeybindingConflictOptions = {},
  customEntries?: readonly CustomKeybinding[]
): KeybindingConflict[]
```

- `KeybindingConflict.actionIds` (`:190`) widens to `(KeybindingActionId | CustomKeybindingActionId)[]` — the only observable type change; the two existing consumers (`keybinding-file.ts:219`, `ShortcutsPane.tsx:100`) both map ids → titles via `getKeybindingDefinition` and need a null-fallback to the custom entry's `title` (new helper `resolveKeybindingTitle(id, customEntries)` in `custom-keybindings.ts`).
- Custom entries feed the same owner map: group = `'terminal'` (their scope), identity via `keybindingConflictIdentities` (`:2065`; never digit-index). Custom entries always count as "customized" (they are user config by definition), so any collision — custom↔built-in-terminal-action, custom↔custom — is reported.
- **Bare printable chords do not conflict with typing** by identity (nothing else claims `+++Period`), which is exactly the "silently shadows normal input" hazard the issue flags. That is handled as a *warning*, not a conflict: Settings shows a per-row shadow warning for any custom binding whose chord has no non-Shift modifiers (§6), and the file parser emits a `warning` diagnostic for the same condition so hand-editors see it too.
- Load-time: `removeConflictingOverrides` (`keybinding-file.ts:212`) passes `custom` into the finder; when a conflict set includes a custom entry, **the custom entry's offending binding is removed** (not the whole entry; entry survives with remaining bindings, `error` diagnostic names both sides). Built-in overrides are only dropped for conflicts among themselves, exactly as today — existing behavior byte-for-byte preserved when `custom` is empty.
- Write-time: both `writeKeybindingOverride` (`:445`) and `upsertCustomKeybinding` run the finder with both populations, so Settings can never save either side of a collision.

---

## 6. Settings UI (Settings → Shortcuts)

New subsection rendered inside `ShortcutsPane.tsx` below the existing grid (`:349-418`), styled per `docs/STYLEGUIDE.md` with existing shadcn primitives (`Button`, `Dialog`, `Select`, `Input` from `src/renderer/src/components/ui/`):

**New components** (all under `src/renderer/src/components/settings/`):

- `CustomShortcutsSection.tsx` — `SettingsSubsectionHeader` ("Custom Shortcuts", description: "Send text or run a quick command with a shortcut of your own.") + "Add Custom Shortcut" button + row list. Rows reuse the visual grammar of `ShortcutRowsList` (chord chips via `formatKeybindingList`, `keybindings.ts:2186`) with: title, action summary (`Sends "." ` with escapes re-encoded for display / `Runs "rebuild"`), edit + delete affordances, inline warnings:
  - bare/Shift-only printable chord → "⚠ `<key>` will no longer type its character in terminals."
  - dangling `quickCommandId` (command deleted from Quick Commands settings) → "⚠ quick command no longer exists."
  - conflict messages from the shared `conflictByAction` map (`ShortcutsPane.tsx:98-114`, extended to pass `customKeybindings` and to also index `CustomKeybindingActionId` keys).
- `CustomShortcutEditor.tsx` — dialog for add/edit:
  - **Title** (required).
  - **Shortcut** — chord recorder. Reuse the recording machinery: `recordingActionId` state (`ShortcutsPane.tsx:73-76`) widens to `KeybindingActionId | CustomKeybindingActionId`; the `setShortcutRecorderFocused` suspension (`:88-91`) already prevents global dispatch from stealing the captured chord. Capture goes through a new `keybindingFromInputForCustom(input, platform)` (thin wrapper: `keybindingFromInputWithOptions` + the custom option set, exported next to `keybindingFromInputForAction` `keybindings.ts:1746`). Multiple bindings per entry, same add/remove-at-index mutations (`shortcut-binding-list-mutations.ts`).
  - **Action** — segmented: *Send text* | *Run quick command*.
    - Send text: mono `Input`, helper line "Escapes: `\e` `\xNN` `\uNNNN` `\n` `\r` `\t` `\\`", and a live decoded-bytes preview (hex, e.g. `1b 5b 31 33 3b 32 75`) driven by `decodeCustomSendText` — the preview is the affordance that makes escape typos visible before saving.
    - Run quick command: `Select` over `settings.terminalQuickCommands` (`types.ts:2721`) filtered by `!isTerminalAgentQuickCommand`; empty state links to Settings → Quick Commands.
  - **Match physical key** checkbox (auto-suggested `true` when the recorded chord is bare punctuation), copy: "Match by key position — required for remapping keys while a CJK input method is active."
  - Save → `upsertCustomKeybinding` store action; conflict errors surface inline exactly like `saveBindings` (`ShortcutsPane.tsx:185-198`).
- Search/filter integration: custom rows join the flat `shortcutRows` (`:140`) with synthetic search keywords `[title, 'custom', 'macro', 'send text', payload]` so the rail filters ("conflicts", "unassigned") and both search paths keep working; `filterCounts` (`:147`) needs no change beyond the widened row source.

File-diagnostics for `section: 'custom'` already render through the existing block (`ShortcutsPane.tsx:329-344`) once the parser emits them — no UI work.

---

## 7. IME, bare keys, cross-platform — behavioral contract

1. **Never match while composing**: `event.isComposing === true` (or `key === 'Process'`, folded into the same guard) bypasses all custom entries; the keystroke flows to the engine untouched. This keeps candidate-window commits (Enter/Space/punctuation during conversion) intact.
2. **Bare-key interception** consumes the keystroke fully: `preventDefault` + `stopImmediatePropagation` on keydown (existing `sendInput` branch, `keyboard-handlers.ts:443-444`) plus companion `keypress`/`beforeinput` suppression via the new tracker (§3) for the IME-direct-insert path where keydown's default-cancel is insufficient.
3. **Physical vs logical**: default matching is logical-key (layout-aware, exactly the fixed-action rules incl. AltGr/non-Latin guards); `matchPhysicalKey` opts a single entry into position matching for the composed-character case. Both reuse the one shared matcher — no forked key model.
4. **Client vs host platform**: chords match against the *client* OS (`Mod` = Cmd on macOS), payload bytes are host-agnostic user data — consistent with the policy's existing "keybindings follow the client OS, byte protocols follow the PTY host" split (`terminal-shortcut-policy.ts:95`).
5. **terminal-first policy**: custom entries fire in the terminal keydown path unconditionally — they are terminal input producers, semantically `scope: 'terminal'`, which `keybindingIsActiveInContext` (`keybindings.ts:1823`) always admits; no `TerminalShortcutPolicy` interaction.

---

## 8. Per-terminal overrides — evaluated, deferred to v2

The issue's concrete ask ("different bytes for a specific remote/SSH host") does not require per-*pane* bindings, and v1 ships without them, because:

- keybindings.json has no durable per-terminal identity (pane ids are session-scoped ints; tab ids are workspace state, not user config).
- The two durable scoping axes that exist today are already reserved in the schema: the `when` clause (`hostPlatform` via `resolveTerminalInputHostPlatform`, `connection` via transport kind — both resolvable inside `keyboard-handlers.ts` where `worktreeId`/transport are in scope, `:197`, `:312-323`), and a repo/global scope mirroring `TerminalQuickCommandScope` (`types.ts:2533`).
- v2 = evaluate `when` at match time (filter `customKeybindings` per active pane before the policy call, memoized alongside the existing lazy host lookups) + optional `scope` field. Zero schema migration: v1 parses and preserves `when` untouched.

---

## 9. Test plan (named)

**Shared** — `src/shared/custom-keybindings.test.ts` (new):
- `decodeCustomSendText decodes \e, \x1b, \xNN, \uNNNN, \u{10FFFF}, \n, \r, \t, \0, \\`
- `decodeCustomSendText rejects unknown escapes, bad hex, out-of-range \u{}, empty result`
- `normalizeCustomKeybindingChord accepts bare Period / Shift+Q / Mod+Alt+K; rejects DoubleTap+Cmd`
- `matchCustomKeybinding: logical match, modifier mismatch, first-entry-wins`
- `matchCustomKeybinding: matchPhysicalKey matches key='。' code='Period' (repro #9338) and key='，' code='Comma'`
- `matchCustomKeybinding: matchPhysicalKey does not fire on Ctrl+Alt (AltGr guard preserved)`

**Existing-behavior guards** — `src/shared/keybindings.test.ts` additions:
- `findKeybindingConflicts without customEntries is byte-identical to today` (snapshot of a representative overrides fixture)
- `custom entry chord colliding with terminal.copySelection reports both ids; titles resolve via fallback`

**File** — `src/main/keybindings/keybinding-file.test.ts` additions:
- `parses custom section; missing section yields []`
- `drops entry with bad id / duplicate id / bad action / oversized payload, each with section:'custom' diagnostic`
- `bare-printable chord produces warning diagnostic, entry retained`
- `load-time conflict removes only the custom entry's offending binding, override untouched`
- `upsertCustomKeybinding round-trips, preserves platforms sections, unknown root keys, and when clause`
- `upsertCustomKeybinding throws on blocking conflict with built-in override`
- `removeCustomKeybinding removes only the target id`
- `writeKeybindingOverride still preserves an existing custom section` (downgrade-symmetry guard)

**IPC** — `src/main/ipc/keybindings.test.ts` additions: `customUpsert/customRemove broadcast keybindings:changed with updated snapshot.custom`.

**Policy** — `terminal-shortcut-policy.test.ts` additions:
- `custom sendText on Shift+Enter beats the hardcoded \x1b[13;2u rewrite`
- `built-in terminal.copySelection chord beats a same-chord custom entry`
- `custom sendText fires on event.repeat; runQuickCommand does not`
- `isComposing: true suppresses custom match and falls through unchanged`
- `bare chord sets suppressTextInsertion; modified chord does not`

**Handlers** — `keyboard-handlers.test.ts` additions:
- `custom sendInput writes decodedText to transport and records leaf activity`
- `runQuickCommand resolves command by id and dispatches via sendTerminalQuickCommandToPane; unknown id no-ops`
- `agent-prompt quick command no-ops (dispatch returns false)`

**Repro** — `src/renderer/src/components/terminal-pane/repro-9338-cjk-fullwidth-punctuation.test.ts` (new, naming per `repro-8299-shift-space-input-source.test.ts`): full-width `。` keydown (`key:'。'`, `code:'Period'`, `isComposing:false`) with a bare-Period sendText entry → transport receives `.`, companion `beforeinput` with `。` suppressed; same event with `isComposing:true` → nothing sent, event untouched.

**Settings** — `src/renderer/src/components/settings/CustomShortcutEditor.test.tsx` (new): conflict save blocked with named counterpart; bare-key warning shown; escape preview renders hex; agent quick commands filtered from picker. `CustomShortcutsSection.test.tsx`: dangling quick-command warning; delete flow.

---

## 10. Milestones

1. **M1 — shared core**: `custom-keybindings.ts` (+`keybindings.ts` additive exports), conflict-finder extension, full shared test suite. *(No behavior change anywhere.)*
2. **M2 — persistence/IPC**: parser, write paths, service, IPC, preload, store slice, snapshot field.
3. **M3 — dispatch**: policy + keyboard-handlers + suppression tracker + repro test.
4. **M4 — Settings UI**: section, editor, search/conflict integration.
5. **v2 (separate)**: `when`-clause evaluation, repo scope, agent-prompt quick commands.

Effort: **L** (4 milestones, ~10 files touched + 5 new, no engine work, no migration). Risk concentrated in M3's IME suppression edge cases — mitigated by reusing the proven native-only tracker pattern and the isComposing hard-gate.

---

## Critic notes

Spot-checked 2026-07-22. Verified exactly as cited: `KeybindingOverrides` (:115), `normalizeKeybindingWithOptions` (:1377) with `isSafeBareKey` (:1351) and the modifier requirement (~:1392), `PHYSICAL_CODE_FALLBACK_KEYS = ['', 'Dead', 'Unidentified']` (:1557) and the empty-key flip into the physical path (:1586) — so the `{...input, key: ''}` retry trick is viable; `keybindingFromInputForAction` (:1746), `findKeybindingConflicts` (:2235), `keybindingConflictIdentityForParsed` (:2043); `FILE_VERSION` (:21), `ROOT_KEYS` (:23), `removeConflictingOverrides` (:212), `readKeybindingFile` (:248), `writeActivePlatformSection` (:385); `sendInput` variant (:43), built-in ladder ending ~:155 and the Shift+Enter rewrite at ~:166-180 (insertion point is exactly where claimed); native-only tracker (:284, beforeinput :710-735); `sendTerminalQuickCommandToPane` (:20). Issues:

1. **Repeat-key precedence hole at the insertion point.** All built-in configurable actions except `switchInputSource` are gated behind `if (!event.repeat)` (:105+). The custom check sits *after* that block and (for `sendText`) deliberately fires on repeat. Consequence: a held chord that matches a built-in on first press falls through to a same-chord custom entry on every repeat event. Write-time conflict blocking should make this unrepresentable, but load-time pruning only runs at file read and the design's own defense-in-depth rationale ("should prevent this state anyway") concedes the state can exist. Fix cheaply: in the custom branch, skip entries whose matched binding also matches any built-in definition (repeat-independent check), and add the policy test "held built-in chord does not fire a same-chord custom sendText on repeat".
2. **AltGr guard under the empty-key retry.** The synthetic `{...input, key: ''}` input takes the physical-code path, but the AltGr guard (:1940 area) keys off the original event's modifier state — confirm the guard is evaluated before the key-token comparison in the physical path, and keep the design's named test "matchPhysicalKey does not fire on Ctrl+Alt" as a blocking test, not a nice-to-have. If the guard reads `input.key`, the retry must preserve enough of the original input for it (pass `altGraph`/modifier state through unchanged).
3. **`keypress` suppression is legacy.** Modern Chromium fires `beforeinput`/`input` for IME direct-insertions; `keypress` rarely fires at all. The new suppression tracker should target `beforeinput` (as the design's cited :710 pattern does) and treat `keypress` as best-effort — reword §3 item 3 so the tracker contract is "swallow companion beforeinput", not "keypress + beforeinput" as co-equal.
4. Minor: `ROOT_KEYS` also contains `'$schema'` (:23) — no behavior impact on the `custom` addition, just keep the legacy root-shape skip logic intact when extending the set.

Everything else — schema evolution safety argument (spread-preserving write path :398/:413-421), conflict-finder extension, Settings reuse — checks out against the code. Effort L stands; engine-boundary analysis (none) is correct.
