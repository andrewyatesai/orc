# Remote Pane Parking — #8652 Design

Issue: SSH/remote PTY tabs are excluded from hidden-view parking, so SSH-heavy workflows
never reclaim renderer memory (`terminal-audit-verdicts.json` n=8652: **still-applies, high
confidence**). Paths relative to `/Users/ayates/orc`. Companion docs:
`upstream-triage/FEDERATED-SEARCH-DESIGN.md` (§2.2/§2.4 cited below),
`upstream-triage/ATERM-SCROLLBACK-SEARCH.md` (memory numbers).

Standing policy check: **no aterm engine surface changes are required** — every seam below is
orc TypeScript (renderer / main / relay / runtime RPC). The snapshot engines this design leans
on (aterm `HeadlessTerminal` in main, aterm wasm in the renderer) are used as-is. No
`ty_model!`/`spec_xref`/adversarial-review obligations attach.

---

## 1. Why the exclusion exists, and what has rotted

`isSnapshotBackedTerminalPty` (`src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts:56-68`)
refuses any `remote:`-prefixed id (`isRemoteRuntimePtyId`,
`src/renderer/src/runtime/runtime-terminal-inspection.ts:28-30`) and any `ssh:` id
(`parseAppSshPtyId`, `src/shared/ssh-pty-id.ts:23-44`). Its comment — "Remote runtime and SSH
PTYs have no local snapshot in this phase" — is **stale for both classes**:

- **`ssh:` PTY bytes transit local main** (`src/main/ssh/ssh-relay-session.ts:916-951` feeds
  `runtime.onPtyData`), and main lazily builds an aterm `HeadlessTerminal` model for *every*
  PTY it ingests (`src/main/runtime/orca-runtime.ts:7795-7813` `trackHeadlessTerminalData` →
  `getOrCreateHeadlessTerminal` :7879-7888; emulator = native aterm, 5 000-row scrollback,
  `src/main/daemon/headless-emulator.ts:41,116-121`). The snapshot IPC already serves it:
  `pty:getMainBufferSnapshot` (`src/main/ipc/pty.ts:3407-3466` →
  `serializeHiddenOutputRecoveryBuffer`, `src/main/runtime/orca-runtime.ts:7537-7565`), and the
  renderer restore predicate already accepts ssh ids:
  `canUseMainBufferSnapshot = !isRemoteRuntimePtyId(ptyId)`
  (`src/renderer/src/components/terminal-pane/pty-connection.ts:5723-5725`). Even the Phase-4
  hidden-delivery gate has an SSH implementation
  (`ssh-relay-session.ts:930-942`: drop + `pty:modelRestoreNeeded`). pty-connection itself
  documents the premise: "bytes transit local main, which implies snapshot-backed"
  (`pty-connection.ts:3527-3533`).
- **`remote:` PTYs have a combined wire snapshot** since port(#6106) (verdict n=6106
  addressed-by-port): host serializes history+frame with a `scrollbackChars` boundary and
  `alternateScreen` flag (`src/main/runtime/rpc/methods/terminal.ts:661-687`, budget
  `REQUESTED_SNAPSHOT_BYTE_BUDGET` = 2 MB at :42), the client splits it back into the local
  restorer shape
  (`src/renderer/src/components/terminal-pane/remote-runtime-pty-alt-screen-snapshot.ts:9-32`),
  and **every subscribe already replays a fresh snapshot into the pane**
  (`remote-runtime-pty-transport.ts:713-819`, snapshot replay at :739-750 with
  `{replayingBufferedData: true, suppressAttentionEvents: true}`). Re-hydration on reveal is
  literally the existing mount path.

Callers of the predicate (all four must see the change):
`terminal-hidden-view-parking.ts:106,136` (worktree/tab eligibility, driven from
`src/renderer/src/components/Terminal.tsx:871` and
`use-terminal-tab-cold-parking.ts:136`) and
`terminal-parked-tab-watchers.ts:105,127` (watcher-coverage guard + per-pane re-guard).

---

## 2. The two remote classes — authority map

