# Runtime divergences: judgment on #9156 / #9163 / #9169 / #9193

Scope: the four shared-runtime issues where upstream reporters ask for behavior the fork's
runtime layer does not implement. All four verdicts in `terminal-audit-verdicts.json` are
`still-applies` (high confidence). This doc judges, per issue: what upstream asked, what the
fork actually does (with the load-bearing seams), whether the current behavior is a deliberate
design worth keeping (per git log/blame), and an adopt/adapt/decline recommendation with an
implementable design.

All four seams are inherited upstream code (upstream PR-numbered commits: `fd6805a29` #8227,
`f5efdd594` #4901, `319ae4e9e` #8958, `91ece6ca7` #9114, `52388c1ab` #8473, `b67106805`
#9166). No fork commit has touched any of them (`git log -- src/main/runtime/orca-runtime.ts`
shows only lane-integration ports, none targeting these paths). The judgment is therefore
about whether the *inherited* design is right, and where the fork's architecture (Rust daemon,
aterm reply drain, Rust orchestration store) changes the correct fix.

**aterm engine surface: none.** None of the four needs a `rust/aterm` change (rationale in
#9156, the only candidate). #9163 does need a fork-Rust change in
`rust/crates/orca-runtime/src/orchestration_schema.rs` (orchestration DB schema) — that is
store code, not engine code, but it follows the fork's Rust conventions (napi wrapper +
`orca-parity` harness + node:sqlite twin migration, as in `88a3d58cc`).

Summary table:

| Issue | Upstream ask | Fork today | Verdict | Effort |
| --- | --- | --- | --- | --- |
| #9156 | Reply-authority election must cover desktop viewers, not just mobile | Every aterm pane auto-answers; only the mobile lock suppresses | **Adopt invariant, adapt mechanism** (fork fixes it *better* than upstream can) | M |
| #9163 | Stable handle, or delivery follows handle changes, or create==list | Epoch-scoped handles (deliberate); addressing by frozen handle (bug) | **Decline ask #1, adopt #2 + #3** | L |
| #9169 | `send` must fail into dead PTYs; `show`/`read` must agree | Cached `connected`/`writable` flags; two liveness derivations | **Adopt**, implemented on the daemon's `isAlive` (fork-only lever) | M |
| #9193 | `close --tab` and pane close must share one liveness model | `--tab` throws `terminal_tab_not_found` where pane close kills | **Adopt** (converge to kill) | S |

---

## #9156 — reply-authority election is mobile-only; paired desktop viewers duplicate query replies

### What upstream asked

