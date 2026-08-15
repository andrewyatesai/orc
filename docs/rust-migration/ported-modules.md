# Ported Modules Ledger

Tracks the TS→Rust port at module granularity so the migration is continuable.
Authoritative inventory of what each subsystem does lives in `functional-map.md`.

## Green parity does not mean the port is faithful — check before cutting over

`pnpm parity` compares each port against its twin **on the vectors that exist**.
That is a coverage claim, not a fidelity claim, and the gap is not theoretical:
six modules on this ledger answer differently from their twin today, on input
production reaches, with parity green.

The mechanism is always the same. A port is taken at some commit; the twin then
grows behaviour (usually an upstream fix); the vector corpus does not grow with
it; nothing notices. `port-provenance-attributions.md` re-pinned several of these
under "every vector-backed module in the drift set is behaviorally in sync at
HEAD" — true only of the vectors that exist.

**`pnpm parity:twin-derived` measures it.** It records every call the twin's own
unit tests make — real inputs, the twin's real answers — replays them through the
Rust core, and reports the disagreements. The twin's tests are the right source
because a twin does not grow behaviour without growing a test:
`tab-title-resolution.test.ts` has six `OC |` cases against the vector corpus's
zero. Run it before starting a cutover; a STALE module needs a re-port first, and
attempting the cutover instead burns the slot.

STALE at the time of writing (27 modules compared, 170 derived cases the corpus
does not have):

| Module | What the core is missing |
| --- | --- |
| `synthetic-agent-title` | knows 5 agents; the twin knows 8 (adds pi, omp, devin) |
| `agent-status-types` | no dispatch-preamble compaction; drops `interactivePrompt` entirely |
| `mcp` | none of the four inspection bounds — size, field count, key and value caps |
| `cross-platform-path` | treats a literal `\` as a separator; no NFD/NFC folding |
| `tab-title-resolution` | no native-OpenCode-title branch (88068f55b, #9080) |
| `workspace-session-terminal-buffers` | caps preserved SSH scrollback in **chars**, the twin in UTF-8 **bytes** — 2× the payload for CJK or accented text |

Three of the six were separately confirmed against the shipped `orca_git_wasm_bg.wasm`
and `orca_node.node`, not just the from-source build, so this is what ships.

The report also has an OUT-OF-SHAPE bucket, which is not a defect list: those
derived cases carry input keys no vector supplies, and some ports are lean by
design (`toDetectedWorktree` spreads its input into its output, so a richer input
produces a richer answer than Rust was ever given). Review those; do not count
them.

### A clean verdict means "nothing found", not "nothing there"

Batch 5 took seven modules this tool called clean and four of them still had to
be refused. Read a clean row as a floor, not a certificate:

* **Input classes no unit test writes down.** `commit-message-models` diverges on
  8 of 23 probes of raw agent-CLI stdout — and those outputs are the PERSISTED
  model selection and the `--model` argv. `task-claim` diverges when a lone
  surrogate reaches the DB as the six ASCII characters of a `\uD800` escape: the
  codec passes it, `serde_json` rejects it, and the core answers
  `unreadable-result` where the twin answers `mismatch` — silencing the fleet's
  only contradicting signal, in the direction that exonerates the audited agent.
* **Behaviour that lives in a sibling module.** `pairing` delegates all
  validation to `mobile-relay-pairing-offer.ts`, whose tests are in a file this
  tool never records for `pairing`. The port has none of that module's relay v1
  sub-object; 10 of 13 probed inputs diverge.
* **Exports with no vector at all** — now reported rather than skipped silently,
  with whether the Rust dispatch module has an arm for them. 18 modules have at
  least one export the corpus has never named AND no Rust route. `stable-pane-id`
  is the cautionary one: `makePaneKey` mints the key used at
  `TerminalPane.tsx:3221` as a React key, has ~60 importers, and both shipped
  cores answer "unknown function makePaneKey". A shim would have thrown on every
  pane key the moment wasm initialised.

### Verify the tree you are about to COMMIT, not the one you are sitting in

The maintainer's working tree carries ~1500 uncommitted files, so a green
`pnpm typecheck:*` in the worktree says nothing about what lands. Batch 4 shipped
four files importing names it had moved out from under them, and every one was
invisible locally. Materialize the index and check that instead:

```sh
tree=$(git write-tree) && commit=$(git commit-tree "$tree" -p HEAD -m verify)
git worktree add --detach /tmp/verify "$commit"
ln -s "$PWD/node_modules" /tmp/verify/node_modules
cd /tmp/verify && pnpm typecheck:node && pnpm typecheck:web
```

Compare against the same two commands on the commit you branched from — the
baseline is not zero, and only NEW errors are yours.

`protocol-compat` is cut over (`protocol-compat-verdict`, pre-ready `parity`);
`worktree-id` and `nested-repo-telemetry` verified safe but are NOT landed, and
`worktree_id.get_worktree_path_basename_from_id` carries a known divergence found
by an adversarial sweep rather than by this tool: it trims with Rust
`char::is_whitespace` where the twin uses JS `String.prototype.trim`, so a path
segment containing U+0085 (Rust only) or U+FEFF (JS only) answers differently.
The other three worktree-id functions are clean.

### What is actually left, and what each one is waiting on

40 of the 85 vector-backed modules hold no twin implementation any more. Of the
rest, the blockers fall into four kinds, and only the first is a cutover problem:

| Blocker | Count | What unblocks it |
| --- | --- | --- |
| nothing — clean and cuttable | 14 | a cutover slot |
| an export with NO Rust dispatch arm | 13 | a Rust change, not a shim |
| a divergence outside the corpus shape | 3 | judgement: lean port, or a real gap |
| deliberate never-cut-over | 3 | nothing; see below |

**No Rust dispatch arm** is the big one and it is invisible to `pnpm parity`,
because the corpus cannot miss a case for a function it has never named.
`orca_core` frequently implements the function while
`rust/crates/orca-dispatch/src/modules/<mod>.rs` never registers it, so the
shipped cores answer `unknown function <name>`. `stable-pane-id::makePaneKey` is
the worked example: ~60 importers, used as a React key, no arm. A cutover here
throws on the first call once wasm initialises. Regenerate the list with
`pnpm parity:twin-derived`; it prints every export with no vector and whether an
arm exists.

**Never cut over, on purpose.** `nacl-box` and `orchestration-store` are
parity-only oracles, held out of the shipped artifacts so rusqlite and curve25519
do not bloat the relay wasm. `keep-tail` is a hot path whose `update` runs on
every pending-data change.

**Open judgement calls.** `worktree-id` is cut over in the working tree and
verified safe, but costs 19x-65x per call on the ready path
(`getRepoIdFromWorktreeId` 9ns -> 581ns wasm / 346ns napi), reaching a leaf sweep
the repo's own tests build at 2,773 elements. `worktree-ownership` is a lean port
by design and its 15 "divergences" are passthrough fields Rust was never handed.

## The per-module pattern

0. `pnpm parity:twin-derived` — a STALE module is re-ported, not cut over, and an
   export with no Rust dispatch arm needs the arm before the shim.
1. Read the `src/shared/<mod>.ts` source **and** its `.test.ts`.
2. Port the logic to `rust/crates/orca-core/src/<mod>.rs`, faithful to behaviour.
3. Translate the original test cases **verbatim** into a `#[cfg(test)]` module.
4. `cargo test` + `cargo clippy` green; keep the core zero-dep, `forbid(unsafe)`,
   panic-free (so Trust can discharge panic-safety obligations).
5. Record it here; mark the owning subsystem in `functional-map.md` when fully covered.

## The shim boundary contract (read before writing the TS wrapper)

Never hand-roll `JSON.parse(binding.orcaDispatch(m, f, JSON.stringify(input)))`.
`JSON.stringify` emits a lone UTF-16 surrogate as `"\ud800"` — valid JSON text
that serde cannot decode as UTF-8, so the WHOLE payload fails to parse — writes
`null` for `NaN`/`±Infinity`, and drops keys whose value is `undefined`. Rust used
to answer a parse failure with `Value::Null`, i.e. a no-arg call, so the module
returned a confident wrong answer with nothing logged (measured on `task-claim`).

