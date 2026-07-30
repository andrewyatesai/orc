# Session Report — orca-alab / aterm program (2026-07-20 → 2026-07-24)

## Scope

Started as "align with upstream, triage the issues"; became a full upstream-sync
+ triage + roadmap-port + engine-performance program across two repos:
**orca-alab** (the Electron app, `/Users/ayates/orc`, GitHub `andrewyatesai/orca-alab`)
and **aterm** (the Rust/WASM terminal engine, submodule + `~/aterm`, on the
dev account's private `aterm` repo).

## What shipped (all gated, all pushed)

### Foundation
- **Upstream sync**: merged `stablyai/orca` v1.4.147-era (+134 commits, 88
  conflicts resolved under the fork's Rust/aterm policy). Verified green.
- **Full triage**: all **777 open issues + 1023 open PRs** downloaded, classified
  by area/kind/fork-relevance → `SUMMARY.md`, `PRIORITIES.md`. 93% apply to the
  fork as-is; only ~1% obsoleted by the aterm engine swap.
- **Roadmap port**: **102 of 103** PRIORITIES items ported (142 `port(#N)`
  commits), verified green → `PORTED.md`.
- **Terminal audit**: **154** terminal-stack issues evidence-audited against the
  fork (each verdict cites a commit/file:line/test) → `TERMINAL-AUDIT.md`.

### Engine program (waves 0–5 + closure)
- **Kitty `:3` release-marker fix** — spec-reviewed vs kitty C + ghostty; the
  reset-escape-hatch carve-out. (Refuted once, corrected, re-verified SOUND.)
- **StreamingSearch → Trust framework** — `ty_model!` derived spec, Tier-0/Tier-1
  lockstep, spec_xref-closure registered; adversarially reviewed incl. mutation drill.
- **Budgeted resumable search** (fed E-6), the P1–P8 product perf batch,
  custom keybindings, Nushell, deep-links (consent-gated), compose box, context
  menu, SSH pane parking, and the five still-applies bug fixes.
- **Federated search v1** — across **local + daemon + remote/SSH** panes; all 5
  closure residuals genuinely closed (the last was a diagnosed replay-geometry
  ordering bug, fixed + mutation-proven).

### Performance (the headline wins, measured)
| Metric | Result |
|---|---|
| Typing-present (E3 dirty-band) | **~605 → 7,543 fps (12.5×)** |
| Scroll-present (E7 scroll-blit) | **368 → ~1,600 fps (4.3×)**, byte-identical |
| Search index memory (sortedvec + delta-postings) | **895 → 314 B/line rotating (−65%)**; replog 220 / linkheavy 242 (≤250) |
| Flood ingest | **~229 MB/s = at/above the macOS PTY read ceiling**, at/above ghostty tip |
| Tiered scrollback store | attached in production (was dormant); no 42 s freezes |

E7 correctness note: whole-row scroll-blit is byte-identical only under a
**general overshoot invariant** (re-raster any retained row whose below-neighbour
is exposed) + shade-parity re-raster — proven across a 288-scenario geometry sweep
and a 26k-frame adversarial differential. The gate caught three real
byte-divergences before the invariant closed the class.

## Engineering discipline (why to trust the above)

Every substantive change ran an **adversarial review + Codex CLI second review**
(dual gate) before push; when Codex went over quota (until 2026-07-30), a
**triple-Claude + formal-oracle** gate substituted, disclosed as such.

The gates caught real defects repeatedly and were never overridden:
- kitty fix refuted once; E7 refuted **three** times; the federation closure
  refuted **four** times — each converged to a correct fix, or to an *honest
  stop* with the exact remaining surface named.
- **Change B (search String-drop) was proven structurally impossible** to do
  byte-identical (the shared `SearchIndex` lifecycle-Replace path needs cached
  old text) — reported honestly instead of forced.
- **Damage-scoped present** hit an architectural blocker (damage is derived
  *from* materialize) — banked, not faked.
- No false green was ever pushed.

## Final repo state (clean, converged)

| Repo | At | Notes |
|---|---|---|
| orca-alab (app) | `74e2e1f5a` | local == origin, clean, pin-check ok |
| aterm (orc pin) | `9d1ce1d2` | v0.61 + perf roadmap |
| `~/aterm` (full engine) | `a0bc4b90` | == origin; latest (game-fonts past v0.61) |

Confirmed: the submodule and `~/aterm` are the **same** GitHub repo; all aterm
work reaches full aterm; `~/aterm` was kept fast-forwarded after each land.

## Open / deferred (honest, tracked)

- **orc pin is at v0.61 (`9d1ce1d2`); aterm has advanced to `a0bc4b90`** (game
  fonts). Re-pin orc when that engine work is wanted (regen blobs + bump).
- **Perf roadmap** (`rust/aterm/docs/PERF-ROADMAP-post-E7.md`): item 2
  (damage-scoped materialize) revisit post-2026-07-30 with the full dual gate —
  few-% win, shared damage-epoch protocol; item 3 (GPU scroll) imperceptible;
  read-only search index for rotating ≤250 is a larger new-engine project.
- **Multi-split cursor/effects audit** (`MULTI-SPLIT-AUDIT.md`): 18 confirmed
  findings, **zero critical**; one root cause (the "effects only animate focused"
  invariant is enforced by native's window model, not the shared engine, so
  visible-unfocused split panes fully animate). **A single engine focus gate in
  `pipeline::apply` collapses 6 findings.** Audited, NOT yet fixed — awaiting a go.
- **ARENA-SCROLL publishable head-to-head** needs the M4 Max (rule zero); the
  engine scroll floors are hardware-agnostic and green.

## Bottom line

The fork is current with upstream, the P0–P2 roadmap is ported, federated search
works across all pane types, and the terminal engine is materially faster
(12.5× typing present, 4.3× scroll, −65% search memory) and — for macOS flood
ingest — at the physical hardware ceiling. Everything is pushed and converged
across all three checkouts. The remaining work is diminishing-returns polish and
one audited-but-unfixed effects-focus-gate cluster, all tracked with reasons.
