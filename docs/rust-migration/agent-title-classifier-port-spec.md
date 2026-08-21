# Port specification — the terminal-title agent classifier

Mapped from `HEAD` (bf58bbb93) by five parallel readers: **68 exports and 92 hazards** across five TS modules. The port itself did not happen — subagent capacity was unavailable (three consecutive API 529s) — but the analysis is the expensive half and it is recorded here so the next attempt does not repeat it.

## Why the classifier, and not the predicates

`agent-recognition`'s three predicates are already faithful — 27/27 against both shipped cores, including the cases where JS ASCII-only `\w` and a lookbehind Rust cannot express should have broken the port. They are refused on GRANULARITY: `terminal-title-agent-type.ts` (12 calls) and `agent-title-identity.ts` (10) each answer ONE question — "which agent is this title?" — as a sequential ladder. At 1810.9 ns per crossing against a 28.1 ns body, that is ~21 µs per title event to answer one question, and it locks in a shape a later classifier port would have to unwind.

So the unit of work is the CLASSIFIER: one crossing that owns the predicates.
`config/scripts/agent-recognition-crossing-granularity.mjs` exits non-zero the moment a new dispatch arm appears, which forces the census entry to be re-triaged from `retained` to `crossed`.

## Branch order is the semantics

Every reader flagged this independently and it is the single biggest porting risk: these are ordered ladders where an earlier branch wins. A port with every predicate correct and the branches reordered is still wrong. Two examples from the specs below — `isGeminiTerminalTitle` step 2 is a NEGATIVE early return (`if (isPiAgentTitle(title)) return false`) that must precede the token match, so a Pi title containing the token `gemini` is never Gemini; and `isClaudeAgent`'s C0 guard uses JS string falsiness, which is true for the empty string ONLY — a whitespace-only title is truthy and falls through.

## What already exists in Rust, and what does not

Verified at `HEAD`, not from the working tree:

| Rust module | Size | Status |
| --- | --- | --- |
| `orca-core/src/agent_recognition.rs` | 327 lines, 8 pub fns | the token matcher, a faithful port |
| `orca-core/src/opencode_terminal_title.rs` | 116 lines, 2 pub fns | present |
| `orca-core/src/agent_kind.rs` | 116 lines, 2 pub fns | present |
| `orca-core/src/js_string.rs` | 58 lines, 4 pub fns | includes `trim_js` |

**Not ported, and needed by the ladders** — this is larger than a first read suggests, so it is worth stating plainly: `containsBrailleSpinner`, the four Gemini glyph constants, `CLAUDE_IDLE`, `isPiAgentTitle`, `isLegacyPiCompatibleTitle`, `isPiTerminalTitle`, `isGrokRotatingWorkingTitle`, and all of `src/shared/pi-compatible-synthetic-title.ts` (55 lines, 3 exports), which both ladders call through `getPiCompatibleSyntheticAgentLabel`.

## The idiom traps that apply here

Each of these has shipped a bug in this repo before:

* JS `\s` includes U+FEFF and excludes U+0085; Rust's `char::is_whitespace` is the reverse on exactly those two. Use `trim_js`.
* JS `\w` without `/u` is ASCII-ONLY; Rust `\w` is Unicode. `'héclaude'`, `'日本claude'`, `'мclaude'` are where this shows.
* JS lookbehind `(?<!...)` has NO equivalent in the Rust `regex` crate — the token matcher's boundary guard must be emulated by inspecting the preceding character.
* `.slice(0, n)` counts UTF-16 code units, not chars or bytes.
* `toLowerCase()` is full-Unicode; `eq_ignore_ascii_case` is not. `pi-compatible-synthetic-title` does `match[1].toLowerCase() === 'omp'` and `lower.includes('permission')`.
* `if (value)` is JS truthiness: `Some("")` is truthy in Rust, falsy in JS.

---

## `src/shared/opencode-terminal-title.ts`

> src/shared/opencode-terminal-title.ts (16 lines at HEAD; 1 private regex + 2 exports). Rust twin ALREADY EXISTS at rust/crates/orca-core/src/opencode_terminal_title.rs (declared rust/crates/orca-core/src/lib.rs:53).

SOURCE OF TRUTH: everything above is `git show HEAD:<path>`. Nothing was read from the working tree.

FULL SOURCE AT HEAD (16 lines) — reproduced so no re-read is needed:
```ts
// Why: OpenCode abbreviates native OSC session titles as `OC | <task>` (no
// agent-name token). Optional single-token multiplexer prefix covers SSH/tmux
// frames like `tmux | OC | …`. Case-sensitive `OC` avoids ordinary lowercase
// "oc" lookalikes; require non-whitespace after the marker so bare `OC |` is not
// identity. Used for both display-title preservation and tab-agent identity.
const OPENCODE_NATIVE_TITLE_RE = /^(?:[^|\s]+ \| )?OC\s*\|\s*\S/u

export function isOpenCodeNativeTitle(title: string | null | undefined): boolean {
  return OPENCODE_NATIVE_TITLE_RE.test(title?.trim() ?? '')
}

export function isMeaningfulOpenCodeTerminalTitle(title: string | null | undefined): boolean {
  return isOpenCodeNativeTitle(title)
}
```

BOTTOM LINE ON RUST COVERAGE (asked explicitly):
| Export | Rust core | Location | Dispatched? |
| --- | --- | --- | --- |
| isOpenCodeNativeTitle | YES | rust/crates/orca-core/src/opencode_terminal_title.rs:16 `is_opencode_native_title(Option<&str>) -> bool` | no arm |
| isMeaningfulOpenCodeTerminalTitle | YES | same file:22 `is_meaningful_opencode_terminal_title` (delegates) | no arm; reached indirectly via `"tab-title-resolution"` |
The module is registered at rust/crates/orca-core/src/lib.rs:53. Its only in-Rust consumer is rust/crates/orca-core/src/tab_title_resolution.rs (import at :8, calls at :34 and :69). There is no `opencode-terminal-title` entry in rust/crates/orca-dispatch/src/modules/mod.rs, no napi/wasm export, and no tools/parity/vectors/opencode-terminal-title.json — so it has NO direct parity corpus of its own; it is covered transitively by the tab-title-resolution parity run (tab-title-ladder.ts header: 90,840 fallback answers × 2 shipped artifacts = 181,680 comparisons, 0 divergences, with a corpus that deliberately carries `OC |` marker variants plus U+0085, U+FEFF, U+3000, astral and combining text; swapping JS `.trim()` for a `char::is_whitespace` trim reddens 2,364 of them — i.e. the H1/H2 hazards above are empirically load-bearing, not theoretical).

WHAT IS NOT PORTED: the classification ladders that CALL these predicates. `getAgentLabel` and `isClaudeAgent` (duplicated in src/shared/terminal-title-agent-type.ts and src/shared/agent-title-identity.ts) have no Rust twin — `git grep -n "get_agent_label\|is_claude_agent" HEAD -- rust/crates` is empty. rust/crates/orca-dispatch/src/modules/agent_recognition.rs dispatches only titleHasAgentName / titleHasAnyLegacyAgentName / isExpectedAgentProcess. So if the goal is porting the ladder, the OpenCode predicate is already done and the ladder around it is the actual work — and rungs 2 vs 13 of `getAgentLabel` (both returning 'OpenCode' from different predicates at opposite ends) is where a reordering port silently breaks.

CONFORMANCE CORPUS a port must pass (TS test file src/shared/opencode-terminal-title.test.ts, plus the twin's extra corners — all TRUE/FALSE values verified against the pattern):
TRUE: "OC | Native Stable Session", "  OC|Session  ", "OC | Understand about the plugin", "tmux | OC | ses_123", "OC|x", "OC \t | \t x", "OC  |  x", "tmux | OC|x", "⠋x | OC | y", "日本 | OC | x", "OC\u{3000}| x", "\u{FEFF}OC | x".
FALSE: "OpenCode", "OpenCode ready", "OC |", undefined/None, "oc | Understand about the plugin", "⠋ Fix foo | OC | bar", "my session | OC | task", "tmux\t| OC | x", "tmux  |  OC | x", " | OC | x", "a | b | OC | x", "日本|OC | x", "run OC | x", "oc | x", "", "   ", "\u{85}OC | x", "OC\u{85}| x", "OC |   ".
The last four are the discriminating ones: any port whose whitespace predicate is `char::is_whitespace` or whose trim is `str::trim` fails "\u{FEFF}OC | x" (expects TRUE), "\u{85}OC | x" (expects FALSE) and "OC\u{85}| x" (expects FALSE).

### Exports (4)

#### `OPENCODE_NATIVE_TITLE_RE (module-private const, not exported — but it IS the entire semantics)`

```ts
const OPENCODE_NATIVE_TITLE_RE: RegExp = /^(?:[^|\s]+ \| )?OC\s*\|\s*\S/u
```

Flags: `u` ONLY. No `i` (case-sensitive), no `m` (so `^` is STRING start, never line start), no `g`/`y` (so `.test()` is stateless — lastIndex is never consulted or mutated; a port that compiles a global regex once and reuses it would alternate results).

BRANCH ORDER inside the pattern, left to right — this order IS the semantics:
1. `^` — the match must begin at index 0 of the ALREADY-TRIMMED input. There is no `$`, so arbitrary trailing text is allowed after the first `\S`.
2. `(?:[^|\s]+ \| )?` — OPTIONAL single multiplexer frame (SSH/tmux, e.g. `tmux | OC | ses_123`). `?` is greedy, so the ECMAScript engine attempts the WITH-PREFIX arm FIRST and falls back to the WITHOUT-PREFIX arm. Because the caller only ever consumes the boolean from `.test()`, the two arms are an OR and a port may evaluate them in either order (the Rust twin does no-prefix first) — but ONLY because the result is boolean, not because the order is free.
   2a. `[^|\s]+` — one or more chars that are neither `|` nor an ECMAScript-`\s` char. Greedy. Requires AT LEAST ONE char, so a trimmed value beginning with `|` kills this arm.
   2b. Literal `" | "` — SPACE, PIPE, SPACE. This is NOT `\s*\|\s*`. `tmux\t| OC | x` is FALSE. `tmux  |  OC | x` is FALSE.
   2c. Exactly ONE frame. There is no `*`/`+` on the group. `a | b | OC | x` is FALSE.
3. `OC` — literal, CASE-SENSITIVE. `oc | x` is FALSE. Deliberate: avoids lowercase `oc` cwd/task lookalikes (source comment).
4. `\s*` — zero or more ECMAScript whitespace between the marker and the pipe. Multi-char and optional on this side.
5. `\|` — exactly one literal pipe.
6. `\s*` — zero or more ECMAScript whitespace after the pipe.
7. `\S` — EXACTLY ONE non-whitespace char must exist. This is the "require non-whitespace after the marker so bare `OC |` is not identity" rule from the source comment.

NO BACKTRACKING IS EVER NEEDED (proof, so a hand-rolled matcher is safe): every quantifier is followed by a literal outside its own class. `[^|\s]+` is terminated by `|`, by `\s`, or by end-of-string; giving a char back would require the NEXT char to be a literal space, but the given-back char is by construction not a space. `\s*` is followed by `\|` and by `\S`, both outside `\s`. So the greedy run is always the only candidate.

Unicode literals: `ECMAScript `\s` (== `\S` complement) is exactly: U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR, U+0020 SP, U+00A0 NBSP, U+1680 OGHAM SPACE, U+2000..U+200A, U+2028 LS, U+2029 PS, U+202F NNBSP, U+205F MMSP, U+3000 IDEOGRAPHIC SPACE, U+FEFF ZWNBSP/BOM`, `U+FEFF — in JS `\s` and in the JS trim set; NOT in Unicode White_Space, so Rust `char::is_whitespace` MISSES it`, `U+0085 NEL — NOT in JS `\s` and NOT in the JS trim set; IS Unicode White_Space, so Rust `char::is_whitespace` WRONGLY includes it`, `U+3000 — in both, must be skipped by `\s*` (`OC\u{3000}| x` is TRUE)`, `U+280B ⠋ braille spinner — appears in the reject corpus (`⠋ Fix foo | OC | bar` is FALSE) because the prefix separator is not whitespace-flexible`

#### `isOpenCodeNativeTitle`

```ts
export function isOpenCodeNativeTitle(title: string | null | undefined): boolean
// Rust twin: pub fn is_opencode_native_title(title: Option<&str>) -> bool
```

Body, verbatim: `return OPENCODE_NATIVE_TITLE_RE.test(title?.trim() ?? '')`.

Evaluation order:
1. `title?.trim()` — optional chaining. If `title` is `null` OR `undefined`, the whole expression short-circuits to `undefined` WITHOUT calling `.trim()`.
2. `?? ''` — nullish coalescing turns that `undefined` into `''`. Note `??`, not `||`: irrelevant here since the only non-string producible is `undefined`, but a port must not substitute a truthiness fallback in a refactor.
3. `.test(...)` on the trimmed string. Trim happens BEFORE anchoring, so `"  OC|Session  "` is TRUE.

`.trim()` is `String.prototype.trim`: it removes WhiteSpace + LineTerminator from BOTH ends — a set that is byte-for-byte identical to ECMAScript `\s`. Consequence a port must exploit: after trim, the string can neither begin nor end with a `\s` char, so the `\S` at step 7 of the pattern degenerates to "there is at least one character after the pipe" (`"OC |   "` trims to `"OC |"` → FALSE).

Total, pure, no I/O, no allocation required, no state.

RUST STATUS: ALREADY IMPLEMENTED. rust/crates/orca-core/src/opencode_terminal_title.rs:16. Zero-dep hand-rolled matcher (no regex crate), structured as:
  trim_js(title.unwrap_or("")) → starts_with_oc_marker(trimmed) || strip_multiplexer_prefix(trimmed).is_some_and(starts_with_oc_marker)
where `starts_with_oc_marker` = strip_prefix("OC") → trim_start_matches(is_js_trim_ws) → strip_prefix('|') → trim_start_matches(is_js_trim_ws) → !is_empty(); and `strip_multiplexer_prefix` = value.find(|c| c=='|' || is_js_trim_ws(c)) → reject token_len==0 → value.get(token_len..)?.strip_prefix(" | "). It uses crate::js_string::{is_js_trim_ws, trim_js} rather than `char::is_whitespace`/`str::trim`, which is the whole reason it is correct. 3 unit tests inside the file (two verbatim from the TS test, one 20-assertion corner suite covering U+FEFF/U+0085/U+3000/multibyte prefixes/one-frame-only).
NOT exposed on any binding: there is no `opencode-terminal-title` arm in rust/crates/orca-dispatch/src/modules/mod.rs (the registry has only `agent-tab-title` and `tab-title-resolution` in this neighbourhood), no napi/wasm export, and no tools/parity/vectors/opencode-terminal-title.json. Its only Rust caller is orca_core::tab_title_resolution (lines 34 and 69), which IS dispatched as `"tab-title-resolution"`.

Unicode literals: `U+FEFF and U+0085 govern both the trim and the `\s*` runs; they are the only two codepoints on which a naive Rust port diverges`

#### `isMeaningfulOpenCodeTerminalTitle`

```ts
export function isMeaningfulOpenCodeTerminalTitle(title: string | null | undefined): boolean
// Rust twin: pub fn is_meaningful_opencode_terminal_title(title: Option<&str>) -> bool
```

Body, verbatim: `return isOpenCodeNativeTitle(title)`. An EXACT alias today — same signature, same result on every input, zero added logic. The two names exist because they answer two different questions ("is this OpenCode's identity marker?" vs "is this live title worth showing/keeping?") that currently have the same answer; the source header says the regex is "Used for both display-title preservation and tab-agent identity." Do NOT collapse them in a port: they have disjoint consumer sets and different cut-over constraints (below).

LOAD-BEARING NOTE — REQUESTED, AND IT IS STRUCTURAL, NOT A PREFERENCE:
`isMeaningfulOpenCodeTerminalTitle` is called from INSIDE the pre-ready fallback of a Rust dispatch shim, so the TypeScript implementation is PERMANENTLY UNCUTTABLE even though the Rust port already exists.
 * src/shared/tab-title-ladder.ts is the shim over orca_core::tab_title_resolution. It imports the function at line 67 and calls it at lines 102 and 120, inside `legacyResolveTerminalTabTitle` and `legacyResolveUnifiedTabLabel` — the two `legacy*` bodies documented as "The deleted twin's body, verbatim."
 * Its header (lines 26-28 at HEAD) says exactly why: "...over the kept parts types and the TypeScript `isMeaningfulOpenCodeTerminalTitle`, which stays implemented in `opencode-terminal-title.ts` precisely so this fallback has something to call — a fallback that dispatches is not a fallback."
 * Those fallbacks are computed EAGERLY, before every dispatch, bound or unbound (header: "Each fallback is computed EAGERLY, before the dispatch, and that is the whole bound-vs-unbound story for this module"), partly so the twin's TypeError on a non-string field is thrown before anything crosses the seam.
 * The seam is UNBOUND for the renderer's entire boot window, and PERMANENTLY unbound on the web preload and on mobile, neither of which ever installs a binding.
 * docs/rust-migration/ported-modules.md (~line 659) names `opencode-terminal-title::isMeaningfulOpenCodeTerminalTitle` in the enumerated set of "41 exports [that] are called from inside a pre-ready fallback and cannot cross" (reproducible via `pnpm exec node config/scripts/list-fallback-load-bearing-exports.mjs`).
Practical instruction for a porter: adding/keeping the Rust function is correct, DELETING the TS one is a regression, and routing the TS one through the dispatch seam is the specific mistake the header forbids.

RUST STATUS: ALREADY IMPLEMENTED. rust/crates/orca-core/src/opencode_terminal_title.rs:22-24, `is_meaningful_opencode_terminal_title(title) { is_opencode_native_title(title) }` — the alias is preserved as an alias, matching the twin. Same non-exposure as above (core-internal only; consumed by tab_title_resolution.rs:34 and :69).

#### `CONSUMER LADDERS (not exports of this module — recorded because the branch POSITION is the semantics a porter must preserve)`

```ts
n/a — call sites of the two exports, all read from HEAD
```

A. src/shared/agent-detection.ts:21 — pure barrel re-export of BOTH names. No logic.

B. src/shared/tab-title-ladder.ts:102 / :120 — rung 3 of a 7-rung `||` chain, in BOTH `legacyResolveTerminalTabTitle` and `legacyResolveUnifiedTabLabel`. Exact order:
   liveTitle = tab.title?.trim() ?? ''  (computed FIRST, used at rungs 3 and 6)
   1 tab.customTitle?.trim()
   2 tab.quickCommandLabel?.trim()
   3 (isMeaningfulOpenCodeTerminalTitle(liveTitle) ? liveTitle : '')
   4 tab.aiVaultTitle?.title.trim()      ← NOTE: no optional chain on `.title`
   5 (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '')
   6 liveTitle
   7 fallback
   Every rung is JS `||`, i.e. blank-string falsiness, not `is_some`. Rung 3 is what makes a native `OC | …` live title OUTRANK the AI-Vault name and the generated name; move it below rung 4 and 4,012 corpus cases go red (header, measured). The Rust equivalent orca_core::tab_title_resolution::resolve_terminal_tab_title / resolve_unified_tab_label reproduces this exact order with `.or_else` over `first_nonblank`, and puts the OC test at the same rung 3.

C. src/shared/agent-row-conversation-name.ts:127 — rung 3 of `getAgentRowConversationName`, an early-return ladder (NOT `||`):
   1 customTitle?.trim() → return it
   2 quickCommandLabel?.trim() → return it
   3 liveTitle = tab.title?.trim() ?? ''; if (isMeaningfulOpenCodeTerminalTitle(liveTitle)) return liveTitle
   4 generatedTitle (gated on generatedTitlesEnabled) → return it
   5 if (!liveTitle) return null
   6 return conversationNameFromLiveTitle(liveTitle, agentType, formatAgentTypeLabel(agentType).toLowerCase(), tab.defaultTitle)
   Note the vault rung is ABSENT here — this ladder is NOT the same as B.

D. `isClaudeAgent` — duplicated verbatim in src/shared/terminal-title-agent-type.ts:84 and src/shared/agent-title-identity.ts:21. `isOpenCodeNativeTitle` is the THIRD disjunct of a single early-REJECT guard, and all three run before any Claude test:
   if (!title || isClaudeManagementTitle(title) || isOpenCodeNativeTitle(title)) return false
   `!title` is JS falsiness on a `string`-typed param (empty string only, in practice). Then: CLAUDE_IDLE-prefix → `. `/`* ` prefix → containsBrailleSpinner (returns `!isCursorAgentTitle(title) && !lower.includes('openclaude')`, where `lower = title.toLowerCase()`) → trimStart()+lowercase startsWith('claude') && titleHasAgentName(trimmedTitle,'claude') → false.

E. `getAgentLabel` — duplicated verbatim in src/shared/terminal-title-agent-type.ts:130 and src/shared/agent-title-identity.ts:52. `isOpenCodeNativeTitle` is RUNG 2 of a ~17-rung classification ladder and returns 'OpenCode'. Full order:
   1 isClaudeManagementTitle → null
   2 isOpenCodeNativeTitle → 'OpenCode'                    ← this module
   3 CLAUDE_IDLE prefix / === CLAUDE_IDLE / '. ' / '* ' → 'Claude Code'
   4 isGeminiTerminalTitle → 'Gemini CLI'
   5 getPiCompatibleSyntheticAgentLabel(title) (truthy) → that label
   6 isPiAgentTitle → 'Pi'
   7 titleHasAgentName(title,'codex') → 'Codex'
   8 titleHasAgentName(title,'openclaude') → 'OpenClaude'
   9 titleHasAgentName(title,'copilot') → 'GitHub Copilot'
  10 titleHasAgentName(title,'grok') → 'Grok'
  11 titleHasAgentName(title,'devin') → 'Devin'
  12 titleHasAgentName(title,'antigravity') || AGY_AGENT_NAME_RE.test(title) → 'Antigravity'
  13 titleHasAgentName(title,'opencode') → 'OpenCode'       ← SECOND, DIFFERENT OpenCode rung
  14 titleHasAgentName(title,'mimo') → 'MiMo Code'
  15 titleHasAgentName(title,'aider') → 'Aider'
  16 isCursorAgentTitle → 'Cursor'
  17 DROID_AGENT_NAME_RE.test → 'Droid'
  18 HERMES_AGENT_NAME_RE.test → 'Hermes'
  19 isClaudeAgent → 'Claude Code'
  20 null
   THE TRAP: rungs 2 and 13 both return 'OpenCode' but are different predicates at opposite ends of the ladder. Rung 2 (native `OC |` marker) beats codex/grok/copilot/etc.; rung 13 (token match on the word "opencode") loses to all of them. A port that merges or reorders them changes the label for e.g. `OC | fix the codex bug` (rung 2 → 'OpenCode') vs `codex in opencode dir` (rung 7 → 'Codex').
   The two files differ ONLY in comment text and in terminal-title-agent-type.ts carrying an extra AGENT_TYPE map (`OpenCode: 'opencode'` at :224); the predicate sequence is identical.

RUST STATUS for D and E: NOT IMPLEMENTED. rust/crates/orca-core/src/agent_recognition.rs has title_has_agent_name (:96), title_has_any_legacy_agent_name, title_has_droid/hermes/agy, normalize_process_name, is_expected_agent_process — but there is NO `get_agent_label` and NO `is_claude_agent` anywhere under rust/crates (`git grep -n "get_agent_label\|is_claude_agent" HEAD -- rust/crates` returns nothing). rust/crates/orca-dispatch/src/modules/agent_recognition.rs dispatches exactly three functions — "titleHasAgentName", "titleHasAnyLegacyAgentName", "isExpectedAgentProcess" — and has no OpenCode-title arm. So the classification ladders themselves are still TS-only; only their leaf predicates are ported.

### Hazards (15)

| Where | JS semantic | Rust trap | Example |
| --- | --- | --- | --- |
| `\s` inside the pattern (both `\s*` runs) and `\S` | ECMAScript `\s` = {U+0009-U+000D, U+0020, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF}. U+FEFF is IN; U+0085 is OUT. | `char::is_whitespace` (Unicode White_Space) is the mirror image on exactly these two: it EXCLUDES U+FEFF and INCLUDES U+0085. Use a bespoke predicate — the repo already has one: `orca_core::js_string::is_js_trim_ws`, defined as `c == '\u{FEFF}' \|\| (c != '\u{0085}' && c.is_whitespace())`. | "OC\u{FEFF}\| x" → JS TRUE (FEFF is \s, skipped), naive Rust FALSE. "OC\u{85}\| x" → JS FALSE (NEL is not \s, so `\\|` sees NEL), naive Rust TRUE. |
| `title?.trim()` | `String.prototype.trim` removes WhiteSpace + LineTerminator — the same set as `\s`, so U+FEFF IS stripped and U+0085 is NOT. | `str::trim()` uses `char::is_whitespace` and diverges on the same two codepoints. Use `orca_core::js_string::trim_js` (`value.trim_matches(is_js_trim_ws)`). | "\u{FEFF}OC \| x" → JS TRUE (BOM trimmed, then `^OC`), `str::trim` port FALSE. "\u{85}OC \| x" → JS FALSE (NEL survives the trim and blocks `^`), `str::trim` port TRUE. |
| The optional prefix separator `[^\|\s]+ \\| ` — the literal " \| " | SPACE PIPE SPACE, exactly. Not `\s*\\|\s*`, not "any whitespace run", not tab-tolerant. | The obvious port reuses the same skip-whitespace-then-pipe helper it wrote for the `OC\s*\\|\s*` half, making the prefix separator whitespace-flexible. That silently ACCEPTS titles JS rejects. | "tmux\t\| OC \| x" → FALSE. "tmux  \|  OC \| x" → FALSE. But "tmux \| OC\|x" → TRUE (the flexible run is only AFTER the marker). |
| The `?` on `(?:[^\|\s]+ \\| )?` — cardinality | ZERO OR ONE multiplexer frame. There is no repetition operator. | Porting it as a loop ("strip any number of `tok \| ` frames") accepts nested frames JS rejects, and lets a mid-title `OC` steal another agent's braille/task frame — the exact regression the TS test guards. | "a \| b \| OC \| x" → FALSE. "my session \| OC \| task" → FALSE (token contains a space, so `[^\|\s]+` cannot span it). "⠋ Fix foo \| OC \| bar" → FALSE. |
| `[^\|\s]+` — the `+` | Requires at least one char that is neither `\|` nor `\s`. After trim the value cannot start with `\s`, so the only way to hit zero is a leading `\|`. | `str::find(...)` returning `Some(0)` must be rejected. The Rust twin does this explicitly (`if token_len == 0 { return None }`); a port using `split_once(" \| ")` instead of find-then-strip would wrongly accept. | " \| OC \| x" trims to "\| OC \| x" → FALSE. (A `split_once(" \| ")` port yields token "\|"… no — it yields "" then "OC \| x" and answers TRUE.) |
| The `OC` literal — no `i` flag | Case-sensitive. Deliberate, per the source comment: "Case-sensitive `OC` avoids ordinary lowercase 'oc' lookalikes." | Reflexively calling `.to_lowercase()`/`eq_ignore_ascii_case` (as neighbouring agent-title code legitimately does) flips lowercase cwd/task noise into OpenCode identity, which then wins rung 2 of `getAgentLabel` over Codex/Grok/Copilot. | "oc \| Understand about the plugin" → FALSE. |
| `\S` after `\s*` after the pipe | Exactly one non-whitespace char must FOLLOW the pipe. Combined with the pre-trim, a pipe at the end of the meaningful content always fails. | A port that only checks "a pipe exists after OC" (or checks `!after_pipe.is_empty()` WITHOUT re-skipping whitespace) accepts bare markers. Must be `!after_pipe.trim_start_matches(is_js_trim_ws).is_empty()`. | "OC \|" → FALSE. "OC \|   " → FALSE (trims to "OC \|"). "OC" → FALSE. "OC \| x" → TRUE. |
| `^` with no `m` flag, and the absence of `$` | `^` is start-of-STRING (a `m` flag would make it start-of-line, and titles can contain LF since `\n` is in the trim set only at the ends). No `$`, so unlimited trailing content is fine. | Porting as `contains`/`is_match` over a multi-line title, or as a regex with an accidental `(?m)`, matches an embedded marker on line 2. Conversely, adding an end anchor breaks every real title, which is `OC \| <task text>`. | "run OC \| x" → FALSE. "other\nOC \| x" → FALSE (LF is interior, `^` is string-start). "OC \| a very long task description" → TRUE. |
| `title?.trim() ?? ''` — the Option handling | `null` and `undefined` collapse to the SAME empty-string input; `''` also produces `''`. All three are FALSE. | `is_some()` is NOT the presence test — `Some("")`, `Some("   ")` and `None` are indistinguishable in the result. Map to `trim_js(title.unwrap_or(""))`, not to an `Option` short-circuit that treats `Some` as meaningful. | None → false; Some("") → false; Some("   ") → false; Some("\u{FEFF}") → false (BOM is blank under JS trim). |
| Runtime type of `title` at the call boundary | Typed `string \| null \| undefined`, but at runtime a number/object reaches `.trim` and throws `TypeError: title.trim is not a function`. That throw is DEPENDED ON: tab-title-ladder.ts computes its legacy fallback eagerly so the twin's TypeError fires before anything crosses the dispatch seam (titles arrive from PTY OSC 0/2, persisted layout JSON, and the SSH/relay wire, so non-strings are reachable). | `Option<&str>` cannot represent "present but not a string". A Rust adapter reading the field with `Value::as_str` sees a non-string as ABSENT and answers the next ladder candidate instead of throwing — a silent behaviour change. Any dispatch arm must reject non-string titles explicitly rather than defaulting them. | isOpenCodeNativeTitle(42 as unknown as string) → throws TypeError in JS; a `Value::as_str().unwrap_or("")` port returns false. |
| Index arithmetic in the hand-rolled `[^\|\s]+` scan | JS matches by code unit but the class here is defined by character identity, so any multi-byte token is one greedy run. | A byte-loop that assumes ASCII, or slicing at a computed byte offset without a char-boundary guarantee, panics or mis-splits. Use `str::find(\|c: char\| …)` (returns a char-boundary byte index) and `str::get(idx..)`, as the twin does. | "日本 \| OC \| x" → TRUE (token is 6 bytes, 2 chars). "⠋x \| OC \| y" → TRUE. "日本\|OC \| x" → FALSE (no " \| "). |
| UTF-16 vs scalar values — lone surrogates and astral text | With the `u` flag, `\S` consumes a whole astral code point; a LONE surrogate in a JS string is also non-whitespace and satisfies `\S`. | Rust `&str` cannot hold a lone surrogate, so `"OC \| \uD83D"` (unpaired high surrogate as the only tail) is TRUE in JS and simply unrepresentable in Rust — an unreachable residual, not a choice. Note also that this module never slices, so there is no `slice_utf16` hazard here (unlike neighbouring ports); do not introduce one by "optimising" with byte offsets into the title. | "OC \| 😀" → TRUE in both. "OC \| \uD83D" (lone high surrogate) → TRUE in JS, unrepresentable in Rust. |
| Regex object lifetime / flags | The regex is a module-level const with NO `g` and NO `y`, so `.test()` never reads or writes `lastIndex` — it is pure and reentrant. | Not a Rust trap per se, but a re-implementation trap: adding `g` while "modernising" makes the shared const stateful and makes alternate calls with the same input disagree. Equally, a Rust port using a regex crate must keep the pattern anchored and must not enable case-insensitivity or multi-line. The shipped twin sidesteps all of it by matching by hand (orca-core is zero-dep). | with `g`: isOpenCodeNativeTitle("OC \| x") → true, then false, then true. |
| `isMeaningfulOpenCodeTerminalTitle` being an exact alias | Two exported names, one behaviour. They are NOT interchangeable at the architecture level: the `Meaningful` name is enumerated in docs/rust-migration/ported-modules.md as one of the 41 fallback-load-bearing exports that CANNOT cross the dispatch seam. | "Dedupe" pressure — deleting the alias in TS, or routing it through the seam once Rust has the port — breaks the tab-title-ladder pre-ready fallback on the renderer boot window and PERMANENTLY on the web preload and on mobile, which never install a binding. Keep both names in both languages; the Rust twin already does (opencode_terminal_title.rs:22). | n/a — architectural. Reproduce with `pnpm exec node config/scripts/list-fallback-load-bearing-exports.mjs`. |
| Greedy-quantifier backtracking | The engine may backtrack in principle, but here it provably never needs to: each quantifier is followed by a literal outside its own class. | Not a correctness trap but a design one — a port that enumerates split points for `[^\|\s]+` is doing wasted work, and one that BREAKS at the first candidate without the proof might convince itself it needs a retry loop and introduce an off-by-one. Single greedy pass is exact. | "abc \| OC \| x": the run "abc" is the only candidate, because giving back "c" would require the next char to be a space and it is "c". |

---

## `src/shared/agent-name-token-match.ts`

> src/shared/agent-name-token-match.ts — whole-token matching of agent names inside OSC terminal titles. Read at HEAD (commit bf58bbb93). 7 exports + 3 module-private constants. Pure, synchronous, no I/O, no config, no dependencies (zero imports). Rust twin ALREADY EXISTS at rust/crates/orca-core/src/agent_recognition.rs and is a faithful port; parity dispatch at rust/crates/orca-dispatch/src/modules/agent_recognition.rs, TS side of the harness at tools/parity/dispatch/agent-recognition.ts, 20 vectors at tools/parity/vectors/agent-recognition.json.

RUST-CORE COVERAGE (checked at HEAD; `git grep -n <name> HEAD -- rust/crates` + rust/crates/orca-core/src/agent_recognition.rs)

The Rust twin ALREADY EXISTS and is faithful. Module: rust/crates/orca-core/src/agent_recognition.rs, registered at rust/crates/orca-core/src/lib.rs:27 (`pub mod agent_recognition;`).

| TS export | Rust equivalent | Status |
|---|---|---|
| AGENT_NAMES | `pub const AGENT_NAMES: &[&str]` (line 15) | IMPLEMENTED — same 13 entries, same order, verbatim |
| buildAgentNameRe | `pub fn title_has_token(title, name, allow_exe_suffix) -> bool` (line ~40) | PARTIAL by design — the *matching* is implemented; the *RegExp object* is not (and should not be). No Rust caller mirrors groups.ts yet |
| titleHasAgentName | `pub fn title_has_agent_name(title, name)` (line 96) | IMPLEMENTED — roster gate then `title_has_token(.., true)` |
| titleHasAnyLegacyAgentName | `pub fn title_has_any_legacy_agent_name(title)` (line 104) | IMPLEMENTED — `AGENT_NAMES.iter().any(|n| title_has_token(title, n, true))` |
| DROID_AGENT_NAME_RE | `pub fn title_has_droid(title)` | IMPLEMENTED as a predicate (`allow_exe_suffix = false`) |
| HERMES_AGENT_NAME_RE | `pub fn title_has_hermes(title)` | IMPLEMENTED as a predicate |
| AGY_AGENT_NAME_RE | `pub fn title_has_agy(title)` | IMPLEMENTED as a predicate |

The Rust file also carries `normalize_process_name` and `is_expected_agent_process`, which are ports of the sibling `src/shared/agent-process-recognition.ts` (NOT of this module) and depend on `crate::js_string::trim_js` — the JS `.trim()` whitespace set differs from Rust's `str::trim` on U+FEFF (JS strips, Rust does not) and U+0085 (Rust strips, JS does not). Out of scope here but adjacent in the same file.

Notable: orca-core's `title_has_token` is written in a verifier-friendly style — every index goes through `.get()`, `checked_sub`, `saturating_add`, and the comment explicitly says `windows()` was avoided because its non-zero-width precondition produced a division-by-zero refutation from the Trust verifier. If you re-derive the function, keep that style; the file also carries a committed differential test (`get_based_token_scan_agrees_with_the_index_based_scan`) that pins the `.get()`-based scan against the original index-based body over 23 titles x 7 names x 2 suffix modes, with a `saw_true && saw_false` discrimination assert.

WIRING STATUS — the Rust is NOT yet in the production path. `git grep` over all of rust/crates finds `agent_recognition` referenced only by orca-core/src/lib.rs, orca-dispatch/src/modules/mod.rs (line 14 `pub mod`, line 103 `"agent-recognition" => Some(agent_recognition::dispatch(...))`), and the dispatch module itself. There is NO napi export, so every shipped call still goes through the TypeScript. The Rust exists purely to be differentially tested against the TS.

PARITY HARNESS
- TS side:  tools/parity/dispatch/agent-recognition.ts (switch over 'titleHasAgentName' | 'titleHasAnyLegacyAgentName' | 'isExpectedAgentProcess')
- Rust side: rust/crates/orca-dispatch/src/modules/agent_recognition.rs (same three)
- Vectors:  tools/parity/vectors/agent-recognition.json — 20 cases; header declares `"source": "src/shared/agent-name-token-match.ts (+ agent-process-recognition.ts)"`, `"rustCrate": "orca-core::agent_recognition"`.

COVERAGE GAP worth closing if you extend the port: the dispatch exposes only 3 functions. `buildAgentNameRe` (the exe-suffix-allowing arbitrary-name path used by orchestration groups) and the three droid/hermes/agy predicates have Rust implementations and Rust unit tests but NO parity vectors — they are the least-protected surface, and they are exactly where the two-droid-matchers divergence lives.

PORT SHAPE RECOMMENDATION
One primitive, three wrappers, no regex engine:

  fn is_boundary_char(c: char) -> bool { c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '\\' | '-') }
  fn title_has_token(title: &str, name: &str, allow_exe_suffix: bool) -> bool

