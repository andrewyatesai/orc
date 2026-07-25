# BUILD-PLAN — committed terminal program, dependency-ordered waves

Scope: the eight designs in `upstream-triage/designs/` (with their Critic notes applied), **plus**
the engine/product roadmap batch from `ATERM-SCROLLBACK-SEARCH.md` §4 **as corrected by
`CODEX-ROADMAP-REVIEW.md`**, **plus** federated search v1 (`FEDERATED-SEARCH-DESIGN.md`, revised).
Compiled 2026-07-22.

Naming: `audit E1…E10 / P1…P8` = ATERM-SCROLLBACK-SEARCH §4 items (Codex-corrected scope).
`fed E-1…E-6` = FEDERATED-SEARCH-DESIGN §3 items. Design shorthand: `CM-A1…A5/B2` =
context-menu-and-hooks, `PC-####` = partial-completions issue sections, `RD-####` =
runtime-divergences issues.

## Standing assumptions

- **Already landed (excluded from waves):** audit **P1** (find-as-you-type debounce +
  generations/cancellation, Codex-modified scope) and **fed E-6** (budgeted, resumable wasm
  search — build-phase slicing) which shipped with it. Wave 4's E2 work must preserve the E-6
  cursor contract when it replaces the backend.
- **Codex-rejected/redesigned items are scheduled only in their corrected form**: E2/E6/E7/E10
  split or redesigned; P7 only as "decouple the grid-row mirror", never suppress-STATE-until-settle;
  E10's truncation surfaced out-of-band (no fake sentinel line); P2 carries no +58% promise.
- **Deferred entirely (Wave 6 backlog, not committed):** audit E6b (multi-layer caches), E7
  (scroll-blit — the translate primitive is explicitly incomplete, scroll_translate.rs:54),
  E10d (push-depth: bench first), plus all design-internal "v2/optional" items.

## Wave rules (constraints honored)

1. **E0 benchmarks first**: no aterm-engine performance work merges before the Wave-0 gate suite
   is committed and green. (Wave 1 is product-only and runs concurrently.)
2. **Engine before dependent product**: every product item that consumes a new engine surface
   sits ≥1 wave after that surface (A3 menu ← A3 binding; deep-links PR1 ← scheme capability;
   federated v1 ← fed E-1/E-5; P8 cap raise ← audit E1 + E2).
3. **Federated search after audit E2/E4** (program mandate): fed v1 is Wave 5, after the Wave-4
   search-engine rework. Fed E-1's summary contract is therefore implemented **once**, on the new
   backend — no interim double implementation (the fed design's own "E-1 now, parity later" plan
   is superseded by this mandate).
