# Orca Modes — Roadmap

**Status: active (undeferred 2026-08-05).** The *mode* foundation is landed and green
(see [`app-modes-conclusion.md`](./app-modes-conclusion.md), `main` at `3e7e6babf`).
The *orchestration* foundation Phase 2 stands on was not, at that commit: the CLI still
dropped `--task` from `orchestration ask`, `orchestration run-log` had a spec and no
handler (`registry-parity.test.ts` red), and a restart stranded dispatches that held
`maxConcurrent` slots forever. That tail closed in `1bef9915a` (2026-07-30), so Phase 2's
premise below is true as of HEAD and was not true when this file was written.

**What changed while this file said "deferred".** The engine kept moving: R0 of
[`alab-auto-mode-design.md`](./alab-auto-mode-design.md) is now **complete** — event
journal, input coordinator, `submitAgentPrompt`, schema v9 with the audit ledger,
`orchestration.runList`, the §3a identity types, the `provider-limit` fact, §6.6 grants
with an issuer, and the experimental gate. So Phase 2's floor below is not merely true,
it is under-stated; read it against §12 of that document.

**What has NOT moved: mode selection.** `src/shared/app-mode/` and `src/main/app-mode/`
are still consumed by nothing, `appMode` is still absent from `GlobalSettings`, and no
mode can be entered. Phase 1 remains the gate for every mode surface.

This is the forward plan. Written to be picked up cold:
every phase names its entry points, the machinery it consumes, and a definition of done.
The full architecture behind each item is [`app-modes.md`](./app-modes.md); the follow-on
engine work — durable ownership, verified submit, transactional gates, account routing —
is [`alab-auto-mode-design.md`](./alab-auto-mode-design.md).

## Ground rules carried forward

- **Classic never regresses.** Every phase ships dark until its mode is selected;
  `resolveAppMode` defaulting to `classic` with an absent sidecar is the invariant.
- **Modes gate, place, and reword — never own engine state.** No phase may unmount the
  terminal workbench or write workspace/session state (`app-modes.md` §1).
- **Safety judges reality, not labels.** Any new launch or dispatch surface goes through
  `decideUnattendedAgentDispatch` / `agentSupportsConfinedLaunch`, judged against actual
  launch config.
- House rules apply throughout: no max-lines suppressions (split files), no
  helpers/utils naming, tokens from `main.css` only.

## Phase 1 — Mode selection surfaces

*Everything below the UI already exists: `src/shared/app-mode/` (id + resolver, tested)
and `src/main/app-mode/` (sidecar read/write/watch, tested).*

