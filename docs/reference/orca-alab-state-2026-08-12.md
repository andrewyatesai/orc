# orca-alab — what is actually here, read from the source

**Measured at `b6250648b`, 2026-08-12.** Every number below came from the tree, not
from a summary. Where a claim is an inference rather than a measurement, it says so.

Written because the project's own documents describe a design, and it had become
hard to tell which parts of that design are wired, which are behind a flag, and
which are still prose.

---

## 1. Scale

| | |
| --- | --- |
| TypeScript / TSX, non-test | **1,134,032 LOC** |
| TypeScript / TSX, tests | 1,093,959 LOC |
| Rust, first-party (27 crates) | 66,757 LOC |
| RPC methods | 543 |
| CLI commands | 231 |

Rust is **5.6%** of the codebase. The test-to-source ratio in TypeScript is close
to 1:1, which is unusual and worth crediting.

`src/main/runtime/orca-runtime.ts` alone is **36,024 lines** — one of the two files
the census ratchet watches, and the reason that ratchet exists.

## 2. The three modes are real, and thinner than the documents suggest

`AppModeId` is exactly `classic | alab | story-world`
(`src/shared/app-mode/app-mode-id.ts`).

**The anti-DSL guard is the load-bearing part**, and it holds. A manifest is plain
JSON — no expression, no condition on runtime state, no template string, no `$ref`,
no `extends` — enforced by a type-level test asserting `AppModeManifest extends
JsonValue`. The header names the exact failure it exists to prevent:

> the first `when: { activeWorktreeHasAgents: true }` field — which would end this
> design and would look perfectly reasonable in review.

A mode may occupy **three slots**: `workspace-body`, `left-sidebar-body`,
`titlebar-strip`. All three are consumed in production —
`app-shell/AppPageRouter.tsx`, `components/sidebar/index.tsx`,
`app-shell/use-app-titlebar-slots.tsx`. The preference persists to a sidecar file
(`src/main/app-mode/app-mode-sidecar-file.ts`) and has a settings pane.

So the mode system is wired, not scaffolding. But **ALab is 9 components and Story
World is 9**. The mode system is a placement-and-gating mechanism, not a second
application.

## 3. The fleet's authority model is genuinely enforced

This is the part most likely to have been theatre, and it is not.
`orca-runtime.ts:15593`:

```ts
const decision = this.checkFleetGrantForPane(options.grant ?? null, handle, ptyId)
if (!decision.allowed) throw new Error(decision.reason)
```

guarded on `pty?.launchAgent ?? pty?.foregroundAgent`, so a write into an agent's
pane requires a grant. There is a **second** call site at `:15550`, passed as a
`checkGrant` callback, with a comment explaining why one check was not enough:

> Agent detection is a hint, never an authority boundary.

Two details in `checkFleetGrantForPane` matter and are correct:

- the grant is **re-evaluated per call, never cached**, "so the pre-Enter re-check
  can observe a revocation that landed while the prompt was pasting";
- the incarnation comes from the **real** `ptysById` field, and `null` means
  unknown — a grant pinned to a real id can never match `null`, so an unknowable
  incarnation **fails closed**.

That second property is now proved rather than tested (§5).

## 4. …and the whole engine is off by default

`assertOrchestrationExperimentEnabled` gates every orchestration RPC. It is enabled
only by `settings.experimentalOrchestration === true` or an env override
(`src/main/runtime/rpc/methods/fleet-experimental-gate.ts`).

**This is the honest headline.** ALab's coordination engine works, is guarded, and
is not on. The orchestration module is 3,302 LOC of non-test TypeScript against
1.13M — and the SQLite schema behind it is 6 tables at `SCHEMA_VERSION = 11`.

## 5. Verification: two systems, often conflated

**Trust the compiler** (`-Ztrust-verify`) runs on every build of every crate at
`advisory` policy. `rust/.cargo/config.toml` states the consequence plainly:

> verified-and-reported, NOT verified-clean

Only **three** crates hold a real gate: `orca-stream-split` and
`orca-provider-backoff` at `certify`, `aterm-hash` at `strict`. Everything else is
blocked on the Trust-Std campaign — roughly 69% of all obligations fail as "absent
callee", which no source change reaches.

