# The ALab update architecture

One trust policy and one release-plan format across **Orca**, **aterm** (embedded and
standalone), and the **ALab toolchain** — working identically whether a machine has Orca,
aterm, or both.

Tags: `[PRESENT]` ships today · `[PARTIAL]` exists, not wired · `[GREENFIELD]` net-new.
All citations verified against this tree. **Fail-closed everywhere; the label never
out-runs the proof.**

---

## 1. What is true today

**Orca is unsigned and does not auto-update on macOS or Windows.** Ad-hoc launch seal
only, no Developer ID, no notarization, no Windows publisher
(`config/electron-builder.config.cjs:19-20,286`); `getUpdateInstallMode()` returns
`'manual'` for everything except Linux (`src/main/updater-install-policy.ts`), and the
native updater logs *"this platform uses manual releases; native updater stays dormant"*
(`src/main/updater.ts:1468`). This is the gate on everything else.

**Six install lanes exist, with four different trust bases.**

| Lane | Anchor | Ordering |
|---|---|---|
| Orca `electron-updater`, feed `alabsystems/orca-alab` | **none** on mac/win | semver prerelease compare |
| aterm self-swap (`renamex_np` + re-exec) | 3 additive tiers: REPO / SIG / APPLE | epoch `build_number` + `min_build` floor |
| atpkg signed index → delegated release key | Ed25519 root + delegation | `rev-list --count`; hand-set `index_build` |
| `companions.toml` — compiled in, rides aterm's *own* release signature, works with **no atpkg root key** | aterm's release signature | pinned 40-hex commit |
| `tools/install.sh` | **skips Ed25519; takes the expected Team ID from downloaded metadata** | numeric max of tags |
| Homebrew cask | Homebrew's | Homebrew's |

**Three verified defects.**

1. **The provenance gate does not cover the native artifacts.**
   `config/scripts/check-aterm-artifact-pin.mjs` hashes the two wasm blobs and checks the
   source commit; it never touches `orca_node.node` or `orca-daemon`. A stale addon can
   ship beside fresh wasm and nothing objects.
2. **The atpkg floor is best-effort.** `crates/atpkg/src/sig.rs:227-239` — an unreadable
   floor reads as `0`, and persisting an advance "never turns an already-passed check into
   a reject". It is a convergence mechanism, not an anti-rollback boundary.
3. **The index counter regressed in production.** Published tags are `atpkg-index-3`
   (older) then `atpkg-index-1` (newer, lower). Any client that saw 3 floor-refuses 1
   (`rust/aterm/tools/atpkg-programs.spec:14-22`).

**Three assets worth more than they look.** aterm's `RELEASES.ledger` is an append-only
claim protocol, 48 releases deep — the compare-and-swap allocator this design needs.
Orca already resolves its own release tag and pins a concrete generic feed
(`src/main/updater.ts:973,984,1009,1047,1486`) — the decision layer is already external.
`atpkg-keys` already signs exact raw bytes and its test **verifies and installs with the
real client** (`crates/atpkg-keys/tests/owner_to_client.rs`).

---

## 2. The architecture

### 2.1 Metadata roles

Four roles, TUF-shaped. One logical release snapshot, without one high-churn file that the
offline root must sign.

| Role | Lifetime | Signs | Held |
|---|---|---|---|
| **root** | long | keys, thresholds, scopes, rotation | **2-of-3 threshold, offline hardware** |
| **targets** (delegated, scoped per namespace) | medium | artifacts + compatibility tracks | signing host |
| **snapshot** | short | binds the whole target set by version, hash, length | online |
| **timestamp** | very short | points at the latest snapshot | online |

A single root-signed index would force the offline root to sign every release, expiry
refresh, and yank — turning offline hardware into a high-cadence availability dependency
and making delegation meaningless. Scoped delegations also stop one malformed `clean`
entry from making the Orca channel unverifiable.

**Compromise boundaries, stated plainly.** Targets-key compromise = user-level code
execution until revocation lands. Root-threshold compromise = total metadata trust loss,
**unrecoverable in-band** — an attacker can issue higher-version root metadata, install
their own delegations, extend expiry, and yank recovery builds indefinitely. Recovery is
an OS-authenticated replacement binary (§2.7), which is why a *second* root is not the
answer: it adds a forgery path without adding a recovery path. Network withholding is
denial of service with no key compromise at all. A long-offline client stays exposed to a
compromised delegation until its expiry.

