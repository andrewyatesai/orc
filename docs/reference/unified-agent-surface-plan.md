# Plan: unified agent surface

Execution plan for [`always-installed-agent-skills.md`](./always-installed-agent-skills.md),
which carries the rationale and the evidence. This file is the sequence.

**Thesis.** Orca links aterm's engine (`aterm-core`, `aterm-grid`, `aterm-types`) and
reimplemented introspection above it at a weaker layer. Unify on aterm's control
protocol; the skill-provisioning problem then shrinks to a size that does not need a
subsystem.

**Settled by experiment (2026-08-01).** Claude Code resolves a skill written to disk
*after* session start — a probe skill absent from the session's listing was invoked by
name and resolved. So a mid-session write can serve the session it was written for on
that harness. Treat this as version-scoped, not as a general law: the synchronous
pre-launch write remains what makes the guarantee unconditional. Other harnesses
unmeasured.

**Decided — federate.** `orca-daemon` is not a bridge or a dialect; it is **another aterm
instance**. It drops its socket in the shared per-user directory
(`$XDG_RUNTIME_DIR/aterm`, or `~/Library/Application Support/aterm` on macOS) and
publishes its panes into the same `graph/<sid>` namespace, so the existing relay resolves
them with no new concepts. One `aterm ctl ls` enumerates aterm tabs and Orca panes alike;
driving works in both directions; aterm's TLS dial and `aterm fleet` reach Orca panes for
free.

Consequence: **do not pin `ATERM_CONTROL_SOCK` in Orca panes.** Pinning would trap an
in-pane agent on Orca's socket and rebuild the island federation exists to avoid. Let
standard resolution (per-user default socket → `graph/` lookup → relay) find the whole
machine.

---

## Phase 1a — Extract a headless control server

The protocol is right; the **server is not extractable today**. `aterm-ctl` is a
client-only crate (`crates/aterm-ctl/Cargo.toml:12`, "a std-only command-line client").
The verb dispatch lives in `aterm-gui`, entangled with
`winit::event_loop::EventLoopProxy`, the GUI `Store`, subscribers, and the image queue
(`control.rs:39-45`). "Link the dispatcher into `orca-daemon`" was wrong: this is an
extraction, and it is the prerequisite for everything downstream.

**Measured boundary.** The verbs are already factored by concern, and `EventLoopProxy`
references localize the GUI coupling almost perfectly:

| module | lines | proxy refs | verdict |
| --- | ---: | ---: | --- |
| `control_query` | 2,923 | 8 | portable — `text`, `screen`, `cursor`, `cell`, `search`, `metrics`, `dims` off `&Terminal` |
| `control_selection` | 600 | 4 | portable — `blocks` |
| `control_session` | 1,645 | 1 | portable — `sessions`, `who`, `family`, `ready`, `await`, `turn`, `lease`, `grant`/`revoke`; needs the store behind a trait |
| `control_input` | 1,002 | 22 | **split** — `send`/`feed` take a sink and are portable; `key`, `ctrl`, `mouse`, `paste`, `focus` route through the event loop |
| `control_media` | 3,189 | 36 | GUI-only — `image`, `video`, `window`, `chrome`, `panes`, `controls`, `inspect`; stays behind the capability flag |
| `control_auth` (+`_unix`/`_win`) | 4,513 | — | portable — transport auth |
| `control.rs` | 11,684 | — | dispatcher, relay/proxy forwarding, workers; mostly host-agnostic |

So `SessionHost` needs four things: a `&Terminal` per sid, an input sink per sid, a
session roster with subscribers, and an optional GUI capability that gates `control_media`
plus the event-loop half of `control_input`. Authority checks are already centralized in
`required_op` / `scope_holds_op` (`control.rs:359`, `:522`) and can move with the
dispatcher unchanged.

**Deliverables**
- `aterm-control`: the verb dispatch, parameterized over a `SessionHost` trait (enumerate,
  resolve sid, read grid, write input, subscribe, await transitions). No winit, no GUI.