4. **No two concurrent tracks write the same subsystem** (see matrix). Where two program items
   touch one subsystem they are either sequenced inside one track or placed in different waves:
   keyboard-handlers (W1 custom-keybindings → W2 compose-box), shell-ready files (W1 nushell PR1 →
   W3 PC-7596), win32 spawn (W2 nushell PR3 → W3 PC-7467), `rpc/methods/terminal.ts`
   (W4 parking-2 budget → W5 fed remote wire), aterm-glue link path (W2: #6880 then P3, one
   track), wasm blob/pin regen (exactly one per engine wave, batching that wave's bindings).
5. **Per-wave gates**: (a) every named test in the constituent designs green + suite-wide CI;
   (b) adversarial review — Trust-convention adversarial for any aterm surface (ty_model! where
   stateful, spec_xref registration), security-focused review for product surfaces flagged below;
   (c) Codex review of the wave's diffs against this plan. A wave does not open until the prior
   wave's gate closes (tracks inside a wave are concurrent).

---

## Wave 0 — E0: benchmark & gate suite (runs concurrently with Wave 1)

The Codex review's #1 missing item; precondition for every engine wave.

| Item | Content | Effort |
|---|---|---|
| E0-bench | Committed wasm **CPU and GPU** benchmarks: ingest/flood, scroll+present cost, search build/update/query/RSS, restore latency; realistic corpora (incl. repetitive-log corpus — the audit's rotating-alphabet caveat) | M |
| E0-gates | Perf-gate floors beyond catastrophic-only (audit §5.6: 0.45 pass-ratio) + same-box trend ledger; resize/rewrap fence (§5.3); ARENA-SCROLL on-glass head-to-head run (§5.4) | S |
| E0-daemon | Restore the missing daemon flood harness (`daemon-flood-timed` class) so P2 is measurable on native/WSL/SSH | S |
| E9a | `search_meta` export carrying `incomplete` (Codex: correctness, move early) — one wasm export + pin regen | S |

**Wave effort: M–L.** Parallelizes internally (bench authoring ∥ gate plumbing ∥ daemon harness).
Engine work: yes (bench-only + one tiny export). Gate: floors committed + methodology
adversarial + Codex.

## Wave 1 — product-only, engine-independent (concurrent with Wave 0)

Six disjoint-subsystem tracks; no aterm writes anywhere.

| Track | Items | Subsystem | Effort |
|---|---|---|---|
| 1A | RD-9193 converge `--tab` close (S) → RD-9169 daemon-backed liveness (M) — this order per the design's rollup | orca-runtime.ts + daemon adapter | S+M |
| 1B | custom-keybindings M1→M4 (incl. repeat-precedence fix from Critic notes) | shared/keybindings, keybinding-file, IPC, Settings, **keyboard-handlers (claimed this wave)** | L |
| 1C | nushell PR1 (POSIX spawn + integration + settings, M) → PR2 (SSH wrapper/#7715, S; regression-test remote kill/timeout paths per Critic notes) | shell spawn, shell-ready (both copies), ssh exec | M+S |
| 1D | PC-8367 fallback-font stacks (M) ∥ PC-5611/8977 verified clipboard writes (M) | fonts / clipboard+main-window | M+M |
| 1E | CM-B2 orca.yaml quickCommands (M); CM-B1 is a verification record — close it in triage tracking | hooks / orca-yaml / trust dialog | M |
| 1F | ssh-pane-parking **phase 1** (`ssh:` class; ordering test written first per Critic notes) | parking predicate, pty-connection reveal path, relay tests | S–M |

**Wave effort: ≈ XL total; calendar ≈ L across 6 parallel tracks.**
Adversarial focus: B2 trust gating (shared-command injection), clipboard IPC surface,
custom-keybindings bare-key shadowing. Engine work: none.

## Wave 2 — engine batch 1 (small surfaces) + freed product surfaces

| Track | Items | Subsystem | Effort |
|---|---|---|---|
| 2A **engine** | audit E8 `cell_frame_into` (XS, endorsed as-specified) + CM-A3 `last_command_output` binding (**`&mut self`**, S) + deep-links §7 host-minted hyperlink scheme capability (M; ty_model! + spec_xref + adversarial per design). **One** wasm blob/pin regen for all three | rust/aterm + wasm pin | M+ |
| 2B | PC-6880 kind-0 OSC-8 rerouting through `handleOscLink` (S) → audit P3 `scrollPx` worker-protocol plumbing (S–M, Codex scope: facade + protocol messages, preserve delta modes/TUI forwarding) — sequential, same subsystem | pane-manager aterm glue | S+S–M |
| 2C | compose-box (M) — keyboard-handlers freed after 1B | terminal-pane UI | M |
| 2D | RD-9156 query-reply election (M; subscribe-ack authority per Critic notes) | orca-runtime + pty-connection | M |
| 2E | nushell PR3 Windows surface + WSL (M) → PR4 agent-startup dialect (S–M) | win32 spawn, WSL, TabBar/settings | M+S–M |

**Wave effort: ≈ XL; 5 parallel tracks.** Engine work: yes.
Gate additions: deep-links scheme-smuggling adversarial suite (design §7.2 named tests);
A3 Trust review; compose-box IME repro tests.

## Wave 3 — engine batch 2 (memory/present core) + dependent product

| Track | Items | Subsystem | Effort |
|---|---|---|---|
| 3A **engine** | audit E1-modified (attach hot+warm LZ4 tiers in wasm ctor + daemon builder; **single total retention limit**; per-pane/global budgets; wasm-LZ4 vs native-zstd split) + E10a byte watermark co-landed (out-of-band truncation) + E3-modified dirty-band present (RGBA bands + **overlay damage/second canvas**) + E5-modified absolute-anchor precheck (selection/cursor/images/fractional tests) + E6a run-cursor only. One pin regen | rust/aterm | L |
| 3B | audit P4 scrollback-rows forwarding (full protocol span per Codex: provider opts → CreateOrAttach → adapter → Session → Rust RPC + old-daemon skew) + P5 incremental replay hydration (async, no 5 MiB sync freeze) | daemon protocol / restore | M+M |
| 3C | audit P2 writer-side semantic coalescing, re-benchmarked via E0-daemon (ordering + control-event flushes; binary + NDJSON) | orca-daemon rust | S–M |
| 3D | deep-links **PR1** (M) — deps satisfied: W2 scheme capability + W2 PC-6880 | main startup/packaging + osc-link routing | M |
| 3E | CM-A items: A1 search-selection (S), A2 link-target menu (M), A3 renderer plumbing over the W2 binding, A4/A5 (XS) | terminal-pane UI/context menu | M+ |
| 3F | PC-7467 custom shell paths (M) + PC-7596 re-run-last-command (M; 633;E once-per-prompt + un-nonced-accept test per Critic notes) | win32 spawn chain / shell-ready hooks / restore banner | M+M |

**Wave effort: ≈ XL+; 6 parallel tracks.** Engine work: yes.
Gate additions: E1/E3/E5 must hold Wave-0 perf floors (no silent 2x regressions — the trend
ledger is now the gate); tiered-budget adversarial (OOM/unbounded-growth semantics);
deep-links registration manual-QA matrix (design §10).

## Wave 4 — search-engine rework (unified audit E2/E4 ≡ fed E-2/E-3/E-4) + parallel product

The program's riskiest wave; Codex's "most serious roadmap mistake" correction is its charter:
document identity, eviction, short-query scan, reflow, and lifecycle are redesigned **before**
incremental hook-up.

| Track | Items | Subsystem | Effort |
|---|---|---|---|
| 4A **engine** | audit E2-redesigned: compact doc IDs; explicit append/replace/evict/reflow/clear/alt-screen events; StreamingSearch becomes the live backend (resolves E10c by wiring, not deleting); differential equivalence oracle vs legacy index. Then audit E4 / fed E-3: posting container (benchmarked) + String-duplicate drop via `SearchContent`, target ≤250 B/line. Plus fed E-4 (`SearchContent` over ring + W3 tiered store), E9b memmem verify (benched; literal path only), search-index release-on-close/idle eviction (Codex missing item), and **fed E-1** `search_summary` (snippet+total+incomplete) implemented once on the new backend, superseding E9a. Preserve the landed fed E-6 cursor contract | rust/aterm search crates + wasm | XL |
| 4B | audit P6 (binary-search visibleRects + versioned throttle with pending state + guaranteed final refresh) + P7-redesigned (decouple/rate-limit **only** the grid-row mirror; batch row export pairs with E9) | worker mirror / search UI | M |
| 4C | deep-links **PR2** (worktree/pair/run + consent dialog + navigation deferral in renderer listeners) | renderer consent UI / notifications path | M |
| 4D | ssh-pane-parking **phase 2** (`remote:` class; watcher byte-source injection, exit classification, **host subscribe-snapshot budget** in rpc/methods/terminal.ts, skew fallback) | runtime RPC + parked watchers | M |
| 4E | fed E-5 daemon/headless search entry (`orca-terminal`/`orca-ffi`/`orca-daemon`) + `searchSessions`/`searchContext` daemon RPC + parked-adapter groundwork — fed sequencing step 2, no aterm dependency | orc rust crates + daemon protocol | M |
| 4F | RD-9163 (decline ask 1; delivery-follows-pane-key + canonical mint; orchestration schema v6→v7 twins + napi + parity harness; `handleByLeafKey` cleanup per Critic notes) | orchestration store + orca-runtime handles | L |

**Wave effort: ≈ XXL (engine XL + product ~3M + L); 6 tracks, engine track is the critical
path.** Engine work: yes (heaviest).
Gate additions: E2 equivalence oracle byte-identical; incremental-search correctness suite
(eviction, reflow, resize, ED3/RIS, alt-screen switch, short queries at large absRow, ID
exhaustion — Codex missing item); committed search benchmarks with floors (B/line, build,
per-line incremental); daemon protocol version-skew tests (P2/P4 follow-through).

## Wave 5 — federated search v1 (mandate: after E2/E4 — satisfied)

| Track | Items | Effort |
|---|---|---|
| 5A | Federation controller + global palette (Cmd/Ctrl+Shift+F) + worker `federatedFind` serial fan-out; §4 admission control retained as belt-and-braces for the in-process fallback; sessionId dedup + depth-extension cutoff; stale-paneRef degradation | M–L |
| 5B | Remote wire: `terminal.search`/`terminal.searchContext` + `hostRowAnchor`/`anchorGen` (+ snapshot-reply anchor), SSH mux routing, relay abort, old-host degradation — lands **after** 4D freed `rpc/methods/terminal.ts` | M |
| 5C | Parked + daemon adapters on 4E's E-5/RPC; parked-remote federation rules from ssh-pane-parking §3.7 (store-state discovery, id-class routing, fresh-anchor remap) | M |
| 5D | audit P8: scrollbar match markers, pending-state label, **raise the 50k cap** (E1 + bounded incremental search now proven) and fix the 50k/100k policy inconsistency (terminal-scrollback-policy vs TerminalEngineBehaviorSections) | S |
| 5E | Federated perf-gate scenario (N panes × M lines, cold/warm) added to the Wave-0 suite — §4 budgets become gates | S |

**Wave effort: ≈ L–XL; 5A ∥ 5B ∥ 5C then 5D/5E.** Engine work: none new (consumes Wave-4
surfaces). Gate: full FEDERATED-SEARCH §6 matrix (dedup, admission, stale-ref, anchor remap,
cancellation, Windows conin/conpty green) + adversarial on the remote wire (provider-generic,
schema-versioned) + Codex.

## Wave 6 — backlog (explicitly not committed)

audit E6b (cache layers — only with E6a run-cursor bench data), E7 scroll-blit (needs the
cross-crate incoming-strip raster first), E10d push-depth (bench then decide), nushell optional
`ShellType::Nushell` upstream-aterm integration, CM-A3 phase-2 daemon RPC (reattach-surviving
blocks), compose-box v1.5 `@`-path completion, custom-keybindings v2 `when`-clauses/repo scope,
deep-links `orca-staging` questions, fed fuzzy toggle, remote cold-activation parking.

---

## Subsystem ownership matrix (concurrent-write safety)

| Subsystem | W0 | W1 | W2 | W3 | W4 | W5 |
|---|---|---|---|---|---|---|
| rust/aterm engine + wasm pin | 2A-bench/E9a | — | 2A | 3A | 4A | — |
| pane-manager aterm glue (link/scroll/worker proto) | — | — | 2B | — | 4B | 5A (worker fan-out) |
| keyboard-handlers / terminal-pane UI | — | 1B | 2C | 3E | — | 5A (palette is app-level) |
| orca-runtime.ts / runtime RPC | — | 1A | 2D | — | 4D, 4F | 5B |
| daemon (node+rust) protocol | — | 1A (adapter) | — | 3B, 3C | 4E | 5C |
| shell spawn / shell-ready / ssh / wsl | — | 1C | 2E | 3F | — | — |
| keybindings | — | 1B | — | — | — | — |
| hooks/orca-yaml | — | 1E | — | — | — | — |
| fonts / clipboard | — | 1D | — | — | — | — |
| parking / pty-connection | — | 1F | 2D (reply gate only) | — | 4D | 5C |
| main startup / packaging | — | — | — | 3D | 4C | — |
| orchestration store (rust) | — | — | — | — | 4F | — |

W1↔W0 concurrency is safe (disjoint: TS product vs rust bench harness). Within every wave the
tracks above are pairwise disjoint; sequential handoffs are annotated in Wave rules §4. The one
soft overlap (2D touches pty-connection after 1F did) is cross-wave, hence sequential by
construction.

## Effort & parallelism rollup

| Wave | Engine effort | Product effort | Total | Parallel tracks | Calendar shape |
|---|---|---|---|---|---|
| 0 | M–L (bench) | — | M–L | 3 | short, gates everything |
| 1 | — | 2L + 5M + 2S | XL | 6 | concurrent with W0 |
| 2 | M+ | 3M + 3S | XL | 5 | engine track short; product dominates |
| 3 | L | ~6M | XL+ | 6 | engine is critical path |
| 4 | XL | 3M + L | XXL | 6 | engine E2/E4 is THE critical path of the program |
| 5 | — | L–XL | L–XL | 5 | remote wire gated on 4D/4E only |

Program total ≈ 5 gated waves of XL-class throughput; the critical path is
**E0 → engine-batch-1 → engine-batch-2 (E1) → E2/E4 rework → federated v1**, with everything
else scheduled to saturate parallel tracks without ever co-writing a subsystem.

## Cross-design corrections folded into this plan

1. **PC-6880 promoted ahead of deep-links PR1** (W2 → W3): deep-links §5 is dead code on aterm
   panes without it (see orca-deep-links Critic notes).
2. **CM-A3 binding is `&mut self`** (blocks_api `output_blocks` is `&mut`) — carried into 2A.
3. **RD order** (#9193 → #9169 → #9156 → #9163) preserved across W1/W2/W4; #9163 deliberately
   last (schema + adoption precedence benefits from #9169's single liveness source).
4. **Fed E-1 implemented once on the post-E2 backend** — the E-1↔E-2 parity oracle obligation
   from the fed design collapses into a single implementation because of the mandated ordering.
5. **Parking phase 2 before fed remote wire** — both write `rpc/methods/terminal.ts`.
6. **E10 byte watermark travels with E1** (W3), truncation out-of-band; dead StreamingSearch
   resolved by E2 wiring it (W4) — per Codex splits.

## Wave-1 ownership waivers (2026-07-22)

Post-merge gate review (range `056a3add1..a48445a44`) found three cross-track edits that
violated the W1 column of the ownership matrix. All three are retained: each was necessary for
its track's deliverable, none conflicts semantically with the owning track's changes, and each
is now pinned by a composition test. Recorded here as the plan amendment the gate rules allow.

1. **1D → `keyboard-handlers.ts` (claimed by 1B), commit `ddc5a8e17`.** The verified-clipboard
   deliverable had to convert the Cmd/Ctrl+Shift+C fire-and-forget copy site, which lives in
   1B's claimed file. The edit refactors only the `copySelection` action branch into
   `copyPaneSelectionViaShortcut` (routing through the `terminal-copy-outcome` seam); 1B's
   resolver ladder, repeat-precedence guard, and bare-key suppression are untouched, and the
   built-in-shadows-custom precedence for the shared `Mod+Shift+C` chord composes with the new
   pathway. Pinned by `keyboard-handlers-custom-actions.test.ts` ("custom bindings compose with
   the verified copy path"): same-chord custom sendText stays shadowed while the verified copy
   seam runs; an empty-selection decline leaves the chord unconsumed without falling through to
   the custom entry.
2. **1D → `pane-manager/aterm/aterm-clipboard-copy.ts` (unclaimed in W1; 2B's subsystem from
   W2), commit `ddc5a8e17`.** Same deliverable: the aterm copy-on-select site is one of the
   fire-and-forget clipboard writes PC-5611/8977 exists to fix; skipping it would have shipped
   the feature with its highest-traffic path unverified. No W1 track co-wrote the file. Pinned
   by the new `aterm-clipboard-copy.test.ts` (routes through the verified seam as
   'copy-on-select'; preserves the `__atermLastCopied` e2e probe) — 2B inherits the file with
   its contract tested.
3. **1E → `orca-runtime.ts` (claimed by 1A), commits `b27c6a7da`/`7fae00337` (+`TerminalPane.tsx`,
   claimed by 1B).** The single-trust-text refactor renamed
   `getDefaultTabCommandTrustContent` → `getSharedCommandTrustContent` at the two runtime
   hooks-snapshot call sites so main/runtime/renderer hash the same content — leaving the old
   name in the runtime would have split the trust hash. Mechanical rename in the hooks-snapshot
   region only; 1A's `--tab` close (`closeMode: 'pty'`) and daemon-liveness logic are in
   disjoint regions and their suites pass unchanged. The rename itself is pinned by an
   `orca-runtime.ts` composition test (`orca-runtime.test.ts`, "getRepoHooks hashes the full
   shared command trust content identically to the renderer source module"): both production
   `getRepoHooks` branches (local and SSH) are driven through the REAL
   `shared/orca-yaml-trust-content` module — the exact module `ensure-hooks-confirmed`/
   `use-project-quick-commands` import — and the resulting `setupTrust.contentHash` must equal
   an independently computed sha256 over that shared content (setup + defaultTabs +
   quickCommands incl. agent prompts), so the rename provably cannot split the trust hash.
   The `TerminalPane.tsx` edit adds the dispatch-time trust gate for project quick commands
   next to 1B's two-line `customKeybindings` threading — disjoint props, pinned at the actual
   composition point by `TerminalPane.trust-gate-composition.test.tsx`, which mounts the REAL
   `TerminalPane`: store `customKeybindings` reach the real keyboard hook through TerminalPane's
   wiring and dispatch to the pane transport (1B survives); the mounted component's
   `onQuickCommand` trust gate fails closed for untrusted `orcaYaml:` commands, passes through
   only when the repo trust record covers the shared-content hash, and both behaviors coexist
   in the same mount. The keyboard-path seam is additionally pinned by
   `keyboard-handlers-custom-actions.test.ts`: a custom binding naming a project (`orcaYaml:`)
   quick-command id fails closed on the keyboard path, so repo-controlled bytes cannot bypass
   TerminalPane's trust gate via 1B's dispatch.

Verification run: `terminal-shortcut-policy-custom`, `keyboard-handlers`,
`keyboard-handlers-custom-actions`, `keyboard-handlers-encode-key` (39), `orca-runtime` (799,
incl. the shared-trust-content composition pin), `TerminalPane.trust-gate-composition` (4),
quick-commands/trust suites (`project-quick-commands`, `use-project-quick-commands`,
`TerminalContextMenu`, `terminal-quick-command-dispatch`, `hooks`, `orca-hook-trust`,
`ensure-hooks-confirmed`; 112), and the full terminal-pane sweep — all green at `a48445a44` +
these pins.

## Wave-2 gate amendments (2026-07-22)

Gate review (range `4c45e13ee..HEAD`, aterm `adb8e73b→7c9bf149`) recorded two plan
amendments; both follow the Wave-1 waiver rules (necessary for the deliverable, no semantic
conflict, pinned by tests).

1. **CM-A3 receiver is `&self`, superseding cross-design correction #2.** The `&mut self`
   requirement existed solely because `blocks_api::output_blocks` needed
   `make_contiguous()`. 2A dissolved that premise instead of inheriting it: aterm
   `dce349fc` adds `Terminal::last_completed_block(&self)` — a contiguity-free read of the
   newest row-sealed block — and the wasm facade `last_command_output(&self)` rides it
   (`output_blocks` is now `#[cfg(test)]`). A read-only binding is the strictly safer
   surface for 3E's renderer plumbing (context-menu reads must not be able to mutate the
   block ledger). Pinned by `last_completed_block_returns_newest_sealed_block_only`
   (blocks_api.rs) and the CM-A3 wasm-export tests in `aterm-wasm/src/lib.rs`.
2. **2E → `orca-runtime.ts` + preload API files (2D's W2 subsystems).** PR4's
   agent-startup dialect had to convert the five `resolveLocalWindowsAgentStartupShell`
   call sites to the new POSIX-aware resolver and thread `terminalPosixShell`; the
   capability plumbing (design item 5) adds `nushellAvailable` beside `gitBashAvailable`
   in `api-types.ts`/`index.ts`/`web-preload-api.ts`. All edits are region-disjoint from
   2D's query-reply election (agent-launch sites + additive API entries vs. the
   view-subscriber registry and subscribe-ack path); the four files auto-merged with no
   conflicts, and the merged composition is green across the `orca-runtime`, runtime-RPC
   `terminal` and agent-startup suites plus the full `src/main` sweep (17k+ tests).

The Wave-2 gate's third finding — `NushellIcon` hardcoded a green brand tile against
nushell design §3.6 (styleguide tokens; GenericTerminalIcon B/W palette) — was fixed in
code, not waived: the tile now uses the CmdIcon/Generic `#1F1F1F`/`#ffffff` palette and
the WslIcon text-tile type treatment.

## Wave-3 gate amendments (2026-07-23)

Gate round 1 fixed two findings in code (E3: both CPU present paths now consume the
engine's dirty bands — direct painter under an overlay-triggered full-band policy, worker
path unconditionally against its separate overlay canvas, pinned by
`aterm-frame-painter.test.ts`; PC-7596: the un-nonced 633 test asserts acceptance
POSITIVELY via a 633-only lifecycle sealing a readable block). Two amendments are
recorded under the Wave-1 waiver rules:

1. **P2's WSL re-bench lane is deferred to Wave 4's daemon version-skew work.** The
   Codex-corrected P2 scope names native/WSL/SSH. Native and SSH are measured with the
   committed `daemon-flood-timed` harness (four-cell ABBA + two isolation ABBAs —
   P2 exactly neutral over SSH; the −14% native-binary delta attributed entirely to the
   E1 tiered attach; recorded in `daemon-pty-drain-investigation.md`). No Windows/WSL
   host exists in the integration environment; the harness runs unchanged inside a WSL
   distro, and Wave 4's gate already requires daemon protocol tests "across native, WSL,
   SSH" (P2/P4 follow-through), which is where the missing run lands. No +58% claim is
   made anywhere.
2. **Gate-driven cross-track edit: E3 host adoption touched the pane-manager aterm glue**
   (`aterm-frame-painter.ts`, `aterm-worker-engine-build.ts`, new
   `aterm-worker-band-present.ts`) — a subsystem the W3 matrix leaves unclaimed (2B owns
   it in W2, 4B in W4). Necessary for the gate's E3 end-to-end requirement; no W3 track
   co-wrote those files; behavior pinned by `aterm-frame-painter.test.ts` and the full
   pane-manager/terminal-pane sweep + perf floors (bench:check PASS) at the merge.

The E1 attach's measured flood cost (−14% native binary, committed harness, isolation
ABBA at the same aterm pin) is accepted for Wave 3 — inside the "no silent 2x" bar,
recorded openly with the staging-path lever for any future floor on this class.

## Wave-6 closure gate (2026-07-23) — FINAL gate FAIL; residual disposition

The Wave-6 federation-closure integration (merge of `w6-closure`: fed items 1–3, aterm
re-pin to `4a82438c`) passed typecheck, lint, the targeted vitest sweep (federation +
pane-manager + terminal-pane + search, ~4272 tests), the orc rust suite (1143 tests),
and the `bench:check` floors — but **FAILED the adversarial FINAL gate on substance** and
was **NOT pushed** to orc main. The gate correctly found the closure is scaffolding ahead of
its engine: the surfaces it consumes do not exist in the pinned engine and its production
remote paths are inert. Independently verified. The following residuals are hereby **carried
to the Wave-6 backlog** (they are NOT landed and must not be represented as such):

1. **fed E-1 `search_summary` + `row_range_json` + `search_index_release` wasm exports do not
   exist in the pin (`4a82438c`).** `aterm_wasm.d.ts` exposes only budgeted search; the aterm
   search rework is milestone-2/3 **partial** (sortedvec posting container + `release()` on the
   streaming search landed; the E-1 summary export and the E4 `SearchContent` String-duplicate
   drop did not). The product-side consumers (`aterm-worker-search-summary.ts`,
   `aterm-worker-federated-find.ts`) feature-detect and fail-closed to count-only, so in
   production they **always** degrade; their green tests exercise mock engines only. Carry:
   implement the E-1/E4 exports on the backend, then the consumers become live.
2. **The budgeted engine discards its completed index (`search_budgeted.rs:327`)** rather than
   retaining it as a readable index, so the "bounded read over the index the scan just built"
   contract the summary consumer assumes has no engine implementation. Carry with item 1.
3. **5C remote/daemon federation is inert.** `discoverRemoteFederatedPanes()` returns `[]`,
   live-pane discovery keeps `sessionId:null`, and daemon expansion is disabled — the 5C adapter
   and the (d1) daemon→live row-space helper have no production caller. Carry: remote-transport
   owner supplies per-pane multiplexer anchor + replay geometry.
4. **(d3)/(d4) blocker tests are not meaningful as written.** (d3) computes a plain
   `offset = matchHostRow − hostRowAnchor` with no rewrap/nearest-boundary math (width only flips
   the `approximate` flag); (d4) stipulates a fixed `hostRow` and mutates an ignored `hostCols`
   field rather than resizing a real host engine. Carry: real width-mismatch remap + a
   resize-driven stability test once a live host engine is reachable. (d1)/(d2) are sound.
5. **5D scrollback cap unchanged (still 50k), 5E cold/warm federated benchmark absent, the 4 Hz
   stale-pane refresh is an always-false field, and P2's WSL re-bench (carried from Wave 3) is
   still undisposed.** Carry all four.

B/line honesty correction (landed this commit, code-comment only): the §4 admission constant
`FEDERATED_INDEX_BYTES_PER_LINE = 1283` was mislabeled "audit-measured". 1283 is the
unreproducible external-audit figure; the honest committed measurement is 521.9/338.8/394.2
B/line (rotating/replog/linkheavy) post-sortedvec, ≤250 target **still open**
(`rust/aterm/docs/measured/search-posting-containers.md`). The constant is retained as a
deliberate conservative over-estimate (admission skips sooner); only its provenance was corrected.
