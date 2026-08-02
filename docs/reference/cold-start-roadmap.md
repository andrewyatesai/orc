<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cold-start roadmap — ranked by expected return (2026-08-02)

Companions: `cold-start-2026-08-01.md` (measured state + four closed doors) and
`cold-start-serialization-review.md` (external design review of leads 3/4).

**Every figure below is ANALYSIS, not measurement.** Analysis was wrong four
times out of four in the session that produced it (see the closed-doors section
of the companion doc). Items 1 and 2 existed to stop that pattern, which is why
they ranked first while saving nothing — both have now landed, and item 1
promptly proved the point by refuting this document's own proposed fix.

## The ceiling that constrains everything

Time to a usable terminal is ~900ms–1s. Of that:

- spawn → app-ready is **190–270ms** against a **~127ms** trivial-Electron
  floor, so ALL of our main-process JS is worth ~60–140ms — and since the
  compile cache landed that is execution, not parse. Most of it is Electron API
  calls, service construction and module init, not computation.
- The rest is the renderer and the pane path, where the remaining cost is
  **waiting, not computation**.

Anything proposing to make our code *compute* faster is competing for a slice of
a slice. Anything removing a *wait* is where the return is.

## Ranking

| # | Item | Est. saving | Effort | Confidence |
|---|---|---|---|---|
| 1 | Milestone lane resolved from the frame — **LANDED** (`afc9424ad2`) | 0ms (correctness) | done | Shipped |
| 2 | Queue trace — **LANDED** (`0560e12f20`), not yet run | 0ms (decision data) | done | Shipped |
| 3 | Visible-first pane admission | 0–200ms | 1 day | **Gated on running #2** |
| 4 | Worker compiles its module at boot | 50–150ms | 1 day | Medium |
| 5 | Prewarm de-chain — **LANDED** (`ba6f7e0039`) | 0–160ms | done | Unverified |
| 6 | PTY attach started earlier | 40–60ms | 1 day | Medium |
| 7 | Engine blob size reduction | 50–100ms | weeks | Low |
| 8 | Promote boot-path TS → Rust (ts2rust factory) | 5–20ms | 1–2 weeks | Low |
| 9 | Move boot I/O + parse into the Rust daemon | 20–60ms | months | Low |
| 10 | Electron fork (V8 snapshot, component stripping) | 60–90ms | standing ops | Medium |

## Why 1 and 2 ranked first despite saving nothing — and what they taught

Both have landed. The lesson is worth more than the code.

`markTerminalPaneBootPhase` claimed its lane by **prediction** (first caller to
reach `boot-start`) while the terminating event is decided by **outcome**
(whichever pane paints). Nothing reconciled them, so on a multi-tab restore every
phase between them subtracted two different objects and still printed as a clean
same-clock number. It read coherently only because the fixture makes `tabs[0]`
both first-mounted and active.

**Three attempts failed by predicting a better pane; the third — "latch to the
visible pane" — was this roadmap's own recommendation, and it is unsound.** A
hidden pane can still present: the context-loss rebuild wires a fresh scheduler
that starts unsuspended, an Activity-portal slot is unsuspended but invisible,
and `isVisible` defaults to true. Do not re-propose it.

What works is to stop predicting: buffer each lane's phases and flush the
winning lane, with original timestamps, once the frame NAMES its pane. The lane
becomes an outcome, so it cannot be left unclaimed while a frame is reported —
which was the second prior attempt's failure mode.

Item 3's payoff is somewhere in 0–200ms and **nothing narrows it until the item-2
trace is actually RUN**. The build queue runs 2-wide FIFO and grants the first two
slots synchronously, so if the winning pane is already in that first pair the
change wins nothing — the external review calls it illusory absent the trace.

## The next concrete step

The instrumentation exists; the measurement does not. On a quiet machine:

```sh
pnpm bench:first-terminal -- --label active0 --active-tab-index 0
pnpm bench:first-terminal -- --label active7 --active-tab-index 7
```

Read the `[bench] queue` table. **Decision rule, fixed before the data:** median
`firstFramePaneAdmitIndex <= 1` with a ~0 `firstFramePaneQueueWaitMs` ⇒ the winner
was already in the first synchronous pair, so drop item 3. A material wait ⇒ that
wait is the CEILING on item 3's payoff — quote it, never a prediction — and note
that fixing it means reordering the *initial* grant, not just releases. Measure
total background completion alongside, so a foreground win cannot hide a restore
regression. Interleave A/B in one quiet window; absolute medians swing ~30% with
machine load and <5% is noise.

The two runs are also the empirical proof of item 1: both must now produce a
coherent lane, where before the change the `active7` run mixed two objects.

## Why 8 and 9 estimate poorly *for cold start*

Both are strategically interesting. Neither belongs on a roadmap ranked by
cold-start return.

Two facts from this repo argue against 8 specifically:

- **P2 was already tried and rejected.** The napi-string NDJSON cutover was
  implemented, proven wire-identical, benched — and rejected at **~30% slower**
  end-to-end (458 vs 657 MB/s), because per-line UTF-16⇄UTF-8 FFI copies
  dominate while V8 substrings are copy-free. The standing rule it produced —
  no Rust cutover on a hot path without a same-day bench win — applies here.
- **The factory's promotions are additive.** 258/264 kernels TRUSTED and the
  seam proven twice, but the shipping TS stays and no hot call site is cut over.
  The open work is promotion, not proving.

Item 9 is structurally sounder — work that never runs in the main process cannot
slow it — but it is a protocol project measured in months, and the specific
boot-path candidates have already measured small: persistence load **3–4ms**,
scrollback restore **0ms**.

Fund 8 for the E1 claim, the certificates and the paper. Its cold-start return is
a rounding error and could be negative at the FFI boundary.

## Suggested scheduling

1. ~~**One session:** items 1 + 2.~~ **Done** — both landed. The instrumentation
   that produces the decision data for 3 now exists.
2. **Next, and it is cheap:** run the two commands above on a quiet machine.
   Until that output exists, item 3 has no defensible estimate.
3. **Then** whichever of 3/4/6 the data justifies, one at a time, each measured
   by interleaved A/B on a quiet machine.
4. Realistic total recovery from the ~900ms: **150–300ms**, and treat the top of
   that range skeptically.

Not scheduled: item 7 (weeks of engine work for a number the measurements say is
not where the time goes) and item 10 (its entire prize is ~60–90ms while ~600ms
of our own path is still on the table — revisit only when that is exhausted).
Note item 10 still out-estimates 8 and 9 for this specific goal.
