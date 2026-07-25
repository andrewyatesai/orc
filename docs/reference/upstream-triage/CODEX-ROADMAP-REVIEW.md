    33	// scrollback to 50k rows can retain more history than the flat 2 MB floor —
    34	// dropping at the floor would discard lines their scrollback would have kept.
    35	// 120 chars/row ≈ 80-col text plus escape-sequence overhead; the cap is a

codex
The report identifies real bottlenecks, but several compound claims overstate what the repository proves. The roadmap is directionally sound; its ordering, effort estimates, and some proposed mechanisms are not safe to execute as written.

## 1. Both Orca shipping paths are ring-only

**CONFIRMED — scoped to Orca’s renderer and daemon paths.**

- The CPU WASM constructor calls `Terminal::new` at [aterm-wasm/lib.rs:291](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:291). That reaches `Grid::new` and `Grid::with_scrollback` at [constructors.rs:27](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/constructors.rs:27) and [grid/construct.rs:27](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/construct.rs:27), whose storage has `scrollback: None` at [grid/construct.rs:75](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/construct.rs:75).
- The WASM binding itself explicitly describes the engine as ring-only at [aterm-wasm/lib.rs:686](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:686).
- Tiering requires the separate `Grid::with_tiered_scrollback` constructor, which assigns `scrollback: Some(...)` at [grid/construct.rs:133](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/construct.rs:133).
- The daemon headless path sets only `.ring_buffer_size(...)` at [headless.rs:121](/Users/ayates/orc/rust/crates/orca-terminal/src/headless.rs:121). `TerminalBuilder` defaults `scrollback` to `None`, and the `(Some(ring), None)` build arm is ring-only at [builder.rs:58](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/builder.rs:58) and [builder.rs:139](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/builder.rs:139).
- Production Rust RPC constructs that headless terminal with the fixed 5,000-line default at [rpc.rs:405](/Users/ayates/orc/rust/crates/orca-daemon/src/rpc.rs:405) and [headless.rs:45](/Users/ayates/orc/rust/crates/orca-terminal/src/headless.rs:45).

Qualification: this is not true of the entire aterm workspace; standalone `aterm-gui` attaches `Scrollback::with_defaults()`. Also, WASM intentionally excludes zstd/disk and can only use RAM/LZ4 tiers ([aterm-wasm/Cargo.toml:12](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/Cargo.toml:12)). The native daemon compiles disk/zstd support but never attaches it.

## 2. Search cost, rebuilds, and repeated searches

**PARTIALLY CONFIRMED.**

Confirmed mechanisms:

- The cache key is `(alt_screen, content_gen)`. On any miss, `indexed_search` discards the old index and calls `build_search_index` at [search_index.rs:84](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/search_index.rs:84).
- That build materializes and indexes every retained history and visible row at [search_index.rs:119](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/search_index.rs:119).
- A single content-cell mutation increments `content_gen` at [storage.rs:196](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/state/storage.rs:196). Therefore the next search after a real cell write performs a full rebuild. It is not rebuilt immediately at write time.
- Postings really are `BTreeSet<u32>` at [bitmap.rs:5](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/bitmap.rs:5).
- The index also duplicates each line into a `String` and a `ColumnMap` at [index.rs:100](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:100) and [index.rs:309](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:309).
- The React effect runs `findMatches` directly on every query update with no debounce at [TerminalSearch.tsx:108](/Users/ayates/orc/src/renderer/src/components/TerminalSearch.tsx:108).
- In the worker, every processed output chunk calls `markDirty`, and the next STATE build calls `search.count()`, which triggers one refresh at [aterm-worker-terminal.ts:151](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-terminal.ts:151), [aterm-worker-terminal.ts:232](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-terminal.ts:232), and [aterm-worker-search.ts:61](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-search.ts:61).

What is not established:

- `~1283 B/line` is not reproducible from this checkout. The report admits it came from an external `scratchpad/searchbench`; that harness is absent. The exact number is corpus-, allocator-, query-mode-, and line-length-dependent.
- “Per-frame re-search” applies only while a nonempty search is active and output has dirtied the engine. It is coalesced to once per emitted frame, not once per PTY chunk and not on idle/no-query frames.
- Pure viewport scrolling deliberately does not invalidate the index.

So the structural diagnosis is correct; the exact memory figure and unconditional wording are not independently verified.

## 3. Scrolling causes FullRepaint and full-frame presentation

