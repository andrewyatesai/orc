<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cold-start roadmap — ranked by expected return (2026-08-02)

Companions: `cold-start-2026-08-01.md` (measured state + four closed doors) and
`cold-start-serialization-review.md` (external design review of leads 3/4).

**Every figure below is ANALYSIS, not measurement.** Analysis was wrong four
times out of four in the session that produced it (see the closed-doors section
of the companion doc). Items 1 and 2 exist to stop that pattern, which is why
they rank first while saving nothing.

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
| 1 | Milestone latch → visible pane | 0ms (correctness) | ½ day | High |
| 2 | Queue trace | 0ms (decision data) | 2 hrs | High |
| 3 | Visible-first pane admission | 0–200ms | 1 day | **Gated on #2** |
| 4 | Worker compiles its module at boot | 50–150ms | 1 day | Medium |
| 5 | Prewarm de-chain — **LANDED** (`ba6f7e0039`) | 0–160ms | done | Unverified |
| 6 | PTY attach started earlier | 40–60ms | 1 day | Medium |
| 7 | Engine blob size reduction | 50–100ms | weeks | Low |
| 8 | Promote boot-path TS → Rust (ts2rust factory) | 5–20ms | 1–2 weeks | Low |
| 9 | Move boot I/O + parse into the Rust daemon | 20–60ms | months | Low |
| 10 | Electron fork (V8 snapshot, component stripping) | 60–90ms | standing ops | Medium |

## Why 1 and 2 rank first despite saving nothing

`markTerminalPaneBootPhase` latches to whichever pane reaches `boot-start`
first; `first-terminal-frame` can only fire from a **visible** pane. On a
multi-tab restore those are different panes, so every phase between them
subtracts two different objects. It reads coherently today only because the
fixture makes `tabs[0]` both first-mounted and active.

Item 3's payoff is somewhere in 0–200ms and **nothing can narrow that without
item 2**. The build queue runs 2-wide FIFO and grants the first two slots
synchronously, so if the visible pane is already in that first pair the change
wins nothing — the external review calls it illusory absent the trace. Spending
a day on 3 before two hours on 2 is how a change gets reverted.

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

1. **One session:** items 1 + 2. Produces the decision data for 3.
2. **Then** whichever of 3/4/6 the data justifies, one at a time, each measured
   by interleaved A/B on a quiet machine.
3. Realistic total recovery from the ~900ms: **150–300ms**, and treat the top of
   that range skeptically.

Not scheduled: item 7 (weeks of engine work for a number the measurements say is
not where the time goes) and item 10 (its entire prize is ~60–90ms while ~600ms
of our own path is still on the table — revisit only when that is exhausted).
Note item 10 still out-estimates 8 and 9 for this specific goal.