Rotation retains every intermediate root version and requires old-plus-new threshold
authorization, so a machine offline across several rotations can walk the chain. **Expiry
never disables installed software** — it stops acquisition of new targets, nothing else.

### 2.2 Ordering

Every ordering value is **allocated by compare-and-swap**, never computed from a clock.
`max(last+1, now)` is not an allocator: two cutters reading the same `last` in the same
second collide. aterm's ledger already has the right primitive — claim remotely,
fast-forward atomically, retry a lost race, never reuse. Every allocation maps permanently
to one (source, build-inputs, artifact) tuple; failed releases burn their number;
publication never clobbers different bytes under an existing number.

Three distinct monotonic values:

- **`snapshot_version`** — every metadata change, including yanks and expiry refreshes.
  Metadata changes without any rebuild, so this cannot be folded into a build number.
- **`target_sequence`** — keyed by **component × channel × compatibility track**.
- **platform transport versions** where Electron, MSI, `CFBundleVersion`, or mobile
  packaging demands one.

Wall-clock survives only as `published_at` and expiry. As an ordering input it lets a
skewed cutter permanently jump the floor, crosses signed-32-bit boundaries in 2038, changes
a rebuild's identity when nothing meaningful changed, and treats time as trust on clients
that have no trusted clock.

**Compatibility eligibility is decided before sequences are compared.** A late security fix
on `orca/1.x/stable` needs a higher sequence *within that track*; under a global counter it
would read as an upgrade from 2.x. **Recovery downgrade is a forward move in metadata**:
publish a higher snapshot containing an explicit recovery target pointing at a retained
older digest. Never lower the control plane.

Air-gapped builders get a pre-claimed signed build ticket. A reproducibility rebuild reuses
its original claim; a republished rebuild is a different release with a new sequence.

### 2.3 Four identities

| Identity | Job |
|---|---|
| Component semantic/API version | real compatibility between components |
| Train version | what humans call the release |
| `target_sequence` | ordering, exclusively |
| Source revision + content digest | provenance |

One universal string cannot do this. `MAJOR.MINOR.0+g<sha>` is disqualified outright:
SemVer ignores build metadata for precedence, so two dev builds compare **equal** and
electron-updater rejects the second. `-fork.N` still dies — it tracks an upstream this repo
has diverged from — replaced by a train version, not by a permanently-zero patch that hides
which component moved.

### 2.4 One verification core, platform adapters

One Rust library authenticates metadata and selects **one exact immutable target**.
Everything platform-specific is an execution adapter behind it.

electron-updater 6.8.9 has no "install this verified file" API — `checkForUpdates()`
selects through a provider and privately establishes the state that `downloadUpdate()` and
`quitAndInstall()` depend on (`node_modules/electron-updater/out/AppUpdater.js:400`). So it
stays as Orca's **transport and stager**, behind a narrow adapter that exposes only the
selected target at a private monotonically-increasing transport SemVer. The digest and OS
identity are re-verified at the last safe point before commit.

This preserves behavior that is expensive to reproduce: macOS needs the authenticated
localhost feed and the Squirrel/ShipIt staging protocol (`MacUpdater.js:52`); Windows needs
NSIS argument, elevation-fallback, and Authenticode behavior (`NsisUpdater.js:31`); Linux is
four topologies, not one, and the current AppImage path unlinks the live image before moving
its replacement — not an acceptable transactional update.

### 2.5 Apply units and typed edges

Not a tree. Managed tools are shared by standalone aterm *and* Orca (two parents); mobile
and Git are peers, not children.

| Edge | Meaning |
|---|---|
| `contains` | ships inside another unit's artifact — **build provenance, never an independently selectable target** |
| `requires` | hard dependency with a version range |
| `compatible-with` | peer constraint: reported, never applied |
| coherence group | members apply atomically or not at all |

**The aterm apply unit inside Orca is four artifacts**: `orca_node.node` (monolithic —
it also exposes Git, SSH, config, networking), `orca-daemon` (which statically embeds a
second aterm copy), and the CPU and GPU wasm plus their generated glue. They move together
or the build is incoherent.