- `aterm-gui` reimplements as a `SessionHost` impl; behavior byte-identical.
- GUI-class verbs (`image`, `video`, `window`, `chrome`, `controls`, `inspect`) stay in
  `aterm-gui` behind a capability the trait advertises, so a host that lacks a frame
  source answers `ERR unsupported` rather than a silently empty frame.
- A verb-matrix conformance suite that any `SessionHost` must pass.

**Exit.** aterm ships on the extracted crate with no behavior change, and the conformance
suite passes against the GUI host.

**Status (2026-08-01): substantially done, one gap.** Landed on aterm main as `f2284d67`
(extraction) and `3b32e5e6` (completion). The crate depends only on `aterm-core` — no
winit, direct or transitive, proven from the dependency tree. `SessionHost` now carries
all four facilities: terminal accessors, subscribe/capabilities, the input sink
(`write_input`), and roster + resolution (`sessions`, `resolve`), with
`SessionEntry`/`SessionState`/`Selector` owned by the crate that owns the wire so two
hosts cannot disagree about what `@12` addresses. The conformance matrix is
non-destructive — a Drop guard restores prior selection on every path including the early
`return Outcome::fail` branches and a panic — and it **runs against a real `GuiHost`**
over a real `Terminal`, proven non-vacuous by forcing `with_terminal_mut` to refuse and
confirming the matrix rather than the setup reports the failure. Gates: workspace check
clean, 12/12 `aterm-control`, 2728 `aterm-gui`, `grep_guard.sh` PASS.

The L0 guard needed more than the scope widening this plan originally called for: verb
bodies borrow through `with_terminal` closures, so `term_lock(` never appears in the new
crate and the same-line anchor could not fire — widening `GUISRC` alone was *inert*. It is
re-anchored on the closure seam with a region walk over the unbalanced-paren span, proven
to fire on a violation planted inside a real multi-line closure.

**The remaining gap, and it is narrow.** The GUI host test builds `proxy: None`, so
nothing proves a `select` actually repaints a window. `winit::EventLoop` panics off the
main thread on every target and libtest runs bodies on spawned threads, so closing this
needs a harness binary owning `fn main`. Everything else in the exit criterion is met.

**Two hazards for Phase 1b, documented in the trait:**

- **The sid contract is SPLIT.** `sessions`/`resolve` answer fleet-wide; the per-session
  methods may serve one bound session *whatever sid you pass* — `aterm-gui`'s host is
  exactly that shape, ignoring `sid` in `with_terminal`, `with_terminal_mut`, and
  `write_input`. So `let sid = host.resolve(sel)?; host.write_input(sid, …)` can land on
  the wrong session. A fleet-scoped `orca-daemon` host must honor sid on every method, and
  `HostCapabilities` does not yet distinguish the two shapes.
- **No check exercises `sessions`, `resolve`, or `write_input`** on any host — the matrix
  is still the 7 selection/block checks. Those three are unproven by conformance; Phase 1b
  must add checks before relying on them.

Also open: `tools/grep_guard.sh`'s paren walk strips string literals but not trailing `//`
comments or char literals, so an unbalanced `)` in either closes a region early and can
hide a violation. And a guard bound to a variable (`let mut t = term_lock(term);`) held
across later statements stays invisible — pre-existing, 5 occurrences in real code,
needing binding-scope tracking with real false-positive risk.

## Phase 1b — `orca-daemon` as a second host

**Deliverables**
- `SessionHost` impl over `orca-daemon`'s existing registry. It already hosts a
  token-authenticated Unix socket (`main.rs --socket/--token`, `protocol.rs`, `rpc.rs`,
  `registry.rs`, `token.rs`), so this is a second dialect on existing infrastructure, not
  new plumbing.
- sid + launch nonce per pane, minted as aterm mints them, derived from existing identity:
  `StablePaneId` (durable layout-leaf UUID, `src/shared/stable-pane-id.ts`) or the
  daemon-restart-stable `worktreeId@@shortUuid` (`src/main/daemon/pty-session-id.ts`),
  which `terminal show` already returns. The daemon currently sees only `sessionId`, not
  pane identity — that gap is the work.
