# Federated Terminal Search — Design

One query across every terminal pane orc knows about — live local panes, hidden/parked panes,
daemon-persisted history, and remote/SSH panes — with ranked, grouped results and
jump-to-pane-and-row. Companion to the scrollback/search audit
(`upstream-triage/ATERM-SCROLLBACK-SEARCH.md`). Paths relative to `/Users/ayates/orc` unless
prefixed `rust/aterm/`.

Standing policy applies throughout: capability lands **in the engine** (aterm crates / orc rust
crates), never as glue re-implementations. Every adapter below calls the same Rust matching
kernel (`aterm-search`); TypeScript only routes queries and merges summaries.

## 1. UX Contract

### Invocation

- `Cmd+Shift+F` (`Ctrl+Shift+F` off-Mac, per AGENTS.md platform-check rule) opens a global
  palette hosted in the same lazy-modal + `CommandDialog` machinery as QuickOpen
  (`src/renderer/src/components/QuickOpen.tsx:33` reads `activeModal === 'quick-open'`;
  lazy mount at `src/renderer/src/App.tsx:2333-2337`; primitives from `components/ui/command`).
- Per-pane `Cmd+F` (`src/renderer/src/components/TerminalSearch.tsx`) is untouched;
  `Cmd+G`/`Cmd+Shift+G` stay pane-scoped
  (`src/renderer/src/components/terminal-pane/keyboard-handlers.ts:118-144`).
- The pane find bar gains a "search all terminals" escape hatch that reopens the current query
  in the global palette.

### Query semantics

- Literal by default, smart-case (case-insensitive until the query contains an uppercase
  letter); explicit case and regex toggles mirroring the pane find bar
  (`TerminalSearch.tsx:108-126` passes `caseSensitive`/`regex` to the engine, which compiles
  regex itself and treats invalid patterns as zero matches —
  `rust/aterm/crates/aterm-wasm/src/lib.rs:1539-1561`).
- One matching kernel everywhere: `aterm-search` compiled into wasm (renderer), into the daemon
  FFI, and into the remote host runtime — a query means the same thing on every source, and
  parity is testable (§6).
- `FilterMode::Fuzzy` already exists in the engine
  (`rust/aterm/crates/aterm-search/src/streaming/types.rs:24-32`) and is reserved for a later
  toggle; the wire shapes below carry a mode enum from day one so adding it is not a protocol
  change.

### Result model

*(rev: paneRef now optional; sessionId added as the daemon-dedup merge key; source-keyed identity)*

One result:

```
{
  paneRef?:  { tabId, leafId, paneKey, worktreeId, title }   // ABSENT when no pane resolves
             // (dead daemon session has no tabId/leafId to fabricate). leafId = stable
             // identity the tab registry exposes (pane-manager-registry.ts:32
             // managersByTabId; TabPaneManager.getPanes() returns leafId)
  sessionId: string | null   // daemon session identity when the source is daemon-backed;
             // THE merge key that dedups a live pane against its own daemon history (§2.3)
  source:    'live' | 'hidden' | 'parked' | 'daemon-history' | 'remote'
  absRow:    number    // engine absolute-row coordinate (aterm-worker-search.ts:9-10);
             // for persisted/remote sources: row within that source's stream, flagged approx
  col, len:  number    // match span
  snippet:   string    // matched line text, span-marked, produced SOURCE-SIDE
  approxTime: number | null   // see below
  incomplete: boolean  // per-source truncation honesty
}
```

- `snippet` is produced where the bytes live — scrollback text never ships to the renderer for
  matching or excerpting.
