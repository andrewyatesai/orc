# orca-daemon authority model

The pre-bind design gate named by [`unified-agent-surface-plan.md`](./unified-agent-surface-plan.md)
(Phase 1b): *"the socket must not be reachable until the above is written and reviewed"*.
Rationale for the surface itself lives in
[`always-installed-agent-skills.md`](./always-installed-agent-skills.md).

## Conclusion, first

**Federation should not ship as designed, and the reason is outside this document.**

Two facts, both verified below, collapse the design as previously written:

1. **An agent inside a pane can read the daemon token and become Owner, and nothing
   shipped prevents it.** The containment profile that this document previously cited as
   the mitigation does not deny Orca's runtime directory — it is `(allow default)` plus a
   fixed list that does not include it (`containment/sbpl.rs:108`, `:120-140`, `:157-177`).
   Per-pane authority is therefore not a boundary against the one adversary it was written
   for.
2. **No shipped client can present an edge token.** `aterm ctl` authenticates by reading
   the instance's owner token file and sending `AUTH <hex>` (`ctl/lib.rs:786-802`, `:570-572`);
   there is no code path in it that presents `TOKEN <hex> <verb>`. The edge tier today is
   reachable only from the aterm GUI's own proxy forward (`gui/control.rs:2933-2966`).

So the edge model, as of today, is **scoping and attribution — not enforcement.** That is
still worth building: it makes the intended grant explicit, it is what the audit log keys
on, and it is the only thing that constrains a *cooperative or sandboxed* agent. But every
sentence that called it "policy" was overclaiming, and the corrections below say so
everywhere it appeared.

**What has to change before federation binds** — neither is in this file:

| # | change | owner | why it gates |
| --- | --- | --- | --- |
| A1 | Orca's pane spawn applies an OS sandbox at all | Orca | see below — A2 is unreachable without it |
| A2 | that profile denies Orca's daemon runtime dir (socket, token, edges) | aterm + Orca | without it, in-pane Owner escalation is a one-line `cat`, and per-pane authority is decorative |
| B | a client that presents an edge token (`TOKEN <hex> <verb>`) ships | Orca or aterm | without it, an in-pane agent authenticates as Owner and edges are never exercised |

**A was one row and is now two, because the original was unsatisfiable.** The SBPL string
is only ever applied by aterm's own spawn seam, which wraps the child in
`/usr/bin/sandbox-exec -p <sbpl>` (`<aterm>/crates/aterm-pty/src/unix.rs:22`, `:52-55`).
Orca does not spawn through that seam: `orca-pty` builds a bare `portable_pty::CommandBuilder`
with no sandbox wrap (`pty/session.rs:10`). So teaching `aterm-containment` to deny the
runtime dir would change nothing for an Orca pane — the profile never reaches it. Widening
the deny list is necessary but not sufficient; Orca must first have a spawn path that
applies a profile at all.

This matters beyond bookkeeping: a future reader checking "has A landed?" against the
original row would have seen an aterm commit widening the deny list and concluded the gate
was met, while every Orca pane remained unsandboxed.

The decisions below are written to be correct *when* A and B land, and are worth
implementing before they do — items 1-11 of §8 are hardening the daemon needs either way.
What must wait is the binding: shared-directory registration and `graph/<sid>` publication.

**Citation roots.** `daemon/` = `rust/crates/orca-daemon/src/` · `pty/` =
`rust/crates/orca-pty/src/` · `app/` = `src/` · `gui/` = `<aterm>/crates/aterm-gui/src/` ·
`session/` = `<aterm>/crates/aterm-session/src/` · `types/` = `<aterm>/crates/aterm-types/src/`
· `control/` = `<aterm>/crates/aterm-control/src/` · `ctl/` = `<aterm>/crates/aterm-ctl/src/`
· `containment/` = `<aterm>/crates/aterm-containment/src/`. Every line reference was opened
and read.

---

## 0. What is true today

**aterm — two tiers, per-op, fail closed.**

