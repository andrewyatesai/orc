# Parity status — orca-alab vs stablyai/orca

Companion to [TAILING-SYSTEM.md](./TAILING-SYSTEM.md) (the process). This is the
current *state*: where the fork sits against upstream, and what remains a human
decision rather than a port. Update the top block on each sync.

## At parity as of upstream `2f0f9a8a39`  _(2026-08-18)_
The ledger through `2f0f9a8a39` is fully dispositioned; every mechanically-portable
*missing* item is on `main`.

- **Cadence sync** (`604169f4af..2f0f9a8a39`, +34 commits): 19 portable-missing, **14
  ported in one wave** (`233bb6b3d4`), 14 n/a, 1 large-feature (HISTFILE feature-channel),
  0 collides. Census re-baselined (orca-runtime.ts 36901→36903, pty.ts 6411→6433, shim
  2823) — the STA-517 relay-deadline budget (one dead relay no longer freezes every
  workspace) + the AgentDetector→AgentSessionTransitionRecorder refactor.

## At parity as of upstream `604169f4af`  _(2026-08-17)_
The ledger from base `4dc777f707` (v1.4.143) through `604169f4af` is fully dispositioned,
and every mechanically-portable *missing* item is on `main`.

- **Small cadence sync** (`b6d5972ec4..604169f4af`, +79 commits, ~1 day): the "sync small
  and often" rule in practice — dispositioned 79 → 38 portable-missing, **all 38 ported in
  ONE wave and merged as a single batch** (`dafbe3b230`), vs the multi-wave grinds a +300
  becomes. 21 n/a, 7 superseded, 5 collides, 5 large-feature, 2 native. Census re-baselined
  (orca-runtime.ts 36628→36901, pty.ts 6382→6411, shim 2823). Orchestration
  dispatch-invariant/routing/lane commits routed to collides per
  [orchestration/RECONCILIATION.md](../orchestration/RECONCILIATION.md).

Earlier syncs to `b6d5972ec4` (below) took three passes:

- **Cadence sync** (`09ec516ae5..b6d5972ec4`, +300 commits): dispositioned 299 → 132
  portable-missing (3 high · 67 med · 62 low), 109 n/a (the max-lines refactor campaign +
  reverts), 31 superseded (aterm 4 / rust 2 / orchestration-divergent 13 / other 12), 12
  large-feature, 9 collides. **84 ported** across 5 batch commits + a mobile-harness fix
  (`2224b2471a`→`1d697951ce`): b1 13, b2 20, b3 16, b4 20, b5 15. Census re-baselined per
  batch (orca-runtime.ts 36393→36628 attach-kind; pty.ts 6382; shim 2812→2823). Two silent
  auto-merge losses were caught by post-rebase tsc (a dropped `withTimeout` that b2's ported
  module already carried; a duplicate const); the SGR-pen-reset and `snapshotCarriesNoImage`
  guard collided on one replay block and were reconciled to keep both; three batch-introduced
  oxlint errors were fixed by *splitting* (mobile + an over-800 test file), never suppressing.
  The orchestration-divergent commits routed to superseded/collides per
  [orchestration/RECONCILIATION.md](../orchestration/RECONCILIATION.md).

The ledger from base `4dc777f707` (v1.4.143) through `09ec516ae5` was fully dispositioned in
the two prior syncs:

- **First sync** (through `c991bb27d3`, 848 commits): 2 orchestration grafts (capability
  tokens, mutation receipts), all 11 high-impact items, the entire medium tier (290) and
  low tier (246).
- **Fresh-delta sync** (`c991bb27d3..09ec516ae5`, +322 commits): 235 *missing* items
  classified into 8 batches of ~30 and fanned out via the port pipeline. **155 ported**
  and pushed across 8 batch commits (`083ade30e7`→`b3ae6d6b23`): b1 20, b2 16, b3 19,
  b4 19, b5 21, b6 18, b7 23, b8 19. The rest dispositioned as superseded (aterm/Rust
  surface), n/a, large-feature, or collides. Census re-baselined knowingly per batch
  (pty.ts 6364→6382 attach-kind growth; orca-runtime.ts tightened 36823→36393 as
  extraction shrank it; shim 2812) — every increment attributed in `_rebaselines`.

