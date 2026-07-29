# Orca Modes — Conclusion of the Foundation Work

**Status:** foundation landed on `main` (`5d5c5cb19..304ace7e4`, 2026-07-28). This records
what shipped, the safety model it established, and exactly where the mode build picks up.
The full architecture is [`app-modes.md`](./app-modes.md); this is the ground-truth delta
between that design and the repo.

## What this was

One goal, three faces: Orca as one engine and one binary that can present as
**Classic** (today's product, unchanged), **Story World** (a child building game worlds
by driving a coding agent), and **ALab** (autonomous multi-agent orchestration under
human supervision). Building toward that surfaced two defects that were never really
mode problems, and both are now fixed in core:

1. **Agent safety was one switch when it is two dials.** Confinement (what the agent
   *can* do, OS-enforced) and approvals (whether it *asks*) are independent axes; the old
   Yolo/Manual toggle could only express unconfined-silent or unspecified-chatty. The
   best cell — confined and silent, exactly as fast as yolo — was inexpressible.
2. **The orchestration engine could not actually reach a human.** `ask` never created a
   gate, resolving a gate stranded the asking worker until timeout while the board read
   success, and the coordinator's only hang detector logged into a discarded no-op.

## What shipped

| Commit | Delta |
| --- | --- |
| `5d5c5cb19` | `App.tsx` 2,774 → <400 lines across 20 `app-shell/` modules; its max-lines disable removed, baseline shrunk 357 → 356. The shell is now composable — the precondition for mode-owned layouts. |
| `e9e767cf6` | Design tokens: `--app-font-scale` (one consumption point), the six-token motion scale (collapses under `prefers-reduced-motion`), `touch`/`icon-touch` 48px buttons. Documented in STYLEGUIDE.md, including the boundary with aterm's engine-side effects. |
| `80daec9c0` | Mode plumbing: `AppModeId` + precedence resolver (`env > locked sidecar > per-project > sidecar > classic`) and the hand-editable `app-mode.json` sidecar, directory-watched, fail-safe on unknown values, never overwriting user text. Nothing consumes it yet; Classic is byte-unchanged. |
| `2ebbe5f8f` | Orchestration human-loop wiring: `ask --task` opens a real gate stamped with `origin_message_id` (schema v7 → v8, nullable, downgrade-safe); `gateResolve` answers the blocked worker on its thread; coordinator diagnostics land in a bounded per-run ring (`orca orchestration run-log`); crash-stranded runs are failed at first DB open instead of reported running forever. |
| `6ab012b18` | The **Safe** permission preset: codex `--sandbox workspace-write --ask-for-approval never`, gemini `--sandbox --approval-mode yolo` + pinned `GEMINI_SANDBOX=true` (gemini lets that env var beat the flag; `true` fails closed). Stored intent (`agentPermissionPreset`), preset-aware Reset, catalog-growth reconciliation, onboarding escalation guard, ko/zh copy. Yolo/Manual byte-identical; custom args never clobbered. |
| `d0a764895` | The design document itself, amended where implementation had already landed or corrected earlier survey claims. |
| `304ace7e4` | Fail-closed unattended dispatch: under Safe, `Coordinator.dispatchTask` only drives workers whose *actual* launch verifies confined + silent (`decideUnattendedAgentDispatch` over `getTerminalAgentLaunchProfile`); refusals skip the circuit breaker and land in the run log. |

## The safety model, in three sentences

Presets are named points on the confinement × approvals grid: `yolo` = unconfined +
silent, `safe` = confined + silent, `manual` = unconfined + prompting. Membership in
`SAFE_TUI_AGENT_ARGS` is a verified claim of OS-enforced confinement (Seatbelt /
container — never model politeness), and absence is a statement: under Safe an
unconfinable agent runs with its own prompts, never a bypass flag, because prompts block
while bypass destroys. Enforcement always judges the *actual* launch — args, env, and
the running pty's agent — never a stored label, and anything unverifiable in an
unattended context refuses with the fix named in the run log.

## Where the mode build picks up

Per the build order in `app-modes.md` §12, in dependency order:

1. **Mode selection surfaces** — the `View ▸ Mode` menu radio, the Settings control, and
   sidecar watching are specified (§3) but unwired; `resolveAppMode` and the sidecar are
   live and tested, so this is UI + IPC broadcast only.
2. **The three layout slots** in `AppWorkspaceShell`/`AppPageRouter` (§5.2) — the shell
   refactor made these prop-driven; no further extraction is a prerequisite.
3. **ALab surfaces** — recomposition over now-working machinery: the gate queue reads
   `gateList`, the exceptions view reads the run log, mission state reads runs that no
   longer lie after a restart.
4. **Story World** — the stage, composer, and world persistence (§7), with the agent
   picker filtered by `agentSupportsConfinedLaunch` and the preset locked via the
   sidecar's `lock`.

Open questions needing the product owner are in `app-modes.md` §13; the two still-open
safety items are Story World's picker filtering (the predicate is live, the picker is
not) and Codex `sandbox_mode` config-level enforcement (deliberately excluded from
`PROMOTED_CODEX_SETTING_KEYS` if ever added).

## Verification state at close

All gates clean at `304ace7e4`: three TypeScript projects, full `oxlint` (zero
suppressions added anywhere in this work), the max-lines ratchet (baseline shrunk, never
grown), switch-exhaustiveness, localization catalog + coverage, Rust `orca-runtime`
suites 27/27 including the v1→v8 migration fixtures, and the renderer/main/shared vitest
suites over every touched area (≈20k tests). The one pre-existing failure found during
the work — `updater.headless-serve-install.test.ts`'s mock of `updater-install-policy`
missing the `usesSelfManagedCheck` export its three sibling suites already stub — was
fixed as a follow-up, so the suite is fully green.