| element | behavior | where |
| --- | --- | --- |
| transport | 0700 per-user dir, owner-verified and refused if foreign-owned; socket `chmod 0600` | `gui/control_auth_unix.rs:28-49`, `:132-134` |
| peer gate | `getpeereid` (macOS, uid+gid only) / `SO_PEERCRED` (Linux, uid+gid+pid); unverifiable peer refused | `gui/control_auth_unix.rs:141-147`, `:153-167`, `:186-192` |
| Owner tier | per-instance token, 32 bytes, `O_CREAT\|O_EXCL\|O_NOFOLLOW` 0600, `fchmod` via the open fd, rotated every launch | `gui/control_auth_unix.rs:105-127` |
| Edge tier | presented hex resolves in the *destination's* table to one `(src, dst, op, nonce)` row | `session/edge.rs:319-330`, `gui/control.rs:2933-2966` |
| the gate | point lookup, never a graph walk; permits iff token ∧ op ∧ dst ∧ nonce all match | `session/edge.rs:326-329` |
| ops | six: `ReadScreen`, `WriteInput`, `Signal`, `ConfigWrite`, `ClipboardWrite`, `DeriveLoop` — the last three split out so an inherited edge cannot reach them | `session/edge.rs:22-46` |
| **who presents an edge** | **only the aterm GUI, on a proxy forward.** `aterm ctl` reads the sibling owner token file and sends `AUTH <hex>`; it has no edge path | `ctl/lib.rs:786-802`, `:570-572`, `:1530-1536` |
| Owner reaches siblings | the instance token is process-wide authority; an Edge needs a row per target | `gui/control.rs:395-408`, `:558-566` |
| identity | `SessionId` = `s-<20 hex>`, pid-free; `LaunchNonce` = 16 bytes, **public** anti-spoof state | `session/id.rs:10-14`, `:29-40`, `:49-55` |
| token delivery | three secrets in a 0600 file keyed on the **fresh per-spawn child sid**; only the non-secret *path* goes in env | `gui/proxy.rs:431-469`, `:495-497` |
| discovery | `<dir>/graph/<sid>` 0600 = `sock <abs>` + `nonce <hex>` + `pid <n>` | `gui/proxy.rs:270-285` |
| cross-instance | a peer reads the target's 0600 token file and presents it verbatim — and aterm states plainly this "grants nothing the caller could not already obtain directly" | `gui/proxy.rs:241-256` |

**orca-daemon — one tier, socket-wide, no per-pane concept.**

| element | behavior | where |
| --- | --- | --- |
| transport | socket `chmod 0600`; token file 0600 but written create/truncate — **no `O_EXCL`, no `O_NOFOLLOW`**; runtime dir created with **no mode** (verified `drwxr-xr-x` under a `drwx------` `Application Support` on this macOS host) | `daemon/lib.rs:57-58`, `daemon/token.rs:66-78`, `app/main/daemon/daemon-init.ts:72-76` |
| peer gate | **none** — accept spawns a thread straight into the handshake | `daemon/lib.rs:82-91`, `daemon/connection.rs:143-198` |
| auth | **conditional.** `serve(socket_path, token_path: Option<&str>)`; `None` ⇒ `expected_token = None` ⇒ the gate at `connection.rs:171-176` is skipped and *any* token is accepted. The daemon announces which (`auth=on`/`auth=off`) | `daemon/lib.rs:55-67`, `:69-77`, `daemon/connection.rs:171-176` |
| who chooses that | the **launch line**, not the daemon: `--token` is optional and there is no default | `daemon/main.rs:24-27`, `:44` |
| identity of caller | `clientId` is a self-asserted string in the hello — a routing key, never verified | `daemon/protocol.rs:88`, `app/main/daemon/client.ts:78` |
| authority granularity | none. Any token holder may name any `sessionId` | `daemon/rpc.rs:405-414` |
| what a token holder can do | spawn an arbitrary program with arbitrary args/cwd/env; write; resize; kill; signal; snapshot; steal ownership of a live session | `daemon/rpc.rs:443-444`, `:597-641`, `daemon/registry.rs:121-142` |
| the "sub-tier" | **not a read-only tier.** `is_read_only_subscriber` has exactly two call sites — `write` (`rpc.rs:115`) and `resize` (`rpc.rs:134`). `kill`, `signal`, `snapshot`, `createOrAttach` are ungated for a subscriber, and `createOrAttach` *promotes* it to owner, clearing both denials | `daemon/registry.rs:191-202`, `:121-142`, `daemon/rpc.rs:115`, `:134`, `:163` |
| workspace | not a daemon concept. The app recovers `worktreeId` by parsing the sid and kills sessions whose worktree is gone | `app/main/daemon/daemon-pty-adapter.ts:1254-1280` |
| pane sid content | `${repoId}::${absolutePath}@@${short}` — the sid *contains the absolute worktree path* | `app/main/daemon/pty-session-id.ts:21-25`, `app/shared/pty-session-id-format.ts:14-15`, `:28-40` |

---

## 1. Principals

A pane belongs to a workspace, not to a process tree: the daemon forks every PTY itself
(`daemon/rpc.rs:444`), so there is no parent session to inherit from. Authority descends
from the workspace, and the workspace's agent is the Orca app.

| principal | authenticates as | may do | actually separable? |
| --- | --- | --- | --- |
| **Orca app** (main process; also the coordinator-window tunnel, `app/main/coordinator-window.ts:148-152`) | the daemon token | everything — Owner | — |
| **agent inside a pane** | the edge triple minted for that pane | exactly the `(sid, op)` rows minted for it; no owner-only verb | **no** — same uid, and the daemon token is 0600-readable by it (§7) |
| **peer aterm instance** | whatever credential it presents | *nothing by virtue of being aterm.* A peer holding the daemon token is Orca-equivalent | **no** — same uid |
| **unrelated same-uid process** | same as above | identical to the peer row | **no**, by construction |
| **process of another uid** | nothing | nothing, once D2.1 lands | **yes** — this is the only boundary the daemon can actually hold |

**D1.1 — Two tiers, exactly aterm's.** `Owner` (the daemon token) and `Edge` (per-op,
per-target). No third "peer" tier: a unix socket authenticates a credential, not a product.