Keeping the engine bundled is the correct design, not a concession. Unbundling needs a
stable Rust dylib ABI (there is none), a new N-API compatibility contract, dynamic verified
module loading with CSP and worker changes, CPU/GPU wasm coherence, restart-gated
activation (Windows locks loaded DLLs), and hardened-runtime library validation for external
native code. If independent cadence is ever needed, ship an atomic engine pack with an exact
`hostAbi` and an embedded fallback, over a process/RPC boundary — not a raw dylib.

### 2.6 Monotone floors

> **Every writer may only raise a component's sequence. No writer may lower one.**

```
target(c) = max(installed, targets.pin[c], min_sequence, host_floor(c))
```

`max` is commutative, associative, and idempotent, so writer order cannot produce a wrong
result and there is no "who wins" question to arbitrate. The store lock prevents torn
writes, nothing more. This is what makes four independent writers to `/Applications/aterm.app`
a non-problem.

To make it a *security* boundary rather than only a convergence property, persist
`(root generation, channel, component/track, metadata version, metadata hash)`
**successfully before activation**, and treat a different hash at the same version as
equivocation rather than an acceptable alternate release. Also persist maximum-trusted-time
to detect backward-clock and VM-snapshot replay.

### 2.7 Bootstrap and recovery are permanently separate

**A binary cannot authenticate the root key embedded inside itself.** First installation can
never be reduced to the metadata path. Bootstrap requires an independently authenticated
installer — product-specific notarization/Authenticode, an OS package repository, or
Homebrew with an independently pinned digest and identity. **Homebrew stays a bootstrap
lane permanently.**

A **manual, OS-authenticated recovery installer** is break-glass, and per §2.1 it is the
only recovery from root compromise. It must exist before it is needed.

`tools/install.sh` retires into this lane. Its current form skips signature verification
*and* can take the expected Team ID from metadata it just downloaded, so a repository-write
attacker can substitute a different notarized team and payload.

### 2.8 Offline and rollback

Installed software runs indefinitely. Expired metadata cannot authorize a new download.
Verified retained artifacts can be repaired or rolled back against a durable authorization
receipt. Staged activation gets a bounded signed apply window. The **last health-confirmed
coherence group** is retained — not merely the numerically previous build. Sentinel
auto-revert is a recovery transaction: it atomically restores the whole group and creates a
**recovery hold** so the updater does not immediately reinstall the failure.

### 2.9 Publication

Artifacts and delegated targets publish **first**; the signed snapshot and timestamp publish
**last**, so a partially uploaded multi-platform release can never become selectable. Every
reference carries an immutable URL plus hash and length; existing tags and assets are never
clobbered. Signatures cover a **domain-separated envelope** (schema, role, root generation,
namespace, payload hash), and parsing rejects duplicate keys, unknown critical fields,
invalid path forms, and oversized or deeply-nested metadata — two parsers reading the same
signed bytes differently is a privilege-boundary failure.

**Metadata authenticity is not build provenance.** A compromised CI runner can hand a
legitimate key a malicious artifact. Promotion binds source revision, build inputs, artifact
digests, platform matrix, and a reviewed release record.

### 2.10 Scope: atpkg stays user-scoped

atpkg's safety rests on structural refusals, all verified: prefix strictly under `$HOME`,
chain-validated (`store.rs:206-220`); `bin/` **appended** to PATH, never prepended
(`store.rs:334-342`); shims colliding with `sudo`/`ssh`/`git`/`launchctl`/`osascript` refused
and reported (`store.rs:270-297`); 0700 owned-by-uid directories throughout; and **no
elevation surface anywhere in the crate.**

That stays. System integration that genuinely needs privilege uses the **OS's own
mechanism** for that one case — macOS bundle-contained `SMAppService`, a signed Windows
MSI/MSIX or narrowly scoped service installer, a distro package or a narrow polkit action.
A generic privileged tier would be a second security-critical package manager running as
root, and capability names do not bound effects: `launch-daemon`, `elevated-install`,
`system-prefix`, and `path-prepend` each reach arbitrary root execution. Consent for a root
daemon means "trust this publisher to ship future root code" — which is a publisher-level
decision, not a capability checkbox.

A per-user process also cannot safely mutate `/Applications`, `Program Files`, or a
distro-owned package. **Prefer per-user installs.** SSH and headless sessions get a defined
non-interactive failure: never silently elevate, never block on a GUI prompt.

---

## 3. aterm: embedded and standalone

Orca embeds aterm as a compiled apply unit (§2.5) and also installs `aterm.app` standalone.
They are the same source at the same commit, compiled to different targets, applied at
different moments.