**PARTIALLY CONFIRMED.**

The narrow CPU-path claim is correct:

- `compute_dirty_rows` requires equal `display_offset`; otherwise it returns `FullRepaint` at [aterm-render/lib.rs:11677](/Users/ayates/orc/rust/aterm/crates/aterm-render/src/lib.rs:11677).
- A normal whole-line scroll changes `display_offset` at [grid/scroll.rs:75](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/scroll.rs:75), so every non-no-op shipping line scroll forces the full raster path at [aterm-render/lib.rs:8015](/Users/ayates/orc/rust/aterm/crates/aterm-render/src/lib.rs:8015).
- CPU WASM then converts every framebuffer pixel into RGBA on every render at [aterm-wasm/lib.rs:942](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:942) and [aterm-wasm/lib.rs:961](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:961).
- The canvas painter constructs a full-frame `ImageData` and calls full-canvas `putImageData` at [aterm-frame-painter.ts:100](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-frame-painter.ts:100). The CPU worker does the same at [aterm-worker-engine-build.ts:255](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-engine-build.ts:255).

But “every scroll step” is too broad:

- Fractional `scroll_px` input can change only the residual until a row boundary is crossed.
- Capable hardware defaults to the separate GPU/WebGL WASM engine, which renders directly to the swapchain and has no RGBA `putImageData` path at [aterm-worker-engine-build.ts:287](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-engine-build.ts:287) and [aterm-gpu-auto-policy.ts:76](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-gpu-auto-policy.ts:76).

There is also a roadmap hazard: JS search/link/prediction overlays are painted onto the same CPU canvas after the framebuffer at [aterm-frame-painter.ts:112](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-frame-painter.ts:112). Dirty-band presentation without separate overlay damage or a separate overlay canvas would leave stale highlights and underlines.

## 4. The +58% writer coalescing is unshipped

**PARTIALLY CONFIRMED.**

- The implementation is definitely unshipped. `spawn_stream_drain` receives a pre-encoded item and immediately calls `write_all`; there is no timeout, adjacency check, or batching at [connection.rs:229](/Users/ayates/orc/rust/crates/orca-daemon/src/connection.rs:229) and [connection.rs:260](/Users/ayates/orc/rust/crates/orca-daemon/src/connection.rs:260).
- `route_output` still encodes and clones one frame per routed read at [registry.rs:220](/Users/ayates/orc/rust/crates/orca-daemon/src/registry.rs:220).
- The documentation records 156→248 MB/s for 32 KiB coalescing at [daemon-pty-drain-investigation.md:119](/Users/ayates/orc/docs/rust-migration/daemon-pty-drain-investigation.md:119), and proposes the writer-side semantic-item design at [daemon-pty-drain-investigation.md:157](/Users/ayates/orc/docs/rust-migration/daemon-pty-drain-investigation.md:157).

The important correction is that the +58% was measured using the default-off **pump-side** `ORCA_PUMP_FRAME_KIB` instrument, visible at [rpc.rs:27](/Users/ayates/orc/rust/crates/orca-daemon/src/rpc.rs:27) and [rpc.rs:782](/Users/ayates/orc/rust/crates/orca-daemon/src/rpc.rs:782). The proposed writer-side design was reviewed but was not implemented or measured. The absent `scratchpad/daemon-flood-timed.mjs` also prevents independent reproduction here.

Therefore: “unshipped” is confirmed; “writer-side implementation delivers +58%” remains a hypothesis supported by a related pump-side experiment.

## 5. Pixel scrolling exists, but JS rounds it to lines

**CONFIRMED.**

- The wheel handler converts all delta modes through `accumulateWheelLines`, banks a JS remainder, and calls `scroll_lines` at [aterm-scroll-input.ts:94](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-scroll-input.ts:94).
- The engine exports true pixel input through `scroll_px`, including fractional residual presentation, at [scroll_input_api.rs:114](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/scroll_input_api.rs:114).

P3 is nevertheless under-scoped: the worker engine surface exposes only `scroll_lines` at [aterm-worker-engine-build.ts:40](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-engine-build.ts:40), the facade posts only `scrollLines` at [aterm-worker-term.ts:313](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-term.ts:313), and the protocol has no pixel-scroll message at [aterm-render-worker-protocol.ts:135](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-render-worker-protocol.ts:135). It is product wiring, but not a one-line handler change.

## 6. Roadmap judgment