**D1.2 — The principal is the credential, never the process.** `clientId` stays a fan-out
routing key inside the Orca dialect and is never consulted by the aterm dialect. Note what
it is today: `createOrAttach` rebinds ownership on an asserted id (`daemon/registry.rs:132`)
and demotes any subscriber registration for that id (`:136-141`). The two subscriber
denials are therefore not a tier — they are two verb-specific checks that a caller clears
by asserting the owning `clientId`. Federation must not add a third consumer of `clientId`,
and no security claim may rest on it.

**D1.3 — The workspace is a first-class `src`.** Each workspace gets a synthetic
`SessionId` (`s-<20 hex>`, `session/id.rs:29-40`) that is the `src` of every edge minted
into its panes. It hosts no terminal, is never published to `graph/`, and never resolves as
a target — so `family` tells the truth about grouping without a second mechanism.

---

## 2. Owner

**D2.1 — The owner connection is any connection presenting the daemon token, and the
token gate must stop being optional.** Three changes, in order of what they buy:

| change | closes | port from |
| --- | --- | --- |
| peer-uid gate on accept | cross-uid reach (the *only* boundary available) | `gui/control_auth_unix.rs:186-192` → `daemon/lib.rs:82-91` |
| runtime dir 0700 + owned-and-unshared predicate | a foreign-owned or group-writable runtime dir; today it is `0755` | `gui/control_auth_unix.rs:28-49` → `app/main/daemon/daemon-init.ts:72-76` |
| token file `O_CREAT\|O_EXCL\|O_NOFOLLOW` + `fchmod` | a planted symlink at the token path — currently a plain create/truncate | `gui/control_auth_unix.rs:105-127` → `daemon/token.rs:66-78` |
| **refuse to bind when `token_path` is `None`** | a federated daemon serving with `auth=off` | new; `daemon/lib.rs:60-67` |

The last one is not hardening, it is a correctness bug in the design as written: the
previous revision presented the token gate as unconditional. It is not — it is
`Option<&str>` all the way from the CLI (`daemon/main.rs:24-27`). A daemon that will
register in a shared directory must fail closed on a missing `--token`, and the parity
harness must pass an explicit opt-out flag rather than inherit "no token" by omission.

**D2.2 — There is no partial owner.** The roster spans workspaces; filtering it per caller
would need a credential meaning "this workspace", and none exists.

| verb class | who | rationale |
| --- | --- | --- |
| `sessions`, `who`, `whoami`, `subscribe … sessions`, `grant`, `revoke`, `dial` | Owner only — a scoped edge gets `ERR denied` | table-declared, not hardcoded: `types/control_verbs.rs:574-597`, `:624-639`, `:640-647`, `:567` |
| everything session-scoped (`text`, `send`, `await`, `blocks`, …) | Owner, or an Edge holding that op for that sid | `gui/control.rs:395-408`, `:558-566` |
| GUI-class — `image`, `video`, `window`, `chrome`, **`controls`**, `inspect` (six) | nobody — `ERR unsupported` | plan line 65; `types/control_verbs.rs:288-330` |

A pane agent therefore cannot enumerate the roster. Its visible world is exactly the set of
edges its workspace minted — *given* B above; without an edge-presenting client it
authenticates as Owner and sees everything.

**D2.3 — The roster line carries the fabric sid, never the pty sessionId.** Three
independent reasons: the pty sessionId embeds an absolute path
(`app/shared/pty-session-id-format.ts:28-40`); `graph/<sid>` is a path join, so a sid
containing `/` escapes the directory (`gui/proxy.rs:149-152`); and aterm's adopters require
exactly `s-<20 hex>` (`gui/spawn.rs:175-176`).

---

## 3. Identity and lifetime

| identity | minted by | visible where | stable across | reissued on |
| --- | --- | --- | --- | --- |
| pty `sessionId` (`worktreeId@@short`) | the app | Orca dialect only | daemon restart, app restart, reload — the app re-creates the string, and an unknown id spawns fresh (`daemon/rpc.rs:436-439`) with cold-restore reseed (`:476-484`) | user closes and recreates the pane |
| **fabric sid** `s-<20 hex>` | the daemon, per PTY spawn | the aterm wire, `graph/<sid>`, **and the edge-file path** | the life of one shell process | every spawn, including a cold-restore respawn under the same pty sessionId |
| **launch nonce** (16 bytes / 32 hex) | the daemon, per PTY spawn | public, in the graph entry in the clear (`gui/proxy.rs:277-281`) | nothing — it *is* the epoch marker | with the sid, always together |
| daemon token | the daemon | the 0600 token file | one daemon process | every daemon start (`daemon/lib.rs:62`) |

**D3.1 — The fabric sid names a shell process, not a pane slot.** Deriving it from
`StablePaneId` (`app/shared/stable-pane-id.ts:10`) would make it survive restarts, which is
attractive for agents and wrong for authority: a durable *and* authorizing identifier is
precisely the pid-reuse hazard `SessionId` exists to avoid (`session/id.rs:10-12`). The
durable pane identity stays a non-authorizing attribute, resolvable through
`orca terminal show --json`.