* Encode with `encodeDispatchPayload` from `src/shared/dispatch-payload-codec.ts`
  (`encodeNumericDispatchPayload` for all-numeric payloads on a hot path). It
  throws `DispatchPayloadError` naming the field and why; the full table of what
  crosses and what is rejected is the header comment of that module.
* Decode with `decodeDispatchResult`, which throws `DispatchCoreError` on the
  `__dispatch_error__` envelope so an error can never be returned as a result.
* The Rust half is `rust/crates/orca-dispatch/src/json_entry.rs`, shared by the
  napi and wasm bindings: `""` is the no-arg call, anything unparseable is an
  `__dispatch_error__`, never a silent null.
* Encoder overhead vs bare `JSON.stringify`:
  `node config/scripts/dispatch-payload-codec-benchmark.mjs [--check]`.

## The pre-ready fallback contract (every renderer revert was this one bug)

> **The value a shim returns before the wasm is ready must be what the deleted
> TypeScript would have returned for THAT input — or something the caller can
> tell apart from an answer. Never a third thing that merely type-checks.**

Seven renderer cut-overs were attempted; four were reverted, and all four failed
the same way: the shim's pre-ready value was a plausible-looking value the caller
consumed as a real answer.

### The worked example — `repo-badge-color`

The shim returned `null` before the wasm compiled, where the deleted TS had
returned `DEFAULT_REPO_BADGE_COLOR`. `ColorPicker` computes
`hasInvalidDraft = draft.trim().length > 0 && !draftColor`
(`src/renderer/src/components/ui/color-picker.tsx:48`), so it showed "Invalid hex
color" and `aria-invalid` against a perfectly valid colour — and `updateColor`
then wrote default gray over the user's saved repo colour on any colour-wheel
drag. Silent data loss on a user setting, from one word in a fallback.

The instructive part is what happened next. The fix swapped `null` for
`DEFAULT_REPO_BADGE_COLOR` — *the constant the twin used* — and **it is still
wrong**, because `resolveRepoBadgeColor` does not return that constant for every
input; it returns it only for an *invalid* one:

```
resolveRepoBadgeColor('#ff0000')   pre-ready '#737373'   ready '#ff0000'
normalizeRepoBadgeColor('nope')    pre-ready '#737373'   ready null
```

`updateColor` calls `resolveRepoBadgeColor(nextColor)` and persists the result,
so on a wasm-load failure a wheel drag *still* saves gray. Both candidate
constants are lies because the twin's answer **depends on the input**. That is
case 3 below, and no fallback value can rescue it.

**How it was finally landed** (2026-08). Both functions return `undefined` — a
value the ready core never produces, so it can never be read as an answer — and
each caller is explicit about what it does with it:

* `ColorPicker` subscribes with `useSyncExternalStore(subscribeGitWasmAvailability,
  isGitWasmReady)`, **disables its trigger** while the sentinel is showing, gates
  `hasInvalidDraft` on readiness (so a valid hex is never flagged), and returns
  early from `updateColor` — the wheel cannot reach `onChange` at all.
* `store/slices/repos.ts` `sanitizeRepoUpdate` (and the main-side twins) drop
  `badgeColor` from the update exactly as for an invalid colour, so an
  unvalidated value cannot enter the store or the persisted repo record.
* The read-only painters (`sidebar/project-header-color.ts`,
  `ai-vault-session-row-display.tsx`, `settings/RepositoryIcon*`) fold the
  sentinel into the neutral default — a swatch has to be *some* colour — and each
  one carries a WHY naming why that value is never written back.

Pinned by `repo-badge-color-pre-ready.test.ts` (both wrong candidates asserted
against by name) and `color-picker.core-unavailable.test.tsx` (no false invalid
state, no `onChange`).

### The three cases

**1 — the twin returned a constant for this input → return that same constant.**
The constant is almost always still in TS: a cut-over twin is reduced to types
and data, so `DEFAULT_*` / catalog tables survive in `src/shared/`. Import it.

```ts
// good: the no-settings answer IS the constant the twin returned
if (!isGitWasmReady()) {return defaultPresentation()}   // github-pr-merge-methods
```

**2 — the twin returned null/undefined *for this input* → null is correct.**
"The twin returns null for *some* inputs" is not this case. `repo-icon`'s
`faviconUrlFromWebsite` is commented "the original legitimately returns null, so
null is a valid not-ready fallback" — that reasoning is invalid; the twin
returned null for an unparseable site, not for `https://x.dev`.

**3 — the twin's answer depends on the input (a predicate, a parse, a
normalizer, a ranking) → there is no honest value, so the caller must handle
not-ready explicitly.** Do not pick the "safe direction" and move on: `false`
from a predicate and `''` from a slugifier are indistinguishable from real
answers.

The shape of a handled case 3 — the shim returns a signal, the caller branches
on it, and a surface that must show something re-renders on the ready edge:

```ts
// shim: null is NOT "no checks" — it is "ask again"; ChecksPanel skips the update.
export function gitLabPipelineJobsToPRChecks(jobs: GitLabPipelineJob[]): PRCheckDetail[] | null {
  if (!isGitWasmReady()) {return null}
  return dispatchToWasmCore('gitlab-pipeline-checks', 'gitLabPipelineJobsToPRChecks', jobs)
}

// caller: branch, never `?? []`
const checks = gitLabPipelineJobsToPRChecks(jobs)
if (checks) {setChecks(checks)}   // keep the last good panel; the next poll repopulates

// caller that must render now: recompute the moment the core lands
useSyncExternalStore(subscribeGitWasmReady, isGitWasmReady)
```

`?? []`, `?? false`, `?? ''` at the call site is the same bug moved one file
over: it re-manufactures the indistinguishable value the shim refused to invent.

**Signal at the level that has a spare state.** If the twin returned one ROW of
a list, a per-row sentinel has nowhere to go: the caller either keeps a hole or
drops it, and dropping every row lands on `[]` — the value that already means
"nothing matched". A search has three answers (rows / nothing matched / could
not search) and a row type can only carry two, so lift the shim to the list:
`base-ref-search-result` exports `legacyBaseRefSearchResults(refNames):
BaseRefSearchResult[] | null`, where `null` is could-not-search and both callers
throw `BaseRefDetailsUnavailableError` on it, so the search REJECTS and the
picker shows its failure line instead of "No matching branches".

### What "explicitly" means here

* **Return `null` and say who branches on it.** The shim's header comment names
  the caller and the branch — not "callers are null-safe" but "ChecksPanel skips
  that poll's update". `gitlab-pipeline-checks` is the model.
* **Make the surface recompute on the ready edge.**
  `useSyncExternalStore(subscribeGitWasmReady, isGitWasmReady)` — see
  `QuickOpen.tsx:73` and `useDiffSectionLayoutMetrics.ts:31`.
* **Stop scheduling when it will never be ready.** `isGitWasmUnavailable()`
  (`git-wasm-availability.ts`) is true only after a terminal failure. A retry
  loop or a spinner must terminate on it; the user has already been told once
  (`git-wasm-unavailable-report.ts`).
* **Never let a pre-ready value be written back.** If the result flows into
  `updateSettings`, a store reducer, or an `onChange`, case 3 is not optional —
  a wrong answer becomes persisted state. This is the difference between a
  cosmetic degrade and the repo-badge-color incident.

### Two things that are not justifications

* **"The boot window is only tens of ms."** `awaitGitWasmReadyForStartupHydration()`
  gates hydration, so a post-mount call that finds the core not-ready has found a
  core that **failed** — the fallback is the behaviour for the whole session, not
  a blip. Many existing shim comments still argue from the window; they are wrong
  about the frequency and the audit below assumes the terminal case.
* **"Main re-normalizes it anyway."** Only true for values that make the IPC
  round trip. It says nothing about what the renderer rendered, compared, or
  persisted locally in the meantime.

### The gate

`src/renderer/src/lib/git-wasm/shim-pre-ready-contract.test.ts` checks the rule
mechanically, and soundly: because the Rust core is a parity port of the deleted
twin, **the twin's answer is the ready answer**, so the test calls each shim
before `initGitWasmForTestFromBytes` and again after, and compares. Every row is
an observed fact — it cannot false-flag a legitimate null. Each row declares one
of:

* `parity` — pre-ready equals ready (cases 1 and 2);
* `sentinel` — pre-ready is a declared not-ready signal, with `handledBy` naming
  the caller branch (case 3, handled);
* `divergence` — a KNOWN VIOLATION, pinned so a fix turns the row red and gets
  re-declared rather than silently drifting back.

**A cut-over adds a row per exported function.** What the gate cannot prove is
that a `sentinel`'s caller actually branches — that stays a review obligation,
which is why `handledBy` is a required string.

### Audit of the existing shims (2026-07; 31 shims + 5 infra modules)

Compliant: `gitlab-pipeline-checks`, `agent-tab-title`, `git-remote-error`
(fail-closed on purpose: never show an unscrubbed URL), `setup-script-telemetry`,
`commit-message-generation`, `commit-message-plan`, `pull-request-generation`,
`tui-agent-startup`, `quick-open`, `agent-notification-id`, `git-line-stats`,
`github-pr-merge-methods` (for the no-settings input), `repo-icon.githubAvatarIcon`
(the fallback rebuilds the same icon inline), `git-publish-target-status`
(same shape: the fallback rejoins `remote/branch` inline, so pre-ready equals
ready for EVERY input — required, because the sole caller equality-compares it
to `upstreamStatus.upstreamName` to unlock "Push linked review", and a `null`
sentinel would read equal to an absent `upstreamName` and push at a target the
upstream never matched), `base-ref-search-result` (case 3, handled — see below),
`terminal-surface-id` (all three mappings rebuild the twin inline, for the same
reason as `git-publish-target-status`, only harder: these values ARE the tab
identity — `toWebTerminalSurfaceTabId` keys `tabsByWorktree` and feeds
`makePaneKey()`, and `web-session-terminal-orphan-recovery.ts` REAPS every local
surface whose `toHostSessionTabId(tab.id)` key is missing from the host's live
set, so `null`/`''`/`false` would kill live terminals. One pinned `divergence`
row covers the READY side, not the fallback: on a malformed percent-escape the
twin's `catch` returned the whole `web-terminal-…` id and the Rust core returns
the decoded slice — the `allowDivergence` case already recorded in the vectors,
unreachable for ids minted by `toWebTerminalSurfaceTabId`).

`browser-viewport-presets` (2026-08, case 1 both ways): the twin's answers came
entirely out of the preset TABLE, which survives in the data-only
`src/shared/browser-viewport-presets.ts` — the dropdown still renders it — so the
fallback finds the row / copies the four emulation fields inline and pre-ready
equals ready for every input. Parity is mandatory, not tidy: both results go
straight to `window.api.browser.setViewportOverride`, so a `null` would send
`override: null` while `setBrowserPageViewportPreset` has already persisted the
id — the menu shows "Tablet" checked over a desktop-sized page, reasserted by
`BrowserPane` on every dom-ready for the rest of the session.

`git-upstream-force-push-decision.shouldForcePushWithLeaseForUpstream` (case 3,
handled) is the newest, and the FIRST shim on the shared dispatch seam rather
than in `src/renderer/src/lib/git-wasm/`: two `src/shared` decision modules
(`source-control-primary-action-decision`, `source-control-create-review-intent`)
call it, and a `src/shared` module cannot import a surface-specific binding. Its
pre-ready value is `undefined` because the twin answered from the input and
NEITHER boolean is even the safe direction — `false` sends `syncBranch` down
`git pull`, re-merging the stale patch-equivalent commits a force-with-lease
exists to replace; `true` force-pushes. **The fallback errs toward WITHHOLDING**:
the diverged primary renders its counts with the button DISABLED, the dropdown
folds the sentinel into `upstreamLoading` so Sync / Pull / Fast-forward /
Commit & Push / Commit & Sync / Push-before-review disable themselves, both
Create-PR-intent resolvers withhold the one-click prepare, and `syncBranch`
throws into the existing "Sync failed" toast. Explicit Push / Force Push stay
enabled — the user names those, and the predicate only *worded* them. Because
`config/vitest-orca-dispatch-seam.ts` binds the seam for every test file,
`shim-pre-ready-contract.test.ts` now unbinds it before the pre-ready pass, or a
seam shim's row would pass vacuously. `isBehindOnlyUpstream` stays TypeScript in
`src/shared/git-upstream-status.ts`: orca-core has no counterpart and the vectors
have no cases for it, so it is unported, not un-cut-over.

`git-push-target-shape.assertGitPushTargetShape` (compliant, `parity`) is the
second shared-seam shim: main's five `git:*` SSH IPC handlers, `worktree-remote`'s
SSH push-target prepare, and the relay's four git-handler entry points all
validate the same wire value, so one seam shim serves both trees (`src/main/git/*`
keeps its napi `validateGitPushTargetRules` shim — same Rust rules, main-only
seam, and now cross-checked against this one instead of the deleted twin). An
`asserts` function has NO spare state — throw and return are both real answers —
and it is the anti-traversal gate on a value replayed into `git push`, so the
fallback rebuilds the twin's body from the kept rule constants and is the twin's
answer for every input. Two hazards drove the shape of it, both from the reverted
first attempt: (1) only the three validated fields cross, never the caller's
object, or a lone surrogate on an unread sibling key (`remoteCreated`, notes)
would fail the encode and flip an accept into a reject naming a field the twin
never read; (2) `DispatchPayloadError` is caught and answered locally, because a
lone surrogate is reachable off the wire (relay `JSON.parse`, Electron structured
clone) and the twin ACCEPTED one in `branchName` — its rule is only non-empty +
no leading `-`, with `check-ref-format` as the next gate — while rejecting one in
`remoteName`. A `DispatchCoreError` still propagates.

Violations, worst first — value written back to persisted state:

| Shim | Pre-ready | Twin (ready) | Consequence |
| --- | --- | --- | --- |
| `terminal-fonts.normalizeTerminalFontWeight` | `500` | the input weight | the settings slider commits the normalized value — any drag persists 500 |
| `terminal-quick-commands.normalizeTerminalQuickCommands` | `[]` | the list | `store/slices/settings.ts` persists it: one unrelated settings write empties the user's quick commands (the TS twin is *still implemented* in `src/shared/terminal-quick-commands.ts` — the pre-ready answer is one import away) |
| `network-proxy.normalizeProxyUrl` | `{ok:true, value:draft}` | `{ok:false, message}` | an unvalidated proxy URL is persisted and the error is never shown |
| `task-providers.normalizeTaskProviderSettings` / `normalizeVisibleTaskProviders` | the raw persisted value, cast | the normalized list | unvalidated junk is typed as `TaskProvider[]` and stored |
| `repo-icon.sanitizeRepoIcon` | the input icon | `undefined` for an unsafe `src` | a `javascript:` icon bypasses the sanitizer into the reducer |
| `open-in-applications.normalizeOpenInApplications` | the input array | the normalized list | blank/duplicate rows enter the settings reducer un-normalized (main re-normalizes on set — see "not justifications" above) |

Violations — wrong answer, not persisted:

| Shim | Pre-ready | Twin (ready) | Consequence |
| --- | --- | --- | --- |
| `hosted-review-refs.normalize*Ref` | the ref unchanged | `refs/heads/main` → `main` | ref-vs-branch comparisons miss (`create-review-draft-title`, eligibility snapshot) |
| `task-query.*` | empty parse / `''` / query unchanged | the parse | TaskPage shows everything unfiltered; a filter click no-ops; `stripRepoQualifiers` leaves `repo:` on cross-repo fan-out |
| `task-providers.filterAvailableTaskProviders` / `resolveVisibleTaskProvider` | unfiltered / the preference | filtered | unavailable providers stay in the UI |
| `branch-name-from-work.sanitizeBranchSlug` | `raw.trim().toLowerCase()` | `fix-the-bug` | the "slug" keeps spaces and punctuation — not a valid git ref |
| `branch-name-from-work.isAutoGeneratedCreatureBranchName` / `humanizeBranchSlug` | `false` / unchanged | the real answer | auto-rename silently skipped |
| `terminal-quick-commands` scope/action/matchesRepo/body/complete | `global` / `terminal-command` / `true` / `''` / `false` | the real answer | an agent-prompt command runs down the terminal-command branch |
| `feature-wall-tour-depth` | `'terminal'` / all-zero counts | the real depth | telemetry emitted with a wrong step and a **missing** `furthest_step` field |
| `agent-kind.tuiAgentToAgentKind` | `'other'` | `'claude-code'` | telemetry attributes the run to the catch-all |
| `feature-education-telemetry` | `'unknown'` | the mapped source | same, for on-table sources |
| `workspace-name.slugify*` / `getLinkedWorkItemSuggestedName` | `''` | the slug | `''` reads as "no usable name"; the create form seeds blank |
| `project-groups.getProjectGroupSubtreeIds` | `{root}` | root + descendants | subtree-scoped removals/queries under-scope |
| `workspace-cleanup` predicates | `false` | the real answer | conservative, but a dismissed candidate reappears and a queueable one is not offered |
| `tailnet-address.isTailnetIPv4Address` | `false` | `true` | pairing picks the first interface instead of the tailnet one |
| `hook-command-source-policy` | `'shared-only'` | `'local-only'` | fail-closed by design, but still a wrong answer for a configured user |
| `github-pr-merge-methods` (with settings) | all three methods | the allowed subset | the dropdown offers a method the repo forbids |