**PARTIALLY ENDORSED.** The themes are right; “impact/effort ordered” is not defensible without the missing WASM measurements the report itself acknowledges.

| Item | Judgment | Required change |
|---|---|---|
| E1 | Modify | Attach tiering, but define one total retention limit. Today a tiered grid retains the store limit **plus** the fixed hot ring ([accessors.rs:536](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/accessors.rs:536)). Add per-pane/global WASM budgets and distinguish WASM LZ4 from native zstd/disk. |
| E2 | Redesign | Do not key a persistent index directly by ever-growing absolute row. Short queries scan `0..line_count` ([index.rs:561](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:561)), postings saturate IDs to `u32` ([index.rs:139](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:139)), and `invalidate()` does not remove stale entries ([search/lib.rs:229](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/lib.rs:229)). It needs compact document IDs plus explicit append/replace/evict/reflow/clear/alt-screen events. Effort is above M. |
| E3 | Modify | CPU-only optimization. Include RGBA conversion bands, fractional-scroll behavior, and old/new overlay damage or separate overlay canvases. Measure how often users actually take the CPU fallback. |
| E4 | Split/defer | Benchmark posting containers after E2 fixes identity/lifecycle. `SearchContent` integration is not mechanical because the current index uses stored strings for verification; `ColumnMap` duplication also remains. |
| E5 | Modify | The anchor idea is good, but it is not a one-line S change. Selection mapping currently depends on `display_offset`; compare each frame using its own absolute anchor and test selection, cursor, images, reflow, and fractional scroll. |
| E6 | Split | Materialized-row LRU, warm-block cache, `Cow`, and run-cursor are four changes with different invalidation risks. Land the run-cursor independently; benchmark before adding multiple cache layers. |
| E7 | Redesign/defer | The existing translate helper deliberately leaves the incoming strip as a placeholder and documents exact incoming-row raster as deferred cross-crate work at [scroll_translate.rs:54](/Users/ayates/orc/rust/aterm/crates/aterm-render/src/scroll_translate.rs:54). It is not yet a complete scroll-blit primitive. |
| E8 | **Endorse as specified** | The GPU bundle already uses retained `RenderInput` plus `cell_frame_into`; copying that pattern into CPU WASM is mechanical and low risk. |
| E9 | Split | Move `search_meta/incomplete` earlier as correctness work. Combine row-range export with the P7 mirror redesign. Benchmark `memmem`; it helps literal verification but not the regex/case-insensitive full scans at [index.rs:899](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:899). |
| E10 | Split | A byte watermark is safety work and should move near E1, not remain hygiene. Do not inject a fake sentinel into terminal content; expose truncation out-of-band. Delete/wire dead search separately and benchmark the claimed push-depth regression first. |
| P1 | Modify | Add debounce plus request generations/cancellation, immediate Enter handling, and a pending state. Debounce alone does not stop a long old query from blocking the render worker. |
| P2 | Modify | Implement the documented semantic writer queue, preserving adjacent same-session ordering and control-event flushes for binary and NDJSON. Re-benchmark the actual writer version on native, WSL, and SSH; do not promise +58% yet. |
| P3 | Modify | Add `scrollPx`/fractional-line commands through the worker facade and protocol. Preserve line/page delta modes, TUI wheel forwarding, sensitivity, and sign conventions. |
| P4 | Modify | This spans more than `terminal-host.ts`: renderer/provider options, `CreateOrAttachRequest`, adapter payload, Node `Session`, Rust RPC validation, and old-daemon compatibility. Node `Session` already accepts `scrollback` at [session.ts:73](/Users/ayates/orc/src/main/daemon/session.ts:73); the intermediate protocol does not. |
| P5 | Modify | The 512 KiB replay versus 5 MiB store claim is real at [terminal-scrollback-limits.ts:1](/Users/ayates/orc/src/shared/terminal-scrollback-limits.ts:1) and [terminal-scrollback-snapshots.ts:136](/Users/ayates/orc/src/main/terminal-scrollback-snapshots.ts:136). Prefer incremental/async hydration; blindly reading and replaying 5 MiB synchronously can create a restore freeze. |
| P6 | Modify | Binary-searching the sorted visible-match range is sound. Throttled freshness needs versioning, an explicit stale/pending state, and a guaranteed final refresh. |
| P7 | Reject as worded | Do not suppress authoritative STATE until “settle”; that can leave offsets, cursor, selection, and accessibility mirrors stale during a long fling. Decouple/rate-limit only the expensive grid-row mirror and batch row export. |
| P8 | Modify | Pending UI belongs with P1/P6. Raise the cap only after E1 **and** bounded incremental search are proven. Also fix the existing policy inconsistency: canonical normalization caps at 50k ([terminal-scrollback-policy.ts:1](/Users/ayates/orc/src/shared/terminal-scrollback-policy.ts:1)), while one settings field advertises 100k ([TerminalEngineBehaviorSections.tsx:59](/Users/ayates/orc/src/renderer/src/components/settings/TerminalEngineBehaviorSections.tsx:59)). |

