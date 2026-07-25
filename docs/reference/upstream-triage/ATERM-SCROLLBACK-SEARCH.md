# aterm Scrollback + Search: Engineering Report

Synthesis of 5 specialist audits (storage, render/scroll, bench/measurement, search engine, product wiring), 2026-07-20/21. All paths relative to `/Users/ayates/orc` unless prefixed `rust/aterm/`.

## 1. Executive Answer

**The engine is architecturally best-in-class; the shipped configuration and the product wiring throw most of it away.**

Hard numbers (native, Apple M5 Max, v0.56 unless noted):

- **Ingest**: 499 MB/s (perf_harness median, n=7; committed baseline 337). On-glass cat-flood 272 MB/s vs ghostty stable 116 — but ghostty **tip** measured 295–305 on the same rig (aterm = 89% of tip), and same-build absolutes drift ~20% day-to-day, so cross-day headline ratios are soft. Engine loop is 1.5–3.9x alacritty_terminal (rust/aterm/docs/measured/engine-throughput-vs-alacritty.md:20-29).
- **Scrollback scrub**: 1.56M rows/s materialized through a 110k-line hot/LZ4/zstd tiered fill; cold-page jumps 46.6k/s (~15–21 µs per 24-row cold viewport). Gate-protected floors committed (tools/golden/perf-baseline-scroll.json).
- **Memory**: tiered store measured ~211 B/line mixed content (crate's own docs claim 20 B/line targets — the 10x gap between target and measurement is unreconciled). Ring-only (what actually ships): 640 B/line at 80 cols, 1.6 KB at 200, content-independent.
- **The gap**: both product paths — renderer wasm (`Terminal::new`, rust/aterm/crates/aterm-wasm/src/lib.rs:291) and daemon headless (rust/crates/orca-terminal/src/headless.rs:121-135) — attach **no tiered store**. The LZ4/zstd tiers, DeferredLine lazy promotion, and off-thread history reflow are all dormant in production. Real deep-scrollback memory is raw uncompressed cells, ~670 MB/1M lines at 80 cols.
- **Search**: trigram-indexed (unique among terminals) but measured at **1283 B/line retained — 15.7x the text it indexes, ~6x the scrollback store itself** (128.3 MB per 100k lines, external harness; prior specialist estimated 60–100 MB — same order, both damning). The product path rebuilds the entire index on **any** content change (~459 ms @ 50k lines per the module's own docs; 982 ms @ 100k measured), then re-runs it per keystroke (no debounce) and per frame during streaming output. Search has **zero** in-tree benchmarks.
- **User-visible ceilings are policy, not engine**: 50k-row settings cap, daemon restore hard-capped at 5k rows (setting never forwarded, src/main/daemon/terminal-host.ts:107-123), snapshot restore replays only 512KB of the 5MB stored.

## 2. Architecture As-Built

### 2.1 Storage: two layers, one dormant

**Layer 1 (always on)** — ring buffer of page-backed rows: `GridStorage.rows: Vec<Row>` with `ring_head`/`display_offset` (rust/aterm/crates/aterm-grid/src/grid/state/storage.rs:31-48); O(1) scroll and modulo lookup with a proof-carrying unchecked fast path (storage.rs:242-262, 435-499). Cells live in a 64KB offset-based page arena with free-list pooling (rust/aterm/crates/aterm-grid/src/page.rs:40-64) — ghostty's serialization-friendly design. `Cell` is exactly 8 bytes, compile-time asserted (rust/aterm/crates/aterm-grid/src/cell.rs:57-72); emoji/RGB/hyperlinks overflow to a flag-gated side table (cell.rs:34-42, 440-449). Densest visible cell of any surveyed terminal (alacritty ~24 B, ghostty ~12 B, kitty ~12-16 B).

**Layer 2 (optional, unattached in production)** — `aterm_scrollback::Scrollback`: hot VecDeque of 1000 uncompressed Lines, warm LZ4 blocks of 100 lines, cold zstd pages with optional mmap disk spill (rust/aterm/crates/aterm-scrollback/src/lib.rs:24-75). Line form: 10-byte RLE attr runs, span-based Arc'd hyperlinks, 32-byte inline text (line.rs:32, 59-83, 203-215). Between layers sits `LazyBuffer`/`DeferredLine` — O(cells) snapshot at scroll-off, materialized lazily in 1000-line batches (rust/aterm/crates/aterm-grid/src/grid/scroll_convert.rs:80-136). Off-thread compression drops oldest staged lines past a 20k backlog rather than compress inline (scroll.rs:355-370, const :593) — deliberate throughput-over-depth trade (SCROLL-1 regression: 193→59 MB/s), currently silent to the user.

**Both shipping paths are ring-only.** The wasm ctor's own docs say so (rust/aterm/crates/aterm-wasm/src/lib.rs:688-693: "ring-only (no tiered store)"; test comment :3228-3231: "the deferred path is dormant there"). Daemon: `TerminalBuilder::new().ring_buffer_size(...)` with no `.scrollback(...)` (headless.rs:121-135), default 5000 lines, `set_scrollback_text_only(true)` (drops styling, keeps hyperlinks). `set_scrollback_limit(0)` in ring-only mode means **unbounded** uncompressed growth — no byte budget, no watermark (rust/aterm/crates/aterm-grid/src/grid/accessors.rs:544-576); the only defense is host OOM.

**Reflow**: visible-grid rewrap is O(rows×cols) synchronous; history rewrap is fully off-critical-path via detach/pump (`resize_offloading_scrollback`, rust/aterm/crates/aterm-grid/src/grid/scrollback_offload.rs:5-44) — built to kill a documented 42-second freeze — **but only for tiered grids**. Ring-only wasm rewraps the entire ring synchronously on every width change (aterm-wasm/src/lib.rs:3251-3256).

### 2.2 Search: sophisticated index, batch-oracle wiring

Engine (rust/aterm/crates/aterm-search): Bloom-filtered trigram index, `FxHashMap<[u8;3], SparseBitmap>` posting lists intersected smallest-first, full line-text cache for verification via `str::find`, per-line ColumnMaps, dual original+Unicode-lowercased trigrams so case-insensitive stays accelerated, final-sigma folding, regex with ReDoS-bounded limits (index.rs:299-307, 533-555, 598-647, 867-882). 100k-line cache cap and 100k match cap with honest `incomplete` flags. No other mainstream terminal has any of this.

Three structural problems:

1. **All-or-nothing invalidation**: `Terminal::indexed_search` keys the cache on `(alt_screen, content_gen)` and any single cell write triggers a full rebuild materializing every retained line as a String (rust/aterm/crates/aterm-core/src/terminal/search_index.rs:44-100, 119-156). The incremental API (`index_line`, eviction watermarks, per-line absolute-row identity — index.rs:272-281, storage.rs:96-111) exists and is unused. A complete TLA+-specified, Kani-proved `StreamingSearch` module has **zero consumers** (aterm-search/src/streaming/).
2. **Memory**: `SparseBitmap` = `BTreeSet<u32>` — a deliberate roaring-removal (#7698, bitmap.rs:5-11) that costs ~10-16 B per posting where dense runs would be ~2 B; ~76 postings per 80-char line ⇒ ~900-1100 B/line in postings alone, plus a full String duplicate of every line (index.rs:104-107). Measured total: 1283 B/line.
3. **Product wiring treats it as a batch oracle**: per-keystroke full search with no debounce (src/renderer/src/components/TerminalSearch.tsx:108-126); during streaming with the find bar open, every frame pays a full O(scrollback) rebuild + re-query (aterm-worker-search.ts:51-68, aterm-worker-terminal.ts:232-235) — seconds-long worker stalls at 50k rows; `visibleRects` and overlay paint iterate ALL matches per frame despite sorted order; the wasm export silently drops the `incomplete` flag (aterm-wasm/src/lib.rs:1539-1561); verification is scalar `str::find`, no memmem/SIMD.

### 2.3 Render/scroll: excellent steady-state, unassembled scroll fast path

Steady-state damage is single-sourced and byte-exact (`compute_dirty_rows`, rust/aterm/crates/aterm-render/src/lib.rs:11650), one-pass snapshot with scratch reuse (render_cells.rs:708-788), metadata excluded from cache-defeating comparisons (render.rs:566-576) — above alacritty's bar. But:

- **Every scroll step is FullRepaint** — the reuse precheck requires equal `display_offset` (lib.rs:11677-11685); no row reuse or blit despite a proven translate primitive (scroll_translate.rs:147) and `base_y` already in the snapshot.
- **Reading history while output streams** re-pins `display_offset` per batch, forcing FullRepaint of pixel-identical frames (scroll.rs:102-115).
- **Scrolled frames re-materialize every visible history row per frame** — fresh allocations, owned clones from warm/cold even on cache hit, single-entry block caches thrashed at 100-line block boundaries (visible_row_view.rs:287, tier.rs:165/370, cold_tier.rs:200); `get_attr` rescans RLE runs per grapheme, accidentally O(cols×runs) (scroll_materialize.rs:153).
- **wasm boundary presents the full framebuffer every frame** — O(W×H) u32→RGBA expansion + whole-canvas putImageData (~32 MB/frame at 1280×800@2x) regardless of a one-row dirty set (aterm-wasm/src/lib.rs:961-969; aterm-frame-painter.ts:105-106). Biggest structural gap vs native swap-chain presentation.
- CPU wasm `render()` uses the allocating `cell_frame` instead of the scratch-reusing `cell_frame_into` its two sibling frontends already use (lib.rs:942 vs aterm-gpu-web/src/lib.rs:2090).
- Pixel-true sub-row scrolling (`scroll_px`) is fully built and unit-proven but orc's wheel handler converts to whole lines in JS (aterm-scroll-input.ts:114) — trackpad feel below kitty/ghostty.
- Worker STATE mirror calls `row_text(y)` per visible row per frame, re-materializing scrolled rows a second time (aterm-worker-dirty-rows.ts:34-71).
- Bridge cadence/QoS (rAF coalescing, eager echo, flood time-slicing) is well-designed and **not** a bottleneck.

## 3. Honest Comparison

| Axis | aterm (engine capability) | aterm (as shipped in orc) | ghostty | kitty | alacritty | wezterm |
|---|---|---|---|---|---|---|
| Visible cell size | **8 B** | 8 B | ~12 B | ~12-16 B | ~24 B | ~20 B+ |
| Scrollback storage | LZ4+zstd tiers, attrs preserved, ~211 B/line, disk spill | **raw ring, 640 B/line @80col, no byte budget** | uncompressed pages, byte-capped | text-only compressed pager history | uncompressed ring, 100k cap | logical lines, uncompressed |
| History rewrap on resize | off-thread/pumped (tiered only) | **synchronous O(ring)** | synchronous | synchronous | synchronous | mitigated by logical lines |
| Scrollback search | trigram index + bloom + regex | same engine, rebuilt per change/keystroke/frame | none (historically) | pager delegation | on-demand regex scan | on-demand copy-mode scan |
| Search standing cost | 1283 B/line index | same | 0 | 0 | 0 | 0 |
| Scroll frame cost | pieces exist for blit/reuse | FullRepaint + re-materialize + O(W×H) present | rotate refs, GPU swap | rotate refs, GPU swap | full-grid redraw | damage-tracked |
| Flood throughput (on-glass, same rig) | 272 MB/s | (native GUI number; wasm **unmeasured**) | 116 stable / **295-305 tip** | not measured here | not measured here | not measured here |
| Verification rigor | Kani/TLA+/gates, committed perf floors | 0.45 pass-ratio = catastrophic-only | good | good | good | good |

**Bottom line**: with tiers attached and incremental search, aterm would lead this field decisively. As shipped it is "alacritty with 3x denser cells and a very expensive search index," ahead on ingest, behind natives on work-per-scroll-frame, and ahead of ghostty stable but behind ghostty tip on flood.

## 4. Improvement Roadmap (impact/effort ordered)

### Engine-side

| # | Work item | Expected effect | Effort |
|---|---|---|---|
| E1 | Attach hot+warm(LZ4) `Scrollback` in the wasm ctor and daemon builder | 10–50x deep-scrollback memory; activates dormant off-thread reflow; unlocks cheap 100k+ retention | M — machinery exists, needs config + wasm-compat validation |
| E2 | Incremental search index: feed scrolled-off lines (already text-converted as DeferredLine) via `index_line` keyed by absolute row; re-index only visible rows per content_gen bump | ~1000x live-search maintenance (O(visible+delta) vs O(retained)); kills streaming-search stalls and first-Cmd+F latency | M — hooks (content_gen, absolute rows, eviction watermarks) all exist |
| E3 | Dirty-band present export for wasm CPU path: expand+putImageData only dirty row bands (mirror existing `spill_rects_ptr` pattern, aterm-wasm/src/lib.rs:1039-1045) | 10–40x per-frame present cost for typing/streaming — single most impactful render change | M |
| E4 | Replace BTreeSet postings with run-length/roaring container; drop the index's String duplicate by verifying via the existing `SearchContent` trait | ~5–10x posting memory + ~200 B/line; 1283 → plausibly ~150-250 B/line | M |
| E5 | Absolute-anchor (base_y − display_offset) reusable precheck | reading-history-while-streaming frames become zero-work gate hits | S |
| E6 | MaterializedRow LRU (~2x viewport, keyed absolute row) + 2-4-entry warm/cold block caches + Cow returns + run-cursor in `materialize_from_line` | scrolled-frame cost ≈ live-frame cost; kills block-boundary decode thrash and O(cols×runs) attr term | S-M |
| E7 | Scroll-blit fast path (reuse `translate_grid_band_in_place`, raster only |d| exposed rows) | 10–40x raster reduction per wheel step | M |
| E8 | `cell_frame_into` scratch in wasm CPU render (copy gpu-web pattern) | removes largest recurring wasm heap churn; mechanical | XS |
| E9 | memmem::Finder per query (+wasm simd128); batch row-range export for the worker mirror; search_meta export carrying `incomplete` | 2–5x verify phase; halves worker scroll cost; honest truncated counts | S each |
| E10 | Byte watermark for ring-only "unlimited" mode; flood-truncation sentinel line; wire or delete dead `StreamingSearch`; fix/flatten push_line depth term (13.2→5.6 Melem/s @500→50k, contradicts its own O(1) bench claim — not user-visible today) | hygiene/safety tier | S each |

### Product-side (orc wiring — no engine work)

| # | Work item | Expected effect | Effort |
|---|---|---|---|
| P1 | Debounce find-as-you-type ~50-100ms (TerminalSearch.tsx:108-126) | N full scans → 1 while typing; removes typing stutter | XS |
| P2 | Build the review-approved writer-side 32KiB frame coalescing (connection.rs::spawn_stream_drain; docs/rust-migration/daemon-pty-drain-investigation.md:157-167) | **measured +58%** (156→248 MB/s) on every embedded-terminal flood — largest known unshipped throughput win | S |
| P3 | Route DOM_DELTA_PIXEL wheel to `term.scroll_px`; delete the JS remainder accumulator | pixel-true trackpad scrolling, zero engine work | S |
| P4 | Forward `terminalScrollbackRows` into daemon Session options (terminal-host.ts:107-123) | restores honor the user's 50k setting instead of silent 5k cap | S |
| P5 | Raise 512KB replay limit toward the 5MB store (or hydrate incrementally); bench exists | restores recover ~10x more history, unchanged disk footprint | S |
| P6 | Binary-search sorted match list in visibleRects/overlay paint; throttle ensureFresh to 4-10Hz during streaming (interim until E2) | O(log n) per frame vs O(all matches); bounds streaming-search cost today | S |
| P7 | Rate-limit STATE grid-mirror posts during flings (post on settle) | halves worker-side scroll frame cost for history content | S |
| P8 | Scrollbar match markers; pending-state match label; raise 50k policy cap once E1 lands | UX polish; the cap itself is a one-constant change | XS-S |

## 5. Measurement Gaps

1. **No wasm benchmarks at all** — every throughput number is native; the renderer ships the wasm build, where 1.5–3x penalties are typical. All "aterm is fast" claims are about a binary orc users never run.
2. **Search had zero benches** — the 1283 B/line and 982 ms/100k-build numbers come from an external audit harness (scratchpad/searchbench), not committed baselines. Caveat: the rotating-alphabet corpus is trigram-diverse; repetitive logs would shrink the trigram map (but not the dominant per-line postings).
3. **No resize/rewrap fence** despite the 42-second-freeze regression class having already happened once (gate.rs:23-25 recalls it).
4. **ARENA-SCROLL head-to-head never ran** — scroll.sh is "ready" but docs/measured/arena/ contains only cat-flood ledgers; on-glass scroll vs ghostty/kitty is the one axis where decode-per-scrub could plausibly lose to ghostty's all-RAM pages.
5. **Headline hygiene**: "272 vs 116" mixes sessions (~20% day-to-day drift) and omits ghostty tip (295-305); July runs used M5 Max against a rule declaring M4 Max the publishable class; June's "193 vs 90" was formally declared non-comparable.
6. **Gates are catastrophic-only** (0.45 pass ratio, xtask/src/perf.rs:41-51) — a genuine 2x regression ships silently; a same-box trend ledger would close this.
7. **Unreconciled numbers**: tiered-store docs target ~20 B/line (lib.rs:66-69) vs 211 B/line measured; prior search-memory estimate 60-100 MB/100k vs 128 MB measured (order-of-magnitude agreement, both from different corpora). The `~459 ms @ 50k` index-build figure is a doc claim consistent with, but not identical to, the measured 982 ms @ 100k.
