# Parity status — orca-alab vs stablyai/orca

Companion to [TAILING-SYSTEM.md](./TAILING-SYSTEM.md) (the process). This is the
current *state*: where the fork sits against upstream, and what remains a human
decision rather than a port. Update the top block on each sync.

## At parity as of upstream `c991bb27d3`
The full ledger from base `4dc777f707` (v1.4.143) through `c991bb27d3` — 848 upstream
commits — is dispositioned, and every mechanically-portable item is on `main`. Ported
across the 2026-08 sync: 2 orchestration grafts (capability tokens, mutation receipts),
all 11 high-impact items, the entire medium tier (290), and the entire low tier (246).

**Open delta:** upstream advanced to `09ec516ae5` (+322 commits) during the sync. That
fresh delta is the next cadence run; its ledger disposition was started (partial) and
resumes per the playbook.

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

## Not-mine red gates (parallel-session state, do not fix blind)
- `report-credential-writes` is red on `main` from a parallel **encrypt-at-rest** fix
  (`integration-credential-file.ts::upgradeStoredCredentialToCiphertext`) that added a
  write site without a review note. The owner must reconcile the note.
- Two `ssh-target-draft` tests assert the old upstream relay-grace default; the fork
  deliberately diverges. These are the parallel session's to reconcile.

## The instrument
- Ledger data (per-sync): `scratchpad/parity/*.json` during a run; snapshot the
  disposition counts here on merge.
- Gate set that every batch must pass is listed in TAILING-SYSTEM.md.
