# ALab Auto Mode — Multi-Aterm Manager & Autonomous Router

**Status: design v4, for review — not in progress.** Written 2026-07-30 to be picked up
cold. Reviewed three times, each round against this tree: v1 by an architecture panel
and by codex (gpt-5.6-sol, ultra reasoning); v2 by a panel on terminal-semantics and
credentials; v3 by both, on the v3-only text. **▸ marks a claim a reviewer disproved;
▸▸ marks a v3 fix that was itself wrong or insufficient** — including two errors this
document introduced and round three caught (facts do *not* flow headlessly;
`agent-working` is not purely title-derived). Companion to
[`app-modes.md`](./app-modes.md) and [`app-modes-roadmap.md`](./app-modes-roadmap.md);
§11 reconciles the three documents.

**What round three changed, in one paragraph.** Both reviewers independently found the
same root cause: the design was treating *account*, *route*, *config dir*, and
*credential store* as one identity, and a byte counter as an event identity. §3a now
defines the four types, and the rules that fall out of them — health may be
account-scoped, credential mutation must be store-scoped; a rotation is a multi-key
transaction — resolve most of the contradictions the reviewers listed individually.
Two scope corrections came with it: R0's sensing work is **bigger** than v3 claimed
(no fact stream exists headlessly, so R0 builds a main-owned event journal), and
unattended rotation across a **shared** credential store is **out of scope for v1**,
because Orca cannot prove such a store is drained.

**The R0 repairs in §11 are landed** (this tree, 2026-07-30) — CLI `ask --task`
forwarding, the `run-log` handler, orphaned-dispatch reconciliation, agent-verified
dispatch targeting, and the settle-before-dispatch wait, with tests. Everything else
here is unbuilt.

---

## 1. What this is

Three pillars, one mode:

- **A — The fleet.** Many aterm terminals, each running an AI CLI (claude, codex,
  gemini, opencode, …), supervised from the ALab shell.
- **B — The router.** Model routing across multiple accounts per provider: when one
  subscription exhausts its credits, work continues on the next. Exhaustion is an
  event, not an outage.
- **C — The manager.** One AI CLI, in its own terminal, manages the others the way a
  human user would: it reads their screens, types into their TUIs, answers their
  questions when they ask, nudges them when they stall. Not dumb "continue" loops —
  judgment with real visibility, on a real cadence.

**The tenet, stated precisely** (v1's "human-indistinguishable" was wrong two ways):

> Managed interaction requires **no worker-specific protocol** — it uses the ordinary
> PTY input path any human uses, so any CLI is manageable uninstrumented. Automation is
> **explicitly attributed inside Orca**: every manager action and rotation is recorded
> durably. No camouflage is added (no jitter, no fake typing cadence); security never
> depends on the worker not noticing.

A worker *can* detect automation (bracketed-paste shape, env like `ORCA_PANE_KEY`,
process ancestry, input while unfocused). Cooperative CLIs don't care; adversarial ones
are handled by policy (§6), not concealment. Worker screens are untrusted input to the
manager.

**What the survey established:** most organs exist — an agent-facing terminal RPC
(`terminal.list/read/search/wait/send/…`, local + SSH + hidden/parked, all served from
the main-owned headless aterm model), typed agent-state facts (`pty:sideEffect`),
managed multi-account stores (Claude, Codex) with per-account isolated homes as
precedent, per-provider usage fetchers, verified resume commands for 11 CLIs, and a
working orchestration engine (tasks, gates, run log, preamble contract). What is
genuinely missing: a **verified submission primitive**, **durable account health +
crash-safe rotation**, **durable run/gate ownership**, and the **manager policy layer**.
Review killed several v1 shortcuts; the corrected claims are inline below, marked ▸.

## 2. Ground rules

- **Classic never regresses.** R0–R2 ship dark; R3 renders only in ALab mode.
- **Modes never own engine state.** Every service here lives in main/runtime.
- **Safety judges reality.** Automated driving of an agent pane passes
  `decideUnattendedAgentDispatch` over the *actual* launch profile. The manager is not
  a bypass.
- **Deterministic services own state transitions; the manager AI proposes.** Gate
  resolution, rotation, dispatch, and process lifecycle are executed by deterministic
  code that authorizes proposals against policy. The AI is judgment, never authority.
- **Gates: deterministic code never resolves them.** LLM resolution exists only under
  an explicit, per-run, human-pre-authorized standing order with a positive category
  allowlist (§6.3). Default is human-only, everywhere.
- **Honest records.** A durable, redacted audit ledger — not the in-memory run log —
  records manager actions and rotations (§7).
- House rules: no max-lines suppressions, concrete names, STYLEGUIDE tokens, SSH + WSL
  + folder workspaces + Windows considered; the support matrix is explicit (§10).

## 3. Why the Orca terminal boundary

aterm's introspection layer (`rust/aterm/docs/INTROSPECTION.md`) is the semantic model:
`turn` as a verified exchange, latched server-side waits, scoped tokens, presence. But
its control socket exists only in `aterm-gui`, which Orca never links (the parity gap
is by construction), and aterm supports exactly two integration surfaces (CLI, Rust
lib; deliberately no MCP). Orca's runtime RPC + `orca` CLI over
`<userData>/orca-runtime.json` is the working equivalent surface — orchestration
workers already use it, it reaches hidden/parked/SSH terminals with no renderer, and
`terminal.wait` shows the long-poll pattern.

**Decision: adopt aterm's semantics on Orca's wire.** Where v1 hand-waved "aterm
semantics", this design imports aterm's *specific lessons* (echo-settle before
anchoring, arm the watcher before the keypress, the second-Enter hazard —
`control_session.rs:734,982,741`) into the Orca implementation (§5). aterm's own
strongest tier, OSC-133 command-start, **does not transfer** — Orca's wire has no such
fact and 133;C is not emitted for a prompt typed into a running TUI, so §5.2 builds a
different ladder on submit hooks. Driving native aterm-gui fleets via `aterm-ctl`
stays a documented extension, not v1.

▸ *Corrected from v1:* `terminal.read` returns **line cursors and tail metadata**, not
an `outputSequence` (`runtime-types.ts:585`); the byte counter is private
(`orca-runtime.ts:7742`). Its text is a normalized transcript, renderer-blind — not
"the same screen the human sees." The design uses it as *evidence*, not as a screen
oracle, and never claims pixel truth.

## 3a. Four identities that are not interchangeable

Both v3 reviewers independently reached the same root cause for the contradictions
they found: the design used *account*, *route*, *config directory*, and *credential
store* as if they named one thing, and used a byte counter as an event identity. They
are four types. Naming them here is what keeps §5, §8 and §12 consistent; every later
section is keyed to one of them.

| Type | Identity | Answers | Consumers |
| --- | --- | --- | --- |
| **RouteKey** | `provider` + tagged account (`system-default` \| `managed:<id>`) + execution host (`local` \| `wsl:<distro>` \| `ssh:<host>`) | "which subscription am I spending, on which host" | chains, health, probes, reservations |
| **StoreKey** | the complete set of mutable credential surfaces a launch writes — config dir, auth file, *and* on darwin both the scoped and legacy keychain items | "can two live CLIs coexist here" | drain, mutex, materialization |
| **PtyBinding** | `runtimeId` + session/incarnation + the RouteKey and StoreKey it launched under, immutable after commit | "what is this live process actually using" | liveness, reattach, audit |
| **EventCursor** | `runtimeId` + `ptyIncarnationId` + monotonic event ordinal | "what have I already seen on this pane" | `terminal.await` replay |