## Verdict

**Endorse as specified**

- E8.

**Endorse the objective, but require modification**

- E1, E3–E5, E9.
- P1–P6 and P8.
- P2 specifically should implement the documented writer-side design, but must not inherit the pump-side experiment’s +58% as a guaranteed result.

**Redesign or split before scheduling**

- E2, E6, E7, E10.
- P7.

**Missing roadmap items**

- A committed E0 benchmark/gate suite for WASM CPU and GPU: search build/update/query/RSS, scroll/present cost, restore latency, and realistic corpora.
- Search request cancellation/backpressure, ideally separating expensive search work from the render-critical worker.
- Search-index lifecycle: closing search clears JS matches but retains the engine’s potentially large cached index ([aterm-search.ts:110](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-search.ts:110)). Add release-on-close, idle eviction, or memory-pressure handling.
- Explicit incremental-search correctness tests for retention eviction, reflow, resize, ED3/RIS clear, main/alternate screen switching, short queries at large absolute rows, and ID exhaustion.
- Per-pane and global scrollback/search memory budgets with WASM heap telemetry and safe “unlimited” semantics.
- CPU partial-present overlay damage and fractional-scroll interaction tests.
- Daemon protocol/version-skew tests for P2/P4 across native, WSL, SSH, binary, and NDJSON transports.

The most serious roadmap mistake is treating E2 as a contained incremental-index hook-up. It is the right high-impact destination, but the current index’s document identity, eviction, short-query scan, reflow, and lifecycle semantics must be redesigned first.
tokens used
394,924
The report identifies real bottlenecks, but several compound claims overstate what the repository proves. The roadmap is directionally sound; its ordering, effort estimates, and some proposed mechanisms are not safe to execute as written.

## 1. Both Orca shipping paths are ring-only

**CONFIRMED — scoped to Orca’s renderer and daemon paths.**

- The CPU WASM constructor calls `Terminal::new` at [aterm-wasm/lib.rs:291](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:291). That reaches `Grid::new` and `Grid::with_scrollback` at [constructors.rs:27](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/constructors.rs:27) and [grid/construct.rs:27](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/construct.rs:27), whose storage has `scrollback: None` at [grid/construct.rs:75](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/construct.rs:75).
- The WASM binding itself explicitly describes the engine as ring-only at [aterm-wasm/lib.rs:686](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:686).
- Tiering requires the separate `Grid::with_tiered_scrollback` constructor, which assigns `scrollback: Some(...)` at [grid/construct.rs:133](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/construct.rs:133).
- The daemon headless path sets only `.ring_buffer_size(...)` at [headless.rs:121](/Users/ayates/orc/rust/crates/orca-terminal/src/headless.rs:121). `TerminalBuilder` defaults `scrollback` to `None`, and the `(Some(ring), None)` build arm is ring-only at [builder.rs:58](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/builder.rs:58) and [builder.rs:139](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/builder.rs:139).
- Production Rust RPC constructs that headless terminal with the fixed 5,000-line default at [rpc.rs:405](/Users/ayates/orc/rust/crates/orca-daemon/src/rpc.rs:405) and [headless.rs:45](/Users/ayates/orc/rust/crates/orca-terminal/src/headless.rs:45).

Qualification: this is not true of the entire aterm workspace; standalone `aterm-gui` attaches `Scrollback::with_defaults()`. Also, WASM intentionally excludes zstd/disk and can only use RAM/LZ4 tiers ([aterm-wasm/Cargo.toml:12](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/Cargo.toml:12)). The native daemon compiles disk/zstd support but never attaches it.

## 2. Search cost, rebuilds, and repeated searches

**PARTIALLY CONFIRMED.**

Confirmed mechanisms:

