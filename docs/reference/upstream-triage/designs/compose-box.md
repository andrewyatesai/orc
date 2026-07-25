# Design: Terminal Compose Box (#6034 + in-terminal half of #7084/#7425)

Status: design, ready to implement. All paths relative to `/Users/ayates/orc`.
Verdicts: #6034 `still-applies`, #7084 `partially-addressed` (native-chat covers the AI-prompt half; no in-terminal editor), #7425 `partially-addressed` (rich-input half only — the smooth-scrolling half is a separate work item on `scroll_px`/`scroll_lines_frac` and is **out of scope here**).

## 1. Summary

A toggleable multi-line drafting editor anchored to the bottom of the **active terminal pane**. The user drafts with normal textarea editing; Enter sends the draft to the PTY through the existing paste pipeline (bracketed when negotiated), with the submit Enter as a separate write encoded per the pane's negotiated keyboard protocol. Draft + history survive close/reopen and pane switches via an LRU cache keyed by stable pane identity, mirroring the native-chat composer.

**Non-goals** (state in PR description): Warp-style output blocks; syntax highlighting / rich formatting (no Monaco/CodeMirror — renderer chunk budget; plain mono textarea); slash-command/skill pickers (agent-specific, native-chat already owns them — #7084's AI half); auto-surfacing on interactive prompts; mobile (`MobileDriverOverlay` path untouched).

**Engine work: none.** This is glue/UI only. Consumed engine surfaces (all already exposed): `keyboard_mode_bits` (src/renderer/src/lib/pane-manager/aterm/aterm-pane-wiring.ts:392), `encodeKeyForHost` (aterm-pane-controller-types.ts:133), `bracketed_paste_mode` (aterm-engine-reads.ts:115), `is_alt_screen` via `buffer.active.type` (aterm-facade-buffer.ts:215). No `rust/aterm` change → no ty_model!/spec_xref/adversarial-review obligations triggered.

## 2. New files (all in `src/renderer/src/components/terminal-pane/`)

| File | Responsibility |
|---|---|
| `TerminalComposeBox.tsx` | The overlay component: textarea, footer hints, send/stage buttons. |
| `terminal-compose-box-send.ts` | Pure + async send: paste-plan build, submit-Enter encoding, agent-delay policy. |
| `terminal-compose-box-ime-guard.ts` | Enter-vs-IME guard incl. macOS Hangul re-dispatch absorb window. |
| `terminal-compose-box-draft-cache.ts` | Module LRU for `{draft, history}` keyed by paneKey. |
| + colocated `.test.ts(x)` for each | See §9. |

Naming follows the concrete-concept rule (AGENTS.md); no `helpers`/`utils`.

## 3. Invocation

### 3.1 Keybinding: `terminal.composeBox`, default `Mod+Shift+Period`

iTerm2 "Open Composer" parity (⇧⌘.). Verified unclaimed in `KEYBINDING_DEFINITIONS` (only `Mod+Comma` = settings uses that punctuation family, src/shared/keybindings.ts:212). Do **not** use Warp's Ctrl+G: `^G` is a live shell byte on Linux/Windows where Mod=Ctrl, and Mod+G collides with search-nav on Mac (keyboard-handlers.ts:353).

1. `src/shared/keybindings.ts` — add `'terminal.composeBox'` to the `KeybindingActionId` union (insert after `'terminal.switchInputSource'`, :113) and a definition after `terminal.splitDown` (:1006-1018):
   ```ts
   {
     id: 'terminal.composeBox',
     title: 'Toggle compose box',
     group: 'Terminal Panes',
     scope: 'terminal',
     searchKeywords: ['shortcut', 'terminal', 'compose', 'multiline', 'draft', 'editor', 'rich input'],
     defaultBindings: platformBindings(['Mod+Shift+Period'])
   }
   ```
   This alone makes it remappable in Settings → Keybindings (definitions drive that UI) and subject to `terminalShortcutPolicy` ('orca-first' | 'terminal-first', keybindings.ts:19).
2. `terminal-shortcut-policy.ts` — extend `TerminalShortcutAction` (:31-58) with `| { type: 'toggleComposeBox' }`; add a branch in the `!event.repeat` chain (:107-155, next to `terminal.expandPane` :130):
   ```ts
   if (keybindingMatchesAction('terminal.composeBox', event, platform, keybindings)) {
     return { type: 'toggleComposeBox' }
   }
   ```
   (`keybindingMatchesAction`: src/shared/keybindings.ts:2083.)
3. `keyboard-handlers.ts` — new dep `onToggleComposeBox: () => void` in `KeyboardHandlersDeps` (:195-226); handler in `onKeyDown` beside `toggleExpandActivePane` (:616-629). **IME deferral — see §6.1**: when `e.isComposing`, open via `sendTerminalInputAfterComposition(activePane?.terminal.element, onToggleComposeBox)` (terminal-ime-deferred-newline.ts:25-56) instead of synchronously.
4. Gate on the setting (§8): resolve `useAppStore.getState().settings?.terminalComposeBox !== false` inside the handler (same lazy-store pattern as `getActivePaneWindowsShiftEnterEncoding`, keyboard-handlers.ts:299-308).

Chord-while-focused: the window-level handler skips editable targets (`isEditableTarget`, keyboard-handlers.ts:87-107), so the same chord **cannot** close the box from within. `TerminalComposeBox`'s own `onKeyDown` must re-match `keybindingMatchesAction('terminal.composeBox', e, platform, keybindings, { context: 'terminal', terminalShortcutPolicy })` and close.

### 3.2 Context menu

Add a "Compose…" item to `TerminalContextMenu.tsx` (item block pattern at :296) wired through `use-terminal-pane-context-menu.ts` (deps struct :73-120), hidden when `settings.terminalComposeBox === false`. i18n keys under `components.terminal-pane.compose-box.*` via `translate()`.

## 4. Mount point and UI

State in `TerminalPane.tsx`: `const [composeOpen, setComposeOpen] = useState(false)` next to `searchOpen` (:370-372). Render exactly like the search overlay — portal into the active pane's container (TerminalPane.tsx:3025-3036):

```tsx
{composeOpen && activePane?.container &&
  createPortal(
    <TerminalComposeBox
      paneKey={makePaneKey(tabId, activePane.leafId)}   // shared/stable-pane-id.ts:22
      pane={activePane}
      transport={paneTransportsRef.current.get(activePane.id) ?? null}
      tabId={tabId}
      worktreeId={worktreeId}
      forceBracketedMultilineTextPaste={forceBracketedMultilineTextPaste}  // TerminalPane.tsx:791
      keybindings={keybindings}
      terminalShortcutPolicy={settings?.terminalShortcutPolicy ?? 'orca-first'}
      onClose={() => { setComposeOpen(false); activePane.terminal.focus() }}
    />,
    activePane.container
  )}
```

- Overlay, **not** layout push: pushing would resize the grid → PTY resize → SIGWINCH reflow of a running TUI on every toggle. Position `absolute inset-x-2 bottom-2 z-40` (below TerminalSearch's `z-50`, TerminalSearch.tsx:275; above the composition overlay's canvas z-4/helpers z-5, aterm-composition-view.ts:59).
- Container styling reuses the native-chat field tokens verbatim (NativeChatComposerField.tsx:129-130): `rounded-lg border border-border p-1.5 shadow-xs bg-muted/50 dark:bg-input/40`; textarea `min-h-12 max-h-[40%] resize-none bg-transparent font-mono text-sm scrollbar-sleek` (mono is the one deliberate divergence — this drafts shell input). Tokens per docs/STYLEGUIDE.md; no new values.
- Footer: left — target hint (see §5.3 warning states); right — `⇧↩ newline · ⌘↩ stage · ↩ send` (platform labels per AGENTS.md), Send button (shadcn `Button`).
- Pane switches: box follows `activePane` (the portal target changes); draft continuity is the cache's job (§7). Pane close / tab switch: unmount persists draft via cache write on every change, nothing to flush.
- While open, terminal-scope chords are inert by design (`isEditableTarget` guard); only the two pre-guard branches (file-search selected-text :338, search-nav :353) can still fire — acceptable, they don't type into the box. Esc inside the box: `stopPropagation()` then close, so tab-level Esc handlers never see it.

## 5. Send semantics

### 5.1 Body: reuse the paste pipeline wholesale

`terminal-compose-box-send.ts` mirrors `handleTerminalProgrammaticTextPaste` (terminal-programmatic-text-paste.ts:22-100) — same plan/execute/target-current machinery, so SSH remotes, WSL, chunking (16 KiB chunks / 64 KiB direct / 16 MiB cap, terminal-paste-limits.ts:1-3), remote timeouts, and stale-target cancellation all come for free:

```ts
export type ComposeBoxSubmitMode = 'submit' | 'stage'
export type ComposeBoxSendArgs = {
  text: string
  mode: ComposeBoxSubmitMode
  pane: ManagedPane
  transport: PtyTransport | null
  tabId: string
  worktreeId: string
  forceBracketedMultilineTextPaste: boolean
}
export type ComposeBoxSendResult =
  | { status: 'sent'; submitted: boolean }
  | { status: 'rejected'; reason: TerminalPasteExecutionReason }  // terminal-paste-model.ts:53-59
```

Flow:
1. Trim exactly one trailing newline (a trailing `\n` would double-execute in the unframed fallback).
2. `planTerminalPasteWithYield({ text, source: 'programmatic', target, forceBracketedPasteForMultiline: forceBracketedMultilineTextPaste, terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true })` — target built exactly as terminal-programmatic-text-paste.ts:49-66 (`resolveTerminalPasteRuntime` terminal-paste-runtime.ts:27, `getTerminalPasteSshRemotePlatform`).
3. `executeTerminalPastePlan(plan, { pasteText: (t, o) => pasteTerminalText(pane.terminal, t, o), writePty: (d) => writeTerminalPastePtyInput(transport, d), isTargetCurrent/canContinue: isTerminalPanePasteTargetCurrent(...) })` (terminal-paste-executor.ts:26; terminal-pty-paste-writer.ts:5; terminal-paste-target-state.ts:24).
4. On `status === 'pasted'`: `recordTerminalUserInputForLeaf(tabId, pane.leafId)` (terminal-input-activity.ts:4), then submit per §5.2, then `pane.terminal.focus()`.
5. On `rejected`: keep the draft, surface the reason in the footer (reuse `TerminalErrorToast` copy pattern for `payload-too-large`).

Bracketing therefore keys off what the foreground app actually negotiated (mode 2004, engine-read via facade `modes.bracketedPasteMode`) plus the pane's existing Windows-ConPTY force policy — identical to clipboard paste, no new protocol decisions. Escapes inside the draft are neutralized by `sanitizeBracketedPasteText` (terminal-bracketed-paste.ts:50-64) on every framed path; the plan's `newlinePolicy: 'terminal-cr'` handles LF→CR (terminal-paste-coordinator.ts:176).

### 5.2 Submit Enter: separate write, protocol-encoded, agent-delayed

Never append `\r` inside the framed body — agent TUIs treat a same-write CR as paste content and the text lands without sending (documented at native-chat-send.ts:28-32). After the body write resolves:

- **Encoding**: `pane.atermController?.encodeKeyForHost('Enter', 0) || '\r'` — the engine emits the pane's negotiated dialect (kitty CSI-u / modifyOtherKeys) and returns null/'' for legacy panes. Same pattern and fallback as the `encodeKey` action (keyboard-handlers.ts:489-505). This is the whole kitty-mode story for submit; paste framing (§5.1) is orthogonal and already gated on mode 2004.
- **Agent panes** (`useAppStore.getState().paneForegroundAgentByPaneKey[paneKey]` truthy agent, store/slices/pane-foreground-agent.ts:21): route the Enter through `enqueueNativeChatPtySend(ptyId, NATIVE_CHAT_SUBMIT_DELAY_MS, …)` (native-chat-pty-send-queue.ts:75; 500 ms, shared/native-chat-answer-stepping.ts:1) writing via `transport.sendInput`. Reusing the per-`ptyId` queue — not a bare setTimeout — means a compose-box send and a native-chat send on the same PTY serialize instead of interleaving clear/body/Enter windows (the queue's whole reason to exist, :1-7). `ptyId` via `transport.getPtyId()` (pty-transport-types.ts:128).
- **Plain shells**: `transport.sendInput(enterBytes)` immediately (transport write queue orders it after the body).
- `mode: 'stage'` (Mod+Enter): skip this step entirely — body lands on the prompt for user review; box closes; user presses Enter themselves.

### 5.3 Multiline into a no-2004 target (the honest case)

If the draft is multiline and the app never enabled 2004 (and not Windows-forced), the plan stays unframed and the shell executes lines sequentially — real terminal behavior, same as pasting today. Do not force-frame: literal `\x1b[200~` bytes into a 2004-ignorant app are worse. Instead the footer hint flips to a warning: "App didn't enable bracketed paste — N lines will run one by one" recomputed from `pane.terminal.modes.bracketedPasteMode` + live line count. Alt-screen (`pane.terminal.buffer.active.type === 'alternate'`, facade at aterm-facade-buffer.ts:215): box stays available (drafting for vim/agent TUIs is a headline use case); the same hint logic covers it since it keys on 2004, not screen.

## 6. IME safety

### 6.1 Opening mid-composition (deferred-newline interplay)

The toggle chord's keydown can arrive with `e.isComposing` (it may BE the committing keystroke). Opening synchronously steals focus from aterm's helper textarea mid-preedit; blur-commit ordering is IME-specific and can race aterm's `compositionend` glyph forward — the same race class the deferred-newline sender exists for (terminal-ime-deferred-newline.ts:1-13). Rule: when `e.isComposing`, defer the open through `sendTerminalInputAfterComposition(pane.terminal.element, open)` (:25-56 — bubble-phase compositionend + one macrotask, 200 ms fallback). The pending glyph commits into the terminal like ordinary typing, then the box opens clean. We deliberately do **not** migrate preedit text into the box.

### 6.2 Enter inside the box (`terminal-compose-box-ime-guard.ts`)

The native-chat guard (`isComposing() || event.nativeEvent.isComposing || event.keyCode === 229` → preventDefault Enter, use-native-chat-composer-keydown.ts:45-52) is necessary but not sufficient: macOS Hangul re-dispatches the committing Enter as a plain keydown (`isComposing === false`) ~2 ms after compositionend (documented at terminal-ime-deferred-newline.ts:85-93) — with only the composing-guard, one commit-Enter would submit the draft. Port the absorb-window idea (:62, 50 ms):

```ts
export type ComposeBoxImeEnterGuard = {
  onCompositionStart(): void
  onCompositionEnd(): void   // arms one absorb credit + Date.now() deadline
  /** true → swallow this Enter (composing, keyCode 229, or re-dispatch within 50ms of compositionend) */
  shouldAbsorbEnter(e: { isComposing: boolean; keyCode: number }): boolean
}
```

Single-pane scope (one guard instance per mounted box), so no per-pane map needed. Constant shared by re-export: `TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS`.

### 6.3 Submit → terminal focus ordering

Send runs while the textarea still owns focus (no composition can be active — §6.2 guarantees Enter only proceeds outside composition); `pane.terminal.focus()` happens after the body write resolves (§5.1 step 4), so no terminal-side composition exists to race the submit Enter. The terminal-side `deferredNewlineSender` (keyboard-handlers.ts:285,463-478) is untouched — it guards a different path (window-chord newline while terminal-focused).

## 7. Draft, history, editing

- **Cache** (`terminal-compose-box-draft-cache.ts`): `Map<paneKey, { draft: string; history: HistoryState }>` using `setBoundedScopeCacheEntry` (native-chat-composer-scope-cache.ts:11-24; the cross-feature import already has precedent — terminal-pane imports native-chat modules at TerminalPaneOverlayLayer.tsx:15). Empty-draft entries keep their history (unlike native-chat-draft-cache.ts:18-21, which drops empties — compose history must survive a send, which empties the draft). Session-scoped; no persistence to disk (drafts may contain secrets).
- **History**: reuse `pushHistory`/`recallPrevious`/`recallNext` verbatim (native-chat-composer-state.ts:188-214). Recall on ArrowUp/ArrowDown gated exactly as native-chat (use-native-chat-composer-keydown.ts:93-111): only when `draft === '' || history.index !== null`, so arrows navigate lines of a non-empty draft. Push on successful send (both modes).
- **Keymap**: Enter=send · Shift+Enter=newline (browser default) · Mod+Enter=stage · Esc=close(keep draft) · toggle-chord=close. All checked after the IME guard.
- **Paste into the box**: browser-native (it's a real textarea); no interception needed — clipboard images/files stay on the terminal paste path.

## 8. Settings

One new optional field in `GlobalSettings` (src/shared/types.ts:2594, insert near `terminalRightClickToPaste` :2728):

```ts
/** Terminal compose box (multi-line draft-then-send). Default on; off hides the chord + context-menu entry. */
terminalComposeBox?: boolean
```

- UI: `SettingsSwitchRow` in `TerminalInteractionSection.tsx` (row pattern :256-269) + a search entry via `createLocalizedCatalog` (pattern: terminal-windows-search.ts:108).
- The keybinding itself is remappable/unbindable via the standard Keybindings pane (from §3.1's definition) — no second setting for the chord.
- No default-on behavior change: the box renders nothing until invoked, so classic input mode (the #7084 ask) is the default by construction.

## 9. Tests (named)

- `terminal-compose-box-send.test.ts`
  - "brackets a multiline draft when the pane negotiated mode 2004"
  - "leaves a multiline draft unframed for a no-2004 POSIX shell and preserves CR line splits"
  - "force-brackets multiline on Windows ConPTY panes like clipboard paste"
  - "writes the submit Enter as a separate write using the engine-encoded Enter for kitty/modifyOtherKeys panes, '\\r' fallback for legacy panes"
  - "routes an agent pane's submit Enter through the shared pty queue with NATIVE_CHAT_SUBMIT_DELAY_MS"
  - "stage mode writes the body only and reports submitted:false"
  - "keeps the draft and reports payload-too-large on an oversized draft"
  - "cancels the submit when the paste target went stale mid-flight"
- `terminal-compose-box-ime-guard.test.ts`
  - "absorbs Enter during composition and keyCode 229"
  - "absorbs the macOS Hangul re-dispatched Enter inside the 50ms window"
  - "submits a real Enter after the absorb window expires"
- `TerminalComposeBox.test.tsx`
  - "restores the per-pane draft and history across close/reopen and pane switches"
  - "gates ArrowUp history recall on empty draft or active recall"
  - "Esc closes, keeps the draft, and does not propagate"
  - "shows the sequential-run warning only for multiline drafts into no-2004 panes"
- `keyboard-handlers.test.ts` (extend)
  - "toggleComposeBox chord mid-composition defers the open until compositionend"
  - "toggleComposeBox is inert when settings.terminalComposeBox is false"
- `keybindings.test.ts` (extend): definition registered under terminal scope; `Mod+Shift+Period` collides with no other default.

## 10. Rollout / effort

Effort **M**: ~5 new modules + 4 touched files (keybindings.ts, terminal-shortcut-policy.ts, keyboard-handlers.ts, TerminalPane.tsx) + settings row; heavy reuse means no new protocol or transport code. Follow-up (v1.5, separate PR): `@` path completion reusing the mention derivation (native-chat-composer-state.ts:62-64,169-183) but completing to `shellEscapePath(path, resolveTerminalPasteTargetShell(...))` (pane-helpers.ts:66; terminal-paste-target-shell.ts:11) with the `@` stripped — shells don't read mentions. Explicitly out: smooth scrolling (#7425's other half → wire `scroll_px` in aterm-wheel-lines.ts / aterm-scroll-input.ts; file separately).

## Critic notes

Spot-checked 2026-07-22 against the working tree. Verified exactly as cited: union insert point after `terminal.switchInputSource` (keybindings.ts:113), `terminal.splitDown` definition (~:1006), `Mod+Comma` at :212, `searchOpen` (TerminalPane.tsx:370) and the TerminalSearch portal (:3025-3036), `paneTransportsRef` (:306), paste pipeline (`handleTerminalProgrammaticTextPaste` :21, `planTerminalPasteWithYield`/`executeTerminalPastePlan`), `enqueueNativeChatPtySend` (:75), `NATIVE_CHAT_SUBMIT_DELAY_MS` = 500 (:1), `sendTerminalInputAfterComposition` (:25), `encodeKeyForHost` (aterm-pane-controller-types.ts:133), `getPtyId` (pty-transport-types.ts:128), `sanitizeBracketedPasteText` (:49), `setBoundedScopeCacheEntry` (:10), TerminalSearch `z-50` (:275), `paneForegroundAgentByPaneKey` (:21), `pane.terminal.modes?.bracketedPasteMode` read pattern (terminal-programmatic-text-paste.ts:64), `TerminalPasteExecutionReason` incl. `payload-too-large` (terminal-paste-model.ts:53-56). Implementable as written, with three corrections:

1. **§5.2 queue claim is overstated.** Only the submit Enter is enqueued through `enqueueNativeChatPtySend`; the body goes through the paste executor directly. A concurrent native-chat send on the same ptyId serializes its own clear/body/Enter through the queue, but can still interleave with the compose-box *body* write (body → native-chat item → compose Enter). Either enqueue the whole compose send (body + Enter) as one queue item for agent panes, or state the residual race explicitly in the PR — "sends serialize instead of interleaving" is only true for the Enter halves as designed.
2. **Shifted-symbol chord matching.** On most layouts `Shift+Period` reports `key: '>'`. The shared normalizer/matcher maps `'>'` → `Period` (keybindings.ts:1561, :2218), so `Mod+Shift+Period` matches — but add a named test for the `key:'>'` event shape to `keybindings.test.ts` so this stays pinned (the design's test list only covers collision).
3. **§3.1 step 3 needs the pane element.** `sendTerminalInputAfterComposition(activePane?.terminal.element, …)` — the facade exposes `element` and the deferred-newline module already uses this exact pattern (terminal-ime-deferred-newline.ts:114), but when `activePane` is null at chord time the deferral silently drops the open; make the handler no-op loudly (return) rather than passing `undefined`.

No other issues; effort M is credible, engine-work-none claim confirmed (all consumed surfaces already exposed).
