# ALab Agent Visibility — What a Driving AI Can Actually See

*A feasibility map for the goal: **one AI in an aterm drives another AI in another
aterm, and to the driven AI the driver IS the human.** For each channel the goal
names — text, screen state, scrollback, search, "expanding collapsed portions",
graphics, video — this says what the embedded engine serves today, what Orca can
serve with work, and what genuinely needs `aterm-gui`.*

> Status: analysis only. No code changed. Every claim is cited `file:line`.
> Companion to [`alab-auto-mode-design.md`](./alab-auto-mode-design.md) (the
> submission/await primitives) and [`rust/aterm/docs/INTROSPECTION.md`](../../rust/aterm/docs/INTROSPECTION.md)
> (the semantic model this borrows from).

---

## 0. The one-page answer

| Capability | Today, no work | Achievable in Orca | Needs `aterm-gui` |
| --- | --- | --- | --- |
| Plain text transcript | ✅ `terminal.read` | — | — |
| Visible grid as text | ⚠️ only via the alt-screen/blank fallback | ✅ direct verb, trivial | — |
| **Lossless styled grid** (per-cell fg/bg/attrs/glyph/wide/link) | ❌ | ✅ **engine already computes it** (`Terminal::render_row_at_screen`, `cell_frame_into`) | ❌ not needed |
| Cursor + modes | ⚠️ engine has them, no verb carries them | ✅ trivial | — |
| Backward paging through transcript | ✅ `terminal.read --cursor` (bounded 2000 lines / 256 KiB) | ✅ deeper via engine scrollback | — |
| Backward paging through **engine scrollback** | ❌ | ✅ `scrollbackRowText` exists in Rust, unexposed at napi | — |
| Search over history + grid | ✅ RPC only (no CLI verb) | ✅ add CLI verb | — |
| Search over cold/parked panes | ❌ **daemon handlers not implemented** | ✅ kernel + client wrappers already written | — |
| OSC-133 block expand/collapse | ❌ | ✅ engine API complete (`toggle_block_collapsed`, …) | ❌ not needed |
| Expanding an **agent TUI's** own `… +N lines` | ❌ **bytes do not exist in the stream** | ⚠️ only by driving the keystroke, or reading the agent's transcript file | ❌ can't help either |
| Inline images (sixel / OSC 1337 / Kitty) — parsed & retained | ✅ **in the grid, feature already on** | ✅ expose payload via napi | — |
| Inline images — payload reachable from an agent | ❌ | ✅ moderate | — |
| Pane pixels (a rendered PNG) | ❌ | ✅ **Orca has its own RGBA framebuffer + canvas** | ❌ not needed |
| Pane pixels for a *parked/headless* pane | ❌ | ⚠️ needs an offscreen render path | — |
| Video (temporal frame sequence) | ❌ | ⚠️ big; recommendation in §6 | ⚠️ or link it |

**The single most important finding:** the "parity gap" is narrower than it reads.
`aterm-gui` owns the *control socket and the artifact plumbing*, but almost all of
the **semantics** — the lossless styled frame, the block model, the inline-image
payloads — live in `aterm-core`, which Orca already links. `aterm-gui`'s own
`screen` verb is a thin JSON wrapper over engine reads
(`rust/aterm/crates/aterm-gui/src/control_query.rs:1917-1957`, all `&Terminal`
calls). Only `video` genuinely requires a GPU present path Orca does not have in
that form.

---

## 1. The three seams (read this before the rest)

Orca embeds the aterm engine three times, and they do **not** have the same reach:

| Seam | Crate | Where it runs | What sees it |
| --- | --- | --- | --- |
| **Headless (main)** | `orca-terminal` → napi `orca_node` | Electron main / `orca serve` | every PTY, always, incl. hidden + parked + SSH |
| **Renderer wasm (CPU)** | `aterm-wasm` | render worker | only **mounted** panes |
| **Renderer wasm (GPU)** | `aterm-gpu-web` | render worker, WebGL2 | only **mounted** panes |

* Headless construction: `rust/crates/orca-terminal/src/headless.rs:121-141`.
* napi boundary — the complete list of what main can ask the engine:
  `src/main/daemon/rust-terminal-addon.ts:10-65`, implemented at
  `native/orca-node/src/lib.rs:57-291`.
* Renderer strategy pick (GPU default, CPU guaranteed fallback, worker path is the
  default): `src/renderer/src/lib/pane-manager/aterm/aterm-strategy-select.ts:36-49`.
* Both wasm crates and `orca-terminal` compile the engine **with sixel on**:
  `rust/aterm/crates/aterm-wasm/Cargo.toml:21`,
  `rust/aterm/crates/aterm-gpu-web/Cargo.toml:17`,
  `rust/crates/orca-terminal/Cargo.toml:23`.

**Consequence that drives every recommendation below:** a driving AI must work from
the **headless seam**, because that is the only one that exists for a background
agent pane. Hidden tabs are unmounted after 30 s of hysteresis
(`docs/reference/terminal-hidden-view-parking.md:26-42`) and under `orca serve`
there is no renderer at all. Anything built only on the renderer wasm works for
the pane a human is looking at and nowhere else.