When a host desktop and a paired desktop/web viewer render the same PTY, both auto-answer
embedded terminal queries (CPR `ESC[6n`, OSC 10/11, DA1). The contract invariant ("exactly one
party may answer any query") should hold for desktop viewers the way #8227 made it hold for
mobile. The reporter explicitly rules out filtering `isTerminalQueryReply` out of the viewer's
input stream (modified-F3 `CSI 1;<mod> R` is byte-identical to CPR) and says suppression must
happen "at the parser".

### What the fork does

The three mobile-only guards survive verbatim, and the aterm cutover *widened* the reply
surface — every viewing pane's engine is now an authoritative auto-responder:

- Server gate: `src/main/runtime/rpc/methods/terminal.ts:1201-1213` accepts
  `inputKind: 'query-reply'` only from `params.client?.type === 'mobile'`; the only election
  is `isMobileTerminalQueryReplyAuthority` (`src/main/runtime/orca-runtime.ts:7441-7464`,
  earliest phone-fitted subscriber wins, and only while `getDriver(ptyId).kind === 'mobile'`).
- Renderer gate: `canSendDesktopQueryReply` (`src/renderer/src/components/terminal-pane/`
  `pty-connection.ts:3758-3761`) suppresses only while `isPtyLocked(ptyId)`
  (`src/renderer/src/lib/pane-manager/mobile-driver-state.ts:66-68` — mobile driver only).
- Reply source: the engine queues replies in `response_buffer`
  (`rust/aterm/crates/aterm-core/src/terminal/buffer_api.rs:200-206`); each pane's process
  pump drains them (`src/renderer/src/lib/pane-manager/aterm/aterm-process-pump.ts:61` →
  `aterm-reply-drain.ts:15-32`) into the pane's input sink, which forwards any
  `isTerminalQueryReply(data)` via `sendDesktopQueryReplyImmediate`
  (`pty-connection.ts:3992-3995`). A remote viewer's forward rides the multiplexed stream
  (`remote-runtime-pty-transport.ts:994` `sendInputImmediate`) as ordinary input — the server
  never even sees it as a query reply, so the `terminal.ts:1208` gate cannot help.
- The hidden-host case is already single-answerer (`src/main/runtime/`
  `terminal-model-query-authority.ts:37-47` yields when `hasRemoteViewSubscriber`); only the
  host-pane-**visible** + viewer-attached topology duplicates — the normal watching-a-host
  case.

### Is the fork right?

No — but it is not a fork regression either; the hole is upstream's (#8227 fixed mobile only,
#8252 deliberately left desktop-viewer *input* ungated, which is correct for input and wrong
for auto-replies). What IS fork-specific: the fix is **cleaner here than upstream**, because
aterm's replies arrive on a dedicated channel (`take_response()` drain) instead of mixed into
xterm's `onData` keystroke stream. The reporter's F3-ambiguity objection ("suppression has to
happen at the parser") does not apply to the drain path: bytes coming out of
`drainAtermReplies` are engine-generated replies by construction, never keystrokes, so
gate-at-the-drain is exact.

**Why no aterm engine change:** the engine is a single-terminal model behaving per spec (a
terminal answers queries). Multi-viewer arbitration is app-runtime domain, exactly where the
mobile election already lives. Drain-and-discard on non-authoritative panes keeps engine state
(DECRQM, kitty flags, colors) bit-identical across host and viewer — an engine-side "don't
generate replies" flag would be a second mode to prove equivalent for zero benefit, and
discarding after drain also keeps `response_buffer` bounded (its unbounded-growth guard:
`handler_dec.rs:259`). Decline the engine route deliberately.

### Recommendation: **adopt the invariant, adapt the mechanism** (effort M, no engine work)

1. **Server-side general election.** Add to `orca-runtime.ts` (next to
   `isMobileTerminalQueryReplyAuthority:7441`):

   ```ts
   type TerminalQueryReplyAuthority =
     | { kind: 'mobile'; clientId: string }        // existing election, unchanged precedence
     | { kind: 'host-renderer' }                    // visible host pane
     | { kind: 'remote-viewer'; clientId: string }  // earliest remote desktop/web subscriber
     | { kind: 'model' }                            // hidden-pane daemon/model responder
   getTerminalQueryReplyAuthority(ptyId: string): TerminalQueryReplyAuthority
   ```

   Precedence: mobile election (when `getDriver(ptyId).kind === 'mobile'`) → visible host
   renderer (derive "visible" from the existing hidden-mark state that
   `shouldDropHiddenRendererPtyData` reads, `src/main/ipc/pty-hidden-delivery-gate.ts:82-91`)
   → earliest remote viewer (`remoteTerminalViewSubscriberCounts` /
   `hasRemoteTerminalViewSubscriber`, `orca-runtime.ts:7434-7439`) → model
   (`shouldModelAnswerHiddenPtyQueries`, unchanged). Headless-serve stays correct: with no
   host renderer, the remote viewer is elected (preserves
   `src/renderer/src/runtime/web-runtime-session.ts:37` semantics).
2. **Push authority to renderers.** New notifier event
   `terminalQueryReplyAuthorityChanged(ptyId, { kind, clientId | null })`, emitted from the
   same places that already call `notifyRemoteTerminalViewPresenceChanged`
   (`orca-runtime.ts:7430`) and `setDriver` (`orca-runtime.ts:9558`). Renderer keeps it in a
   new `src/renderer/src/lib/pane-manager/query-reply-authority-state.ts` (mirror of
   `mobile-driver-state.ts` — do NOT name it `-utils`/`-helpers`). Each client knows its own
   runtime client id; a pane is authoritative iff the event names it (host panes match
   `kind === 'host-renderer'`, remote viewer panes match their clientId).
3. **One renderer choke point.** Extend `canSendDesktopQueryReply` (`pty-connection.ts:3758`)
   to `!isPtyLocked(ptyId) && isQueryReplyAuthorityForThisView(ptyId)`. That single predicate
   already gates: the aterm drain forward (3992-3995), capability handlers (wired 3798-3820),
   the pixel-size responder (3821-3832), the mode-2031 fact (3773-3789), and restore-salvage
   replies. **One stray path**: the OSC color responder is constructed with a raw
   `(data) => transport.sendInput(data)` at `pty-connection.ts:3838` — route it through
   `sendDesktopQueryReplyImmediate` in the same change or the duplicate survives for OSC
   10/11, the worst leak class in the report.
4. **Fail-safe default.** Before the first authority event arrives, a pane treats itself as
   authoritative iff it is the host (non-remote transport). Never leave zero answerers: on
   authority-holder disconnect, re-elect immediately (subscriber release at
   `orca-runtime.ts:7420-7431` already fires presence change).

Named tests:
- `src/main/runtime/orca-runtime.test.ts`: "elects mobile over visible host", "elects visible
  host over remote viewer", "elects remote viewer when host pane is hidden", "elects remote
  viewer on headless serve", "re-elects on viewer release".
- `src/renderer/src/components/terminal-pane/pty-connection.test.ts` (beside the existing
  mobile-lock capability test at :4896): "drained aterm reply is discarded when this view is
  not reply authority", "OSC color responder honors the authority gate".
- `src/main/runtime/terminal-model-query-authority.test.ts`: unchanged behavior pinned
  (hidden + viewer stays single-answerer).

Upstream-reportable: the election design (steps 1-2) is portable; step 3's exactness is
fork-only (upstream still has the F3 ambiguity in `onData`).

---

## #9163 — epoch-scoped handle identity breaks orchestration addressing

### What upstream asked

Any one of: (1) a stable per-session id for `orchestration` addressing and `terminal send`;
(2) delivery follows handle changes (message addressed to a session reaches its *current*
handle); (3) `terminal create` and `terminal list` return the same canonical handle.

### What the fork does

Two handle namespaces with deliberate, documented lifetimes:

- **Leaf-keyed handles are epoch-scoped fail-fast identity.** `issueHandle`
  (`orca-runtime.ts:23670-23701`) reuses a handle only when
  `existingRecord.rendererGraphEpoch === this.rendererGraphEpoch`; `markRendererReloading`
  (:20953-20970) and `markGraphUnavailable` (:20981-21000) bump the epoch and clear
  `handles`/`handleByLeafKey`. In-code rationale (:20960): *"a renderer reload tears down the
  live graph, so live handles must go stale immediately, not be reused against the rebuild."*
- **ptyId-keyed handles deliberately survive.** `handleByPtyId` persists across reloads
  (:20967 *"pre-allocated CLI handles survive reloads so CLI agents keep control"*; :23803
  *"ORCA_TERMINAL_HANDLE is an agent identity"*), re-linked via `adoptPreAllocatedHandle`
  (:23703-23724) and restart-recovered via `adoptControllerTerminalHandle` (:6168-6206,
  first-wins by design, rationale :6181-6185).
- **The create/list split (Repro A)** is a precedence bug between the namespaces:
  `issueHandle` consults `handleByLeafKey` *before* `adoptPreAllocatedHandle`, and the
  graph-sync first-PTY bind `adoptFirstPtyForLeafHandle` (:23786-23798, called at
  :3521-3529) attaches the PTY to a leaf-minted handle **without ever checking
  `handleByPtyId`**. Once a leaf handle exists (issued while `ptyId` was still null — the
  reveal path `createTerminal` → `terminal:requestTabCreate` → `waitForTerminalHandle`
  (:19633) makes this window routine), the pre-allocated create handle survives as a second,
  pty-backed alias (`getLivePtyForHandle:23607-23636` resolves it) — one PTY, two live ids,
  exactly the report.
- **The addressing consequence**: `orchestration.send`
  (`src/main/runtime/rpc/methods/orchestration.ts:196-233`) addresses purely by the frozen
  `params.to` handle; `deliverPendingMessagesForHandle` (`orca-runtime.ts:23472-23481`)
  swallows `terminal_handle_stale` and leaves the message inbox-only, silently.

### Is the fork right?

**On epoch-scoping: yes.** The fail-fast design prevents a worse class of bug — a cached
handle silently resolving against a rebuilt graph and writing into the wrong PTY (the exact
hazard the `ptyGeneration` checks in `getLiveLeafForHandle:23600-23603` also guard). Upstream
itself already concluded handles are ephemeral: #8473 (`52388c1ab`) made the **pane key** the
"remint-stable" identity for dispatch/worker_done, and the fork extended that into the Rust
store (`88a3d58cc`: `messages.sender_pane_key`, `dispatch_contexts.assignee_pane_key`,
per-pane dispatch dedupe). Upstream ask #1 (a handle that never changes) would reintroduce
the stale-graph hazard and contradict upstream's own #8473 direction — **decline it**.

**On the consequences: no.** Silent non-delivery (the ~2h orchestration stall) and the
create/list split are bugs on top of a sound identity model. **Adopt asks #2 and #3.**

### Recommendation: **decline ask 1; adopt asks 2 + 3** (effort L; Rust store change, no aterm work)

**(a) Delivery follows identity (ask 2).**
- Schema: orchestration DB v6→v7 — add `messages.recipient_pane_key TEXT NULL`. Both twins:
  `rust/crates/orca-runtime/src/orchestration_schema.rs` (ALTER-guarded ladder, :166-228) and
  the TS node:sqlite twin, plus the napi wrapper and `orca-parity` harness rows (follow
  `88a3d58cc` exactly).
- On `orchestration.send` (`orchestration.ts:196-233`): resolve
  `runtime.getTerminalPaneKey(params.to)` (exists, `orca-runtime.ts:11625-11627`, documented
  best-effort) and persist it alongside the handle.
- On delivery: `deliverPendingMessagesForHandle` grows a fallback — when
  `getLiveLeafForHandle(handle)` throws stale AND the message row carries
  `recipient_pane_key`, re-resolve `runtime.getTerminalHandleForPaneKey(paneKey)`
  (exists, used at :11632/:20691/:23126) and deliver to the current handle; same re-resolution
  in `notifyMessageArrived` waiter lookup so `check --wait` under a reminted handle wakes.
  Keep the existing silent-skip only when the pane itself is gone.
- Protocol shape: `RuntimeOrchestrationMessage` gains optional `recipientPaneKey: string`;
  the `[Reply: … --from …]` injection string is unchanged (the `--from` handle is already
  re-read live at injection time).

**(b) Canonical handle at mint time (ask 3).**
- In `adoptFirstPtyForLeafHandle` (:23786): before binding the PTY to the leaf-minted handle,
  check `this.handleByPtyId.get(ptyId)`; when a pre-allocated handle exists, retire the
  leaf-minted record (reject its waiters with `terminal_handle_stale` via
  `invalidateLeafHandle:23776`) and install the pre-allocated handle for the leafKey — the
  ptyId-keyed identity wins, matching the documented "agent identity" rule.
- In `issueHandle` (:23670): when the `handleByLeafKey` hit's record has
  `ptyId === leaf.ptyId` but `handleByPtyId.get(leaf.ptyId)` names a different handle, prefer
  the ptyId-keyed one (same retirement). This makes `create` and `list` converge for every
  ordering of graph sync vs first list call.
- Compatibility: the *retired* leaf handle must fail loud (`terminal_handle_stale`), not
  linger as an alias — two live ids is the reported bug.

Named tests:
- `orca-runtime.test.ts`: "create and list return one canonical handle when the leaf handle
  was minted before the PTY bound", "leaf-minted waiters are rejected stale when the
  pre-allocated handle takes over", "pane-key fallback delivers a pending message after a
  renderer reload remints the handle".
- Orchestration vitest suite (the 213-test suite named in `88a3d58cc`): "message addressed to
  a stale handle injects into the current handle of the same pane", "inbox-only fallback
  still applies when the pane is gone".
- `rust/crates/orca-runtime/tests/user_version_migrations.rs`: v6→v7 ladder row; parity
  harness: `send_message` persists + returns `recipient_pane_key`.

---

## #9169 — `send` returns ok into a pidless terminal; `show`/`read` disagree on liveness

### What upstream asked

Invariant 1: `send` must not return `ok:true` when the terminal has no live process.
Invariant 2: `show` and `read` must derive liveness from a single source of truth.

### What the fork does

- `sendTerminal` (`orca-runtime.ts:11716-11765`) gates on the **cached** `pty.connected`
  (:11732) or `leaf.writable` (:11749). `writable` is derived, never probed:
  `refreshWritableFlags` (:23770-23774) = graph ready + `leaf.connected` + `ptyId`.
  `connected` flips false only on the exit callback (:9531/:9541) or the controller list
  sweep (:22269-22274, only when the daemon no longer lists the session). A lost exit event =
  permanent `accepted: true` into the void.
- `readTerminal` → `readPtyTerminal` (:23652-23668) computes `status` from `pty.connected`;
  `showTerminal` (:11646-11682) builds from `buildPtyTerminalSummary` (:23565-23585) /
  `buildTerminalSummary` (:22401+) snapshots. Two derivations → the reported
  `show: null` / `read: "running"` split is structural.

### Is the fork right?

The invariants are obviously correct and nothing in the log defends the current behavior as a
design — it is inherited scaffolding. Two fork-specific facts shape the fix:

1. **The fork has a true-liveness oracle upstream lacks.** PTYs live in the Rust daemon on
   every platform; the registry reaps dead sessions (`rust/crates/orca-daemon/src/`
   `registry.rs:360` `reap_and_mark_exited`) and the adapter filters/reports `isAlive`
   (`src/main/daemon/daemon-pty-adapter.ts:871,914,928`) with pid/state per session (:924).
   The issue's hypothesized wedge (shell dead, wrapper still says running) is exactly what
   `isAlive` refutes.
2. **The opposite failure mode is a live bug class.** Upstream `b67106805` (#9166) just fixed
   an agent-send TOCTOU where an over-eager liveness check **rejected live agents during
   startup**. So the fix must fail-open on *absence of evidence* and fail-closed only on
   *positive death evidence* — no synchronous per-send pid probe.

### Recommendation: **adopt both invariants**, daemon-backed (effort M, no engine work)

1. **One liveness helper.** New `resolveTerminalLiveness(ptyId)` in `orca-runtime.ts`:

   ```ts
   type TerminalLiveness = {
     status: 'running' | 'exited' | 'unknown'
     pid: number | null
     exitCode: number | null
     source: 'daemon' | 'cache'
   }
   ```

   Implementation: consult the daemon adapter first — add
   `getSessionLiveness(ptyId): Promise<{ alive: boolean; pid: number | null }>` to
   `daemon-pty-adapter.ts` (cheap daemon RPC; memoize ~1-2s per ptyId; bounded by the
   existing `PTY_CONTROLLER_LIST_TIMEOUT_MS` pattern at :22238-22245). Timeout/unreachable →
   fall back to the cached `connected` flag with `source: 'cache'`, `status` at worst
   `'unknown'`.
2. **Invariant 1.** In `sendTerminal`, both branches: when liveness resolves
   `status === 'exited'` with `source: 'daemon'`, flip `pty.connected = false` /
   `leaf.connected = false` (reuse the exit path bookkeeping :9529-9547 so projections,
   waiters, and snapshots converge) and throw the existing `terminal_not_writable`. Never
   reject on `'unknown'` — that is the #9166 regression guard. Same check in
   `sendTerminalAgentPrompt` (:11767+), which shares `getLivePtyForHandle` gating.
3. **Invariant 2.** `showTerminal` and `readPtyTerminal` both take their
   `status`/`pid`/`exitCode` from `resolveTerminalLiveness` instead of their private
   derivations; `RuntimeTerminalShow` gains `pid: number | null` (today only
   `inspectTerminalProcess:13932` exposes process info). The two RPCs then agree
   definitionally, satisfying the invariant even if the wedge trigger is never pinned.

Named tests:
- `orca-runtime.test.ts`: "send into a daemon-reaped PTY throws terminal_not_writable and
  flips the record disconnected", "send proceeds when the daemon probe times out
  (source: cache)", "show and read report identical status for the same handle" (pty-backed
  and leaf-backed variants), "agent prompt send honors daemon liveness".
- `src/main/daemon/daemon-pty-adapter.test.ts`: "getSessionLiveness reports alive=false after
  child exit", "memoizes within the probe window".

Upstream-reportable: invariant 2's single-helper shape ports; invariant 1's daemon oracle is
fork-only (upstream would need its node-pty exit bookkeeping instead).

---

## #9193 — `close --tab` says not-found for live floating PTYs that pane close can kill

### What upstream asked

The tab-aware and pane-aware close paths must share one liveness model. For a live PTY with no
closeable tab, `close --tab` should either resolve and close the owning surface or return a
structured result saying the PTY is live and killable via the pane path — never
"nonexistent to one path, live/killable to the other".

### What the fork does

Verbatim divergence, `orca-runtime.ts`:
- `closeTerminal` (:20512-20531): pty-backed branch kills directly
  (`ptyController.kill` → `ptyKilled: true`).
- `closeTerminalTab` (:20533-20549): pty-backed branch throws `terminal_tab_not_found`
  (:20537-20538) when `pty.tabId` is null, else routes through `closeMobileSessionTab`
  (:5026+). CLI `--tab` maps via `terminal.closeTab`
  (`src/main/runtime/rpc/methods/terminal.ts:1479-1484`).
- How `tabId` goes null: restart adoption. `refreshPtyWorktreeRecordsFromController`
  (:22231-22277) re-adopts daemon-surviving sessions with `recordPtyWorktree(id, worktreeId,
  { connected: true })` (:22261-22265) — no tab binding. (Background `createTerminal` *does*
  set `pty.tabId` at :19509, so the population is specifically restart/cleanup-orphaned
  records — matching the reporter's seven post-restart blank floating handles.)

### Is the fork right?

No, and nothing defends it: upstream's own recent commits (`319ae4e9e` #8958 durable
whole-tab close, `91ece6ca7` #9114 headless teardown on whole-tab close) keep hardening this
path without reconciling the two liveness models. The fork has *extra* exposure: the daemon
survives app quit by design and `09e345a73` (binding-churn prune, per the #9585 verdict)
deliberately nulls stale tab bindings on runtime churn — i.e., the fork manufactures exactly
the live-PTY/no-tab records that `closeTerminalTab` refuses. An orchestrator retrying `--tab`
can never make progress; that is the worst option.

### Recommendation: **adopt — converge tabless `--tab` close onto the authoritative kill** (effort S, no engine work)

In `closeTerminalTab`'s pty-backed branch (:20535-20542), replace the throw: when
`pty.pty.tabId` is null, perform the `closeTerminal` kill (`ptyController.kill` +
`claudeAgentTeams.removeTeamForLeaderHandle`) and return a structured result instead of an
error:

```ts
// RuntimeTerminalClose gains:
closeMode?: 'tab' | 'pty'   // today only 'tab' exists (:20542)
{ handle, tabId: pty.record.tabId /* 'pty:<id>' */, closeMode: 'pty', ptyKilled: true }
```

Rationale for kill-over-error: the reporter's own incident resolution (pane close) and the
"retry must progress" requirement both point at convergence, and the issue explicitly allows
either resolution "or a structured result" — `closeMode: 'pty'` gives callers the audit trail
that no tab was closed. Keep the throw only when the handle resolves to nothing at all
(existing `getLivePtyForHandle` null → leaf path → genuine stale). Post-kill projection
cleanup needs no new code: the exit callback path (:9529-9547) plus
`pruneDisconnectedPtyRecords` (:22297) already remove the handle from terminal/worktree
projections — assert it in tests rather than adding a second cleanup.

CLI surface: `orca terminal close --tab --json` output gains `closeMode`; document that
`closeMode: 'pty'` means "no tab existed; PTY killed" so orchestrators can branch. GitLab/
provider-neutral: no provider coupling in this path.

Named tests (`orca-runtime.test.ts`):
- "closeTerminalTab kills a live pty-backed handle with no tab binding and reports
  closeMode 'pty'" (the issue's regression steps 1-3).
- "closeTerminal and closeTerminalTab agree for a restart-adopted tabless PTY" (step 3).
- "killed tabless handle disappears from listTerminals and worktree projections" (step 4).
- Existing durable-close behavior pinned unchanged when `tabId` is present (guard against
  regressing #8958/#9114).

---

## Rollup

- **Adopt**: #9169 (both invariants), #9193 (converge to kill).
- **Adopt-the-invariant / adapt-the-mechanism**: #9156 — the aterm drain channel makes the
  fork's fix exact where upstream's is blocked on CPR/F3 byte ambiguity.
- **Split**: #9163 — decline stable-forever handles (epoch fail-fast is right, and upstream's
  own #8473 pane-key direction agrees); adopt delivery-follows-identity and create/list
  canonicalization.
- **Engine work**: none in `rust/aterm` (deliberately declined for #9156 — arbitration is
  app-runtime domain; drain-and-discard keeps engine state identical across views). #9163
  touches fork Rust store code (`orca-runtime` crate orchestration schema v6→v7 + napi +
  parity harness), which follows the fork's Rust review conventions but is not engine
  surface.
- **Suggested order**: #9193 (S, unblocks orchestrator cleanup) → #9169 (M, daemon liveness
  helper) → #9156 (M, election + renderer gate) → #9163 (L, schema + adoption precedence).
  #9169's `resolveTerminalLiveness` lands first among the M/L items because #9163's delivery
  fallback and #9193's projection assertions both read cleaner on top of a single liveness
  source.

---

## Critic notes

Spot-checked 2026-07-22. This is the most precisely-cited design in the batch — every load-bearing seam verified at the exact line: mobile-only query-reply gate (rpc/methods/terminal.ts:1201-1213), `isMobileTerminalQueryReplyAuthority` (:7441), `hasRemoteTerminalViewSubscriber` (:7434), `canSendDesktopQueryReply` (pty-connection.ts:3758), the stray OSC color responder built on raw `transport.sendInput` (:3837 — the design's worst-leak call-out is real), `sendTerminal` (:11716), `closeTerminal` (:20512) vs `closeTerminalTab` (:20533) with the `terminal_tab_not_found` throw and the existing `closeMode: 'tab'` literal (so the #9193 type widening is additive exactly as claimed), `issueHandle` (:23670), `adoptFirstPtyForLeafHandle` (:23786), `getTerminalPaneKey` (:11625), daemon `reap_and_mark_exited` (registry.rs:360), adapter `isAlive` filtering (:871/:914/:928). Three notes:

1. **#9156 zero-answerer window on headless serve.** The fail-safe default ("authoritative iff host, until the first authority event") means a headless-serve remote viewer answers nothing between subscribe and the first `terminalQueryReplyAuthorityChanged` event — a TUI probing DA1/CPR at attach time can hang its startup. Close it by carrying the authority verdict in the subscribe ack (or emitting the event synchronously on subscribe), not only on change.
2. **#9163(b) retirement must clear `handleByLeafKey`.** The design routes waiter rejection through `invalidateLeafHandle` (:23776) — verify that path also removes the leafKey→handle mapping, otherwise the next `issueHandle` call re-mints the retired handle from the stale map entry and the two-alias state returns. The named test "create and list return one canonical handle…" should assert list stability across a *subsequent* `issueHandle` call, not just the first convergence.
3. **#9169 memo scope**: the 1-2s liveness memo must be invalidated by the exit callback path (:9529-9547) so a just-reaped PTY doesn't get a stale `alive=true` answer inside the window — cheap: exit bookkeeping deletes the memo entry. Worth a named test alongside "memoizes within the probe window".

Recommended order (#9193 → #9169 → #9156 → #9163) is sound and adopted by the BUILD-PLAN (split across two waves: S/M items first, election + schema after). Efforts credible. Engine-boundary reasoning (#9156 drain-gate exactness; decline engine-side arbitration) is correct and well-argued.
