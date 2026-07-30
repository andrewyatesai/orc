# Upstream Sync v1.4.150 → v1.4.161 — Audit and Merge Plan

**Status: plan, not in progress.** Written 2026-07-30 to be picked up cold.
Produced by a full audit of every unmerged upstream commit (multi-agent
categorization of all 267, spot-verification of top claims against this tree by
`rg`/`git show`, plus a loss audit of the previous merge).

## Where we stand

- Last upstream sync: `478e0eabf3` — full merge of **stablyai/orca v1.4.150**
  (431 commits). Upstream is now at **v1.4.161** (stable) / v1.4.162-rc.1.
- **267 upstream commits are unmerged**, zero patch-equivalents on our side
  (`git log --cherry-pick --right-only HEAD...upstream/main` = 267).
- The fork carries ~1,369 own commits over the merge-base.
- **The v1.4.150 merge lost nothing by accident** (audited 2026-07-30): every
  upstream file absent from HEAD is a documented engine replacement (xterm.js /
  Node daemon), a Rust-port deletion with the crate mirror verified (pattern
  held for upstream's #10299 setup-script hardening), a policy removal
  (hosted CI, casks, non-allowlisted docs), or was restored (`91dc77d412`, the
  26 reference docs, verified byte-identical). No dangling imports; no
  fork-authored reverts of upstream features.

**Verdict: the fork is not currently a strict superset of upstream.** It is far
ahead on everything it owns (engine, daemon, Rust core, verification, security
posture, release engineering — see `alab-typescript-first-core-strategy.md` and
`security-audit-2026-07.md`), and it shipped ~142 ports of *open* upstream
issues ahead of upstream. But 11 releases of upstream fixes and features are
missing, and several of those bugs are **confirmed live in this tree today**
(next section). Closing the gap = one disciplined merge + a cadence change.

## Confirmed live in this tree (spot-verified 2026-07-30)

| Upstream | What | Evidence here |
| --- | --- | --- |
| `f10b6de2c7` | Mobile Relay connect-loop: host-proof validation rejects a few seconds of clock skew | `src/main/runtime/relay/relay-host-proof.ts:104` — `issuedAt <= now`, no ±30s tolerance |
| `9a8e21a47e` | Workspace-space scans stall host / OOM renderer at ~300 worktrees | `src/main/workspace-space-analysis.ts` present, uncapped |
| `4543bb6826` | React #185 crash class from Activity portal readiness oscillation (14 field crash stacks upstream) | `ActivityPortal` referenced in `src/renderer/src/components/Terminal.tsx` |
| `db01879043` | **Security**: remote worktree can fail-open and spawn its terminal through the LOCAL daemon | spawn-routing layer is upstream-derived here |
| `cf513adddc` | Claude 5 family / GPT-5.6 usage priced at $0 | no pricing entries for fable/opus-5/sonnet-5 in `src/main/claude-usage/` |
| `64aa726301` | Quick Open breaks past 10k files | `src/shared/quick-open-readdir-budget.ts` present, pre-fix |
| `7f3c95a585` | Every named ref in git history mis-categorized (`--end-of-options` echo, all git 2.25–2.49) | `src/shared/git-history.ts` retained |
| `38e9581758`/`560f853a40` | Markdown edit loss (blur/switch/quit before debounce; floating-workspace save route) | editor code retained |

If the v1.4.161 merge lands within days, take these via the merge. If it will
sit for weeks, cherry-pick this table first — each is small except `db01879043`.

## The 267, categorized

~171 fixes · ~26 features · 30 perf · 2 security · ~15 infra · ~10 test ·
6 release · 3 docs · 2 reverts · 5 chore. Roughly 200 are engine-orthogonal and
merge cleanly (class A). The rest fall into three named classes below.

### Class B — reconcile, don't merge mechanically

1. **Orchestration cluster** — `cd05f2ff93` (connected-server workers, ~3k
   lines in `db.ts`), `dca0db38c4` (schema-skew repair, SCHEMA_VERSION 17→18),
   `363e478909`+`dde72f85de` (worker preservation across updates — a pair,
   apply as a unit), `77d4c64f7a`/`0660ad9d6e`/`76b6c137c6` (legacy-mail
   read-only). **This is the hardest item in the merge**: our store moved to
   Rust (`rust/crates/orca-runtime/src/orchestration_schema.rs`, v1→v8 ladder;
   the TS twin is deleted) while upstream's TS `db.ts` evolved to v18 on a
   different lineage. Upstream's semantics must be re-expressed against the
   Rust store; migration numbering must not be blindly adopted. Also reconcile
   with our fail-closed unattended dispatch (`304ace7e45`) and gate wiring
   (`2ebbe5f8fb`).
2. **`a40183389b` SSH reconnect fan-out recovery** (~20k insertions, 125
   files) — rewrites the exact renderer store slices (`terminals.ts`,
   `worktrees.ts`) our aterm pane glue hangs off. Highest-conflict single
   commit; also the highest-value for our SSH emphasis. Merge in its own
   sitting, parity + e2e after.
3. **Plugin system** — `97e4776dfe` (#8549, ~31.5k lines, experimental,
   flag-gated) + `5c59c84c7a` (four trust-boundary holes) + `3c0cd6069f`
   (hostile-panel fixture shipped in asar). **Owner decision: adopt or defer.**
   If adopted, take all three together, never #8549 alone — and it is a new
   supply-chain surface (marketplace, kill-list) landing on our security
   posture. If deferred, drop the tree cleanly; nothing else depends on it.
4. **Updater** — `10ca89ac8b` (validated local mac builds, rewrites
   `updater.ts`) + `5753cf6c5c` (background-check resume). Our updater is
   self-managed (`usesSelfManagedCheck`, ALab feed, .app-swap); take the
   bug-fix semantics, keep our feed/identity model authoritative.
5. **Daemon/terminal transport** — `1d87f181b4`+`8db61248ec` (dead-daemon
   respawn + input quarantine, a pair: renderer side must map onto aterm pane
   remount), `24706ccff0` (close-intent protocol bump vs. our daemon lineage),
   `0c861d79b5` (v29→v30 history handoff — our `src/main/daemon` is adapted),
   `5f7807497e` (relay PTY backpressure end-to-end vs. our own bounded
   multiplexer/admission work), `a7c8b8e071` (SSH hidden-worktree retention:
   port the parking/retention *policy*, reimplement the repaint against aterm).
6. **IME** — `fe6f929c6e` is a 971-line @xterm core patch we cannot take.
   Treat it as the **spec** for aterm's IME composition lifecycle (deferred
   Enter during composition, Korean/Chinese dedup, composition-transaction
   ownership) and file it against the engine.