- The cache key is `(alt_screen, content_gen)`. On any miss, `indexed_search` discards the old index and calls `build_search_index` at [search_index.rs:84](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/search_index.rs:84).
- That build materializes and indexes every retained history and visible row at [search_index.rs:119](/Users/ayates/orc/rust/aterm/crates/aterm-core/src/terminal/search_index.rs:119).
- A single content-cell mutation increments `content_gen` at [storage.rs:196](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/state/storage.rs:196). Therefore the next search after a real cell write performs a full rebuild. It is not rebuilt immediately at write time.
- Postings really are `BTreeSet<u32>` at [bitmap.rs:5](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/bitmap.rs:5).
- The index also duplicates each line into a `String` and a `ColumnMap` at [index.rs:100](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:100) and [index.rs:309](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:309).
- The React effect runs `findMatches` directly on every query update with no debounce at [TerminalSearch.tsx:108](/Users/ayates/orc/src/renderer/src/components/TerminalSearch.tsx:108).
- In the worker, every processed output chunk calls `markDirty`, and the next STATE build calls `search.count()`, which triggers one refresh at [aterm-worker-terminal.ts:151](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-terminal.ts:151), [aterm-worker-terminal.ts:232](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-terminal.ts:232), and [aterm-worker-search.ts:61](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-search.ts:61).

What is not established:

- `~1283 B/line` is not reproducible from this checkout. The report admits it came from an external `scratchpad/searchbench`; that harness is absent. The exact number is corpus-, allocator-, query-mode-, and line-length-dependent.
- “Per-frame re-search” applies only while a nonempty search is active and output has dirtied the engine. It is coalesced to once per emitted frame, not once per PTY chunk and not on idle/no-query frames.
- Pure viewport scrolling deliberately does not invalidate the index.

So the structural diagnosis is correct; the exact memory figure and unconditional wording are not independently verified.

## 3. Scrolling causes FullRepaint and full-frame presentation

**PARTIALLY CONFIRMED.**

The narrow CPU-path claim is correct:

- `compute_dirty_rows` requires equal `display_offset`; otherwise it returns `FullRepaint` at [aterm-render/lib.rs:11677](/Users/ayates/orc/rust/aterm/crates/aterm-render/src/lib.rs:11677).
- A normal whole-line scroll changes `display_offset` at [grid/scroll.rs:75](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/scroll.rs:75), so every non-no-op shipping line scroll forces the full raster path at [aterm-render/lib.rs:8015](/Users/ayates/orc/rust/aterm/crates/aterm-render/src/lib.rs:8015).
- CPU WASM then converts every framebuffer pixel into RGBA on every render at [aterm-wasm/lib.rs:942](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:942) and [aterm-wasm/lib.rs:961](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/lib.rs:961).
- The canvas painter constructs a full-frame `ImageData` and calls full-canvas `putImageData` at [aterm-frame-painter.ts:100](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-frame-painter.ts:100). The CPU worker does the same at [aterm-worker-engine-build.ts:255](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-engine-build.ts:255).

But “every scroll step” is too broad:

- Fractional `scroll_px` input can change only the residual until a row boundary is crossed.
- Capable hardware defaults to the separate GPU/WebGL WASM engine, which renders directly to the swapchain and has no RGBA `putImageData` path at [aterm-worker-engine-build.ts:287](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-engine-build.ts:287) and [aterm-gpu-auto-policy.ts:76](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-gpu-auto-policy.ts:76).

There is also a roadmap hazard: JS search/link/prediction overlays are painted onto the same CPU canvas after the framebuffer at [aterm-frame-painter.ts:112](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-frame-painter.ts:112). Dirty-band presentation without separate overlay damage or a separate overlay canvas would leave stale highlights and underlines.

## 4. The +58% writer coalescing is unshipped

**PARTIALLY CONFIRMED.**

- The implementation is definitely unshipped. `spawn_stream_drain` receives a pre-encoded item and immediately calls `write_all`; there is no timeout, adjacency check, or batching at [connection.rs:229](/Users/ayates/orc/rust/crates/orca-daemon/src/connection.rs:229) and [connection.rs:260](/Users/ayates/orc/rust/crates/orca-daemon/src/connection.rs:260).
- `route_output` still encodes and clones one frame per routed read at [registry.rs:220](/Users/ayates/orc/rust/crates/orca-daemon/src/registry.rs:220).
- The documentation records 156→248 MB/s for 32 KiB coalescing at [daemon-pty-drain-investigation.md:119](/Users/ayates/orc/docs/rust-migration/daemon-pty-drain-investigation.md:119), and proposes the writer-side semantic-item design at [daemon-pty-drain-investigation.md:157](/Users/ayates/orc/docs/rust-migration/daemon-pty-drain-investigation.md:157).