**D3.2 — Nothing needs a stale-sid rule, because sids are not reused.** A presented token
whose row is gone denies by default (`session/edge.rs:326-329`); a leftover graph entry
resolves to a socket that either fails `confine_proxy_sock` (`gui/control_auth.rs:2128-2154`)
or answers `ERR no such session`, and is swept on liveness (`gui/proxy.rs:416-429`).

---

## 4. Capability delivery and revocation

### D4.1 — Where capability lives, and what each candidate actually separates

This is the section the previous revision got wrong. It claimed the mitigation for a
same-uid adversary was "the file mode and the dir mode". File mode and directory mode do
not separate two processes of the same uid — which is the only adversary this section
exists for. Honestly:

| mechanism | separates cross-uid | separates same-uid | repeatable read (relaunch) | cost |
| --- | --- | --- | --- | --- |
| 0600 file in a 0700 dir | yes | **no** | yes | none — shipped shape |
| tokens in env | yes | **no** (and worse: leaks to every child, and to `ps` on some platforms) | yes | none |
| tokens over the already-authenticated socket | yes | **no** — the connection is authenticated by the daemon token, which is itself a 0600 file the adversary can read | yes | low |
| peer credentials of the connection | yes | **no** — `getpeereid` yields uid+gid only on macOS (`gui/control_auth_unix.rs:141-147`); Linux `SO_PEERCRED` adds a pid, but a pane's grant must cover its whole descendant subtree, and pid→pane is unsound under reparenting and pid reuse | n/a | medium, and it does not work |
| **inherited fd from the daemon's own fork** | yes | **raises the bar to debugging another process** — the strongest option available | yes, if the fd survives exec in the shell | **high**: `PtySession::spawn` builds a `portable-pty` `CommandBuilder` exposing only program/args/cwd/env, with no `pre_exec` or extra-fd hook (`pty/session.rs:55-79`) |

**Decision: keep the 0600 file, and stop calling it enforcement.** It is the only mechanism
compatible with the shipped spawn path, and none of the alternatives reaches a same-uid
boundary anyway; only fd-passing meaningfully narrows the window, and it requires replacing
the spawn path. Record fd-passing as the one upgrade that would change the answer, priced
above, and do not ship copy that implies today's shape achieves it.

So: **each pane receives one token triple** — `read` / `write` / `signal`, 32 random bytes
each (`session/edge.rs:108-112`) — written 0600 in the daemon's 0700 runtime dir, the path
(not the secrets) in env.

### D4.2 — Edges are scoping, not policy

The mechanism is unchanged and correct: one token may appear in many destination tables
because each destination owns its table and the gate compares `dst` per lookup
(`session/edge.rs:327`).