Two rules fall straight out, and they resolve the sharpest v3 contradictions:

- **Health may be account-scoped; credential mutation must be store-scoped.** An
  account-keyed drain cannot answer whether a physical store is unused (§8.2a/§8.2b).
- **A rotation is a multi-key transaction** — source RouteKey, target RouteKey, and
  one or more StoreKeys — so it can be owned by neither a single account queue nor a
  single directory mutex (§8.2c).

`system-default` is representable in RouteKey and *not* in an accountId-keyed map,
which is why v3's `sessionId → accountId` map and `(provider, accountId)` queue were
both under-keyed.

## 4. Durable ownership first (R0 schema work)

Everything downstream needs identity that survives restarts. Today `coordinator_runs`
is a disconnected table — tasks, dispatches, and gates carry no `run_id`
(`orchestration_schema.rs`), the Coordinator schedules over *all* tasks, and the run
log is an explicitly non-audit in-memory ring that returns `retained:false` after
restart.

Schema v9. ▸▸ **"Nullable, defensively read" is not a blanket rule** — that pattern is
safe for `origin_message_id` only because null means "skip an optional reply". Per
column:

- `run_id` on `tasks`, `dispatch_contexts`, `decision_gates`. **Ownership needs a
  creation story, not just a column:** `taskCreate` today runs *before* any run exists
  and `orchestration.run` mints the run later, so nullable `run_id` leaves "which run
  adopts pre-existing tasks" undefined — including them races, excluding them strands
  today's workflow. Ship either `runCreate` + required `runId` on task/gate creation,
  or one atomic collision-detecting adoption transaction at `run`. `taskList` and
  `gateList` gain run filters; `runList` alone does not isolate queries.
- `decision_gates`: `category`, `default_option`, `manager_deadline_at`,
  `hard_deadline_at`, `policy_snapshot`, `resolved_by`, `resolution_reason`, and
  `version` **`NOT NULL DEFAULT 0`** — a CAS operand may not be null; legacy rows
  backfill to zero. Plus a **uniqueness rule for one pending gate per task** (today's
  indexes are non-unique).
- `coordinator_runs`: the per-run `gateResolutionPolicy` + its category allowlist
  (§6.3 assigns them here; v3 forgot to list them).
- `dispatch_contexts.status` gains `waiting_gate` (§6.2). ▸▸ **This is a table
  rebuild, not an additive step** — the column carries a CHECK constraint, which
  SQLite cannot extend in place — and every active-dispatch predicate must learn the
  new state (conflict, lookup, completion, and idle-terminal paths recognize only
  `pending`/`dispatched` today, `orchestration.rs:528,617`).
- **v9 is not downgrade-safe, and must say so.** Older binaries deliberately accept
  future-version DBs (`orchestration_schema.rs:172`), so a v8 binary would ignore a
  `waiting_gate` dispatch and hand that pane a second task. Add a compatibility fence.
- New `audit_events` table (§7) and `rotation_sagas` table (§8.3). ▸▸ Reservations
  need real mechanics, not "columns": `target_route_key`, `target_store_key`,
  `reservation_expires_at`, `reservation_released_at`, `reservation_fence`, and
  **partial uniqueness on the target while unreleased**. Acquisition releases expired
  rows and claims the target in one `BEGIN IMMEDIATE` transaction; expiry alone cannot
  make a uniqueness constraint lapse, so a row must be transactionally marked
  released. Long sagas renew and stop if they lose the fence.
- New RPC: `orchestration.runList` (bounded history, ordering, pagination, run-owned
  task/gate summaries) — the supervisor's wake brief depends on it and it does not
  exist today.
- Outside the orchestration DB: the persisted live-PTY registry gains **PtyBinding**
  attribution (§3a, §8.2b). ▸▸ It lives in top-level main-owned `PersistedState`
  (`persistence.ts:6744`), **not** `GlobalSettings` — moving it there would expose
  safety state through the generic renderer settings IPC. It is R1 work (§8.2b), not
  R0 schema work.