The important correction is that the +58% was measured using the default-off **pump-side** `ORCA_PUMP_FRAME_KIB` instrument, visible at [rpc.rs:27](/Users/ayates/orc/rust/crates/orca-daemon/src/rpc.rs:27) and [rpc.rs:782](/Users/ayates/orc/rust/crates/orca-daemon/src/rpc.rs:782). The proposed writer-side design was reviewed but was not implemented or measured. The absent `scratchpad/daemon-flood-timed.mjs` also prevents independent reproduction here.

Therefore: “unshipped” is confirmed; “writer-side implementation delivers +58%” remains a hypothesis supported by a related pump-side experiment.

## 5. Pixel scrolling exists, but JS rounds it to lines

**CONFIRMED.**

- The wheel handler converts all delta modes through `accumulateWheelLines`, banks a JS remainder, and calls `scroll_lines` at [aterm-scroll-input.ts:94](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-scroll-input.ts:94).
- The engine exports true pixel input through `scroll_px`, including fractional residual presentation, at [scroll_input_api.rs:114](/Users/ayates/orc/rust/aterm/crates/aterm-wasm/src/scroll_input_api.rs:114).

P3 is nevertheless under-scoped: the worker engine surface exposes only `scroll_lines` at [aterm-worker-engine-build.ts:40](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-engine-build.ts:40), the facade posts only `scrollLines` at [aterm-worker-term.ts:313](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-worker-term.ts:313), and the protocol has no pixel-scroll message at [aterm-render-worker-protocol.ts:135](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-render-worker-protocol.ts:135). It is product wiring, but not a one-line handler change.

## 6. Roadmap judgment

**PARTIALLY ENDORSED.** The themes are right; “impact/effort ordered” is not defensible without the missing WASM measurements the report itself acknowledges.

