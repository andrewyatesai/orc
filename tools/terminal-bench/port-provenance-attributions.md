# Port-provenance re-pin attributions

The provenance manifest (`port-provenance.json`) is generated, so a re-pin commit
cannot carry its own review. This file is the review: every re-pin cites an entry
here that attributes each drifted file to the commits that moved it — the
census-ratchet `_rebaselines` idiom. Drift is fine; **silent** drift is not.
A blanket `--generate` with no attribution converts a review backlog into a green
checkmark and is never acceptable. A module whose drift review finds an
**un-absorbed behavioral change** is NOT re-pinned: its old pin stays in the
manifest so the gate keeps reporting the re-port task by name.

## 2026-08-13 — re-pin of the 07-16 pin epoch (112 drifts, 98 files, 162 commits)

- head: 21a0ae8c4. Pin epoch: 4c49c3b70 (2026-07-16, first generation), with
  partial re-pins at 93d835a4e, 63e53d894, f2e83a4c6, 883b235bd (2026-08-10,
  "re-pin only the files I changed").
- why re-baseline at all: the manifest sat one upstream-merge month behind HEAD,
  so the provenance axis returned REVIEW unconditionally (112 rows) and could no
  longer surface NEW drift — at that volume a fresh un-reviewed change reads
  identically to the backlog. Re-pinning restores detection; the five held-back
  modules below are what the review actually found.
- what the month contained (the union of the 162 file-scoped commits):
  - four upstream merges: v1.4.147-rc.4 (b206b3147), v1.4.150 (478e0eabf),
    v1.4.161 (cd1429992), v1.4.165-rc.0 (5fb3d4781). Where these touched Rust
    twins, the re-sync happened **inside the merge commit itself** (e.g.
    `tui_agent_startup_json.rs` in 478e0eabf) — the process working as designed.
  - the 18-lane port merge and its `port(#…)` commits (07-21).
  - three mechanical Rust sweeps, verified behavior-preserving by the parity run
    below: eff6b81f3 (index-via-`get`/saturating rewrites for the Trust
    verifier — 25 pinned files), d933238fa (saturating arithmetic on scanner-fed
    values in the E1 decision cores), a82dc9b20 (publish-guard scrubs of test
    fixtures, no logic).
  - orchestration schema v7→v11, where `db.ts` and `orchestration.rs` moved in
    lockstep through the same commits.
  - the 08-11/08-12 parity-port batches (ports reviewed under their own commits).
- verification at this tree (both legs rebuilt from this source): orca-parity
  1634 cases / 85 vector files, golden 1624/1624 ok; vitest TS-vs-Rust
  1720/1720 pass (`pnpm parity`, napi addon rebuilt from this tree). Every
  vector-backed module in the drift set is therefore behaviorally in sync at
  HEAD. Vector-less (IO-tier/ledger) modules were reviewed by hand; results
  below.

### NOT re-pinned — attributed, but the port did not absorb the change

These five keep their old pins on purpose. The gate MUST keep reporting them
(`ts-drift`, 5 rows) until the re-port lands; re-pinning them would bury a known
divergence under a green checkmark.