---

## 2. Text and screen state

### 2.1 What `terminal.read` actually returns

`terminal.read` (`src/main/runtime/rpc/methods/terminal.ts:1238`) →
`OrcaRuntime.readTerminal` (`src/main/runtime/orca-runtime.ts:14601`) →
`readTerminalTail` (`src/main/runtime/orca-runtime.ts:33553`).

It returns a **normalized PTY transcript**, not the grid. The shape carries no
style, no cursor, no modes:

```
src/shared/runtime-types.ts:585-595
  handle, status, tail: string[], truncated, limited?,
  oldestCursor?, nextCursor, latestCursor?, returnedLineCount?
```

The tail is built from raw PTY bytes by `normalizeTerminalChunk`
(`src/main/runtime/orca-runtime.ts:34463-34514`), which **strips every escape
sequence** except a narrow set of line-controls kept so a Codex-style status
redraw overwrites its previous frame rather than stacking
(`orca-runtime.ts:34490-34492`). SGR is gone. It is then folded through a
miniature line model that applies CR/backspace/erase and multi-line vertical
controls (`appendNormalizedToTailBuffer`, `orca-runtime.ts:32755-32840`, with a
`RetainedTailRedrawCursor` at `:33107`) — so a repainting TUI produces a plausible
transcript rather than a spinner-frame avalanche, but it is a *reconstruction*,
not the screen.

This is already stated correctly in the auto-mode design and should stay stated
that way: *"Its text is a normalized transcript, renderer-blind — not 'the same
screen the human sees.' The design uses it as evidence, not as a screen oracle"*
(`docs/reference/alab-auto-mode-design.md:104-109`).

### 2.2 The visible-snapshot fallback — narrower than it looks

`withVisibleSnapshotFallback` (`src/main/runtime/orca-runtime.ts:10272-10303`)
swaps the transcript for the **visible grid rows** — but only under conditions
that matter here:

1. `if (typeof opts.cursor === 'number') return read` (`:10276-10278`) — **any
   cursor read is never given the visible grid.** Paging and screen state are
   mutually exclusive on this verb.
2. Otherwise it fires only when the pane is on the alternate screen, or the
   transcript came back substantially blank
   (`shouldFallbackToVisibleTerminalSnapshot`, `orca-runtime.ts:33629-33642`).

The grid rows themselves come from `HeadlessEmulator.getVisibleLines()`
(`orca-runtime.ts:10391-10411`) — i.e. `HeadlessTerminal::snapshot()`
(`rust/crates/orca-terminal/src/headless.rs:304-306`), which is
`row_text` per row with trailing blanks trimmed: **plain text again.** A renderer
fallback exists (`readRendererVisibleSnapshotLines`, `orca-runtime.ts:10435-10465`)
but it re-parses the serialized snapshot through a throwaway emulator and returns
plain lines too (`parseVisibleSnapshotLines`, `:10416-10434`).

Net: **there is no path today by which a driving AI receives a styled grid,
a cursor position, or terminal modes.**

### 2.3 What the engine already has (and nobody exposes)

The headless engine holds all of it:

| Thing | Rust API | At napi? | On the wire? |
| --- | --- | --- | --- |
| Styled cell (char + bold/dim/italic/underline/blink/inverse/conceal/strike/overline + fg/bg as default/indexed/rgb) | `headless.rs:236` `cell()`, `headless.rs:59-84` `CellAttrs`/`Cell` | ❌ | ❌ |
| Cursor `(row, col)` | `headless.rs:309` | ✅ `cursor()` | ❌ |
| Alt screen | `headless.rs:373` | ✅ | ⚠️ internal only |
| Bracketed paste / DECCKM / Kitty keyboard flags | `headless.rs:385`, `:390`, `:380` | ✅ | ❌ |
| Mouse mode + SGR/SGR-pixel encoding | `headless.rs:283`, `:295`, `:299` | ✅ | ❌ |
| Title (OSC 0/2) | `headless.rs:544` | ✅ | ⚠️ via agent-status only |
| OSC-8 link ranges | `headless.rs:489` | ✅ | ⚠️ snapshot only |
| **SGR-styled ANSI of the visible grid** | `headless.rs:405` `serialize_ansi` | ✅ `serializeAnsi` | ⚠️ `terminal.subscribe` only |

`serialize_ansi` is the closest thing shipping to a screen oracle: it emits
minimal change-based SGR per visible row via aterm's `Grid::row_ansi_text_screen`,
handles wide-char continuation, and restores the cursor
(`headless.rs:549-592`). It reads the **live screen** row, not the user's scroll
view (`headless.rs:581-584`) — correct for an observer. It reaches the wire only
through `terminal.subscribe` (`src/main/runtime/rpc/methods/terminal.ts:2692`), a
stateful streaming protocol with binary framing, viewport claims and input leases
— not something a driving AI should be asked to speak.

And the true lossless form is one call away in the engine Orca already links:

* `Terminal::render_row_at_screen(row) -> Vec<RenderCell>`
  (`rust/aterm/crates/aterm-core/src/terminal/render_cells.rs:191`)
* `Terminal::cell_frame(rows, cols) -> RenderInput` / `cell_frame_into`
  (`render_cells.rs:697`, `:746`) — the whole frame: cells, emoji clusters,
  combining marks, per-row DEC line sizes, **inline images**, live default bg,
  live cursor colour, and a monotone `damage_epoch` staleness stamp
  (`rust/aterm/crates/aterm-core/src/render.rs:990-1060`).

`aterm-gui`'s `screen` verb — the one INTROSPECTION.md advertises as *"lossless
styled per-cell grid"* — is `gather_styled_frame`
(`rust/aterm/crates/aterm-gui/src/control_query.rs:1917-1957`), and every line of
it is an engine read: `render_row_at_screen`, `cell_grapheme`, `cell_attrs`,
`hyperlink_at`, `text_selection`, `row_line_size`. **Nothing in it is gui-only.**

### 2.4 Verdict — §1

* **Today:** plain transcript + a conditional plain-text visible grid. Renderer-blind, style-blind, cursor-blind.
* **With work in Orca:** full parity with aterm's `screen` verb. Add `styled_frame()` to `orca-terminal` over `render_row_at_screen`, a napi method, and a `terminal.screen` RPC + CLI verb. The engine work is zero; this is adapter + binding + wire.
* **Needs aterm-gui:** nothing.

---

## 3. Scrollback — can a caller page backward?

### 3.1 Yes, through the transcript — bounded

`readTerminalTail`'s cursor branch (`orca-runtime.ts:33566-33600`) is genuinely
bidirectional. `oldestCursor = completedLineCount - completedLines.length`,
`latestCursor = completedLineCount`, and a caller may name **any** cursor in
`[oldestCursor, latestCursor]`, receiving `limit` lines forward from there. So
"page backward" = repeatedly request `latestCursor - k*limit`. Asking below the
floor is answered honestly: `truncated: args.cursor < oldestCursor`
(`:33588`).

The bound is the retained transcript, not the engine's scrollback:

```
src/main/runtime/orca-runtime.ts:32249-32254
  MAX_TAIL_LINES  = 2000
  MAX_TAIL_CHARS  = 256 * 1024
  MAX_TERMINAL_READ_LIMIT     = 2000
  DEFAULT_TERMINAL_READ_LIMIT = 120
```

Eviction is whichever binds first (`appendCompletedTerminalTranscript`,
`orca-runtime.ts:33420-33452`). A verbose agent blows 256 KiB in minutes. And per
§2.2, a cursor read never gets the visible-grid fallback, so on an alt-screen TUI
the paged content may be the pre-TUI history rather than what is on screen.

### 3.2 The engine's scrollback is deeper — and unreachable line-by-line

The headless engine holds up to the configured retention (default
`DEFAULT_SCROLLBACK = 5000`, `headless.rs:46`; parked replay uses 50 000,
`src/main/daemon/parked-scrollback-search.ts:29`) in a tiered store
(`headless.rs:132-139`).

What exists in Rust:

* `scrollback_len()` — `headless.rs:194`
* `scrollback_row_text(index)` — **random access to any history row**, `headless.rs:214`
* `retained_origin_row()` — stable monotone coordinate surviving eviction, `headless.rs:208`
* `serialize_scrollback_ansi(max_rows)` — history tail, `headless.rs:431`
* `serialize_ansi(Some(n))` — visible grid with the last `n` history rows prepended, `headless.rs:405`

What crosses napi (`src/main/daemon/rust-terminal-addon.ts:10-65`,
`native/orca-node/src/lib.rs:99-286`): `scrollbackLen`, `serializeAnsi`,
`serializeScrollbackAnsi`, `retainedOriginRow`, `searchScrollback`,
`searchContext`, `snapshot`. **`scrollbackRowText` is not bound.** So main can get
"the whole tail" or "a search context window", but cannot say *"give me rows
4000–4100"*. That is the missing paging primitive, and it is a ~10-line addition.

Two honesty notes on `serialize_scrollback_ansi`, both by design:

* It is **text-only** — history colour is deliberately dropped. `with_scrollback`
  calls `aterm_grid::set_scrollback_text_only(true)`
  (`headless.rs:122-127`), and the scroll-off path then keeps *only* OSC-8
  hyperlink spans (`rust/aterm/crates/aterm-grid/src/grid/scroll_convert.rs:834-842`
  → `extract_hyperlinks_only_into` at `:1008-1053`). Colours, RGB extras and
  **inline-image refs are discarded on scroll-off.** `serialize_ansi` likewise
  prepends history as bare text (`headless.rs:558-561`).
* On the alternate screen it reads the **main** grid and additionally preserves
  the main buffer's visible rows, so an in-TUI cold restore recovers the whole
  pre-TUI screen (`headless.rs:431-479`).

### 3.3 The renderer wasm can page — but only for mounted panes