- Registration into the shared socket directory and `graph/<sid>`, so peers resolve and
  relay to Orca panes with no protocol change.
- **Orca ships the client trio.** Orca's artifact carries no aterm binary today
  (`electron-builder.config.cjs:86`, `:172`), which would make both the exit criterion and
  the skill's instructions fail for Orca-only users. The whole agent-facing surface is
  small and dependency-free: `aterm-ctl` over two workspace crates with no third-party
  deps (`aterm-ctl/Cargo.toml:16-23`) plus `aterm-agent` in the same shape, producing
  `aterm-drive` and `aterm-fleet`. Bundle all three as extraResources.
- **An `aterm` dispatcher shim.** The skill says `aterm ctl` / `aterm drive` /
  `aterm fleet` — the single front door aterm's own distribution provides via argv0
  symlinks. Without a shim, every command in the skill is wrong for Orca-only users. The
  shim forwards `aterm <verb>` to the bundled `aterm-<verb>` and returns a clear error for
  GUI verbs it does not carry. It must **resolve a real `aterm` later in PATH first and
  exec that** — otherwise, prepended to managed-PTY PATH the way `orca` is, it shadows a
  full aterm.app install inside Orca panes and breaks `image`/`video`/`window` for users
  who have the real thing. What ships is a client only: `aterm agents install` lives in
  `aterm-cli` and stays out, since skill installation is Orca's provisioner (Phase 3).

**Authority: adopt aterm's mechanism, keep the policy in Orca.** aterm's model is
`SessionId` + launch nonce + a per-op edge table of unforgeable read/write/signal tokens,
handed to a child through a 0600 file rather than env (`env_sanitize.rs:41-86`,
`aterm-gui/src/lib.rs:3699`). `orca-daemon`'s current owner is a rebindable `client_id`
with one socket-wide token (`registry.rs:121`) — no per-pane answer at all. Orca mints
edges the same way, into the same `edges/` directory, at the same `ATERM_EDGE_TOKENS`
path; Orca's app connection is the owner connection, so owner-only verbs (`ls`,
`sessions`, `who`, `subscribe sessions`) stay owner-only. Workspace scoping becomes a
*mint-time policy* — which edges a pane receives — not a second mechanism, so broadening
it later (cross-worktree driving) needs no protocol change.

**Pre-bind design gate** — the socket must not be reachable until the above is written
and reviewed: principals, sid lifetime, stale-target behavior, token recipients, edge
minting and revocation, reattach rules, nonce rotation. Record explicitly that federating
makes Orca panes reachable by any same-uid process that can read the socket directory.
That is already aterm's stated trust boundary, but it is a change for Orca, where a pane
is reachable only through Orca's authenticated socket today.

**Exit.** The full verb matrix — not just `text` — passes against a live Orca pane, both
locally and *via relay from a separate aterm instance*; an in-pane agent's `aterm ctl ls`
enumerates non-Orca sessions; GUI-class verbs return `ERR unsupported`; every existing
`orca terminal` verb is unchanged; the threat model is reviewed and tested.

## Phase 1c — Isolation, made legible

**Power ships first.** The default is the most capable configuration: sessions do
anything, and any agent signed in as you can find and drive them. Phase 1b carries only
the *mechanisms* to narrow that — skipping `graph/<sid>` publication, and not binding at
all — because a kill switch must exist the moment exposure widens. This phase is about
making them clear, not about gating the capability behind them.

**Two controls, never one.** The axes point in opposite directions for an untrusted
agent: you want its capabilities low and your observability high. A single "security
level" slider would make the safest setting also the blindest, and would foreclose the
most useful configuration there is — a tightly contained agent you can still watch and
interrupt. So: two plainly-worded controls, no internal vocabulary.

**"What this session can do"** — over `aterm-containment`'s four modes:

| shown | mode | meaning |
| --- | --- | --- |
| Full access | `Master` | developer trust |
| Normal | `User` | standard safeguards — default |
| Limited | `Safety` | allowlisted operations only |
| No network or secrets | `Containment` | macOS Seatbelt denies network plus `.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.netrc` and the private-data set |

Launcher-owned via `ATERM_CONTAINMENT_MODE`, deny-listed from inheritance
(`env_sanitize.rs:112`) so a child cannot loosen itself; non-escalation and monotonicity
carry Kani harnesses; spawn fails closed when the OS sandbox wrapper is missing. UI copy
states the honest scope — OS enforcement is macOS-only today, general filesystem scoping
is deferred.

**"Who can watch and control it"** — the axis federation creates:

| shown | position | behavior |
| --- | --- | --- |
| Anything signed in as me | `federated` | default — registered and relayed, cross-drivable from any aterm |
| Only Orca | `private` | socket hosted, but **no shared-directory registration and no `graph/<sid>` publication** — reachable only by Orca and by holders of edges it minted |
| Nothing | `off` | no control socket (`ATERM_NO_CONTROL_SOCK=1`); Orca's own agent features go dark too, and the UI says so |

**One rule, stated once:** a workspace may only narrow what the global setting allows, and
an agent-spawned pane may only be narrower than its parent. Never wider. Same
non-escalation property the containment model already proves, applied to both axes.

**Legibility is the deliverable.** A narrowed pane says so in its own UI, fed by
`aterm_containment::log_denial`. Without it an agent hits a network denial and reports
"npm install failed", and a safety feature becomes support burden.

**Exit.** `private` is verified by a peer instance failing to *resolve the sid* — not
merely by absence from the socket symlink; `off` disables Orca's own introspection too and
labels the pane; a workspace cannot widen the global position; denials surface in the pane
UI; every option's label is comprehensible without reading this document.

## Phase 2 — One skill spine

Two skills, split by one question: *is Orca's runtime state the source of truth?*

**Deliverables**
- `drive-aterm` (aterm, compiled in) — the terminal as a terminal.
- `orca` (one skill) — worktrees, git and review state, task DAG, ownership,
  inbox/reply/dispatch, gates, automations, browser, emulator, pane lifecycle. Its
  terminal section is one instruction: get the sid, use the aterm skill.
- A test asserting **no command verb appears in both surfaces**, and that each
  frontmatter names the other exactly once as the escalation path.

**Exit.** Overlap test passes; guides regenerate; snapshot revisions bump.

## Phase 3 — Ownership and payload (local only)

**Deliverables**
- **Sidecar ledger** of `(owner, agent, path, digest, build)`, written atomically beside
  the install. Content stays byte-exact; ownership never lives inside the file. This is
  what lets Orca's digest model and aterm's marker model coexist, and what makes pruning
  decidable. Its **reader contract is defined here** and consumed by Phase 5.
- Payload emitted to `resources/skills/packages/<name>/` by
  `generate-skill-bundle-manifest.mjs`, with a build check binding bytes to
  `exactSha256`. No electron-builder change needed. **Done (2026-08-01):** all 8 packages
  emit (31,247 B), every `exactSha256` and `size` re-verified against the bytes
  independently of the generator, no CRLF, `verify:skill-bundle-manifest` exits 0 and
  fails closed on a one-byte edit. Leaves `electron-builder.config.cjs:57-58`'s comment
  ("never needs the skill package bytes") false — fix when the payload is committed.
- A provisioning-state type and one exported classifier — the existing inventory has no
  `absent` state and its classifier is private.
- **Package-atomic writes as a recoverable transaction**: staging, journal, swap,
  recovery-on-next-start, with fault injection at every rename boundary. The existing
  durable primitive renames one file and documents weaker Windows directory durability
  (`durable-file-write.ts:10`, `:54`).
- Synchronous write before a known agent launch, against that launch's resolved home.