- `approxTime`: live engine rows carry no timestamps; daemon results use log-batch append time
  (`src/main/daemon/history-manager.ts:153-184` appends seq'd batches on a 5s tick); live panes
  fall back to last-activity time. Rendered with a "~" prefix.
- `incomplete`: the index tracks it (`rust/aterm/crates/aterm-search/src/index.rs:738`
  `results_may_be_incomplete`) but today's wasm export silently drops it
  (`aterm-wasm/src/lib.rs:1539-1561`) — fixed by E-1.
- Result identity is **source-keyed**: daemon-backed results (any source) are identified by
  `sessionId`; live-only results by `paneRef.leafId`. Grouping merges on `sessionId` first so a
  live pane and its daemon depth extension (§2.3) form ONE group, never two.

### Grouping and ranking

- Grouped by pane. Group header: worktree name / tab title / source badge / exact-or-flagged
  per-pane total; body: top-K matches (K=50) with "+N more" expanding to a pane-scoped view.
- Pane order: focused pane, then visible panes, then panes by recency of last output, then
  daemon-history entries for exited sessions.
- Within a pane: newest first (highest absRow), matching the pane find bar's select-last
  behavior (`src/renderer/src/lib/pane-manager/aterm/aterm-worker-search.ts:82-83`).

### Navigation

- **Live/hidden pane**: activate the tab/worktree, focus the pane, then
  `scroll_search_line_into_view(absRow)` + transient highlight (wasm export
  `aterm_wasm.d.ts:362`; display-row math via `search_display_origin`,
  `rust/aterm/crates/aterm-wasm/src/lib.rs:1566-1575`). Hidden panes are still mounted with
  rendering suspended (`src/renderer/src/lib/pane-manager/pane-manager.ts:63-76`), so revealing
  resumes painting and the jump is exact.
- **Parked pane** (TerminalPane unmounted —
  `src/renderer/src/components/terminal-pane/parked-terminal-byte-watcher.ts:1-4`): activation
  un-parks normally; the engine restores from snapshot/replay; the federation layer then
  **re-runs the pinned query inside the restored engine and jumps to the match nearest the
  recorded absRow**. Row identity is NOT stable across a truncated replay
  (`src/shared/terminal-scrollback-limits.ts:1-3`: 512KB replay of a 5MB store), so
  nearest-match-after-restore is the contract; a toast fires when the restored buffer no longer
  contains the match at all.
- **Daemon-history of a dead session**: no pane exists (`paneRef` absent, identity =
  `sessionId`); the result expands inline into a daemon-produced context window (±20 lines).
- **Remote/SSH pane** *(rev: host↔client row mapping specified; snapshot-budget citation
  fixed)*: host-side absolute rows are NOT client-engine absolute rows — the client engine
  replayed only a truncated tail of the combined wire snapshot
  (`src/main/runtime/rpc/methods/terminal.ts:682` — `data: bounded.scrollbackAnsi +
  serialized.data`), so its rows start at the replay boundary, and host/client wrap-width
  differences shift row counts further. Mapping contract: every `terminal.search` response
  (and the snapshot reply itself) carries `hostRowAnchor` — the host absolute row of the FIRST
  row the snapshot serialized (§2.4). Client row = match.hostRow − hostRowAnchor +
  client-replay origin; if that lands inside the replayed window AND the anchor generation
  matches the snapshot the client actually replayed, jump in-pane — flagged approximate when
  wrap widths differ (host is authority for row counts; the client remaps to the nearest row
  boundary). Otherwise deeper history expands inline via a host-side context fetch (§2.4).
  Never a full-history download. Citation correction: this requested-snapshot path is budgeted
  by `REQUESTED_SNAPSHOT_BYTE_BUDGET` (2MB, `terminal.ts:42`) with client-requested rows; the
  previously cited `src/main/runtime/scrollback-limits.ts:7-8` values (1000 rows / 512KB) are
  the separate MOBILE_* subscribe budgets and do not describe this path.
- **Result staleness at click time** *(rev: new — pane death between result and click)*: a
  `paneRef` may no longer resolve when clicked (tab closed mid-search, remote host
  disconnected). The controller treats resolution failure as an expected outcome, not an
  error: if the result carries a `sessionId` whose daemon session persisted, degrade to the
  dead-session inline expansion above; otherwise show a "pane no longer available" toast and
  drop the group on the next re-rank. Never throw, never navigate to a fallback pane.

### Liveness

75ms debounce after last keystroke; each keystroke bumps a generation token; Esc cancels all
in-flight source queries. Results stream in per source and re-rank incrementally — remote and
cold-daemon sources must never block local results.

## 2. Architecture

The **federation layer** is a renderer main-thread `FederatedSearchController`
(new `src/renderer/src/lib/federated-search/`): owns the generation counter, fans out to source
adapters, merges/ranks, feeds the palette. Pane discovery: the tab registry
(`src/renderer/src/lib/pane-manager/pane-manager-registry.ts:26-32` — `liveManagers` +
`managersByTabId`) plus store tab/worktree state (which knows parked tabs and remote
providers). Adapter contract:

```
type SearchSourceAdapter = {
  query(q, opts, gen, maxPerPane): AsyncIterable<PaneMatchBatch>   // streams batches
  cancel(gen): void
}
```

### 2.1 Live + hidden local panes — one query into the shared render worker

Every worker-path engine lives in ONE Web Worker
(`src/renderer/src/lib/pane-manager/aterm/aterm-shared-render-worker.ts:1-24`), so federated
search over N local panes is **one** postMessage, not N:

- New *worker-scoped* (not pane-stamped) command `federatedFind {query, opts, gen, maxPerPane}`;
  the worker iterates its engine map calling the E-1 summary API per engine and replies with
  `federatedFindResult` events carrying per-pane batches (time-sliced, §4).
- Plumbing follows the existing id-correlated query channel
  (`aterm-worker-query-channel.ts:1-45`; query/queryResult protocol shapes
  `aterm-render-worker-protocol.ts:223-230, 469-471`).
- The per-pane find-bar state machine (`aterm-worker-search.ts:42-68`) is untouched: federated
  queries must NOT disturb a pane's active find state — separate engine call, no
  `scroll_search_line_into_view`, no highlight mutation.
- *(rev)* The worker does NOT search all engines eagerly: `federatedFind` walks panes
  **serially in priority order** (focused → visible → recency of last output) under the §4
  memory-admission rule — at most K resident on-demand indexes, immediate eviction after each
  non-visible pane's scan. One postMessage in, streamed batches out, but never N indexes
  resident at once.
- *(rev)* In-process-fallback panes (worker unavailable) run the same wasm call on the main
  thread — under the SAME E-6 row budget, sliced across idle callbacks. An unbudgeted call
  here stalls the UI thread itself, which is strictly worse than a worker stall.
- Hidden panes are mounted with live engines (`pane-manager.ts:63-76`) — same path, no extra
  work.

Cost note *(rev: federation voids the on-demand/TTL memory bound)*: today any single cell
write invalidates the whole per-pane index
(`rust/aterm/crates/aterm-core/src/terminal/search_index.rs:14-36`; `content_gen` keying
at :58), so a federated query over 20 streaming panes = 20 full rebuilds. Worse, a federated
query makes EVERY pane "actively searched", so "on-demand + TTL" alone no longer bounds
memory — the serial-scan + admission rule above (§4) is what bounds it. Rebuild cost is
acceptable for an explicit-invoke v1 within the §4 budget; eliminated by E-2.

### 2.2 Parked panes — search the snapshot, never wake the engine

Parked = unmounted, no engine in the renderer. Content lives main-side: the disk snapshot store
(`src/main/terminal-scrollback-snapshots.ts:15-21`, byte limits
`src/shared/terminal-scrollback-limits.ts:1-3`) and, for daemon-backed sessions, the daemon
(§2.3, the superset). Decision: **never wake engines to search** — waking N parked panes means
N engine restores + replays on the shared worker. The parked adapter asks the main process,
which routes daemon-backed sessions to the daemon search RPC and otherwise runs the
orca-terminal search entry (E-5) over the stored snapshot in the main process. ANSI is stripped
by a headless parse in Rust — not a TS regex strip (policy).

### 2.3 Daemon-persisted history — daemon-side Rust search

The daemon holds warm sessions as live `HeadlessTerminal`s — ring-only, text-only scrollback
(`rust/crates/orca-terminal/src/headless.rs:115-135`; `set_scrollback_text_only` at :121-126) —
and persists checkpoint.json + output.log per session with a 5MB cap
(`src/main/daemon/history-manager.ts:26-27`; checkpoint shape :206-218; generation counter
:205). New daemon RPC on the existing framed protocol (5-byte type/length framing
`src/main/daemon/daemon-frame-types.ts:8`; router `src/main/daemon/daemon-pty-router.ts`;
version bump in `daemon-protocol-versions.ts`):

```
searchSessions {query, opts, sessionIds?, maxPerSession, gen}
  -> stream of {sessionId, matches: MatchSummary[], total, incomplete}
searchContext {sessionId, absRow, before, after} -> {lines: string[]}
```

- *Warm session*: search the in-memory emulator via E-5 — data is already text, no replay.
- *Cold/persisted-only*: replay checkpoint+log through a transient `HeadlessTerminal` (bounded
  by the 5MB cap) and scan; cache derived text keyed `(sessionId, generation)` so repeat
  queries don't re-replay — `history-manager.ts:205`'s generation is exactly the invalidation
  key (bumped on every checkpoint, which resets the log).

Only match summaries cross the socket. The audit's P4/P5 caps (5k-row restore, 512KB replay)
stop mattering for search: search reads the store directly instead of what restore replays.

**Session dedup and depth-extension contract** *(rev: new — the exclusion rule was
unstated)*: the federation controller resolves the live↔daemon overlap BEFORE fan-out, using
the daemon sessionId each daemon-backed pane already carries:

- Sessions currently attached to a live/hidden/parked pane are **excluded** from standalone
  daemon-history results (`searchSessions`' `sessionIds?` is the allowlist: controller passes
  only unattached sessions... plus attached ones in extension mode, below). Without this rule
  every daemon-backed live pane double-reports.
- For an ATTACHED session, the daemon adapter still searches it — as a **depth extension**:
  the daemon's 5MB log exceeds the pane's replayed/retained renderer window, so rows older
  than the live engine's retention are otherwise searched by NO adapter while the pane is
  live, yet would be searched the moment it parks. The daemon returns only matches at rows
  older than the live window's oldest row (controller sends that cutoff per session);
  results carry the same `sessionId`, so they merge into the live pane's group, badged as
  history depth and navigated via inline context expansion (not an in-pane jump — those rows
  aren't in the engine).
- Dead sessions surface as daemon-history groups with `paneRef` absent, identity =
  `sessionId` (§1 result model).

### 2.4 Remote/SSH panes — host-side search, wire protocol addition

*(rev: hostRowAnchor added to the wire; snapshot-budget citation corrected)*

Remote panes attach via the runtime RPC; local engines hold only the bounded combined wire
snapshot (`src/main/runtime/rpc/methods/terminal.ts:682`, budgeted by
`REQUESTED_SNAPSHOT_BYTE_BUDGET` — 2MB, `terminal.ts:42` — with client-requested rows; the
MOBILE_* constants in `src/main/runtime/scrollback-limits.ts:7-8` are a different, subscribe
path), never full remote history. Additions to `src/main/runtime/rpc/methods/terminal.ts`:

```
terminal.search  {terminalId, query, opts, maxMatches, gen}
  -> {matches, total, incomplete, hostRowAnchor, anchorGen}
     // hostRowAnchor = host absolute row of the first row serialized into the combined
     // wire snapshot this client last received; anchorGen ties it to that snapshot so a
     // client never remaps against a snapshot it didn't replay. Same anchor is added to
     // the snapshot reply itself. Match rows are host-absolute; §1 Navigation remaps.
terminal.searchContext {terminalId, absRow, before, after}  -> {lines}   // absRow host-absolute
```

Executed on the host against the same authority that answers model queries today
(`src/main/runtime/terminal-model-query-authority.ts`), backed by E-5 — and by the host's own
daemon search (§2.3) for persisted history. The relay transport (`src/relay/pty-handler.ts`,
dispatcher `src/relay/dispatcher.ts`) carries it like any namespaced request; schema-versioned
so an old host degrades to "source unavailable" for that pane rather than failing the federated
query. SSH-provider panes route the same method over the channel multiplexer
(`src/main/ssh/ssh-channel-multiplexer.ts`). Provider-generic naming per AGENTS.md — nothing
GitHub/GitLab-specific touches this surface.

## 3. Engine Work Items

| # | Item | Crate(s) | Detail |
|---|------|----------|--------|
| E-1 | **Federated summary wasm API** | `aterm-wasm` | `search_summary(query, case_sensitive, is_regex, max_matches)` returning per-match `(abs_row, start_col, len)` + line-text snippet + `{total, incomplete}` in one call. Today's `search` returns bare triplets and drops `incomplete` (`aterm-wasm/src/lib.rs:1539-1561`); snippets would otherwise cost a `row_text` round-trip per match. Backed by `indexed_search()` / `search_results_opts` (`aterm-search/src/index.rs:940`). Also closes the pane find bar's honesty gap (audit E9). |
| E-2 | **StreamingSearch becomes the live backend** *(rev: anchors refreshed; migration status updated; E-1 contract-parity obligation added)* | `aterm-core`, `aterm-search` | Replace the all-or-nothing `(alt_screen, content_gen)` rebuild (`search_index.rs:14-58`) with incremental maintenance: scrolled-off lines via `index_line` keyed by absolute row (`index.rs:271`), live deltas via `StreamingSearch::content_added / content_modified / content_reflowed` (`streaming/engine/operations.rs:598, :661, :765`), time-sliced scans via `scan_row(…, max_rows)` (:177), `cancel()` (:395). Audit E2. Migration status: the ty_model! Trust migration of `streaming/` **appears landed on main HEAD** (`streaming_search_model` in `aterm-spec/src/derive.rs`; `aterm-search/tests/conformance_streaming.rs`; `streaming/spec_proof_anchors.rs`; `streaming/mod.rs` documents the derived model) — confirm with the migration owners, then E-2 is unblocked. **Contract parity**: `StreamingMatch` (`streaming/types.rs:50-59`) carries no snippet/total/incomplete, so E-2 MUST re-implement E-1's `search_summary` contract behind the SAME wasm API, gated by a differential equivalence oracle (legacy-index vs streaming summaries byte-identical on the same buffer) — otherwise v1 ships two divergent search surfaces. |
| E-3 | **Index memory fix — conditional v1 gate** *(rev: no longer "parallel hygiene")* | `aterm-search` | Federation multiplies the 1283 B/line standing cost (audit §2.2), and the String cache is a FULL text duplicate up to `DEFAULT_MAX_CACHED_LINES` = 100_000 (`index.rs:26`): 20×50k ≈ 1.3 GB, 50×100k ≈ 6.4 GB — past wasm32's 4 GB address space, inside the one shared render worker whose OOM retires every pane. Replace `SparseBitmap = BTreeSet<u32>` postings (`bitmap.rs:12-21`) with run-length/roaring containers; drop the full String duplicate (`index.rs:104-107`) by verifying through `SearchContent`. Target ≤250 B/line. v1 ships without full E-3 ONLY under the §4 admission control (serial scan, ≤K resident indexes, immediate eviction, hard byte budget); if that admission control cannot meet §4 latency, the String-duplicate drop alone is promoted to a v1 gate. Always-warm indexing of hidden panes stays gated on full E-3. |
| E-4 | **`SearchContent` over the retained buffer** | `aterm-grid`, `aterm-scrollback`, `aterm-search` | Implement `row_count`/`get_row_text`/`is_row_wrapped` (`streaming/content.rs`) directly over the ring — and the tiered store once audit E1 attaches it — so StreamingSearch scans without materializing every line as String. Wrapped-row remap (#7572) is already implemented and exercised by the `WrappedTestContent` test scaffolding in `streaming/mod.rs` (that block is test fixtures, not the spec — the behavior itself lives in the engine + its derived model). |
| E-5 | **Headless/daemon search entry** | `rust/crates/orca-terminal`, `orca-ffi`, `orca-daemon` | `HeadlessTerminal::search_scrollback(query, opts, max) -> Vec<MatchSummary>` using `aterm-search` (same kernel as wasm) over text-only scrollback (`headless.rs:121-126`); FFI-exposed for §2.3 and §2.4; includes the transient-replay path for cold sessions. |
| E-6 | **Budgeted, resumable wasm search** *(rev: budget explicitly covers index BUILD, not just enumeration)* | `aterm-wasm`, `aterm-core` | `search_summary` accepts a row budget and returns a resumable cursor. Critically, the dominant cold-query cost is the index **build**, not the match scan: `Terminal::indexed_search` rebuilds monolithically (`aterm-core/src/terminal/search_index.rs`) — the audit's ~982ms @ 100k lines is that rebuild. So the cursor MUST drive incremental index construction: each slice feeds ≤budget rows through `SearchIndex::index_line`/`next_line` (which already support append-order build), scans what was just indexed, and returns the cursor; a budget that only bounds enumeration leaves the ~1s monolithic build in front of the first slice and stalls every pane's rendering (`aterm-shared-render-worker.ts:1-9`). Mirrors `scan_row`'s bounded contract. Same budget applies on the main-thread in-process fallback (§2.1), which today would run with no budget at all. |

Non-items (already in the engine): regex with ReDoS bounds, dual-case trigram acceleration,
match caps (audit §2.2); jump math (`scroll_search_line_into_view`, `search_display_origin`).

## 4. Performance Budget

- **Local fan-out** *(rev: slice budget explicitly covers the build phase)* (explicit invoke,
  20 panes × 50k lines, warm indexes): first per-pane batch ≤ 50ms; full local fan-out
  ≤ 150ms. Cold-index worst case today ≈ 1s per 100k-line pane (audit: 982ms measured) — and
  that cost is the index BUILD, so the ≤8ms/slice guarantee holds only because E-6 slices
  construction itself (incremental `index_line` build per slice, not enumeration-only
  budgeting); visible panes searched first. E-2 removes the rebuild class.
- **Daemon/parked**: ≤ 100ms warm (in-memory emulator); ≤ 500ms cold (5MB replay, then cached
  by checkpoint generation). Runs in the daemon process — zero renderer/worker cost.
- **Remote**: network-bound; treated as streaming-in, never blocking local results; response
  capped at 64KB of summaries per host.
- **Memory ceilings** *(rev: admission control added — federation defeats on-demand+TTL
  alone)*: federation layer holds ≤ K×N summaries (50 × panes, ~100 B each — trivial).
  Engine-side: no always-warm indexes until E-3. "On-demand + 60s TTL" is NOT sufficient
  under federation — one query makes every pane actively-searched at once, and at 1283 B/line
  with the full String cache (`DEFAULT_MAX_CACHED_LINES` = 100k, `index.rs:26`) 20×50k ≈
  1.3 GB and 50×100k ≈ 6.4 GB, past wasm32's 4 GB space in the ONE shared worker (fonts +
  every engine; a worker OOM retires rendering for every pane). v1 admission rule: panes are
  searched **serially** (§2.1 priority order); at most K=2 on-demand indexes resident (current
  + next prefetch); non-visible panes' indexes evicted immediately after their scan (visible
  panes keep the 60s TTL); hard budget — if estimated index bytes (lines × 1283 B) would push
  worker-resident index memory past 256 MB, that pane skips indexing and degrades to an
  unindexed budgeted linear scan through the same E-6 cursor. Post-E-3 (≤250 B/line,
  no String duplicate) always-warm becomes viable for hidden panes.
- **Incremental updates while output streams** *(rev: cost-gated stale-skip rule added)*:
  palette open + streaming pane re-queries that pane on its existing dirty signal
  (`aterm-worker-terminal.ts:164` `search.markDirty()`) throttled to 4Hz (audit P6 interim) —
  but 4Hz alone breaks at scale: any cell write invalidates the whole per-pane index
  (`search_index.rs`), so a streaming 100k-line pane would pay a ~1s rebuild per 250ms tick —
  permanent worker saturation in exactly the cat-flood scenario this repo benchmarks against.
  Cost gate: skip the re-query for any pane whose last rebuild+scan exceeded the tick period;
  mark that pane's group "results stale — output streaming" in the palette and refresh it on
  the next idle window or explicit re-invoke. True deltas after E-2 remove the gate.
- **Cancellation**: every keystroke bumps `gen`; adapters check `gen` before replying; engines
  honor `cancel()` so an abandoned regex over 1M daemon-side lines stops mid-scan.

## 5. Sequencing

*(rev: migration status re-verified against main; E-3 resequenced as conditional v1 gate;
E-1↔E-2 parity obligation carried into step 3)*

1. **Now**: E-1 + E-6 on the existing index path (E-6 with build-phase slicing, §3); worker
   `federatedFind` serial fan-out + §4 admission control; federation controller + palette
   (incl. sessionId dedup, stale-paneRef degradation); pane find-bar debounce (audit P1).
   Ships v1: federated search over live/hidden local panes. Note: the StreamingSearch
   ty_model! migration **appears already landed on main HEAD** (`streaming_search_model` in
   `aterm-spec/src/derive.rs`, `conformance_streaming.rs`, `spec_proof_anchors.rs`;
   `streaming/mod.rs` documents the derived model superseding the never-committed hand TLA+) —
   the old "hands off `streaming/` until it lands" restriction is likely already satisfiable;
   re-verify with the migration workflow before step 3, and still avoid touching `streaming/`
   from this effort until that confirmation.
2. **Parallel, no aterm dependency**: E-5 + daemon RPC (§2.3, incl. the depth-extension
   cutoff) + parked adapter (§2.2) — these live in orc's rust crates. Then the remote wire
   (§2.4, incl. `hostRowAnchor`), gated only on E-5.
3. **After migration confirmation**: E-2 + E-4 — converts federated search from
   rebuild-per-query to incremental, enabling streaming-time result updates and retiring the
   §4 stale-skip gate. E-2 re-implements E-1's summary contract behind the same wasm API with
   the equivalence oracle (§3 E-2) so the two backends never diverge user-visibly.
4. **Conditional v1 gate, not hygiene**: E-3 — v1 may ship on §4 admission control alone, but
   if that control cannot hold the §4 latency targets, the String-duplicate drop
   (`index.rs:104-107`) becomes a v1 blocker; full E-3 gates always-warm indexing of hidden
   panes.
5. **Later**: fuzzy toggle; audit E1 (tiered store attach) deepens searchable history but
   changes no interface here — E-4 abstracts storage behind `SearchContent`.

## 6. Testing Strategy

**Trust-framework obligations (engine).** New surface follows the standard already visible in
`aterm-search`: TLA+ spec + six named invariants + Kani proofs + a proofs-gap ledger
(`streaming/mod.rs:5-46`, `streaming/proofs.rs`, `streaming/proofs_gaps.rs`); post-migration
these are ty_model!-derived (`rust/aterm/crates/aterm-spec/src/lib.rs:18-41`).

- **E-1/E-6** *(rev: build-phase slicing invariant added)*: wasm in-tree tests in the style of
  the existing shrink/resize search invariants (`aterm-wasm/src/lib.rs:2152-2262`): summaries
  never reference evicted absolute rows; `incomplete` is true whenever the index flag or
  `max_matches` truncated; cursor-resume is equivalent to one unbounded call (equivalence
  oracle); **no single budgeted call performs unbounded index construction** — cold-pane
  per-slice work is proportional to the row budget (perf-gated), so a 100k-line cold pane
  never produces a monolithic-rebuild slice.
- **E-2**: extend the streaming state machine with generation/cancel interleavings → new
  invariant "no result from generation g surfaces after cancel(g)", modeled in the ty_model!
  spec and Kani-proved on the bounded model; differential conformance: incremental maintenance
  must produce byte-identical match sets to a from-scratch index.
- **E-3**: Kani proofs for the new posting container (pattern: `bloom_kani_proofs.rs`), plus
  **committed search benchmarks** — search currently has zero (audit §5.2) — with perf-gate
  floors for index build, per-line incremental cost, and measured B/line.
- **E-5**: differential parity — daemon-side search over a replayed session equals wasm-side
  search over the same byte stream (same kernel, provable).

**Product-side.**

- Adapter unit tests with fake sources (worker fake via the DI seam,
  `aterm-shared-render-worker.ts:107-109`).
- Worker fan-out test proving `federatedFind` never perturbs any pane's active find state
  (count/activeIndex/rects unchanged).
- Parked-jump e2e: park → search → activate → nearest-match anchor → missing-match toast.
- *(rev)* Admission-control tests: N synthetic cold panes → never more than K resident
  indexes (worker memory instrumentation); over-budget pane takes the unindexed linear-scan
  path and still returns matches; 4Hz stale-skip fires when a pane's rebuild exceeds the tick
  and the group is marked stale.
- *(rev)* Dedup tests: daemon-backed live pane yields ONE group (no double results); daemon
  depth-extension matches merge into the live group under the same sessionId and respect the
  cutoff row; dead-session results carry no paneRef and expand inline.
- *(rev)* Stale-paneRef test: close the tab between result render and click → degrades to
  daemon inline expansion when sessionId persists, toast otherwise; no throw.
- Daemon RPC contract tests incl. old-daemon version negotiation
  (`daemon-protocol-versions.ts`) and generation-cache invalidation across a checkpoint.
- Remote wire tests both directions, old-host graceful degradation, SSH mux routing; relay
  request abort path (`src/relay/client-request-aborts.ts` pattern) for cancellation;
  *(rev)* `hostRowAnchor` remap: in-window match jumps to the correct client row across
  differing wrap widths (nearest-row flagged approximate), and an anchorGen mismatch falls
  back to inline context expansion instead of a wrong-row jump.
- Cancellation test: no stale-generation batch ever renders.
- Cross-platform per AGENTS.md: shortcut via platform check; daemon tests green on the Windows
  conin/conpty paths (`src/main/daemon/conin-atomic-sequence-writer.ts` neighborhood).

**Perf verification.** Add a federated-search scenario (N synthetic panes × M lines, cold and
warm) to the committed perf-gate set so §4 is a gate, not a hope — and close the audit's
"no wasm benchmarks at all" gap for at least this surface.