`aterm-wasm` has the full viewport-scrolling model: `scroll_lines(delta)`
(`rust/aterm/crates/aterm-wasm/src/lib.rs:1191`), `display_offset()` (`:1212`),
`serialize_scrollback(max_rows)` (`:1617`), and the batched
`row_range_json(first_row, count)` (`:1901`) which returns text + wrap + len +
per-column wide map for a display-row range in one boundary crossing. That is a
proper backward pager — but it moves the **user's visible scroll position** and
only exists where a pane is mounted (§1).

### 3.4 Verdict — §2

* **Today:** backward paging works over a ≤2000-line / ≤256 KiB plain-text transcript, with honest truncation. No paging over engine scrollback; no styled history anywhere (by design).
* **With work in Orca:** bind `scrollbackRowText` (and a batched `scrollbackRowRange`) at napi, then add `terminal.history --from --count`. Cursor coordinates should be `retainedOriginRow() + absRow` so they survive eviction — the contract is already proven in `rust/crates/orca-terminal/src/scrollback_search.rs:324-344`.
* **Needs aterm-gui:** nothing.
* **Cannot be recovered:** colour of scrolled-off rows, unless `set_scrollback_text_only` is turned off — which would trade a measured flood-path optimization for history colour nobody currently consumes. Do not do this casually.

---

## 4. Search — real scope and real limits

### 4.1 What ships

`terminal.search` (`src/main/runtime/rpc/methods/terminal.ts:1136`) and
`terminal.searchContext` (`:1176`) →
`OrcaRuntime.searchTerminalScrollback` (`orca-runtime.ts:9565`) and
`terminalSearchContext` (`:9638`) → the live headless emulator → the Rust kernel
`HeadlessTerminal::search_scrollback` / `search_context`
(`rust/crates/orca-terminal/src/scrollback_search.rs:202`, `:237`).

**Scope: retained history + the visible grid, for one pane, newest row first**
(`scrollback_search.rs:214-231`). Not visible-only. `abs_row` spans history then
grid (`:257-263`), and the response converts to eviction-stable host rows via
`originRow` (`orca-runtime.ts:9620-9626`).

Semantics: literal by default with Unicode case folding that is byte-compatible
with the wasm find-bar kernel including final-sigma and `İ` expansion
(`scrollback_search.rs:52-99`, tests at `:394-415`); optional regex with a 1 MiB
compile bound where a hostile or invalid pattern yields **zero matches, never an
error** (`:50`, `:111-130`). Search settles staged compression offload first so
row identity agrees with what a snapshot observer sees (`:209`, test at `:513-525`).

### 4.2 The limits that will bite a driving AI

1. **Live-pane only.** `const state = this.headlessTerminals.get(ptyId); if (!state) return unavailable` (`orca-runtime.ts:9599-9602`). A pane with no headless state answers `available: false` — never an error, but never a result.
2. **Cold and parked panes are groundwork, not shipped.** The Rust kernel exists (`replay_for_search`, `scrollback_search.rs:271`), the main-side replay adapter exists (`searchStoredScrollback`, `src/main/daemon/parked-scrollback-search.ts:59`), the daemon **client** wrappers exist (`searchDaemonSessions` `:62`, `searchDeadSessionHistory` `:221`, `fetchDeadSessionSearchContext` `:250` in `src/main/daemon/daemon-session-search.ts`) — but `src/main/daemon/daemon-server.ts` implements **no** `searchSessions` / `searchReplay` / `searchReplayContext` handler. A repo-wide grep finds the string only in the client and in the protocol-version comment (`src/main/daemon/daemon-protocol-versions.ts:22`). **Cold search does not work today.**
3. **Caps.** `maxMatches` is clamped to 200 (`orca-runtime.ts:9612`); every returned `line` is truncated to 512 chars (`:9622`); `searchContext` before/after are clamped to 100 (`:9660-9662`). `incomplete` is honest about the cap (`scrollback_search.rs:230`).
4. **Cols are char offsets, not display columns** — the one documented divergence from the renderer kernel (`scrollback_search.rs:134-138`).
5. **No CLI verb.** `src/cli/handlers/terminal.ts:62-231` and `src/cli/specs/terminal.ts` expose list/show/read/send/wait/submit/stop/create/switch/close/rename/split — and nothing else. Same for `terminal.await`. A driving AI must speak the runtime JSON-RPC socket directly to use search at all.

### 4.3 Verdict — §3

* **Today:** correct, deep, kernel-parity search over one live pane's history + grid. Reachable by RPC only.
* **With work in Orca:** (a) add `orca terminal search` / `search-context` / `await` CLI verbs — hours, not days; (b) implement the three daemon handlers to light up cold/parked panes, since the kernel and the client are both already written.
* **Needs aterm-gui:** nothing.

---

## 5. "Expanding collapsed portions" — which one, and what each costs

This is the item the goal statement leaves ambiguous, and the two candidates need
completely different mechanisms. **The goal needs (b). (a) is real, cheap, and
almost useless for driving an agent.**

### 5.1 Candidate (a) — aterm's OSC-133 command blocks

Real and engine-side. The whole model is in `aterm-core`, not `aterm-gui`:

```
rust/aterm/crates/aterm-core/src/terminal/blocks_api.rs
  :27   BlockText { Text | Evicted | NotAvailable }   ← honest eviction, never silently-empty
  :95   current_block            :103  all_blocks           :112 block_count
  :156  block_at_row             :186  next_block_after_row :220 previous_block_before_row
  :302  last_completed_block     :324  toggle_block_collapsed
  :351  set_block_collapsed      :373  collapse_all_blocks  :388 expand_all_blocks
  :437  total_hidden_rows        :606  block_output_text    :649 block_full_text
```

OSC 133 A/B/C/D is parsed unconditionally by the engine
(`rust/aterm/crates/aterm-core/src/terminal/handler_osc.rs:82` →
`handler_osc_shell.rs:226-243`), and Orca *installs the shell hooks itself* for
bash/zsh/fish/nu (`src/main/shell-templates.ts:219-226`) and PowerShell
(`src/main/powershell-osc133-bootstrap.ts:4-80`). So the blocks are being built in
every Orca pane running an instrumented shell, right now, in both the headless and
the wasm engines.

Orca already consumes one leaf of it: "copy last command output" in the terminal
context menu, via `aterm-wasm`'s `last_command_output()`
(`rust/aterm/crates/aterm-wasm/src/lib.rs:1653-1668` →
`src/renderer/src/lib/pane-manager/aterm/aterm-worker-terminal-query.ts:45-46` →
`src/renderer/src/components/terminal-pane/terminal-context-menu-link-target.ts:119`).
Renderer-only; nothing at napi or on the RPC.

`aterm-gui`'s `blocks` / `blocktext` verbs
(`rust/aterm/crates/aterm-gui/src/control_selection.rs:117-155`) are thin wrappers
over exactly these engine calls.

**Why it does not solve the goal.** An agent CLI is *one* command. `claude` is
launched once; OSC 133 C fires once; D fires when the agent exits. The entire
session is a single block. Collapsing or expanding it moves nothing a driver cares
about, and 133;C is not emitted for a prompt typed into an already-running TUI —
which is exactly why the auto-mode design dropped OSC-133 as its top evidence tier
(`docs/reference/alab-auto-mode-design.md:101-104` and `:310-314`).

**Cost if you want it anyway** (worth it for *shell* panes, not agent panes):
adapter methods on `orca-terminal` → napi → a `terminal.blocks` / `terminal.blockText`
RPC. Small and mechanical, engine work zero. Note `output_blocks()` is `#[cfg(test)]`
(`blocks_api.rs:83`); use the public `all_blocks()` (`:103`).

### 5.2 Candidate (b) — the agent's own TUI collapsing (`… +N lines`)

This is what the goal means, and it is the hard one.

When Claude Code renders a long tool result as `… +214 lines`, **those 214 lines
were never written to the PTY.** The agent decided not to emit them. There is
nothing to un-collapse in the grid, in scrollback, in the transcript, in the
block model, or in a screenshot — the bytes do not exist anywhere in the terminal
pipeline. No engine feature and no `aterm-gui` verb can recover them; aterm is
downstream of the decision.

Two mechanisms actually work:

**(b1) Drive the keystroke a human would press.** Ctrl+O / Ctrl+R style expansion
in the agent's own TUI. Mechanically this already works: `terminal.send`
(`src/main/runtime/rpc/methods/terminal.ts:1283`) writes the payload raw —
`buildSendPayload` does `payload += action.text` with no control-char filter
(`orca-runtime.ts:33678-33694`) — so `--text $'\x0f'` reaches the PTY. (The
`sanitizeUntrustedTerminalText` in `src/cli/terminal-safe-text.ts` guards CLI
*output* formatting, not input.) What is missing is everything around it:

* No screen oracle to *find* the `+N lines` marker and know it expanded (§1).
* No verb for "key" as distinct from "text" — a driver must hand-encode bytes, and the encoding is mode-dependent. The engine can do this correctly: `AtermTerminal::encode_key` (`rust/aterm/crates/aterm-wasm/src/lib.rs:1365`) and `encode_key_with_mode` (`:2203`) exist, honour DECCKM and the Kitty protocol, and are **not bound at napi at all**.
* It is per-agent and version-fragile. Claude Code's expansion key is not Codex's.
* It **mutates the driven agent's UI state**, which the goal accepts (the driver *is* the human) but which must be leased — the input-coordinator work in `alab-auto-mode-design.md:194-211` is the prerequisite.

**(b2) Skip the terminal: read the agent's own transcript.** Claude Code writes
every message and full tool result to `~/.claude/projects/<slug>/<session>.jsonl`
— untruncated, structured, with no collapsing. Orca **already** scans that tree:
`src/main/ai-vault/session-scanner-source-discovery.ts:14` and `:41-49` (local +
every WSL home), `src/main/claude-usage/scanner.ts:48`. The equivalent exists for
Codex (`src/main/codex/codex-session-file-listing.ts:15-20`).