**Exit.** The design doc's matrix passes, including dev↔stable↔downgrade round-trips and
a fault-injected crash at each rename boundary leaving no mixed revision.

## Phase 4 — Migration and compatibility

Owns everything the cut-over breaks. No phase owned this before.

**Deliverables**
- Permanent rename aliases for `orca-cli` → `orca`; the guide generator already requires
  aliases to be permanent (`generate-bundled-skill-guides.mjs:21`, `:39`).
- Adoption of exact-known legacy installs into the ledger; pruning of superseded stubs;
  duplicate-name detection that reports competing paths instead of installing blind.
- **One** `~/.agents/.skill-lock.json` policy, chosen: register atomically as part of
  provisioning, or leave npx-registered names entirely to npx. Not both.
- Downgrade restoration path.

**Exit.** An install carrying the old three skills converges to the new two with no
orphan, no duplicate activation, and a working downgrade.

## Phase 5 — PATH, standalone aterm, remote hosts

**Deliverables**
- Cross-platform managed-PTY shim. Windows places `orca.exe` — **not** `orca.cmd`, which
  deliberately refuses `orchestration send`/`reply`. macOS executes the bundled launcher
  at its real bundle path. SSH panes are out of scope: `buildPtyHostEnv` is explicitly
  not called for them (`src/main/ipc/pty.ts:1104`); remote resolution is the relay shim.
- aterm compiles the Orca discovery stub in, used only when no Orca CLI resolves. No
  manifest, no drop-dir, no trust model.
- aterm's agent table extended to the real per-agent skills dirs.
- aterm's writes made safe for automatic sync: cross-process lock, atomic
  compare-and-swap, and a read path distinguishing missing, unreadable, non-UTF-8,
  symlinked, and foreign instead of collapsing all of them to absent (`primer.rs:468`,
  `:501`).
- Remote provisioning over SFTP and WSL against the Phase 3 ledger contract. **SFTP
  atomic rename support is UNVERIFIED** — verify before designing on it.
- The CTA becomes a health surface: renders only when provisioning is blocked, naming
  the blocker.

**Exit.** `orchestration send` with a multi-line body round-trips in cmd.exe, PowerShell,
pwsh, and Git Bash; macOS and Linux PATH resolution tested; standalone aterm installs the
stub with no Orca present; two concurrent syncs cannot interleave; a remote host
provisions and re-provisions idempotently.

## Rollout (spans phases 3–5)

Locale keys for every changed string (the current CTA is fully translated); telemetry for
provisioning outcome and blocker class; a feature flag; and a rollback threshold. Without
these the failure modes are untranslated, unobservable, and hard to withdraw.

---

## Not in this plan

- **Pixels for Orca panes.** `image`/`video` over Orca's renderer is a separate
  renderer-provenance project, held to the bar aterm's `--meta` and `index.json` set. A
  lower-fidelity capture answering the same verb name is worse than `ERR unsupported`.
- **A generic provider bus for aterm.** The payload is a 4 KB pointer stub; a manifest
  schema, signature model, provenance headers, and collision arbitration are
  disproportionate — and the zero-touch trust rule is unenforceable, since Orca and aterm
  are separately installed apps with no shared installer or signature to anchor.
- **`context_block` injection.** Codex, Gemini, OpenCode, Grok, and Pi all have skills
  directories Orca already scans.
- **Claiming "always installed" where the install is eventual.** Say eventual where it is.

## Risks

| risk | mitigation |
| --- | --- |
| Phase 1a is an extraction from a 516 KB GUI-coupled file | Conformance suite first; aterm must pass it before `orca-daemon` is written |
| Authority reconciliation is where a wrong answer is a security bug | Pre-bind design gate; socket unreachable until reviewed |
| Ownership must hold across dev, stable, fork, and downgrade builds | Ledger records the build; snapshots decide freshness only |
| Managed markdown is executable policy | Same provenance bar as the existing status-hook writes |
| Phases 1a–1b are a real project; 3–5 are plumbing | Phase 3's payload work is independent and can ship first |