| | `ssh:` (app-SSH provider) | `remote:` (remote runtime env) |
|---|---|---|
| id shape | `ssh:<conn>@@<relayPty>` (`ssh-pty-id.ts:23-44`) | `remote:[<env>@@]<handle>` — handle embedded in the id (`runtime-terminal-stream.ts:14-47`), survives unmount by construction |
| byte path | relay → local main → renderer `pty:data` | host runtime → renderer WebSocket multiplexer; never local main (`pty-connection.ts:5760`) |
| park snapshot authority | local main aterm model (5 000 rows), `pty:getMainBufferSnapshot` | host model over the wire: initial subscribe snapshot (`rpc/methods/terminal.ts:2247-2301`) / requested snapshot (:661-687) |
| side effects (bell/title/agent) | main authority facts (`terminal-side-effect-facts-handler.ts:44-62` — `runtimeEnvironmentId: null` ⇒ true; facts emitted by the runtime service for all ingested bytes, `src/main/index.ts:1877-1881`) | renderer byte parsing (authority false for non-null env) |
| exit signal while parked | `pty:exit` via `ssh-relay-session.ts:958-969` → `subscribeToPtyExit` works unchanged | no `pty:exit`; needs stream-end classification (`terminal.wait`, pattern `remote-runtime-pty-transport.ts:601-626`, #9151 rules) |
| host history while parked | main model keeps ingesting (already true today); relay keeps only a 100 KB reconnect tail (`src/relay/pty-handler.ts:149,972-1015`) | host model + host daemon logs keep ingesting; reveal snapshot reflects everything missed |

---

## 3. Design

### 3.1 Eligibility: classify instead of exclude

Replace the boolean interior of `isSnapshotBackedTerminalPty` with a class resolver (same
file, exported for the watcher layer):

```ts
export type TerminalParkSnapshotClass = 'daemon' | 'ssh-main-model' | 'remote-wire'

export function terminalPtyParkSnapshotClass(
  ptyId: string | null,
  worktreeId: string
): TerminalParkSnapshotClass | null {
  if (!ptyId) return null
  if (isRemoteRuntimePtyId(ptyId)) return 'remote-wire'
  if (parseAppSshPtyId(ptyId)) return 'ssh-main-model'
  // unchanged: separator-less daemon-fail-open ids and foreign-worktree
  // session ids stay unparkable (terminal-hidden-view-parking.ts:63-67)
  const separatorIdx = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  return separatorIdx !== -1 && ptyId.slice(0, separatorIdx) === worktreeId ? 'daemon' : null
}
```

`isSnapshotBackedTerminalPty(ptyId, worktreeId, opts?)` becomes
`terminalPtyParkSnapshotClass(...) !== null`, with the two new classes additionally gated by a
scoped kill switch `settings.terminalRemotePaneParking !== false` (new optional boolean in
`src/shared/types.ts` `GlobalSettings`, provider-generic name per AGENTS.md; same
default-on-with-persisted-kill-switch pattern as `terminalHiddenDeliveryGate`,
`terminal-hidden-delivery-gate.ts:29-40`). The existing global switch
`terminalHiddenViewParking` (`use-terminal-tab-cold-parking.ts:71-73`) still dominates.
Settings plumb through the existing `parkingEnabled` args — the predicate gains an
`opts: { remoteParkingEnabled: boolean }` parameter threaded from the four callers (§1) so the
pure module stays store-free like today.

Cold-activation ("view never mounted") keeps its **stronger** eligibility: the
`ParkedTerminalPtyEligibility` injection point (`terminal-parked-tab-watchers.ts:42,96`) is
passed a predicate that accepts only `'daemon'` in v1 — activation-deferred tabs
(`use-terminal-tab-cold-parking.ts:219-228`) stay local-only until phase 2 soak completes.

Hysteresis, hot-retain caps, and last-active exemption are untouched
(`terminal-hidden-view-parking.ts:13-19,139-192`): remote panes simply join the candidate
pool. Note honestly: with ≤ `TERMINAL_TAB_HOT_RETAIN_LIMIT` (12) hidden tabs the win arrives
after `TERMINAL_TAB_HOT_RETAIN_MS` (15 min), not at 30 s.

### 3.2 Phase 1 — `ssh:` parking (all infrastructure already live)

**Park:** the eligibility flip alone activates the existing machinery. The watcher starts in
fact-consumer mode (`parked-terminal-byte-watcher.ts:191-231` — it already passes
`runtimeEnvironmentId: null`, which is *correct* for ssh) and acquires the hidden-delivery
claim (:239-241); `ssh-relay-session.ts:930-942` then stops renderer byte delivery entirely
and latches `pty:modelRestoreNeeded`. Bell/title/agent-completion/PR-link parity comes from
main facts (already emitted for ssh bytes). `sendInput` via `window.api.pty.write`
(`terminal-parked-tab-watchers.ts:143`) already routes to the relay for ssh ids.

**Reveal:** must restore from the main model snapshot, **not** the relay's 100 KB attach
tail. Two sub-cases:

- Gate ON (default): reveal follows the existing model-restore flow — the watcher's claim
  release (`parked-terminal-byte-watcher.ts:262-263`) precedes pane handler registration, main
  emits the restore marker, and the pane restores via `serializeHiddenOutputSnapshot` →
  `getMainBufferSnapshot` (`pty-connection.ts:5737-5752`) at depth
  `resolveHiddenRestoreScrollbackRows(settings.terminalScrollbackRows)`
  (`terminal-hidden-restore-scrollback.ts:8-13`). No new code; needs a named test (§6).
- Gate OFF (kill switch): the reattach replay (`relay/pty-handler.ts:972-1015`, forwarded by
  `ssh-relay-session.ts:952-957` with dedupe :972-988) paints only the 100 KB tail. Add one
  reveal-time restore: when the mounting pane's prior state was "parked" and the pty class is
  `'ssh-main-model'`, schedule a hidden-output restore against `getMainBufferSnapshot` after
  connect, reusing the existing restore/replace routine and `replay-guard.ts` dedupe. This is
  the only new renderer logic in phase 1.

**Depth caveat (accepted):** main's emulator holds `DEFAULT_SCROLLBACK` = 5 000 rows
(`headless-emulator.ts:41`) regardless of a larger `terminalScrollbackRows`; a parked ssh pane
reveals at most 5 000 rows. Same class of trade the local path already accepts (daemon restore
5k cap / 512 KB sync replay, `src/shared/terminal-scrollback-limits.ts:1-5`). Optional
follow-up: plumb the setting into `createPtyHeadlessTerminalState` (`orca-runtime.ts:7818+`).

### 3.3 Phase 2 — `remote:` parking

**Park-time capture** is identity-only (`captureParkedTerminalPaneCandidates`,
`terminal-parked-watcher-registry.ts:29-35`) — no buffer capture needed for any class; the
host is the authority. Unchanged.

**Watcher byte source:** `subscribeToPtyData` (`pty-data-sidecar-subscriptions.ts:6-29`)
never sees remote bytes. Inject a source at watcher start
(`terminal-parked-tab-watchers.ts:111-194` decides per-pane class):

```ts
// startParkedTerminalByteWatcher gains:
subscribeBytes?: (ptyId: string, cb: (data: string) => void) => () => void   // default: subscribeToPtyData
sendInput: (data: string) => void   // remote: sendRuntimePtyInput(settings, ptyId, data)
runtimeEnvironmentId: string | null // remote: getRemoteRuntimePtyEnvironmentId(ptyId); today hardcoded null at :193
```

For `'remote-wire'` panes, `subscribeBytes` =
`subscribeToRuntimeTerminalData(settings, ptyId, parkedWatcherClientId, cb, { startAtLiveTail: true })`
(`runtime-terminal-stream.ts:56-129`) — `startAtLiveTail` already skips the historical
snapshot, so watcher start can never re-fire stale bells (exactly the semantics the outcome
observers rely on, :114-116). With `runtimeEnvironmentId` non-null the watcher takes
byte-parser mode (`isMainTerminalSideEffectAuthorityForPty` false), which is correct — remote
side effects are renderer-parsed today. The mode-2031 responder
(`parked-terminal-mode2031-responder.ts:32-50`) takes the same injected source; its reply goes
through the remote `sendInput`. The hidden-delivery claim (:239-241) is skipped for
`'remote-wire'` (main never gates what it never delivers).

Network cost is unchanged versus today's hidden-but-mounted pane: the same stream flows, it
just feeds a ~KB parser instead of a multi-MB engine.

**Exit while parked:** the watcher's stream `onEnd` must not be treated as exit (transport
churn is routine). Classify exactly like the live transport
(`remote-runtime-pty-transport.ts:601-626`): `terminal.wait {for:'exit', timeoutMs}`;
confirmed (`terminal_exited`/`terminal_gone`) → run the same teardown as the
`subscribeToPtyExit` callback (`terminal-parked-tab-watchers.ts:146-180`); unconfirmed →
resubscribe with backoff (pattern: `scheduleResubscribeAfterTransportClose`,
`remote-runtime-pty-transport.ts:693-711`). Full runtime-env disconnect while parked: watcher
idles; reveal lands in the pane's normal reconnect flow — identical UX to a hidden mounted
pane on a dead connection.