**The hard pair.**

> Orca contributes a floor: the installed `aterm.app` sequence must be ≥ the sequence of the
> aterm source Orca's embedded unit was built from.

```
host_floor(aterm) = provenance.embeddedAtermSequence
```

A floor, not a pin — one more term in §2.6's `max`. The guarantee is exact and checkable:
**the aterm you launch is never older than the engine inside Orca.** A standalone aterm that
self-updated *past* the floor is never pulled back. The transient after an Orca update is
bounded by aterm's documented "at worst one launch behind"
(`crates/aterm-update/src/lib.rs:24-40`), and About shows the pending state rather than
claiming they match.

**Publish-time invariant:** targets metadata records the aterm sequence Orca's pinned
submodule commit produced, asserted at cut time. A cut whose floor is unreachable fails
closed — you cannot ship an Orca demanding an aterm nobody published.

**The artifact.** Prefer the channel; **ship a seed inside Orca's bundle** for first run,
offline, and channel-below-floor. `aterm.app` measures **24 MB** against an Electron app
already ~150 MB packed, and the nested inside-out signing machinery exists —
`aterm-release` already signs nested `atpkg`/`aterm-ctl`/`aterm-cli` before the outer bundle
seals them (`crates/aterm-release/src/sign.rs:20,256-260`). A network-dependent guarantee is
not a guarantee.

**Install, adopt, advance, or leave alone.**

| Situation | Behavior |
|---|---|
| Not installed | Install the seed to `/Applications`, or `~/Applications` if not user-writable. Ownership recorded in the **store**, never in the sealed bundle. |
| Installed, sequence ≥ floor | Adopt: verify identity, record ownership, take over the loop. No bytes move. |
| Installed, sequence < floor | Advance to `max(floor, channel pin)`; applies at aterm's next launch. |
| Installed, unverifiable | **Leave it alone.** Report `unmanaged — signature not recognized`. |

Identity verification is **product-specific** — expected bundle identity, designated
requirement or publisher chain, architecture, entitlements. A Team ID covers many binaries
and is not sufficient on its own.

**Consented once, honored permanently.** Installing a second app is not a silent act.
Declining does not degrade Orca — the embedded unit is what Orca uses.

**Four writers, no conflict.** Orca's coordinator, aterm's own updater, Homebrew, and
`install.sh` all only raise the sequence (§2.6). aterm's updater keeps running so a
notarized fix is never blocked by an inert index. Homebrew and `install.sh` refuse to
overwrite a managed install without `--force`. Uninstalling Orca drops the floor and the
ownership record but does **not** remove aterm.app.

**Two embeddings are two writers, not one client.** The shared store needs a schema/writer
version, with older clients refusing writes once a newer incompatible writer has migrated it.

---

## 4. Keys, pins, and environment

A **pin** is baked in at compile time via `option_env!` — unchangeable at runtime, empty is
the fail-closed default (`aterm-update-core/src/lib.rs:56-64`).

**Trust anchors:** `PINNED_PKG_ROOTKEY` ← `ATERM_PKG_ROOTKEY` (empty ⇒ atpkg inert) ·
`PINNED_UPDATE_PUBKEY` ← `ATERM_UPDATE_PUBKEY` (empty ⇒ Tier SIG skipped) ·
`PINNED_TEAM_ID` ← `ATERM_EXPECTED_TEAM_ID` (empty ⇒ Tier APPLE skipped).

**Identity, all derived:** `ATERM_DEFAULT_OWNER`/`_REPO` from `[workspace.metadata.aterm]
update_channel` = `alabsystems/aterm` — where installed copies *look for updates* ·
`ATERM_PUBLISH_OWNER`/`_REPO` from `[workspace.package] repository` = the private aterm dev repo
— the account the project *belongs to*, kept separate because atpkg's trust is
account-bound and following a mirror repoint would silently move its root
(`aterm-update-core/src/source.rs:33-46`) · `ATERM_APP_RELEASE_VERSION`,
`ATERM_BUILD_NUMBER`, `ATERM_GIT_COMMIT`, `ATERM_BUILD_TIME`, `ATERM_RUSTC_*`,
`ATERM_COMPILER_FLAVOR`, `ATERM_BUILD_PROFILE`, `ATERM_TRUST_VERIFY`.

