# Unified agent surface: aterm introspection + Orca runtime

The rationale and the evidence. The sequence and the exit criteria live in
[`unified-agent-surface-plan.md`](./unified-agent-surface-plan.md).

## 1. What is actually true about the two products

**Orca embeds aterm's engine, not aterm's control plane.** `rust/crates/orca-terminal/Cargo.toml:23`
declares exactly three aterm dependencies: `aterm-core`, `aterm-grid`, `aterm-types`.
Orca links the PTY→grid hot path (`rust/Cargo.toml:64` carries per-crate release profile
overrides for `aterm-core`, `aterm-grid`, `aterm-parser`, `aterm-scrollback`,
`aterm-grapheme`, `aterm-vi`, `aterm-selection`, `aterm-search`) and none of
`aterm-ctl`, `aterm-uds`, `aterm-session`, `aterm-gui`, `aterm-net`.

So the introspection surface was built twice, at two layers, over one engine.

**aterm's control plane is strictly richer at the terminal layer.** From `aterm ctl --help`
on the installed build:

| capability | aterm `ctl` | `orca terminal *` |
| --- | --- | --- |
| screen / cursor text | `text`, `screen`, `cursor` | `read` (cursor paging) |
| command blocks, turn ledger, search | `blocks`, `history` (512-record), `search` | — |
| pixels | `image` (PNG; `--bytes` base64 for remote drivers; `--meta` fingerprint + phase/raster/paint/geometry; `plain`; `read` for inline OSC-1337), `window` (incl. platform chrome) | — |
| video | `video` 0.5–60 s of WSI-submitted frames → `frame_NNNN.png` + `index.json`; `keys` keystroke log, `fps=`, `budget=`, `pace`; `video status` / `video stop`; **`video frames [count=N]`** returns the N highest-delta frames so an agent pulls only eventful keyframes; `index.json` reports honest coverage (`head_truncated`, `evicted_frames`, `ring_skipped`, `covered_us` vs `requested_ms`) and supports key→frame latency measurement | — |
| live stream | `subscribe` (screen, cursor, cells, bytes, events, sessions; `timestamps`) | — |
| real transition waits | `turn`, `await`, `ready` — verdicts, exit 124 on timeout | `wait --for exit\|tui-idle` (heuristic) |
| layout | `panes` (per-pane `session=<sid> rect=… focused=…`) | `split`, `switch` |
| presence | `who` (driving / watchers / turns), `sessions`, `family`, `whoami` | — |
| addressing | `@<sid>` any session of any same-user instance, relayed transparently; owner-only gating; capability edges (read/write/signal); remote dial over TLS | handle scoped to one running Orca |

And the inverse: aterm has no concept of a worktree, a repo, review state, a task DAG,
ownership, an inbox, an automation, an embedded browser, or an emulator.

**The consequence for the skills.** `orca-cli`'s Terminals section
(`skill-guides/orca-cli.md:172-208`) is a strict subset of aterm's introspection minus
pixels, video, streaming, and the block/history/search ledger — plus pane *lifecycle*
verbs (`create --worktree`, `split`, `rename`, `switch`, `close`) that are genuinely
Orca UI operations. Its guidance reads the way it does — read before send, page by
cursor, `wait --for tui-idle` with a mandatory timeout — because the surface it was
written against cannot do what `turn` / `await` / `who` do. That is the weaker
environment showing through, not a documentation defect.

## 2. The unified design

### Move 1 — one control plane

**Federate, do not bridge.** `orca-daemon` is another aterm instance: its socket goes in
the shared per-user directory — `$XDG_RUNTIME_DIR/aterm`, else
`$HOME/Library/Application Support/aterm` (`aterm-uds/src/lib.rs:75`) — and its panes
publish into the `graph/<sid>` namespace discovery already reads
(`control_socket.rs:129`), so the existing relay resolves them with no new concepts: one
`aterm ctl ls` enumerates aterm tabs and Orca panes alike, and TLS dial and `aterm fleet`
reach Orca panes for free. Do **not** pin `ATERM_CONTROL_SOCK` in a pane — that traps an
in-pane agent on Orca's socket and rebuilds the island federation exists to remove. aterm
deny-lists the variable from inheritance for the same reason (`env_sanitize.rs:116`).