> when pane *Q* is created, insert *P*'s three tokens as rows in *Q*'s table (bound to
> *Q*'s nonce) for every *P* that policy says may drive *Q* — including *Q* itself, since a
> self-loop is just the row `(Q, Q, op)` (`session/edge.rs:79-84`, test `:495-498`).

Cost is O(panes-in-workspace) inserts per pane creation. **Default: same workspace, all
three ops, plus the self triple.**

What this buys, stated at its true strength:

| against | effect |
| --- | --- |
| a cooperative agent following its grant | **binding** — it cannot name a pane outside its workspace |
| a confused deputy handed a token by prompt injection | **binding** — the token it holds resolves in one table, for one op |
| a sandboxed agent that cannot read 0600 files | **binding** — this is aterm's own scoping of the claim (`gui/control_auth.rs:22-26`) |
| a hostile same-uid process (including a hostile in-pane agent) | **nothing.** It reads the edge file, or the daemon token, and acts as anyone |

The word "policy" is retired from this section. Widening to cross-worktree is more rows and
no wire change — that reversibility is real and is still the reason to build it this way.

### D4.3 — Identity env: strip the whole deny list, and do not inject aterm's identity pair

Two corrections.

**The strip is a strip of fourteen keys, not four.** aterm's deny list is
`types/env_sanitize.rs:111-132` — fourteen entries, and the previous revision's sentence
("`ATERM_CONTROL_SOCK` is not pinned, matching aterm's own deny-list") contradicted the
very file it cited: `ATERM_CONTROL_SOCK` is *in* that list. The daemon takes the client's
`env` verbatim today (`daemon/rpc.rs:602`, `:635-639`) — there is no strip at all — so the
rule below is new work, not a description.

| key | why a client must not set it |
| --- | --- |
| `ATERM_SESSION_ID`, `ATERM_LAUNCH_NONCE` | choose a pane's published identity |
| `ATERM_EDGE_TOKENS`, `ATERM_EDGE_READ/WRITE/SIGNAL` | aterm's env fallback token channel — a client-supplied value is adopted as parent edges |
| `ATERM_CONTROL_SOCK`, `ATERM_NO_CONTROL_SOCK` | redirect the pane's control socket, or silently disable it |
| `ATERM_NET_LISTEN`, `ATERM_NET_CERT`, `ATERM_NET_KEY` | stand up a network-reachable control surface from inside a pane |
| `ATERM_CONTAINMENT_MODE`, `ATERM_CONTAINMENT_ALLOWLIST` | loosen the pane's containment |
| `ATERM_PARENT_SESSION_ID` | claim a parent |

**Reject the whole `ENV_DENY_VARS` set from the client payload, then inject.** Anything
narrower is an under-strip whose gaps are exactly the escalation primitives.

**Do not inject `ATERM_SESSION_ID` + `ATERM_LAUNCH_NONCE`.** That pair is precisely what
aterm's `adopt_injected_identity` consumes (`gui/spawn.rs:195-204`, parser at `:179-193`):
an aterm the user launches inside an Orca pane would adopt the pane's fabric sid and nonce
as its *own root identity* and publish `graph/<sid>` for its own socket
(`gui/proxy.rs:222-227`) — squatting the pane's published identity and pointing peers at a
different process. That directly contradicts D5.1.

So the pane's identity env is **Orca-namespaced**: `ORCA_PANE_SID`, `ORCA_PANE_NONCE`,
`ORCA_PANE_PARENT_SID`, `ORCA_EDGE_TOKENS`. aterm's adoption path does not read them. If
Orca later *wants* nested-aterm adoption, that is a separate decision with its own review,
not a side effect of variable naming.

### D4.4 — Revocation: every route a pane can disappear by

The previous revision named one route. Verified, the daemon's `reap_and_mark_exited`
(`daemon/registry.rs:415`) has exactly one production caller — `daemon/rpc.rs:982`, on PTY
**master EOF**. That is not "the pane closed". It is "the last holder of the PTY slave
closed it", which a backgrounded descendant can defer indefinitely — the daemon's own
adapter notes that detached prompt helpers survive the kill
(`app/main/daemon/daemon-pty-adapter.ts:1007-1009`).

| # | route | what happens today | in-memory table | edge file on disk | revoke where |
| --- | --- | --- | --- | --- | --- |
| 1 | UI pane close | `adapter.shutdown` (`daemon-pty-adapter.ts:934`) → `kill` RPC (`:1013-1017`) → SIGHUP, SIGKILL after 5 s (`daemon/rpc.rs:163-194`) → child dies → EOF → reap | reaped **iff** EOF arrives | leaked | **at the `kill` RPC**, not at EOF |
| 2 | shell exits on its own | EOF → reap (`daemon/rpc.rs:982`) | reaped | leaked | at reap |
| 3 | a descendant holds the slave open after the shell dies (route 1 or 2) | no EOF arrives, so the reap that routes 1 and 2 rely on **never fires** | **not reaped** — the entry stays live and drivable | leaked | nothing triggers until the descendant exits or the daemon restarts. This is the case that makes an intent-time seam mandatory rather than tidy |
| 4 | workspace close | per-pane route 1 for each | as route 1 | leaked | app-driven RPC; retire the workspace `src` too |
| 5 | app quit, normal | `disconnectDaemon()`, not `shutdownDaemon()` — the daemon and its sessions survive for warm reattach, by design (`app/main/index.ts:2838-2839`, `daemon-init.ts:354-357`) | **untouched** | **untouched** | nothing — stated, not hidden (see Q7) |
| 6 | explicit daemon shutdown | `shutdown {killSessions:true}` → `kill_all_sessions` then `process::exit(0)` 50 ms later (`daemon/rpc.rs:352-370`, `registry.rs:278-283`, `app/main/daemon/daemon-init.ts:1111`) | dies with the process; **no reap runs** | **leaked** | unlink the edges dir in the same handler, before exit |
| 7 | SIGTERM / SIGHUP to the daemon | `teardown_and_exit_code` → `process::exit` (`daemon/termination_signals.rs:28-42`) | dies with the process | **leaked** | same handler |
| 8 | daemon crash / SIGKILL | nothing runs | dies with the process | **leaked** | **sweep the edges dir at daemon start** |
| 9 | client disconnect | `unregister_stream` + `remove_subscriber_from_all` (`daemon/connection.rs:254-257`) — ownership is *not* dropped | untouched | untouched | correct as is; a disconnect is not a close |
| 10 | dead entry replaced | `remove_session` on the createOrAttach fall-through (`daemon/rpc.rs:439`) — bypasses reap entirely | removed | leaked | revoke here too |
| 11 | orphan reconcile | `kill` per orphan (`daemon-pty-adapter.ts:1273`) | as route 1 | leaked | route 1 covers it |

**D4.4 — Revoke on intent, then again on exit, and sweep on start.** Three seams, not one:

1. **Intent** — the `kill` RPC (`daemon/rpc.rs:163`) drops the pane's table, drops every row
   minted from its tokens in all other tables, and unlinks its edge file, *before* signalling
   the child. This is the seam that makes "I closed that pane" true, and it is the one the
   previous revision missed. Shaped like `remove_subscriber_from_all`
   (`daemon/registry.rs:180-186`).
2. **Exit** — the same pass at reap (`daemon/registry.rs:415`), idempotent, for routes 2 and 3.
3. **Start** — sweep `<runtimeDir>/edges/` on daemon start, for routes 6-8. Safe precisely
   because D4.5 keys the path on a per-spawn sid: on a fresh daemon, no leftover name can
   collide with a live pane.

A revocation model that names one route is the bug. Enumerate; then test each row.

### D4.5 — The edge file is per spawn, not per pane

**The durable path is removed from this design.** The previous revision keyed the file on a
durable `stablePaneId` and had the daemon rewrite it per spawn, citing aterm's "leftovers
are inert" argument (`gui/proxy.rs:507-513`). That argument depends entirely on the key:

| | aterm | durable-path design |
| --- | --- | --- |
| path key | fresh per-launch child sid (`gui/proxy.rs:495-497`) | durable `stablePaneId` |
| what capturing the path once yields | an `(sid, nonce)` never reissued — inert | **fresh tokens on every subsequent spawn of that pane, forever** |

That is automatic re-adoption, the opposite of inert. And the durable path bought nothing:
its stated justification was that the shell's inherited `ORCA_EDGE_TOKENS` must keep
pointing at the rewritten file, but the next spawn is a *new shell process* with a *new env*
(`daemon/rpc.rs:439-444`), so it inherits whatever path the daemon injects at that spawn.

**Decision: `<runtimeDir>/edges/<fabric-sid>`, minted per spawn, 0600, in a 0700 dir** —
aterm's shape exactly. And now aterm's reason transfers verbatim: the file persists for the
*spawn's* life because the agent process inside the pane exits and is re-run constantly
while the shell lives, and the re-launched agent re-inherits the pinned path and must
re-read the same secrets; consume-on-read broke every relaunch
(`gui/proxy.rs:438-452`, `types/env_sanitize.rs:64-77`). A leftover from a crashed daemon
binds an `(sid, nonce)` never reissued and authorizes nothing
(`gui/proxy.rs:507-513`) — *because the key is fresh*, which is the whole point.

The daemon owns removal (D4.4 seams 1-3). One honest difference from aterm remains: aterm's
file authorizes against one child, Orca's against every pane in a workspace, so a leaked
file is worth more. Per D4.1 there is no mitigation for that against a same-uid reader —
only the narrowing of the window from "pane lifetime" to "spawn lifetime", which this
decision buys, and the default-policy breadth, which Q1 decides.

---

## 5. Nonce

aterm documents that on the recursion path the nonce is **pinned, not fresh**: the child
adopts an injected constant, so a same-shell relaunch adopts the identical nonce and the
cross-relaunch protection does not hold there — the nonce is a binding key, not a relaunch
guard (`types/env_sanitize.rs:44-53`).

**D5.1 — Orca mints fresh, always, in the daemon, per PTY spawn, and never adopts an
injected nonce.** The daemon forks every pane itself, and per D4.3 the pane's env carries
no `ATERM_*` identity pair for a nested aterm to adopt.

What that does and does not buy:

* **Does:** an edge minted for spawn *k* fails closed at spawn *k+1* in the same pane — the
  cold-restore case where one pty sessionId acquires a new shell.
* **Does not:** protect anything *within* one spawn. A token read out of the 0600 file
  drives that pane until the pane dies.
* **Does not:** act as a secret. The nonce is public (`session/id.rs:49-55`), written to the
  graph entry in the clear (`gui/proxy.rs:277-281`); a same-uid process can copy it. aterm's
  `confine_proxy_sock` exists precisely because copying it is easy, and its own comment says
  so: the nonce guard "does NOT stop a hostile same-uid process" from redirecting a graph
  entry (`gui/control_auth.rs:2115-2124`).
* **Inherits:** if a user runs a nested aterm inside an Orca pane, that aterm mints its own
  identity (D4.3), so aterm's pinned-nonce caveat applies to *its* children, not to the
  Orca pane. Orca neither fixes nor inherits it.

---

## 6. Reattach

| case | presents | checked | outcome |
| --- | --- | --- | --- |
| in-pane agent after a **daemon restart** | nothing — it is dead. PTYs are daemon children; the master closes with the daemon | — | a fresh pane spawns with a fresh sid, nonce, and a **new** edge-file path |
| in-pane agent **relaunched in the same shell** (the common case) | the same hex, re-read non-destructively from the pinned `ORCA_EDGE_TOKENS` path | `decide_edge(table_of_dst, token, dst, op, nonce_of_dst)` | permitted while the spawn epoch is unchanged; this is exactly why D4.5 persists the file for the spawn |
| **out-of-pane holder** (peer, script) after a daemon restart | a stale edge hex and a cached sid | table lookup misses; the sid is absent from `graph/` | `ERR auth`; recovery is re-resolution, never re-adoption |

**D6.1 — No re-adoption of pre-restart credentials, ever.** Fail closed and audit it the
way aterm does (`gui/control.rs:2939-2963`).

**D6.2 — Nothing durable grants, and nothing durable *addresses* either.** The previous
revision made the rendezvous path durable and the contents fresh. Per D4.5 both are now per
spawn. A reconnecting agent re-reads its env; an agent that cached a path across a respawn
gets a missing file, which is the correct answer.

---

## 7. The new exposure

Stated as the plan requires, without softening.

**What is already true.** The daemon's socket and token are 0600, owner-readable (verified
on this host: `srw------- daemon-v1021.sock`, `-rw------- daemon-v1021.token`, in a
`drwxr-xr-x` dir). A same-uid process that reads that file today already holds *complete*
control: no peer gate (`daemon/lib.rs:82-91`), no per-session gate, arbitrary program spawn
(`daemon/rpc.rs:443-444`, `:597-641`), ownership theft by naming a sid
(`daemon/registry.rs:121-142`). **The uid is already the boundary.**

