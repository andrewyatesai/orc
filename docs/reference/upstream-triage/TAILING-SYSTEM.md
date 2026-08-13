# Tailing a fast-moving upstream with a *superior* fork

Draft playbook, grounded in the 2026-08 parity sync (orca-alab tailing stablyai/orca).
Goal: stay at-or-ahead of upstream at **low, repeatable cost** without regressing the
fork's superior surface (aterm engine, Rust cores, own orchestration).

## The core tension
A normal fork *merges* upstream. A superior fork **cannot** — upstream commits on a
surface the fork has replaced (terminal=aterm, git/daemon/orchestration=Rust) must be
**re-derived in spirit**, never applied literally, or they regress the very thing that
makes the fork better. So tailing is not `git merge`; it is **disposition + selective
re-derivation**. That is the whole game.

## The instrument: a standing parity ledger
Every upstream commit since the last sync gets one terminal disposition:

| disposition | meaning | action |
|---|---|---|
| ported | fork now has it | none |
| superseded | fork covers it a different (better) way — *name the surface* | none |
| not-applicable | CI/branding/i18n-catalog/release | none |
| missing | genuinely absent, portable | **port** |
| large-feature | a whole subsystem | human decision |
| collides | needs a churned/owned file or an architecture call | human decision |
| native | Swift/macOS, needs a toolchain | queue for a toolchain run |

"At parity" = the *missing* bucket is empty. It always has a **timestamp** ("parity as
of upstream <sha>") because upstream keeps moving — there is no frozen 100%.

## The two hard-won laws
1. **RE-VERIFY before porting.** The ledger goes stale in days. In this sync ~45% of
   "missing" was already covered (fork's own work, or a parallel session, or a
   deliberate divergence). Porting those is wasted-to-harmful — one "missing" item
   would have *reversed* a fork decision (manual checks → needs-attention). Always
   re-check each item against *current* main before writing code.
2. **Superseded is a claim you must name.** "The fork covers it" is only credible if
   you can point at the covering surface. Otherwise it's a silent gap.

## The pipeline (per batch of ~30 items)
```
re-verify (fan out, high supersede)  →  port survivors in spirit (add named modules,
never grow the god-object, never touch forbidden/credential/fleet surface)  →
adversarial-verify  →  full repo-wide gate set  →  rebase-race merge
```
Fan out the *port* work (subagent-heavy, cheap to parallelize); **serialize the
gate+merge** (full-suite runs OOM under concurrency). Merge conflicts are almost always
the shared ledger files (census-ratchet, locales) — resolve by taking main's version
then re-deriving for that batch.

## The repo-wide gate set (run EVERY batch — blast-radius alone has blind spots)
tsc ×(node/web/cli/mobile) · gauntlet-census (god-object ratchet — re-baseline
*knowingly* with attribution, never silence) · report-credential-writes (security
sign-off — **never auto-rekey**) · verify-localization-catalog (real translations, not
English placeholders) · check-exported-home-paths · check-max-lines-ratchet ·
check-styled-scrollbars · `pnpm install --frozen-lockfile` (a new direct dep needs the
lockfile regenerated or prod install breaks). Baseline every failure against a *fresh
origin/main worktree* — parallel sessions leave their own gates red, and those are not
yours to fix or to block on.

## What "superior" costs, and how to protect it
- **Re-derivation, not application** — the recurring work. An upstream fix to xterm
  IME/ConPTY/PTY must land on the aterm path or be N/A; a git-parsing fix lands in the
  Rust crate. This is the tax of superiority and it is unavoidable.
- **The god-object drift** — features attach to the one big runtime file; it grew
  ~+700 lines this sync. Extraction discipline (new named modules) slows it but the
  glue accretes. Decomposition is a standing debt, tracked line-by-line in the census
  ledger, separate from parity.
- **Architecture forks stay forks** — where the fork and upstream built *rival*
  implementations of the same concept (orchestration: fork v9 + capability-token grafts
  vs upstream Run subsystem vs a parallel "fleet" model), tailing is a **design
  decision**, not a port. Additive grafts work when schemas don't conflict; wholesale
  swaps do not. These go to the human backlog, never auto-ported.

## Making it cheap and standing (the actual objective)
The one-off heroics of this session become a cadence:
1. **Sync small and often.** A +30-commit delta is a cheap afternoon; a +322 delta is a
   multi-day grind with heavy drift and conflict. Cadence beats batch size. Trigger on
   ~N upstream commits or weekly, whichever first.
2. **Automate the disposition.** The classifier fan-out (read commit + check main →
   ported/superseded/n-a/missing) is ~90% mechanical and already a workflow. Run it on
   each sync; a human reviews only the *missing-high*, *large-feature*, *collides*, and
   *superseded-without-a-named-surface* rows.
3. **Keep the superseded map current.** A living doc of "upstream surface X → fork
   surface Y (aterm/Rust/…)" makes most disposition instant and prevents re-litigating.
4. **The named backlog is the roadmap, not debt to hide.** Large-features + security +
   native + collides + architecture calls are product decisions. Surface them as a
   standing list the human triages, so parity work never silently swallows a feature
   decision.
5. **Guardrails are non-negotiable and encoded in the pipeline**, not remembered:
   forbidden-surface list, census re-baseline-with-attribution, never-auto-rekey-a-
   credential-note, real-translations, lockfile-regen, fresh-baseline-diff.

## Definition of done (durable form)
Not "zero gap forever." It is: **parity as of a recent upstream sha, a standing
mechanism to re-establish it cheaply on each sync, and a named human-decision backlog
for everything that is a choice rather than a port.** That is what tailing a
fast-moving AI project with a superior copy looks like as a steady state.