7. **Watchdog/packaging** — `747b241145`+`3f37e32e72` (main-thread hang
   watchdog, then moved into a worker thread): our packaging/plain-node-entry
   guards must carry the entrypoints; take both or neither.
8. `9c5d827d6a` (codex per-account CODEX_HOME, 4.9k lines) — substance is
   main-process and engine-orthogonal, but expect conflicts in the terminal-pane
   glue we adapted for aterm.
9. `b339fe0346` (Node 26 test gate) and `5e00a30e4e` (copy/locale-parity
   decoupling) — reconcile with our own test infra and localization gates.

### Class C — superseded by the aterm engine (resolve ours; verify behavior)

`c25d85cc4c` (frame-chunk pipeline), `97cb32c1cc` (synchronized-output latch —
verify aterm survives an abandoned ?2026 bracket across hide/reveal),
`3a80fbe162` (upstream reverted four rendering changes for flashing/lost
content — one is our merge-base `8f5a45401f`; audit aterm's GPU path for the
same symptom class), `2a640abfbe` (already covered by
`src/main/pty/inherited-spawn-env.ts` + aterm's own env stripping — verified),
WebGL portions of `ab1c37889a` (take the main-process breadcrumb fixes, drop
the xterm-WebGL crumbs), `0e11ec38bb` (we have
`terminal-linkifier-hover-reset.ts`; confirm the mouseleave wiring),
`2dac0741b4`/`c0734f039d` (mode-2031 replies / stale TUI-mode disarm — port
onto aterm's chunk/reply path only if aterm doesn't already handle them).

### Class D — skip, or take only as chains

- Release commits (6) and the APK-link doc: ours are fork-owned.
- `8ad9448905` reverts upstream's worker process boundaries — take the revert
  together with its ancestors, or neither.
- `a8660839ee` → replaced by `7a3df87994`: if adopting background skill
  updates (`0956d5ca3a`), take the whole chain through `7a3df87994`.
- `#11026`/`#11012` introduced regressions repaired by `a721125d06`: all three
  or none.
- `39a200d900` (Windows inner-binary signature gate fail-open since
  electron-builder 26.9): our release path is `pub`, but **audit whether our
  Windows builds inherited the same fail-open gate from v1.4.150**.

### Class A — the default ~200

Everything else merges cleanly. High-impact members: `3a67186623`
(notification-loss/credentialed-cache/clipboard triple), `fa449bc0ef` (Cmd+J
crash + SSH name-clear), `05603a2e78` (Resource Manager killing live
sessions), `3baffb49ff` (SSH project setup acting locally), `c140a51118`
(two-host project poisoning), `1fd0f731fc` (agent PTY orphaned at launch; SSH
folder workspaces), `ca5a821600` (unconsented approval-bypass agent
relaunch), `380034edf9` (macOS reactivation deadlock), `c75c04eaae`
(single-instance lock defeated after TMPDIR purge), `d547e278f9` (mobile
notification watermark), `86a993aec4` (SSH hosts without a C toolchain),
`ee7ec43149`/`4340781c9f`/`50f46889d9`/`77ac0bd517` (codex account isolation),
`8b57e6e180` (remote watcher resync), `29c40e3353` (PTY leak on tab close —
floating/setup/folder workspaces), `cbe8635f46` (worktree deletion blocking),
`8c5b02547e` (Windows claude-login hang), `791577861b` (host identity),
`bf894ef150` (paired-terminal parking), the computer-use supervision cluster
(`1f2f809a11` `ef90f6099c` `48184b9e21` `4f536ed601` `0349cb6bdb`
`d0f341ad69`), `5d17bd8f33` (rolling GPU-crash window), `c30a0ea685` (verified
speech-model downloads), `f48cb78646`/`79ec57d045` (hydration & relay-replay
perf). Features: `6d4e335001` (worktree.sharedDirectories), `8f36cd9baf`
(remote skills discovery), `afbd98d8a4` (Windows drives in remote picker),
`c74fb3c71b` (Shift link-routing), `13c193a00a`+`4e99602ac8` (kanban
search/filters), `e73b1a1dd0`+`8d4e975ff7` (type-ahead pickers),
`af708d3471` (detached-HEAD filter), `2d23217166` (Trae CLI), `fa2f5de7da`
(feedback images — keep our fail-closed feedback posture), `74563b6498`
(Jira links), `0956d5ca3a` chain, emoji trio (`49fbe5231d` `038fd7a50c`
`84b335f80c`), `cf513adddc` (pricing), `827207784d` (OMP skills),
`270c5ad3fa`, `6fc05df985`. UI-heavy adoptions get restyled per
STYLEGUIDE.md tokens.

## Protocol

1. Branch `merge/upstream-v1.4.161`; `git merge v1.4.161` (full tag merge, the
   v1.4.150 vehicle). Defer v1.4.162 until it goes stable.
2. Resolve with the class playbook: A theirs-leaning, B by design, C ours,
   D per chain rule. Never resurrect a deleted TS twin — mirror the fix into
   the owning crate instead.
3. Post-merge loss audit (the two places loss can hide):
   intersect upstream-new files with merge-dropped files; diff
   upstream-modified files against their Rust-port mirrors.
4. Gates: `pnpm parity` (must stay green at its ratcheted corpus), the
   84-case conformance suite, perf-proof (`bench:check`), full lint/typecheck/
   vitest, launch smoke. Verify the merged tree against the Class C behavior
   checks above.
5. File the aterm-side items (IME spec, ?2026 hide/reveal, mode-2031/TUI-mode
   disarm, retention-policy port) as engine work — they are not merge blockers.

## Cadence

The real failure was letting 11 releases pile up. Policy going forward:
**merge every upstream stable release**, target delta ≤ ~30 commits. At that
size the disposition pass is an hour, not a workflow.