Five shims still reach the core through
per-module typed wasm exports (`terminalQuickCommandOp`, `tuiAgentStartupOp`,
`planCommitMessageGeneration`, `buildPullRequestFieldsPrompt`, the
`workspace-name` entries) with their own `JSON.stringify`, so they too skip the
codec's surrogate/NaN/`undefined` rejection.

## `orca-config` — project/config tier (14 modules, 113 tests, clippy clean)

JSON-backed config inspection on **vendored `serde_json`** (`preserve_order`,
so servers list in file order). `mcp` ports `inspectMcpConfigContent` +
`summarizeMcpServer` from `mcp-config.ts`: parse the config JSON, extract the
servers object at the candidate path, summarize each server's transport
(stdio/http/unknown) + status (enabled/disabled/invalid), masking sensitive env
via `orca-text::mcp_env`. JSON is the shared format for configs and IPC, so this
unblocks a broad class of future ports.

| Rust module | Source | Notes |
| --- | --- | --- |
| `mcp` | `mcp-config.ts` (inspect/summarize) | JSON config → server summaries; invalid-JSON handling without leaking contents |
| `setup_script_package_manager` | `setup-script-package-manager-suggestion.ts` | package.json `packageManager` + lockfile-family detection → install-command candidate; ambiguous/multi-family → none; file reads/exists injected |
| `repo_icon` | `repo-icon.ts` | repo-icon sanitize (lucide/emoji/image; reject unsafe URLs, oversized data URLs; tri-state undefined/reset/icon) + favicon/GitHub-avatar builders (hand-rolled URL parse) |
| `pi_overlay_ui_settings` | `pi-overlay-ui-settings.ts` | merge user Pi settings while force-overriding Orca-only safety (`terminal.clearOnShrink`, `hideThinkingBlock`); tolerates malformed shapes |
| `project_groups` | `project-groups.ts` | create/normalize project groups (persisted-JSON normalize, dedupe, parent-cleanup, sort), clear dead memberships, subtree-id collection, next-order; id/clock injected |
| `workspace_statuses` | `workspace-statuses.ts` (+`-defaults`/`-default-migration`) | status-column normalize (sanitize id/label/color/icon, dedupe, cap) + one-shot legacy-default-visual + reversed-order migrations; clamp board width/opacity; group-key encode/decode |
| `feature_interactions` | `feature-interactions.ts` | 37-id feature-interaction catalog + `normalizeFeatureInteractions`/`hasFeatureInteraction` over untrusted persisted JSON (drop unknown ids, reject non-finite/negative `firstInteractedAt`, integer>0 `interactionCount` else 1). Reassigned from orca-core (needs `serde_json::Value`). TS repo-writer meta-test skipped (asserts the TS app, not this logic) |

## `orca-agents` — agent-CLI tier (11 modules, 115 tests, clippy clean)

Seeds the agent-CLI domain (commit-message generation, provider specs, output
parsing). `commit_message_prompt` ports `commit-message-prompt.ts`: the base
prompt assembly + diff truncation, agent-output cleanup (fence/preamble/list-
marker stripping), a POSIX-style custom-command **tokenizer** (quotes + escapes,
no shell expansion) → spawn-ready binary/argv with `{prompt}` substitution, and
**error extraction** from noisy agent stdout/stderr (ANSI strip, last-`ERROR:`
JSON payload, wrapped `Error code:` quoted-message). Over **vendored `regex` +
`serde_json`**.

| Rust module | Source (`src/shared/`) | Notes |
| --- | --- | --- |
| `commit_message_prompt` | `commit-message-prompt.ts` | prompt build + diff truncate, `cleanGeneratedCommitMessage`, `tokenizeCustomCommandTemplate` + `planCustomCommand`, `extractAgentErrorMessage` (JSON + `Error code:` payloads) |
| `tui_agent_selection` | `tui-agent-selection.ts` | agent auto-pick (catalog fallback order), blank preference, disabled-agent normalize/filter; agents keyed by id (catalog = auto-pick order) |
| `commit_message_models` | `commit-message-agent-spec.ts` (parser half) | model-discovery parsers: Codex JSON, one-per-line, Pi whitespace table, Cursor `id - Label`; label/thinking-level derivation, dedupe |
| `commit_message_agent_spec` | `commit-message-agent-spec.ts` (spec half) | 8-agent spec table (binary/prompt-delivery/`buildArgs`/model catalog/dynamic discovery) + lookups, `resolveCommitMessageAgentChoice` (uses `tui_agent_selection`), capability views (no spawn details), dynamic-model synth |
| `pull_request_generation` | `pull-request-generation.ts` | PR-fields prompt build (reuses `truncate_diff_for_prompt`) + fence-tolerant JSON parse with current-field fallbacks (base/title/body/draft) |
| `commit_message_generation` | `commit-message-generation.ts` | commit-draft prompt from staged context + split generated text into subject/body (reuses `clean_generated_commit_message`/`truncate_diff_for_prompt`) |
| `commit_message_plan` | `commit-message-plan.ts` | agent+prompt → spawn-ready binary/argv/stdin; custom-command path, command-override prefix, model/thinking validation, dynamic-model acceptance (composes spec lookups + tokenizer) |
| `agent_status_types` | `agent-status-types.ts` (parser half) | untrusted agent-status payload → lean `ParsedAgentStatusPayload`: state allow-list (`working`/`blocked`/`waiting`/`done`), per-field trim + line collapse (single-line vs paragraph-preserving), strict-`true` `interrupted` gated on `done`, **UTF-16-safe truncation** that drops a trailing lone high surrogate |

## `orca-net` — network tier (1 module, 6 tests, clippy clean)

