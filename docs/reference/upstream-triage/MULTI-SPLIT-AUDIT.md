# Multi-Split + Cursor/Effects Audit — aterm terminal

**Scope:** Multiple splits and split/unsplit lifecycle across the Orca renderer (`src/renderer/src/lib/pane-manager/`, `src/renderer/src/components/terminal-pane/`) and the aterm engine (`rust/aterm/crates/aterm-effects`, `aterm-render`, `aterm-core`, wasm/worker glue). Special focus: cursor rendering + terminal effects (owner-flagged prior pain).
**Method:** read-only — source + tests read, `git`/`grep` read-only. Every claim cites `file:line`. 18 findings survived verification (REFUTED dropped); 2 are PARTIAL/dormant.

---

## 1. Executive summary

**Multi-split is structurally sound for correctness-of-data and does not crash or lose scrollback in Orca.** No critical findings. The real risks cluster in two seams, both in the owner's flagged area:

1. **Focus-gate gap (the dominant root cause).** The engine's effects pipeline treats `self.focused` as driving *only* matrix rain. Cursor glow, cursor trail, and *all* word-decoration effects are **never focus-gated in the engine**, and the native "unfocused ⇒ amplitude 0" `MotionPolicy` gate (`app_render.rs:5190/5200-5201` + `motion.rs`) was **not replicated on the wasm/worker path**. In native this is masked because an unfocused *window* isn't rendered; in Orca a split pane is unfocused *but still visible and rendered*, so the "effects only animate focused" invariant is violated for every visible-unfocused pane. This produces one high, several mediums (correctness + the N-scaling perf cost that rides on it).

2. **Geometry re-anchor without effects re-baseline.** `resize()` on split/unsplit/divider-drag resets the input predictor but never re-baselines the cursor trail/glow, so a reflow-induced cursor jump spawns a spurious one-frame comet — the exact class the native app guards with `cursor_trail.reset()+cursor_glow.reset()` (`app_render.rs:6667-6680`) and the web path omits.

Everything else is low-severity efficiency scaling (N concurrent bounded rAF/fit loops per split, O(N²) spill recomposite, per-pane STATE fan-in) — bounded, self-cancelling, and mostly gated behind opt-in effects. Two scrollback-budget findings are **dormant by design** in Orca (no global budget is ever set).

**Verdict: sound core, with a real and coherent focus-gate divergence between the native and web effects paths that the owner should close at the engine level.**

---

## 2. Findings by severity

### HIGH

| # | Title | Area | Kind | Evidence | Symptom / Repro | Fix sketch |
|---|-------|------|------|----------|-----------------|-----------|
| H1 | Focus gate is a no-op for **all** word-decoration effects | effects-across-splits | correctness | `pipeline.rs:1145` threads `self.focused` in; `word_decorations.rs:3202` param is `_focused: bool` (unused — grep confirms only decl + a test-name substring at 12949); stale doc `3180-3182` vs reversal note `3245-3247` ("focus deferral removed 2026-07-17") | Unfocused-but-visible split pane fully animates cat entrance/sing/idle one-shots. Repro: split, run a cat/nyan decoration effect in the non-focused pane while it emits output | Restore the gate inside `WordDecorations::tick` (freeze episode/idle advance when `!focused`, keep wall-clock latch), OR host-side skip `tickEffects` for unfocused-visible panes. Fix stale docs. |

### MEDIUM