**Owner secrets** live in `~/.aterm/release.conf` — parsed as `KEY=value` in-process, never
shell-sourced, refused unless owner-only-writable and owned
(`crates/aterm-release/src/sign.rs:1-45`). Three become build pins (`sign.rs:65-74`); the
rest are `ATERM_UPDATE_SIGN_KEY`, `ATERM_SIGN_ID`, and notarytool auth.

**Runtime knobs.** aterm: `ATERM_UPDATE_OWNER`/`_REPO`, `ATERM_UPDATE_INTERVAL_SECS`,
`ATERM_NO_AUTO_UPDATE`, `ATERM_NO_AUTO_APPLY`, `ATERM_NO_SEAMLESS_UPDATE`,
`ATERM_UPDATE_REEXEC`, `ATERM_UPDATED_FROM`. atpkg: `ATPKG_ACCOUNT`, `ATPKG_TOKEN`,
`ATPKG_REGISTRY`, `ATPKG_INDEX_REPO`, `ATPKG_DISABLE`, `ATPKG_UPDATE_INTERVAL_SECS`,
`ATPKG_SOURCE_BUILD`/`_NO_SOURCE_BUILD`, `ATPKG_MANAGED` (already means *"another manager
owns this store"*). Orca build: `ORCA_BUILD_IDENTITY` + `ORCA_POSTHOG_WRITE_KEY` (telemetry
gate as compile-time literals, so a shell export cannot enable transmission),
`ORCA_MAC_RELEASE`, `ORCA_RELEASE_*`, `ORCA_ALAB_PUBLIC_*`.

> **`ATPKG_ROOTKEY_OVERRIDE` replaces the compiled trust root from the environment.**
> Compile it out of shipping builds. This is a one-line fix and is not contingent on
> anything else in this plan.

**Key inventory.**

| Key | Status | Held |
|---|---|---|
| Apple Developer ID + notarization (Orca) | **missing — blocks everything** | keychain |
| Windows Authenticode / Trusted Signing (Orca) | **missing — blocks everything** | HSM / cloud |
| Apple Developer ID (aterm) | design-ready, dormant | login keychain |
| **ALab root role** | `[GREENFIELD]` | **2-of-3 threshold, offline hardware** |
| Targets delegations (scoped per namespace) | `[PARTIAL]` — schema exists, unpublished | signing host |
| Snapshot / timestamp | `[GREENFIELD]` | online |
| aterm Tier SIG key | `[PRESENT]` — retires into the role hierarchy | — |
| Per-machine GitHub token | `[PRESENT]`, optional | keychain → 0600 file → `gh` |

Minting is solved: `atpkg-keys keygen|pubkey|sign` generates Ed25519 keypairs, writes
secrets `0600`, and signs exact raw bytes; the client stays verify-only (`ring`,
`default-features = false`, no RNG, no alloc).

---

## 5. Consolidated surfaces

**One provenance module.** `src/shared/build-provenance.ts`, Orca's twin of aterm's
`build_info.rs`: `trainVersion`, `targetSequence`, `commit`, `commitDate`, `buildTime`,
`channel`, `feed`, `identity`, `embeddedAtermSequence`, and the resolved unit list.
Injected once at build time; read by main, renderer, CLI, telemetry, and crash reporting.
**Nothing else reads `package.json` at runtime.** This replaces eight scattered sources.

**One Version menu**, mirroring aterm's
(`crates/aterm-gui/src/menu.rs:862-875,888-894,1261-1317`): live title `v<version>` with a
trailing ⬆️ **while an update is staged only** — the badge means "act on this", so applying
clears it; the post-update celebration is a self-dismissing row.

| Condition | Item |
|---|---|
| staged | `⬆️ Update to v<X> — restart now` |
| just updated | `⬆️ Updated to v<X> just now` |
| always | `About Orca — build & versions…` |
| always | `Check for Updates…` — reuse `checkForUpdatesItem` verbatim so modifier-click routing survives (`register-app-menu.ts:92-108`) |
| staged | `Update details…` |

macOS: top-level, appended last (`register-app-menu.ts:318-325`). Windows/Linux: the same
items join Help, where `{ role: 'about' }` and `checkForUpdatesItem` already live for
non-mac (`register-app-menu.ts:310-315`); `Ctrl+`/`Shift+` labels per `AGENTS.md`.
`rebuildAppMenu()` already exists (`register-app-menu.ts:337-345`) and needs one call at
`src/main/updater.ts:247`. `{ role: 'about' }` is dropped — the system panel can only show
one version.

