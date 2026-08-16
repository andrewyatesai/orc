# Orchestration authority model — reconciliation decision

_Decision-ready assessment, 2026-08-16, verified against `origin/main` `6100792fc0`
(orchestration `SCHEMA_VERSION = 11`). Resolves the standing "which orchestration model
wins" question and the held grafts 2 / 4._

## Verdict

**The fork's orchestration is already coherent. There is nothing to reconcile, and
grafts 2 and 4 should stay held.** Every apparent "gap" against upstream is either a
deliberate divergent-machinery choice or a keyword-match false alarm; every "fix" a naive
read suggests is actively wrong (see [Myths](#myths--changes-that-look-additive-but-are-not)).
Agent-shippable work here is **empty**. The subsystem is reconciled as-is.

This retires the "three rival implementations" framing (fork v9+grafts vs a parallel
*fleet* model vs upstream's Run subsystem). It was never three rivals over one seam — it
is **three distinct seams, each with exactly one owner**.

## The three seams and their owners

| Seam (direction) | Owner | Where | Threat closed |
|---|---|---|---|
| **worker → coordinator REPORT** auth | **graft-1 capability tokens** (schema v10) | `dispatch_contexts.capability_hash / launch_token_hash / process_incarnation / capability_revoked_at`; checked in `rpc/methods/orchestration.ts:295-337` | a pane that only knows a dispatch id forging `worker_done`/`heartbeat` |
| **coordinator → pane WRITE** auth | **fleet grants + `coordinator.ownedWorkerHandles`** | `fleet-grant-registry.ts` (live, process-pinned) + `coordinator.ts:642-658` (owned handles, **durable** — rebuilt from the append-only `audit_events` ledger on restart) | hijacking a pane the coordinator is driving |
| **retried-RPC idempotency** | **graft-3 mutation receipts** (schema v11) | `mutation_receipts` (`orchestration_schema.rs:193-203`), `withMutationReceipt` on `taskCreate`/`dispatch` | a reconnect/retry double-applying a mutation |

All three write **one single-writer SQLite store** (the fork's Rust `orca-runtime`, fronted
by the `OrchestrationDb` napi shim), so they never race. graft-1's capability columns and
graft-3's `mutation_receipts` are **byte-identical to upstream** — the fork has been porting
upstream's model column-for-column, not diverging from it.

### The "bearer vs anti-bearer" rivalry was false

Fleet's design doc rejects "a token you issue to yourself proves nothing." graft-1's token
is issued **by the coordinator to the worker** and presented back — which fleet explicitly
permits. Capability-tokens (report-inbound) and fleet-grants (write-outbound) are the **two
directional halves of one anti-hijack story**, not competitors. They gate opposite seams
and share no record.

## Grafts 2 and 4 — stay held (deliberate divergences, not omissions)

- **Graft 4 (runs + deliveries + mailbox-pointer).** The fork's `messages` table is
  **per-worker-handle addressed** (`to_handle` + `recipient_pane_key`, `read`,
  `delivered_at`; **no `run_id`, no `delivery_contract`** — `orchestration_schema.rs:40-63`)
  and the Rust delivery path (`orchestration.rs:279-305`) matches it exactly. Upstream's
  `deliveries` + mailbox-pointer is **run-scoped shared-mailbox** machinery (`run:<runId>`,
  one-outstanding-per-run via `idx_deliveries_one_outstanding`). These are **different
  machines**, not a superset/subset. Swapping upstream's in would **strand every in-flight
  per-worker message**. Revive only on a concrete product need, and then **additively** —
  layer a `delivery_contract` discriminator (`legacy_direct` for today's lane +
  `current_delivery` on top) exactly as upstream did — **never a swap**.
- **Graft 2 (worker lifecycle / `worker_terminal_resources`).** The fork does **not** lack
  durable pane-ownership: `coordinator.ownedWorkerHandles` (rebuilt from `audit_events`) plus
  fleet write-grants already are the seam-2 anti-hijack half. Upstream's ownership/release
  state machine (`ownership_state`, `release_state`) is a **richer net-new project** that
  overlaps the existing owned+fleet halves — not a coherence fix, and with no forcing
  function. Keep held.

Neither graft is a subset of the fork's model; both are deliberate divergences on the
fork's superseded (Rust) surface.

## Myths — changes that look additive but are NOT (do not ship these)

Established across two adversarial rounds; each was proposed by a naive read and refuted
with file citations:

- **"Unify the two process-incarnation strings."** The report gate mints/checks the
  composite `${ptyId}:${incarnationId}` (`getTerminalProcessIncarnation`,
  `orca-runtime.ts:15312`); the write gate mints/checks the **raw** `incarnationId`
  (`resolveTerminalIncarnationId`, `orca-runtime.ts:15793`). They are on **different seams,
  never cross-compared**, each a self-consistent matched mint/check pair. Pointing one at the
  other's encoding **breaks the fleet write gate** (composite vs raw never compares equal →
  all writes blocked). There is **no latent bug** here.
- **"Make `fleet.generationByRun` durable."** Fleet's in-memory grant lifetime is a
  **deliberate security property** (`fleet-grant-registry.ts:7-9`): a grant must not outlive
  the runtime that issued it. A durable read-through would be a **regression**.
- **"There's a generation-fence collision."** There is **no** v9/run generation to collide
  with — `coordinator_runs` has no generation column and the Rust surface has zero
  `generation` references. The only fence is fleet's manager epoch. No collision.
- **"Adopt upstream's `deliveries`/mailbox-pointer as the exactly-once owner."** Divergent
  machinery (see graft 4) — strands per-worker mail.
- **"The fork lacks durable pane-ownership."** It does not (see seam 2 / `ownedWorkerHandles`).

## The one genuine open item (low priority, owner's call)

`restoreOwnedWorkers` (`coordinator.ts:642-658`) rebuilds owned-worker handles from a
**global newest-1000** audit window (`audit.list({limit: 1000})`, no `runId`/pane filter;
Rust `audit_ledger.rs:71` is `ORDER BY created_at DESC ... LIMIT ?`). On a very busy ledger,
an old `fleet.worker-created` marker could fall outside the window and not be restored.

**Severity: low, with a backstop.** `isDispatchableTarget` (`coordinator.ts:677-687`) only
short-circuits on `ownedWorkerHandles.has(handle)`; otherwise it still **requires a live
`hasFleetWriteGrantForRun(...)`** before driving the pane — so an evicted owned-marker does
not open a hijack, it at worst forces the coordinator down the fleet-grant path. If the
owner chooses to close it, prefer a **targeted query** (`action = 'fleet.worker-created' AND
target_pane_key = ?`) over widening the global window. This touches owned files
(`coordinator.ts` + `rust/.../audit_ledger.rs`) — **a human/owner decision, not an agent
edit.**

## Provenance & method

Two workflow passes (`wf_76f78150-eca`, `wf_a2ded76b-75e`): four read-only model maps →
synthesis → two adversarial refuters (data-collision + security lenses). The **first**
synthesis was returned **UNSOUND** — it over-reached toward "adopt upstream," which the
refuters broke on four file-cited counts (the C1–C4 above). The **corrected** synthesis,
constrained by those verified corrections and the upstream map, was returned **SOUND**. The
value of this document is as much the myths it kills as the verdict it reaches: the naive
"align with upstream" instinct is wrong for exactly the reasons the fork is superior here.