**The dispatcher is an extraction, not a link.** Verb dispatch lives in `aterm-gui`,
entangled with the winit event loop, so this move begins by lifting it into
`aterm-control` behind a `SessionHost` trait; `orca-daemon` is then the second host. Once
it is, `aterm ctl @<sid> text | blocks | history | search | await | turn | subscribe |
send | paste | key` works against Orca panes — each carrying a stable aterm `sid`,
surfaced in `orca terminal show --json` — and `orca terminal read/send/wait` become thin
retained aliases.

**Orca ships no aterm binary today.** `rust/**` is excluded from asar; only `orca-daemon`
and `orca_node.node` ship as extraResources (`electron-builder.config.cjs:86`, `:172`), so
every command in the skill is currently wrong for an Orca-only user. Co-shipping is cheap:
`aterm-ctl` is std-only over two workspace crates with no third-party dependencies
(`rust/aterm/crates/aterm-ctl/Cargo.toml:16-23`), and `aterm-agent` is the same shape,
producing `aterm-drive` and `aterm-fleet`. The hazard is the `aterm` front-door shim that
makes those reachable under the names the skill actually uses: prepended to managed-PTY
PATH the way `orca` is, it shadows an aterm.app install inside Orca panes unless it
resolves a real `aterm` later in PATH and execs that first — breaking
`image`/`video`/`window` for exactly the users who have the real thing. `aterm agents
install` stays out, by Move 3's one-writer-per-path rule.

**The boundary that is not free.** `image`, `video`, `window`, `chrome`, `controls`, and
`inspect` are aterm-*GUI* verbs: they capture aterm's own rendered frames
(`rust/aterm/crates/aterm-gui/src/cast.rs`, `control.rs:2257`) — the WSI-submitted
destination, bound to a real present transaction. Orca renders in Electron, so they cannot
serve an Orca-hosted sid by linking a crate: those sids answer `ERR unsupported` for that
class, while engine-layer verbs work everywhere. Reimplementing the contract over Orca's
own renderer, at the frame-provenance bar `--meta` and `index.json` already set, is its
own project — out of scope here.

**Authority: adopt aterm's mechanism, keep the policy in Orca.** aterm mints per-op
read/write/signal edges per child into a 0600 file rather than env
(`env_sanitize.rs:41-86`); `orca-daemon`'s owner is a rebindable `client_id` holding one
socket-wide token (`registry.rs:121`) — no per-pane answer at all. Orca mints edges the
same way at the same `ATERM_EDGE_TOKENS` path, its app connection being the owner
connection, so workspace scoping is *mint-time policy* — which edges a pane receives —
not a second mechanism. A wrong answer here is a security bug: the socket must not bind
until that design is reviewed.

### Move 2 — one skill spine, layered by authority domain

Two always-present skills, split by the only question with a stable answer: *is Orca's
runtime state the source of truth?*

- **`drive-aterm`** (aterm, compiled into the binary, `primer.rs:98`) — a terminal as a
  terminal: observe, act, await real transitions, address any session anywhere.
- **`orca`** (one skill) — worktrees and repos, git and review state, the task DAG,
  ownership, inbox/reply/dispatch, gates and coordinator loops, automations, the
  embedded browser, the emulator, and pane lifecycle. Its terminal section shrinks to:
  get the sid from `orca terminal show --json`, then use the aterm skill.

`orca-cli` retires as a separate always-installed skill.

This replaces a prose disambiguation clause, which would re-open the negotiation on
every new verb. The boundary is checkable: **assert no command verb appears in both
skills' surfaces**, and assert each frontmatter names the other exactly once as the
escalation path. Enforced by test, not by wording.

The payoff is not fewer files. `wait --for tui-idle` with a mandatory timeout is a
heuristic standing in for a transition the engine can report; `turn` verdicts with exit
124 are the transition. Cursor-paged `read` stands in for `subscribe`. "Show me what the
agent saw" is impossible today and becomes `video frames count=8`.

### Move 3 — delivery: compile in, do not build a provider bus

A generic provider drop-dir (`~/.config/aterm/agent-skills.d/*.json`) is a **non-goal**:
the payload is a ~4 KB pointer stub whose real content is served by `orca skills get`
(`src/cli/handlers/skills.ts`), and a manifest schema, signature/trust model, provenance
headers, collision arbitration, pruning ledger, and a second ownership system is a large
security surface to deliver a pointer. Trust makes it worse, not better: Orca and aterm
are separately installed apps with no shared installer or signature to anchor a zero-touch
rule to, and a user-owned JSON file carries no evidence of which installer wrote it.