with ASCII-only case folding, `.get()`-based indexing, left guard via `checked_sub(1)`, right guard via `!…get(end).is_some_and(is_boundary_char)`, suffixes `[".exe", ".cmd", ".bat", ".ps1"]` in that order with no backtracking. Then gate `title_has_agent_name` on exact-case AGENT_NAMES membership, build `title_has_any_legacy_agent_name` from `any()` over AGENT_NAMES in order, and build droid/hermes/agy with `allow_exe_suffix = false`. Do not introduce the `regex` crate: the lookbehind will not compile, and if you route around it with `\b` or `(?i)` you inherit two separate over-matching bugs (hazards 1 and 3).

WHY THIS MODULE EXISTS (from the file header, worth preserving in the Rust doc comment): substring matching mis-fired on worktree/cwd titles like 'opencode-blinker' (⊃ 'opencode') and 'openclaude' (⊃ 'claude'), painting a Codex/OpenClaude tab as the wrong agent whenever the title fell back to the bare directory name. The roster is intentionally narrow — 'amp' would classify 'timestamp ready' as agent activity — and the header notes product telemetry uses explicit launch/session facts Orca owns, not this inference path.

The module contains no Unicode escape literals and no non-ASCII characters at all; every Unicode concern in the hazards list arises from the INPUT side (titles), not from the source.

Read-only session: nothing in /Users/ayates/orca-alab was modified, staged, or built. All reads were `git show HEAD:` / `git grep … HEAD`.

### Exports (7)

#### `AGENT_NAMES`

```ts
export const AGENT_NAMES: string[]  // NOT `as const`, NOT readonly — plain mutable string[]
```

Exact table, in exact source order (order is load-bearing for the alternation regex built from it, and for any port that reports WHICH name matched):

  0  'claude'
  1  'openclaude'
  2  'codex'
  3  'copilot'
  4  'cursor'
  5  'gemini'
  6  'antigravity'
  7  'opencode'
  8  'mimo'
  9  'openclaw'
 10  'aider'
 11  'grok'
 12  'devin'

13 entries. All lowercase ASCII letters only — no digits, no hyphens, no regex metacharacters. Source comment states the roster is INTENTIONALLY NARROWER than the full launchable-agent set: short names like 'amp' would classify ordinary shell titles ('timestamp ready') as agent activity. Note 'droid', 'hermes', 'agy', 'pi', 'cursor-agent' are deliberately NOT in this table — droid/hermes/agy have their own exported regexes below; cursor-agent/pi live in a separate regex in src/renderer/src/components/terminal-pane/title-agent-identity.ts.

Also note 'claude' is a strict substring of 'openclaude', and 'openc' prefixes 'opencode'/'openclaude'/'openclaw' — this collision set is the whole reason the module exists.

Re-exported (only) by src/shared/agent-detection.ts line 31; never iterated anywhere else in src/.

#### `buildAgentNameRe`

```ts
export function buildAgentNameRe(name: string): RegExp
```

Constructs and returns a NEW RegExp each call (no caching):

  new RegExp(`(?<![\\w./\\\\-])${name}(?:${WINDOWS_EXECUTABLE_SUFFIX_RE})?(?![\\w./\\\\-])`, 'i')

After template-literal escape processing the ACTUAL pattern string is:

  (?<![\w./\\-])<name>(?:(?:\.(?:exe|cmd|bat|ps1)))?(?![\w./\\-])

Flags: 'i' only. NO 'u'. NO 'g'. NO 'm'/'s'/'y'/'d'.

Character class `[\w./\\-]` decodes to exactly five things: \w (ASCII-only, see hazards), literal '.', literal '/', literal '\' (single backslash — `\\` inside a class is an escaped backslash), literal '-' (trailing hyphen before ']' is literal, NOT a range). So the boundary-char set is precisely [A-Za-z0-9_./\\-].

The suffix fragment is module-private:
  const WINDOWS_EXECUTABLE_SUFFIX_RE = String.raw`(?:\.(?:exe|cmd|bat|ps1))`
(String.raw, so backslash is literal). buildAgentNameRe wraps it AGAIN: `(?:${...})?` yields the doubly-nested `(?:(?:\.(?:exe|cmd|bat|ps1)))?` — semantically identical to a single group, but transcribe it as written if you diff patterns.

BRANCH ORDER inside the regex engine (this IS the semantics):
  1. Scan start positions left-to-right, 0..=len (leftmost-first). Position units are UTF-16 code units.
  2. At each position: negative lookbehind — fail immediately if the PRECEDING code unit is in [A-Za-z0-9_./\\-]. Position 0 has no preceding unit, so the lookbehind PASSES at start-of-string.
  3. Match `name` case-insensitively (ECMAScript Canonicalize; see hazards).
  4. Optional suffix group is GREEDY: try WITH `.exe|.cmd|.bat|.ps1` first (alternatives tried in that listed order; they are mutually exclusive since all four differ in their first letter), then WITHOUT.
  5. Negative lookahead — fail if the NEXT code unit is in [A-Za-z0-9_./\\-]. End-of-string PASSES.
  6. On failure, backtrack step 4 (drop the suffix) and retry step 5; on failure again, advance the start position.

BACKTRACKING IS PROVABLY REDUNDANT — do not 'fix' a port that omits it: every suffix begins with '.', and '.' is itself in the boundary class, so whenever step 4's greedy branch succeeded, the no-suffix retry of step 5 must fail on that same '.'. A port may commit to the first matching suffix with no backtracking (orca-core does exactly this).

CONTRACT LEAK: `name` is interpolated RAW into the pattern — never escaped. The export's real contract is 'a regex fragment', not 'a literal'. Callers today only pass plain lowercase ASCII words, so it behaves as a literal in production.

Only production caller: src/main/runtime/orchestration/groups.ts:45, `buildAgentNameRe(agentName).test(title)`, where agentName ranges over AGENT_NAME_GROUPS = ['claude','openclaude','codex','opencode','mimo','gemini','droid','grok','cursor'] — note 'droid' is in that list but NOT in AGENT_NAMES, and 'cursor' is short-circuited earlier by GROUP_TITLE_MATCHERS.cursor = isCursorAgentTitle. Result is consumed via .test() only — never .exec/.match/.replace/.source.

#### `titleHasAgentName`

```ts
export function titleHasAgentName(title: string, name: string): boolean
```

Body is exactly one expression:

  return AGENT_NAME_RE_BY_NAME.get(name)?.test(title) ?? false

where the module-private map is

  const AGENT_NAME_RE_BY_NAME = new Map(AGENT_NAMES.map((name) => [name, buildAgentNameRe(name)]))

i.e. 13 pre-compiled regexes, one per AGENT_NAMES entry, keyed by the exact name string.

BRANCH ORDER:
  1. Map lookup on `name` — EXACT, CASE-SENSITIVE, identity-of-string key. 'Claude' / 'CLAUDE' / ' claude' all MISS.
  2. Miss  -> `?.` yields undefined -> `?? false` -> return false. The membership gate fires BEFORE any title inspection; the title is never even read.
  3. Hit   -> return regex.test(title) with the semantics of buildAgentNameRe above (case-insensitive on the TITLE side, exe-suffix ALLOWED).

So the function is asymmetric: the NAME argument is matched case-sensitively against the roster, the TITLE is matched case-insensitively. Both facts must survive a port.

`?? false` (nullish coalescing) rather than `|| false` — irrelevant here because .test() returns a boolean, but if a port models the map value as Option<bool>, only None maps to false.

Example truth table (from the committed parity vectors + Rust tests):
  ('openclaude','claude')          -> false   (left boundary 'n' is \w)
  ('opencode-blinker','opencode')  -> false   (right boundary '-')
  ('~/opencode/working','opencode')-> false   (both boundaries '/')
  ('claude working','claude')      -> true
  ('running codex now','codex')    -> true
  ('claude.exe ready','claude')    -> true    (suffix consumed, then ' ')
  ('claude','claude')              -> true    (both boundaries are string ends)
  ('notanagent working','notanagent') -> false (not in AGENT_NAMES)
  ('mimo ready','mimo')            -> true
  ('devin working','devin')        -> true

Callers: src/shared/terminal-title-agent-type.ts (lines 49, 112, 162, 165, 168, 171, 174, 177, 180, 183, 186, 248), src/shared/agent-title-identity.ts:93, re-exported by src/shared/agent-title-core.ts:10 and src/shared/agent-detection.ts:31. These callers form their OWN classification ladder whose branch order matters (codex -> openclaude -> copilot -> grok -> devin -> antigravity|agy -> opencode -> mimo -> aider -> droid -> hermes); that ladder is out of scope for this module but a port must not reorder it either.

#### `titleHasAnyLegacyAgentName`

```ts
export function titleHasAnyLegacyAgentName(title: string): boolean
```

Body:

  return ANY_LEGACY_AGENT_NAME_RE.test(title)

where the module-private constant is a SINGLE regex built by joining the 13 per-name patterns with '|':

  const ANY_LEGACY_AGENT_NAME_RE = new RegExp(
    AGENT_NAMES.map((name) => `(?<![\\w./\\\\-])${name}(?:${WINDOWS_EXECUTABLE_SUFFIX_RE})?(?![\\w./\\\\-])`).join('|'),
    'i'
  )

Note it re-inlines the same fragment rather than calling buildAgentNameRe — the fragments are character-identical. Each alternative carries its OWN pair of lookbehind/lookahead guards (the guards are NOT factored out around the alternation).

Resulting pattern (elided in the middle, alternatives in AGENT_NAMES order):
  (?<![\w./\\-])claude(?:(?:\.(?:exe|cmd|bat|ps1)))?(?![\w./\\-])|(?<![\w./\\-])openclaude(?:(?:\.(?:exe|cmd|bat|ps1)))?(?![\w./\\-])|…|(?<![\w./\\-])devin(?:(?:\.(?:exe|cmd|bat|ps1)))?(?![\w./\\-])

Flags 'i' only. No 'u', no 'g' — so `.test()` is stateless (lastIndex is never consulted or written) and the shared module-level RegExp object is safe to reuse and safe to call concurrently.

BRANCH ORDER: position-major, then alternative-major. For start position 0,1,2,…len: try alternative 0 ('claude'), then 1 ('openclaude'), … then 12 ('devin'); first success ends the whole match. Because the return value is only a boolean, this is EXTENSIONALLY equal to `AGENT_NAMES.some(n => buildAgentNameRe(n).test(title))` (name-major), which is what the Rust twin does. The two orders differ ONLY if a port is extended to report which name or at what index — see hazards.

Examples:
  'codex • ~/repo'      -> true
  'mimo • ~/repo'       -> true
  'devin ready'         -> true
  'timestamp ready'     -> false  (this is the reason 'amp' is off the roster)
  'openclaude-blinker'  -> false  ('claude' blocked left by 'n'; 'openclaude' blocked right by '-')
  'openclaude'          -> true   ('claude' alt blocked left, but the 'openclaude' alt matches whole)

Callers: src/shared/terminal-title-display.ts:23, src/shared/terminal-title-status.ts:134, src/shared/agent-title-core.ts, src/shared/agent-title-status.ts, src/renderer/src/components/terminal-pane/title-agent-identity.ts:30.

#### `DROID_AGENT_NAME_RE`

```ts
export const DROID_AGENT_NAME_RE: RegExp
```

Regex LITERAL (not new RegExp), written verbatim as:

  export const DROID_AGENT_NAME_RE = /(?<![\w./\\-])droid(?![\w./\\-])/i

Pattern: (?<![\w./\\-])droid(?![\w./\\-])   Flags: 'i'. No 'u', no 'g'.

CRITICAL DIFFERENCE from the AGENT_NAMES matchers: there is NO optional Windows executable suffix. 'droid.exe' does NOT match (the '.' is a boundary char and nothing consumes it). Contrast buildAgentNameRe('droid'), which groups.ts DOES call and which DOES allow '.exe' — two different droid matchers coexist in this codebase and a port must keep them distinct (model it as an `allow_exe_suffix: bool` parameter, as orca-core does).

Rationale from the source comment: 'android' contains 'droid', so Android terminal titles must not become agent status.

Examples: 'droid ready' -> true; 'android ready' -> false; 'droid.exe' -> false; 'droid' -> true.

Used only via `.test(title)`: src/shared/terminal-title-agent-type.ts:196, src/shared/agent-title-identity.ts:110, src/shared/terminal-title-display.ts:25, src/shared/terminal-title-status.ts:131, src/shared/agent-title-core.ts:94, src/shared/agent-title-status.ts:188, src/renderer/src/components/terminal-pane/title-agent-identity.ts:32. Re-exported by agent-title-core.ts:10.

#### `HERMES_AGENT_NAME_RE`

```ts
export const HERMES_AGENT_NAME_RE: RegExp
```

Regex literal:

  export const HERMES_AGENT_NAME_RE = /(?<![\w./\\-])hermes(?![\w./\\-])/i

Identical shape to DROID_AGENT_NAME_RE with needle 'hermes'. Flags 'i'. NO exe suffix.

Rationale from the source comment: cwd/path titles like `~/hermes/working` would otherwise count as agent activity.

Examples: 'hermes working' -> true; '~/hermes/working' -> false; 'hermes.exe' -> false.

Used only via `.test(title)`: terminal-title-agent-type.ts:201, agent-title-identity.ts:113, terminal-title-display.ts:26, terminal-title-status.ts:132, agent-title-core.ts:95, agent-title-status.ts:189, title-agent-identity.ts:33.

#### `AGY_AGENT_NAME_RE`

```ts
export const AGY_AGENT_NAME_RE: RegExp
```

Regex literal:

  export const AGY_AGENT_NAME_RE = /(?<![\w./\\-])agy(?![\w./\\-])/i

Identical shape, needle 'agy' (the Antigravity short form). Flags 'i'. NO exe suffix.

Only THREE characters — the shortest needle in the module, so the boundary guard carries the most weight here ('agy' is a substring of 'antigravity'? no — but of 'shaggy'? no; of 'baggy'/'saggy' -> left boundary is a \w letter so blocked; of 'agy-thing' -> blocked by '-').

Examples: 'agy now' -> true; 'agy' -> true; 'shaggy' -> false; 'agy.exe' -> false.

Always evaluated in an OR with the antigravity token: `titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)` — antigravity FIRST — at terminal-title-agent-type.ts:177 and agent-title-identity.ts:93. Also used at terminal-title-display.ts:24, terminal-title-status.ts:133, agent-title-core.ts:93, agent-title-status.ts:190, title-agent-identity.ts:31.

### Hazards (15)