These are shared-core changes reviewed as such (per app-modes §8.1's own rule), not
mode UI slipped in sideways.

## 5. The submission primitive (R0)

### 5.1 Per-PTY input coordinator

`src/main/runtime/terminal-input-coordinator.ts` — one serializer per PTY for every
*automated* writer (manager, coordinator dispatch/delivery, query replies). Operations
are pinned to PTY incarnation + connection generation; a generation change mid-operation
aborts with a truthful phase report. Human paths are not serialized through it — humans
preempt (§5.4).

▸ **Mobile is a human, not an automated writer** (v2 listed it as one). Mobile already
sits at the *top* of the existing input floor: while `driver.kind === 'mobile'` the
desktop human's `pty:write` is dropped and desktop RPC sends are locked, and mobile
clients are never locked (`ipc/pty.ts:5188`, `rpc/methods/terminal.ts:342`). The
coordinator must compose with that election rather than outrank it: a phone human
grabbing a runaway agent preempts the manager's lease like any other human. The
ordering contract between the lease and `beginMobileInputFloor` is explicit —
floor claim wins, lease aborts at its current phase.

### 5.2 `terminal.submitAgentPrompt` — atomic, evidence-based

Not a wrapper around `sendTerminalAgentPrompt`'s fixed 500 ms + bare `\r`. Phases:

1. **Lease** the input coordinator; validate incarnation + launch profile; consult
   `decideUnattendedAgentDispatch` when the target runs a TUI agent (refusal is a
   first-class result, reason included).
2. **Paste** mode-aware (bracketed paste as today; ConPTY/CSI-u differences are why
   this is mode-aware, not fixed bytes).
3. **Echo-settle**: wait for the paste echo to quiesce — *then* capture the anchor.
   (Anchoring before paste lets the echo "prove" a submission that never happened.)
4. **Arm the watcher, then press Enter once.**
5. **Verify** with the strongest available evidence, in order: known-agent state
   transition (side-effect facts: `agent-working`) → content-change past the anchor
   (weak, labeled as such). Re-press Enter **only** when the target's provider adapter
   declares it safe — a second Enter on a slow link can auto-confirm the *next* prompt
   (aterm's own warning).

   ▸▸ **Corrected twice — the real ladder is hook-first.** v3 said `agent-working` is
   title-derived and therefore per-agent. Half right: the fact does come from
   `createAgentStatusTracker.handleTitle`, but **hook events synthesize OSC title
   frames into that same tracker** (`ingestSyntheticTitleFrame`,
   `orca-runtime.ts:8088`; producers at `index.ts:1413,1867`), so hook-capable agents
   do reach it. More importantly it is not the strongest signal available: Claude and
   Codex normalize **`UserPromptSubmit`** as a working event
   (`shared/agent-hook-listener.ts:2488,3243`), enriched with `hookEventName` and
   prompt identity (`shared/agent-status-types.ts:187`), and the hook server already
   treats it as proof a turn was submitted (`agent-hooks/server.ts:827`). The ladder:

   1. **Same-pane, post-arm, adapter-certified `UserPromptSubmit`** (or equivalent)
      attributed to this operation → `submitted: yes`.
   2. **Adapter-certified native state transition** → `yes` only where the adapter
      certifies it; otherwise `unknown`.
   3. **Display/content change** → observation only. Generic `agent-working` is any
      non-working→working title transition (`shared/agent-title-status.ts:48`) with no
      operation or prompt correlation, and a content change can be a repaint, a stale
      spinner, or a terminal query reply. **Neither may return `yes`** — uncertified
      evidence returns `submitted: 'unknown'`, which forbids retrying.

### 5.2a Measured: the R0 spike result

The spike §12 gates on has run (2026-07-30, against HEAD), and its verifier refuted
enough of it to change this section. What survived:

| Agent | Submit hook | Per-turn key | Native title state | Verdict |
| --- | --- | --- | --- | --- |
| claude | `UserPromptSubmit` (prompt text) | ✗ | ✓ | certify via lease (below) |
| codex | `UserPromptSubmit` (prompt text) | ✗ | ✓ working | certify via lease |
| cursor | `beforeSubmitPrompt` | ✗ | ✗ (title is Orca-synthesized — circular) | certify via lease |
| droid | `UserPromptSubmit` | ✗ | ✗ (defers to hook) | certify via lease; **no fallback tier** |
| grok | `user_prompt_submit` | ✗ | collapse | certify via lease |
| opencode | ✗ (no submit event) | **✓ `promptInteractionKey`** | ✗ | certify; plugin has a documented drop path |
| gemini | ✗ (`BeforeAgent`, prompt-less) | ✗ | ✓ | **`unknown` only** |

Only claude (2.1.220) and codex (0.146.0) are installed on this machine, so **five rows
rest on Orca-authored fixtures** — which prove Orca's *parser* accepts a prompt, not
that the vendor CLI emits one. That is the same standard the spike used to withhold
certification from gemini, so those five are provisional until a live probe; §10's
matrix reads accordingly.

**The decisive finding: nothing in the payload distinguishes two submissions to the
same pane seconds apart.** `promptInteractionKey` exists only for
opencode/mimo-code/command-code; `stateStartedAt` deliberately does *not* advance when
consecutive events share a state (`agent-hooks/server.ts:871`) — the manager's normal
case is submitting into an already-`working` pane; `receivedAt` is watermark-inflated
on relayed panes; and prompt text cannot be a key because it is capped to a 200-char
single-line preview (`agent-status-field-normalization.ts:13`) with lossy dispatch
compaction, after the paste path already rewrote ESC bytes. Orca's own code states the
limit: *"hooks prove a turn was submitted but not which UI launched the terminal"*
(`server.ts:938`).

**The resolution is the lease, not the payload.** §5.1's input coordinator already
grants *exclusive automated write* on the pane, and §5.4 turns any human input into a
preemption. So within a held lease, the first post-arm submit hook on that pane **is**
this operation's — the ambiguity the payload cannot resolve is one the coordinator
excludes by construction. That makes attribution sound without a new protocol, with two
honest caveats:

- **Nesting.** A child agent of the same type posts to the same endpoint and pane, and
  `inheritedFromActivePane` is `false` for identical types
  (`agent-status-identity.ts:59`), so a claude-inside-claude child's submit is
  indistinguishable from the lead's. Since a child's submit is causally downstream of
  the manager's, first-after-arm still attributes correctly; a *second* hook inside the
  window is not evidence of a second submission and must not be read as one.
- **`launchToken`** (`agent-hook-listener.ts:278`, minted at `orca-runtime.ts:22552`,
  posted back by every hook script) is the better pane/incarnation discriminator than a
  hook `source` field and is already plumbed — R0 uses it to reject stale panes. It is
  inherited by children, so it does not solve nesting either.

**One real hole, and R0 must close it:** the HTTP hook handler drops events for panes
in the closed-tab set *before* normalization and answers `204` regardless
(`server.ts:1823,1830`), and that set is cleared only at server stop. A real submit can
therefore be silently discarded with a success response. The verifier must be able to
tell "no hook arrived" from "the hook was dropped", or it will report `unknown` for
submissions that in fact landed.

   So the certified manager-backend allowlist (§6.5) and the "verified submit" row of
   §10 are keyed on this table, now measured rather than assumed.

   ▸ **OSC-133 command-start is not available and was removed as the top tier**
   (v2 claimed it). The fact union carries only command-*finished* (133;D)
   (`shared/terminal-side-effect-facts.ts:21`), main wires the scanner without its
   `onCommandStarted` callback (`shared/terminal-output-side-effects.ts:106`), and
   133;C is emitted by shell preexec hooks — a prompt typed into an
   *already-running TUI agent*, the primary case here, never produces one. 133;D
   remains meaningful for shell panes only, where `command-complete` is a valid
   `await` predicate.
6. **Return** a rich result: `{ operationId, phase, submitted: 'yes'|'no'|'unknown',
   evidence, attempts, draftState: 'clean'|'contaminated'|'unknown', generation }`.

`submitted:'unknown'` (e.g. disconnect after Enter) is terminal for automation — **no
automatic retry, ever**; it escalates.

### 5.3 `terminal.await` — settling is separate

Latched predicates extending `terminal.wait`: `quiet <ms>`, `match <regex>` (bounded:
1 KiB pattern cap, aterm-observe style), `agent-state <state>`, `command-complete`
(OSC-133, shell panes only), `none`. ▸ `tui-idle` is *not* a settle oracle (it can
classify silent computation as idle and never settle repainting TUIs);
`match`/`agent-state` are the primary predicates for agent panes. Long-poll with
stderr keepalives; the runtime caps long polls at 16 (with `ask` sub-capped at 8), so
the manager holds **one** await multiplexed over its watch set, not one per worker.

▸ **The multiplex needs per-pane resumption cursors — the hard part v2 omitted.**
`terminal.wait` is single-handle, the CLI transport is strictly one-shot (first
terminal frame ends the socket), and server-side waiters are torn down on resolve. A
first-event-across-N verb fits the wire, but every return destroys the watch, so
transitions on other panes between return and re-arm are lost.

▸▸ **`outputSequence` is the wrong cursor** (v3 named it). It is a byte counter
advanced by PTY output (`orca-runtime.ts:7742`) merely copied onto batches, so
synthetic and timer-driven facts emit without advancing it and two distinct batches
can share one value — "replay anything newer" would drop the second. It is also
deleted on teardown, and the fact contract states agent transitions never replay
(`shared/terminal-side-effect-facts.ts:40`). The cursor is
`{runtimeId, ptyIncarnationId, eventSeq}` over the R0 event journal's own monotonic
ordinal, with bounded per-PTY retention, an explicit `cursor_gap` resync result,
atomic replay-then-park registration, and deterministic fairness across panes. The
incarnation component is what makes it agree with §5.1's pinning contract.

▸▸▸ **Corrected three times; this version is measured.** The fact *stream* is indeed
consumer-gated — `recordTerminalSideEffectFact` returns immediately with no consumer
(`orca-runtime.ts:8246`) and the sink forwards to a `BrowserWindow`. But an earlier
edit then over-claimed that agent state itself is absent headlessly. It is **not**:
`applyTrackedPtyTitle` (`orca-runtime.ts:8510-8529`) sits outside the gate, computes
`detectAgentStatusFromTitle`, writes `pty.lastAgentStatus`, and resolves tui-idle
waiters — which is precisely how the existing `terminal.wait --for tui-idle` already
works under `orca serve` (`rpc/methods/terminal.ts:922`). The hook tap
`subscribeEnrichedStatus` likewise runs headlessly by design (`server.ts:599,522`).

So R0's sensing item is a **publication** problem, not a production one, and it is
correspondingly smaller: state is computed, it just has nowhere to go. R0 adds the
main-owned bus + bounded per-PTY journal as the *publication* layer, with the
renderer, `terminal.await`, and the health service as independent subscribers, and
leaves the deliberate headless skip of the per-chunk bell/133/URL scans
(`orca-runtime.ts:8443`, a commented perf decision) intact — enabling those per watched
or health-relevant PTY only. Two constraints the journal must satisfy that today's
surfaces do not: the enriched-status tap has **no replay and no per-pane sequence**
(`server.ts:598`), and `getStatusSnapshot` is last-status-per-pane, so a
`working→done` pair collapses between polls; and trackers are disposed wholesale at the
window boundary (`orca-runtime.ts:8616`), so a long-lived watcher must survive that
swap. Tier 1 is additionally gated on the agent-status-hooks setting
(`index.ts:834`) — with hooks off it does not exist at all, which §6.5's capability
probe must detect rather than silently degrade.

`terminal.turn` is then a convenience composition (submit + await), not the primitive.

### 5.4 Interjection — exclusive automation with visible takeover

If human input reaches the pane after the lease is taken, the operation stops and
reports truthfully — **generic rollback of a paste into an unknown TUI is
impossible**, so a contaminated draft is surfaced (UI toast + audit event), never
silently abandoned. Revocation is checked between chunks and immediately before Enter.

▸▸ **"Aborts at its current phase" was wrong after Enter** and contradicted §5.2's
no-retry rule. The phase decides the outcome:

| Preempted | Result |
| --- | --- |
| before paste | `submitted:'no'`, draft clean |
| after paste, before Enter | `submitted:'no'`, `draftState:'contaminated'` |
| **after Enter** | write authority revoked, watcher continues **read-only**, result is `'yes'` or `'unknown'` — never `preempted`, and never retried |

The ordering also needs one real linearization point between lease acquisition and
`beginMobileInputFloor`; check-then-subscribe is not enough. The grant-authenticated
verb must be classified server-side as *automation* rather than inheriting legacy
clientless `terminal.send` behavior, where absent client metadata reads as unlocked
mobile (`rpc/methods/terminal.ts:347`). And every human path needs the same
synchronous revocation hook — desktop `pty:write` currently reaches the provider after
only the mobile check (`ipc/pty.ts:5188`) and would not notify the coordinator at all.
The human always wins the keyboard; the design does not pretend it can also un-type.

### 5.5 SSH and remote

Local `write()` acceptance is not delivery proof over SSH (the code says so:
`ipc/pty.ts:5210`). For SSH panes, verification evidence must come from the echo/fact
stream, and `submitted:'unknown'` on relay loss follows the no-retry rule.
Remote-runtime (`remote:`) panes get submit/await implemented runtime-side (their bytes
never transit local main). v1 scope: local + SSH-relay verified; remote-runtime verbs
land with the same contract or report `unsupported`, never a silent downgrade.

## 6. Gates and the manager (R2)

### 6.1 The invariant, restated

`coordinator.ts:342` says the coordinator never auto-resolves gates because that would
defeat them as approval checkpoints. That invariant survives, sharpened:
**deterministic code never resolves a gate on its own judgment.** What changes: a
human may *pre-authorize*, per run, either a declared default (timeout fallthrough) or
delegation to the manager for a positive allowlist of categories. The comment is
reworded in the same commit that lands the policy — the code and the prose must not
disagree.

### 6.2 Transactional gate mechanics (prerequisite, R0/R1)

Today `resolve_gate` updates regardless of current status (last-writer-wins races),
gate open/resolve/task-status/reply are separate non-transactional writes, multiple
pending gates per task are possible, and opening a gate completes the active dispatch —
so resolution can *redispatch* the task while the original worker also resumes. Fixes:

- `resolvePendingGate(id, expectedVersion, actor, resolution)` — CAS on `pending` +
  gate/task/dispatch mutation + durable outbox reply insert, one transaction. Losers
  get the committed result; only the winner's reply is delivered.
- Dispatch enters `waiting_gate` instead of completing; resolution **resumes that
  dispatch** (the worker keeps its lease). Requeue happens only after worker-loss
  reconciliation.
- One active gate per task, enforced.
- ▸ `timeout_gate` today only stamps `status='timeout'` and leaves the task blocked;
  the fallthrough behavior below is new code, not a wrapper.

### 6.3 `gateResolutionPolicy` (per run, persisted on the run row)

- **`human-only`** — the default, including inside ALab missions. (v1 recommended
  `human-first` by default; both reviews called that unsafe, and app-modes §13 Q5's
  standing-order recommendation agrees. Overridden.)
- **`standing-order`** — on `hard_deadline_at`, the GatePolicyService applies the
  gate's *declared* `default_option`. Deterministic, pre-authorized, category-scoped.
- **`manager-delegated`** — the manager may resolve gates whose `category` is in the
  run's allowlist, before `manager_deadline_at`. **Fail-closed categories that are
  always human-only:** credentials, spend, destructive/irreversible actions, permission
  or security-boundary changes, and any gate with no category (legacy). Manager
  resolutions carry `resolved_by:'manager:<handle>'` + reason.

Precedence is explicit: manager window first (if delegated), then standing-order
fallthrough, then the gate waits for a human. One decider per phase; no race between
supervisor and manager by construction.

### 6.4 The deterministic services

Per review, the v1 manager/supervisor pair becomes judgment vs. small, single-purpose
services (the event spine is the `orchestration-event-bus.ts` that app-modes §8.5
already specifies — not wiring into the Coordinator's private methods):

- **Coordinator** (exists): DAG scheduling only; emits typed events (gate opened,
  dispatch stale, escalation) onto the bus.
- **GatePolicyService**: deadlines, defaults, CAS resolution, dispatch parking,
  outbox delivery.
- **RotationService** (§8.3): the account-transition saga.
- **ManagerSupervisor**: manager process lease, generation/fencing token, restart
  budget, wake queue. Nothing else. A restarted manager gets a wake brief (runList +
  gateList + router state) and a **new generation**; proposals carrying a stale
  generation are refused — that is the two-managers split-brain fence. Manager
  liveness is a real heartbeat (a periodic `orca manager heartbeat` the skill
  performs), not title/quiet inference.

### 6.5 The manager itself

An AI CLI holding the new bundled **`manager` skill**, seated in the
`OrchestratorPane`. ▸ Not "any of the ~34 catalog agents": the catalog describes
launching, not skill discovery or long-poll discipline. R2 ships a **certified
manager-backend allowlist** (claude, codex initially) behind a capability probe;
others graduate by passing the same probe.

- **See:** `orca terminal list/read/agent-status`; one multiplexed await.
- **Act:** propose → deterministic service authorizes → execute via
  `submitAgentPrompt`. Answers a worker's TUI question, nudges a stall with a
  considered instruction, interrupts a runaway (`signal`, grant-gated).
- **Rotate:** executes the human-shaped steps of a rotation saga when the
  RotationService asks (§8.3); never initiates one unilaterally.
- **Escalate:** anything outside policy → gate + notification. A manager that cannot
  classify a worker's state escalates rather than guessing.
- **Workers need no instrumentation.** Coordinator missions keep the preamble
  contract; but a plain uninstrumented CLI is fully manageable through its screen.
  **Preamble reconciliation (budgeted, snapshot-pinned):** BEHAVIOR RULE #1 currently
  tells workers a TUI prompt "cannot be seen and cannot be answered — your session
  will hang forever." Under a managed run that is false. A manager-aware preamble
  variant states that interactive prompts *will be answered at the terminal*, while
  still preferring `ask --task` for decisions that deserve a durable gate. The
  regenerated snapshot is the reviewable artifact.

### 6.6 Grants — scope and honesty

Grants (op classes `read`/`write`/`signal`, target set = the run's terminals) are
carried in the manager's env, checked by submit/send/signal, revocable, and rendered
as presence ("manager is driving"). **Minimal authority ships in R0, not R2:**
`submitAgentPrompt` against a TUI-agent pane refuses callers that present no grant
(the renderer/human path excepted), and the R0 verbs sit behind the orchestration
experimental flag. The human's own terminals are in no grant by default — which also
closes today's hole where `Coordinator.getAvailableTerminals` can dispatch into the
human's shells (fleet-ownership marker on coordinator-created terminals, R0).

▸ *Honesty:* grants are **not a same-UID security boundary** — any local process can
read the runtime owner token (0600, same user). They exist for accidental-scope
prevention, revocation UX, and audit. Containment against a hostile local process is
an OS-sandbox problem, out of scope and stated as such.

▸ *Mechanism, not just posture:* today every RPC caller authenticates with the one
shared `authToken` and there is no authenticated per-caller subject, so the grant is
an explicit bearer value presented per call.

▸▸ **The containment promise has to be narrowed to be true.** An ambient env variable
and "stripped from any worker the manager spawns" are incompatible: every child of the
manager inherits its environment by default — including the `orca` CLI child that must
present the grant. Orca can only guarantee stripping at **Orca-controlled spawn
boundaries**, so:

- The grant variable is **reserved and force-deleted** at the final local, WSL,
  SSH/relay, and remote worker spawn boundaries even when a caller explicitly supplies
  it (`terminal.create` accepts caller env today), and it may **never** enter durable
  `launchConfig.agentEnv`, or a resumed pane would carry authority.
- The guarantee is stated as "Orca-managed worker PTYs", not "any worker". A
  non-ambient broker transport would close the rest; that is out of v1 scope.
- The grant binds to `(runId, ManagerSupervisor generation, target pane incarnation)`,
  is atomically revoked before manager replacement, and is re-checked immediately
  before Enter or signal — not only when a long operation starts.

▸▸ **R0 has no issuer, and its own done-criterion needs one.** The supervisor and
manager launch arrive in R2, but R0's criterion is one agent driving another. R0
therefore ships a minimal grant-mint path for the test driver; without it the R0 gate
either can't run or runs ungated.

## 7. The audit ledger (R0/R1)

`audit_events` (append-only, in the orchestration DB): actor (human / manager:<handle>
/ service), action, target (pane key + handle + run), evidence pointer, timestamp.
Rotation sagas, gate resolutions, manager submissions, grant changes, and takeovers all
land here. **Redaction rule:** submitted *text* is stored as length + hash + an
optional operator-visible preview that a per-run setting can disable; credentials and
env values are never recorded. Retention is bounded (per-run cap + global cap, oldest
pruned). The in-memory run log remains what it says it is — a diagnostic tail.

## 8. The router (R1)

### 8.1 Route identity and chains

Chain members are **RouteKeys** (§3a) — never bare account ids. ▸
`providerAccountId` already means the upstream provider identity in the Codex model
and is not reused for Orca's managed-row id. `system-default` is a first-class member
(v1's managed-ids-only chains could not express the zero-change default), and it is
expressible only because RouteKey carries a tagged account plus execution host. Chains
are per provider, ordered, in `GlobalSettings.agentAccountChains`; default = current
selection only. Every member also resolves to a **StoreKey**, which is what §8.2a's
eligibility table reads. Cross-provider fallback is **a handoff, not a rotation**
(§8.4), off by default.

### 8.2 `AccountHealthService`

Durable per-**RouteKey** observations: per-window state
(session / weekly / monthly / model-scoped buckets — ▸ "100%" is not one bit; the
router evaluates the bucket relevant to the requested model), source, confidence,
observed-at, expiry, reset-at.

▸ *Corrected signals:* `failureKind:'rate-limited'` + `retryAtMs` mean the **usage
endpoint throttled telemetry**, not that the subscription is exhausted — v1 would have
rotated healthy accounts. Exhaustion evidence, in trust order: usage fetch showing an
exhausted relevant bucket; statusline live ingest at 100% for the attributed config
dir; a new `provider-limit` side-effect fact from in-terminal limit banners
(precedent: `codex-stream-error`). Telemetry-throttled or stale-beyond-expiry health is
`unknown` → the router treats unknown as "do not rotate onto", never as "rotate off
of". Because normal polling stops when the window is unfocused and inactive-account
fetches are UI-triggered today, the service adds **controlled on-demand probes**: only
at routing decision points, only for chain members, serialized through the §8.2c queue.

▸ **The statusline channel is same-UID spoofable** and therefore ranks *below* the
usage fetch (v2 had it first). `configDir` is parsed from a worker-posted HTTP body;
today's drop-on-mismatch bounds the blast radius to the single active slot.

▸▸ **"Corroboration" was not a strong enough rule.** v3 still left statusline as
standalone exhaustion evidence, so a forged 100% could drive a rotation whenever the
authoritative fetch is unavailable — and today a fresh statusline actually *suppresses*
the OAuth fetch and clears backoff state (`service.ts:1300,1368`). The rule: a
lower-trust 100% produces **`suspected-exhausted`**, which triggers an authoritative
probe and **may never authorize credential mutation on its own**. Attribution binds
server-side through `pane/session → RouteKey`; the posted `configDir` is only a
consistency check.

▸ **Per-account health is a RateLimitService refactor, and it is an R1 line item**
(v2 budgeted it as "verified in integration tests"). There is exactly one
`lastClaudeAuthSnapshot`, nulled on every switch, and `ingestLiveClaudeRateLimits`
*drops* posts whose config dir does not match it, writing one `state.claude` slot
(`service.ts:202,1326`). Throttle state is likewise per-provider on the active slot,
and all inactive accounts share one debounce timestamp.

▸▸ **Key it by RouteKey, not config dir** (v3 said config dir — which is both the
self-reported value the paragraph above rejects, and non-injective: the host shared
lane returns `envPatch = {}`, so `system-default` and every shared-lane account
normalize to the same null key, exactly the members that must be told apart).
Observations are keyed `(RouteKey, bucket, source)` and **kept separately per source**
— authoritative fetch, statusline, terminal banner — with explicit precedence and
freshness rather than one mutable slot each source overwrites. Backoff is per route
and durable. Codex needs the same refactor; this is not Claude-only. Add a **global
probe floor** so that probing every chain member at every decision point cannot itself
429 the endpoint into `unknown` and manufacture a false `chain-exhausted`.

### 8.2a Chain eligibility — the shared-store rule (blocker fix)

▸ **R1a as written in v2 was unsound for Claude host chains.** Every *shared-lane*
host account (and `system-default`, which can never be per-account-laned) materializes
into one runtime store — `~/.claude` plus the scoped *and legacy* keychain items
(`runtime-auth-service.ts:463,740`; `keychain.ts:38`). Letting an exhausted source
session keep running as a handoff while new launches route to the target puts two
accounts' live CLIs on one credential surface — the store-mixing the code forbids for
WSL.

▸▸ **Eligibility is per *transition* over StoreKeys, not a chain-wide label** (v3 had
it chain-wide, which needlessly destroys the concurrency it promises, and mis-keyed
`system-default` as a provider-generic rule — Codex system-default uses the real home
while its managed accounts use isolated homes, so nothing there is shared):

| Transition (§3a StoreKeys) | Rule |
| --- | --- |
| shared source → isolated target | may coexist; no drain |
| isolated source → shared target | drain the **target** store's occupants |
| same StoreKey on both sides | drain required |
| disjoint StoreKeys | concurrent, the R1 criterion's happy path |

So the rule is: **a target requires a drain when its credential surfaces overlap a
live lane** — replacing v3's "`system-default` is rotate-off-only", which was both
provider-generic and self-contradictory (it then permitted return-when-idle, i.e. a
conditional rotate-on).

▸▸ **And Orca cannot actually prove a shared-store drain.** A PTY enters the gate only
when its *initial spawn command* matches the Claude regex (`ipc/pty.ts:1227,3209`), so
`claude` typed later inside an Orca shell is invisible, as is anything the user runs in
Terminal.app — and the hidden usage-probe PTYs Orca spawns itself
(`rate-limits/claude-pty.ts:289`, reached by exactly the inactive-account probes §8.2
schedules) never register at all. Therefore: **unattended rotation across a shared
user store is unsupported in v1.** It is either an explicitly confirmed human action,
or the chain uses isolated lanes. This is the honest version of R1a's guarantee, and
§8.3/§12 are qualified to match — "a live session finishes as a handoff" holds for
isolated lanes; on a shared store the source must be gone first.

▸ Also unsound as stated: `beginClaudeAuthSwitch` is a **global** mutex and PTY spawn
*throws* for every Claude launch while a switch is in progress (`ipc/pty.ts:3213`) —
so "new launches route to the healthy account" is false during the materialization
window. ▸▸ But a per-store mutex alone does not fix it either: launch sites only *test*
the flag and register liveness *after* `provider.spawn` returns (`ipc/pty.ts:3825`),
so "no live PTY on this store" is provably true while a launch is in flight. Store
admission must be **atomic across credential preparation → provider spawn → liveness
commit**, held by the launch itself, with the drain predicate reading "no live **and**
no in-flight". "Human wins" means queued priority or cancellation *before* mutation
begins — it cannot preempt a multi-write materialization (file + scoped keychain +
legacy keychain + oauth-account JSON) halfway through.

### 8.2b Account-scoped liveness — a schema change, not a bullet

▸ The live-PTY gate is account-blind at *every* layer: a flat `Set` of pty ids with a
global `switchInProgress` flag and a drain event that fires only on the global 1→0
transition (`live-pty-gate.ts`), a flat `claudeLivePtySessionIds: string[]` in
persistence (`persistence.ts:6746`), and spawn sites that record only the pty id. Under
concurrent accounts the drain never fires, so **any** live PTY defers **every**
account's managed OAuth refresh indefinitely.

▸▸ **Persist a PtyBinding, not `sessionId → accountId`** (§3a): the map cannot express
`system-default`, the execution host, or the StoreKey — the last of which is the only
thing that answers the drain question. R1 therefore includes:

- The binding written **pending before** `provider.spawn` and committed after, so the
  crash window between spawn and the liveness mark cannot orphan an unattributed live
  process. `ClaudeRuntimeAuthPreparation.provenance` is already in scope at both spawn
  sites and is the discriminator to persist.
- **Reattach preserves the old binding.** The spawn result can be a reattach
  (`ipc/pty.ts:3609,4824`) while `prepareClaudeAuth` ran for *today's* selection —
  relabelling a surviving session would license materializing over a live store.
- **Seeded-unconfirmed ids never clearing is now load-bearing.** They release only via
  daemon reconciliation (`daemon-init.ts:771`), which deliberately keeps seeds on a
  listing failure. Today that merely delays a refresh; promoting the same predicate to
  a rotation gate would make shared-lane rotation impossible for the whole process
  lifetime after one failed listing. The saga must treat "unconfirmed" as blocking but
  **surface it** rather than hang silently.
- **Drain scope splits by purpose:** health may drain per account; *credential
  mutation drains per StoreKey* (§3a). v3's "per-account drain replacing the global
  hook" is also inert as written — `hasLiveClaudePtys()` and
  `managedRefreshDeferredByLivePtyAccountId` remain global, and the single production
  consumer early-returns unless the globally-derived flag is set, so a per-account
  event would fire into a no-op.

▸ **macOS is not the WSL template.** The WSL lane works because auth is a file inside
`CLAUDE_CONFIG_DIR`; on darwin the CLI reads a keychain item scoped by
`sha256(configDir)`, so a per-account host lane still needs per-account keychain
staging plus read-back. Worse, `writeActiveClaudeKeychainCredentialsForRuntime` always
co-writes the **legacy unsuffixed item**, which is global across accounts.

▸▸ **The "or serialize under one global lock" alternative is not viable** — a pre-2.1
CLI reads and writes the legacy item for its whole lifetime, so releasing the lock
after materialization permits immediate cross-account corruption, and holding it for
the CLI's lifetime eliminates the concurrency the lane exists for. It also contradicts
the per-store mutex model. So the lane's contract is: **enforce a Claude CLI version
floor, checked before every per-account-lane launch, and stop co-writing the legacy
item for those lanes.** The floor is verified against real CLI behavior in R1a's
integration matrix, not inferred from in-tree comments. (§8.5's "no shared-store
materialization" phrasing is superseded by this paragraph.)

### 8.2c One auth mutation domain

▸ Single-use refresh tokens can double-rotate today: `fetchManagedAccountUsage`
refreshes and persists an inactive account's token *outside* `ClaudeRuntimeAuthService`'s
mutation queue, and `oauth-refresh.ts` has no single-flight — so a health probe racing
a saga's target-prepare on the same account fires two refreshes with one token and
manufactures `invalid_grant`, i.e. the saga's own "target not authorized" failure.

▸▸ **`(provider, accountId)` is the wrong key** (v3's proposal). It cannot name
`system-default` or a StoreKey, and it breaks the very unification it intends: a
single `doSyncForCurrentSelection` already spans **two** accounts (previous-account
read-back plus incoming activation) and mutates process-wide single-slot CAS state
that only today's one global queue protects — so an accountId-keyed lock needs two
acquisitions with no stated order, i.e. a deadlock. The domain is a **multi-key
coordinator** that atomically acquires the full `{source RouteKey, target RouteKey,
StoreKey(s)}` set in one canonical order, covering add / reauth / remove / select,
probes, saga phases, materialization, and account deletion. Single-flight on refresh
(keyed by a token *hash*, never the bearer) plus CAS persistence is a backstop, not a
substitute — and no internal queue serializes an **external** live CLI refreshing the
same credential, which is why store liveness and CAS remain mandatory.

### 8.3 `RotationService` — a durable saga

Per provider, persisted in `rotation_sagas` with fencing tokens and phases:

`planned → source-quiesced → session-captured → target-prepared → target-spawned →
resume-verified → committed`, with `needs-human` as the terminal failure state.
Startup reconciliation rolls forward, restores source authority, or marks
`needs-human`; an ambiguous spawn or submit is never blindly retried. The failure
inventory from review is the test plan: crash between any two phases, account
deleted/re-logged mid-saga, two tasks racing the same nearly-exhausted successor
(reservations close this — see below), quota death mid-tool-call, transcript appended
while captured, target account not authorized to resume, CLI version skew, and
▸ **WSL distro unavailable**: today the win32 ownership check is a synchronous
`wsl.exe` exec with a 5 s timeout whose catch returns null, and null ownership
*clears the active account selection and restores system default*
(`runtime-auth-service.ts:1171,297`). A distro asleep or cold-booting during
target-prepare therefore silently deselects the target — a mis-route, not a
`needs-human` — while blocking the main-process event loop.

▸▸ **Terminal `needs-human` is too coarse, though** (v3's fix). Ownership returns a
typed result — `owned` | `definitively-not-owned` | `unavailable/transient` |
`invalid` — and only the definitive failures are terminal; transient unavailability
retries under a bounded saga budget and **never clears the selection**, so a cold
distro boot stays a delay instead of becoming a terminal failure. The probe must be
async, and `getOwnedManagedAuthPath` is synchronous and widely called today, so that
conversion is designed through its callers rather than swapped in place.

▸ **Reservations need a home** (v2 named them with no storage): they are a phase
artifact of the saga, so they live on `rotation_sagas` — with the atomicity mechanics
§4 now specifies. ▸▸ Columns plus expiry alone do **not** stop two live processes from
claiming one successor; until the transactional claim, fence, renewal, and pre-routing
reconciliation exist, saying "reservations close this race" overstates the design.

**Wind-down is specified,** not vibes: prefer quiesce-at-idle (await agent-idle with a
deadline); past deadline, interrupt is a *policy decision* recorded in the audit
ledger; the saga captures the provider session id + transcript reference before any
teardown.

▸ **Cross-account resume must be proven per provider before the saga relies on it.**
Codex deliberately refuses resuming a session from a different home
(`src/main/codex/codex-session-resume-home.ts:79`), and per-account `CLAUDE_CONFIG_DIR` forks
`~/.claude` session history, so `claude --resume <sid>` under account B against
account A's transcript is unverified. R1 therefore ships in two stages:
**R1a — rotation-at-boundary**: new launches route to the healthy account; a limited
live session finishes as a *handoff* — a structured checkpoint (task state, files
touched, next step — the worker itself is asked to produce it while still functional
when possible) seeds a fresh conversation on the target account.
**R1b — live resume** where a per-provider proof exists (transcript portability +
provider-side authorization verified by an integration test); providers without proof
stay on R1a. The continuity promise is honest either way: seconds-to-minutes gap, no
lost *work*; R1b additionally preserves the conversation.

▸▸ **R1a's "guaranteed" carries a StoreKey qualifier** (§8.2a): "the source finishes
as a handoff while new launches route onward" is true only when source and target
StoreKeys are disjoint. On a shared store the source must be **gone before** the
target is materialized, and unattended shared-store rotation is out of scope for v1 —
so the overlapping case is drain-then-rotate, or a human-confirmed action.

### 8.4 Cross-provider handoff

Always a handoff (different model, different conversation): explicit checkpoint, new
session, stated in the mission dialog when enabled. Never silent.

### 8.5 Credential-safety repairs (R1 prerequisites)

- ▸ The inactive-usage preview flow on macOS temporarily writes then deletes the
  *scoped active* keychain item (`claude-fetcher.ts:1181`) — once "inactive" accounts
  can own live PTYs, that can clobber a live account's rotated credentials. Fix: the
  §3a StoreKey lock, taken by that flow too, before R1 enables concurrent accounts.
  ▸▸ Note this probe path spawns hidden PTYs that never enter the live gate at all
  (§8.2a), so the lock — not the gate — is what protects it.
- Claude host per-account `CLAUDE_CONFIG_DIR` lane (the WSL branch of
  `prepareForClaudeLaunch` is the shape; envPatch + `stripAuthEnv`), **plus** the
  darwin keychain contract and CLI version floor of §8.2b — which supersedes the
  "no shared-store materialization" phrasing. Existing installs keep the shared lane
  until opted in; the session-history fork is disclosed at opt-in. Statusline
  attribution binds via RouteKey (§8.2), not the posted config dir.
- `accountId` (tagged identity) through `prepareForClaudeLaunch` /
  `getSelectedCodexHomePath`, `SleepingAgentLaunchConfig`, and `TerminalCreateParams` —
  additive, resume-surviving.
- SSH: **managed rotation is unsupported in v1** (account targets are host/WSL only;
  SSH spawns deliberately skip local credential injection). Stated in the matrix.

## 9. The shell (R3)

Recomposition per app-modes §8. **Scope statement:** R3 *subsumes* roadmap Phase 2 —
it delivers the Phase-2 surface list (mode-gated shell, gate queue, run health,
MissionStrip, FleetBoard, TaskDetail, claim reconciliation, MissionDiffOverlay,
MissionLog, escalation plumbing) *plus* the extensions below, and the roadmap's Phase 2
entry should be marked superseded by this section when R3 starts. R3 depends on
roadmap Phase 1 (mode selector) only.

- **FleetBoard** rows: CLI + account (tagged identity → provenance string) + model
  (appliedSessionOptions) + launch-posture badge + who-is-driving presence.
- **BurnMeter**: per-account bars per provider, active/cooling/exhausted/unknown,
  reset countdowns, rotation ticks; "account-wide, not per-mission" stays.
- **ExceptionsQueue** lanes: `rotation-performed` (ack), `chain-exhausted` (blocking,
  names earliest reset), `manager-escalation`, `needs-human` sagas,
  `draft-contaminated` interjections.
- **OrchestratorPane**: the manager's real pane via the pane portal; `[Take over]`
  suspends the pane's grant and bumps the manager generation.
- **New Mission dialog**: worker chain, launch posture, `gateResolutionPolicy` with
  its category allowlist, R1a-vs-R1b continuity mode per provider.

## 10. Support matrix (v1 of the feature)

| Capability | local | WSL | SSH | remote-runtime | Windows-native |
| --- | --- | --- | --- | --- | --- |
| read / await / facts | ✅ | ✅ | ✅ | runtime-side | ✅ |
| verified submit | per-agent¹ | per-agent¹ | per-agent¹ (`unknown` on relay loss) | runtime-side or `unsupported` | per-agent¹ (ConPTY paste mode; own verification tests) |
| account routing — disjoint StoreKeys | ✅ | ✅ | ❌ (v1) | ❌ | ✅ |
| account routing — shared store | drain-then-rotate or human-confirmed² | n/a (isolated) | ❌ | ❌ | drain-then-rotate² |
| live-resume rotation (R1b) | per-provider proof | per-provider proof | ❌ | ❌ | per-provider proof |
| manager seat | certified backends³ | certified backends³ | workers only | ❌ | certified backends³ |

¹ Per the measured table in §5.2a: claude, codex, cursor, droid and grok certify via
the input lease (five of those rows still provisional on a live probe — only claude and
codex were installed when the spike ran); opencode certifies via its
`promptInteractionKey`; gemini reports `'unknown'` only. Attribution comes from the
exclusive lease, not the payload — no agent except opencode/mimo-code/command-code
carries a per-turn key.
² Unattended shared-store rotation is out of scope for v1: Orca cannot prove such a
store is drained (§8.2a).
³ Not "any of the ~34 catalog agents" — the allowlist is whatever passes the §6.5
capability probe, seeded with claude and codex.

## 11. Repairs and document reconciliation

Verified-at-HEAD defects, fixed in R0 regardless of the rest:

| Defect | Evidence |
| --- | --- |
| CLI `orchestration ask` drops `--task` — the one path the preamble teaches workers cannot open a gate (RPC + spec accept it; commit `2ebbe5f8f` updated only those) | `src/cli/handlers/orchestration.ts:612-648` |
| `orca orchestration run-log` spec has no handler; `registry-parity.test.ts` is red at HEAD | `src/cli/specs/orchestration.ts:139` |
| Restart strands tasks in `dispatched` (only `coordinator_runs` rows are failed) | `stranded-coordinator-runs.ts` |
| Dispatch races agent startup (`waitForTerminal` declared, never called) | `coordinator.ts` |
| Coordinator can dispatch into the human's shells | `Coordinator.getAvailableTerminals` (fix: §6.6 ownership marker, R0) |
| Gate resolution races + redispatch-while-resumed | §6.2 (R0/R1 schema + CAS) |

**Document reconciliation (do in R0):** app-modes §8.1 still describes pre-`2ebbe5f8f`
breakage as current; the roadmap declares the foundation "landed and green" at a commit
where the parity test was red; this design's repairs are the *unfinished CLI tail* of
that same Phase 0, not new findings. One pass updates §8.1's status, the roadmap's
premise, and cross-links here — so the three documents agree at HEAD. The roadmap's
Phase-2 entry gains a pointer that R3 (§9) supersedes it.

## 12. Build order

**R0 — Ownership, senses, hands, repairs.** *Landed already:* the §11 repair table.
*Remaining:* the §3a identity types as real shared types; schema v9 (§4, incl. the run
adoption story, the `waiting_gate` rebuild + downgrade fence, and reservation
atomicity) + audit ledger; doc reconciliation; continuous provider-session capture
(local + SSH envelope); **the main-owned event bus + bounded per-PTY journal** (§5.3 —
the load-bearing item: no facts exist headlessly today) and the `provider-limit` fact
on it; input coordinator + `submitAgentPrompt` + `await` with `{runtimeId,
ptyIncarnationId, eventSeq}` cursors + CLI faces, behind the experimental flag; the
grant check *and its R0 issuer* (§6.6). ~~First task: measure the submit-evidence
ladder per agent.~~ **Done — §5.2a.** It changed three things: attribution comes from
the input lease rather than the payload (no per-turn key exists for five of seven
agents), the sensing item is publication not production (so smaller), and the
closed-tab hook drop (`server.ts:1823`) must be made detectable. Remaining spike work:
a live probe of cursor/droid/grok/opencode/gemini, whose rows rest on Orca-authored
fixtures rather than observed vendor behavior. *Done when:* an agent
in one terminal drives a verified turn against a sibling TUI agent via the CLI alone —
local and SSH — with honest `submitted` evidence (`yes` only where certified,
`unknown` otherwise); kill-tests at each submit phase produce truthful phase results;
an await across N panes loses no transition across a return/re-arm cycle.

**R1 — Router.** The **RateLimitService per-RouteKey refactor** (§8.2 — per-source
observations, per-route backoff, probe floor; Codex too, not Claude-only); the
multi-key auth coordinator (§8.2c); PtyBinding persistence + store-scoped drain
(§8.2b); R1a rotation-at-boundary end to end (health service, transactional
reservations, saga, handoff checkpoints, ledger, BurnMeter feed); credential-safety
repairs (§8.5); Claude per-account lane behind opt-in with the darwin keychain
contract + CLI version floor. R1b live-resume for any provider whose proof lands.
*Done when:* **two Claude accounts on disjoint StoreKeys** run concurrently (the
shared-store case is drain-then-rotate, or human-confirmed, by §8.2a); exhausting one
(fixture) routes new work and hands off a live session with no lost work; a crash
injected at every saga phase reconciles to forward/restore/needs-human, never a
stranded task or duplicate agent; two sagas racing one successor produce exactly one
winner; an empty chain pauses the mission loudly.

**R2 — Manager.** Event bus + GatePolicyService (CAS, `waiting_gate`, outbox) +
gateResolutionPolicy; ManagerSupervisor (lease, generation fencing, heartbeat, restart
budget); `manager` skill + certified backends; full grants + presence; manager-aware
preamble variant (snapshot reviewed). *Done when:* a scripted overnight mission with a
stalling worker, a TUI question, and an account exhaustion shows the manager nudging,
answering, and executing a rotation — every action attributed in the ledger, a forced
manager crash mid-gate produces exactly one resolution (fencing proven), and a
duplicate-manager start is refused.

**R3 — Shell.** §9, after roadmap Phase 1. *Done when:* the (superseded) Phase-2
criterion passes with chains, manager actions, and takeover legible in the UI.

## 13. Open decisions (owner)

1. **Claude per-account config dirs** — opt-in disclosure UX for the session-history
   fork; recommendation: new accounts per-account, existing shared until opted in.
2. **Gate category taxonomy** — the fixed fail-closed set (§6.3) plus what a run may
   add; recommendation: ship the fixed set, allowlist extends only the delegable side.
3. **Audit preview retention** — operator-visible previews of submitted text on/off by
   default; recommendation: on for manager actions, off for anything matching secret
   patterns, per-run override.
4. **Manager cardinality** — recommendation: one fleet manager singleton, distinct
   from per-mission orchestrator agents (app-modes §8.2's distinction), revisit
   per-mission managers only with evidence.
5. **Experimental-flag graduation** — orchestration becomes load-bearing;
   recommendation: graduate to a real setting in R1.
6. **Non-managed providers** (gemini/kimi/grok/minimax are single-account today) —
   recommendation: chains cover claude+codex; a generic env-home account abstraction
   is a later design.
7. **Claude CLI version floor for the per-account darwin lane** (§8.2b) — concurrent
   lanes require dropping the legacy-keychain co-write, which pre-2.1 CLIs depend on.
   Recommendation: set the floor, enforce it before every lane launch, and refuse the
   lane below it rather than silently sharing one credential slot.
8. **Shared-store rotation posture** (§8.2a) — v1 makes it human-confirmed because
   Orca cannot prove such a store is drained (a `claude` typed into any shell, or run
   outside Orca, is invisible). Recommendation: keep it confirmed-only, and treat
   "prove the drain" as its own project rather than a rung of this one.

## 14. Explicitly deferred, on purpose

- Linking aterm-gui's control socket into Orca; MCP exposure of any surface.
- Cross-host fleet fabric; driving native aterm fleets (documented `aterm-ctl`
  extension).
- Same-UID containment of hostile local processes (OS sandbox problem; grants are
  scoping + audit, stated honestly).
- Spend caps; per-mission cost attribution.
- AI task decomposition (`Coordinator.decompose()` still requires pre-created tasks;
  manager judgment does not depend on it).
- Camouflage of automation, permanently: detection-resistance is explicitly a
  non-goal.