**What federation changes.** Not the boundary — the reach, the vocabulary, and the blast
radius of one credential:

| change | consequence |
| --- | --- |
| panes publish `graph/<sid>` into the shared per-user dir (`gui/proxy.rs:222-227`, `:270-285`) | enumeration no longer requires knowing Orca exists; `aterm ctl ls` walks the dir and dials each socket (`ctl/lib.rs:606-661`) |
| a standard client and a documented verb table ship | driving an Orca pane goes from bespoke to one command |
| peers relay presenting the token they read (`gui/proxy.rs:241-256`) | an Orca pane becomes reachable *through another product's socket*. Note the socket must sit **directly in** the shared dir for a forward to dial it: `confine_proxy_sock` requires canonical-parent equality, one component, no symlink (`gui/control_auth.rs:2128-2154`) — so federating means relocating or mirroring the socket, which is itself a decision |
| aterm's TLS `dial` becomes a path to Orca panes (owner-only, `types/control_verbs.rs:640-647`) | potentially off-machine, if the operator configured a listener — **UNVERIFIED**: the network path's authority mapping was not read |
| the sid namespace becomes shared | sid *content* becomes disclosure; see D2.3 |

**The honest limit — corrected, and it is the reason for the top-line conclusion.**

An agent inside a pane can read the daemon's 0600 token file — same uid, owner-readable —
and become Owner, bypassing every edge. The previous revision said this was "real under
`aterm-containment`'s Seatbelt mode, which denies the private-data set". **That is false as
shipped.** Read for this revision:

| checked | result |
| --- | --- |
| profile base | `(version 1)(allow default)(deny network*)` — permissive by default (`containment/sbpl.rs:108`, `:16-24`) |
| secret set | `.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.config/aterm`, `.kube`, `.docker`, `.config/gcloud`, `.azure` (`containment/sbpl.rs:120-130`) |
| secret files | `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc` (`:135-140`) |
| private set | `Documents`, `Desktop`, `Downloads`, `Pictures`, `Movies`, `Music`, `Library/{Mail,Messages,Keychains,Cookies,Safari}`, and five named browser profiles under `Library/Application Support` (`:157-177`) |
| **Orca's runtime dir** (`<userData>/daemon`, holding the socket, the token, the edge files) | **not denied by any entry.** The `Library/Application Support` denies are five specific browser subpaths; the module's own doc states the general FS scoping is "an explicit FOLLOW-UP, not silently implied" (`:23-24`) |

So: **in-pane Owner escalation is unmitigated today.** Containment mode denies the network,
which stops exfiltration, and denies credential stores — both valuable, neither relevant to
this. A reviewer is entitled to refuse federation on this fact alone, and should, until
change A in the top-line table lands. Any UI copy implying per-pane authority constrains an
in-pane agent is false.

**What an operator who does not want this does.** The Phase 1c positions, which Phase 1b
must land as working switches *before* it binds federated (plan lines 199-207):

| position | what it actually buys | what it does **not** buy | verified by |
| --- | --- | --- | --- |
| `federated` (default) | registered in the shared dir, `graph/<sid>` published, cross-drivable | — | — |
| `private` | **non-discovery.** No shared-dir registration and no `graph/<sid>`, so neither branch of `live_instances` finds it: the readdir branch (`ctl/lib.rs:623-638`) only sees sockets *in* the dir, and the graph branch (`:639-658`) only sees published entries | **non-reachability.** The socket still exists at a stable path in `<userData>/daemon`; any same-uid process that looks can dial it, and the token file is beside it | a peer's `ls`/`instances` omitting it **and** a direct dial to the known path still succeeding — the second half is the honest half |
| `off` | no control socket at all (`types/control_socket.rs:62-74`); Orca's own agent features go dark, and the UI says so | — | — |

A workspace may only narrow what the machine setting allows; a pane may only be narrower
than its workspace. Never wider.

---

## 8. Delta required before the socket binds

1. Peer-uid gate on accept — `daemon/lib.rs:82-91` (port `gui/control_auth_unix.rs:186-192`).
2. Runtime dir 0700 + owned-and-unshared predicate — `app/main/daemon/daemon-init.ts:72-76`
   (port `gui/control_auth_unix.rs:28-49`).
3. Token file `O_EXCL|O_NOFOLLOW` + `fchmod` — `daemon/token.rs:66-78`.
4. **Refuse to bind federated with `token_path: None`** — `daemon/lib.rs:60-67`.
5. Fabric sid + nonce minted per spawn; pty sessionId kept off the aterm wire (D2.3, D3.1).
6. `EdgeTable` per pane in the registry; edge file at `edges/<fabric-sid>` (D4.5).
7. Revocation at all three seams, with a test per row of D4.4 — intent (`daemon/rpc.rs:163`),
   exit (`daemon/registry.rs:415`), start-sweep.