| Item | Judgment | Required change |
|---|---|---|
| E1 | Modify | Attach tiering, but define one total retention limit. Today a tiered grid retains the store limit **plus** the fixed hot ring ([accessors.rs:536](/Users/ayates/orc/rust/aterm/crates/aterm-grid/src/grid/accessors.rs:536)). Add per-pane/global WASM budgets and distinguish WASM LZ4 from native zstd/disk. |
| E2 | Redesign | Do not key a persistent index directly by ever-growing absolute row. Short queries scan `0..line_count` ([index.rs:561](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:561)), postings saturate IDs to `u32` ([index.rs:139](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:139)), and `invalidate()` does not remove stale entries ([search/lib.rs:229](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/lib.rs:229)). It needs compact document IDs plus explicit append/replace/evict/reflow/clear/alt-screen events. Effort is above M. |
| E3 | Modify | CPU-only optimization. Include RGBA conversion bands, fractional-scroll behavior, and old/new overlay damage or separate overlay canvases. Measure how often users actually take the CPU fallback. |
| E4 | Split/defer | Benchmark posting containers after E2 fixes identity/lifecycle. `SearchContent` integration is not mechanical because the current index uses stored strings for verification; `ColumnMap` duplication also remains. |
| E5 | Modify | The anchor idea is good, but it is not a one-line S change. Selection mapping currently depends on `display_offset`; compare each frame using its own absolute anchor and test selection, cursor, images, reflow, and fractional scroll. |
| E6 | Split | Materialized-row LRU, warm-block cache, `Cow`, and run-cursor are four changes with different invalidation risks. Land the run-cursor independently; benchmark before adding multiple cache layers. |
| E7 | Redesign/defer | The existing translate helper deliberately leaves the incoming strip as a placeholder and documents exact incoming-row raster as deferred cross-crate work at [scroll_translate.rs:54](/Users/ayates/orc/rust/aterm/crates/aterm-render/src/scroll_translate.rs:54). It is not yet a complete scroll-blit primitive. |
| E8 | **Endorse as specified** | The GPU bundle already uses retained `RenderInput` plus `cell_frame_into`; copying that pattern into CPU WASM is mechanical and low risk. |
| E9 | Split | Move `search_meta/incomplete` earlier as correctness work. Combine row-range export with the P7 mirror redesign. Benchmark `memmem`; it helps literal verification but not the regex/case-insensitive full scans at [index.rs:899](/Users/ayates/orc/rust/aterm/crates/aterm-search/src/index.rs:899). |
| E10 | Split | A byte watermark is safety work and should move near E1, not remain hygiene. Do not inject a fake sentinel into terminal content; expose truncation out-of-band. Delete/wire dead search separately and benchmark the claimed push-depth regression first. |
| P1 | Modify | Add debounce plus request generations/cancellation, immediate Enter handling, and a pending state. Debounce alone does not stop a long old query from blocking the render worker. |
| P2 | Modify | Implement the documented semantic writer queue, preserving adjacent same-session ordering and control-event flushes for binary and NDJSON. Re-benchmark the actual writer version on native, WSL, and SSH; do not promise +58% yet. |
| P3 | Modify | Add `scrollPx`/fractional-line commands through the worker facade and protocol. Preserve line/page delta modes, TUI wheel forwarding, sensitivity, and sign conventions. |
| P4 | Modify | This spans more than `terminal-host.ts`: renderer/provider options, `CreateOrAttachRequest`, adapter payload, Node `Session`, Rust RPC validation, and old-daemon compatibility. Node `Session` already accepts `scrollback` at [session.ts:73](/Users/ayates/orc/src/main/daemon/session.ts:73); the intermediate protocol does not. |
| P5 | Modify | The 512 KiB replay versus 5 MiB store claim is real at [terminal-scrollback-limits.ts:1](/Users/ayates/orc/src/shared/terminal-scrollback-limits.ts:1) and [terminal-scrollback-snapshots.ts:136](/Users/ayates/orc/src/main/terminal-scrollback-snapshots.ts:136). Prefer incremental/async hydration; blindly reading and replaying 5 MiB synchronously can create a restore freeze. |
| P6 | Modify | Binary-searching the sorted visible-match range is sound. Throttled freshness needs versioning, an explicit stale/pending state, and a guaranteed final refresh. |
| P7 | Reject as worded | Do not suppress authoritative STATE until “settle”; that can leave offsets, cursor, selection, and accessibility mirrors stale during a long fling. Decouple/rate-limit only the expensive grid-row mirror and batch row export. |
| P8 | Modify | Pending UI belongs with P1/P6. Raise the cap only after E1 **and** bounded incremental search are proven. Also fix the existing policy inconsistency: canonical normalization caps at 50k ([terminal-scrollback-policy.ts:1](/Users/ayates/orc/src/shared/terminal-scrollback-policy.ts:1)), while one settings field advertises 100k ([TerminalEngineBehaviorSections.tsx:59](/Users/ayates/orc/src/renderer/src/components/settings/TerminalEngineBehaviorSections.tsx:59)). |

## Verdict

**Endorse as specified**

- E8.

**Endorse the objective, but require modification**

- E1, E3–E5, E9.
- P1–P6 and P8.
- P2 specifically should implement the documented writer-side design, but must not inherit the pump-side experiment’s +58% as a guaranteed result.

**Redesign or split before scheduling**

- E2, E6, E7, E10.
- P7.

**Missing roadmap items**

- A committed E0 benchmark/gate suite for WASM CPU and GPU: search build/update/query/RSS, scroll/present cost, restore latency, and realistic corpora.
- Search request cancellation/backpressure, ideally separating expensive search work from the render-critical worker.
- Search-index lifecycle: closing search clears JS matches but retains the engine’s potentially large cached index ([aterm-search.ts:110](/Users/ayates/orc/src/renderer/src/lib/pane-manager/aterm/aterm-search.ts:110)). Add release-on-close, idle eviction, or memory-pressure handling.
- Explicit incremental-search correctness tests for retention eviction, reflow, resize, ED3/RIS clear, main/alternate screen switching, short queries at large absolute rows, and ID exhaustion.
- Per-pane and global scrollback/search memory budgets with WASM heap telemetry and safe “unlimited” semantics.
- CPU partial-present overlay damage and fractional-scroll interaction tests.
- Daemon protocol/version-skew tests for P2/P4 across native, WSL, SSH, binary, and NDJSON transports.

The most serious roadmap mistake is treating E2 as a contained incremental-index hook-up. It is the right high-impact destination, but the current index’s document identity, eviction, short-query scan, reflow, and lifecycle semantics must be redesigned first.