**Reveal:** the ordinary mount path. Fresh transport → `subscribeToHandle` → host sends the
initial `'scrollback'` snapshot → replay with attention suppression (:739-750). The handle is
embedded in the pty id, so no registry can go stale across park.

**Snapshot budget gap (must fix host-side):** the desktop initial subscribe snapshot is
**unbudgeted** — `serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile=false)` returns the
full `scrollbackAnsi + data` with `truncatedByByteBudget: false`
(`rpc/methods/terminal.ts:724-739`), and the client multiplexer hard-drops any snapshot over
`MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES` = 2 MiB
(`remote-runtime-terminal-multiplexer.ts:126,130-131` — benign today, but a parked
output-heavy agent pane would reveal *empty* until live bytes arrive, every time). Fix: bound
the desktop subscribe branch with the existing `boundScrollbackAnsi` under
`REQUESTED_SNAPSHOT_BYTE_BUDGET` (reuse :624-658; honest `truncatedByByteBudget`; line-boundary
cut). Protocol-compatible both directions — `SnapshotStart` already carries
`truncatedByByteBudget` (:693-712) and the client already parses it (multiplexer
`RemoteRuntimeSnapshotInfo:103-116`).

**Version-skew degrade (old host, new client):** on `REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE`
during a post-park reveal, the transport requests a budgeted snapshot via the *requested* path
(`stream.serializeBuffer({ scrollbackRows: resolveHiddenRestoreScrollbackRows(...) })` — that
path is already server-bounded, :661-687) and replays it through
`outputProcessor.processData(..., { replayingBufferedData: true, suppressAttentionEvents: true })`,
split through `splitRemoteAltScreenSnapshot` first (alt-screen restore correctness, #6106).
Old client + new host: strictly better (bounded snapshot instead of a dropped one).

### 3.4 Wire/data shapes — summary of changes

- **No protocol additions.** All shapes exist: `RemoteRuntimeSerializedBufferSnapshot`
  (`remote-runtime-terminal-multiplexer.ts:56-68`, incl. `alternateScreen` +
  `scrollbackChars` from #6106), `PtyBufferSnapshot`, `pty:getMainBufferSnapshot` reply
  (`ipc/pty.ts:3412-3424`).
- One host behavior change (desktop subscribe snapshot budget, §3.3) inside the existing
  `SnapshotStart/Chunk/End` frames.
- One settings field: `terminalRemotePaneParking?: boolean` (default on).
- Watcher options: `subscribeBytes` / `runtimeEnvironmentId` injection (renderer-internal).

### 3.5 Daemon history interplay

- **Local daemon:** owns neither class — no checkpoint/log exists locally for `ssh:`/`remote:`
  ids (`src/main/daemon/history-manager.ts` scope is daemon sessions). Parking changes nothing
  here; conversely nothing local persists remote history, which is why the park snapshot
  authority is main's model (ssh) / the host (remote), never the disk snapshot store
  (`src/main/terminal-scrollback-snapshots.ts:15-51` is keyed by tab/leaf for
  workspace-session restore, a separate lifecycle).
- **`ssh:`** — the main-side model is fed continuously whether parked or not (it exists today
  for mobile/web mirroring), so parking adds **zero marginal main-process memory** and the
  snapshot is always current at reveal. The relay's `REPLAY_BUFFER_MAX` = 100 KB tail
  (`relay/pty-handler.ts:149`) remains a reconnect aid only; the relay has no terminal model
  (`pty.serialize` is metadata-only, :1220-1246) and needs none.
- **`remote:`** — the host runtime's model and the host's own daemon persistence keep
  ingesting while the client pane is parked; the reveal snapshot reflects everything missed.
  Client-side shutdown captures skip parked panes today already (no renderer serializer while
  parked; main's fallback chain `serializeHiddenOutputRecoveryBuffer` → renderer → provider,
  `orca-runtime.ts:7553-7564`, is unaffected); app-restart restore of remote panes reattaches
  via the host regardless.

### 3.6 Memory win estimate

Fork-measured inputs (`ATERM-SCROLLBACK-SEARCH.md:13`, parking module comment
`terminal-hidden-view-parking.ts:6-12`): renderer engine ring is 640 B/line @ 80 cols,
1.6 KB/line @ 200 cols, content-independent; per-worktree renderer floor ~4-5 MB.

Per parked remote pane, reclaimed from the renderer + shared render worker:

| component | estimate |
|---|---|
| aterm wasm ring (5 000-row scrollback + grid) | 3.2 MB @ 80 cols → 8 MB @ 200 cols |
| pane canvas backing stores | 0–16 MB (full-window retina pane ≈ 2560×1600×4 B; splits proportionally less; browser may discard hidden backings — do not bank on it) |
| JS/DOM/link-provider/parser state | ~1 MB |
| **net per pane** | **~4–10 MB typical, more at wide cols/large panes** |

Retained while parked: watcher + fact consumer (KBs), transient reveal snapshot string
(≤ 2 MiB, freed after replay). So the issue's 5–10 hidden SSH terminals ≈ **40–100+ MB
reclaimed**, which is the right order for its observed 23 MB → 100–257 MB heap growth (the
issue's per-pane 10–20 MB figure is xterm math; the fork's engine is cheaper per §above, but
growth is still unbounded in pane count until this lands). Main-process and host cost: zero
marginal (models already exist).

### 3.7 Federated-search implication (FEDERATED-SEARCH-DESIGN.md alignment)

- **Parked remote panes stay searchable host-side.** §2.4 already executes `terminal.search`
  against the host model-query authority (`src/main/runtime/terminal-model-query-authority.ts`)
  — client-side parking is invisible to that path. Requirement carried into the federation
  controller: remote-pane discovery must enumerate **store** tab state (which knows parked
  tabs), not just live pane managers (`pane-manager-registry.ts:26-32` has no manager for a
  parked pane); results keep `source: 'remote'` with a parked badge, never routed to the §2.2
  local parked adapter (route by id class — `ssh:`/`remote:` ids have no local disk-snapshot
  entry).
- **`ssh:` parked panes are searched in local main's model** — the "host-side authority" for
  the ssh class *is* main's `HeadlessEmulator` (the relay has no model, §3.5). That is the
  same main-process E-5 route §2.2 uses for parked local panes, so parked ssh panes cost the
  daemon/parked adapter nothing new; depth = the model's 5 000 rows.
- **Anchor contract on navigation into a parked remote pane:** the `hostRowAnchor`/`anchorGen`
  the client last replayed died with the parked engine. On click: un-park → fresh subscribe
  snapshot arrives carrying a **new** anchor pair (§2.4 requires the snapshot reply itself to
  carry it) → remap `match.hostRow − hostRowAnchor + replay origin` against the fresh replay;
  if the match predates the fresh snapshot's first serialized row, degrade to §2.4's inline
  host-side context expansion — never a wrong-row jump, and strictly better than the local
  parked nearest-match contract (host-absolute rows survive the park; local absRows do not).
- **Dedup:** unchanged — sessionId-keyed merge (§1/§2.3) never applied to these ids;
  identity for remote results stays `paneRef.leafId` + host session handle.

---

## 4. Sequencing and risk

1. **Phase 1 (`ssh:`)** — predicate change + settings flag + gate-off reveal restore + tests.
   Everything else is already wired. Riskiest spot: reveal double-paint (relay tail + model
   snapshot) — covered by `replay-guard.ts` dedupe and a named test.
2. **Phase 2 (`remote:`)** — watcher byte-source injection, exit classification, host
   subscribe-snapshot budget, overflow fallback. Gate behind the same flag; ship after
   phase 1 soaks.
3. Cold-activation eligibility for remote classes: explicitly out (v1 keeps
   `ParkedTerminalPtyEligibility` local-only, §3.1).
4. Kill switches: `terminalHiddenViewParking` (global, exists) ∧
   `terminalRemotePaneParking` (new, scoped). Both default on.

## 5. Effort

- Phase 1: **S–M** (predicate + flag + one reveal restore path + tests).
- Phase 2: **M** (watcher generalization, exit classification, host budget fix, skew fallback).
- Overall: **L** including the federated-search controller notes (§3.7 lands with that
  project, not this one).
- Engine work: **none** (no aterm crate changes; no Trust-convention obligations).

## 6. Tests (named)

Renderer (vitest, existing files unless marked new):
- `terminal-hidden-view-parking.test.ts` — "ssh pty parks when remote parking enabled";
  "remote runtime pty parks when remote parking enabled"; "terminalRemotePaneParking=false
  restores the exclusion"; "separator-less daemon-fail-open id still refuses"; "foreign
  worktree session id still refuses".
- `terminal-parked-tab-watchers.test.ts` — ssh watcher starts fact-consumer + gate claim;
  remote watcher receives injected byte source + `sendRuntimePtyInput` + non-null
  `runtimeEnvironmentId`; remote exit: `terminal.wait` confirmed → leaf teardown;
  unconfirmed stream end → resubscribe, no tab close.
- `parked-terminal-byte-watcher.test.ts` — remote byte source drives bell/title/completion
  parity; watcher start after `startAtLiveTail` fires no stale bell from historical snapshot.
- new `remote-parked-reveal-snapshot.test.ts` (terminal-pane) — reveal replays subscribe
  snapshot with `suppressAttentionEvents`; `REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE` → budgeted
  requested-snapshot fallback replay, split via `splitRemoteAltScreenSnapshot` (extends
  `remote-runtime-pty-alt-screen-snapshot.test.ts` fixtures).
- new `ssh-parked-reveal-depth.test.ts` — revealed parked ssh pane restores the model
  snapshot (5 000-row depth), not the 100 KB relay tail; replay-guard dedupes the attach
  replay.

Main:
- new `terminal-multiplex-desktop-snapshot-budget.test.ts`
  (beside `src/main/runtime/rpc/terminal-multiplex-alt-screen-snapshot.test.ts`) — desktop
  subscribe snapshot bounded by `REQUESTED_SNAPSHOT_BYTE_BUDGET`, line-boundary cut, honest
  `truncatedByByteBudget`; mobile path unchanged.
- `ssh-relay-session` gate parity — parked (claimed) ssh pty: delivery dropped, exactly one
  `pty:modelRestoreNeeded` latched (extends the :930-942 path's existing coverage).

E2E: extend the parking e2e suite via `terminal-parking-e2e-overrides.ts` (shrunk hysteresis)
with an SSH-target scenario: 3 hidden ssh tabs park past the cap/TTL, bell while parked marks
unread, reveal shows full model-depth scrollback. Cross-platform per AGENTS.md: no new
keyboard/path surface; relay/daemon tests must stay green on the Windows conpty paths.

---

## Critic notes

Spot-checked 2026-07-22. Verified: the exclusion and its stale comment (terminal-hidden-view-parking.ts:54-68 — "Remote runtime and SSH PTYs have no local snapshot in this phase"), `canUseMainBufferSnapshot = !isRemoteRuntimePtyId(ptyId)` (pty-connection.ts:5723), the **unbudgeted desktop subscribe snapshot** with hardcoded `truncatedByByteBudget: false` (rpc/methods/terminal.ts:724-741 — the design's key host-side fix is real), `MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES` = 2 MiB (remote-runtime-terminal-multiplexer.ts:126), `REPLAY_BUFFER_MAX` = 100 KiB (relay/pty-handler.ts:149), `DEFAULT_SCROLLBACK` = 5000 (headless-emulator.ts:41), `startAtLiveTail` semantics (runtime-terminal-stream.ts:61-92). Notes:

1. **Citation drift, behavior claims hold**: the client hard-drop is at remote-runtime-terminal-multiplexer.ts:526 (constant at :126; file lives under `src/renderer/src/runtime/`, not `components/terminal-pane/`); `trackHeadlessTerminalData` is at orca-runtime.ts:6332-6344 (not :7795-7813). Update before implementation to avoid mid-PR re-derivation — the seams themselves are as described.
2. **Phase-1 "no new code" reveal (gate ON) rests on an ordering assumption** — watcher claim release before pane handler registration, with exactly one `pty:modelRestoreNeeded` latch consumed. That ordering is plausible from the cited seams but was not provable by inspection alone; the named test "revealed parked ssh pane restores the model snapshot… replay-guard dedupes the attach replay" should be written *first* and treated as the phase-1 gate, not a trailing check.
3. **Wave-planning constraint**: §3.3's host subscribe-snapshot budget edits `rpc/methods/terminal.ts` — the same file the federated-search remote wire (§2.4 of FEDERATED-SEARCH-DESIGN.md) extends with `terminal.search`. The BUILD-PLAN sequences parking phase 2 in the wave before the federated remote adapter so no two waves write that subsystem concurrently.
4. The §3.6 memory estimate honestly reuses fork-measured numbers; note the audit's ring figures are content-independent, so the "40–100+ MB" claim is conservative for wide panes — fine as motivation.

Effort (Phase 1 S–M, Phase 2 M) credible; engine-work-none confirmed (headless/wasm snapshot engines used as-is).