**One About surface**, showing apply units and edges:

```
Orca            <train> · ef188703b · seq 4821       [Check] [⬆️ Restart to update]
  aterm unit    0.5.0 · e268133              contains — diagnostics only
      orca_node.node · orca-daemon · cpu wasm · gpu wasm
  aterm.app     0.5.0 · seq 671              requires ≥ 671 — in sync ✓
  ALab toolchain  stable @ snapshot 137      managed — [Check] [Update]
      ay 18 · trust 4821 (rustc coherence group)
  Mobile companion  0.3.0                    compatible-with — App Store
  Git             2.43.0                     compatible-with — your system
```

`contains — diagnostics only` is the honest answer to "why can't I update the engine
separately", stated once in the UI instead of discovered as a bug report.

**Deleted.** `aterm-appcast.toml` and its parser · `PINNED_UPDATE_PUBKEY` as a distinct
anchor · `compareVersions`/`isPrereleaseVersion` · `updater-prerelease-feed.ts` tag
inference · Orca's atom-feed and `releases/latest` fallbacks · `publish/config.sh`
`VERSION_DEFAULT` · `-fork.N` · hand-set `INDEX_BUILD` · `install.sh`'s weak tier ·
`{ role: 'about' }` · `ATPKG_ROOTKEY_OVERRIDE` in shipping builds · `companions.toml` once
its bridge purpose completes. **Kept permanently:** Homebrew and the recovery installer
(§2.7).

---

## 6. The plan

**Track 0 — Unblock.** Obtain product-specific Apple Developer ID + notarization and a
Windows publisher identity. Nothing about signed distribution, nested notarization, or
automatic migration for existing mac/win users is possible before this. *Exit:* Orca ships
signed and notarized; `getUpdateInstallMode()` can return `'automatic'`.

**Track 1 — Truth.** Independent of Track 0; start now.
1. **Fix the provenance gate** to cover `orca_node.node`, `orca-daemon`, all glue and wasm,
   the exact source commit, and the local patch. *Exit:* a stale addon beside fresh wasm
   fails the lint.
2. **`build-provenance.ts`** + the four identities; delete the scattered version reads.
3. **Version menu and About**, off existing provenance. No new build inputs.
4. **Compile out `ATPKG_ROOTKEY_OVERRIDE`** in release builds.

**Track 2 — Trust.**
1. **Make the floor durable** — persist `(root generation, channel, track, version, hash)`
   before activation; same-version/different-hash is equivocation.
2. **CAS allocation** — `snapshot_version` plus per-track `target_sequence`, reusing the
   ledger's claim/fast-forward/retry protocol.
3. **Mint the 2-of-3 threshold root**; stand up targets, snapshot, timestamp; publication
   ordering and envelope rules (§2.9).
4. **Repair the legacy atpkg sequence at ≥ 4 under the old root.** Never republish at 1.
5. **Build the recovery installer** before it is needed.

**Track 3 — Convergence.**
1. **Exact-target adapter** in front of electron-updater; digest and OS identity re-verified
   before commit.
2. **Apply units and typed edges**; `atpkg status --json`; About renders them.
3. **Ship `atpkg` and the `aterm.app` seed**; nested notarization and entitlements pass.
4. **The hard pair** — install/adopt/advance/leave-alone; store writer-version discipline.
5. **Offline and rollback policy** — recovery holds, retained health-confirmed groups.
6. **Executed compatibility-range preflight** in the release gate: a range widens only after
   old-host × new-children actually runs.

**Migration.** Freeze and archive every legacy anchor, appcast, index, tag, Team ID, and
client floor location; **namespace new floors by root generation** rather than comparing them
numerically against legacy floors. Ship one bridge through every old lane — old atpkg clients
via an old-root-signed legacy index, standalone aterm via a dual-reader bridge on the old
appcast, Orca via the existing Electron feed at a transport SemVer above `1.4.147-fork.1`.
**Current macOS and Windows Orca installs have no authenticated update path, so that cohort
needs a manually installed, OS-signed bridge** — say so rather than pretending otherwise.
Dual-publish legacy and new metadata from one immutable release record; the bridge verifies
the old lane, installs the new root generation, records a signed migration marker, and shadows
both decision engines before the new one becomes authoritative. **Never use an environment
root override for migration.** Canary user-scoped packages first, exercising offline return,
corrupt state, partial publication, concurrent writers, and coherence-group rollback. Retain
bridge metadata and rotation chains indefinitely.