**ay certificates** (`proofs/ay/`) are hand-written, re-checkable SMT proofs.
**9 crates, 64 obligations**, all discharged. This is where verification actually
happens, and it is governed by a prove-and-catch contract: every bundle ships a
non-vacuity obligation (the property is reachable at all) and a catch-control (the
proof fails when the guard it credits is removed).

**Differential parity**: 85 modules, 1,633 vectors, run by both the Rust port and
the live TypeScript and diffed against each other — 1,719 comparisons green.

### What is measured, and what is not

`orca-core` was surveyed in full: **542 unproved obligations over 400 functions**.

| bucket | count | who can close it |
| --- | --- | --- |
| `[assert] runtime-checked` — absent std callee | 393 | only Trust |
| `[hardened_unsafe_operation]`, **empty** counterexample | 44 | only Trust — a statement about std |
| derive-generated (`Debug` 72, `Clone` 33, `PartialEq` 28, `Default` 13) | 146 fns | Orca, mechanically |
| `[unknown]` | 29 | mixed |
| overflow / divzero, runtime-checked | 8 | Orca, by rewriting to obligation-free forms |
| **`[unbounded_allocation]`, populated counterexample** | **2** | **Orca — the only actionable rows** |

Buckets overlap (most derive-generated functions produce `[assert]` rows), so they
do not sum.

**Two rows out of 542 carry a verified counterexample.** That is the number that
means something: a populated counterexample is an input the verifier constructed
that breaks the property. Everything else is the std gap or missing coverage.

**2 of 27 crates have ever been surveyed.** Everything above generalizes from
`orca-core` and `orca-policy`, and `orca-core` is the most string-heavy crate in the
tree — likely the worst case, not the average. This is the largest gap in this
document.

## 6. The gate discipline, and why it was needed

The repo enforces that a gate must be **falsifiable**:
`GATES_MISSING_A_NEGATIVE_TEST` in `config/scripts/gate-negative-coverage.test.mjs`
lists gates whose failure path nothing has executed, and its docstring sets the
rule — "the list only shrinks". It is now **empty**, and its scope covers
`check:` / `verify:` / `lint:`. Every claim is settled by an exit the meta-test
watched, not by a comment.

That discipline earned itself. A sweep that planted a real violation against every
fast gate found the same defect in **eight** places — a thing that did not run,
reporting success:

- E1's parity leg exited 101 on stale `-Z` rustflags under a stable toolchain
- `pnpm parity` aborted before the TS↔Rust diff
- `gauntlet` reported SKIP and exited 0
- `gauntlet bootstrap`'s install installed nothing, so **conformance had never run**
- all four `spec:` scripts skipped green when `ty` was absent
- `spec:exit-delivery`'s negative control was **erroring**, not detecting — a TLA+
  precedence trap meant it had stopped catching the `#7894` double-delivery race
- `check:build-output` printed its failure and exited 0
- `check:cli-main-entries` had no coverage and no debt row

None of these were wrong logic. All were plumbing that made a green signal mean
nothing.

## 7. Where the design and the code still disagree

- **R0 has no live acceptance test.** Everything about the fleet is verified by unit
  tests and differential parity. No test has watched two real panes coordinate end
  to end. This is the one place "it works" remains an inference.
- **`gauntlet autoformalize` cannot pass**, and should not be made to. A deliberate
  negative control in the Trust repo (`countws_bug.rs`) is now being proved
  VERIFIED — a soundness break — and a toolchain move dropped verified kernels
  397 → 124. Both belong upstream; lowering the floor would be bar-lowering.
- **103 provenance drifts** belong to other authors. Re-pinning them is one command
  and would destroy the signal.
- **The census ratchet has been re-baselined three times in three days.**
  `orca-runtime.ts` grows because it is where upstream features attach. The useful
  signal has been the delivery-reliability shim holding flat at 2,813 — not the god
  object staying small.

## 8. Summary

Orca is a large, conventional Electron IDE with a small, well-guarded coordination
engine inside it, and a genuinely unusual verification apparatus attached to a thin
slice of that engine.

The modes work. The fleet's authority model is real, enforced at two call sites, and
its refusals are now proved rather than asserted. The engine is ~3,300 LOC against
1.13M, off by default, and the review surface around it is the actual product.

"The fleet is verified" should be read precisely: **two authority decisions are
proved, and five pure decision cores are differentially checked against the live
TypeScript.** The coordinator itself is not verified, and nothing in this tree
claims otherwise.