Seeds the network tier (proxy now; HTTP clients + rate limiting later). std-only,
zero-dependency, IO-free: it computes proxy configuration that higher tiers (PTY
env, HTTP dialers) consume. `network_proxy` ports `network-proxy.ts`, replacing
the WHATWG `URL` parse with a targeted proxy-URL parser (proxy URLs are
`scheme://[user[:pass]@]host[:port]` and the only output is `scheme://[auth@]host`,
so paths/default-port-dropping/IDNA aren't needed).

| Rust module | Source (`src/shared/`) | Notes |
| --- | --- | --- |
| `network_proxy` | `network-proxy.ts` | proxy URL normalize (protocol allowlist, host required, strips path/query/fragment) + redact creds; env precedence (`HTTPS_PROXY`→…→`http_proxy`, `NO_PROXY`/`no_proxy`); bypass-rule normalize; child-process proxy env build |

## `orca-crypto` — E2EE tier (1 module, 5 tests, clippy clean)

NaCl `box` for the encrypted remote-runtime transport, on **vendored
`crypto_box`** (X25519 + XSalsa20-Poly1305; 20-crate pure-Rust stack incl.
`curve25519-dalek` + `fiat-crypto`, built offline). `nacl_box` ports
`e2ee-crypto.ts` (which used `tweetnacl`): keypair-from-seed, shared-box
precompute (`box.before`), and seal/open with the `nonce || tag || ciphertext`
bundle. Nonces/seeds are caller-injected (the IO edge owns the OS RNG), so the
crate vendors `crypto_box` **without `getrandom`** and stays deterministic.

The TS module shipped with **no tests**; the port is gated on the **canonical
NaCl `box` test vector**, so parity is *byte-for-byte* wire-compatibility with
`tweetnacl` (the property mobile/CLI pairing actually depends on) — a stronger
guarantee than the original had.

| Rust module | Source (`src/shared/`) | Notes |
| --- | --- | --- |
| `nacl_box` | `e2ee-crypto.ts` | X25519 keypair-from-seed + shared-box precompute + seal/open; canonical NaCl `box` KAT (`tweetnacl` wire-compat), peer interop round-trip, tamper/short/bad-length rejection |

## `orca-relay` — remote/mobile transport tier (4 modules + base64, 46 tests, clippy clean)

The remote/mobile transport (replaces the `ws`-based relay). `terminal_stream`
is the binary framing it multiplexes terminal traffic over; `pairing` is the
deep-link handshake that bootstraps the session; `e2ee_channel` is the encrypted
session itself, over `orca-crypto`. A private `base64` module (standard +
url-safe) backs both protocols. JSON over **vendored `serde_json`**;
`#![forbid(unsafe_code)]`, panic-free (Trust-ready).

`e2ee_channel` is ported as a **pure reducer**: every input returns a list of
`E2eeEffect`s the transport owner executes (`SendText`/`SendBinary`/`Deliver*`/
`Ready`/`Error`), and the WebSocket, the handshake timer, and the nonce RNG are
**injected at the edge** (same boundary pattern as `orca-git`'s `GitRunner`) — so
the handshake state machine is fully unit-testable with no IO.

| Rust module | Source | Notes |
| --- | --- | --- |
| `terminal_stream` | `terminal-stream-protocol.ts` | frame encode/decode (10 opcodes: output/snapshot×3/resized/error/input/resize/subscribe/unsubscribe), text + JSON payloads; rejects bad version/opcode |
| `pairing` | `pairing.ts` | `orca://pair?code=` deep-link encode/decode + paste-pair parse; minimal `orca://` URL parse (exact host/path route) + offer schema (`v`=2, non-empty fields) replacing zod |
| `e2ee_channel` | `runtime/rpc/e2ee-channel.ts` | NaCl-box handshake state machine (hello→auth→ready) + transparent encrypt/decrypt; token-auth + nonce RNG injected; consecutive-decrypt-failure cap, handshake timeout, destroy-safety. 16 cases (the 1 cross-compat sanity case lives in `orca-crypto`'s interop test) |
| `base64` (priv) | — | standard (`+/=`) + url-safe-no-pad encode, lenient decode; shared by pairing + e2ee_channel |

## `orca-core` — done (49 modules, 271 tests, clippy clean)

| Rust module | Source (`src/shared/`) | Notes |
| --- | --- | --- |
| `cross_platform_path` | `cross-platform-path.ts` | path containment/resolution, POSIX+Windows+UNC |
| `git_cquoted_path` | `git-cquoted-path.ts` | git C-quoted path decode (octal/named escapes) |
| `worktree_id` | `worktree-id.ts` | worktree id parse + folder-instance suffix strip |
| `worktree_ownership` | `worktree-ownership.ts` | worktree ownership classify (orca-managed/unknown-legacy/external) + external-visibility policy + known-layout building; **composes `cross_platform_path` + `wsl_paths`** (Windows-casing & WSL-aware) |
| `worktree_base_ref` | `worktree-base-ref.ts` | `git worktree add` ref qualification |
| `wsl_paths` | `wsl-paths.ts` | `\\wsl.localhost\` / `\\wsl$\` UNC parsing |
| `repo_badge_color` | `repo-badge-color.ts` (+`constants.ts`) | hex colour normalise/expand/validate |
| `git_push_target` | `git-push-target-validation.ts` | remote/branch/URL safety (anti-traversal). **Cut over**: seam shim `src/shared/git-push-target-shape.ts` for main's IPC handlers + the relay, napi shim `src/main/git/rust-push-target-validation.ts` for `src/main/git/*`; the twin keeps only the rule constants both fallbacks rebuild from |
| `gitlab_projects` | `gitlab-projects.ts` | GitLab recents list: most-recent-first, dedupe by host+path, cap at 10 (clock injected as ISO string) |
| `gitlab_pipeline_checks` | `gitlab-pipeline-checks.ts` | GitLab pipeline jobs → provider-neutral `PRCheckDetail` status/conclusion (manual→neutral, scheduled/waiting→queued+pending); shares the Checks panel with GitHub |
| `branch_name_from_work` | `branch-name-from-work.ts` (+`marine-creatures.ts`) | slug sanitise, creature-name detection, prompt build |
| `browser_search` | `browser-url.ts` (search heuristics) | search-vs-URL detection + per-engine search-URL building (Google/DuckDuckGo/Bing/Kagi). **Cut over**: renderer shim `git-wasm/browser-search.ts`; the twin keeps `SEARCH_ENGINE_URLS`/`SEARCH_ENGINE_LABELS` as data and the un-ported navigation normaliser, whose search branch moved to `browser-pane/address-bar-navigation-url.ts` (main never reached it — every main caller passes no engine) |
| `marine_creatures` | `marine-creatures.ts` | 552-entry name corpus (data table) |
| `native_file_drop` | `native-file-drop.ts` | OS file-drop routing by event target path (terminal/editor/composer/sidebar/file-explorer), internal-drag rejection, fail-closed explorer dir. **Cut over**: shared-seam shim `src/shared/native-file-drop-routing.ts` — the real consumer is `src/preload/index.ts`, which can bind neither binding, so both fallbacks rebuild the twin inline (`parity`, mandatory: a bare boolean and a real-answer `null`). `paneLeafId` is unported (orca-core's entry has no such field) and is composed by the shim on BOTH paths; the twin keeps the ids/limits/types plus the unported payload build/validate/guard half |
| `nested_repo_telemetry` | `nested-repo-telemetry.ts` | nested-repo scan/import funnel payloads: count cap+bucket, scan/import outcome classification, UUIDv4 attempt-id (random bytes injected), all-selected from raw counts |
| `tab_title_resolution` | `tab-title-resolution.ts` | tab title/label priority resolution |
| `base_ref_search_result` | `base-ref-search-result.ts` | legacy remote-ref → local branch derivation |
| `github_pr_merge_methods` | `github-pr-merge-methods.ts` | PR merge-method ordering/labelling |
| `stable_pane_id` | `stable-pane-id.ts` | UUID leaf-id validation + pane-key build/parse |
| `setup_runner_command` | `setup-runner-command.ts` | cross-platform setup-runner shell command: bash (POSIX/`/`-paths), WSL UNC→Linux-path rewrite, `cmd.exe /c` for Windows; POSIX/Windows arg quoting |
| `setup_script_telemetry` | `setup-script-telemetry.ts` | setup-script prompt funnel payloads: count→bucket (0/1/2-3/4+), import-vs-configure mode, provider-only (no raw details), action + edited-before-save |
| `feature_wall_tour_depth` | `feature-wall-tour-depth.ts` | onboarding tour depth telemetry: workflow+substep → canonical ordered depth step, furthest-step + visited/completed counts |
| `agent_kind` | `agent-kind.ts` | TuiAgent ↔ telemetry AgentKind mapping |
| `agent_hook_endpoint_file` | `agent-hook-endpoint-file.ts` | parse `endpoint.env`/`endpoint.cmd` hook handshake files (POSIX `KEY=value` + Windows `set KEY=value`), `=`-in-value preservation, required-field check |
| `agent_notification_id` | `agent-notification-id.ts` | deterministic notification dedupe id from worktree/pane/state-start (percent-encoded, truncated ts); `None` on missing field or non-finite timestamp |
| `agent_recognition` | `agent-name-token-match.ts` + `agent-process-recognition.ts` | whole-token agent-name matching (hand-rolled boundaries, no regex lookbehind) + process-name normalization/expected-match |
| `pty_env` | `pty/{terminal-color-env,wsl-orca-env,codex-home-wsl-env}.ts` | PTY env construction (NO_COLOR strip, WSLENV interop, Codex-home flavor) |
| `terminal_fonts` | `terminal-fonts.ts` | font-weight clamp + bold derivation |
| `synthetic_agent_title` | `synthetic-agent-title.ts` | agent terminal-state title synthesis |
| `open_in_applications` | `open-in-applications.ts` | "open in app" list normalise/dedup/cap |
| `protocol_compat` | `protocol-compat.ts` | runtime/mobile protocol compat verdicts |
| `protocol_version` | `protocol-version.ts` | protocol version constants + capabilities |
| `commit_message_host_key` | `commit-message-host-key.ts` | model-discovery host-key namespacing |
| `git_upstream_status` | `git-upstream-status.ts` | patch-equivalence + force-push-with-lease decision |
| `hook_command_source_policy` | `hook-command-source-policy.ts` | normalize/resolve hook source policy (local-only/run-both/shared-only); absent-vs-invalid distinction, legacy fallback to shared-only |
| `hosted_remote_url` | `git/hosted-remote-url.ts` | provider-neutral remote-URL parse (https/ssh/scp/shorthand) + GitHub/GitLab/Bitbucket file-URL build (hand-rolled percent en/decode) |
| `linear_links` | `linear-links.ts` | Linear team/settings URL builders (percent-encoded segments) + workspace url-key extraction from issue URLs (host/first-path-segment parse) |
| `hosted_review_queue` | `hosted-review-queue.ts` | provider-neutral review classification (mine/requested/agent/teammate), needs-response + ready-to-merge gates (GitHub merge-state blockers scoped to GitHub); hand-rolled UTC ISO-8601→epoch parser (no date crate) |
| `hosted_review_refs` | `hosted-review-refs.ts` | git ref → branch name: strip `refs/heads/`, `refs/remotes/<remote>/`, and `origin/`/`upstream/` (base refs) |
| `tailnet_address` | `tailnet-address.ts` | Tailscale `100.64.0.0/10` IPv4 detection (octet parse + range check) for phone pairing |
| `quick_open_filter` | `quick-open-filter.ts` | Quick Open blocklist, exclude prefixes (POSIX + Windows `path.relative`), rg/git arg builders, rg line normalisation |
| `uri_component` | (extracted from `hosted-remote-url.ts`) | `encodeURIComponent`/`decodeURIComponent` equivalents, shared by URL/id builders (malformed-escape passthrough) |
| `terminal_surface_id` | `terminal-surface-id.ts` | host `tab::leaf` ↔ `:`-safe `web-terminal-<encoded>` tab id (percent-encode the `::` separator), prefix detection |
| `terminal_tab_id` | `terminal-tab-id.ts` | tab-id validity (non-empty, no `:`) + host-tab exclusion of web-terminal surface ids |
| `task_providers` | `task-providers.ts` | provider-neutral (GitHub/GitLab/Linear/Jira) visible-list + default-source normalization, runtime-availability filtering, always ≥1 valid source |
| `task_query` | `task-query.ts` | GitHub-style task search: quote-aware tokenizer, parse→scope/state/draft/assignee/author/review/labels/free-text, serialize (round-trip), single-filter edit, `repo:` stripping for cross-repo fan-out |
| `workspace_cleanup` | `workspace-cleanup.ts` | cleanup classification (ready/review/protected) + queue/select/force-remove policy, idle/archived inactivity reasons, dismissal fingerprint |

## `orca-text` — done (regex-backed; 6 modules, 37 tests, clippy clean)

Pure logic that needs a regex engine. Depends on the **vendored** `regex`
(see "Vendoring" below). Separated from `orca-core` only to keep that crate
zero-dependency.

| Rust module | Source (`src/shared/`) | Notes |
| --- | --- | --- |
| `git_remote_error` | `git-remote-error.ts` | credential-URL scrubbing, error normalisation, `isNoUpstreamError` |
| `mcp_env` | `mcp-config.ts` (`maskMcpEnv`) | mask sensitive MCP env values by credential-ish key or token-shaped value |
| `pi_agent_kind` | `pi-agent-kind.ts` | Pi vs OMP launch-command detection; word-boundary regex (no `pip`/`mpi`/`comp` false-positives), path-aware, case-insensitive |
| `skill_metadata` | `skill-metadata.ts` | skill markdown → `{name, description}`: minimal YAML frontmatter parse (scalars/quotes/`-` lists/`\|`/`>` block scalars) with first-heading + first-paragraph fallback |
| `agent_tab_title` | `agent-tab-title.ts` | prompt → short tab title: first clause, leading-filler/markup/link/punctuation strip, `\p{L}`/`\p{N}` cleanup, capitalize, word-boundary truncate (needs `unicode-gencat`) |
| `workspace_name` | `workspace-name.ts` | git-ref-safe slugify + work-item intent name (action detection w/ `[^a-z0-9_-]` boundaries so slugs aren't mistaken for actions, compact title, Linear/Jira identity), create-name resolve |

## `orca-git` — IO tier (21 modules, 113 tests, clippy clean)

Git logic generic over a `GitRunner` boundary (`runner.rs`): real
`ProcessGitRunner` shells the user's `git` via `std::process` (Orca's current
approach; a vendored `gitoxide` backend can replace it behind the trait). Tests
run against closure / sequential mock runners — the same shape as the TS
`gitExecFileAsync` mocks. Depends on `orca-core` + `orca-text`.

| Rust module | Source | Notes |
| --- | --- | --- |
| `runner` | `git/runner.ts` (contract) | `GitRunner` trait, `GitOutput`/`GitError`, `ProcessGitRunner`, `Fn` blanket impl |
| `fetch_error_classification` | `git/fetch-error-classification.ts` | missing-remote-ref detection |
| `check_ignored_paths` | `git/check-ignored-paths.ts` | chunked `check-ignore` + exit-1 handling + dedup |
| `branch_rename` | `git/branch-rename.ts` | `branchHasUpstream`, collision-suffix resolution, `branch -m` (complete) |
| `push_target` | `git/push-target-validation.ts` | `GitPushTarget` + shape/`check-ref-format` validation |
| `effective_upstream` | `shared/git-effective-upstream.ts` | resolve `@{u}` + legacy same-name-origin fixup; ahead/behind |
| `publish_target_status` | `shared/git-publish-target-status.ts` | ahead/behind vs an explicit `remote/branch` |
| `upstream` | `git/upstream.ts` | full upstream-status engine (composes the above; full test suite) |
| `remote` | `git/remote.ts` | push / pull / fast-forward / fetch / rebase-from-base (configured + explicit targets; error normalisation) — complete |
| `rebase_source` | `shared/git-rebase-source.ts` | base-ref → remote/branch (longest-match remote) |
| `status_parse` | `git/status.ts` (parsers) | porcelain-v2 status-char, conflict-kind, branch-ahead/behind parsing |
| `status` | `git/status.ts` (getStatus core) | full porcelain-v2 parse → entries/branch/upstream/ignored; type-1/2, untracked, ignored, unmerged conflicts (fs-exists injected) |
| `worktree` | `git/worktree.ts` (parseWorktreeList) | `git worktree list --porcelain` parse (line + NUL `-z`, bare/sparse/detached, main detection) |
| `repo_clone_path` | `git/repo-clone-path.ts` (pure) | clone-destination validation (absolute + anti-traversal) + WSL comparison key; platform-parameterized |
| `branch_cleanup` | `shared/git-branch-cleanup.ts` | worktree-deletion safety: target-ref gathering, non-fatal remote refresh, unmerged-changes detection (tree-equal merge / merge-only / patch-equivalent) |

## `orca-store` — persistence tier (1 module, 4 tests, clippy clean)

Thin synchronous SQLite adapter, the native replacement for
`src/main/sqlite/sync-database.ts` (which wraps Electron's `node:sqlite`).
Backed by **vendored, bundled SQLite** — the C amalgamation compiles offline
via `cc`, no system SQLite.

| Rust module | Source | Notes |
| --- | --- | --- |
| `database` | `sqlite/sync-database.ts` | open (file/memory, read-only, `file_must_exist`), `exec`, pragma get/set, connection access |

## `orca-pty` — local PTY tier (1 module, 2 tests, clippy clean)

Native PTY spawning, the replacement for `node-pty`. Backed by **vendored
`portable-pty`**. `PtySession` mirrors the node-pty surface: spawn
`(program, args, {cwd, env, cols, rows})`, stream output via a reader, `write`,
`resize`, `process_id`, `kill`, `wait`. Tests spawn a **real PTY child** and
assert its streamed output (offline).

| Rust module | Source | Notes |
| --- | --- | --- |
| `session` | `node-pty` usage (rate-limits/runtime `pty:spawn`) | open/spawn/read/write/resize/kill/wait over `portable_pty` |

## `orca-terminal` — headless terminal engine (2 modules, 19 tests, clippy clean)

The foundation of the `@xterm/headless` replacement
(`daemon/headless-emulator.ts`): a server-side grid + cursor driven by the
**`aterm` engine (`aterm-core`)**, tracking cwd via OSC-7, with **snapshot/restore
and resize** (the reconnect/SSH-replay role of `@xterm/addon-serialize`).
Implemented subset: print, CR/LF/BS/HT, line scroll, **bounded scrollback**
(default 5000 lines), OSC-7 cwd (percent-decoded), `TerminalSnapshot`
capture/restore, resize, and **per-cell SGR attributes**
(bold/italic/underline/inverse + a full `Color` model: 16-color, bright,
256-palette `38;5;n`, and truecolor `38;2;r;g;b` — both `;` and `:` forms), and
**mouse-reporting modes** (DECSET 9/1000/1002/1003 tracking + 1006/1016 SGR,
tracked for remote replay). `orca-terminal` is now a thin **adapter over `aterm`**,
so the engine's fuller features (selection/copy, full DECSET set, hyperlinks) sit
under the same stable surface (`HeadlessTerminal`, `Cell`, `Color`, …).

| Rust module | Source | Notes |
| --- | --- | --- |
| `headless` | `daemon/headless-emulator.ts` (subset) | grid of `Cell{ch,attrs}` over the **`aterm` engine** (`aterm-core`/`-grid`/`-types`); OSC-7 cwd; SGR attrs; snapshot/restore; resize |
| `color_scheme_protocol` | `terminal-color-scheme-protocol.ts` | DEC mode 2031 / CSI 997 color-scheme: reply-sequence build, theme/system resolution, subscribe/unsubscribe scan with cross-chunk tail carry (vendored `regex`, literal/class only) |

## `orca-ffi` — native FFI boundary (1 module, 5 tests, clippy clean)

The stable **C ABI** the thin native wrappers (SwiftUI on macOS, etc.) link
against — the keystone connecting the Rust core to platform shells. Two
surfaces: (1) headless **terminal** — create/process/row-text/cursor/resize/
size/free + **per-cell render data** (`orca_terminal_cell` → `OrcaCell{ch,
bold/italic/underline/inverse, fg/bg as default|indexed|truecolor}`); and (2)
**live session** — `orca_session_spawn`/wait/write/resize/size/cursor/row-text/
cell/free, spawning a real PTY whose output streams into the terminal. The
session FFI test spawns a shell and reads its grid through the ABI. Builds as **`staticlib` + `cdylib`** (`liborca_ffi.a` /
`liborca_ffi.dylib`) with a hand-written C header at
`rust/crates/orca-ffi/include/orca.h`. This is the one crate not under
`forbid(unsafe_code)` — `unsafe` is confined to the FFI boundary, each `unsafe
fn` documenting its contract. Tests exercise the C ABI exactly as a wrapper
would (incl. null-pointer tolerance).

| Rust module | Source | Notes |
| --- | --- | --- |
| `lib` (C ABI) | new boundary | `orca_terminal_*` + `orca_string_free` + `orca_ffi_version`; `orca.h` |

## Native shell — `native/orca-macos` (Swift + SwiftUI, builds & runs)

The thin macOS wrapper (the owner's original ask). A SwiftPM package links the
vendored Rust core through the C ABI: `OrcaTerminal` (Swift) → `COrca` (module
map over `orca.h`) → `liborca_ffi.a` → the `aterm` engine. The `orca-smoke`
executable drives the core end-to-end and **passes**:

```
(cd rust && cargo build -p orca-ffi) && (cd native/orca-macos && swift run orca-smoke)
# → OK — Swift shell drove the Rust core (grid, cursor, OSC-7 cwd, resize); core v0.0.1
```

`OrcaKit` exposes typed `TerminalCell`/`CellColor` (incl. truecolor) via
`cell(row:col:)` + `size()`. The smoke verifies grid, cursor, OSC-7 cwd, resize,
and per-cell SGR/truecolor through the ABI.

**`OrcaUI` (SwiftUI) renders it.** `TerminalView` and `SessionTerminalView` draw
the Rust core's grid — monospaced cells with bold/italic/underline, inverse, and
the 16/256/truecolor palette mapped to SwiftUI `Color` — through `OrcaKit`.
Compiles against the macOS SDK.

**The full live path runs.** `OrcaKit.OrcaSession` spawns a real shell command
in a PTY via the FFI; `swift run orca-smoke` verifies output streams all the way
back to Swift:

```
SessionTerminalView (SwiftUI) → OrcaKit.OrcaSession → orca.h (C ABI)
        → liborca_ffi → orca-session → PTY + orca-terminal → aterm engine
```

**Windowed app (`OrcaApp`, `@main`) builds.** A SwiftUI `App` spawns the user's
`$SHELL` in a live PTY session, renders it via `SessionTerminalView` on a redraw
tick, and forwards key input (incl. return/tab/arrows/escape) to
`session.write`. `swift build` compiles all targets (OrcaKit, OrcaUI, OrcaApp,
OrcaSmoke) against the macOS SDK.

So a functional native terminal — windowed SwiftUI app → live PTY → Rust VT
engine — exists end-to-end. Packaging it into a signed `.app` bundle (Info.plist
+ codesign) is the remaining distribution step.

## `orca-runtime` — orchestration tier (1 module, 7 tests, clippy clean)

The multi-agent coordination store, ported from
`src/main/runtime/orchestration/db.ts` onto `orca-store`'s vendored SQLite. Full
schema (messages, tasks, dispatch_contexts, decision_gates, coordinator_runs +
indexes + CHECK constraints) verbatim. Operations: message send/inbox/mark-read,
task create/list/update/get, **dispatch contexts** (ready-gated dispatch,
one-active-per-assignee guard, failure-count carry-forward, complete), and
**decision gates** (create/list/resolve), and **coordinator runs**
(create/update/active-lookup, terminal states stamp `completed_at`). All five
schema tables now have operations. Tests run against in-memory SQLite (incl.
CHECK-constraint + state-transition enforcement).

| Rust module | Source | Notes |
| --- | --- | --- |
| `orchestration` | `runtime/orchestration/db.ts` | schema + messages + tasks + dispatch contexts + decision gates + coordinator runs (all 5 tables) |

## `orca-ssh` — SSH tier, started (1 module, 11 tests, clippy clean)

OpenSSH config parsing ported from `ssh-config-parser.ts`: `parse_ssh_config`
handles Host blocks (single + multi-pattern, wildcard/negation/pattern-only
skipping), scalar directives (hostname/port/user/identity*/proxy*), quoted
values + inline comments, `=`-form, case-insensitive keywords, `Match`
block-termination, and `~` expansion (POSIX + Windows separators, parameterized
on `home` for purity). The transport (a vendored SSH crate behind a connection
boundary, like `orca-git`'s runner) is the next step.

| Rust module | Source | Notes |
| --- | --- | --- |
| `config_parser` | `ssh/ssh-config-parser.ts` | `parse_ssh_config` → `SshConfigHost[]` (pure; `home`-parameterized) |

## `orca-session` — live terminal session (1 module, 2 tests, clippy clean)

Composes `orca-pty` + `orca-terminal`: spawns a PTY, runs a background reader
thread streaming the child's output into a shared `Mutex<HeadlessTerminal>`, and
exposes write/resize + grid access for rendering. This is the unit the UI drives
(and what the FFI/Swift app will spawn). Tests spawn a real shell command and
assert the streamed grid content.

| Rust module | Source | Notes |
| --- | --- | --- |
| `session` | runtime `pty:spawn` + headless emulator wiring | PTY spawn → reader thread → headless terminal; write/resize/grid access |

## E1 decision-core tier — ay-certified, shared-corpus ports

Pure decision cores lifted out of live TS subsystems and given the full **E1
pair**: an ay machine-checked safety/invariant certificate (`rust/crates/<crate>/proofs/ay/verify.sh`)
plus a behavioral parity corpus (`*-parity-corpus.txt`) run byte-identically by
**both** the Rust core and its TS twin. These crates have no orca-dispatch parity
adapter, so — like the IO tier — they are pinned here in the ledger; the
`certificates` and `provenance` gauntlet axes enforce the certificate and the
source-drift pin respectively. Listing them here is what makes upstream edits to
the TS twins fail LOUDLY (re-verify the port) instead of silently diverging on
un-sampled inputs.

## `orca-flow-control` — E1 decision-core (PTY back-pressure, ay-certified)

| Rust module | Source | Notes |
| --- | --- | --- |
| `lib` | `ipc/pty-producer-flow-control.ts` | per-PTY hysteresis pause/resume machine (pause past HIGH, resume below LOW, failsafe re-assert); ay proves anti-flap + gated reassert + strict edges |
| `keep_tail` | `daemon/daemon-stream-keep-tail-drop.ts` | keep-tail byte sizing + drop cap; ay proves the [64K,512K]/[128K,1M] bounds ∀ (division abstracted as a free non-negative) |

## `orca-provider-backoff` — E1 decision-core (rate-limits, ay-certified)

| Rust module | Source | Notes |
| --- | --- | --- |
| `lib` | `rate-limits/active-failure-backoff.ts` | saturating-exponential refetch throttle `min(30s·2^(streak-1), 15min)`; ay proves range + monotone + exact ceiling (exponent abstracted linear) |

## `orca-crash-recovery` — E1 decision-core (crash-reporting, ay-certified)

| Rust module | Source | Notes |
| --- | --- | --- |
| `renderer_recovery` | `crash-reporting/renderer-recovery-circuit-breaker.ts` | rolling-window renderer-reload rate limiter; ay proves in-window ≤ max (inductive), no-admit-at-cap, reset-reopens liveness |
| `gpu_fallback` | `crash-reporting/gpu-crash-fallback-decision.ts` | one-shot GPU software-fallback latch; ay proves engages-at-most-once, window-gate no-op, no-engage-below-threshold |

## `orca-renderer-heap` — E1 decision-core (startup, ay-certified)

| Rust module | Source | Notes |
| --- | --- | --- |
| `lib` | `startup/renderer-heap-headroom.ts` | renderer `--max-old-space-size` ceiling `clamp(⌊gib·0.4⌋·1024, 3072, 4096)` gated at 7.5 GiB; ay proves the clamp bounds (f64 target abstracted as a bounded free int) |

## `orca-stream-split` — E1 decision-core (daemon, ay-certified)

| Rust module | Source | Notes |
| --- | --- | --- |
| `lib` | `daemon/daemon-stream-data-split.ts` | UTF-16 surrogate-safe chunk split point; ay proves the split never lands between a high/low surrogate pair (no lone surrogate emitted) |

## `orca-session-gc` — E1 decision-core (daemon history GC, ay-certified)

| Rust module | Source | Notes |
| --- | --- | --- |
| `lib` | `daemon/daemon-session-history-gc-plan.ts` | session-history retention + budget eviction planner; ay proves live/floor exemption, ended→24h / unknown→∞ retention, survivor-byte accounting |

## Vendoring (done — three dependency modes proven)

All third-party crates are vendored in-tree under `rust/vendor/` (87 crates),
pinned by `rust/Cargo.lock`, with `rust/.cargo/config.toml` redirecting
crates.io → `vendor/` and `[net] offline = true`. **Builds are offline by
construction** across all three dependency modes:

1. **pure-Rust** — `regex` (+`regex-automata`, `regex-syntax`, `aho-corasick`, `memchr`); `vte` (+`utf8parse`, `arrayvec`); `serde_json` (+`serde`, `itoa`, `ryu`, `indexmap`); `crypto_box` (+`curve25519-dalek`, `crypto_secretbox`, `salsa20`, `poly1305`, `aead`, `fiat-crypto`, `subtle`, `zeroize` — 20 crates, the NaCl-box E2EE stack, no `getrandom`).
2. **native C via `cc`** — `rusqlite` + `libsqlite3-sys` `bundled` (SQLite C amalgamation compiled in-tree, no system lib).
3. **native syscalls** — `portable-pty` (+`nix`, `libc`, `filedescriptor`; `winapi` for the Windows target).

Stripping = minimal feature sets (`default-features = false` + only what's
used): `regex` keeps `std, perf, unicode-case, unicode-perl`; `rusqlite` keeps
only `bundled`; `portable-pty` drops `ssh`/serde; `crypto_box` keeps only
`alloc, salsa20` (drops `getrandom`/`std`/`serde`). (Cross-platform vendoring
includes Windows-only crates like `winapi`; physical pruning of unused-target
source is a later refinement.)

## Next-up queue

- **orca-text (regex tier):** `text-search.ts` (rg/git `--json` parsing),
  `agent-tab-title.ts` (add the `unicode-gencat` feature for `\p{L}`/`\p{N}`).
- **orca-core (pure tier):** `color-validation.ts`,
  `workspace-space-compaction.ts`, `composer-branch-selection.ts`.
  (`project-groups.ts` + `workspace-statuses.ts` chain landed in `orca-config`.)
  (`gitlab-pipeline-checks.ts`, `gitlab-projects.ts`, `hosted-review-queue.ts`,
  `linear-links.ts`, `task-providers.ts`, `terminal-tab-id.ts` +
  `terminal-surface-id.ts` landed; `pi-agent-kind.ts` landed in `orca-text`.
  `git-history-boundary-rows.ts` deferred — untested UI graph-model logic.)
- **orca-git (in progress):** remote ops complete; `hosted-remote-url.ts` landed
  in `orca-core` (hand-rolled URL parse/build). Next: `repo-clone-path.ts`, then
  the larger `status.ts` / `worktree.ts` / `repo.ts`.
- **orca-crypto (started):** NaCl `box` done (tweetnacl-wire-compatible).
  Vendored Curve25519/XSalsa20-Poly1305 stack now unblocks the relay's
  encrypted session and the SSH transport's key handling.
- **orca-relay (started):** terminal binary-stream framing + pairing handshake
  + E2EE channel state machine done (over `orca-crypto`). Next: the multiplex
  registry and wiring the channel reducer to a concrete WebSocket transport.
- **orca-pty (started):** add the IO-mixed `shell-startup-env.ts` +
  `windows-environment-path.ts` over injectable file/exec readers.
- **orca-net (started):** proxy settings done (std-only). Next: HTTP client +
  rate limiting (will vendor a stripped HTTP/TLS stack).
- **orca-agents:** commit-message generation ported **end-to-end** (spec table +
  model parsers + prompt + generation + plan + PR generation + tui-agent
  selection); plus `agent_status_types` (untrusted status-payload
  parse/normalize). Next agent-domain candidates: `tui-agent-config` catalog
  (fuller `is_tui_agent`), the agent-status **rendering/derivation** half
  (label/icon/state-machine consumers of `ParsedAgentStatusPayload`), or agent
  spawning/execution (IO tier).
- **Large subsystems (multi-turn):** `keybindings.ts` (1579 LOC — a ~600-line
  cross-platform definitions table + match/normalize engine, 22 tests) then
  `window-shortcut-policy.ts` (26 tests) on top; the per-provider review
  adapters `hosted-review-github.ts`/`hosted-review-gitlab.ts` (pair with the
  landed `hosted_review_queue` classifier).
- **IO tier (next crates):** `orca-store` schema/migrations (port
  `runtime/orchestration/db.ts`), `orca-ssh` (vendor an ssh crate). Each adds a
  vendored, stripped dependency.

## Regex tier (now unblocked — `regex` is vendored)

`orca-core` stays zero-dependency; modules needing a real regex engine live in
`orca-text`:

- ✅ `git-remote-error.ts` → `orca-text::git_remote_error` (done).
- `text-search.ts` — rg/git-grep `--json` parsing + submatch regex construction.
- ✅ `agent-tab-title.ts` → `orca-text::agent_tab_title` (done; enabled the
  `unicode-gencat` regex feature for `\p{L}`/`\p{N}`).