**Submodule discipline:** aterm-side changes land in the aterm repo and arrive by pin bump;
`check:aterm-pin` fails on uncommitted submodule changes, by design.

---

## 7. Risks

1. **No signing identity.** Blocks nested notarization, the second anchor, the Windows story,
   and automatic migration for existing mac/win users.
2. **The provenance gap is live.** A stale native addon can ship today with no gate objecting.
3. **The mac/win cohort cannot be migrated automatically** — they have no authenticated update
   path at all. Manual OS-signed bridge, or manual reinstall.
4. **Root-threshold compromise is unrecoverable in-band**, by construction. The recovery
   installer is the only answer and must exist first.
5. **The seed enlarges Orca's signing surface** — a nested signed app bundle inside a notarized
   Electron app, surviving `verify:macos-entitlements`. Never done in Orca.
6. **Orca has no rollback.** `installer-handoff` has no equivalent of aterm's sentinel revert.
7. **Two atpkg embeddings racing one store** without writer-version discipline.

## 8. Open questions

1. Timeline and cost for the Apple and Windows signing identities.
2. Does Orca ship the toolchain to end users, or only ALab machines?
3. Does the standalone aterm ship on Windows and Linux, or is the hard pair macOS-only in v1?
4. Per-user or machine-scoped Orca installs? Per-user is materially cheaper.
5. Transparency log or witness co-signature — accept root compromise as undetectable, or take
   on the machinery?

None of these block Track 1.

---

## 9. Execution — the first commits

Ordered. Each is independently shippable, leaves the tree lint-clean, and needs nothing
from Track 0.

**1. Compile out the trust-root escape hatch** — `rust/aterm`
`crates/atpkg/src/lib.rs`, `cli.rs`, `discovery.rs`, `sig.rs` — gate every
`ATPKG_ROOTKEY_OVERRIDE` read behind `#[cfg(debug_assertions)]` or a `dev-escape-hatch`
feature. *Test:* a release-profile build ignores the variable; a unit test asserts the
override is unreachable in release.

**2. Close the provenance gap** — `config/scripts/check-aterm-artifact-pin.mjs` +
`src/renderer/src/lib/pane-manager/aterm/aterm_wasm_artifact_pin.json`. Extend the manifest
to record SHA-256 and byte length for `native/orca-node/orca_node.node` and
`rust/target/release/orca-daemon` alongside the eight wasm/glue artifacts; verify all ten
offline. *Test:* rebuilding wasm without rebuilding the addon fails `pnpm run check:aterm-pin`.

**3. One provenance record** — new `src/shared/build-provenance.ts`; producer in
`electron.vite.config.ts` (replacing `computeOrcaBuildInfoLiteral`). Fields:
`trainVersion`, `targetSequence`, `commit`, `commitDate`, `buildTime`, `channel`, `feed`,
`identity`, `embeddedAtermSequence`, `units[]`. Migrate `ORCA_BUILD_INFO` readers
(`GeneralUpdateSettingsSection.tsx`, telemetry, crash reporting). *Test:* a grep gate —
no runtime `package.json` version read outside the producer.

**4. Version menu + About** — `src/main/menu/register-app-menu.ts` (new menu; Help group
off-mac; drop `{ role: 'about' }`), one `rebuildAppMenu()` call at `src/main/updater.ts:247`,
`src/main/index.ts:2172` threading update state, apply-unit rendering in
`GeneralUpdateSettingsSection.tsx`, strings in `src/renderer/src/i18n/locales/*.json`,
coverage in `register-app-menu.test.ts`. *Test:* the ⬆️ badge appears on a staged update and
clears on apply; About lists Orca and the aterm unit with their edge labels.

**5. Durable floor** — `rust/aterm` `crates/atpkg/src/sig.rs`. Persist
`(root generation, channel, component/track, metadata version, metadata hash)` successfully
*before* activation; treat same-version/different-hash as equivocation; a failed write fails
the check closed instead of passing. *Test:* an unwritable floor path refuses activation;
a replayed same-version different-hash index is rejected.

Items 1, 2, and 5 are defect fixes with value independent of the rest of the plan. Items 3
and 4 are the surface consolidation. Items 1 and 5 land in the aterm repo and arrive in Orca
by pin bump.