Replace it with **exactly one writer per path**, chosen by what is installed:

- **Orca installed** → Orca's provisioner owns the skill paths. aterm never writes them.
- **Standalone aterm, no Orca** → aterm's compiled-in copy of the stub, written by the
  machinery that already ships `drive-aterm`. No manifest, no drop-dir, no trust model.
- Ownership is recorded in a **sidecar ledger** (below), so the two never both claim a
  path, and either can detect the other's.

Detection is "does the Orca CLI resolve" — the same question the stub itself answers.

## 3. Provisioning, corrected

### 3.1 Ownership: the constraint that dictates the rest

**Orca's and aterm's ownership protocols are mutually exclusive as designed.** Orca
identifies its files by exact content: the observed file list and normalized hashes must
match a shipped snapshot (`skill-package-identity.ts:125`, `:225`). aterm identifies its
files by an `<!-- aterm skill … -->` marker *inside* the file; a file without one is
`Foreign` and is never touched (`primer.rs:139`). The shipped Orca stub carries no aterm
marker (`skills/orchestration/SKILL.md:1`). So:

- if aterm prepends its header, Orca sees modified bytes and classifies them
  `unrecognized` **permanently** — its updater stops forever;
- if aterm writes Orca's exact bytes, aterm sees `Foreign` and can never update or
  remove what it installed;
- if two writers use the same generic marker, each reads the other's file as `Stale` and
  is authorized to overwrite it.

**Resolution:** installed content stays **byte-exact** (no injected header), and
ownership lives in a sidecar ledger of `(owner, agent, path, digest, build)` records
written atomically beside the install. Both products read the ledger; neither infers
ownership from file content. Pruning, provider removal, renamed skills, and changed
target paths all become decidable — which the marker model cannot do, because
enumeration is driven by the current `skills_for()` table and a removed entry's paths
are no longer enumerable (`primer.rs:112`, `:570`).

The ledger also fixes a second identity gap: the snapshot registry is **not** "every
byte Orca ever shipped." Released history is append-only guarded
(`config/scripts/skill-release-history-stability.mjs:141`), but the generator drops and
recomputes the unreleased tail (`generate-skill-bundle-manifest.mjs:416`), and a
downgraded binary cannot know snapshots minted after it was built. Dev, staging, and
fork builds therefore classify each other's legitimate output as user-owned
`unrecognized`. Use snapshots for *freshness*; use the ledger for *ownership*.

### 3.2 Ship the payload

`resources/skills/` ships three identity artifacts and no content. The stubs are tiny
(31 KB for all eight; 4.2 KB for `orchestration`) and are discovery stubs by design —
the guide is served by the binary, so it cannot drift from the running build.

Emit `resources/skills/packages/<name>/…` from
`config/scripts/generate-skill-bundle-manifest.mjs`. **No packaging change is required**:
`resources/skills/**` is excluded from asar (`electron-builder.config.cjs:193`) while the
whole directory is copied recursively through `extraResources` (`:59`). Note that
entry's comment says the bundle "never needs the skill package bytes" — that intent is
being reversed deliberately, for 31 KB. Add a build check that every
`manifest.skills[].files[].exactSha256` matches the copied bytes.

### 3.3 The provisioner needs new API, not the existing inventory

The freshness inventory cannot be consumed as-is:

- `SkillFreshnessStatus` has no `absent` state (`src/shared/skill-freshness.ts:42`), and
  an `ENOENT` candidate is silently dropped rather than reported
  (`skill-freshness-placement-observation.ts:143`);
- the actual classifier is private to that module (`:22`);
- `observeSkillPackage` assumes a local directory and has no remote filesystem
  abstraction (`skill-package-identity.ts:141`).

So: introduce a dedicated provisioning-state type, export one authoritative classifier,
and put it behind filesystem adapters (local / SFTP / WSL). The decision table itself is
unchanged — install when absent, update when ours-and-older, never touch
`unrecognized`, never touch a topology outside `canonical-copy` / `provider-alias`.

Writes must be **package-atomic**, not file-atomic: `writeFileDurable` renames one
string over one destination (`src/main/durable-file-write.ts:54`), while the manifest
schema permits multi-file packages (all eight current ones happen to hold only
`SKILL.md`). A crash mid-package yields a mixed revision, which classifies as
`unrecognized`, which the never-touch rule then makes unrepairable. Stage the package in
a sibling directory, verify, swap.