This is by far the cheapest complete answer to "what did the tool actually
return", and it is strictly better than expansion: no keystroke, no UI mutation,
no truncation, full structure. Its limits are equally clear: it is provider-specific
(one reader per agent CLI), it is not a *screen* (it will not tell you what the
human sees), it lags by the agent's flush, and for an SSH-hosted agent the file is
on the remote host — Orca would need the same remote-read path the vault scanner
already models (`src/main/ai-vault/remote-session-scanner-sources.ts:44`).

### 5.3 Verdict — §4

* **What the goal needs:** (b).
* **Recommended:** build **(b2) first** — a `terminal.agentTranscript` reader keyed off the pane's detected agent kind, reusing the existing vault scanner paths. It gives untruncated tool output today with no TUI driving at all.
* **Then (b1)** as the *interaction* answer, once §1's screen oracle exists: bind `encode_key` at napi, add `terminal.key`, and let the driver press what a human presses. Do not attempt (b1) before the screen oracle — without it the driver is pressing keys blind.
* **(a)** is a nice shell-pane feature and a cheap win; it is not on the critical path.
* **Needs aterm-gui:** nothing, for any of the three.

---

## 6. Graphic display — inline images

### 6.1 The engine parses and retains them. This is already on.

| Format | Handling | Gated? |
| --- | --- | --- |
| iTerm2 OSC 1337 `File=` | `rust/aterm/crates/aterm-core/src/terminal/handler_osc_1337.rs:1-45`, dispatched at `handler_osc.rs:91` | **no** — always compiled |
| Sixel DCS | `aterm-sixel` decodes the raster in-engine to packed RGBA8 | `sixel` feature — **on in all three Orca seams** (§1) |
| Kitty graphics + Unicode placeholders | `render_cells.rs:640-676` `placeholder_image_ref`, images held in `transient_state.rs:143` | **no** |

Storage: the payload is kept **once** behind an `Arc<ImageData>` and every covered
cell holds a cheap `ImageRef` with its tile coordinates
(`rust/aterm/crates/aterm-grid/src/extra.rs:131-168`), reachable per cell via
`CellExtra::image()` (`extra.rs:527`). `ImageFormat` is `Png`, `RawRgba8{w,h}`
(the sixel path — decoded in-engine precisely because the renderer has no sixel
codec), or `Unknown` kept verbatim (`extra.rs:105-128`). Payload is capped at
16 MiB and footprint at 4096 cells/axis (`handler_osc_1337.rs:36-44`).

`Terminal::cell_frame_into` gathers them per frame into
`RenderInput.images: Vec<Vec<(usize, ImageRef)>>`
(`render_cells.rs:601-631`, field at `rust/aterm/crates/aterm-core/src/render.rs:1032`).

**So yes: Orca's headless engine parses inline images and keeps the bytes.** Orca
even advertises the capability to apps — DA1 reports sixel support for
aterm-rendered panes (`src/renderer/src/components/terminal-pane/terminal-capability-replies.ts:7-9`),
so programs that gate on `;4` will actually send sixel into Orca.

### 6.2 What blocks a driving AI from getting them

Three walls, all inside Orca, none in aterm:

1. **`orca-terminal` exposes no image accessor.** Its `Cell` is `{ ch, attrs }` only (`rust/crates/orca-terminal/src/headless.rs:73-84`); nothing in its public surface touches `CellExtra::image()`.
2. **Nothing crosses napi.** `src/main/daemon/rust-terminal-addon.ts:10-65` has no image method.
3. **Images do not survive scroll-off in the headless seam.** `set_scrollback_text_only(true)` (`headless.rs:127`) routes scrolled rows through `extract_hyperlinks_only_into` (`scroll_convert.rs:839-842`, `:1008-1053`), which preserves OSC-8 spans and **discards image refs**. An image is retrievable only while it is on the visible grid.

The renderer wasm is no better as a source: it exposes no image accessor either
(`src/renderer/src/lib/pane-manager/aterm/aterm_wasm.d.ts` has no `image` member) —
it rasterizes straight into pixels.

### 6.3 Two ways to serve an image without aterm-gui