| # | Title | Area | Kind | Evidence | Symptom / Repro | Fix sketch |
|---|-------|------|------|----------|-----------------|-----------|
| M1 | Cursor glow + comet trail animate on **unfocused** split panes (engine never focus-gates; web host never zeroes amplitude like native) | cursor-across-splits | correctness | `pipeline.rs:1027-1035` trail tick / `1048-1051` glow tick use full cfg; `self.focused` read only at `1145`; `set_effects_focused` (`aterm-gpu-web/src/effects_api.rs:62-64`) touches rain only; native gate `app_render.rs:5190/5200-5201` + `motion.rs:243-272` (unfocused⇒amplitude 0.0); engine contract comment `cursor_glow.rs:2600-2605` expects host to deliver intensity≤0 | Wrong cursor affordance (glow/comet) on unfocused visible pane during background output (`yes` repro). Opt-in effect, 2+ visible panes | Fold `!self.focused` into glow/trail amplitude inside `pipeline::apply` (local `glow_cfg.intensity=0.0`, `trail_cfg.enabled=false`) mirroring native; glow's intensity≤0 = cool-not-wipe so momentum survives a blip |
| M2 | Shared worker rAF keeps ticking + rendering every unfocused-glowing split pane (no focus gate on `is_effects_active`) | cursor-across-splits | performance | Consequence of M1: `pipeline.rs:311-316` `is_active()` true on trail/glow; `aterm-worker-effects-tick.ts:31-39` advances unconditionally; visible-unfocused not suspended (`frame-scheduler.ts:166-180,296-298`); one shared rAF (`frame-scheduler.ts:46-73`) | N unfocused glowing splits keep re-rendering offscreen on the shared loop instead of settling | Fixed by M1: idle unfocused pane's `is_effects_active()` goes false → `frame-scheduler.ts:221-223` stops re-booking |
| M3 | Unfocused visible split panes animate glow/trail at full intensity — cost scales with N (contradicts "effects only animate focused") | performance-N-splits | efficiency | `cursor-blink.ts:64-72,98-108` never touches glow; `pipeline.rs:358-365,372-384` set rain only; `is_active()` counts glow (`311-316`); glow kill path only at `cursor_glow.rs:2851 (cfg.intensity<=0.0)`; native zeroes it `app_render.rs:5190` | N actively-streaming unfocused visible panes burn display-rAF while cursor moves | Web focus path scales glow/trail amplitude to 0 like native motion policy |
| M4 | Host advances effects for every VISIBLE pane regardless of focus; only hidden/suspended throttles | effects-across-splits | correctness | `aterm-worker-effects-tick.ts:31-38` unconditional advance; `frame-scheduler.ts:166` suspended early-out, `186` tickEffects, `343-353` setSuspended from hidden only; `aterm-render-worker.ts:399-400` setFocused→noteFocus (QoS only, `command-scheduler.ts:55-57`); spill compositor has **zero** focus refs | Unfocused visible pane's chrome-band fire/glow composites into the shared window band next to focused pane | Thread focus into frame scheduler; skip `tickEffects` for unfocused-visible (also resolves M1). If intended, document as explicit policy |
| M5 | Cursor trail/glow have no resize-reflow re-baseline — spurious comet across reflow cursor jump on the **focused** pane | past-regressions-history | correctness | `aterm-wasm/src/lib.rs:853-884` resize resets only `predict` (`883`), never `self.effects`; `pipeline.apply` ticks trail `1033-1035`/glow `1049-1051` unconditionally; spawn suppressors need armed hint (`cursor_trail.rs:442-447`) which resize/scroll never arm on wasm (`effects_api.rs` note_keystroke → rain only; `note_scroll` wired only in `app_render.rs:6975-6976`) | One-frame comet on every window resize, divider-drag commit, unsplit-grow of focused pane | Pipeline re-baseline entry from wasm resize clearing trail.last/glow.last, or a short resize-settle suppressing spawn (as word_decorations' `RESIZE_SETTLE_MS`) |
| M6 | Trail/glow not focus-gated — split reflows the now-unfocused sibling and spawns a comet on it | past-regressions-history | correctness | Same non-gating as M1 (`pipeline.rs:1033-1035,1049-1051` vs single focus site `1145`); host blur reaches rain only (`cursor-blink.ts:98-108,64-72`); CHANGELOG:1291 documents "unfocused window = dark trail" invariant | Split shrinks sibling cols → rewrap → cursor shift → comet on unfocused pane (transient unless host keeps advancing it) | Gate trail/glow spawn behind `self.focused` in `pipeline.apply` |
| M7 | Closing/unsplitting focused pane transfers focus (+ blink + effects) to the **oldest** map pane, not the spatial survivor | split-unsplit-lifecycle | correctness | `pane-split-close.ts:216-225` picks `panes.values().next().value` = first-inserted; `198-214` promotes spatial sibling but discards its id; Map iteration = insertion order, `disposePane` only deletes (`pane-lifecycle.ts:183`); focus event drives effects+blink (`aterm-cursor-blink.ts:64-93,110-118`); container has no focus→setActivePane route (`pane-lifecycle.ts:122-129`) | 3+ pane layout: keyboard input + cursor/glow land on wrong (oldest) pane after unsplit | `removePaneContainer` returns promoted leaf's paneId; prefer it in `activateReplacementPane` before the `.next()` fallback |
| M8 | Split & close active-pane transitions never emit `onActivePaneChange` (only `setActivePane` does) | split-unsplit-lifecycle | correctness | `pane-split-close.ts:64,222` use raw `setActivePaneId`; only `setActivePane` fires `onActivePaneChange` (`pane-manager.ts:323-324`); documented gap `use-terminal-pane-lifecycle.ts:1561`; manual close mitigation re-does only 2 side-effects (`1564,1566`), split path none (`980+`); `syncPaneLayoutRevision`/`persistLayoutSnapshot` skipped (`1590-1593`) | Layout-revision + persist consumers desync on split-create / close-survivor (tab title + PTY are mitigated) | Route split/close reassignment through `setActivePane` (or emit on real id change) |
| M9 | Per-pane STATE post + main-thread applyState/overlay repaint scale O(N) with streaming visible panes; unfocused-visible not throttled | performance-N-splits | performance | `frame-scheduler.ts:144-158` posts full `buildState()` per painted frame, gated only on `suspended` (`166,195-198`); `buildState` full snapshot (`aterm-worker-terminal.ts:202-269`); main `aterm-worker-loader.ts:166-192` applyState + overlay.paint gated on `workerSuspended` (hidden, `401-404`); QoS orders `process` not STATE posts | 4-pane all-streaming split = O(N) main-thread snapshot work/frame | Lower STATE cadence for visible-but-unfocused; skip `overlay.paint` when no search/link content |

### LOW

| # | Title | Area | Kind | Evidence | Symptom | Fix sketch |
|---|-------|------|------|----------|---------|-----------|
| L1 | `resize()` resets prediction but not cursor effects — surviving pane spawns spurious comet from stale pre-reflow cursor | effects-across-splits | correctness | `aterm-gpu-web/src/lib.rs:1078-1108`, `1101` predict.reset only; no pub reset on `EffectsPipeline`; trail/glow reset gated on `!enabled` only (`pipeline.rs:519,576`); `cursor_trail.rs:341-343` spawn on any move; native guard `app_render.rs:6667-6680` | One-frame cursor smear on split | Add `EffectsPipeline::reset` (trail+glow) beside `predict.reset()` at `lib.rs:1101` |
| L2 | Each rapid split starts an independent per-frame post-spawn PTY reconcile loop (`safeFit` every frame ≤~3s) | split-unsplit-lifecycle | efficiency | `pty-connection.ts:4384-4408` pane-local handle, cancels only own (`4390`); reschedules per frame ≤`POST_SPAWN_RECONCILE_MAX_FRAMES=180` (`pty-size-reconcile.ts:35-36,79,116-119`); N burst = N concurrent `getBoundingClientRect` loops overlapping teardown fit (`pane-split-close.ts:170-172`) | Redundant measurement churn during split bursts (bounded, self-cancelling `8680-8681`) | Cap concurrent reconciles or fold measure into the shared fit pass |
| L3 | split-right white-screen fallback heals only exact 0×0 spawn, not transient-nonzero-then-stuck grid | split-unsplit-lifecycle | correctness | fallback gated `lastSent<=0` (`pty-size-reconcile.ts:126-127`); a transient `{1,1}` sets lastSent=1 (`64-69`), later nulls stall stability (`77-78`) → loop hits MAX, fallback skipped; documented 1-col wobble `pane-fit-resize-observer.ts:97-99` | Pane pinned at sub-usable ~1-col grid until onResize backstop recovers | Gate fallback on min-usable-grid (`cols<MIN`) not strict `<=0` |
| L4 | Split/unsplit relayout triggers O(N) full spill recomposite per pane = O(N²) reblits when effects chrome active | performance-N-splits | efficiency | `aterm-worker-spill-compositor.ts:280-284` per-pane `recompositeAll` on geometry change; `113-119` clearRect + reblit all panes; also overlay-box `252-256` | Handful of strip reblits on split/drag (no-op when no chrome — `114,137`) | Set overlay-dirty flag; single `recompositeAll` at flush epilogue |
| L5 | ResizeObserver stable-fit rAF poll fires per pane on every split — N concurrent bounded rAF loops | performance-N-splits | efficiency | `pane-fit-resize-observer.ts:148-166` one RO/pane → `requestStablePaneFit` (`85-146`) ≤`MAX_STABILITY_FRAMES=8`; settle guard armed only by OUTER container RO (`use-terminal-container-fit-sync.ts:233-236`), which a split doesn't change → guard stays false | N concurrent ≤8-frame proposeDimensions loops per relayout | Route post-split refits through one debounced settle-window pass for all panes |
| L6 | Word-decoration resize-settle opens on a COLS change only — horizontal (rows-only) splits bypass born-settled suppression | past-regressions-history | correctness | `word_decorations.rs:2806` `cols_changed` sole gate; only `self.cols` stored (`2877`); `rescan_end` never receives/compares rows; `RESIZE_SETTLE_MS=500` (`147`) | Word scrolling into a stacked-split pane during rows reflow plays full entrance instead of static ink | Thread rows into `rescan_end`, track `self.rows`, open settle on either dim change |

### PARTIAL / DORMANT (informational — no action needed for Orca)

| # | Title | Why dormant | Evidence |
|---|-------|-------------|----------|
| D1 | Shared `LIVE_SHARES` budget: opening a split evicts the OTHER pane's scrollback | `effective()` short-circuits when `GLOBAL_BUDGET_BYTES==0` (default), never reads LIVE_SHARES; no host caller of `set_scrollback_global_budget` (only generated glue) | `scrollback_shared_budget.rs:34,94-95`; `aterm_wasm.js:1793` |
| D2 | Global budget share re-applies only on render/drain — split transiently over-budgets; idle pane keeps stale-large budget | Same dormancy (global never set); documented touch-time policy (`scrollback_shared_budget.rs:13-28`); no production `drain_scrollback_backlog` caller (tests only) | `scrollback_shared_budget.rs:105-112`; `scrollback_tiers_api.rs:28-32,96-105,151-154` |

---

## 3. Cursor + effects across splits (owner's stated concern)

**Root-cause pattern: a single missing focus gate in the engine, plus a native-only host gate the web path never ported.**

- **The one lever.** `EffectsPipeline` reads `self.focused` at exactly **one** site — the word-deco tick call (`pipeline.rs:1145`) — and even there the callee ignores it (`word_decorations.rs:3202` `_focused`). `set_focused`/`set_effects_visibility` (`pipeline.rs:358-365,372-384`) wire focus to **matrix rain only**. Cursor trail (`1033-1035`) and glow (`1049-1051`) tick unconditionally. So *nothing cursor/word-related in the engine honors focus.* (H1, M1, M4, M6)
- **The native mask that hides it.** Native folds focus into a `MotionPolicy` that drives unfocused amplitude to a **hard 0.0** (`app_render.rs:5190/5200-5201`, `motion.rs:243-272`), and never renders a blurred *window*. The engine was *designed around that contract* — `cursor_glow.rs:2600-2605` literally documents "expect unfocus to arrive as intensity ≤ 0." The wasm/worker path (`effects_api.rs:62-64`) never applies it. (M1, M3)
- **Why splits expose it.** In Orca each pane is its own engine instance and an unfocused pane stays **visible and rendered**. The host only throttles **hidden** panes (`frame-scheduler.ts:166,343-353`), never unfocused-visible ones. So every visible-unfocused split pane advances effects (M4), keeps `is_effects_active()` true on the shared rAF (M2), and repaints at full glow intensity scaling with N (M3, M9).
- **Geometry re-anchor with no effects reset.** Separately, split/unsplit/resize reflows the cursor but `resize()` resets only the predictor (`lib.rs:883`, `gpu-web lib.rs:1101`), not effects — so a reflow cursor jump spawns a one-frame comet on both the focused pane (M5) and a reflowing unfocused sibling (M6/L1). Native guards exactly this (`app_render.rs:6667-6680`); web omits it.

**Net:** the cursor/effects-across-splits behavior is *not* what the CHANGELOG claims ("effects only animate focused"). The invariant is enforced by native's window model, not by the shared engine — and multi-pane splitting is precisely the case that breaks the assumption.

---

## 4. Recommended fix order

1. **Engine focus gate in `pipeline::apply` (fixes H1, M1, M2, M3, M4, M6 at once).** When `!self.focused`, locally set `glow_cfg.intensity=0.0` / `trail_cfg.enabled=false` before the ticks, and freeze word-deco episode/idle advancement (keep the wall-clock latch to avoid replay). This makes `is_active()`/`is_effects_active()` go false for idle unfocused panes, dropping them off the shared rAF. **One engine change collapses the whole focus-gate cluster.** *Effort: M (engine + care to preserve latch semantics + tests).* **Do this first.**
2. **`EffectsPipeline::reset()` on resize (fixes M5, L1).** Add a pub reset (trail.reset+glow.reset+clear scratch) invoked from wasm/gpu-web `resize()` beside `predict.reset()`. *Effort: S.*
3. **Focus survivor + `onActivePaneChange` on split/close (fixes M7, M8).** Return the promoted spatial sibling's paneId from `removePaneContainer` and prefer it; route split/close active reassignment through `setActivePane`. *Effort: S–M.* Correctness of keyboard target + layout persistence.
4. **STATE-post / overlay cadence throttle for visible-unfocused (M9).** Lower cadence + skip empty overlay paints. *Effort: M.* Do after #1 (focus bit is already threaded).
5. **Low-severity efficiency batching (L2, L4, L5) + white-screen min-grid (L3) + rows settle (L6).** Fold post-split fits/recomposites through one settle flush; broaden fallback + settle gates. *Effort: S each, opportunistic.*

D1/D2 need no action unless a host opts into a global scrollback budget.

---

## 5. Checked and found SOUND

- **No white-screen-on-split regression recurrence for the 0×0 path** — `split-right-white-screen.test.ts` covers it and the `<=0` fallback (`pty-size-reconcile.ts:126-132`) heals the pure-blank case (only the narrower stuck-1-col slips, L3).
- **Divider capture loss** — `pane-divider-capture-loss.test.ts` covers pointer-capture release on divider drag; no finding.
- **Pane id stability** — `mint-stable-pane-id.ts` yields stable ids; `disposePane` deletes cleanly (`pane-lifecycle.ts:183`), no id reuse hazard found.
- **Scrollback isolation between split instances** — per-instance in Orca; the shared-budget coupling (D1/D2) is dormant because no global budget is ever set (`scrollback_shared_budget.rs:34,94-95`).
- **Post-spawn PTY reconcile leaks** — bounded (≤180 frames) and self-cancelling on dispose (`pty-connection.ts:8680-8681`); no permanent loop leak (only concurrency churn, L2).
- **Data/PTY correctness across splits** — no dropped output, no cross-pane PTY misrouting found; close-path PTY + tab-title are explicitly re-synced (`use-terminal-pane-lifecycle.ts:1564,1566`).
- **Matrix rain focus behavior** — the *one* effect that is correctly focus-gated end-to-end (`pipeline.rs:382`); confirms the gate mechanism works and only its coverage is incomplete.
- **Hidden-pane suspension** — hidden panes are correctly suspended/throttled (`frame-scheduler.ts:166,343-353`); the gap is specifically *unfocused-but-visible*, not hidden.