### 3.4 Interop with `npx skills`

`skills update` is lock-driven and never reads disk: `readGloballyUpdatableSkillLocks`
reads `~/.agents/.skill-lock.json` — or `$XDG_STATE_HOME/skills/.skill-lock.json` when
that variable is set, which is the standard Linux desktop case
(`skill-update-registration.ts:20-21`) — and `eligibleSkillUpdateNames` skips any name
absent from it (`skill-freshness-eligibility.ts:16-17` — "an unregistered copied bundle is installed but
`skills update` cannot identify its source"). It also pulls repository HEAD, which is
legitimately ahead of the bundled build (`skill-update-convergence.ts:17`).

Consequences, both real:

- a provisioner-installed skill with no lock entry is permanently ineligible for the
  existing update rail;
- with a **stale** lock entry from a prior npx install, the name stays eligible, the user
  clicks Update, `skills update` compares lock against source, writes nothing, reports
  success, and the rescan reports failure — a visible "update available → update fails"
  loop.

Pick one owner per name: either update `.skill-lock.json` atomically as part of
provisioning, or detect npx-registered ownership and leave that name entirely to npx.
Do not write the file and ignore the lock.

### 3.5 Agent homes

**Every target agent already has a skills convention.** `skill-discovery-sources.ts`
scans `~/.codex/skills`, `~/.claude/skills`, `~/.grok/skills`,
`~/.config/opencode/skills`, `~/.pi/agent/skills`, `~/.gemini/skills`, plus the
cross-agent `~/.agents/skills` root, with the comment "`npx skills add --global` writes
into each agent's own home skills directory." aterm's single-agent table
(`primer.rs:109`) is an aterm limitation, not evidence about the agents — so
`context_block` injection is a **non-goal**, and aterm's agent table extends to the real
per-agent skills dirs instead.

`~/.agents/skills` is a candidate single target that would replace the fan-out entirely
— **UNVERIFIED**: this repo proves Orca *scans* it, not that each harness *reads* it.
Verify per harness before choosing it over per-agent dirs.

### 3.6 Delivery paths, corrected

- **SSH panes do not get local env injection at all.** `buildPtyHostEnv`'s contract is
  explicit: "Do NOT call when `args.connectionId` is set (SSH): every injection is
  host-loopback or references local filesystem paths meaningless to a remote shell"
  (`src/main/ipc/pty.ts:1104`). The PATH shim and `ORCA_CLI_COMMAND` never reach a
  remote shell. Remote CLI resolution is the relay shim `~/.orca-relay/bin/orca`
  (`ssh-remote-cli-host-passthrough.ts`), so remote provisioning must ride the relay
  deploy.
- **The cited SSH/WSL "rails" are not filesystem provisioners.** The SSH passthrough
  runs the *host's* CLI and explicitly refuses to import remote PATH/userData
  (`ssh-remote-cli-host-passthrough.ts:49`, `:134`); the WSL installer manages an
  `orca-ide` launcher and PowerShell bridge (`wsl-cli-installer.ts:200`). Remote
  provisioning is a new subsystem with its own compare-and-swap, hashing, and stamping —
  not a small extension.
- **Windows shim must place `orca.exe`, not `orca.cmd`.** The shipped
  `resources/win32/bin/orca.cmd` deliberately refuses `orchestration send` and
  `orchestration reply` because "cmd.exe reparses `%*` and can execute/truncate embedded
  newlines" — a `.cmd` shim would break exactly the commands this design exists to
  enable. Define and test the contract across cmd.exe, Windows PowerShell, pwsh, Git
  Bash, PATHEXT, and direct spawn; on macOS execute the bundled launcher at its real
  bundle path.
- **Stamps must key on targets, not home mtimes.** Editing a skill in place changes the
  file's mtime, not `~/.claude`'s; deleting one changes a nested directory. Key the
  stamp on each target's existence, type, size, mtime, and expected digest.
- **Locking does not survive shared homes.** The hook lock deliberately refuses a lock
  owned by another host, because shared SSH homes have unrelated PID namespaces
  (`managed-hook-install-lock.ts:81`). That is correct for hooks and cannot deliver
  self-healing across hosts on one NFS home; iCloud/Dropbox replication is not a
  distributed lock either. Use content compare-and-swap plus one documented precedence
  rule for stable / dev / fork / external writers.
- **aterm's current writes are not safe under automatic sync.** Primer updates are
  read-transform-`std::fs::write` with no lock, atomic rename, or mode preservation
  (`primer.rs:468`), and every read error — including invalid UTF-8 — collapses to
  `Absent`, after which install overwrites the path (`:501`, `:417`). Making sync
  automatic turns rare races into routine data loss. Add a cross-process lock and atomic
  compare-and-swap that distinguishes missing, unreadable, non-UTF-8, symlinked, and
  foreign.

### 3.7 The guarantee, stated honestly

"Always installed" does not follow from the steps above. Remaining paths to an agent
with no usable skill:

- provisioning on idle after first paint loses the race with an agent launched at
  startup;
- an agent home created after startup is not revisited until a version change;
- `unrecognized`, external-link, symlinked, independent-copy, read-only, and plugin
  placements are deliberately never written;
- a per-PTY `CODEX_HOME` (`src/main/ipc/pty.ts:1237`) differs from the `homedir()`-derived
  discovery roots (`skill-discovery-sources.ts:63`);
- remote hook writes are best-effort and do not block SSH startup
  (`remote-managed-hook-installers.ts:97`);
- a WSL distro or SSH host created after a success stamp stays unprovisioned;
- a moved or uninstalled Orca leaves an absolute content path dangling;
- duplicate skill *names* across plugin cache, user copy, and global copy are not
  deduplicated — discovery dedupes canonical paths only (`discovery.ts:254`) — so the
  Orca stub may not be the one the harness activates. **UNVERIFIED**: harness precedence
  for duplicate names is not defined in this repo;
- tmux servers and nested shells retain a PATH predating the managed PTY.

**Settled by experiment (2026-08-01).** Claude Code resolves a skill written to disk
*after* session start: a probe skill absent from the session's listing was invoked by name
and resolved. A mid-session write can therefore serve the session it was written for on
that harness. Version-scoped, not a general law; other harnesses unmeasured.

What makes the guarantee **unconditional** is still provisioning as a **synchronous
precondition of a known agent launch** — resolve that launch's actual home, write before
spawn, retry a failed host before spawn — with everything else eventual repair. Say
"eventual" where it is eventual.

## 4. Test contract

- Retained `orca terminal` aliases resolve to the same sid the aterm path addresses.
- Ledger: byte-exact installs, one owner per path, ownership survives a marker-free file,
  and a removed owner's paths are still prunable.
- Identity: dev↔stable↔downgrade round-trips do not classify each other's output as
  user-owned.
- Provisioner matrix: absent, `current`, `outdated`, `newer-known`, `unrecognized`,
  symlinked-into-repo, plugin-cache, read-only home, non-UTF-8 file at the path.
- Package atomicity: crash mid-multi-file-package leaves either the old or the new
  package, never a mix.
- Lock interop: a provisioner-managed name is never offered to `skills update`; a
  pre-existing npx-managed install never enters the "update available → update fails"
  loop.
- Windows: the shim resolves `orca.exe`; `orchestration send` with a multi-line body
  round-trips in cmd.exe, PowerShell, pwsh, and Git Bash.
- Pre-launch: an agent spawned immediately at app start finds its skill already written.
- Duplicate-name detection reports competing paths instead of installing blind.
- aterm: concurrent syncs cannot interleave writes; unreadable/non-UTF-8/symlinked files
  are never treated as absent.

## 5. Known consequences

- **User-modified copies stay modified forever.** `unrecognized` is never overwritten;
  that is the one case where the banner still appears, as a health signal.
- **The install is eventual on several paths** (§3.7). Any UI copy must not claim
  otherwise.
- **Automatic writes into agent homes are a prompt-injection surface**, not a benign
  markdown copy: managed markdown is **executable policy** for threat-modeling — an agent
  runs commands because markdown told it to, so the absent exec bit is irrelevant to the
  threat. Already Orca's established behavior for status hooks, which is a reason to hold
  both to the same provenance bar, not a reason to relax this one.
- **Federating widens reach.** Registering in the shared socket directory makes an Orca
  pane resolvable and drivable by any same-uid process that can read that directory —
  already aterm's stated trust boundary, but a change for Orca, where a pane is reachable
  only through Orca's authenticated socket today. Narrowable per pane.
- Whether the current CTA is Claude-only is **UNVERIFIED**: the command carries no agent
  selector (`agent-feature-install-commands.ts:13`) and the external CLI's behavior is
  not in this repo.