**(A) Structured — hand back the payload.** Add `visible_images() -> Vec<{row, col, cols, rows, format, bytes}>`
to `orca-terminal` over `grid.cell_extra(...).image()` (or over
`cell_frame_into`'s already-gathered `images`), bind it at napi, expose
`terminal.images`. The driver receives the original PNG (or RGBA8 + dimensions
for sixel) and can look at it as an image. This is **the highest-fidelity option**
— it is the exact bytes the program emitted, not a re-render — and it works for
hidden, parked, headless and SSH panes because it lives entirely in the main-process
engine.

**(B) Pictorial — hand back a rendered pane.** Orca already renders panes to pixels
in its own process, both paths:

* CPU: `aterm-wasm` keeps a persistent RGBA framebuffer, exposed as `rgba()` / `rgba_ptr()` (`rust/aterm/crates/aterm-wasm/src/lib.rs:1115`, `:1125`) and blitted to an `OffscreenCanvas` via `putImageData` in production (`src/renderer/src/lib/pane-manager/aterm/aterm-worker-band-present.ts:30-39`).
* GPU: `aterm-gpu-web` presents into a WebGL2 canvas; `gl.readPixels` off it is already exercised (`src/renderer/src/lib/pane-manager/aterm/aterm-gpu-cpu-compare.ts:82-85`).

Either way a `canvas.convertToBlob()` yields a PNG of the pane **including** its
rasterized sixel/Kitty/iTerm2 images. This is the analogue of aterm's `image` verb
and needs no aterm-gui — but it inherits the renderer seam's fatal limitation:
**it only exists for mounted panes.** A background agent has no canvas.

(There is also an OS-level path already shipping — `orca computer get-app-state`
returns a window screenshot, `src/cli/specs/computer.ts:39-43`. It captures the
whole Orca window, needs screen-recording permission, and cannot target a pane.
Useful as a fallback, not as the mechanism.)

### 6.4 Verdict — §5

* **Today:** the engine parses and retains inline images; **no agent-reachable surface exposes them at all.** The honest gap is entirely Orca-side plumbing.
* **Recommended:** build **(A)**. It is engine-native, higher fidelity than a re-render, and works for every pane including headless/parked/SSH. Then optionally (B) for "show me the pane as the human sees it" on mounted panes.
* **Needs aterm-gui:** nothing. `aterm-gui`'s `image` verb is itself a re-render from retained engine input via `cell_frame_into` (`rust/aterm/docs/INTROSPECTION.md:44-56`; `App::render_image` at `rust/aterm/crates/aterm-gui/src/lib.rs:13239`) — the same input Orca has.
* **Caveat to design around:** images vanish from the headless engine once they scroll off. Capture on the visible grid, or accept the loss.

---

## 7. Video — the honest cost

### 7.1 What aterm's `video` actually is

Per INTROSPECTION.md, `video` is *"the one path that taps successive GPU swapchain
destinations"* (`rust/aterm/docs/INTROSPECTION.md:48-51`). It is not a re-render
loop — it copies the post-crown swapchain texture in the present encoder
(`rust/aterm/crates/aterm-gui/src/app_introspect.rs:4270`), writes a PNG sequence
plus an `index.json` carrying a dropped/evicted/decimated ledger
(`INTROSPECTION.md:75-76, 177`), and hangs off `aterm-gui`'s window/present
lifecycle end to end (`app_config.rs:6024-6027`, `:6222-6225`). The verb dispatch
is `crates/aterm-gui/src/control.rs:2257,4718`.

That machinery is bound to a native winit window with a wgpu swapchain. Orca has
neither.

### 7.2 The three options, priced

**Option 1 — link `aterm-gui`.** Rejected. `aterm-gui` owns its own window, event
loop, tab model, config system and control socket; it is the *application*, not a
library. Linking it into an Electron app means two competing window systems and
adopting aterm's config surface wholesale. This is not a build item, it is a
different product.

**Option 2 — a headless `aterm-gui` sidecar process.** Spawn a real aterm instance
per driven pane, hand it the PTY, and drive it with `aterm-ctl`. Then `image`,
`video`, `controls`, `turn`, `cast` all just work — full parity, zero
reimplementation. The cost is architectural, not incidental: two terminal engines
consuming one PTY (or the driven agent moving *out* of Orca's pane model
entirely), a second window server / offscreen surface per pane, and every Orca
invariant that assumes it owns the PTY — parking, snapshots, leases, SSH relay —
needing a second answer. Also note headless `image` in aterm is explicitly a
*semantic-renderer artifact*, not a present capture (`INTROSPECTION.md:53-56`), so
a headless sidecar may not even give true `video` semantics. **Viable, but it is a
product-shape decision, not a feature.**

**Option 3 — renderer-side capture in Orca's own path.** Orca already produces a
frame per pane per present, in two rasterizers whose pixel parity is tested
(§5.3(B)). A capture is: on each present, if a recording is armed for this pane,
push the RGBA band/frame into a bounded ring, and on stop write a PNG sequence with
an honest dropped/decimated ledger. The dirty-band machinery that makes this cheap
already exists (`present_band_count()` / `present_bands_ptr()`,
`aterm-worker-band-present.ts:26-39`), and the GPU path's readback is already
demonstrated (`aterm-gpu-cpu-compare.ts:82-85`).

Its limitation is the seam, not the pixels: **only mounted panes present frames.**
A parked or headless pane produces no frames, so "record the background agent"
would additionally require driving `cell_frame_into` on the headless engine into an
offscreen software rasterizer at a fixed cadence — which is a second, unproven
render path and a real project.

### 7.3 Recommendation

**Do not build video now.** It is the highest cost and the lowest visibility gain
per unit of work of everything in this document: for an agent-driving-agent loop,
a styled grid every settle beats a 30 fps movie, and the temporal information a
driver actually needs is already available and cheaper — the event journal
(`src/main/runtime/terminal-event-journal.ts:1-28`, retention 256 per PTY at `:52`)
plus `terminal.await`'s latched predicates
(`docs/reference/alab-auto-mode-design.md:324-332`) give ordered, resumable
transition facts with explicit gap reporting, which is what "what happened while I
wasn't looking" really means.

If video becomes a requirement (demo capture, human review of an autonomous run),
build **Option 3, mounted panes only, and say so in the artifact**. Reuse the
existing dirty-band export; write aterm's honesty ledger format so the two are
comparable. Budget it as a multi-week item, not a sprint. Explicitly refuse to
promise parked-pane video without the offscreen rasterizer project behind it.

---

## 8. Ranked build order — visibility per unit of work

Ordered by (visibility unlocked) ÷ (work), with dependencies respected.

**1. CLI verbs for what already exists — `search`, `searchContext`, `await`.**
Hours. `terminal.search`, `terminal.searchContext` and `terminal.await` are
implemented and correct but have no `orca terminal` subcommand
(`src/cli/handlers/terminal.ts:62-231`, `src/cli/specs/terminal.ts`), so a driving
AI must hand-speak the runtime socket. Pure surface work, zero risk, immediately
triples what a driver can do.

**2. `terminal.screen` — the styled-grid oracle.** Days. `orca-terminal` gains
`styled_frame()` over `Terminal::render_row_at_screen`
(`render_cells.rs:191`) — modelled directly on `gather_styled_frame`
(`control_query.rs:1917-1957`) — plus cursor, alt-screen, and mode bits, all of
which the engine already answers (`headless.rs:309, 373, 380, 385, 390`). Bind at
napi, add the RPC + CLI verb. **This is the keystone.** Every interaction item
below is blind without it, and it is the single largest jump from "reads a
transcript" to "sees the screen".

**3. Agent transcript reader (`§4 b2`).** Days. Untruncated tool output with no
TUI driving, reusing the vault scanner's existing path discovery
(`src/main/ai-vault/session-scanner-source-discovery.ts:14,41-49`). Solves the
substance of "expanding collapsed portions" without solving the interaction.
Provider-specific by nature — start with Claude Code, then Codex.

**4. Scrollback paging — `scrollbackRowText` / row-range at napi + `terminal.history`.**
Days. The Rust side is done (`headless.rs:214`, `:208`); this is a binding plus a
verb. Lifts the driver from a 2000-line transcript window to the engine's full
retention, with eviction-stable coordinates.

**5. `terminal.key` — encoded keystrokes.** Days, **after (2)**. Bind
`encode_key` / `encode_key_with_mode`
(`rust/aterm/crates/aterm-wasm/src/lib.rs:1365`, `:2203`) so a driver presses
Ctrl+O / Escape / arrows correctly under DECCKM and the Kitty protocol instead of
hand-rolling bytes. This is the (b1) half of §4, and it is what makes the driver
genuinely *interactive* rather than a prompt-poster. Requires the input-lease work
from `alab-auto-mode-design.md:194-211`.

**6. `terminal.images` — structured inline images.** ~1 week. `visible_images()`
over `CellExtra::image()` (`extra.rs:527`) → napi → RPC. Highest-fidelity graphics
answer, works on every pane including headless/parked/SSH. Note the scroll-off
caveat (§5.2.3).

**7. Cold/parked search — the three daemon handlers.** ~1 week. The kernel
(`scrollback_search.rs:271`), the replay adapter
(`parked-scrollback-search.ts:59`) and the client wrappers
(`daemon-session-search.ts:62,221,250`) are all written; `daemon-server.ts` has no
handler. Finishes a half-built feature and extends search to every session the user
has, not just live panes.

**8. Pane PNG capture (mounted panes).** ~1–2 weeks. Canvas readback on either
rasterizer (§5.3(B)). Honest label required: *mounted panes only*.

**9. Video.** Multi-week, Option 3, mounted panes only, or defer indefinitely (§6.3).

**Not on the list, deliberately:** linking `aterm-gui`, and running an `aterm-gui`
sidecar. Both are product-shape decisions rather than features, and — with the sole
exception of `video` — everything the goal asks for is reachable through
`aterm-core`, which Orca already links.

---

## 9. Where the answer is genuinely "no"

Stated plainly, because the owner would rather know:

* **The `+N lines` an agent chose not to print are gone.** No terminal feature
  recovers them. Only driving the agent's own key, or reading the agent's own
  transcript file. Any claim otherwise is wrong.
* **Colour of scrolled-off history is gone** in the headless seam, by a deliberate
  performance decision (`headless.rs:122-127`, `scroll_convert.rs:834-842`).
  Recoverable only by disabling `scrollback_text_only` and paying the flood cost.
* **Inline images vanish on scroll-off** for the same reason. Capture while visible.
* **Cold/parked search does not work today**, despite three-quarters of the
  implementation existing.
* **Nothing renderer-side reaches a background agent.** Pixels, canvas capture,
  `last_command_output`, `row_range_json`, the find bar — every one of them is
  mounted-pane-only. The headless seam is the only universal source, and it is the
  seam with the fewest bindings.
* **True present-destination `video` is aterm-gui's alone.** Orca can produce a
  frame sequence from its own rasterizers, and should describe it as exactly that
  — not as a swapchain tap.