Re-derivation-in-spirit held throughout: hook-command and output-snapshot conflicts
between two upstream commits touching one file were reconciled against upstream's own
already-reconciled tip, not blindly one-sided. The b5 usage-tracking removal, b6
`hosted-review-gitlab` deletion, and the IME/WSL/PTY attach-path work all landed on the
fork's superseded surface without regressing it.

**Deferred this sync (human decisions, below):** 1 credential-surface item
(`2249330acf`, cookie diag sink), 7 large-features, 7 orchestration-collides.

**Open delta:** none as of `09ec516ae5`. Upstream keeps moving; the next cadence run
starts from this sha per the playbook — sync small and often.

## The named backlog — decisions, not ports
These are deliberately *not* auto-ported. Each is a product/architecture call.

### Architecture (the big ones)
- **Orchestration model.** `main` runs its own v9 subsystem (run ownership, gate policy,
  audit ledger) plus grafted **capability tokens** (schema v10) and **mutation receipts**
  (v11). Upstream's Run/capability subsystem and a parallel-session **"fleet"**
  ownership/grant model are *rival* implementations of the same concept. Grafts 2
  (worker lifecycle) and 4 (runs/deliveries) are **held** — they collide with fleet and
  are a design decision, not a graft. Reconciling capability-tokens vs fleet-grants is
  the standing orchestration decision.
- **`orca-runtime.ts` decomposition debt.** The runtime god-object grew ~+700 lines over
  the sync (features attach there). Every increment is attributed in
  `tools/terminal-bench/census-ratchet.json` `_rebaselines`. Decomposition is owed and
  is separate from parity.

### Large features (whole subsystems — port only if wanted as features)
Plugin system (kernel/packs/panels/marketplace), agent-status search board, dashboard
boards, account-backed artifact sharing, kanban/Linear view persistence, macOS TCC
"Full Disk Access" explainer, and others tagged `large-feature` in the ledger.

### Security-gated
- **`orca account add`** (headless-host credential capture) trips the
  `report-credential-writes` review-note audit. It must go through a **human credential
  review**, never an auto-rekey. Deferred as its own isolated batch.

### Toolchain-gated
- **Native macOS (Swift)** items (computer-use permission settling, etc.) — need a Swift
  toolchain to build/test; queue for a toolchain run.

### Dependency-blocked
- A few **ai-vault** items need a prerequisite feature the fork lacks (e.g. the session-
  delete surface); port the prerequisite first or leave.

### Fresh-delta deferrals (`09ec516ae5` sync — concrete shas for the human triage)
- **Credential-surface:** `2249330acf` (cookie-preservation) touches the
  `browser-cookie-import.ts` diag sink flagged `named [cookies] in payload` and orphans
  review notes → needs a **human credential review**, never an auto-port.
- **Large-features:** `25f7870c58` (stacked PRs), `394e4bf1c0`, `9f0bf39b04`,
  `abd160fadd`, `d6362deb04`, `5e3a2d25f7`, `665e0ead83`.
- **Orchestration-collides** (fork v9 + grafts vs upstream Run/capability vs fleet):
  `8da362919e`, `0824351fe0`, `686f5dca1a`, `09c8597fb7`, `158b575680`, `84e7ca5212`,
  `991a3fe963`.

## Not-mine red gates (parallel-session state, do not fix blind)
- Full-repo `oxlint` is red on `main` (4 errors) in files on the **credential/account
  forbidden surface** — `codex-accounts/service.ts`, `codex-accounts/runtime-home-service.ts`,
  `browser-cookie-import.ts` (3 of 4), plus `native-chat-image-transcript-markers.ts`. All
  pre-existing on base, all `<0`→`===-1` / `hasOwnProperty`→`hasOwn` nits; the credential
  three can only be fixed by their surface owner. Every ported batch's own diff is
  oxlint-clean.
- `report-credential-writes` is red on `main` from a parallel **encrypt-at-rest** fix
  (`integration-credential-file.ts::upgradeStoredCredentialToCiphertext`) that added a
  write site without a review note. The owner must reconcile the note.
- Two `ssh-target-draft` tests assert the old upstream relay-grace default; the fork
  deliberately diverges. These are the parallel session's to reconcile.

## The instrument
- Ledger data (per-sync): `scratchpad/parity/*.json` during a run; snapshot the
  disposition counts here on merge.
- Gate set that every batch must pass is listed in TAILING-SYSTEM.md.