| Item | Entry point |
| --- | --- |
| Resolve mode at startup; expose over IPC with a `mode:changed` broadcast to all windows | `src/main/index.ts` startup, beside settings registration |
| `View ▸ Mode` radio group (three items, CmdOrCtrl-free, checked from resolved mode) | `src/main/menu/register-app-menu.ts` — mirror the `AppearanceMenuState` rebuild pattern |
| Settings ▸ Mode control + first-run explanation of modes | new pane section; search entries like `agents-search.ts` |
| Sidecar writer behind both selectors; watcher → live re-resolve → broadcast | `writeAppModeSidecar` / `watchAppModeSidecar` |
| Unknown-mode launch toast with a Fix action (never overwrite the user's file) | renderer toast host |
| `ORCA_APP_MODE` env pin disables both selectors with an explanatory label | `isAppModeSelectionLocked` |

**Done when:** switching mode from any of the three surfaces updates every open window
without restart; a hand-edited sidecar takes effect on save; unknown values boot Classic
with the toast; E2E pin via the env var.

## Phase 2 — ALab mode

**Superseded by [`alab-auto-mode-design.md`](./alab-auto-mode-design.md) §9 (R3)** once that
build starts: R3 delivers this entire surface list *plus* BurnMeter, the exception lanes,
the OrchestratorPane grant handoff and the New Mission dialog, and depends on Phase 1 only.
Read the list below as the floor.

*Recomposition over machinery that now works — true as of `1bef9915a` (2026-07-30), not at
the commit this file was pinned to: gates answer their askers, run logs exist and have a CLI
reader, stranded runs are failed at startup and orphaned dispatches reconciled at run start,
unattended dispatch is fail-closed, and the coordinator dispatches only into panes it created
or can verify are running an agent.*

- Mode-gated shell: swap `AppPageRouter` content for the supervisory layout via the
  three prop-driven slots in `AppWorkspaceShell` (`app-modes.md` §5.2, §8.3). Files,
  diffs, tabs hidden but mounted.
- **Gate queue** — reads `orchestration.gateList`; resolving calls `gateResolve` (which
  now answers the blocked worker). The "Nothing is waiting on you" empty state is
  truthful since `ask --task` creates real gates — from the CLI too, since `1bef9915a`.
- **Run health / exceptions** — reads `orchestration.runLog` (stall warnings, retries,
  terminal-creation failures); a run interrupted by restart shows as failed, not running.
  There is no `runList` method yet (`run`, `runStop`, `runLog` are the run methods) — the
  `mission-progress.ts` + split-counter row of `app-modes.md` §8.1 is the one Phase-0 item
  still unlanded, and this bullet is what consumes it.
- **Mission strip + fleet roster** — group by `coordinatorHandle ?? orchestrationRunId`
  (§13 Q9); per-worker launch-posture badge from `getTerminalAgentLaunchProfile`
  (§13 Q11: show yolo honestly).
- **Escalation** — desktop notifications first; mobile `gateResolve` allowlisting is a
  separate decision (§13 Q6, recommended resolve-only).

**Done when:** a scripted fleet run (spec → workers → one `ask --task` → gate answered
from the queue → convergence) is fully drivable from the ALab shell with the terminal
never opened, and a kill-restart mid-run shows truthful state.

## Phase 3 — Story World mode

*Blocked on nothing technically; blocked on the owner's §13 decisions (lock semantics,
sandbox posture) being confirmed at build time.*

- **Agent picker filtered by `agentSupportsConfinedLaunch`** — the live predicate;
  unconfinable agents are not offered, fail-closed (no warn-and-continue).
- **Preset + mode lock** — Safe preset forced while active; `app-mode.json` `lock: true`
  makes selectors read-only (§13 Q1: child can leave, parent can put back).
- Chat-first three-band layout in the shell slots: worlds list, aterm-native agent
  terminal (real chat framing, not a React chat pane), live game pane.
- **Artifact-style preview** — self-contained `game.html` rendered in the browser pane;
  reload on save; no dev server, no build step (owner decision, supersedes the
  localhost-proxy option). SSH workspaces: defer or read-through — decide then.
- Story Saves (snapshot/restore), black-screen recovery, parent panel (honest meter,
  no fake `$0.00`), copy at `--app-font-scale` + `touch` targets.

**Done when:** a cold start to a playable, edited, saved, and resumed world happens with
no reading-dependent step, and the agent demonstrably cannot write outside the world
folder (codex Seatbelt verified on the machine).

## Phase 4 — Scope and policy

- `Repo.appMode` per-project rung (§2.8 rung 3, follows the `sourceControlAi` pattern).
- Crash reports and telemetry record the active mode.
- Mobile/relay mode awareness; CLI `--mode` override if demand appears.
- Promote proven mode surfaces into Classic deliberately (fleet board, live preview).

## Decisions needed from the owner (before the phase that consumes them)

Condensed from `app-modes.md` §13 — each has a recommendation recorded there:
lock semantics (Q1, Phase 3) · sandbox claims vs. reality in copy (Q2, Phase 3) ·
`ask` verb with two answerers (Q4, **now overdue** — `1bef9915a` shipped the `ask --task`
CLI half, so both answerers are live) ·
the 2am problem scope (Q5, Phase 2) · mobile gate control (Q6, Phase 2) ·
fleet grouping key (Q9, **decide before FleetBoard headers are written**).

## Explicitly deferred, on purpose

- Claude confinement under Safe (settings-JSON sandbox, not args-expressible; needs the
  managed-settings seam — until then Claude runs manual under Safe, honestly).
- Codex `sandbox_mode` config-level enforcement (must stay out of
  `PROMOTED_CODEX_SETTING_KEYS` if ever added).
- Coordinator-run resume across restart (currently failed-at-startup, truthful; a real
  resume loop is its own project).
- A fourth mode, spend caps, and network policy beyond the existing PTY proxy env.