8. Whole-deny-list env rejection + Orca-namespaced identity injection (D4.3).
9. Owner-only verb set enforced for the aterm dialect (D2.2), GUI-class six answering
   `ERR unsupported`.
10. `private` and `off` implemented and tested *before* federated registration is enabled —
    with `private` verified for **non-discovery**, and its non-reachability limit documented
    in the UI copy.
11. Conformance for `sessions` / `resolve` / `write_input` on the Orca host — the plan
    records these three as unproven (plan lines 106-108), and the trait documents that
    per-session methods must fail closed on a foreign sid (`control/host.rs:116-132`).
12. **Blocked on others:** change A (containment denies the runtime dir) and change B (an
    edge-presenting client). Items 1-11 are worth doing regardless; federation binding is not.

---

## 9. Reversible, and not

| decision | reversible? |
| --- | --- |
| workspace policy breadth (which rows get inserted) | **yes** — mint-time, no wire change. This is the whole point of D4.2 |
| default position (`federated` / `private` / `off`) | **yes**, per machine and per workspace |
| sid random vs. derived from `StablePaneId` | **with notice** — both are opaque strings, but agents that cached sids break |
| edge-file location and layout | **yes** — internal, re-derived per spawn |
| the env namespace (`ORCA_*` vs `ATERM_*`) | **yes before ship, no after** — an agent that reads `ORCA_EDGE_TOKENS` is a compatibility surface the moment one exists |
| Owner = the socket token | **no, not by a protocol bump.** The handshake accepts a **range** — `MIN_SUPPORTED` 1018 through `PROTOCOL_VERSION` 1021 (`daemon/protocol.rs:23`, `:28`, `daemon/connection.rs:164-168`) — so raising the current version leaves every 1018-1021 client authenticating exactly as before. Retiring the socket token means raising the **floor**, which breaks old clients: a migration, not a bump |
| **publishing sids into the shared namespace** | **no.** Once shipped, third-party scripts depend on `graph/<sid>` presence, and older installs keep publishing. Retraction breaks everyone but the publisher |
| **anything a published sid disclosed** | **no.** A path that appeared in a sid cannot be unpublished. This is why D2.3 is not stylistic |
| **the compatibility surface once agents key on a field** | **no**, in practice — including any accidental exposure of the pty sessionId |

---

## 10. What a human must decide

**Irreversible — decide before anything binds.**

1. **Ship federation at all, given §7?** In-pane Owner escalation is unmitigated today.
   Recommendation: no, until change A lands. This is the decision; the rest are details
   under it.
2. **Publish sids into the shared namespace?** Irreversible on day one (§9). If yes, D2.3
   (fabric sid only, never the pty sessionId) is not optional.
3. **Does the pane env carry `ATERM_*` identity?** Choosing yes hands a nested aterm the
   pane's published identity (D4.3). Recommendation: no; Orca-namespaced.

**Reversible — decide, but they can be revisited.**

4. **Default policy breadth.** D4.2 proposes same-workspace; Phase 1c's stated default is
   "anything signed in as me" (plan line 201). These differ only for *in-pane agents* — an
   Owner-token holder is unconstrained either way — which is exactly the prompt-injection
   case. Same-workspace recommended.
5. **Is containment a prerequisite, or defence-in-depth?** Given §7, "prerequisite" is the
   only answer consistent with shipping honest UI copy. If the answer is
   defence-in-depth, the UI must say per-pane authority does not constrain a hostile
   in-pane agent.
6. **Buy the fd-passing upgrade?** The only mechanism that moves the same-uid answer, priced
   in D4.1 as replacing `PtySession::spawn` (`pty/session.rs:55-79`). Not required for 1b;
   required before any claim stronger than "scoping".
7. **Does the Owner tier need splitting** for the coordinator-window client
   (`app/main/coordinator-window.ts:148-152`), or is one Orca-wide owner correct?
8. **`ConfigWrite` / `ClipboardWrite` / `DeriveLoop`.** aterm splits these so an inherited
   edge cannot reach them (`session/edge.rs:32-45`). Orca exposes no equivalent — do they
   answer `ERR unsupported`, or acquire meaning?
9. **Does the Orca dialect stay token-only?** Every existing `orca terminal` RPC is
   authorized by the socket token alone. Edge-gate it too, or keep one dialect for Orca and
   one for agents permanently?
10. **Windows.** No peer-uid primitive; the token file gets no owner-only DACL
    (`daemon/token.rs:80-87`); the named-pipe path is cross-compile-verified but has never
    run on a real Windows host (`daemon/lib.rs:95-104`). Federated on Windows in 1b at all?
11. **The daemon outliving the app.** Normal quit keeps it for warm reattach
    (`app/main/index.ts:2838-2839`), so panes stay federated and drivable with Orca closed
    (D4.4 route 5). Intended, or should quitting narrow to `private` until Orca returns?

**UNVERIFIED.** The TLS `dial` / network-listener authority mapping (read as documentation,
not as code). Runtime-dir permissions on Linux and Windows (`0755` observed on this macOS
host only; the code passes no mode). Whether `portable-pty` can be extended to inherit an
extra fd without forking it. Whether any harness besides the ones already measured resolves
a mid-session credential rewrite.