| module | un-absorbed TS change | Rust twin state | owed |
| --- | --- | --- | --- |
| `orca-crash-recovery::gpu_fallback` | rolling crash window (5d17bd8f3, upstream #10707) | still launch-anchored (`ms_since_launch > window_ms` no-op) | re-port + re-derive the ay certificate (engages-at-most-once etc. restated over the rolling window) |
| `orca-relay::e2ee_channel` | **security**: v1 replay guard via nonce-uniqueness (36f2812ac); v1 inbound extracted to `mobile-e2ee-v1-{replay-guard,inbound}.ts` | no replay/seen-nonce guard | re-port the guard; map the two new TS modules into the ledger row |
| `orca-git::branch_rename` | two-arg pinned `branch -m` + fail-closed HEAD checks with revert-on-race (a9ef2983b, 0eb5bedec) | still single-arg `branch -m <new>` | re-port; ledger row says "(complete)" and is currently wrong |
| `orca-terminal::color_scheme_protocol` | mode-2031 reply-decision scan API, withdrawn-toggle handling (2dac0741b) | scan API absent | re-port the reply-decision scan |
| `orca-core::protocol_version` | +10 runtime capabilities across 12 commits (versions still 3/2/2) | capability list stale at 7 entries | sync constants; only a daemon test + dispatch adapter consume the Rust list today, so risk is drift-at-a-distance, not live breakage |

#### Correction (2026-08-15): the list was five short of complete

`src/shared/synthetic-agent-title.ts` was re-pinned to HEAD in the attribution
table below, citing 88068f55b ("Preserve native OpenCode session titles", #9080)
as absorbed. It was not: `orca-core::synthetic_agent_title` still knew 5 of the
twin's 8 agents and had neither `titleIdentityGroup` nor
`synthesizeTerminalTitle`, so it answered `"OpenCode ready"` where the twin
answers `null`. The row belonged in this table on 08-13, and the verification
sentence above — "every vector-backed module in the drift set is therefore
behaviorally in sync at HEAD" — is a coverage claim, not a fidelity one: the
corpus had no vector for any of it. The re-port landed 2026-08-15 (14 derived
divergences → 0, corpus 13 → 37 cases), so the pin is correct **now** and is
deliberately left alone rather than moved back and re-pinned. Two more rows in
the same table were in the same state and have since been re-ported by parallel
work (`tab-title-resolution`, `workspace-session-terminal-buffers`).
Run `pnpm parity:twin-derived` before believing any "absorbed" attribution.

The `workspace-session-terminal-buffers` row (`src/shared/…`, re-pinned to
39964149c citing e05223005, "perf(P5): stream deep scrollback restore past the
512KB sync replay limit") is the sharpest instance, because the cited commit is
the one that was NOT absorbed. e05223005 is what moved the cap from
`buffer.slice(-LIMIT)` to `clampUtf8TextTail(buffer, BYTE_LIMIT)` and added the
`opts.bufferByteLimit` override; the Rust core kept the UTF-16 slice, so it
persisted 2× the intended payload for accented text and 3× for CJK. A separate
un-absorbed change hid in the same row — `executionHostId` on the repo shape, so
runtime-host panes had the only scrollback they can restore from deleted. On
08-13 the row belonged in the NOT-re-pinned table above, owed "re-port the
byte-unit cap + the execution-host branch". **Do not move it now**: the re-port
landed 2026-08-15 (1 derived divergence → 0, corpus 8 → 29 cases), so the pin is
correct at HEAD, and moving the row back would re-open a gate on work that is
done. Recorded here so the next reader knows the 08-13 attribution was wrong
rather than lucky.

The `tab-title-resolution` row (`src/shared/tab-title-resolution.ts`, re-pinned
to 00f384966 citing f8b57aac5 + 88068f55b) is the third instance, and again the
cited commit is the un-absorbed one. 88068f55b added the native-OpenCode step
between the quick-command label and the generated title; neither Rust resolver
had it, and the sibling twin it calls, `src/shared/opencode-terminal-title.ts`,
was not ported at all — that file is not in the manifest under any module, so no
gate was watching it. On 08-13 the row belonged in the NOT-re-pinned table above,
owed "re-port both resolvers + port `isOpenCodeNativeTitle`". **Do not move it
now**: the re-port landed 2026-08-15 (`resolveTerminalTabTitle` with
`title: 'OC | Native Stable Session'` answers the session title again; corpus
17 → 47 cases, twin-derived stale 0), so the pin is correct at HEAD. What a
regeneration SHOULD change: the `tab-title-resolution` entry pins exactly one
file per side, so add `src/shared/opencode-terminal-title.ts` to its `ts` list
and `rust/crates/orca-core/src/opencode_terminal_title.rs` to its `rust` list.
Otherwise the next drift in the predicate is invisible — it would hide behind a
resolver file that did not move.

The `mcp` / `mcp-env` row (`src/shared/mcp-config.ts`, re-pinned to 879aad7dd
citing "oom(foundation): bound shared readers/limits + add BoundedMap primitive",
#10299) is the fourth. That commit is exactly the one the port did not absorb: it
added all four MCP inspection bounds, and `orca-config::mcp` had none of them, so
a 300-server config read `valid` with 300 summaries where the twin reads
`invalid` with `servers: []`, and a 300 KiB config was parsed where the twin
refuses it before `JSON.parse`. On 08-13 the row belonged in the NOT-re-pinned
table above, owed "re-port the four inspection bounds". **Do not move it now**:
the re-port landed 2026-08-15 (7 derived divergences → 0 stale, corpus 9 → 30
cases), so the pin is correct at HEAD. What a regeneration SHOULD change: both
modules pin `src/shared/mcp-config.ts` and nothing else, but the behaviour lives
in two siblings the manifest does not track at all —
`src/shared/mcp-server-inspection.ts` (`summarizeMcpServer`, `inspectMcpEnv`,
`maskMcpEnv`: every per-server bound and the `String(x)` env coercion) and
`src/shared/mcp-config-inspection-limits.ts` (the caps themselves). Both moved in
879aad7dd and neither could have reported drift. Add them to the `ts` list of
`mcp`, add `mcp-server-inspection.ts` + `mcp-config-inspection-limits.ts` to
`mcp-env`, and add `rust/crates/orca-text/src/mcp_config_inspection_limits.rs` to
the `rust` list of both.

### Registered by this regeneration

- `fleet-exceptions`, `fleet-identity`, `task-claim` — new parity modules from
  8785e1c32 (2026-08-11, "port the last three pure decision cores behind the
  differential harness"); first pins.
- `terminal-quick-commands` — `src/shared/terminal-quick-commands.ts` was
  deleted at the Rust cutover (c270be4ff) and **resurrected** by upstream #9298
  (5fcf77761, via merge b206b3147). Kept deliberately: 348acb8db made it the home
  of upstream's not-yet-ported mutation API (`applyTerminalQuickCommandMutation`,
  `parseNormalizedTerminalQuickCommands`) re-exported by the wasm facade, while
  the ported ops still run in Rust. Now pinned as a TS source, so further motion
  drifts loudly. Porting the mutation API is a named candidate.
- unmapped set: unchanged (7 entries, same as the previous manifest).

### Attribution table — every drifted file

Pin = the newest commit whose content matches the old pinned sha256 (computed,
not assumed); commits = `git log <pin>..HEAD -- <file>`, i.e. exactly the motion
the old pin failed to cover. Shared files (e.g. `rust-git-addon.ts`, pinned by
8 modules) appear once with all pinning modules listed.

| file | pinned at | module(s) | commits since pin | what changed |
| --- | --- | --- | --- | --- |
| `src/main/crash-reporting/gpu-crash-fallback-decision.ts` | 48f0e54c0 | orca-crash-recovery::gpu_fallback | 5d17bd8f3 | **NOT RE-PINNED** — rolling crash window replaced the launch-anchored gate (5d17bd8f3, upstream #10707): sorted crash-time array pruned to windowMs behind newest |
| `src/main/git/branch-rename.ts` | 94073b78c | orca-git::branch_rename | 0eb5bedec a9ef2983b | **NOT RE-PINNED** — two-arg pinned `git branch -m <current> <new>` plus fail-closed HEAD checks before and after, with revert on race (a9ef2983b, 0eb5bedec) |
| `src/main/runtime/rpc/e2ee-channel.ts` | 77b154d5d | orca-relay::e2ee_channel | cd1429992 24706ccff 478e0eabf 36f2812ac 8f40ddf32 d6c9fcd53 | **NOT RE-PINNED** — v1 replay guard via nonce-uniqueness (36f2812ac) with v1 inbound extracted to mobile-e2ee-v1-* modules, pairing-auth failure surfacing (d6c9fcd53), close-intent negotiation (24706ccff), OOM caps, two merges |
| `src/shared/protocol-version.ts` | fd6805a29 | orca-core::protocol_version | bf2722743 24706ccff cd05f2ff9 4a71a0ecb e3adb2091 0326594d5 41751dd90 b232df732 54c1ec5e7 5fcf77761 e719ef1a5 6e91ca6c0 | **NOT RE-PINNED** — +10 runtime capabilities (quick-commands, worktree/terminal create-idempotency, session-tab close-intent, host-authority, OMP resume-path, mutation-ownership, codex-reset-credit, remote-server-update, certificate-trust) across 12 commits; version numbers unchanged (3/2/2) — the Rust twin still lists 7 capabilities |
| `src/shared/terminal-color-scheme-protocol.ts` | bf31ecbad | orca-terminal::color_scheme_protocol | 2dac0741b | **NOT RE-PINNED** — new mode-2031 reply-decision scan API: tailMayResolveToMode2031 + scanMode2031ReplyDecision withholding replies the same chunk withdrew (2dac0741b) |
| `rust/crates/orca-agents/src/tui_agent_startup_json.rs` | 3318bf29c | tui-agent-startup | 478e0eabf 096ddd514 | merge: upstream stablyai/orca v1.4.150 (431 commits) (478e0eabf); fix: post-integration verification sweep for the 18-lane port merge (096ddd514) |
| `rust/crates/orca-config/src/contextual_tours.rs` | ca79be80f | contextual-tours | 75fd29901 | fix(parity): re-port contextual-tours — step ids, copy fix, and the floating-workspace tour (75fd29901) |
| `rust/crates/orca-config/src/setup_script_imports.rs` | ca79be80f | setup-script-imports | 478e0eabf | merge: upstream stablyai/orca v1.4.150 (431 commits) (478e0eabf) |
| `rust/crates/orca-config/src/setup_script_package_manager.rs` | 87e6a130f | orca-config::setup_script_package_manager | 478e0eabf | merge: upstream stablyai/orca v1.4.150 (431 commits) (478e0eabf) |
| `rust/crates/orca-config/src/workspace_session_schema.rs` | 71931e760 | workspace-session-schema | 39e0d0c49 c22d0edc9 f8b57aac5 | feat(parity): port 15 tail medium items (batch 4) — worktree/relay/remote/install reliability (39e0d0c49); feat(parity): port 13 tail medium items (batch 3) — ssh/browser/daemon/terminal reliability (c22d0edc9); feat(parity): port 7 medium items — ai-vault, editor diff, native-chat, codex, clipboard (f8b57aac5) |
| `rust/crates/orca-core/src/agent_kind.rs` | 87e6a130f | agent-kind | 5fb3d4781 | Merge upstream stablyai/orca (v1.4.165-rc.0, +506 commits) into the Rust/aterm fork (5fb3d4781) |
| `rust/crates/orca-core/src/agent_notification_id.rs` | 87e6a130f | agent-notification-id | a82dc9b20 | fix(publish): make the public source snapshot pass the publication guards (a82dc9b20) |
| `rust/crates/orca-core/src/agent_recognition.rs` | 879a3d029 | agent-recognition | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/base_ref_search_result.rs` | 87e6a130f | base-ref-search-result | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/branch_name_from_work.rs` | af649e3c6 | branch-name-from-work | eff6b81f3 1987cb912 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3); feat(specs): model-check the PTY flow-control protocol with ty (TLA+) — first temporal gate (1987cb912) |
| `rust/crates/orca-core/src/browser_search.rs` | 87e6a130f | browser-search | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/cross_platform_path.rs` | 7530038b3 | cross-platform-path | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/feature_wall_tour_depth.rs` | 87e6a130f | feature-wall-tour-depth | 30fd59819 | feat: ship terminal-first ALab walkthrough (30fd59819) |
| `rust/crates/orca-core/src/git_cquoted_path.rs` | 9b2af1131 | orca-core::git_cquoted_path | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/gitlab_pipeline_checks.rs` | 87e6a130f | gitlab-pipeline-checks | bcc4fe066 f74fdf764 | fix(gitlab): blocking manual jobs read action_required in job-level checks, not neutral (bcc4fe066); port(#7732): load GitLab pipeline job details in the Checks panel (f74fdf764) |
| `rust/crates/orca-core/src/gitlab_projects.rs` | 87e6a130f | gitlab-projects | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/hosted_remote_url.rs` | 87e6a130f | orca-core::hosted_remote_url | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/hosted_review_refs.rs` | 87e6a130f | hosted-review-refs | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/linear_links.rs` | af649e3c6 | linear-links | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/nested_repo_telemetry.rs` | 87e6a130f | nested-repo-telemetry | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/open_in_applications.rs` | 87e6a130f | open-in-applications | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/pty_env.rs` | 87e6a130f | orca-core::pty_env | a82dc9b20 | fix(publish): make the public source snapshot pass the publication guards (a82dc9b20) |
| `rust/crates/orca-core/src/quick_open_filter.rs` | d511430ad | quick-open-filter | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/setup_runner_command.rs` | 285ab7d21 | setup-runner-command | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/stable_pane_id.rs` | 87e6a130f | stable-pane-id | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/tailnet_address.rs` | 87e6a130f | tailnet-address | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/terminal_fonts.rs` | 87e6a130f | terminal-fonts | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/uri_component.rs` | af649e3c6 | uri-component | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/workspace_cleanup.rs` | 87e6a130f | workspace-cleanup | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/worktree_id.rs` | 87e6a130f | worktree-id | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-core/src/wsl_paths.rs` | 87e6a130f | wsl-paths | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-crash-recovery/src/gpu_fallback.rs` | db8522380 | orca-crash-recovery::gpu_fallback | d933238fa | fix(decision): saturate the arithmetic the AY proofs never covered (d933238fa) |
| `rust/crates/orca-crash-recovery/src/renderer_recovery.rs` | db8522380 | orca-crash-recovery::renderer_recovery | d933238fa | fix(decision): saturate the arithmetic the AY proofs never covered (d933238fa) |
| `rust/crates/orca-crypto/src/nacl_box.rs` | 87e6a130f | nacl-box | 252860709 | fix(crypto): zeroize NaCl secret key material on drop (252860709) |
| `rust/crates/orca-crypto/src/shared_key_box.rs` | ad5b29bc8 | nacl-box | 252860709 | fix(crypto): zeroize NaCl secret key material on drop (252860709) |
| `rust/crates/orca-git/src/branch_cleanup.rs` | 4ba49a70c | orca-git::branch_cleanup | 5fb3d4781 | Merge upstream stablyai/orca (v1.4.165-rc.0, +506 commits) into the Rust/aterm fork (5fb3d4781) |
| `rust/crates/orca-git/src/source_control_ai.rs` | 00d81a999 | source-control-ai | 1987cb912 | feat(specs): model-check the PTY flow-control protocol with ty (TLA+) — first temporal gate (1987cb912) |
| `rust/crates/orca-net/src/network_proxy.rs` | 87e6a130f | network-proxy | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-policy/src/lib.rs` | c3ebf0280 | policy | 8785e1c32 | feat(policy,core): port the last three pure decision cores behind the differential harness (8785e1c32) |
| `rust/crates/orca-provider-backoff/src/lib.rs` | 6c464e677 | provider-backoff | d933238fa | fix(decision): saturate the arithmetic the AY proofs never covered (d933238fa) |
| `rust/crates/orca-relay/src/e2ee_channel.rs` | 87e6a130f | orca-relay::e2ee_channel | 252860709 | fix(crypto): zeroize NaCl secret key material on drop (252860709) |
| `rust/crates/orca-relay/src/pairing.rs` | dccdc3137 | pairing | a82dc9b20 | fix(publish): make the public source snapshot pass the publication guards (a82dc9b20) |
| `rust/crates/orca-relay/src/terminal_stream.rs` | 33b59889b | terminal-stream-protocol | 30ac57707 5fb3d4781 30fd59819 | build(trust): pin the Trust toolchain with verification ON, and make the authority crate verifiable again (30ac57707); Merge upstream stablyai/orca (v1.4.165-rc.0, +506 commits) into the Rust/aterm fork (5fb3d4781); feat: ship terminal-first ALab walkthrough (30fd59819) |
| `rust/crates/orca-renderer-heap/src/lib.rs` | e131af058 | orca-renderer-heap::lib | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-runtime/src/orchestration.rs` | 989f3ea93 | orchestration-store | 71978392e a948ef7bc 9492e2f07 2ebbe5f8f 7dbddc80b 7c98fd8f4 | the same schema v7-v11 commits as db.ts — twins moved in lockstep |
| `rust/crates/orca-session-gc/src/lib.rs` | 2fb25b56c | orca-session-gc::lib | d933238fa | fix(decision): saturate the arithmetic the AY proofs never covered (d933238fa) |
| `rust/crates/orca-ssh/src/config_parser.rs` | 8cde0e041 | ssh-config-parser | eff6b81f3 5fb3d4781 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3); Merge upstream stablyai/orca (v1.4.165-rc.0, +506 commits) into the Rust/aterm fork (5fb3d4781) |
| `rust/crates/orca-ssh/src/resolved_config.rs` | 8cde0e041 | ssh-g-config | eff6b81f3 | fix(rust): remove slice-bounds obligations Trust cannot discharge (eff6b81f3) |
| `rust/crates/orca-stream-split/src/lib.rs` | c178ed6b5 | orca-stream-split::lib | d933238fa | fix(decision): saturate the arithmetic the AY proofs never covered (d933238fa) |
| `rust/crates/orca-terminal/src/headless.rs` | 47c29030b | orca-terminal::headless | 336490f7f 7dd8316a0 a82dc9b20 4b3896d94 bcc071e40 9ac454fa0 | same feature commits as its TS driver (336490f7f, 7dd8316a0, 4b3896d94) plus the tiered scrollback store (9ac454fa0, bcc071e40) and publish-guard scrub (a82dc9b20) — twins moved in lockstep |
| `rust/crates/orca-text/src/mcp_env.rs` | 87e6a130f | mcp-env | a82dc9b20 | fix(publish): make the public source snapshot pass the publication guards (a82dc9b20) |
| `rust/crates/orca-text/src/quick_open_rank.rs` | 10e181bd6 | quick-open-rank | 0bd04448c | perf(quick-open): return rank indices instead of JSON, ~5% off each keystroke (0bd04448c) |
| `src/main/daemon/daemon-stream-data-split.ts` | c178ed6b5 | orca-stream-split::lib | b206b3147 c0f0810dd | stream-data payload gained seq/rawLength/transformed fields (c0f0810dd, via merge b206b3147) — the ported surrogate-safe split-index scope is untouched |
| `src/main/daemon/daemon-stream-keep-tail-drop.ts` | e84a8ddec | keep-tail | 943f9a077 c0f0810dd | perf(daemon): cache droppable stream membership (#10121) (943f9a077); Fix native Windows PTY startup query handling (#9500) (c0f0810dd) |
| `src/main/daemon/headless-emulator.ts` | bbccaf4ef | orca-terminal::headless | 336490f7f 7dd8316a0 fb652cbcf 4b3896d94 051324bbb b5efabd4c b206b3147 98b00d3a6 1def694e8 3efc93090 | co-evolved with headless.rs: remote search wire (4b3896d94), agent scrollback/transcript/orientation (fb652cbcf, 7dd8316a0, 336490f7f), ConPTY OSC 10/11/12 reply suppression (b5efabd4c, 051324bbb), WSL CWD wake fix (3efc93090), skill picker, merge + comment slimming |
| `src/main/daemon/rust-git-addon.ts` | b67ab3a76 | git-remote-error, gitlab-projects, linear-links, pi-agent-kind, setup-script-imports, ssh-config-parser, ssh-g-config, workspace-session-schema | 71978392e a948ef7bc 9492e2f07 2ebbe5f8f 7dbddc80b a316c27f5 7c98fd8f4 | napi binding surface grew with orchestration schema v7-v11 (7dbddc80b, 2ebbe5f8f, 9492e2f07, a948ef7bc, 71978392e), run-stop by handle (7c98fd8f4), packaged-build cwd-probe fix (a316c27f5) — TS-side declarations of the Rust addon, so this is interface growth, not reference divergence |
| `src/main/git/fetch-error-classification.ts` | a0eb9ce27 | orca-git::fetch_error_classification | 478e0eabf 772081577 6a33e98f2 | boundary now feeds stderr to the Rust matcher for multi-remote PR fetch (6a33e98f2); TS-only transient-fetch allowlist added (772081577, 478e0eabf) — the missing-remote-ref matcher itself lives in Rust and did not move |
| `src/main/git/remote.ts` | 699acbe3a | orca-git::remote | 19b2fe6b7 | exec options swapped to the timeout/tree-kill-capable factory (19b2fe6b7) — push/pull/fast-forward/rebase decisions and error normalisation untouched |
| `src/main/git/runner.ts` | 4579e6762 | orca-git::runner | 478e0eabf 19d082a16 34000bdad 1ace87c15 aab112933 8f40ddf32 443a27a9e 31c690652 19b2fe6b7 863a2f9e8 971b16754 b206b3147 e109e78eb 190de8223 b320bcb37 d67ede159 | exec plumbing/classification around the runner: WSL distro routing (1ace87c15, 863a2f9e8), custom-timeout classification (34000bdad), SSH Host aliases (19d082a16), bounded gitlab auth probes (b320bcb37), per-hunk stage (31c690652), two upstream merges — the ported GitRunner/GitError contract surface has no file-scoped -S`GitError` hits since the pin |
| `src/main/git/status.ts` | ea42ada8e | orca-git::status, orca-git::status_parse | 3a75c6e7c cd1429992 a49d68f8c 5a30c5c2e cac7d8edd aab112933 8387374cd 8f40ddf32 443a27a9e 31c690652 2eaf82f00 b206b3147 e109e78eb 190de8223 1987cb912 a03a3dd51 | caller/orchestration around the Rust parser: shared read leases + dedupe, perf overlap (e109e78eb, 8387374cd, a49d68f8c, 5a30c5c2e), discard semantics (2eaf82f00, cac7d8edd), OOM caps cycle, three merges — the porcelain-v2 parse itself delegates to orca_node (status.ts:272), so the ported scope executes in Rust |
| `src/main/git/worktree.ts` | 8982a4f34 | orca-git::worktree | 39e0d0c49 478e0eabf 9d0278296 19f715a10 b192288f6 1525a0161 e3cc08f18 aab112933 4c8dd372f 8f40ddf32 282df8f3f e422e0d29 6a3f1340f 71bbfa022 ccbe5ef82 98a8e78b9 b206b3147 190de8223 1987cb912 d363c83ae | worktree-add rollback hardening (6a3f1340f, e422e0d29, 282df8f3f, 19f715a10), git-crypt + parallel checkout ports (ccbe5ef82, 98a8e78b9), sparse-checkout reads (9d0278296, e3cc08f18), reset --keep fast-forward (b192288f6), bounded list scans, two merges — parseWorktreeList delegates to orca_node (worktree.ts:493) |
| `src/main/pty/wsl-orca-env.ts` | 17f032dbd | orca-core::pty_env | ff945ef5d e1eca7f31 4d49b9342 | WSLENV passthrough construction grew: worktree setup vars with /u-vs-/p flavor (4d49b9342, #9206), OpenCode plugin env (e1eca7f31), batch-5 port (ff945ef5d) — the Rust twin holds the upsert primitive, which is unchanged; the new construction logic is TS-side and not yet in the ported scope (port candidate) |
| `src/main/runtime/orchestration/db.ts` | 4579e6762 | orchestration-store | 71978392e a948ef7bc 9492e2f07 2ebbe5f8f 442895b4a 7dbddc80b 096ddd514 76548808e 7c98fd8f4 b206b3147 98b00d3a6 5b6cefa5a | orchestration schema v7-v11 co-evolved with orchestration.rs (7dbddc80b, 2ebbe5f8f, 9492e2f07, a948ef7bc, 71978392e), run-stop by handle (7c98fd8f4), dispatch-scan perf (442895b4a), RFC3339 timestamps (5b6cefa5a), 18-lane integration, merge |
| `src/main/sqlite/sync-database.ts` | 1009ac908 | orca-store::database | 0906471fb | node:sqlite loaded via process.getBuiltinModule so Node-18 SSH companions can import the adapter (0906471fb) — open/exec/pragma semantics untouched |
| `src/shared/agent-process-recognition.ts` | 1a6abc87d | agent-recognition | e78eece56 4c7bbed2f | feat(parity): port 19 low-impact items (low batch 5) — worktree/mobile/ssh/ai-vault polish (e78eece56); fix(windows): detect Cursor Agent Node wrapper (#8266) (4c7bbed2f) |
| `src/shared/agent-status-types.ts` | 94073b78c | agent-status-types | b9f2d7192 478e0eabf 879aad7dd aab112933 8f40ddf32 e986a7ba1 7d06ad6da 2784d8004 b206b3147 098912828 3a847bfac 3f335efdb | status vocabulary + caps grew: pi resume (3f335efdb), SSH-disconnect status clear (3a847bfac), early-exit/127 = launch-failed (2784d8004), plugin-hook churn de-notify (7d06ad6da), nested Codex subagents (e986a7ba1), OOM caps add/revert/re-add (8f40ddf32/aab112933/879aad7dd), hibernation in-flight guard (b9f2d7192), two upstream merges + comment slimming |
| `src/shared/branch-name-from-work.ts` | d1d7114fd | branch-name-from-work | 1987cb912 ce910e5d5 | feat(specs): model-check the PTY flow-control protocol with ty (TLA+) — first temporal gate (1987cb912); fix(naming): keep the built-in branch-name prompt general (#9088) (ce910e5d5) |
| `src/shared/browser-screencast-protocol.ts` | aab112933 | browser-screencast-protocol | 879aad7dd | oom(foundation): bound shared readers/limits + add BoundedMap primitive (#10299) (879aad7dd) |
| `src/shared/browser-url.ts` | c56f151cb | browser-search | 6e91ca6c0 | fix(browser): local HTTPS Try HTTPS + cert proceed (#8454) (#9104) (6e91ca6c0) |
| `src/shared/commit-message-agent-spec.ts` | 552c56788 | commit-message-agent-spec, commit-message-models | b6e576aec f8b57aac5 478e0eabf 879aad7dd aab112933 8f40ddf32 | OOM caps cycle (8f40ddf32/aab112933/879aad7dd), v1.4.150 merge, then parity-port batches f8b57aac5 + b6e576aec extended the spec |
| `src/shared/commit-message-generation.ts` | b76a92cfc | commit-message-generation | 478e0eabf ca70be831 | merge: upstream stablyai/orca v1.4.150 (431 commits) (478e0eabf); Add {linkedIssue} template variable for commit and PR generation (#10640) (ca70be831) |
| `src/shared/constants.ts` | 8cde0e041 | repo-badge-color | 8c5f79821 fa1ded3a6 fee5235eb f5e79827a ad5ecfe40 cd1429992 97e4776df 478e0eabf af708d347 28dfc1365 9042ef979 4a71a0ecb d56e2fbbe 3149a5595 f60905ae6 5ebca0523 76708826b 443a27a9e 80c654d74 919db4368 b25474479 1c47f6092 0a685d4ec f78a49a9e 5b6b70a7f ebadd12d5 64e53fc94 762442fcf 91ee29a80 6444be3a0 580f8eb49 3468b434d b206b3147 098912828 c5d40565a 4b17c917b 1987cb912 c5d2275c3 5b75a87dd 1536171fd | grab-bag constants module, pinned for repo-badge-color: 40 file-scoped commits — three upstream merges, the 18-lane port integration, and feature flags/constants (plugins, app-mode, artifacts sharing, dashboards, fonts, ssh pane parking); the ported repo-badge-color surface is parity-verified green at HEAD |
| `src/shared/contextual-tours.ts` | 1f2a50fe6 | contextual-tours | 651f334c4 | feat(parity): port 20 low-impact items (low batch 7) — locale-infra/restart/browser polish (651f334c4) |
| `src/shared/cross-platform-path.ts` | 64be81979 | cross-platform-path | 7dab1e86e a1a78da87 | perf(ssh): normalize watch event paths once per fs.changed batch (#10881) (7dab1e86e); fix(agent-history): match non-ASCII workspace paths to Claude sessions (#10841) (a1a78da87) |
| `src/shared/e2ee-crypto.ts` | 7b5343930 | nacl-box | 478e0eabf 8f40ddf32 | merge: upstream stablyai/orca v1.4.150 (431 commits) (478e0eabf); fix(memory): bound OOM-prone accumulators (#10179) (8f40ddf32) |
| `src/shared/feature-wall-tour-depth.ts` | b76a92cfc | feature-wall-tour-depth | 30fd59819 | feat: ship terminal-first ALab walkthrough (30fd59819) |
| `src/shared/git-remote-error.ts` | 6f254670e | git-remote-error | 1177efd1f 478e0eabf 772081577 19b2fe6b7 b206b3147 098912828 | credential-scrub TS twin deleted in favor of Rust (1177efd1f), exec-killed classification for durable review-head fetches (772081577), remote-op timeouts (19b2fe6b7), v1.4.147-rc.4 + v1.4.150 merges, comment slimming |
| `src/shared/git-upstream-status.ts` | 9ca33b450 | git-upstream-status | b206b3147 daf22f072 | Merge upstream stablyai/orca (+134 commits: v1.4.147-rc.4 + fixes) into the Rust/aterm fork (b206b3147); Make Create PR handle sync by fast-forwarding behind-only branches (#9481) (daf22f072) |
| `src/shared/mcp-config.ts` | aab112933 | mcp, mcp-env | 879aad7dd | oom(foundation): bound shared readers/limits + add BoundedMap primitive (#10299) (879aad7dd) |
| `src/shared/pairing.ts` | aab112933 | pairing | 879aad7dd | oom(foundation): bound shared readers/limits + add BoundedMap primitive (#10299) (879aad7dd) |
| `src/shared/pull-request-generation.ts` | 5a80192cd | pull-request-generation | 478e0eabf ca70be831 879aad7dd aab112933 8f40ddf32 | {linkedIssue} template variable (ca70be831), OOM caps cycle, v1.4.150 merge |
| `src/shared/quick-open-filter.ts` | ec8f86487 | quick-open-filter | b206b3147 098912828 | Merge upstream stablyai/orca (+134 commits: v1.4.147-rc.4 + fixes) into the Rust/aterm fork (b206b3147); refactor(comments): slim verbose comments in shared/cli/relay/preload (#9544) (098912828) |
| `src/shared/repo-icon.ts` | b93135689 | repo-icon | 478e0eabf 248c0d9cd 879aad7dd aab112933 8f40ddf32 971b16754 | Tauri/WebP icon detection (248c0d9cd), Enterprise PR diff import churn (971b16754), OOM caps cycle, v1.4.150 merge |
| `src/shared/setup-runner-command.ts` | a278a30b1 | setup-runner-command | 4e5d49cc8 f7404e459 | feat(w2-2e): nushell PR4 — agent-startup 'nushell' dialect, POSIX default-shell resolver, bracketed-paste gate (4e5d49cc8); port(#6896): deliver Windows setup runner through the configured terminal shell (Git Bash) (f7404e459) |
| `src/shared/source-control-ai.ts` | 3f3a9ef94 | source-control-ai | f78a49a9e ce910e5d5 | port(#1479): custom CLI agent profiles (f78a49a9e); fix(naming): keep the built-in branch-name prompt general (#9088) (ce910e5d5) |
| `src/shared/synthetic-agent-title.ts` | 29df9a3ab | synthetic-agent-title | 88068f55b | Preserve native OpenCode session titles (#9080) (88068f55b) |
| `src/shared/tab-title-resolution.ts` | 00f384966 | tab-title-resolution | f8b57aac5 88068f55b | feat(parity): port 7 medium items — ai-vault, editor diff, native-chat, codex, clipboard (f8b57aac5); Preserve native OpenCode session titles (#9080) (88068f55b) |
| `src/shared/terminal-stream-protocol.ts` | 71931e760 | terminal-stream-protocol | ff945ef5d | feat(parity): port 16 tail medium items (batch 5) — daemon-attach/liveness/recovery, terminal reliability (ff945ef5d) |
| `src/shared/tui-agent-selection.ts` | 0c0367ea8 | tui-agent-selection | f78a49a9e | port(#1479): custom CLI agent profiles (f78a49a9e) |
| `src/shared/tui-agent-startup.ts` | 3318bf29c | tui-agent-startup | 478e0eabf e3adb2091 1987cb912 5b75a87dd dcfa91919 96d1fa1d6 | per-model session option pickers (5b75a87dd), Hermes native-query prompts (dcfa91919), grok/ConPTY KKP (96d1fa1d6), OMP cold restore (e3adb2091), v1.4.150 merge — the Rust twin was re-synced by the same merge (478e0eabf) + verification sweep (096ddd514) |
| `src/shared/workspace-session-terminal-buffers.ts` | 39964149c | workspace-session-terminal-buffers | e05223005 | perf(P5): stream deep scrollback restore past the 512KB sync replay limit (e05223005) |
| `src/shared/worktree-ownership.ts` | 4c0392461 | worktree-ownership | 0783032fc | port(#9535): classify Claude Code scratch worktrees (.claude/worktrees/agent-*) as hidden agent-scratch (0783032fc) |
| `src/shared/wsl-paths.ts` | 6ee81dcfb | wsl-paths | eddfd85ca eba15f8b4 3efc93090 | WSL worktree POSIX-link -> UNC mapping (eba15f8b4), terminal-input lane integration (eddfd85ca), WSL CWD sleep/wake fix (3efc93090) |