| Where | JS semantic | Rust trap | Example |
| --- | --- | --- | --- |
| Every pattern in the module: the `(?<![\w./\\-])` prefix. | JS negative lookbehind — zero-width assertion that the immediately preceding code unit is NOT in [A-Za-z0-9_./\\-]. Start-of-string satisfies it. | The Rust `regex` crate supports NO lookaround at all (neither lookbehind nor lookahead) — the pattern will fail to COMPILE, not silently misbehave. Do not reach for `fancy-regex` either; hand-roll the scan as rust/crates/orca-core/src/agent_recognition.rs::title_has_token does. And do NOT substitute `\b`: `\b` treats '.', '/', '\\' and '-' as boundaries, which is precisely the class this guard exists to REJECT. | 'opencode-blinker' / 'opencode' -> correct false; a `\bopencode\b` port returns TRUE. '~/opencode/working' likewise: correct false, `\b` port returns TRUE. |
| `\w` inside `[\w./\\-]`, in all four patterns. | The regexes have flags 'i' only — no 'u'/'v'. In non-Unicode mode JS `\w` is exactly [A-Za-z0-9_]. (Even with the 'i' flag the spec's extraWordChars set is empty here, because Canonicalize refuses non-ASCII -> ASCII folds; so U+017F and U+212A are NOT \w.) Any non-ASCII letter therefore counts as a WORD BOUNDARY and permits a match. | Rust `regex` `\w` is Unicode-aware by default (`\p{Alphabetic}` + marks + digits + connector punctuation), so 'é' and '本' become word chars and BLOCK the match — the port silently under-detects on non-English titles. Use `(?-u:\w)` / a bytes regex, or an explicit `c.is_ascii_alphanumeric() \|\| c == '_'` predicate. | 'é claude é' and '日本claude' both -> TRUE in JS (the neighbours are not ASCII \w). A default-Unicode Rust `\w` port returns FALSE for '日本claude'. |
| The 'i' flag on buildAgentNameRe / ANY_LEGACY_AGENT_NAME_RE / DROID / HERMES / AGY. | ECMAScript Canonicalize for a NON-Unicode regex: uppercase the single code unit; if the result is not exactly one code unit, keep the original; if the original code >= 128 and the uppercased code < 128, KEEP THE ORIGINAL. Net effect: ASCII-only case folding. U+212A KELVIN SIGN does not fold to 'k'; U+017F LONG S does not fold to 's'; U+0131 dotless i does not fold to 'i'; U+0130 İ does not fold to 'I'. | Rust `regex` `(?i)` uses full Unicode simple case folding, so U+212A WOULD match 'k' and U+017F WOULD match 's' — the port over-detects. Equally, hand-rolling with `str::to_lowercase()` (full Unicode) folds U+212A -> 'k'. Use `to_ascii_lowercase()` / `eq_ignore_ascii_case`, or `(?i-u)`. | 'gro\u{212A}' (gro + KELVIN SIGN) vs needle 'grok': JS -> FALSE. Rust `(?i)grok` or a to_lowercase() port -> TRUE. Committed as a regression test in orca-core (`token_match_uses_ascii_fold_like_the_js_regex_i_flag`). |
| Any hand-rolled scan that lowercases the haystack before comparing (the orca-core approach). | JS never materialises a lowercased copy; the regex canonicalises per code unit, which is always length-preserving. | Rust `String::to_lowercase()` is LENGTH-CHANGING: U+0130 becomes the two chars "i\u{307}". If you lowercase into a Vec<char> and then use those indices for boundary checks, every index after the first U+0130 is shifted relative to the original string. `to_ascii_lowercase()` is length-preserving and is the correct choice. | '\u{130}claude' — to_lowercase() yields "i\u{307}claude" (8 chars from 7), and the char before 'claude' becomes U+0307 instead of U+0130. Both are non-boundary so the boolean happens to survive, but any index-returning variant is now wrong. |
| Position arithmetic throughout (start index, `after`, `end`). | JS regex positions are UTF-16 CODE UNIT offsets. An astral char (e.g. U+1F600) occupies TWO positions; each surrogate half is individually tested against the boundary class (neither half is in it) and can never equal an ASCII needle char. | Rust indexes by UTF-8 BYTES (&str) or by char (Vec<char>) — three incompatible index spaces. The booleans agree for this module because every needle char and every boundary char is ASCII, so the extra units/bytes of a non-ASCII char are inert either way. But the moment a port is extended to return a match offset or a slice range, JS offsets and Rust offsets diverge silently. Keep the API boolean, or convert explicitly. | 'claude😀' -> TRUE in JS (the following code unit is a high surrogate, not in the class) and TRUE in a char-based Rust port — but the match END index is 6 in all three spaces here, while for '😀claude' JS says the match starts at 2, a char port says 1, and a byte port says 4. |
| titleHasAgentName's `AGENT_NAME_RE_BY_NAME.get(name)` gate. | A JS Map keyed by string uses SameValueZero — exact, case-SENSITIVE, no trimming, no normalization. A miss short-circuits to false via `?.` + `?? false` WITHOUT ever looking at the title. | Easy to 'improve' this into a case-insensitive roster lookup (because the title side is case-insensitive) or to drop the gate entirely and just token-match whatever name arrives. Both widen behaviour. Model it as `if !AGENT_NAMES.contains(&name) { return false }` with an exact &str comparison, evaluated FIRST. | titleHasAgentName('Claude working', 'Claude') -> FALSE in JS (roster miss), even though the title plainly contains the token. titleHasAgentName('notanagent working', 'notanagent') -> FALSE (committed parity vector). |
| buildAgentNameRe: `${name}` interpolated into the pattern source. | `name` is spliced in UNESCAPED, so it is a regex FRAGMENT, not a literal. Metacharacters are live, and an unbalanced construct makes `new RegExp` THROW a SyntaxError at call time. | A port that does literal substring matching (correct for every real caller) silently diverges for metacharacter input; a port that builds a regex from the raw name inherits an injection surface and a panic path. Production callers only ever pass /^[a-z]+$/ words (AGENT_NAMES, plus AGENT_NAME_GROUPS in groups.ts), so treat the name as a LITERAL and document the narrowing. | buildAgentNameRe('a\|b') yields `(?<![\w./\\-])a\|b(?:…)?(?![\w./\\-])` — the alternation splits the guards, so 'a' is matched with only a LEFT guard and 'b' with only a RIGHT guard. buildAgentNameRe('c.d').test('cxd') -> TRUE ('.' is a wildcard). buildAgentNameRe('(') THROWS. |
| buildAgentNameRe with an empty name. | `(?<![\w./\\-])(?:(?:\.(?:exe\|cmd\|bat\|ps1)))?(?![\w./\\-])` matches the EMPTY STRING at any position not flanked by a boundary char. So `.test('')` -> TRUE and `.test(' ')` -> TRUE, while `.test('claude')` -> FALSE (every position is flanked by a \w char). | orca-core's `title_has_token` returns FALSE for an empty needle (`if needle.is_empty() { return false }`) — a deliberate divergence from buildAgentNameRe(''). It is unreachable through titleHasAgentName ('' is not in AGENT_NAMES) and through the droid/hermes/agy wrappers, but a port that re-exposes a general build-a-matcher entry point must decide explicitly rather than inherit whichever it happened to write. | buildAgentNameRe('').test('') -> TRUE in JS; title_has_token("", "", true) -> false in Rust. |
| The greedy optional suffix `(?:(?:\.(?:exe\|cmd\|bat\|ps1)))?` followed by the right-boundary lookahead. | Greedy: the engine tries WITH the suffix first, and on lookahead failure BACKTRACKS to the zero-width alternative and retries the lookahead. | A hand-rolled scan naturally commits to the suffix with no backtracking (orca-core does: `let mut end = after; for suffix … { end = after + suffix.len(); break }`). This is PROVABLY equivalent — every suffix starts with '.', and '.' is itself in the boundary class, so the backtracked no-suffix branch always fails on that same '.'. Record the proof so a later reviewer does not 'restore' backtracking, and so nobody adds a suffix that does not start with a boundary char (which would break the equivalence). | 'claude.exel': greedy takes '.exe', lookahead sees 'l' (\w) -> fail; backtrack to no suffix, lookahead sees '.' -> fail; no other start position works -> FALSE. 'claude.exe.exe' -> FALSE for the same reason. 'claude.zip' -> FALSE. 'claude.exe ready' -> TRUE. |
| The right-boundary check at end-of-string. | `(?![\w./\\-])` at the end of the subject SUCCEEDS — there is no next character to violate it. | `is_boundary_char(haystack[end])` PANICS with index-out-of-bounds when the token ends the string (the common case: a title that is exactly 'claude'). The correct encoding is `!haystack.get(end).is_some_and(is_boundary_char)` — 'absent OR not a boundary char'. Symmetrically the left guard needs `start.checked_sub(1)` so position 0 has no predecessor and passes. This is the `is_some_and` vs truthiness trap: `Option<bool>::unwrap_or(false)` on the RIGHT side of a NEGATED predicate must default to false-before-negation, i.e. treat 'past the end' as 'not a boundary'. | titleHasAgentName('claude', 'claude') -> TRUE (committed vector). A naive indexing port panics on this input, and a port that defaults the absent case to `true` returns FALSE. |
| titleHasAnyLegacyAgentName: single alternation regex vs. Rust's `AGENT_NAMES.iter().any(...)`. | The regex is POSITION-MAJOR: leftmost start position wins, and only within a position are the 13 alternatives tried in AGENT_NAMES order. | `any()` is NAME-MAJOR: it short-circuits on the first NAME that matches ANYWHERE. Identical for a boolean result (both answer 'does some (position, name) pair match'), but if the port is ever widened to return the matched name, the matched index, or a match span, the two disagree. Preserve AGENT_NAMES order regardless, and if you need the name, do a leftmost-first scan rather than `any()`. | 'codex and claude': position-major says 'codex' (offset 0); name-major (`any()` over ['claude','openclaude','codex',…]) hits 'claude' at offset 10 first. Both return true today. |
| Flags on all four regexes: 'i' only, no 'g'. | Without the 'g'/'y' flag, `RegExp.prototype.test` neither reads nor writes `lastIndex`. The three module-level RegExp constants and the 13 cached regexes in AGENT_NAME_RE_BY_NAME are therefore stateless and safe to share across all callers. | Not a Rust trap so much as a licence: a `once_cell::Lazy<Regex>` (or a plain const table) is a faithful model — no per-call reset, no interior mutability, no thread-safety caveat. Conversely, a port that 'helpfully' adds a global flag to reuse one matcher for find_iter would introduce cross-call state that the TS does not have. | Calling titleHasAnyLegacyAgentName('codex') twice in a row returns true both times; with a 'g' flag the second call would return false. |
| Transcribing the character class `[\w./\\-]` out of the TS source. | Two different escaping layers are in play. The regex LITERALS (DROID/HERMES/AGY) contain `[\w./\\-]` verbatim. The TEMPLATE-STRING builders contain `[\\w./\\\\-]`, which the template literal reduces to the same `[\w./\\-]`. Inside the class, `\\` is ONE literal backslash and the trailing `-` (immediately before `]`) is a LITERAL hyphen, not a range operator. The class is exactly {A-Z, a-z, 0-9, _, ., /, \, -}. | Copying the template-literal form into a Rust raw string yields `[\\w./\\\\-]` — a class of {literal backslash, w, ., /, -} that no longer contains letters or digits, so 'openclaudeX' would match. Also, reading the trailing `-` as a range start produces a compile error or, worse, a silently different class. Prefer an explicit predicate: `c.is_ascii_alphanumeric() \|\| matches!(c, '_' \| '.' \| '/' \| '\\' \| '-')`. | 'openclaude' / 'claude': correct FALSE. With the mis-escaped class (no letters), the left guard no longer rejects 'n' -> TRUE. |
| Two competing 'droid' matchers. | DROID_AGENT_NAME_RE (exported here) FORBIDS the executable suffix, while groups.ts reaches 'droid' through buildAgentNameRe('droid'), which ALLOWS it. Same word, two different predicates, chosen by call site. | Collapsing them into one `title_has_droid()` loses a real distinction. orca-core models it correctly by exposing `title_has_token(title, name, allow_exe_suffix: bool)` and building `title_has_droid/hermes/agy` on top with `false`, and `title_has_agent_name/title_has_any_legacy_agent_name` with `true`. Keep the flag in the port's public surface so the orchestration-groups path can request the exe-suffix variant. | 'droid.exe' -> DROID_AGENT_NAME_RE.test = FALSE, but buildAgentNameRe('droid').test = TRUE. |
| Argument types at runtime. | `RegExp.prototype.test(x)` applies ToString to x. Callers are typed `string`, but a `null`/`undefined`/number leaking through `as any` or from IPC is stringified: test(null) actually tests the 5-char string 'null'. | Rust's `&str` cannot represent this, so the port is stricter by construction. The parity dispatch (rust/crates/orca-dispatch/src/modules/agent_recognition.rs) papers over it with `.and_then(Value::as_str).unwrap_or("")`, mapping a missing/non-string field to "" rather than to "undefined" — a deliberate, documented harness convention, not a semantic equivalence. Do not generalise it into the library. | titleHasAnyLegacyAgentName(undefined as any) tests 'undefined' -> false (harmless here); but a hypothetical roster entry 'codex' with title 12345 would test '12345'. The dispatch would instead test ''. |

---

## `src/shared/agent-title-identity.ts`

> src/shared/agent-title-identity.ts (121 lines at HEAD; read via `git show HEAD:src/shared/agent-title-identity.ts`). Pure, dependency-free-at-runtime string classification. Imports only predicates: from `./agent-title-core` — `AGY_AGENT_NAME_RE`, `CLAUDE_IDLE`, `DROID_AGENT_NAME_RE`, `HERMES_AGENT_NAME_RE`, `containsBrailleSpinner`, `isClaudeManagementTitle`, `isCursorAgentTitle`, `isGeminiTerminalTitle`, `isPiAgentTitle`, `titleHasAgentName`; from `./opencode-terminal-title` — `isOpenCodeNativeTitle`; from `./pi-compatible-synthetic-title` — `getPiCompatibleSyntheticAgentLabel`. Re-exported to app code through `src/shared/agent-detection.ts` line 22 (`export { getAgentLabel, isClaudeAgent } from './agent-title-identity'`). No state, no I/O, no config; both exports are total functions of one string.

RUST CORE STATUS (checked at HEAD, `git grep -n … HEAD -- rust/crates`)

Neither export of this module exists in Rust. Nothing named `is_claude_agent`, `get_agent_label`, or `agent_label` appears anywhere under rust/crates (grep returned zero hits), and there is no `agent-title-identity` / `terminal-title-agent-type` entry in the dispatch registry `rust/crates/orca-dispatch/src/modules/mod.rs`.

  * `isClaudeAgent`  → NOT implemented in Rust.
  * `getAgentLabel`  → NOT implemented in Rust.

Of the seven helper predicates the ladder depends on, exactly TWO are already ported and parity-dispatched; five are missing and must be written as part of this port:

  IMPLEMENTED
  - `titleHasAgentName` → `orca_core::agent_recognition::title_has_agent_name`
    (rust/crates/orca-core/src/agent_recognition.rs). Hand-rolled boundary matcher (`title_has_token` + `is_boundary_char`) because Rust regex lacks lookbehind; already uses ASCII folding with an explicit comment about why full `to_lowercase` would be wrong. Siblings `title_has_droid`, `title_has_hermes`, `title_has_agy` cover DROID_/HERMES_/AGY_AGENT_NAME_RE — so rungs 7-15, 17, 18 and the second half of rung 12 are fully backed today. Dispatched via rust/crates/orca-dispatch/src/modules/agent_recognition.rs (functions `titleHasAgentName`, `titleHasAnyLegacyAgentName`, `isExpectedAgentProcess`).
  - `isOpenCodeNativeTitle` → `orca_core::opencode_terminal_title::is_opencode_native_title`
    (rust/crates/orca-core/src/opencode_terminal_title.rs). Complete, with an unusually good corner-case test suite covering the JS-trim/`\s` divergences. Rung 2 and isClaudeAgent B0 are backed.

  MISSING — write these first
  - `containsBrailleSpinner` (trivial; 3 call sites)
  - `isClaudeManagementTitle` + CLAUDE_MANAGEMENT_TITLE_RE (rung 1, isClaudeAgent B0)
  - `isCursorAgentTitle` + CURSOR_NATIVE_TITLE_LOWER (rung 16, isClaudeAgent B3)
  - `isGeminiTerminalTitle` + the four Gemini glyph constants (rung 4)
  - `isPiAgentTitle` / `isLegacyPiCompatibleTitle` and `getPiCompatibleSyntheticAgentLabel` + the two Pi regexes (rungs 5, 6, and the Gemini veto)

  Useful existing infrastructure: `orca_core::js_string` already provides `is_js_trim_ws` (the exact ECMAScript trim set — U+FEFF in, U+0085 out) and `trim_js`. Use `is_js_trim_ws` for BOTH `.trim()`/`.trimStart()` sites AND as the `\s` character class in the hand-rolled management-title / Pi matchers; JS `\s` and the JS trim set are the same set. `rust/crates/orca-core/src/synthetic_agent_title.rs` already holds the product-label vocabulary ("Pi", "OMP", "Codex", "Cursor Agent", "Cursor ready", "Cursor - action required", …) if you want a single source for the literals.

PORTING ADVICE

1. Port ONCE, serve both TS twins. `src/shared/terminal-title-agent-type.ts` contains a semantically identical copy of both exports (verified by diffing the two files: the only differences are import lines, comment prose, and an `if (c) return true; return false` vs `return c` reshaping at the tail of isClaudeAgent). Its inline `CLAUDE_MANAGEMENT_TITLE_RE` literal expands to exactly the pattern `agent-title-core.ts` builds from `String.raw`. Do not port two ladders.
2. Build the ladder as an ordered list of (predicate, label) pairs plus the rung-1 veto and the two-predicate rung 12, so the order is data and a reorder is a visible diff. The tests in `src/shared/terminal-title-agent-type.test.ts` pin the cross-cutting cases (Cursor vs cursor-as-noun, "⠋ Codex: fix cursor offsets" → codex, "⠋ OpenClaude" → not Claude); mirror them as Rust unit tests and as parity-corpus rows.
3. If you add a dispatch module, `agent-title-identity` is the natural name (`isClaudeAgent`, `getAgentLabel`), sitting alongside the existing `agent-recognition` entry; the parity harness can then drive the whole ladder from the TS side against a shared corpus of titles.
4. The single highest-value invariant to encode as a test: `getAgentLabel` must call `isClaudeAgent` LAST, and `isClaudeAgent`'s braille branch must be terminal. Almost every real-world misclassification this module has ever had traces to one of those two facts being violated.

No files were modified; everything above was read from HEAD via `git show` / `git grep … HEAD`.

### Exports (2)

#### `isClaudeAgent`

```ts
TS: export function isClaudeAgent(title: string): boolean  |  Rust: pub fn is_claude_agent(title: &str) -> bool
```

FIVE stages, evaluated strictly in this order. Every stage that fires RETURNS; there is no accumulation.

B0 VETO (line 21) — `if (!title || isClaudeManagementTitle(title) || isOpenCodeNativeTitle(title)) return false`.
  * `!title` is JS falsiness on a declared `string`: true only for `""`. Rust: `title.is_empty()`.
  * `||` short-circuits; all three are pure so order is perf-only.

PRE (line 24) — `const lower = title.toLowerCase()` is computed UNCONDITIONALLY here, after B0, even though it is consumed only in B3. Full-Unicode `String.prototype.toLowerCase`, NOT ASCII folding.

B1 (line 28) — `if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) return true`. CLAUDE_IDLE = U+2733 '✳'. First test is the TWO-code-point prefix "✳\u{20}" (asterisk + ASCII space); second is exact whole-string equality with the bare "✳". `"✳foo"` and `"✳\tfoo"` do NOT fire. No trim: `" ✳ x"` does NOT fire.

B2 (line 31) — `if (title.startsWith('. ') || title.startsWith('* ')) return true`. Literal 2-char prefixes ". " and "* " (dot/asterisk + ASCII space). No trim, so leading whitespace defeats them.

B3 (lines 34-38) — `if (containsBrailleSpinner(title)) { return !isCursorAgentTitle(title) && !lower.includes('openclaude') }`. This is a TERMINAL branch: any title containing at least one code point in U+2800..=U+28FF returns from here and NEVER reaches B4. Result is `true` unless the title is a Cursor closed-set identity title, or the lowercased WHOLE title contains the raw SUBSTRING "openclaude" (substring, not token — see hazards). `&&` short-circuits (isCursorAgentTitle evaluated first).

B4 (lines 40-43, the fallthrough return) — `const trimmedTitle = title.trimStart(); return trimmedTitle.toLowerCase().startsWith('claude') && titleHasAgentName(trimmedTitle, 'claude')`. Note BOTH conjuncts operate on the LEADING-trimmed string (trailing whitespace is retained). Requires the title to BEGIN with the word claude AND to carry `claude` as a whole token. So `"claude-scratch"` → false (starts-with passes, token match fails on the `-`); `"fix the claude bug"` → false (token passes, starts-with fails); `"Claude Code — ~/repo"` → true.

If B4's conjunction is false the function returns false. No other exit.

DIFFERENCE FROM terminal-title-agent-type.ts: none behaviourally. That file's private copy writes B4 as `if (cond) { return true }` followed by `return false` instead of returning the expression — identical truth table. `git diff` of the two files shows only import lines, comment text, and that if/return reshaping inside isClaudeAgent.

Unicode literals: `U+2733 ✳ (CLAUDE_IDLE) — prefix "✳ " = U+2733 U+0020, and bare "✳"`, `U+002E U+0020 (". ")`, `U+002A U+0020 ("* ")`, `U+2800..U+28FF braille block (spinner test, inclusive both ends)`

#### `getAgentLabel`

```ts
TS: export function getAgentLabel(title: string): string | null  |  Rust: pub fn get_agent_label(title: &str) -> Option<&'static str>
```

A 19-rung ladder plus a null tail. Each rung is `if (pred) return LABEL`. THE ORDER IS THE SEMANTICS. Exact rung list, in source order (lines 46-121):

 1. `isClaudeManagementTitle(title)` -> **null** (VETO, not a fallthrough — `"claude agents"` must never label as an agent; returning null here is different from falling through, because falling through would let rung 19 claim it).
 2. `isOpenCodeNativeTitle(title)` -> "OpenCode".
 3. `title.startsWith("✳ ") || title === "✳" || title.startsWith(". ") || title.startsWith("* ")` -> "Claude Code". (Same four disjuncts as isClaudeAgent B1+B2, flattened into one `if`, and WITHOUT any `!title` guard — but rungs 1 and 2 have already vetoed the management/OpenCode cases.)
 4. `isGeminiTerminalTitle(title)` -> "Gemini CLI".
 5. `const l = getPiCompatibleSyntheticAgentLabel(title); if (l) return l` -> "Pi" or "OMP". THIS IS THE ONLY PRODUCER OF "OMP" in the module.
 6. `isPiAgentTitle(title)` -> "Pi".
 7. `titleHasAgentName(title, 'codex')` -> "Codex".
 8. `titleHasAgentName(title, 'openclaude')` -> "OpenClaude".
 9. `titleHasAgentName(title, 'copilot')` -> "GitHub Copilot".
10. `titleHasAgentName(title, 'grok')` -> "Grok".
11. `titleHasAgentName(title, 'devin')` -> "Devin".
12. `titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)` -> "Antigravity". (Two-predicate rung; `agy` is the short alias and is NOT in AGENT_NAMES, hence the separate regex.)
13. `titleHasAgentName(title, 'opencode')` -> "OpenCode".
14. `titleHasAgentName(title, 'mimo')` -> "MiMo Code".
15. `titleHasAgentName(title, 'aider')` -> "Aider".
16. `isCursorAgentTitle(title)` -> "Cursor". (Closed-set title match, NOT a `cursor` token match — `cursor` is ordinary editor vocabulary.)
17. `DROID_AGENT_NAME_RE.test(title)` -> "Droid".
18. `HERMES_AGENT_NAME_RE.test(title)` -> "Hermes".
19. `isClaudeAgent(title)` -> "Claude Code".
20. fallthrough -> null.

WHY THE ORDER MATTERS (load-bearing invariants a reorder would break):
  * There is NO `titleHasAgentName(title, 'claude')` rung. Claude identity arrives only via rung 3 (status prefix) or rung 19 (isClaudeAgent). A title that merely mentions `claude` as a token mid-string never becomes Claude here.
  * Rung 19 is LAST on purpose: isClaudeAgent's braille rule (B3) claims essentially every spinner-bearing title, so every named agent that also emits a braille spinner (Codex, Grok, Droid, Hermes, Pi, Cursor, OpenCode…) must be matched at rungs 4-18 first. Moving isClaudeAgent up mislabels all of them "Claude Code".
  * Rung 5 before rung 6 and before all token rungs: Pi/OMP synthetic frames carry braille and would otherwise be claimed generically.
  * Rung 4 (Gemini) before Pi: but `isGeminiTerminalTitle` internally defers to Pi for its TOKEN path (glyph evidence still wins over Pi) — see notes.
  * Rung 16 (Cursor) before rungs 17-19, so `"⠋ Cursor Agent"` is Cursor, not Claude.
  * Rung 1 before everything: `null` is a distinct outcome from the ladder falling through.

EXACT RETURN STRINGS (byte-exact, they are keys elsewhere — `TITLE_LABEL_TO_AGENT` in terminal-title-agent-type.ts): "OpenCode", "Claude Code", "Gemini CLI", "Pi", "OMP", "Codex", "OpenClaude", "GitHub Copilot", "Grok", "Devin", "Antigravity", "MiMo Code", "Aider", "Cursor", "Droid", "Hermes". Note the casing/spacing: "GitHub Copilot", "MiMo Code", "Gemini CLI", "Claude Code".

EMPTY INPUT: `getAgentLabel("")` walks the entire ladder (no early `!title` guard) and returns null via rung 19's `isClaudeAgent("") === false`.

DIFFERENCE FROM terminal-title-agent-type.ts's getAgentLabel: none. Byte-for-byte identical rung order and predicates; the diff is comments only. The other file layers EXTRA machinery on top that does NOT exist here: `TITLE_LABEL_TO_AGENT` (label -> TuiAgent id, adds "OMP"->'omp', "MiMo Code"->'mimo-code'), `resolveTerminalTitleAgentType`, `hasGenericClaudeStatusPrefix`/`isGenericClaudeStatusClaim`, and `resolveExplicitTerminalTitleAgentType` (which nulls out a 'claude' answer whose only evidence was a bare status prefix and which lacks a `claude` name token). It also carries PRIVATE duplicates of CLAUDE_IDLE, CLAUDE_MANAGEMENT_TITLE_RE, containsBrailleSpinner, isGeminiTerminalTitle, isPiTerminalTitle, isPiAgentTitle, isClaudeManagementTitle, plus Grok-only helpers (isGrokRotatingWorkingTitle). Verified identical: its inline CLAUDE_MANAGEMENT_TITLE_RE literal expands to exactly the string agent-title-core builds via String.raw. A Rust port should implement the ladder ONCE and have both TS twins map onto it.

Unicode literals: `U+2733 ✳ (rung 3)`, `U+002E/U+002A + U+0020 (rung 3)`, `U+2800..U+28FF (via isClaudeAgent rung 19, isCursorAgentTitle, the Pi regexes)`, `U+270B ✋ / U+2726 ✦ / U+23F2 ⏲ / U+25C7 ◇ (Gemini glyphs, rung 4)`, `U+03C0 π (legacy Pi title regex, rung 6 — lowercase pi only)`

### Hazards (20)

| Where | JS semantic | Rust trap | Example |
| --- | --- | --- | --- |
| isClaudeAgent B0 — `!title` | JS falsiness on a `string`-typed value is true only for the empty string. `"0"` and `" "` are truthy. | Porting `!title` as "is empty or blank" (e.g. `title.trim().is_empty()`) is wrong: `"   "` must NOT short-circuit — it proceeds and reaches B4, where `trimStart()` yields `""` and the answer is false anyway, but the intermediate branch behaviour (B3 braille) differs for `"  ⠋  "`. Use exactly `title.is_empty()`. | "  ⠋  " → must return true (B3), not false |
| isClaudeAgent line 24 — `const lower = title.toLowerCase()` | Full Unicode Default Case Conversion, locale-independent, may change length (U+0130 İ → "i̇"). | Using `to_ascii_lowercase()` here is a different function than the one the regexes need (see next hazard) — get the two backwards and both sites are wrong. Use `str::to_lowercase()` for this site. Also: this is computed BEFORE B1/B2 in JS; a Rust port that lazily computes it inside B3 is observationally identical (pure) but do not "optimise" it into a different case-fold. | "⠋ ＯＰＥＮＣＬＡＵＤＥ" (fullwidth) → lowercases to fullwidth, does NOT contain "openclaude", so B3 returns true under both foldings; "⠋ OPENCLAUDE" → false |
| isClaudeAgent B3 — `!lower.includes('openclaude')` | RAW SUBSTRING search on the lowercased title. No word boundaries at all. | Substituting the module's own `titleHasAgentName(title,'openclaude')` (token match) here is WRONG and silently flips real inputs. The substring form is deliberately broader than the token form, and the asymmetry is load-bearing: rung 8 of getAgentLabel uses the TOKEN form, so a hyphen-compound OpenClaude title falls past rung 8, reaches rung 19, and is killed by this SUBSTRING check → overall null. | "⠋ openclaude-blinker" → titleHasAgentName(...,'openclaude') is FALSE (right boundary `-`), but lower.includes("openclaude") is TRUE → isClaudeAgent false → getAgentLabel returns null |
| isClaudeAgent B3 — the whole branch | `if (containsBrailleSpinner(title)) { return ... }` — a `return`, so braille-bearing titles NEVER reach B4. | Writing it as `if braille && !cursor && !openclaude { return true }` and letting the rest fall through to B4 is a different function: `"⠋ Cursor Agent"` would then be re-tested by B4 (still false there, so harmless) but `"⠋ claude something openclaude"` would fall to B4 and return TRUE instead of false. | "claude fix ⠋ openclaude drift" → braille present → B3 returns false; a fallthrough port returns true (starts with "claude" + token match) |
| isClaudeAgent B4 — `title.trimStart()` | ECMAScript trim set = WhiteSpace + LineTerminator. INCLUDES U+FEFF; EXCLUDES U+0085 (NEL). | Rust `str::trim_start()` uses Unicode White_Space: it strips U+0085 (JS does not) and keeps U+FEFF (JS strips it). Use the repo's existing `orca_core::js_string::is_js_trim_ws` with `trim_start_matches`. | "\u{FEFF}Claude Code" → JS true (BOM trimmed, then starts with "claude"); Rust `trim_start()` also handles it? No — Rust keeps U+FEFF → starts_with("claude") false → wrong answer false. Conversely "\u{85}Claude Code" → JS false, naive Rust true. |
| titleHasAgentName / AGY_ / DROID_ / HERMES_ regexes — the `i` flag | ECMAScript `i` without `u` uses Canonicalize (simple uppercase mapping) with the rule that a non-ASCII char whose uppercase is ASCII stays non-ASCII. For these all-ASCII patterns that is exactly ASCII-only case folding. | Using `to_lowercase()` (full Unicode) makes U+212A KELVIN SIGN fold to 'k' and U+0130 expand — matches the JS regex does NOT make. The committed Rust core already gets this right (`title_has_token` uses `to_ascii_lowercase` with an explicit comment); do not "fix" it to full folding. | "\u{212A}odex ready" (Kelvin + odex) → JS titleHasAgentName(...,'codex') FALSE; a full-lowercase Rust port says TRUE → mislabels as Codex |
| the token-boundary lookarounds `(?<![\w./\\-])…(?![\w./\\-])` | Lookbehind + lookahead; `\w` without the `u` flag is ASCII `[A-Za-z0-9_]`. Boundary class = ASCII word chars plus `.` `/` `\` `-`. | Rust's `regex` crate has NO lookbehind — you cannot transcribe the pattern. Hand-roll it (already done: `orca_core::agent_recognition::title_has_token` / `is_boundary_char`). Also do not use `\b`, and do not treat non-ASCII letters as word chars: `"é"` is NOT a boundary blocker, so "écodex" DOES token-match `codex`. | "écodex" → JS matches `codex` (é is not in `[\w./\\-]`) → getAgentLabel returns "Codex". A Rust port using `\b` with Unicode word chars returns null. |
| titleHasAgentName's optional exe suffix vs DROID/HERMES/AGY | `buildAgentNameRe` appends `(?:\.(?:exe\|cmd\|bat\|ps1))?` before the right boundary. DROID_AGENT_NAME_RE, HERMES_AGENT_NAME_RE and AGY_AGENT_NAME_RE do NOT. | A single shared token helper with the suffix always enabled makes `"droid.exe"` match Droid, which JS refuses (the `.` is a right-boundary blocker with no suffix rule). The Rust core models this with the `allow_exe_suffix` flag — keep it per-call. | "droid.exe" → JS Droid rung FALSE; "codex.exe ready" → JS Codex rung TRUE |
| titleHasAgentName(title, name) — the map lookup | `AGENT_NAME_RE_BY_NAME.get(name)?.test(title) ?? false` — a name that is not in AGENT_NAMES returns false, it does not throw and does not fall back to a substring. | A Rust `title_has_agent_name` that builds a matcher for any string would answer true for names JS answers false for. `agy`, `droid`, `hermes` are deliberately NOT in AGENT_NAMES. The committed Rust guards with `AGENT_NAMES.contains(&name)` — preserve that. | titleHasAgentName("agy running", "agy") → false in JS; rung 12 only fires because of the separate AGY_AGENT_NAME_RE |
| getAgentLabel rung 1 — isClaudeManagementTitle → null | An explicit `return null`, not a `break`/fallthrough. | Modelling the ladder as "first predicate that matches yields a label, else None" and simply omitting the management title from the label table produces the WRONG answer: without the veto, `"claude agents"` falls to rung 19 where isClaudeAgent... also vetoes it. But `"✳ claude agents"`? rung 3 would fire and return "Claude Code". The veto must be a distinct, first-position early return. | "/usr/local/bin/claude.exe   agents  " → null (matches the management regex); without rung 1, rung 19 would still say null, but "✳ claude agents" would wrongly become "Claude Code" |
| CLAUDE_MANAGEMENT_TITLE_RE = /^\s*(?:"CMD"\|'CMD'\|CMD)\s+agents\s*$/i, CMD = (?:.*[\\/])?claude(?:\.(?:exe\|cmd\|bat\|ps1))? | JS `\s` = the trim set (includes U+00A0, U+FEFF, U+3000; EXCLUDES U+0085). JS `.` without the `s` flag matches anything EXCEPT U+000A, U+000D, U+2028, U+2029. `$` without `m` is end-of-input. Quotes must be immediately after the leading whitespace, and the same quote style is required on both ends only in the sense that each alternative is self-consistent. | Rust `regex`'s `\s` is Unicode White_Space (has U+0085, lacks U+FEFF) and Rust `.` matches everything but `\n` only (not U+2028/U+2029, and it DOES match `\r`). Both diverge. Hand-roll or use an explicit class. Also note there is no `(?s)`/`(?m)` — do not enable them. | "\u{FEFF}claude agents" → JS TRUE (\s* eats the BOM); Rust regex `\s*` → FALSE. "C:\\bin\\claude.cmd agents" → TRUE. "~/x\u{2028}y/claude agents" → JS FALSE (`.` cannot cross U+2028); Rust `.` → TRUE. |
| isOpenCodeNativeTitle — /^(?:[^\|\s]+ \\| )?OC\s*\\|\s*\S/u on title.trim() | Case-SENSITIVE "OC". The optional multiplexer prefix separator is the literal three characters space-pipe-space, while the separator after OC is `\s*\\|\s*` (flexible). Requires one non-whitespace char after the pipe. Input is JS-trimmed first. | Already ported correctly at rust/crates/orca-core/src/opencode_terminal_title.rs — reuse it, do not re-derive. The traps it documents: JS-trim vs Rust-trim (U+FEFF/U+0085), and the literal " \| " prefix separator (so "tmux\t\| OC \| x" is FALSE while "OC \t \| \t x" is TRUE). | "tmux \| OC \| ses_123" → true; "oc \| task" → false; "⠋ Fix foo \| OC \| bar" → false (only one prefix frame allowed and it must be token-shaped) |
| getAgentLabel rung 5 — `if (piCompatibleSyntheticAgentLabel)` | Truthiness test on a `'Pi' \| 'OMP' \| null` value. Since neither label is the empty string, truthiness ≡ non-null. | `is_some()` is the faithful port here ONLY because the value set excludes "". Do not generalise the pattern to other string-returning helpers in this codebase without checking for an empty-string return. | "⠋ omp - action required" → Some("OMP") |
| PI_COMPATIBLE_SYNTHETIC_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?(pi\|omp)(?:\s+-\s+action required\|\s+(?:ready\|idle\|done))?\s*$/i | Case-INsensitive (so "PI", "Omp", "READY" all match). EXACTLY ONE optional braille code point followed by one-or-more whitespace. Capture group 1 decides the label: `match[1].toLowerCase() === 'omp' ? 'OMP' : 'Pi'`. Whole-string anchored. | Two braille chars ("⠋⠙ Pi") do NOT match — a `[⠀-⣿]+` port over-accepts. The `\s+` after the braille char is required, not optional. And the `(pi\|omp)` alternation is inside an anchored pattern, so "pin" fails: do not implement it as a prefix test. | "⠋ Pi" → "Pi"; "OMP ready" → "OMP"; "⠋⠙ Pi" → null; "⠋Pi" (no space) → null; "pin" → null |
| LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?π(?:\s*[-:]\|\s)\s*.*$/u — backing isPiAgentTitle (rung 6) and the Pi veto inside isGeminiTerminalTitle | NO `i` flag: only U+03C0 π (lowercase). U+03A0 Π does NOT match. A delimiter is REQUIRED after π: either `\s*` then one of `-`/`:`, or a single whitespace. `.*` cannot cross a line terminator and `$` is end-of-input (no `m`), so a newline after the delimiter fails the match. | Rust `regex` with `(?i)` would wrongly accept Π; Rust `.` also differs on U+2028/U+2029/`\r`. Also easy to over-accept a bare "π" — it fails (no delimiter) — while "π " (trailing space) SUCCEEDS. | "π - ~/repo" → Pi; "π" → not Pi; "π " → Pi; "Π - ~/repo" → not Pi; "π - a\nb" → not Pi |
| isGeminiTerminalTitle (rung 4) — internal branch order | 1) `title.includes(✋\|✦\|⏲\|◇)` → true; 2) `if (isPiAgentTitle(title)) return false`; 3) `return titleHasAgentName(title,'gemini')`. The Pi veto sits BETWEEN the glyph test and the token test. | Hoisting the Pi veto to the top makes a Pi title bearing a Gemini glyph lose to Pi, which JS does not do. Sinking it below the token test makes "π - ~/gemini-work" ... actually "gemini-work" fails the token test anyway; the reachable break is "π - run gemini now", JS says NOT Gemini, a reordered port says Gemini. | "π - run gemini now" → isGeminiTerminalTitle FALSE (Pi veto) → ladder continues to rung 6 → "Pi". "π - ✦ building" → TRUE (glyph beats the veto) → "Gemini CLI". |
| isCursorAgentTitle (rung 16, and inside isClaudeAgent B3) | `typeof title !== 'string'` → false. Then `trimmed = title.trim()` (JS trim set), `lower = trimmed.toLowerCase()` (FULL Unicode lowercase). Matches iff lower is exactly one of "cursor agent", "cursor ready", "cursor - action required", OR the CASE-SENSITIVE regex /^[⠀-⣿] Cursor Agent$/u matches the TRIMMED (not lowercased) string. | The regex arm is case-sensitive and demands exactly one braille char + exactly one ASCII space + the literal "Cursor Agent". Folding it into the lowercase set ("⠋ cursor agent") over-accepts. Applying the regex to the untrimmed string under-accepts. And it is a CLOSED SET — never substitute `titleHasAgentName(title,'cursor')`, which would claim ordinary editor task text. | "  ⠋ Cursor Agent  " → true; "⠋ cursor agent" → false; "⠋  Cursor Agent" (two spaces) → false; "⠋ preserve cursor visibility across replays" → false (→ ends up "Claude Code") |
| containsBrailleSpinner | `for (const char of title)` iterates CODE POINTS (astral chars arrive whole); tests `codePointAt(0)` in [0x2800, 0x28FF] inclusive. | Iterating UTF-16 code units (or bytes) instead of chars is the classic break — a surrogate half can never land in 0x2800..0x28FF so the answer happens to survive, but any port that indexes by `title.length` (UTF-16) elsewhere in the same pass will desync. Rust `title.chars().any(\|c\| ('\u{2800}'..='\u{28FF}').contains(&c))` is exact. Note the range is INCLUSIVE at both ends (0x28FF, not 0x28FE). | "⣿ done" (U+28FF) → true; "⤀" (U+2900) → false |
| getAgentLabel rung 19 re-entering isClaudeAgent | isClaudeAgent re-runs isClaudeManagementTitle and isOpenCodeNativeTitle, both already known false from rungs 1-2. | Not a correctness trap, a refactoring trap: "optimising" rung 19 to call a guard-free inner isClaudeAgent is safe TODAY only because rungs 1-2 dominate it. If the ladder is ever reordered the guards are the only thing keeping it honest — keep the full call. | "OC \| ⠋ working on claude" → rung 2 wins with "OpenCode"; if rung 2 were removed, isClaudeAgent's own B0 would still return false → null (not "Claude Code") |
| Return type — `string \| null` vs a closed enum | The labels are free-form strings, and downstream `TITLE_LABEL_TO_AGENT[label] ?? null` in terminal-title-agent-type.ts is a lookup that can MISS. | Modelling the return as a Rust enum with a variant per agent is fine, but the exact strings must round-trip byte-for-byte ("GitHub Copilot", "MiMo Code", "Gemini CLI", "Claude Code", "OpenClaude" — capital C) or the downstream label→TuiAgent map silently yields None. Do not normalise casing or spacing. | "copilot ready" → must be exactly "GitHub Copilot", which maps to TuiAgent 'copilot'; "mimo working" → exactly "MiMo Code" → 'mimo-code' |

---

## `src/shared/terminal-title-agent-type.ts`

> src/shared/terminal-title-agent-type.ts (269 lines, 15 exports) @ HEAD (bf58bbb93). Read exclusively via `git show HEAD:`. Direct dependencies also read at HEAD: src/shared/agent-name-token-match.ts, src/shared/agent-title-core.ts, src/shared/opencode-terminal-title.ts, src/shared/pi-compatible-synthetic-title.ts, src/shared/types.ts (TuiAgent). Rust cross-check: rust/crates/orca-core/src/agent_recognition.rs, rust/crates/orca-core/src/opencode_terminal_title.rs, rust/crates/orca-core/src/js_string.rs, rust/crates/orca-core/src/agent_kind.rs, rust/crates/orca-dispatch/src/modules/agent_recognition.rs.

RUST-CORE COVERAGE SUMMARY (checked at HEAD)

Nothing in this module is ported. `git grep -rn "terminal-title-agent-type|resolveTerminalTitleAgentType|getAgentLabel|isCursorAgentTitle|isClaudeAgent" HEAD -- rust tools` returns ZERO hits — no Rust implementation, no dispatch entry, no parity oracle, no recorded golden. All 15 exports are greenfield.

Two of the four imported dependencies ARE already ported and should be reused verbatim rather than re-derived:
  * `titleHasAgentName` → `orca_core::agent_recognition::title_has_agent_name` (rust/crates/orca-core/src/agent_recognition.rs:96), plus `title_has_droid` / `title_has_hermes` / `title_has_agy` for the three sibling regexes. This file already solved the lookbehind problem (hand-rolled `title_has_token`) and the `i`-flag fold problem (ASCII fold, with a pinning test).
  * `isOpenCodeNativeTitle` → `orca_core::opencode_terminal_title::is_opencode_native_title` (rust/crates/orca-core/src/opencode_terminal_title.rs:16), already hand-rolled against `is_js_trim_ws`.
Two are NOT ported and must be written as part of this work:
  * `isCursorAgentTitle` (from src/shared/agent-title-core.ts) — needed by getAgentLabel G16 and isClaudeAgent C3.
  * `isLegacyPiCompatibleTitle` + `getPiCompatibleSyntheticAgentLabel` (from src/shared/pi-compatible-synthetic-title.ts) — needed by G5/G6 and by isGeminiTerminalTitle's veto. Note rust/crates/orca-core/src/synthetic_agent_title.rs is a DIFFERENT concern (the label/profile table) and does not help.
Supporting infrastructure already present: `orca_core::js_string::{is_js_trim_ws, trim_js}` for JS-exact whitespace, and `orca_core::agent_kind::TUI_AGENT_KIND_PAIRS` which already carries all 16 target TuiAgent id strings (as `&str`; there is no Rust enum for TuiAgent).

CRATE PLACEMENT
`orca-core` is deliberately ZERO-DEPENDENCY (its Cargo.toml says so explicitly) — no `regex`. Its two existing title modules are hand-rolled matchers. `orca-text` has `regex` with features `["std","perf","unicode-case","unicode-perl","unicode-gencat"]`. Either works, but note that `unicode-case` gives Unicode simple folding for `(?i)`, which is NOT what the JS `i` flag does; if you go the regex route use `(?i-u:…)` for ASCII-only insensitivity, and remember the crate has no lookbehind at all (so `titleHasAgentName` can never be a regex there). Following the precedent of opencode_terminal_title.rs — hand-rolled, in orca-core, next to its siblings — keeps the whole cluster in one zero-dep crate and sidesteps both traps.

DUPLICATION WARNING (do not port twice, do not let them drift)
src/shared/agent-title-core.ts and src/shared/agent-title-identity.ts together contain a byte-for-byte parallel copy of nearly this entire module: CLAUDE_IDLE, all four GEMINI_* glyphs, CLAUDE_MANAGEMENT_TITLE_RE (built from a shared fragment, same pattern), containsBrailleSpinner, isGeminiTerminalTitle, isPiTerminalTitle, isPiAgentTitle, isClaudeManagementTitle, isClaudeAgent, and getAgentLabel (same 19 branches, same order). The test file at src/shared/terminal-title-agent-type.test.ts:139 explicitly says "this module carries its own isClaudeAgent copy parallel to agent-title-identity.ts; both got the identical isCursorAgentTitle guard, so pin this copy directly to catch drift." A Rust port should implement the logic ONCE and have both TS surfaces resolve to it, but the parity harness must exercise BOTH entry points.
What terminal-title-agent-type.ts has that agent-title-identity.ts does NOT: isGrokRotatingWorkingTitle (+ the two GROK regexes), TITLE_LABEL_TO_AGENT, resolveTerminalTitleAgentType, resolveExplicitTerminalTitleAgentType, hasGenericClaudeStatusPrefix, isGenericClaudeStatusClaim.

BRANCH-ORDER CHECKLIST (the four orderings that actually decide outcomes)
1. getAgentLabel: G1 null-abort → G2 OpenCode-marker → G3 Claude-prefix → G4 Gemini → G5 Pi/OMP-synthetic → G6 Pi-legacy → G7..G15 name tokens (codex, openclaude, copilot, grok, devin, antigravity|agy, opencode, mimo, aider) → G16 Cursor closed-set → G17 Droid → G18 Hermes → G19 isClaudeAgent → null.
2. isClaudeAgent: C0 guard(empty | management | opencode) → C1 ✳ → C2 '. '/'* ' → C3 braille (TERMINAL, returns from inside) → C4 trimStart+claude-prefix+claude-token → false.
3. isGeminiTerminalTitle: glyphs → Pi VETO (returns false) → gemini token.
4. resolveExplicit: full ladder → then and only then the Claude-generic-status suppressor.

REACHABILITY NOTES FOR TEST DESIGN
- 'openclaw' is in AGENT_NAMES but has no branch in getAgentLabel: it is unreachable as a label. Do not add one.
- 'claude' and 'cursor' are in AGENT_NAMES but are intentionally never used as getAgentLabel token branches.
- getAgentLabel's range is exactly 16 strings + null; TITLE_LABEL_TO_AGENT covers all 16, so the `?? null` arm is currently dead but must be preserved as the safe default.
- 18 of the 34 TuiAgent union members in src/shared/types.ts:2531 are unreachable through this path (claude-agent-teams, autohand, goose, amp, kilo, kiro, crush, aug, cline, codebuff, command-code, continue, kimi, mistral-vibe, qwen-code, rovo, ante, trae).
- The full pinned corpus lives in src/shared/terminal-title-agent-type.test.ts (HEAD) and is reproduced in the per-export semantics above; port it as the Rust `#[cfg(test)]` module the way orca-core/src/opencode_terminal_title.rs ports its TS twin's cases verbatim.

FILES READ (all via `git show HEAD:` / `git grep … HEAD`, per the read-HEAD-only rule)
/Users/ayates/orca-alab/src/shared/terminal-title-agent-type.ts
/Users/ayates/orca-alab/src/shared/terminal-title-agent-type.test.ts
/Users/ayates/orca-alab/src/shared/agent-name-token-match.ts
/Users/ayates/orca-alab/src/shared/agent-title-core.ts
/Users/ayates/orca-alab/src/shared/agent-title-identity.ts
/Users/ayates/orca-alab/src/shared/opencode-terminal-title.ts
/Users/ayates/orca-alab/src/shared/pi-compatible-synthetic-title.ts
/Users/ayates/orca-alab/src/shared/types.ts
/Users/ayates/orca-alab/rust/crates/orca-core/src/agent_recognition.rs
/Users/ayates/orca-alab/rust/crates/orca-core/src/opencode_terminal_title.rs
/Users/ayates/orca-alab/rust/crates/orca-core/src/js_string.rs
/Users/ayates/orca-alab/rust/crates/orca-core/src/agent_kind.rs
/Users/ayates/orca-alab/rust/crates/orca-core/src/synthetic_agent_title.rs
/Users/ayates/orca-alab/rust/crates/orca-core/Cargo.toml
/Users/ayates/orca-alab/rust/crates/orca-text/Cargo.toml
/Users/ayates/orca-alab/rust/crates/orca-dispatch/src/modules/agent_recognition.rs
Nothing was written, staged, committed, or rebuilt.

### Exports (26)

#### `CLAUDE_IDLE`

```ts
export const CLAUDE_IDLE: string = '✳'
```

Claude Code's idle status prefix glyph. Source spells it as the escape `'✳'` with the comment `// ✳ (eight-spoked asterisk — Claude Code idle prefix)`. Used in three places: `isClaudeAgent` branch C1 (`title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE`), `getAgentLabel` branch G3 (same two tests), and — spelled as a RAW LITERAL rather than the constant — in the module-private `hasGenericClaudeStatusPrefix`. Hexdump of the private helper confirms the raw literal is bytes `e2 9c b3` = the SAME U+2733; there is no second glyph. RUST STATUS: NOT implemented. `git grep -n "2733" HEAD -- rust/crates` returns nothing; no Rust crate defines this constant.

Unicode literals: `U+2733 ✳ EIGHT SPOKED ASTERISK (UTF-8 e2 9c b3)`

#### `GEMINI_WORKING`

```ts
export const GEMINI_WORKING: string = '✦'
```

Gemini CLI 'working' OSC glyph. Consumed only by `isGeminiTerminalTitle` step 1 as a `String.prototype.includes` substring probe (case-sensitive, anywhere in the title). Never used as a prefix test. RUST STATUS: NOT implemented (no `2726` in rust/crates).

Unicode literals: `U+2726 ✦ BLACK FOUR POINTED STAR`

#### `GEMINI_SILENT_WORKING`

```ts
export const GEMINI_SILENT_WORKING: string = '⏲'
```

Gemini CLI 'silent working' glyph. Consumed only by `isGeminiTerminalTitle` step 1 as a substring probe. Note the source uses uppercase hex `⏲` here while the twin in agent-title-core.ts spells it lowercase `⏲` — same code point, no behavioural difference. RUST STATUS: NOT implemented.

Unicode literals: `U+23F2 ⏲ TIMER CLOCK`

#### `GEMINI_IDLE`

```ts
export const GEMINI_IDLE: string = '◇'
```

Gemini CLI 'idle' glyph. Consumed only by `isGeminiTerminalTitle` step 1 as a substring probe. RUST STATUS: NOT implemented.

Unicode literals: `U+25C7 ◇ WHITE DIAMOND`

#### `GEMINI_PERMISSION`

```ts
export const GEMINI_PERMISSION: string = '✋'
```

Gemini CLI 'permission / action required' glyph. Consumed only by `isGeminiTerminalTitle` step 1 as a substring probe; it is the FIRST operand of the four-way `||`, though short-circuit order cannot change the boolean result. RUST STATUS: NOT implemented.

Unicode literals: `U+270B ✋ RAISED HAND`

#### `containsBrailleSpinner`

```ts
export function containsBrailleSpinner(title: string): boolean
```

Exact body: `for (const char of title) { const codePoint = char.codePointAt(0); if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) return true } return false`. `for...of` over a JS string iterates CODE POINTS (surrogate pairs are yielded as one two-unit string), so `codePointAt(0)` is that whole code point. Range is inclusive on both ends: U+2800..U+28FF (the full Braille Patterns block, 256 code points, including U+2800 BRAILLE PATTERN BLANK). Empty string → false. `codePoint !== undefined` can only be hit for an empty `char`, which the iterator never yields — it is dead but harmless. Rust: `title.chars().any(|c| ('\u{2800}'..='\u{28FF}').contains(&c))`. RUST STATUS: NOT implemented anywhere in rust/crates.

Unicode literals: `U+2800..U+28FF Braille Patterns block (inclusive), e.g. ⠋ U+280B, ⠴ U+2834, ⠦ U+2826, ⠸ U+2838, ⠙ U+2819`

#### `isGeminiTerminalTitle`

```ts
export function isGeminiTerminalTitle(title: string): boolean
```

THREE-STEP LADDER, order is semantics:
Step 1 (POSITIVE, glyph evidence beats everything): `if (title.includes(GEMINI_PERMISSION) || title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING) || title.includes(GEMINI_IDLE)) return true`. Plain case-sensitive substring search anywhere in the string.
Step 2 (NEGATIVE EARLY RETURN — the trap): `if (isPiAgentTitle(title)) return false`. A Pi-compatible title can never be Gemini, even if it contains the token `gemini`. This branch must come BEFORE step 3, and it must return false, not fall through.
Step 3: `return titleHasAgentName(title, 'gemini')` — whole-token match, not substring.
Bit-for-bit identical to the copy in src/shared/agent-title-core.ts. RUST STATUS: NOT implemented (step 3's `title_has_agent_name` IS available in orca-core; steps 1-2 are not).

#### `isPiTerminalTitle`

```ts
export function isPiTerminalTitle(title: string): boolean
```

`return isLegacyPiCompatibleTitle(title) && !containsBrailleSpinner(title)` — a Pi-compatible title with NO braille spinner, i.e. Pi at rest. Evaluation order: the Pi regex first, spinner scan second (short-circuit). NOT used by this module's own ladder (`getAgentLabel` uses `isPiAgentTitle`, the spinner-agnostic sibling); it is exported for src/shared/agent-title-status.ts:181, src/shared/terminal-title-status.ts:123, src/shared/agent-detection.ts and src/renderer/src/components/terminal-pane/title-agent-identity.ts:25. Duplicate of agent-title-core.ts:68. RUST STATUS: NOT implemented; `is_legacy_pi_compatible_title` is not ported either.

#### `isGrokRotatingWorkingTitle`

```ts
export function isGrokRotatingWorkingTitle(title: string): boolean
```

TWO-STEP: `if (!containsBrailleSpinner(title)) return false;` then `return GROK_ROTATING_FRAME_RE.test(title) || GROK_COLLAPSED_WORKING_TITLE_RE.test(title)`. The spinner gate is logically redundant (both regexes are anchored on `[⠀-⣿]+`) but is a cheap pre-filter — keep it for shape fidelity, it cannot change the result. Not part of `getAgentLabel`; the sole production caller is src/shared/agent-title-status.ts:146 (activity/status, not identity).
Pinned truth table from src/shared/terminal-title-agent-type.test.ts:
TRUE: '⠋ - Waiting for response… - grok', '⠴ - Thinking - grok', '⠦ - Sleep 2s then echo hello… - grok', '⠋ grok', '⠋ Grok'.
FALSE: 'grok', 'Fix the auth bug - grok', '⠋ debugging grok - claude', '⠋ ~/grok-scratch/ready', '⠋ grokking the plan', '⠋ Codex', '⠋ wire up grok', '⠋ Codex is thinking about grok', '⠋ support for Grok', '⠋ fix the flaky suite - grok', '⠋ review grok integration - claude'.
The discriminator between '⠋ - Thinking - grok' (true) and '⠋ fix the flaky suite - grok' (false) is the mandatory POST-SPINNER ` - ` delimiter. RUST STATUS: NOT implemented.

Unicode literals: `U+2800..U+28FF in both regex classes`, `the test corpus uses U+2026 … HORIZONTAL ELLIPSIS inside the rotating phrase — matched by [\s\S]+?, no special handling`

#### `isPiAgentTitle`

```ts
export function isPiAgentTitle(title: string): boolean
```

Pure one-line delegation: `return isLegacyPiCompatibleTitle(title)`. Spinner-agnostic (unlike `isPiTerminalTitle`). This is the predicate used by `isGeminiTerminalTitle` step 2 and `getAgentLabel` branch G6. Duplicate of agent-title-core.ts:72. RUST STATUS: NOT implemented.

#### `isClaudeAgent`

```ts
export function isClaudeAgent(title: string): boolean
```

FIVE-BRANCH LADDER. Order is semantics; every branch is a return, none falls through except C4's compound test.
C0 GUARD: `if (!title || isClaudeManagementTitle(title) || isOpenCodeNativeTitle(title)) return false`. `!title` is JS string falsiness — TRUE ONLY FOR THE EMPTY STRING (a whitespace-only title is truthy and proceeds). Evaluation order is left-to-right with short-circuit.
C-pre: `const lower = title.toLowerCase()` is computed unconditionally right after C0, but is READ ONLY inside branch C3.
C1: `if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) return true` — i.e. starts with "✳"+U+0020, or is exactly the bare glyph with no surrounding whitespace.
C2: `if (title.startsWith('. ') || title.startsWith('* ')) return true` — literal ASCII "dot space" (working) and "asterisk space" (idle). Note: bare '.' or '*' with nothing after does NOT match; the trailing space is required.
C3 TERMINAL BRAILLE BRANCH: `if (containsBrailleSpinner(title)) { return !isCursorAgentTitle(title) && !lower.includes('openclaude') }`. This RETURNS from inside — a braille title that is a Cursor identity title, or whose lowercased form contains the SUBSTRING 'openclaude', yields false and NEVER reaches C4. Note `lower.includes('openclaude')` is a deliberate SUBSTRING test, not `titleHasAgentName`.
C4: `const trimmedTitle = title.trimStart(); if (trimmedTitle.toLowerCase().startsWith('claude') && titleHasAgentName(trimmedTitle, 'claude')) return true`. Both sub-tests run on the LEADING-TRIMMED string (`trimStart`, not `trim`). The prefix test is a cheap pre-filter; the token test is the real gate (so 'claude-scratch' fails on the token boundary, and 'fixing claude bug' fails on the prefix).
C5: `return false`.
Pinned by tests: isClaudeAgent('⠋ Cursor Agent')===false, ('Cursor ready')===false, ('⠋ preserve cursor visibility across replays')===true, ('⠋ OpenClaude')===false, ('OC | ⠋ implementing the feature')===false, ('OC | Understand about the plugin')===false.
NOTE: src/shared/agent-title-identity.ts carries a parallel copy of this function; the two bodies are behaviourally identical (only C4's final `return` is written as an expression there). RUST STATUS: NOT implemented.

Unicode literals: `U+2733 ✳ via CLAUDE_IDLE`, `U+0020 SPACE is load-bearing in '✳ ', '. ', '* '`

#### `isClaudeManagementTitle`

```ts
export function isClaudeManagementTitle(title: string): boolean
```

`return CLAUDE_MANAGEMENT_TITLE_RE.test(title)` — matches the `claude agents` management/roster invocation, which must be classified as NOT-an-agent-pane (getAgentLabel returns null for it, before even the OpenCode check). Regex given in full under the private entry CLAUDE_MANAGEMENT_TITLE_RE. Duplicate of agent-title-core.ts:100 (which builds the identical pattern from a shared CLAUDE_COMMAND_RE fragment). RUST STATUS: NOT implemented.

#### `getAgentLabel`

```ts
export function getAgentLabel(title: string): string | null
```

THE MAIN CLASSIFICATION LADDER — 19 sequential `if` branches then `return null`. EACH BRANCH RETURNS; there is no accumulation, no scoring, no 'best match'. Reordering any pair changes behaviour. Exact order, with the exact returned label string:
G1  `isClaudeManagementTitle(title)` → return **null**  (an EARLY NULL, not a fallthrough — `claude agents` must not become a Claude pane)
G2  `isOpenCodeNativeTitle(title)` → 'OpenCode'  (the `OC | …` marker owns the whole title; its session text may contain other agents' names AND status glyphs)
G3  `title.startsWith('✳ ') || title === '✳' || title.startsWith('. ') || title.startsWith('* ')` → 'Claude Code'  (spelled `${CLAUDE_IDLE} ` and `CLAUDE_IDLE`; the four operands are one `if` with `||`)
G4  `isGeminiTerminalTitle(title)` → 'Gemini CLI'
G5  `const piCompatibleSyntheticAgentLabel = getPiCompatibleSyntheticAgentLabel(title); if (piCompatibleSyntheticAgentLabel)` → return that value, which is **'Pi' or 'OMP'**  (truthiness test on a `'Pi'|'OMP'|null`; this is the ONLY branch that can produce 'OMP')
G6  `isPiAgentTitle(title)` → 'Pi'
G7  `titleHasAgentName(title, 'codex')` → 'Codex'
G8  `titleHasAgentName(title, 'openclaude')` → 'OpenClaude'
G9  `titleHasAgentName(title, 'copilot')` → 'GitHub Copilot'
G10 `titleHasAgentName(title, 'grok')` → 'Grok'
G11 `titleHasAgentName(title, 'devin')` → 'Devin'
G12 `titleHasAgentName(title, 'antigravity') || AGY_AGENT_NAME_RE.test(title)` → 'Antigravity'  (two alternatives in ONE branch, antigravity token first, then the `agy` regex)
G13 `titleHasAgentName(title, 'opencode')` → 'OpenCode'
G14 `titleHasAgentName(title, 'mimo')` → 'MiMo Code'
G15 `titleHasAgentName(title, 'aider')` → 'Aider'
G16 `isCursorAgentTitle(title)` → 'Cursor'  (closed title set, NOT a `cursor` token match — deliberately placed BEFORE G19 so a braille Cursor frame is not claimed by Claude)
G17 `DROID_AGENT_NAME_RE.test(title)` → 'Droid'
G18 `HERMES_AGENT_NAME_RE.test(title)` → 'Hermes'
G19 `isClaudeAgent(title)` → 'Claude Code'  (the generic braille/prefix heuristic; LAST on purpose)
G20 `return null`.
STRUCTURAL FACTS A PORT MUST PRESERVE: (a) there is NO `titleHasAgentName(title,'claude')` branch — Claude is reachable only via G3's prefixes or G19; (b) there is NO `titleHasAgentName(title,'cursor')` branch — `cursor` is ordinary editor vocabulary; (c) `'openclaw'` is a member of AGENT_NAMES but has NO branch here, so it can never be labelled; (d) the complete range of this function is exactly the 16 strings {'OpenCode','Claude Code','Gemini CLI','Pi','OMP','Codex','OpenClaude','GitHub Copilot','Grok','Devin','Antigravity','MiMo Code','Aider','Cursor','Droid','Hermes'} plus null.
src/shared/agent-title-identity.ts exports a parallel `getAgentLabel` with the SAME 19 branches in the SAME order (only comments differ) — keep them in lockstep. RUST STATUS: NOT implemented.

Unicode literals: `U+2733 ✳ (via CLAUDE_IDLE in G3)`

#### `resolveTerminalTitleAgentType`

```ts
export function resolveTerminalTitleAgentType(title: string): TuiAgent | null
```

Exact body: `const label = getAgentLabel(title); return label ? (TITLE_LABEL_TO_AGENT[label] ?? null) : null`. Two nullish steps: a falsy label (only `null` in practice — no branch returns '') short-circuits to null, and an unmapped label falls to null via `??`. The map is exhaustive over getAgentLabel's 16-value range, so in practice `resolveTerminalTitleAgentType(t) === null ⟺ getAgentLabel(t) === null`; keep the `?? null` anyway.
Pinned by tests: ('⠋ Cursor Agent')→'cursor', ('Cursor Agent')→'cursor', ('Cursor ready')→'cursor', ('Cursor - action required')→'cursor', ('⠋ preserve cursor visibility across replays')→'claude', ('⠋ Codex: fix cursor offsets')→'codex', ('OC | ⠋ implementing the feature')→'opencode'. RUST STATUS: NOT implemented; no dispatch entry exists (rust/crates/orca-dispatch/src/modules/agent_recognition.rs registers only titleHasAgentName / titleHasAnyLegacyAgentName / isExpectedAgentProcess).

#### `resolveExplicitTerminalTitleAgentType`

```ts
export function resolveExplicitTerminalTitleAgentType(title: string): TuiAgent | null
```

Exact body: `const titleAgent = resolveTerminalTitleAgentType(title); if (isGenericClaudeStatusClaim(title, titleAgent)) return null; return titleAgent`. Strictly a post-filter: it can only turn `'claude'` into `null`, never change any other id and never produce a new one. Doc comment: Claude's bare status prefixes (spinner / '✳' / '. ' / '* ') are ACTIVITY evidence, not IDENTITY — a task or worktree title cannot become Claude without an explicit `claude` name token.
Pinned by tests — mapped: ('✳ Claude Code')→'claude', ('⠋ Codex')→'codex', ('✦ Gemini CLI')→'gemini', ('MiMo Code')→'mimo-code', ('⠋ OpenClaude')→'openclaude', ('OMP')→'omp', ('Cursor Agent')→'cursor', ('⠋ Cursor Agent')→'cursor', ('Cursor ready')→'cursor', ('Cursor - action required')→'cursor', ('Pi ready')→'pi', ('OpenCode ready')→'opencode', ('OC | Understand about the plugin')→'opencode', ('OC | Compare Codex and Claude')→'opencode', ('OC | ✦ Gemini CLI')→'opencode', ('tmux | OC | ses_123')→'opencode', ('OC|compact-session')→'opencode', ('. Claude Code compare Opencode')→'claude'.
Suppressed to null: ('✳ investigating startup'), ('⠸ investigating startup'), ('. Compare Opencode Vs Orca'), ('* Review Codex behavior'), ('⠋ preserve cursor visibility across replays'), ('~/cursor-rules'), ('⠋ Fix foo | OC | bar'), ('oc | Understand about the plugin'), ('Terminal 1'), ('zsh').
Note '. Compare Opencode Vs Orca' → suppressed even though it contains 'Opencode': G3 fires first and yields 'Claude Code', then the suppressor kills it — the OpenCode branches G2/G13 are never reached. RUST STATUS: NOT implemented.

#### `CLAUDE_MANAGEMENT_TITLE_RE (module-private)`

```ts
const CLAUDE_MANAGEMENT_TITLE_RE: RegExp
```

Verbatim source (single line, only the `i` flag — NO `u`, NO `m`, NO `g`):
/^\s*(?:"(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?"|'(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?'|(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?)\s+agents\s*$/i
Structure: optional leading `\s*`; then one of three alternatives tried in order — double-quoted command, single-quoted command, bare command; each is `(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?` i.e. an optional path prefix ending in `/` or `\`, the literal `claude`, and an optional Windows extension; then `\s+agents\s*$`. `.` excludes line terminators; `$` is end-of-input (no `m`). Matches e.g. `claude agents`, `  /usr/local/bin/claude agents `, `"C:\\bin\\claude.exe" agents`, `CLAUDE AGENTS`. Does not match `claude agents now` (trailing text) or `claude  agent`. Identical to the pattern agent-title-core.ts builds via CLAUDE_COMMAND_RE. RUST STATUS: NOT implemented.

#### `GROK_ROTATING_FRAME_RE (module-private)`

```ts
const GROK_ROTATING_FRAME_RE: RegExp
```

Verbatim: /^[⠀-⣿]+\s+-\s+[\s\S]+?\s-\s+grok\s*$/i — flags: `i` only.
Segment by segment: `^` start-of-input; `[⠀-⣿]+` ONE OR MORE braille chars; `\s+` one-or-more JS-whitespace; `-` literal hyphen-minus U+002D; `\s+`; `[\s\S]+?` LAZY one-or-more of ANY char including line terminators (the rotating phrase, ≥1 char); `\s` EXACTLY ONE whitespace (NOTE the asymmetry — the left side of this hyphen is `\s`, the right side is `\s+`); `-` literal hyphen; `\s+`; `grok` case-insensitive; `\s*$` optional trailing whitespace then end-of-input.
Because the function only does `.test()`, the laziness of `[\s\S]+?` cannot change the boolean — a greedy port is observationally equivalent for `is_match`. RUST STATUS: NOT implemented.

Unicode literals: `U+2800..U+28FF (character class)`, `U+002D HYPHEN-MINUS (two literal occurrences)`

#### `GROK_COLLAPSED_WORKING_TITLE_RE (module-private)`

```ts
const GROK_COLLAPSED_WORKING_TITLE_RE: RegExp
```

Verbatim: /^[⠀-⣿]+\s+grok\s*$/i — flags: `i` only. Braille run, whitespace run, the literal `grok` (case-insensitive), optional trailing whitespace, end-of-input. Exists so Orca's OWN collapsed label ('⠋ Grok') re-detects as working under re-normalization (idempotence). RUST STATUS: NOT implemented.

Unicode literals: `U+2800..U+28FF (character class)`

#### `TITLE_LABEL_TO_AGENT (module-private)`

```ts
const TITLE_LABEL_TO_AGENT: Partial<Record<string, TuiAgent>>
```

Object literal, 16 entries, in this source order (order is NOT semantic — it is a keyed lookup):
'Claude Code' → 'claude'
'OpenClaude'  → 'openclaude'   (written unquoted as `OpenClaude:` in source)
'Codex'       → 'codex'        (unquoted key)
'Gemini CLI'  → 'gemini'
'GitHub Copilot' → 'copilot'
'Grok'        → 'grok'         (unquoted key)
'Devin'       → 'devin'        (unquoted key)
'Antigravity' → 'antigravity'  (unquoted key)
'OpenCode'    → 'opencode'     (unquoted key)
'MiMo Code'   → 'mimo-code'
'Aider'       → 'aider'        (unquoted key)
'Cursor'      → 'cursor'       (unquoted key)
'Droid'       → 'droid'        (unquoted key)
'Hermes'      → 'hermes'       (unquoted key)
'Pi'          → 'pi'           (unquoted key)
'OMP'         → 'omp'          (unquoted key)
Every one of getAgentLabel's 16 possible labels is present, so the map is total over the ladder's range. All 16 target ids are members of the `TuiAgent` union in src/shared/types.ts:2531 (which has 34 members total; the other 18 are unreachable through this path). Rust already carries the id strings in orca-core/src/agent_kind.rs::TUI_AGENT_KIND_PAIRS (as `&str`, no enum). RUST STATUS: the table itself is NOT implemented.

#### `hasGenericClaudeStatusPrefix (module-private)`

```ts
function hasGenericClaudeStatusPrefix(title: string): boolean
```

`return containsBrailleSpinner(title) || title.startsWith('✳ ') || title === '✳' || title.startsWith('. ') || title.startsWith('* ')`. Five operands, left-to-right short-circuit. NOTE: the ✳ here is written as a RAW LITERAL, not via CLAUDE_IDLE; a hexdump of HEAD confirms both are U+2733 (e2 9c b3), so there is no hidden second glyph. This is a SUPERSET of `isClaudeAgent`'s C1+C2+C3 conditions: it adds the braille test as a first-class disjunct rather than a gated branch. RUST STATUS: NOT implemented.

Unicode literals: `U+2733 ✳ (raw literal, twice: as '✳ ' prefix and as the bare '✳' equality)`

#### `isGenericClaudeStatusClaim (module-private)`

```ts
function isGenericClaudeStatusClaim(title: string, titleAgent: TuiAgent | null): boolean
```

`return titleAgent === 'claude' && hasGenericClaudeStatusPrefix(title) && !titleHasAgentName(title, 'claude')`. THREE conjuncts, left-to-right: (1) the ladder already resolved to Claude; (2) the title carries one of Claude's generic status prefixes; (3) the title does NOT contain `claude` as a whole token. All three must hold to suppress. Conjunct (3) uses the RAW `title`, whereas `isClaudeAgent` branch C4 token-matches `title.trimStart()` — preserve the literal difference (it is behaviourally inert because whitespace is not a token-boundary char, but a port should not silently unify them). RUST STATUS: NOT implemented.

#### `titleHasAgentName (imported from ./agent-name-token-match)`

```ts
export function titleHasAgentName(title: string, name: string): boolean
```

SPEC INCLUDED BECAUSE THE PORT NEEDS IT. `return AGENT_NAME_RE_BY_NAME.get(name)?.test(title) ?? false` — a `name` outside AGENT_NAMES yields false, never throws. Per-name regex from `buildAgentNameRe(name)`: new RegExp(`(?<![\\w./\\\\-])${name}(?:(?:\\.(?:exe|cmd|bat|ps1)))?(?![\\w./\\\\-])`, 'i') — i.e. a negative lookbehind for `[\w./\\-]`, the name, an OPTIONAL Windows exe suffix (.exe/.cmd/.bat/.ps1), and a negative lookahead for `[\w./\\-]`. Flags: `i` only (no `u`), so `\w` is ASCII `[A-Za-z0-9_]`.
AGENT_NAMES (source order, 13): claude, openclaude, codex, copilot, cursor, gemini, antigravity, opencode, mimo, openclaw, aider, grok, devin.
Sibling regexes also imported by this module, all `i`-only, all WITHOUT the exe suffix:
  DROID_AGENT_NAME_RE  = /(?<![\w./\\-])droid(?![\w./\\-])/i
  HERMES_AGENT_NAME_RE = /(?<![\w./\\-])hermes(?![\w./\\-])/i
  AGY_AGENT_NAME_RE    = /(?<![\w./\\-])agy(?![\w./\\-])/i
RUST STATUS: **IMPLEMENTED**. orca-core/src/agent_recognition.rs:96 `title_has_agent_name(&str,&str)->bool` (guards membership in `AGENT_NAMES`, then `title_has_token(title,name,true)`); the three sibling regexes are `title_has_droid` / `title_has_hermes` / `title_has_agy`, all `title_has_token(..., false)`. Boundary predicate `is_boundary_char` = `c.is_ascii_alphanumeric() || matches!(c, '_'|'.'|'/'|'\\'|'-')` — correctly ASCII, matching the non-`u` JS `\w`. Case folding is deliberately `to_ascii_lowercase`, with a regression test (`token_match_uses_ascii_fold_like_the_js_regex_i_flag`) pinning that U+212A must NOT fold. Also exposed over dispatch as `titleHasAgentName` in orca-dispatch/src/modules/agent_recognition.rs.

#### `isOpenCodeNativeTitle (imported from ./opencode-terminal-title)`

```ts
export function isOpenCodeNativeTitle(title: string | null | undefined): boolean
```

SPEC INCLUDED BECAUSE THE PORT NEEDS IT. `return OPENCODE_NATIVE_TITLE_RE.test(title?.trim() ?? '')` where OPENCODE_NATIVE_TITLE_RE = /^(?:[^|\s]+ \| )?OC\s*\|\s*\S/u (flags: `u` only — CASE-SENSITIVE). Note the input is JS-`.trim()`ed first. Optional single-token multiplexer frame `[^|\s]+` followed by a LITERAL space-pipe-space; then case-sensitive `OC`, `\s*`, `|`, `\s*`, and at least one non-whitespace char. Not anchored at the end. Pinned: 'OC | Native Stable Session' true, '  OC|Session  ' true, 'tmux | OC | ses_123' true, 'OC \t | \t x' true, 'tmux\t| OC | x' FALSE (the multiplexer separator must be exactly ' | '), '⠋ Fix foo | OC | bar' FALSE, 'my session | OC | task' FALSE (prefix is two tokens), 'oc | …' FALSE (case).
RUST STATUS: **IMPLEMENTED**. orca-core/src/opencode_terminal_title.rs:16 `is_opencode_native_title(Option<&str>)->bool`, hand-rolled (zero-dep crate) using `trim_js`/`is_js_trim_ws` so the `\s` class matches ECMAScript exactly. `is_meaningful_opencode_terminal_title` is the same function under the TS alias.

#### `isCursorAgentTitle (imported from ./agent-title-core)`

```ts
export function isCursorAgentTitle(title: string | null | undefined): boolean
```

SPEC INCLUDED BECAUSE THE PORT NEEDS IT. Body order: (1) `if (typeof title !== 'string') return false`; (2) `const trimmed = title.trim(); const lower = trimmed.toLowerCase()`; (3) `if (lower === 'cursor agent' || lower === 'cursor ready' || lower === 'cursor - action required') return true` — three exact, case-insensitive, whitespace-trimmed literals (CURSOR_NATIVE_TITLE_LOWER is the first); (4) `return /^[⠀-⣿] Cursor Agent$/u.test(trimmed)` — CASE-SENSITIVE, EXACTLY ONE braille char (no `+`), exactly one ASCII space, the literal 'Cursor Agent', anchored both ends against the TRIMMED string. So '⠋ Cursor Agent' is Cursor but '⠋ cursor agent' is NOT, and '⠋⠙ Cursor Agent' is NOT. This closed set is deliberately narrow because `cursor` is ordinary editor vocabulary. RUST STATUS: NOT implemented (`git grep -n "Cursor Agent" HEAD -- rust/crates` hits only the `working_label` string in synthetic_agent_title.rs, which is a different concern).

Unicode literals: `U+2800..U+28FF (single-char class in the synthetic-title regex)`

#### `isLegacyPiCompatibleTitle (imported from ./pi-compatible-synthetic-title)`

```ts
export function isLegacyPiCompatibleTitle(title: string): boolean
```

SPEC INCLUDED BECAUSE THE PORT NEEDS IT. `return LEGACY_PI_COMPATIBLE_TITLE_RE.test(title)` where LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?π(?:\s*[-:]|\s)\s*.*$/u — flags: `u` ONLY, NO `i` (so U+03C0 π matches but U+03A0 Π does not). Structure: optional leading whitespace; an OPTIONAL group of exactly ONE braille char plus one-or-more whitespace; the literal π; then EITHER `\s*[-:]` (optional whitespace then a hyphen or colon) OR a single `\s`; then `\s*`; then `.*$`. Because there is no `s` flag, `.` excludes line terminators, and `$` (no `m`) is end-of-input — so a title containing a newline/CR/U+2028/U+2029 after the π delimiter does NOT match. RUST STATUS: NOT implemented.

Unicode literals: `U+03C0 π GREEK SMALL LETTER PI (case-sensitive literal)`, `U+2800..U+28FF (single-char optional class)`, `U+002D HYPHEN-MINUS / U+003A COLON in the [-:] class`

#### `getPiCompatibleSyntheticAgentLabel (imported from ./pi-compatible-synthetic-title)`

```ts
export function getPiCompatibleSyntheticAgentLabel(title: string): 'Pi' | 'OMP' | null
```

SPEC INCLUDED BECAUSE THE PORT NEEDS IT. `const match = PI_COMPATIBLE_SYNTHETIC_TITLE_RE.exec(title); if (!match) return null; return match[1].toLowerCase() === 'omp' ? 'OMP' : 'Pi'` where PI_COMPATIBLE_SYNTHETIC_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?(pi|omp)(?:\s+-\s+action required|\s+(?:ready|idle|done))?\s*$/i — flags: `i` ONLY (no `u`). The whole title must be exactly: optional leading whitespace, an OPTIONAL single braille char plus whitespace, the captured name `pi` or `omp`, an OPTIONAL status suffix (either ` - action required` with `\s+-\s+` spacing, or one of `ready`/`idle`/`done` after `\s+`), then optional trailing whitespace to end-of-input. Capture group 1 decides the label via an ASCII-lowercase comparison against 'omp'. This is the ONLY producer of the 'OMP' label in the whole ladder. RUST STATUS: NOT implemented (grep for `PI_COMPATIBLE` in rust/crates hits only the unrelated `title_identity_group: Some("pi-compatible")` field in synthetic_agent_title.rs).

Unicode literals: `U+2800..U+28FF (single-char optional class)`, `U+002D HYPHEN-MINUS in the ' - action required' suffix`

### Hazards (22)

| Where | JS semantic | Rust trap | Example |
| --- | --- | --- | --- |
| Every regex in the transitive closure: CLAUDE_MANAGEMENT_TITLE_RE (`^\s*`, `\s+agents`, `\s*$`), both GROK regexes, PI_COMPATIBLE_SYNTHETIC_TITLE_RE, LEGACY_PI_COMPATIBLE_TITLE_RE, OPENCODE_NATIVE_TITLE_RE (`[^\|\s]+`, `\s*`) | ECMAScript `\s` = WhiteSpace + LineTerminator = [\t\n\v\f\r    -     　﻿]. It INCLUDES U+FEFF (BOM/ZWNBSP) and EXCLUDES U+0085 (NEL). | Rust `regex`'s `\s` is Unicode White_Space: it EXCLUDES U+FEFF and INCLUDES U+0085 — inverted on exactly the two code points that matter. `char::is_whitespace` has the same inversion. Use `orca_core::js_string::is_js_trim_ws` as the `\s` predicate (rust/crates/orca-core/src/opencode_terminal_title.rs already does this and documents it), or spell the class out literally. | '\u{FEFF}claude agents' → JS isClaudeManagementTitle true (getAgentLabel returns null); Rust `\s*` false → falls through to G19 and mislabels as Claude Code. Conversely 'claude\u{0085}agents' → JS false; Rust `\s+` true → wrongly suppressed to null. |
| isClaudeAgent branch C4: `const trimmedTitle = title.trimStart()` | `String.prototype.trimStart` strips the ECMAScript trim set — strips U+FEFF, keeps U+0085. It trims the LEADING side only. | `str::trim_start()` does the opposite on those two code points, and a porter may also reach for full `trim()`. Use `title.trim_start_matches(orca_core::js_string::is_js_trim_ws)`. Do NOT unify with the full `.trim()` used by isCursorAgentTitle and isOpenCodeNativeTitle — this module uses BOTH kinds and the asymmetry is intentional. | '\u{FEFF}claude ready' → JS trimStart yields 'claude ready', prefix+token both pass → isClaudeAgent true. Rust `trim_start` leaves the BOM → startsWith('claude') false → isClaudeAgent false. Mirror case: '\u{85}claude ready' → JS false, Rust `trim_start` true. |
| Regex `i` flag on CLAUDE_MANAGEMENT_TITLE_RE, both GROK regexes, PI_COMPATIBLE_SYNTHETIC_TITLE_RE, buildAgentNameRe, DROID/HERMES/AGY_AGENT_NAME_RE | For a non-`u` regex the `i` flag uses ECMAScript Canonicalize (toUpperCase on the single char, rejected if it changes length or maps non-ASCII→ASCII). U+212A KELVIN SIGN does NOT fold to 'k'; U+017F LATIN SMALL LETTER LONG S does NOT fold to 's'. | Rust `regex` `(?i)` applies Unicode simple case folding, which DOES fold U+212A→k and U+017F→s. Use ASCII-only case insensitivity — `(?i-u:grok)` in the regex crate, or hand-roll with `to_ascii_lowercase` as orca-core/src/agent_recognition.rs::title_has_token already does (it carries the pinning test `token_match_uses_ascii_fold_like_the_js_regex_i_flag`). | '⠋ gro\u{212A}' → JS GROK_COLLAPSED_WORKING_TITLE_RE false, so isGrokRotatingWorkingTitle false. Rust `(?i)^[\u{2800}-\u{28FF}]+\s+grok\s*$` matches → true. |
| buildAgentNameRe / DROID / HERMES / AGY regexes: the boundary guards `(?<![\w./\\-])` and `(?![\w./\\-])` | Lookbehind + lookahead over ASCII `\w` (`[A-Za-z0-9_]`, because none of these regexes carry the `u` flag) plus `.`, `/`, `\`, `-`. | The Rust `regex` crate has NO lookbehind at all, so the pattern cannot be transcribed. It must be hand-rolled — and the hand-roll must use an ASCII boundary predicate, because Rust's `\w` is Unicode by default and would treat 'é' or '日' as a boundary char. | '日claude' → JS: '日' is not ASCII `\w`, lookbehind passes → titleHasAgentName true → getAgentLabel G19/'Claude Code'. A Rust port using Unicode `\w` (or `char::is_alphanumeric`) sees a word char → false → label null. |
| isClaudeAgent branch C0: `if (!title \|\| …) return false` | `!title` on a string is true ONLY for the empty string ''. A whitespace-only title ('   ') is truthy and proceeds through the ladder. | Writing `title.trim().is_empty()` (or the JS-trim variant) widens the guard and short-circuits whitespace-only titles that JS lets through. Use `title.is_empty()` exactly. | '   ' → JS: C0 passes, C1/C2/C3 all false, C4 trimStart gives '' which does not start with 'claude' → false. Same answer here, but '  ✳ Claude Code' shows the difference in spirit: C0 must not pre-trim, and C1's `startsWith('✳ ')` then correctly FAILS on the leading spaces (the title falls to C4 instead). |
| isClaudeAgent branch C3: `!lower.includes('openclaude')` | A deliberate SUBSTRING test on the fully lowercased title — categorically different from the token matching used everywhere else in the module. | 'Fixing' this to `title_has_agent_name(title, "openclaude")` for consistency changes behaviour on hyphenated/path forms. Keep it as `lowered.contains("openclaude")`. | '⠋ ~/openclaude-scratch' → JS: C3 substring hit → isClaudeAgent FALSE. With a token match the trailing '-' is a boundary char → no token → isClaudeAgent TRUE, and getAgentLabel would return 'Claude Code' at G19 instead of null. |
| isClaudeAgent branch C3 as a whole | The braille branch `return`s from INSIDE the `if` — it is terminal for every braille-bearing title. Branch C4's `claude`-prefix/token test is unreachable whenever the title contains any U+2800..U+28FF char. | Flattening the ladder into a single boolean expression (`… \|\| contains_braille && …\|\| starts_with_claude && …`) restores reachability to C4 and changes results. | '⠋ Cursor Agent claude' → JS: C3 fires, isCursorAgentTitle('⠋ Cursor Agent claude') is false (not the closed set) and no 'openclaude' → returns TRUE at C3. But '⠋ Cursor Agent' → C3 returns FALSE and never reaches C4, even though C4 would also have said false. The load-bearing case is a Cursor identity title that also names claude: '⠋ Cursor Agent' with C3 removed would fall to C4 → different. |
| isGeminiTerminalTitle step 2: `if (isPiAgentTitle(title)) return false` | A NEGATIVE early return sitting between the glyph test and the name-token test. A Pi title vetoes Gemini identity outright. | Porting the function as `has_gemini_glyph(t) \|\| title_has_agent_name(t, "gemini")` drops the veto; porting it as `… && !is_pi_agent_title(t)` at the end also drops it (the glyph branch must still win over Pi). | 'π - gemini notes' → JS: no Gemini glyph, isPiAgentTitle true → returns FALSE, so getAgentLabel skips G4 and lands on G6 → 'Pi' → 'pi'. Drop the veto and G4 fires → 'Gemini CLI' → 'gemini'. Meanwhile 'π - ✦ working' still returns TRUE (glyph beats Pi) → 'Gemini CLI'. |
| getAgentLabel branch ORDER, specifically G3 (Claude prefixes) sitting above G4/G5/G6/G7-G18 | A bare '. '/'* '/'✳ ' prefix claims 'Claude Code' before any name token, Gemini glyph, Pi form, or Cursor title is examined. | Sorting the branches by 'specificity' (name tokens first, generic prefixes last) is the natural refactor and it is wrong. | '. Compare Opencode Vs Orca' → JS: G3 → 'Claude Code' → 'claude' (then resolveExplicit suppresses to null). Move the name-token branches above G3 and G13 fires → 'OpenCode' → 'opencode', which resolveExplicit will NOT suppress. |
| getAgentLabel branch ORDER, G7-G18 (name tokens / Cursor / Droid / Hermes) sitting above G19 (isClaudeAgent) | Named agents also emit braille spinners, so every explicit name must be tested before Claude's generic braille heuristic. | Calling `is_claude_agent` early (it is the 'main' predicate and reads like a natural first check) makes every spinner-bearing title Claude. | '⠋ Codex' → JS: G7 → 'Codex' → 'codex'. With G19 hoisted: isClaudeAgent C3 braille → true → 'Claude Code' → 'claude'. Test src/shared/terminal-title-agent-type.test.ts pins 'codex'. |
| getAgentLabel branch G16 (isCursorAgentTitle) sitting above G19, and the ABSENCE of a `titleHasAgentName(title,'cursor')` branch | Cursor is recognised only by a closed 4-form title set; a bare `cursor` token is task vocabulary, not identity. | Adding `title_has_agent_name(title, "cursor") => "Cursor"` for symmetry with the other 9 token branches ('cursor' IS in AGENT_NAMES, which makes the omission look like a bug) reclassifies ordinary Claude/Codex work. | '⠋ preserve cursor visibility across replays' → JS: G16 false, G19 isClaudeAgent C3 true → 'Claude Code' → 'claude' (pinned by test). Add a cursor token branch and it becomes 'cursor'. Same for '⠋ Codex: fix cursor offsets', pinned as 'codex'. |
| getAgentLabel branch G1: `if (isClaudeManagementTitle(title)) return null` | An EARLY NULL — the only branch that returns null before the ladder ends. It is not a 'skip Claude' guard; it aborts the whole classification. | Porting it as a guard inside the Claude branches (or as `if !is_management { … claude … }`) lets a management title reach the name-token branches. | '/usr/local/bin/claude agents' → JS: G1 → null. Demote the check into G19 only and G19's isClaudeAgent already returns false at its own C0 → still null here; but '"claude.exe" agents' inside a title that also names codex, e.g. 'claude agents' is the pure case — the invariant to preserve is that NOTHING after G1 runs. |
| getAgentLabel branch G5 vs G6, and the fact that 'OMP' is producible only at G5 | `getPiCompatibleSyntheticAgentLabel` is checked (truthiness on a 'Pi'\|'OMP'\|null) BEFORE `isPiAgentTitle`, and only G5 can yield 'OMP'. | Collapsing the two Pi checks into one `if is_pi_agent_title(t) { "Pi" }` silently deletes the entire OMP identity path. | 'OMP' → JS: G5 → 'OMP' → 'omp' (pinned by test `resolveExplicitTerminalTitleAgentType('OMP')` toBe 'omp'). Collapsed: isPiAgentTitle('OMP') is false (LEGACY_PI regex needs π) → falls through to null. |
| LEGACY_PI_COMPATIBLE_TITLE_RE `.*$` with the `u` flag but no `s` and no `m` | JS `.` excludes ALL FOUR line terminators (\n, \r, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR), and `$` without `m` anchors only at end-of-input. | Rust `regex`'s `.` excludes only `\n` — it MATCHES \r, U+2028 and U+2029. Spell the class as `[^\n\r\u{2028}\u{2029}]` (and never enable `(?s)` or `(?m)`). | 'π - fix\rthing' → JS: `.*` cannot cross \r and `$` is at end-of-input → isLegacyPiCompatibleTitle FALSE → isPiAgentTitle false → getAgentLabel skips G6. Rust with a naive `.` → TRUE → labelled 'Pi'. |
| OPENCODE_NATIVE_TITLE_RE multiplexer prefix `(?:[^\|\s]+ \\| )?` — the literal ' \| ' vs the marker's own `\s*\\|\s*` | The optional multiplexer frame requires EXACTLY space-pipe-space (U+0020, U+007C, U+0020), while the OC marker itself accepts any run of `\s` around its pipe. The whole test runs against `title.trim()` and is CASE-SENSITIVE on 'OC'. | Normalising both separators to `\s*\\|\s*` (the obvious simplification) widens acceptance; lowercasing 'OC' widens it further. | 'tmux\t\| OC \| x' → JS FALSE (tab is not the literal space). 'OC \t \| \t x' → JS TRUE. 'oc \| Understand about the plugin' → JS FALSE, pinned by test as null. Note the flow-on: getAgentLabel G2 is the very first non-null branch, so a widened OC match steals identity from every other agent. |
| isCursorAgentTitle's synthetic regex `/^[⠀-⣿] Cursor Agent$/u` | CASE-SENSITIVE (no `i`), EXACTLY ONE braille char (no `+`), EXACTLY ONE ASCII space, anchored both ends against the already-`.trim()`ed string. The three literal comparisons above it, by contrast, ARE case-insensitive (via `.toLowerCase()`). | Adding `(?i)` for consistency with the three literal comparisons, or `+` for consistency with the GROK spinner classes, both widen it. | '⠋ cursor agent' → JS FALSE at both steps → getAgentLabel G16 misses → G19 isClaudeAgent C3 braille → 'Claude Code' → 'claude'. With `(?i)` it becomes 'cursor'. And '⠋⠙ Cursor Agent' → JS FALSE (two spinner chars); with `+` it becomes 'cursor'. |
| containsBrailleSpinner's `for (const char of title)` + `codePointAt(0)` | Code-point iteration: surrogate pairs are yielded whole, so `codePointAt(0)` returns the astral scalar, never a lone surrogate half. | Iterating `title.as_bytes()` (a byte in 0x2800..0x28FF is impossible, so the function would always return false) or iterating UTF-16 units. `title.chars()` is the correct twin. There is NO UTF-16-vs-scalar divergence here because U+2800..U+28FF is entirely BMP. | '⠋ working' (U+280B = e2 a0 8b) → JS true; a byte-wise port sees 0xE2/0xA0/0x8B and returns false. |
| resolveTerminalTitleAgentType: `label ? (TITLE_LABEL_TO_AGENT[label] ?? null) : null` | Two distinct nullish steps — a falsy label short-circuits, and an unmapped label is coalesced with `??` (nullish, not `\|\|`). The plain-object index would also return `undefined` for any key not present as an own property. | Collapsing to a single `HashMap::get(label).copied()` is fine mechanically, but a porter who instead makes the mapping TOTAL (e.g. `_ => TuiAgent::Claude` as a catch-all, or a `From<&str>` with a default) invents identities. Model it as `Option<&str>`/`Option<TuiAgent>` and let unmapped mean None. | getAgentLabel returns one of 16 strings and all 16 are mapped, so no live input reaches the `?? null` today — but a new label added to the ladder without a map entry must yield null, not a default agent. |
| isGenericClaudeStatusClaim's third conjunct `!titleHasAgentName(title, 'claude')` — raw title — vs isClaudeAgent C4's `titleHasAgentName(trimmedTitle, 'claude')` — trimStart'ed | Two calls to the same token matcher on two DIFFERENT strings, ten lines apart. Behaviourally inert (whitespace is not in the boundary class `[\w./\\-]`), but the source distinction is real. | Hoisting a single `let trimmed = …` and reusing it in both places is a silent semantic edit; conversely, a port that trims in the suppressor but NOT in C4 would break C4's `starts_with("claude")` pre-filter. | '  claude ready' → C4: trimStart → 'claude ready', starts_with('claude') true AND token true → isClaudeAgent true. Suppressor: titleHasAgentName('  claude ready','claude') is also true → not suppressed. Same answer, different strings; preserve both call sites verbatim. |
| isClaudeAgent's `title.toLowerCase()` and `trimmedTitle.toLowerCase()` | Full Unicode default case conversion (locale-independent), which can CHANGE LENGTH — e.g. U+0130 İ lowercases to the two code points 'i' + U+0307. | Substituting `to_ascii_lowercase()` or `eq_ignore_ascii_case` for speed. The needles are ASCII ('openclaude', 'claude'), so ASCII folding is *almost* right — but a non-ASCII char that lowercases INTO ASCII (U+212A KELVIN → 'k', U+017F ſ → 's') or that changes length shifts the result. Use `str::to_lowercase()` here. Note this is the OPPOSITE guidance from the regex `i` flag hazard above (regex → ASCII fold; `.toLowerCase()` → full fold): the two must not be unified. | '⠋ OPENCLAUDE' → JS: lower = '⠋ openclaude', C3's substring hit → isClaudeAgent FALSE. A port that skips lowercasing entirely (raw `contains("openclaude")`) returns TRUE → 'Claude Code' instead of the correct G8 'OpenClaude'. |
| GROK_ROTATING_FRAME_RE's tail `\s-\s+grok` — exactly one `\s` on the left of the hyphen, `\s+` on the right | Deliberate asymmetry in the source; the greedy `[\s\S]+?` before it can absorb extra whitespace, so the effective rule is 'at least one whitespace, then hyphen, then at least one whitespace'. | 'Normalising' it to `\s+-\s+` looks harmless and is observationally equivalent for `is_match` — but a porter who instead normalises the OTHER direction (`\s-\s`) drops the required whitespace run after the hyphen. Transcribe verbatim. | '⠴ - Thinking - grok' → true either way. '⠋ - Thinking -grok' → JS false (`\s+` after the second hyphen is unsatisfied); with `\s-\s*` it becomes true. |
| getAgentLabel / resolveTerminalTitleAgentType parameter typing (`title: string`) at runtime | TypeScript types are erased. `getAgentLabel(undefined)` survives G1 (regex `.test(undefined)` coerces to the string 'undefined' → false) and G2 (isOpenCodeNativeTitle handles null/undefined) but THROWS a TypeError at G3's `undefined.startsWith`. `isClaudeAgent(undefined)` returns false at C0 instead. | None in the port itself (`&str` cannot be null), but do NOT add an `Option<&str>` overload that returns `None` for missing input and call it 'parity' — the TS twin throws, so any recorded-golden harness must not feed it null. | getAgentLabel(undefined as unknown as string) → TypeError at line 137; isClaudeAgent(undefined as unknown as string) → false. |

---

## `src/shared/agent-title-core.ts`

> src/shared/agent-title-core.ts (read at HEAD via `git show HEAD:src/shared/agent-title-core.ts`; 132 lines). Direct dependencies, also read at HEAD and specified here because the ladders call into them: src/shared/agent-name-token-match.ts and src/shared/pi-compatible-synthetic-title.ts.

SCOPE / METHOD. Everything below was read with `git show HEAD:<path>` only — no working-tree reads. Regex `.source` strings, flag sets and every truth-table row marked "verified" were produced by re-executing the exact literals in Node in the scratchpad (/private/tmp/.../scratchpad/probe*.mjs), not inferred. Nothing in the repo was modified, staged, or built.

=== WHAT THE MODULE IS ===
A leaf module of pure, side-effect-free predicates and constants over terminal-title strings. It has exactly two imports (agent-name-token-match, pi-compatible-synthetic-title), no I/O, no config, no clock. Nine functions, twelve constants, one type. It is the shared vocabulary that the four status/identity ladders above it consume: src/shared/agent-title-status.ts, src/shared/agent-title-identity.ts, src/shared/terminal-title-status.ts, src/shared/terminal-title-agent-type.ts, plus src/shared/terminal-title-display.ts and src/shared/agent-detection.ts (a pure re-export barrel).

=== THE COMPLETE EXPORT LIST (26 names) ===
Re-exported from ./agent-name-token-match: AGY_AGENT_NAME_RE, DROID_AGENT_NAME_RE, HERMES_AGENT_NAME_RE, titleHasAgentName.
Type: AgentStatus.
Constants: CLAUDE_IDLE, CLAUDE_MANAGEMENT_TITLE_RE, GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION, STRONG_IDLE_KEYWORDS_RE, STRONG_WORKING_KEYWORDS_RE, STRONG_WORKING_KEYWORDS_RE_GLOBAL, CURSOR_NATIVE_TITLE_LOWER, BRAILLE_SPINNER_RE.
Functions: isGeminiTerminalTitle, isPiTerminalTitle, isPiAgentTitle, containsBrailleSpinner, containsLegacyAgentName, containsAgentName, containsAny, isClaudeManagementTitle, isCursorNativeAgentTitle, isCursorAgentTitle.
NOT exported but required by the port: CLAUDE_COMMAND_RE, STRONG_IDLE_KEYWORDS, STRONG_WORKING_KEYWORDS.
Imported and required: titleHasAnyLegacyAgentName, isLegacyPiCompatibleTitle (and, transitively, AGENT_NAMES + buildAgentNameRe).

=== BRANCH-ORDER SUMMARY (the part a port gets wrong) ===
Only two exports are real ladders; the rest are single expressions.

isGeminiTerminalTitle(title):
  1. contains ✋ U+270B OR ✦ U+2726 OR ⏲ U+23F2 OR ◇ U+25C7  -> TRUE
  2. isPiAgentTitle(title)                                     -> FALSE   (veto, not fall-through)
  3. titleHasAgentName(title, 'gemini')                        -> that value
  Step 1 BEFORE step 2 is observable ("⠋ π - ✦ x" is TRUE). Step 2 must use the
  IDENTITY predicate isPiAgentTitle, never the settled variant isPiTerminalTitle.

isCursorAgentTitle(title):
  1. not a string (null/undefined)                             -> FALSE
  2. trimmed = trim_js(title); lower = trimmed.to_lowercase()
  3. lower == "cursor agent" | "cursor ready" | "cursor - action required" -> TRUE
  4. /^[⠀-⣿] Cursor Agent$/u against TRIMMED (case-SENSITIVE) -> that value
  The `lower` (step 3) vs `trimmed` (step 4) split is load-bearing.

Pure disjunctions where order is free but should be preserved verbatim:
  containsAgentName  = legacy(13 names, exe suffix OK) || agy || droid || hermes
                       (the last three do NOT allow an exe suffix)
Pure conjunction:
  isPiTerminalTitle  = isLegacyPiCompatibleTitle && !containsBrailleSpinner
Aliases:
  isPiAgentTitle       = isLegacyPiCompatibleTitle
  containsLegacyAgentName = titleHasAnyLegacyAgentName
  isClaudeManagementTitle = CLAUDE_MANAGEMENT_TITLE_RE.test

=== RUST IMPLEMENTATION STATUS (checked at HEAD) ===
Command used: `git grep -c "<snake_case>" HEAD -- rust/crates` for all twelve candidate names, plus a scan for the literal glyph code points (2726/25c7/270b/23f2/2733/2800/28ff) and for pi_compatible / STRONG_ / braille.

ALREADY IMPLEMENTED in rust/crates/orca-core/src/agent_recognition.rs — reuse, do not rewrite:
  * title_has_agent_name(title, name)            <- titleHasAgentName (incl. the AGENT_NAMES membership gate)
  * title_has_any_legacy_agent_name(title)       <- containsLegacyAgentName
  * title_has_droid / title_has_hermes / title_has_agy  <- the three re-exported regexes
  * title_has_token(title, name, allow_exe_suffix)      <- the shared hand-rolled boundary scan
  * AGENT_NAMES const, is_boundary_char, normalize_process_name, is_expected_agent_process
Also present and reusable: orca_core::js_string::{trim_js, is_js_trim_ws, utf16_len, slice_utf16}.
Parity dispatch already wired (orca-dispatch/src/modules/agent_recognition.rs, registered as
"agent-recognition" in modules/mod.rs:103) for exactly three functions: titleHasAgentName,
titleHasAnyLegacyAgentName, isExpectedAgentProcess. title_has_droid/hermes/agy are implemented
but NOT dispatched.

NOT IMPLEMENTED ANYWHERE (all new work):
  CLAUDE_IDLE, CLAUDE_MANAGEMENT_TITLE_RE / is_claude_management_title,
  GEMINI_WORKING / GEMINI_SILENT_WORKING / GEMINI_IDLE / GEMINI_PERMISSION,
  is_gemini_terminal_title, is_pi_terminal_title, is_pi_agent_title,
  is_legacy_pi_compatible_title, contains_braille_spinner, BRAILLE_SPINNER_RE,
  contains_agent_name (the 4-way OR; all four operands exist), contains_any,
  CURSOR_NATIVE_TITLE_LOWER, is_cursor_native_agent_title, is_cursor_agent_title,
  STRONG_IDLE_KEYWORDS_RE / STRONG_WORKING_KEYWORDS_RE / STRONG_WORKING_KEYWORDS_RE_GLOBAL.
Grep proof: zero hits in rust/crates for 2726|25c7|270b|23f2|2733|u{2800}|28ff, for
STRONG_IDLE|strong_idle|STRONG_WORKING|strong_working, and for GEMINI_WORKING|CURSOR_NATIVE|
claude_management|CLAUDE_IDLE. The only "braille" mention is a comment in
orca-core/src/opencode_terminal_title.rs:76. The only "pi_compatible" hit is the unrelated
title_identity_group string "pi-compatible" in orca-core/src/synthetic_agent_title.rs.

=== SUGGESTED RUST SHAPE ===
Put the new code in a sibling of agent_recognition.rs (e.g. orca-core/src/agent_title_core.rs) so
it can `use crate::agent_recognition::{title_has_agent_name, title_has_any_legacy_agent_name,
title_has_agy, title_has_droid, title_has_hermes}` and `use crate::js_string::trim_js`. Compile
the three regexes that survive translation (CLAUDE_MANAGEMENT, LEGACY_PI, CURSOR_SPINNER) once
behind OnceLock, with `\s` spelled out explicitly and `(?i-u)` where the TS has `i` — see hazards.
Hand-roll the two STRONG_* matchers (lookbehind) with an ASYMMETRIC right-hand boundary predicate;
they cannot share is_boundary_char with the AGENT_NAMES family.

=== PARITY-CORPUS SEEDS ===
The existing TS tests already pin most of the behaviour and make a good golden corpus:
src/renderer/src/lib/agent-status.test.ts:420-440 (14 isGeminiTerminalTitle cases including all
the π forms) and :537-546 (7 isClaudeManagementTitle cases including quoted Windows paths);
src/shared/agent-detection.test.ts:244,256,274 (isCursorAgentTitle). Add the Unicode adversarials
from the hazards list — none of them is currently covered by a TS test, and each is a place where
a plausible Rust port diverges silently.

=== TWO NEAR-DUPLICATE MODULES — CHECK BEFORE SHARING CODE ===
src/shared/terminal-title-agent-type.ts and src/shared/terminal-title-status.ts carry their own
copies of CLAUDE_IDLE, GEMINI_SILENT_WORKING, containsBrailleSpinner, isGeminiTerminalTitle,
isPiTerminalTitle, isPiAgentTitle, isClaudeManagementTitle, containsAny and both STRONG_* regexes.
src/shared/terminal-title-display.ts has a private containsAgentName. A comment at
src/shared/terminal-title-agent-type.test.ts:129 says the copies "both got the identical
isCursorAgentTitle guard, so pin this copy directly to catch drift" — i.e. drift between the
copies is a known, actively-guarded risk. Port agent-title-core as the single source and diff the
copies against it rather than assuming they are identical.

### Exports (29)

#### `AgentStatus`

```ts
TS: type AgentStatus = 'working' | 'permission' | 'idle'  //  Rust: #[derive(Clone,Copy,PartialEq,Eq)] pub enum AgentStatus { Working, Permission, Idle }
```

Pure type alias, no runtime value. Three-variant string union. Wire form (for the parity dispatcher) must serialize as the exact lowercase strings "working" / "permission" / "idle".

RUST STATUS: NOT in orca-core as this name. A structurally identical status enum exists at rust/crates/orca-agents/src/agent_status_types.rs; confirm before duplicating.

#### `CLAUDE_IDLE`

```ts
export const CLAUDE_IDLE: string = '✳'  //  Rust: pub const CLAUDE_IDLE: char = '\u{2733}';  (or &str "\u{2733}")
```

Single BMP char U+2733 EIGHT SPOKED ASTERISK (✳). Claude Code's idle title prefix.

NOT used inside agent-title-core itself — it is exported purely for consumers. Every consumer (src/shared/agent-title-identity.ts:28,58; src/shared/agent-title-status.ts:178; src/shared/terminal-title-status.ts:119; src/shared/terminal-title-agent-type.ts:92,136) uses the SAME two-part test:
    title.startsWith(`${CLAUDE_IDLE} `)  ||  title === CLAUDE_IDLE
i.e. "glyph followed by one ASCII space U+0020" OR "the bare glyph and nothing else". A port that only does `starts_with('\u{2733}')` is WRONG — it would accept "✳x".

RUST STATUS: NOT implemented anywhere in rust/crates (verified: no hit for 2733 / CLAUDE_IDLE).

Unicode literals: `U+2733 ✳ EIGHT SPOKED ASTERISK`

#### `CLAUDE_MANAGEMENT_TITLE_RE`

```ts
export const CLAUDE_MANAGEMENT_TITLE_RE: RegExp  (flags: "i" only — no g, no u, no m, no s)
```

Built by string interpolation from a private, NON-exported fragment:

    const CLAUDE_COMMAND_RE = String.raw`(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?`

    CLAUDE_MANAGEMENT_TITLE_RE = new RegExp(
      String.raw`^\s*(?:"${C}"|'${C}'|${C})\s+agents\s*$`, 'i')

EXACT expanded .source (verified by running it in Node):

    ^\s*(?:"(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?"|'(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?'|(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?)\s+agents\s*$

Structure, in order:
  1. `^`            start of input (NOT multiline)
  2. `\s*`          any leading JS whitespace (INCLUDING newlines and U+FEFF)
  3. one of three alternatives, tried in this order (order is irrelevant to the
     boolean because the whole pattern is anchored and .test() only asks
     "does any match exist" — but keep it for a faithful port):
       a. `"` COMMAND `"`   (double-quoted)
       b. `'` COMMAND `'`   (single-quoted)
       c. COMMAND            (bare)
     where COMMAND = optional path prefix `(?:.*[\\/])?`  (any run of
     non-line-terminator chars ending in `\` or `/`), then literal `claude`,
     then an OPTIONAL Windows launcher extension `.exe` | `.cmd` | `.bat` | `.ps1`
  4. `\s+`          at least one whitespace
  5. `agents`       literal, case-insensitive
  6. `\s*$`         trailing whitespace to end of input

VERIFIED truth table (Node):
  true : "claude agents", "  Claude Agents  ", "CLAUDE AGENTS", "claude.exe agents",
         "claude.cmd agents", "claude.bat agents", "claude.ps1 agents",
         "/usr/bin/claude agents", "C:\\Users\\d\\claude.cmd agents",
         "\"C:\\Users\\d\\claude.cmd\" agents", "'/usr/bin/claude' agents",
         "claude  agents", "\tclaude agents\n", "\"claude\" agents",
         "\u00a0claude agents", "\ufeffclaude agents"
  false: "claudeagents", "claude agents x", "xclaude agents", "claude.zip agents",
         "claude agent", "claude\" agents", "a\nclaude agents", "\u0085claude agents"

Note "xclaude agents" is FALSE: the path prefix must end in `\` or `/`, there is no
word-boundary alternative. And "\u0085claude agents" is FALSE because U+0085 NEL is
not in the JS `\s` set (see hazards).

RUST STATUS: NOT implemented. Rust's `regex` crate handles this pattern fine (no
lookaround), but `\s`, `\w` and `(?i)` must be pinned — see hazards.

Unicode literals: `U+FEFF (accepted by \s)`, `U+0085 (rejected by \s)`

#### `GEMINI_WORKING`

```ts
export const GEMINI_WORKING = '✦'
```

U+2726 BLACK FOUR POINTED STAR (✦). Gemini CLI "working" OSC glyph. Matched with plain substring containment (String.prototype.includes), never a regex, never anchored.

RUST STATUS: NOT implemented in rust/crates.

Unicode literals: `U+2726 ✦ BLACK FOUR POINTED STAR`

#### `GEMINI_SILENT_WORKING`

```ts
export const GEMINI_SILENT_WORKING = '⏲'
```

U+23F2 TIMER CLOCK (⏲). Gemini CLI "working, no output" glyph. Substring containment.

Consumers also use it as a REPLACE target: `cleaned = cleaned.replace(GEMINI_SILENT_WORKING, '')` (src/shared/agent-title-status.ts:35, terminal-title-display.ts:40). Because it is a plain string (not a global regex), JS `String.replace(string, '')` removes ONLY THE FIRST occurrence. A Rust port using `str::replace` removes ALL of them — that is a divergence.

RUST STATUS: NOT implemented in rust/crates.

Unicode literals: `U+23F2 ⏲ TIMER CLOCK`

#### `GEMINI_IDLE`

```ts
export const GEMINI_IDLE = '◇'
```

U+25C7 WHITE DIAMOND (◇). Gemini CLI "idle" glyph. Substring containment.

RUST STATUS: NOT implemented in rust/crates.

Unicode literals: `U+25C7 ◇ WHITE DIAMOND`

#### `GEMINI_PERMISSION`

```ts
export const GEMINI_PERMISSION = '✋'
```

U+270B RAISED HAND (✋). Gemini CLI "awaiting permission" glyph. Substring containment.

RUST STATUS: NOT implemented in rust/crates.

Unicode literals: `U+270B ✋ RAISED HAND`

#### `STRONG_IDLE_KEYWORDS (private, NOT exported — port it as a private const)`

```ts
const STRONG_IDLE_KEYWORDS = ['ready', 'idle', 'done'] as const
```

Ordered keyword list joined with `|` into the alternation of STRONG_IDLE_KEYWORDS_RE. Order is not semantically load-bearing (the three words share no prefix), but preserve it so the generated .source is byte-identical if anything ever snapshots it.

RUST STATUS: NOT implemented.

#### `STRONG_WORKING_KEYWORDS (private, NOT exported — port it as a private const)`

```ts
const STRONG_WORKING_KEYWORDS = ['working', 'thinking', 'running'] as const
```

Ordered keyword list joined with `|` into STRONG_WORKING_KEYWORDS_RE. Same note as above.

RUST STATUS: NOT implemented.

#### `STRONG_IDLE_KEYWORDS_RE`

```ts
export const STRONG_IDLE_KEYWORDS_RE: RegExp  (flags: "i" only — NOT global, so .test() is stateless)
```

EXACT .source (verified in Node):

    (?<![\w./\\-])(ready|idle|done)(?![\w\-])

Three pieces:
  * NEGATIVE LOOKBEHIND `(?<![\w./\\-])` — the char immediately before the keyword
    must NOT be one of: ASCII word char [A-Za-z0-9_], `.`, `/`, `\`, `-`.
    Start-of-string satisfies it.
  * capture group 1: `ready` | `idle` | `done`, case-insensitive
  * NEGATIVE LOOKAHEAD `(?![\w\-])` — the char immediately after must NOT be an
    ASCII word char or `-`. End-of-string satisfies it.

*** THE TWO SIDES ARE DELIBERATELY ASYMMETRIC. *** The left class blocks `.` `/` `\`
(path separators); the RIGHT class does NOT. So a trailing `.` or `/` is allowed.
The source comment states this explicitly. A port that symmetrizes the classes is
wrong.

VERIFIED truth table (Node):
  true : "ready", "Ready", "DONE", "idle", "ready.", "ready/x"
  false: "already", "/ready", "x-ready", "ready-x", "~/codex/ready", "idled",
         "undone", "worKing"

Used by: src/shared/agent-title-status.ts:199 and src/shared/terminal-title-status.ts:140,
both as a bare `.test(title)` inside a status ladder, AFTER the permission check.

RUST STATUS: NOT implemented. Rust's `regex` crate has NO lookbehind — hand-roll the
scan the way orca-core::agent_recognition::title_has_token already does.

#### `STRONG_WORKING_KEYWORDS_RE`

```ts
export const STRONG_WORKING_KEYWORDS_RE: RegExp  (flags: "i" only — stateless)
```

EXACT .source (verified in Node):

    (?<![\w./\\-])(working|thinking|running)(?![\w\-])

Identical boundary machinery to STRONG_IDLE_KEYWORDS_RE (same asymmetric classes),
different alternation. The comment gives the motivating negatives: "reworking" and
"is-thinking-cap" must NOT match.

VERIFIED truth table (Node):
  true : "working", "thinking", "running", "working.", "working/x"
  false: "reworking", "/working", "is-thinking-cap", "runningx",
         "worKing", "thinKing"

The last two are the Kelvin-sign trap: both "working" and "thinking" contain `k`, so a
Rust `(?i)` (Unicode simple fold) WOULD match U+212A here where JS does not.

Used by: src/shared/agent-title-status.ts:202 and terminal-title-status.ts:144, always
immediately AFTER the STRONG_IDLE test in the same ladder.

RUST STATUS: NOT implemented.

Unicode literals: `U+212A KELVIN SIGN (must NOT fold to 'k')`

#### `STRONG_WORKING_KEYWORDS_RE_GLOBAL`

```ts
export const STRONG_WORKING_KEYWORDS_RE_GLOBAL = new RegExp(STRONG_WORKING_KEYWORDS_RE.source, 'gi')  (flags: "gi")
```

SAME pattern source as STRONG_WORKING_KEYWORDS_RE, re-compiled with the GLOBAL flag added. It exists only as a strip target:

    cleaned = cleaned.replace(STRONG_WORKING_KEYWORDS_RE_GLOBAL, '')

(src/shared/agent-title-status.ts:41 and src/shared/terminal-title-display.ts:54 — in
both, guarded by an `if` on the same line region.)

*** MUTABLE MODULE STATE. *** A `g`-flagged RegExp carries `lastIndex`, which
`.test()` and `.exec()` advance and which persists across calls at module scope.
Verified in Node: three consecutive `G.test("working")` calls return true, false, true.
`.replace()` resets lastIndex to 0 afterwards, which is why the current consumers are
safe — but the object is shared and any future `.test()` on it is a latent bug.

In Rust there is no lastIndex: compile ONE Regex and use `replace_all` for this export
and `is_match` for the non-global twin. Do not model lastIndex.

RUST STATUS: NOT implemented.

#### `CURSOR_NATIVE_TITLE_LOWER`

```ts
export const CURSOR_NATIVE_TITLE_LOWER = 'cursor agent'  //  Rust: pub const CURSOR_NATIVE_TITLE_LOWER: &str = "cursor agent";
```

Exactly 12 ASCII code points: 99 117 114 115 111 114 32 97 103 101 110 116 ("cursor", U+0020, "agent"). Verified by codepoint dump. One ASCII space, no double space.

RUST STATUS: NOT implemented.

#### `BRAILLE_SPINNER_RE`

```ts
export const BRAILLE_SPINNER_RE = /[⠀-⣿]/g  (flags: "g")
```

Single-char class over the whole Braille Patterns block U+2800..U+28FF INCLUSIVE (U+2800 BRAILLE PATTERN BLANK through U+28FF). No `u` flag, no `i` flag. Carries an eslint-disable for no-control-regex.

Used as a strip target: `cleaned = cleaned.replace(BRAILLE_SPINNER_RE, '')` (agent-title-status.ts:36). A near-identical private copy `/[⠀-⣿]/g` lives at src/shared/terminal-output-side-effects.ts:31 and is used as `title.replace(BRAILLE_SPINNER_RE, '').trim()`.

*** Same `g`-flag lastIndex hazard as above *** — verified: two consecutive `.test("⠋")` return true then false.

This regex is NOT how containsBrailleSpinner works — that function is a hand-rolled code-point loop. Keep them as two distinct things in the port (one a replace-all Regex, one a predicate).

RUST STATUS: NOT implemented (no 2800/28ff literal anywhere in rust/crates).

Unicode literals: `U+2800..U+28FF Braille Patterns block (inclusive both ends)`

#### `isGeminiTerminalTitle`

```ts
export function isGeminiTerminalTitle(title: string): boolean  //  Rust: pub fn is_gemini_terminal_title(title: &str) -> bool
```

*** THREE-BRANCH LADDER. THE ORDER IS THE SEMANTICS. ***

  BRANCH 1 (glyph evidence, wins over everything):
      if title.includes('✋')      // GEMINI_PERMISSION ✋
      || title.includes('✦')      // GEMINI_WORKING ✦
      || title.includes('⏲')      // GEMINI_SILENT_WORKING ⏲
      || title.includes('◇')      // GEMINI_IDLE ◇
        -> return TRUE
     Source comment: "Gemini OSC glyphs are stronger evidence than any cwd/session text."
     The four `includes` are a plain disjunction (no side effects), so their relative
     order is free; but the BLOCK must stay first.

  BRANCH 2 (Pi veto):
      if isPiAgentTitle(title) -> return FALSE
     Source comment: "Pi/OMP titles include cwd/session text; substring matching made
     paths like 'gemini-project' masquerade as Gemini CLI."
     Note this returns FALSE, it does not fall through.

  BRANCH 3 (name token):
      return titleHasAgentName(title, 'gemini')

REORDERING BRANCHES 1 AND 2 IS OBSERVABLE. A Pi-formatted title that also carries a
Gemini glyph (e.g. "⠋ π - ✦ build") is TRUE under the real order and FALSE if the Pi
veto is hoisted.

Pinned behaviour from src/renderer/src/lib/agent-status.test.ts:420-440:
  true : "✦  Typing prompt... (workspace)", "◇  Ready (workspace)",
         "gemini waiting for input"
  false: "⠂ Claude Code", "⠋ π - gemini", "π - gemini", "⠋ π: gemini", "π: gemini",
         "⠋ π gemini", "π gemini", "π -", "π:", "π ",
         "⠋ π - gemini-project", "/tmp/gemini/working", "bash"
The "π -" / "π:" / "π " cases are false via BRANCH 2, not branch 3 — they contain no
"gemini" at all, but they prove the Pi regex fires on a bare delimiter.

RUST STATUS: NOT implemented. Its branch-3 dependency title_has_agent_name IS
implemented (orca-core::agent_recognition); its branch-2 dependency is not.

Unicode literals: `U+270B ✋`, `U+2726 ✦`, `U+23F2 ⏲`, `U+25C7 ◇`

#### `isPiTerminalTitle`

```ts
export function isPiTerminalTitle(title: string): boolean  //  Rust: pub fn is_pi_terminal_title(title: &str) -> bool
```

    return isLegacyPiCompatibleTitle(title) && !containsBrailleSpinner(title)

A Pi-compatible title that is NOT currently spinning. Short-circuit AND: the braille
scan is skipped when the regex misses (no observable difference, both are pure).

Semantically: "is a Pi/OMP title AND is not in the working state". Consumers treat this
as the settled-Pi predicate (terminal-title-status.ts:123, agent-title-status.ts:181).

RUST STATUS: NOT implemented (neither this nor either dependency).

#### `isPiAgentTitle`

```ts
export function isPiAgentTitle(title: string): boolean  //  Rust: pub fn is_pi_agent_title(title: &str) -> bool
```

    return isLegacyPiCompatibleTitle(title)

A bare re-export-as-function. Differs from isPiTerminalTitle ONLY by the missing
braille veto: isPiAgentTitle is IDENTITY ("this pane is Pi/OMP, spinning or not"),
isPiTerminalTitle is IDENTITY-AND-SETTLED. Conflating them is the single easiest way to
break this module: the Gemini ladder's branch 2 uses the IDENTITY one, so a port that
substitutes isPiTerminalTitle there would let a SPINNING Pi title fall through to the
"gemini" name check.

RUST STATUS: NOT implemented.

#### `isLegacyPiCompatibleTitle (imported helper from ./pi-compatible-synthetic-title — MUST be ported)`

```ts
export function isLegacyPiCompatibleTitle(title: string): boolean  //  Rust: pub fn is_legacy_pi_compatible_title(title: &str) -> bool
```

    const LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[⠀-⣿]\s+)?π(?:\s*[-:]|\s)\s*.*$/u
    return LEGACY_PI_COMPATIBLE_TITLE_RE.test(title)

Flags: `u` ONLY. *** NO `i` FLAG *** — `π` is exactly U+03C0 GREEK SMALL LETTER PI.
Uppercase Π (U+03A0) does NOT match. Verified.

Structure, left to right:
  1. `^`                     start of input (not multiline)
  2. `\s*`                   leading JS whitespace, any amount, may include newlines
  3. `(?:[⠀-⣿]\s+)?`  OPTIONAL spinner prefix: EXACTLY ONE braille char
                             followed by ONE OR MORE whitespace. Two braille chars, or
                             a braille char with no space, both fail.
  4. `π`                     literal U+03C0
  5. `(?:\s*[-:]|\s)`        the DELIMITER — required, one of two alternatives:
                               a. optional whitespace then `-` or `:`
                               b. exactly ONE whitespace char
                             Alternation order matters for backtracking only; the
                             boolean is the disjunction.
  6. `\s*`                   more whitespace (may include newlines)
  7. `.*`                    the payload — `.` excludes \n \r U+2028 U+2029
  8. `$`                     end of input (not multiline)

VERIFIED truth table (Node):
  true : "π - foo", "π: foo", "π foo", "π -", "π:", "π ", "⠋ π - foo", "  π - x",
         "π\t- x", "π x", "π  -  x", "π -\nfoo"
  false: "π"  (bare pi: no delimiter),  "⠋π - foo"  (braille needs \s+),
         "Π - foo"  (uppercase),  "π - foo\nbar"  (see below)

The "π -\nfoo" TRUE / "π - foo\nbar" FALSE pair is the `.*$` subtlety: step 6's `\s*`
can cross newlines but step 7's `.*` cannot, and `$` is not multiline — so the payload
may contain AT MOST ONE newline-free run, preceded only by whitespace.

RUST STATUS: NOT implemented (no pi_compatible / LEGACY_PI in rust/crates; the only
hit for "pi_compatible" is the unrelated title_identity_group string "pi-compatible" in
orca-core/src/synthetic_agent_title.rs).

Unicode literals: `U+03C0 π GREEK SMALL LETTER PI (lowercase only)`, `U+2800..U+28FF braille prefix`

#### `containsBrailleSpinner`

```ts
export function containsBrailleSpinner(title: string): boolean  //  Rust: pub fn contains_braille_spinner(title: &str) -> bool
```

    for (const char of title) {
      const codePoint = char.codePointAt(0)
      if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) return true
    }
    return false

`for...of` over a string iterates CODE POINTS (surrogate pairs combined), not UTF-16
code units. `codePointAt(0)` on a one-code-point string is never undefined for a
non-empty iteration, so the `!== undefined` guard is dead — do NOT model it as an
Option in Rust; it is a TS-narrowing artifact.

Range is INCLUSIVE on both ends: 0x2800 <= cp <= 0x28FF.

Exact Rust equivalent:
    title.chars().any(|c| ('\u{2800}'..='\u{28FF}').contains(&c))
No divergence: the whole block is BMP, and Rust `str` cannot hold the lone surrogates
that are the only case where JS code-point iteration is exotic.

An IDENTICAL private copy of this function exists in
src/shared/pi-compatible-synthetic-title.ts:9 and another export of the same name in
src/shared/terminal-title-agent-type.ts:24. Port once, share.

RUST STATUS: NOT implemented.

Unicode literals: `U+2800..U+28FF`

#### `containsLegacyAgentName`

```ts
export function containsLegacyAgentName(title: string): boolean  //  Rust: orca_core::agent_recognition::title_has_any_legacy_agent_name(title)
```

    return titleHasAnyLegacyAgentName(title)

A one-line alias for the imported helper. Delegates to

    ANY_LEGACY_AGENT_NAME_RE = new RegExp(
      AGENT_NAMES.map(n => `(?<![\\w./\\\\-])${n}(?:(?:\\.(?:exe|cmd|bat|ps1)))?(?![\\w./\\\\-])`)
        .join('|'), 'i')

AGENT_NAMES, in source order: claude, openclaude, codex, copilot, cursor, gemini,
antigravity, opencode, mimo, openclaw, aider, grok, devin. (Order is irrelevant to the
boolean: JS tries every start position and every alternative, so "openclaude" is TRUE
even though `claude` is listed first and fails its lookbehind at index 4.)

*** RUST STATUS: ALREADY IMPLEMENTED — DO NOT REWRITE. ***
  orca-core/src/agent_recognition.rs :: title_has_any_legacy_agent_name(&str) -> bool
  It is a hand-rolled boundary scan (Rust regex has no lookbehind), uses
  to_ascii_lowercase (correct — matches JS non-`u` `i` folding), and is already exposed
  through the parity dispatcher as "titleHasAnyLegacyAgentName" in
  orca-dispatch/src/modules/agent_recognition.rs.

#### `containsAgentName`

```ts
export function containsAgentName(title: string): boolean  //  Rust: pub fn contains_agent_name(title: &str) -> bool
```

*** FOUR-BRANCH SHORT-CIRCUIT DISJUNCTION, IN THIS ORDER: ***

    return containsLegacyAgentName(title)      //  the 13 AGENT_NAMES, exe suffix ALLOWED
        || AGY_AGENT_NAME_RE.test(title)       //  agy,    exe suffix NOT allowed
        || DROID_AGENT_NAME_RE.test(title)     //  droid,  exe suffix NOT allowed
        || HERMES_AGENT_NAME_RE.test(title)    //  hermes, exe suffix NOT allowed

All four operands are pure and all four regexes are NON-global (stateless `.test`), so
the order is a pure performance/short-circuit detail — the boolean is the plain OR of
four predicates. Safe to reorder; reproduce it anyway.

The asymmetry that IS load-bearing: the first operand permits an optional
`.exe|.cmd|.bat|.ps1` suffix before the right boundary; the other three do NOT. So
"claude.exe" is TRUE but "droid.exe" is FALSE (already pinned by the Rust test
`droid_hermes_agy_token_matching_without_exe_suffix`).

A near-duplicate PRIVATE function of the same name exists at
src/shared/terminal-title-display.ts:21 — check it has not drifted before sharing code.

RUST STATUS: the FUNCTION is NOT implemented, but ALL FOUR OPERANDS ARE:
    orca_core::agent_recognition::title_has_any_legacy_agent_name
    orca_core::agent_recognition::title_has_agy
    orca_core::agent_recognition::title_has_droid
    orca_core::agent_recognition::title_has_hermes
(the last three are `title_has_token(title, name, /*allow_exe_suffix=*/false)`).
The port is a four-way `||` over existing functions — write no new matching logic.
Note none of title_has_agy/droid/hermes is wired into the parity dispatcher yet.

#### `AGY_AGENT_NAME_RE`

```ts
re-exported from ./agent-name-token-match:  export const AGY_AGENT_NAME_RE = /(?<![\w./\\-])agy(?![\w./\\-])/i
```

Whole-token match of the literal `agy`, case-insensitive, NO exe-suffix option.
*** Both boundary classes are `[\w./\\-]` — SYMMETRIC here, unlike the STRONG_*
keyword regexes whose right side is only `[\w\-]`. *** So "agy." and "agy/x" are FALSE
for this regex but "ready." is TRUE for the idle regex. Do not share one boundary
helper between the two families without a flag.

Comment rationale: cwd/path titles like `~/hermes/working` must not count as activity.

RUST STATUS: IMPLEMENTED as orca_core::agent_recognition::title_has_agy(&str) -> bool
(= title_has_token(title, "agy", false)). Not yet in the parity dispatcher.

#### `DROID_AGENT_NAME_RE`

```ts
re-exported from ./agent-name-token-match:  export const DROID_AGENT_NAME_RE = /(?<![\w./\\-])droid(?![\w./\\-])/i
```

Whole-token match of `droid`, case-insensitive, NO exe-suffix option, symmetric
`[\w./\\-]` boundaries. Comment rationale: "`android` contains `droid`".

RUST STATUS: IMPLEMENTED as orca_core::agent_recognition::title_has_droid. Its unit
test already pins `!title_has_droid("android ready")` and `!title_has_droid("droid.exe")`.

#### `HERMES_AGENT_NAME_RE`

```ts
re-exported from ./agent-name-token-match:  export const HERMES_AGENT_NAME_RE = /(?<![\w./\\-])hermes(?![\w./\\-])/i
```

Whole-token match of `hermes`, case-insensitive, NO exe-suffix option, symmetric
`[\w./\\-]` boundaries.

RUST STATUS: IMPLEMENTED as orca_core::agent_recognition::title_has_hermes.

#### `titleHasAgentName`

```ts
re-exported from ./agent-name-token-match:  export function titleHasAgentName(title: string, name: string): boolean
```

    return AGENT_NAME_RE_BY_NAME.get(name)?.test(title) ?? false

TWO-STEP, and step 1 is a gate people miss:
  1. `name` must be an EXACT, CASE-SENSITIVE member of AGENT_NAMES. A Map miss makes
     optional chaining yield `undefined`, and `?? false` turns that into FALSE.
     titleHasAgentName(anything, 'Gemini') is FALSE. titleHasAgentName(x, 'droid') is
     FALSE (droid is not in AGENT_NAMES).
  2. Otherwise test the per-name regex from buildAgentNameRe(name):
         (?<![\w./\\-])<name>(?:(?:\.(?:exe|cmd|bat|ps1)))?(?![\w./\\-])
     case-insensitive, symmetric boundaries, exe suffix ALLOWED.

Note buildAgentNameRe interpolates `name` into the pattern UNESCAPED. Harmless for the
13 ASCII names; a Rust port should still use regex::escape or a literal scan.

Within agent-title-core this is called exactly once: `titleHasAgentName(title, 'gemini')`
as branch 3 of isGeminiTerminalTitle.

*** RUST STATUS: ALREADY IMPLEMENTED — DO NOT REWRITE. ***
  orca-core/src/agent_recognition.rs :: title_has_agent_name(title, name) -> bool.
  It reproduces the membership gate (`if !AGENT_NAMES.contains(&name) { return false }`)
  and calls title_has_token(title, name, true). Exposed via the parity dispatcher as
  "titleHasAgentName" (orca-dispatch/src/modules/agent_recognition.rs), keyed under the
  module name "agent-recognition" in modules/mod.rs:103.

#### `containsAny`

```ts
export function containsAny(title: string, words: readonly string[]): boolean  //  Rust: pub fn contains_any(title: &str, words: &[&str]) -> bool
```

    const lower = title.toLowerCase()
    return words.some((word) => lower.includes(word))

*** ASYMMETRIC CASE HANDLING: the TITLE is lowercased, the WORDS ARE NOT. *** A caller
passing an uppercase needle can never match. Verified: containsAny('ABC', ['abc']) is
true; containsAny('abc', ['ABC']) is false. Every real call site passes
['action required', 'permission', 'waiting'] (agent-title-status.ts:195,
terminal-title-status.ts:136) — already lowercase — but the contract is the asymmetric
one and a port must not "fix" it by lowercasing the needles.

Edge cases (verified): empty word list -> false (Array.prototype.some on []). A word
that is the empty string -> TRUE for any title (String.includes('') is true). Rust
`"abc".contains("")` is also true, and `[].iter().any(..)` is also false — both agree.

`toLowerCase()` is FULL Unicode lowercase (locale-independent), not ASCII: 'K' U+212A
lowercases to 'k' (verified: containsAny('K', ['k']) is true), and U+0130
lowercases to the TWO code points "i̇" (a length-changing fold). So the port must
use Rust `str::to_lowercase()`, NOT `to_ascii_lowercase()`.

NOTE the deliberate contrast with the token matchers: containsAny is a raw SUBSTRING
test with no boundary guard at all, and it uses full Unicode folding, whereas
title_has_token uses ASCII folding. Both are correct for their own call sites.

A byte-identical private copy lives at src/shared/terminal-title-status.ts:42.

RUST STATUS: NOT implemented.

Unicode literals: `U+212A KELVIN SIGN (DOES fold to 'k' here)`, `U+0130 (folds to U+0069 U+0307, length change)`

#### `isClaudeManagementTitle`

```ts
export function isClaudeManagementTitle(title: string): boolean  //  Rust: pub fn is_claude_management_title(title: &str) -> bool
```

    return CLAUDE_MANAGEMENT_TITLE_RE.test(title)

One line, no pre-trim, no lowercase — the regex's own `^\s*` / `\s*$` / `i` flag do all
the work. The regex is NOT global, so `.test` is stateless and safe to share.

Callers: src/main/runtime/orca-runtime.ts:30116 (on an already-trimmed value),
:36429, :36439; src/shared/agent-row-conversation-name.ts:98;
src/shared/agent-title-identity.ts:21,47; src/shared/agent-title-status.ts:154;
src/renderer/src/runtime/sync-runtime-graph.ts:1406;
src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.ts:132.
In agent-title-identity.ts:21 and agent-title-status.ts:154 it is the FIRST veto of the
ladder, sharing the branch with a `!title` falsiness check:
    if (!title || isClaudeManagementTitle(title) || ...) return null
Note `!title` is JS falsiness on a string — true only for "" (and null/undefined) —
so in Rust that is `title.is_empty()`, NOT `Option::is_none()`.

RUST STATUS: NOT implemented.

#### `isCursorNativeAgentTitle`

```ts
export function isCursorNativeAgentTitle(title: string): boolean  //  Rust: pub fn is_cursor_native_agent_title(title: &str) -> bool
```

    return title.trim().toLowerCase() === CURSOR_NATIVE_TITLE_LOWER

THREE steps, in this order — trim, then lowercase, then FULL-STRING EQUALITY (not
`includes`, not a prefix test):
  1. `String.prototype.trim()` — the ECMAScript trim set, which STRIPS U+FEFF and does
     NOT strip U+0085. Rust `str::trim` is exactly backwards on those two code points;
     use orca_core::js_string::trim_js.
  2. `String.prototype.toLowerCase()` — full Unicode; Rust `str::to_lowercase`.
  3. `=== 'cursor agent'`.

VERIFIED: "CURSOR AGENT" -> true; "cursor agent" -> true; "cursor  agent" (two spaces)
-> false; "cursor agent x" -> false; "⠋ Cursor Agent" -> FALSE (this function has no
braille allowance — that is isCursorAgentTitle's job).

Unlike its sibling below, this takes a plain `string` — callers must not pass null.
Call sites: src/main/runtime/orca-runtime.ts:9067;
src/shared/terminal-output-side-effects.ts:160,254.

RUST STATUS: NOT implemented.

#### `isCursorAgentTitle`

```ts
export function isCursorAgentTitle(title: string | null | undefined): boolean  //  Rust: pub fn is_cursor_agent_title(title: Option<&str>) -> bool
```

*** FOUR-STAGE LADDER. ORDER MATTERS FOR STAGE 1 AND FOR THE lower-vs-trimmed SPLIT. ***

  STAGE 1 — type guard:
      if (typeof title !== 'string') return false
    Covers null and undefined (and, at runtime, any non-string). Maps to Rust
    `let Some(title) = title else { return false };`. An EMPTY STRING is a string and
    FALLS THROUGH (and then fails everything, returning false) — do not collapse
    "empty" into "absent", the observable result is the same here but the shape differs.

  STAGE 2 — normalize, computing BOTH forms up front:
      const trimmed = title.trim()        // JS trim set (BOM yes, NEL no)
      const lower   = trimmed.toLowerCase()   // lowercase of the TRIMMED value

  STAGE 3 — closed-set equality against `lower`, three literals, case-insensitive by
  construction:
      if (lower === 'cursor agent'
       || lower === 'cursor ready'
       || lower === 'cursor - action required') return true
    Note the middle/last literals are Cursor's synthesized idle/permission labels;
    exactly one ASCII space around the hyphen in the third.

  STAGE 4 — the synthetic spinner form, tested against `trimmed`, NOT `lower`:
      return /^[⠀-⣿] Cursor Agent$/u.test(trimmed)
    *** NO `i` FLAG — this branch is CASE-SENSITIVE. *** Requires: exactly ONE braille
    char, exactly ONE ASCII space U+0020, then the literal "Cursor Agent" with that
    exact capitalization, then end of string.

VERIFIED truth table:
  true : "cursor agent", "CURSOR AGENT", "Cursor Ready", "CURSOR - ACTION REQUIRED",
         "⠋ Cursor Agent", "  ⠋ Cursor Agent  " (leading/trailing trimmed first),
         "﻿⠋ Cursor Agent" (BOM is trimmed by JS)
  false: null, undefined, "⠋ cursor agent" (stage 4 is case-sensitive),
         "⠋  Cursor Agent" (two spaces), "⠋⠋ Cursor Agent" (two braille chars),
         "Cursor Agent" with no braille reaching stage 4 — but note it is TRUE via
         stage 3, so the only way to see stage 4 fail is a non-matching prefix,
         "cursor  agent", "cursor agent x"

STAGE 3 BEFORE STAGE 4 is required in practice only for performance, since the two
languages are disjoint — but the `lower` vs `trimmed` split between them is NOT
cosmetic and a port that runs stage 4 against `lower` would wrongly accept
"⠋ cursor agent".

Source comment explains WHY there is no `cursor` token match here: "`cursor` is also an
ordinary editor noun that other agents type into their own task-summary titles, so a
name token is not identity." A port MUST NOT be "improved" into calling
titleHasAgentName(title, 'cursor').

Call sites: src/main/runtime/orca-runtime.ts:1344 (`[lastOscTitle, paneTitle,
tabTitle].some(isCursorAgentTitle)` — hence the null-tolerant signature);
src/main/runtime/orchestration/groups.ts:34 (registered in a per-agent predicate map);
src/shared/agent-title-identity.ts:37,107; src/shared/terminal-title-agent-type.ts:7.

RUST STATUS: NOT implemented.

Unicode literals: `U+2800..U+28FF braille prefix`, `U+0020 the single required ASCII space`, `U+FEFF (trimmed)`, `U+0085 (NOT trimmed)`

### Hazards (20)

| Where | JS semantic | Rust trap | Example |
| --- | --- | --- | --- |
| CLAUDE_MANAGEMENT_TITLE_RE, LEGACY_PI_COMPATIBLE_TITLE_RE, PI_COMPATIBLE_SYNTHETIC_TITLE_RE — every `\s` and `\s*` and `\s+` | JS regex `\s` = WhiteSpace ∪ LineTerminator = U+0009-U+000D, U+0020, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, and U+FEFF. It INCLUDES U+FEFF and EXCLUDES U+0085 (NEL). | Rust `regex` `\s` = Unicode White_Space, which is exactly the mirror image: it INCLUDES U+0085 and EXCLUDES U+FEFF. Writing `\s` in the Rust pattern silently flips both code points. Fix: use an explicit class `[\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]`, or `[\s&&[^\u{0085}]]\u{FEFF}`-style set arithmetic. orca_core::js_string::is_js_trim_ws already encodes exactly this predicate for the non-regex case. | "\u{FEFF}claude agents" -> JS TRUE, naive Rust FALSE.  "\u{0085}claude agents" -> JS FALSE, naive Rust TRUE. (Both verified in Node.) |
| STRONG_IDLE_KEYWORDS_RE and STRONG_WORKING_KEYWORDS_RE — the `\w` inside `(?<![\w./\\-])` and `(?![\w\-])`; also buildAgentNameRe / DROID / HERMES / AGY | None of these regexes carries the `u` flag, so JS `\w` is strictly `[A-Za-z0-9_]` — ASCII only. | Rust `regex` `\w` defaults to Unicode: `[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`. Any accented or CJK char adjacent to the keyword would then block the match. Fix: `(?-u:\w)` or spell the class `[A-Za-z0-9_]`. orca-core's hand-rolled `is_boundary_char` already gets this right (`c.is_ascii_alphanumeric() \|\| matches!(c, '_' \| '.' \| '/' \| '\\' \| '-')`) — reuse it. | "é ready" -> JS TRUE (é is not \w in non-u mode, so the lookbehind passes). With Rust Unicode \w, é IS a word char, so the lookbehind fails -> FALSE. |
| Every `i`-flagged regex in the module: CLAUDE_MANAGEMENT_TITLE_RE, STRONG_*_RE, buildAgentNameRe, DROID/HERMES/AGY, PI_COMPATIBLE_SYNTHETIC_TITLE_RE | ECMAScript `i` WITHOUT `u` uses the legacy Canonicalize rule: if a char is non-ASCII but its toUpperCase is a single ASCII char, it is NOT canonicalized. Consequence: U+212A KELVIN SIGN does NOT match `k`, and U+017F LATIN SMALL LETTER LONG S does NOT match `s`. Effectively ASCII-only folding for these ASCII patterns. | Rust `(?i)` performs Unicode simple case folding, which DOES fold U+212A<->k and U+017F<->s. `working` and `thinking` both contain `k`; `agents` and `cursor` contain `s`. Fix: `(?i-u)` for ASCII-insensitive matching, or lowercase the haystack with to_ascii_lowercase (NOT to_lowercase) before a case-sensitive scan — which is exactly what orca-core's title_has_token does, with a comment and a regression test (`token_match_uses_ascii_fold_like_the_js_regex_i_flag`). | "wor\u{212A}ing" -> JS STRONG_WORKING FALSE (verified), Rust (?i) TRUE. "claude agent\u{017F}" -> JS CLAUDE_MGMT FALSE, Rust (?i) TRUE. |
| isCursorNativeAgentTitle and isCursorAgentTitle — the `.trim()` call | `String.prototype.trim` strips the ECMAScript trim set: it REMOVES U+FEFF (BOM/ZWNBSP) and KEEPS U+0085 (NEL). Verified: '\u{FEFF}x\u{FEFF}'.trim() === 'x'. | Rust `str::trim` uses `char::is_whitespace` (Unicode White_Space), which KEEPS U+FEFF and REMOVES U+0085 — the exact opposite on both. Use orca_core::js_string::trim_js, which already exists for precisely this reason and has a test pinning both directions. | "\u{FEFF}Cursor Agent" -> JS isCursorNativeAgentTitle TRUE (verified via the sibling probe), Rust str::trim FALSE. "\u{0085}cursor agent" -> JS FALSE, Rust str::trim TRUE. |
| containsAny, isCursorNativeAgentTitle, isCursorAgentTitle — the `.toLowerCase()` calls | `String.prototype.toLowerCase()` is FULL Unicode default case conversion, locale-independent, including SpecialCasing and the Final_Sigma condition. U+212A lowercases to 'k'; U+0130 lowercases to the TWO code points U+0069 U+0307 (a LENGTH-CHANGING fold, verified: 'İ'.toLowerCase() === 'i̇'). | Two opposite traps. (a) Porting these with `to_ascii_lowercase()` for "speed" loses U+212A->k and the U+0130 expansion — and note this is the OPPOSITE requirement from the regex `i` flag above, where ASCII folding is the CORRECT choice. Same module, two different folding rules; pick per call site. (b) Any port that assumes lowercase preserves byte/char length breaks on U+0130. | containsAny('\u{212A}', ['k']) -> JS TRUE (verified). With to_ascii_lowercase -> FALSE. Meanwhile STRONG_WORKING_KEYWORDS_RE on 'wor\u{212A}ing' must be FALSE. Both behaviours must coexist. |
| STRONG_IDLE_KEYWORDS_RE / STRONG_WORKING_KEYWORDS_RE — the negative lookbehind `(?<![\w./\\-])`; and buildAgentNameRe / DROID / HERMES / AGY | JS regex supports variable-length lookbehind natively; the pattern reads as a single anchored assertion. | The Rust `regex` crate supports NO lookaround at all — the pattern will fail to COMPILE, and the reflexive workarounds are all wrong: `\b` matches inside hyphenated tokens and after path separators (that is the exact bug the comment says this replaces), and `[^\w./\\-]` on the left is not the same assertion because it CONSUMES a char and therefore cannot match at start-of-string. Fix: hand-roll the scan, as orca_core::agent_recognition::title_has_token already does (iterate candidate starts, check the char before via `start.checked_sub(1)` so start-of-string passes vacuously). | "ready" (keyword at index 0) — a consuming `[^\w./\\-]` left guard makes this FALSE; JS gives TRUE. And "~/codex/ready" must be FALSE, which `\b` would get wrong (TRUE). |
| STRONG_IDLE_KEYWORDS_RE and STRONG_WORKING_KEYWORDS_RE — the boundary classes are DIFFERENT on each side | Left: `(?<![\w./\\-])` blocks word chars, `.`, `/`, `\`, `-`.  Right: `(?![\w\-])` blocks ONLY word chars and `-`. The right side deliberately PERMITS `.` `/` `\`. Verified: "ready." TRUE, "ready/x" TRUE, but "/ready" FALSE and "x-ready" FALSE. | A porter who factors out one `is_boundary_char` helper and applies it to both sides (the natural thing, and what orca-core's existing title_has_token does for the AGENT_NAMES family where the classes ARE symmetric) will make "ready." and "working/x" FALSE. The STRONG_* family needs its own right-hand predicate: `c.is_ascii_alphanumeric() \|\| c == '_' \|\| c == '-'`. | "Codex working/repo" -> JS STRONG_WORKING TRUE (verified for "working/x"), symmetric-boundary port FALSE — the pane silently stops reporting as active. |
| BRAILLE_SPINNER_RE (flags `g`) and STRONG_WORKING_KEYWORDS_RE_GLOBAL (flags `gi`) — module-level `g`-flagged RegExp objects | A `g`-flagged RegExp carries a mutable `lastIndex` that `.test()`/`.exec()` advance and that persists between calls on the shared module-level object. Verified in Node: three consecutive `G.test('working')` return true, false, true; two consecutive `B.test('⠋')` return true, false. `.replace()` resets lastIndex to 0, which is the only reason the current call sites are safe. | Rust has no lastIndex, so a port is unconditionally stateless — usually a silent IMPROVEMENT, but it means a parity harness that replays `.test()` calls against these two exported objects will disagree with the TS on every even-numbered call. Do not try to emulate lastIndex; instead pin the parity contract to `replace_all` (the actual usage) and never expose a stateful `test` for these two. | BRAILLE_SPINNER_RE.test('⠋') twice -> JS [true, false]; Rust Regex::is_match twice -> [true, true]. |
| GEMINI_SILENT_WORKING used as a replace target in consumers: `cleaned.replace(GEMINI_SILENT_WORKING, '')` | `String.prototype.replace` with a STRING (not a regex) first argument replaces ONLY THE FIRST occurrence. | Rust `str::replace(pat, "")` replaces ALL occurrences. Use `replacen(pat, "", 1)`. Note the sibling line one above it uses BRAILLE_SPINNER_RE, which IS `g`-flagged and therefore DOES replace all — two adjacent lines with opposite multiplicity. | "⏲ build ⏲ done" -> JS replace gives " build ⏲ done"; Rust str::replace gives " build  done". |
| CLAUDE_COMMAND_RE's `.*` and LEGACY_PI_COMPATIBLE_TITLE_RE's trailing `.*` — dot without the `s` flag | JS `.` without `s` excludes FOUR characters: U+000A, U+000D, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR. Neither regex has `s` or `m`, so `^` and `$` are input anchors. | Rust `.` without `(?s)` excludes ONLY `\n`. So `\r`, U+2028 and U+2029 would be swallowed by `.*` in Rust where JS stops. Fix: `[^\n\r\u{2028}\u{2029}]`. Separately, do NOT add `(?m)` — Rust's `$` without `(?m)` is already end-of-haystack with no trailing-newline tolerance, matching JS. | "a\u{2028}/x/claude agents" -> JS CLAUDE_MGMT FALSE (the `.*` cannot cross U+2028 and `^` is not multiline); Rust with a bare `.` TRUE. |
| LEGACY_PI_COMPATIBLE_TITLE_RE — the trailing `\s*.*$` after the delimiter | `\s*` CAN cross newlines but the following `.*` CANNOT, and `$` is not multiline. So the payload may contain at most one newline-free run, preceded only by whitespace. Verified: "π -\nfoo" TRUE, "π - foo\nbar" FALSE. | A porter who simplifies the tail to "anything goes" (dropping `.*$` and just returning true after the delimiter) makes multi-line titles TRUE. Since isPiAgentTitle is the VETO in isGeminiTerminalTitle branch 2, a widened Pi predicate silently suppresses Gemini detection on any multi-line title. | "π - foo\nbar" -> JS isPiAgentTitle FALSE (verified). A widened port returns TRUE, which then makes isGeminiTerminalTitle("π - foo\ngemini") return FALSE instead of TRUE. |
| LEGACY_PI_COMPATIBLE_TITLE_RE — the `π` literal and the required delimiter | Flags are `u` only — NO `i`. `π` is U+03C0 GREEK SMALL LETTER PI exclusively; Π (U+03A0) does not match. And the delimiter group `(?:\s*[-:]\|\s)` is NOT optional: a bare "π" with nothing after it is FALSE, while "π " (pi + one space) is TRUE. | Two independent traps: (a) adding `(?i)` for consistency with the module's other regexes makes "Π - foo" TRUE; (b) treating the delimiter as optional (`?`) makes the bare token "π" TRUE, which then vetoes Gemini detection for any title that merely mentions π. | "Π - foo" -> JS FALSE, `(?i)` port TRUE.  "π" -> JS FALSE (verified), optional-delimiter port TRUE. |
| LEGACY_PI_COMPATIBLE_TITLE_RE and PI_COMPATIBLE_SYNTHETIC_TITLE_RE — the optional spinner prefix `(?:[⠀-⣿]\s+)?` | EXACTLY ONE braille code point, followed by ONE OR MORE whitespace. Verified: "⠋ π - foo" TRUE but "⠋π - foo" FALSE and (for the cursor spinner regex) "⠋⠋ Cursor Agent" FALSE. | Writing `[\u{2800}-\u{28FF}]*\s*` or `+` for the braille run (natural, since real spinners cycle glyphs) accepts inputs JS rejects, and making the `\s+` an `\s*` accepts "⠋π". | "⠋⠙ π - build" -> JS isPiAgentTitle FALSE; a `+`-quantified port TRUE. |
| isCursorAgentTitle stage 4 — `/^[⠀-⣿] Cursor Agent$/u.test(trimmed)` | Tested against `trimmed`, NOT `lower`, and the regex has no `i` flag. So the branch is CASE-SENSITIVE on exactly "Cursor Agent", with exactly one ASCII space U+0020 (not \s) between the braille char and the C. | A port that reuses the already-computed lowercased value (the obvious refactor, since stages 3 and 4 sit adjacent) makes "⠋ cursor agent" TRUE where JS gives FALSE. Likewise replacing the literal space with `\s` accepts "⠋\tCursor Agent". | "⠋ cursor agent" -> JS FALSE (verified), lower-based port TRUE.  "⠋  Cursor Agent" (two spaces) -> JS FALSE (verified). |
| isGeminiTerminalTitle — branch 1 (glyphs) sits BEFORE branch 2 (the isPiAgentTitle veto) | The glyph disjunction returns TRUE and exits before the Pi veto is ever evaluated. The comment states the intent: "Gemini OSC glyphs are stronger evidence than any cwd/session text." | Rust ports of classification ladders routinely get rewritten as a single `match` or a guard-clause reshuffle that hoists the cheap-looking Pi veto (one regex) above the four `contains` calls. That reordering is a behaviour change, not an optimization. | "⠋ π - ✦ building" -> real order TRUE (glyph wins); Pi-veto-first order FALSE. |
| isPiTerminalTitle vs isPiAgentTitle — two exports differing only by `&& !containsBrailleSpinner(title)` | isPiAgentTitle = identity (Pi/OMP, spinning or not). isPiTerminalTitle = identity AND settled. isGeminiTerminalTitle's veto uses the IDENTITY one. | Deduplicating them into one function (they are one line apart and one is a bare alias) collapses a real distinction. If the veto in is_gemini_terminal_title ends up calling the settled variant, a SPINNING Pi title falls through to branch 3 and any Pi title whose payload mentions gemini becomes TRUE. | "⠋ π - gemini" -> real isGeminiTerminalTitle FALSE (pinned in agent-status.test.ts:429). If the veto used isPiTerminalTitle, the braille makes the veto FALSE, branch 3 token-matches "gemini" -> TRUE. |
| titleHasAgentName's AGENT_NAMES membership gate — `AGENT_NAME_RE_BY_NAME.get(name)?.test(title) ?? false` | Optional chaining on a Map miss yields `undefined`, and `?? false` converts that to FALSE. The lookup key is case-sensitive. So the function returns FALSE for any `name` not literally in AGENT_NAMES, INCLUDING 'droid', 'hermes', 'agy' and 'Gemini'. | This is the `is_some` vs truthiness shape: the natural Rust is `map.get(name).map_or(false, \|re\| re.is_match(title))`, but the natural WRONG Rust is a generic `title_has_token(title, name, true)` with no membership check — which would silently start matching arbitrary names and make titleHasAgentName(x, 'droid') accept 'droid.exe'. orca-core already implements the gate correctly (`if !AGENT_NAMES.contains(&name) { return false }`); keep it. | titleHasAgentName("droid.exe ready", "droid") -> JS FALSE (droid is not in AGENT_NAMES). A gate-less port -> TRUE. |
| The exe-suffix option in buildAgentNameRe: `(?:\.(?:exe\|cmd\|bat\|ps1))?` followed by `(?![\w./\\-])` | JS backtracks: if the greedy suffix match leaves the lookahead failing, it retries with no suffix. It looks like the Rust non-backtracking scan could diverge. | It cannot, and knowing why prevents a porter from 'fixing' the existing Rust. PROOF: every suffix begins with `.`, and `.` is itself in the right-boundary class `[\w./\\-]`. So whenever a suffix matched, the no-suffix retry lands on that same `.` and fails the lookahead too. The retry can never rescue a start position the greedy path rejected, so a single-pass greedy consume is exactly equivalent. orca_core's title_has_token relies on this (it `break`s on the first suffix and never retries) and its `get_based_token_scan_agrees_with_the_index_based_scan` test covers "claude.exe.exe" and "claude.ps1x". | "claude.exe-x" -> both paths FALSE at start 0 (suffix path hits '-', no-suffix path hits '.'), so JS and the non-backtracking Rust agree on FALSE. |
| The token-boundary scan in general — indexing the haystack | JS regex lookbehind/lookahead inspect a single UTF-16 CODE UNIT. Astral chars appear as two surrogate halves, neither of which is in `[\w./\\-]`, so a boundary adjacent to an emoji always passes. | Indexing a Rust `&str` by BYTE offset to fetch "the char before the match" lands on a UTF-8 continuation byte for any multi-byte neighbour and either panics or misclassifies. Scan over `Vec<char>` (what orca_core::title_has_token does) or use char_indices. Result-wise char and UTF-16 iteration agree here because every boundary-class member and every braille/gemini glyph is BMP — the divergence risk is a panic, not a wrong answer. | "é claude" — a byte-indexed left-boundary read grabs 0xA9 (a continuation byte) instead of the space. |
| containsAny — needles are NOT lowercased, and the substring test has no boundary guard | `title.toLowerCase().includes(word)` with `word` used verbatim, plus `Array.prototype.some` short-circuit. Empty word list -> false; an empty-string word -> true for every title. | Two temptations. (a) Lowercasing the needles "for symmetry" changes the contract — containsAny('abc', ['ABC']) must stay FALSE (verified). (b) Adding a word-boundary guard to match the rest of the module's style would break the only real call site, which searches for the multi-word phrase 'action required' inside arbitrary title text. containsAny is deliberately the module's one unguarded substring matcher. | containsAny('abc', ['ABC']) -> JS FALSE; a needle-lowercasing port -> TRUE. |

---

