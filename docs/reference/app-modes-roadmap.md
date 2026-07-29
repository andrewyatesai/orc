# Orca Modes — Roadmap

**Status: deferred, not in progress.** The foundation is landed and green
(see [`app-modes-conclusion.md`](./app-modes-conclusion.md), `main` at `3e7e6babf`);
this is the forward plan for whenever the build resumes. Written to be picked up cold:
every phase names its entry points, the machinery it consumes, and a definition of done.
The full architecture behind each item is [`app-modes.md`](./app-modes.md).

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

*Recomposition over machinery that now works: gates answer their askers, run logs exist,
stranded runs are failed at startup, unattended dispatch is fail-closed.*

- Mode-gated shell: swap `AppPageRouter` content for the supervisory layout via the
  three prop-driven slots in `AppWorkspaceShell` (`app-modes.md` §5.2, §8.3). Files,
  diffs, tabs hidden but mounted.
- **Gate queue** — reads `orchestration.gateList`; resolving calls `gateResolve` (which
  now answers the blocked worker). The "Nothing is waiting on you" empty state is
  truthful since `ask --task` creates real gates.
- **Run health / exceptions** — reads `orchestration.runLog` (stall warnings, retries,
  terminal-creation failures) and `runList`; a run interrupted by restart shows as
  failed, not running.
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
`ask` verb with two answerers (Q4, **decide before more Phase-2 CLI surface**) ·
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
