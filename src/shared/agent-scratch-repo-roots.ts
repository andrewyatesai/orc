// Agent-scratch REPO ROOT recognition on the Rust
// `orca_core::agent_scratch_worktrees` core. `agent-scratch-worktrees.ts` keeps
// the marker table; this is the only body of that module that became a shim, and
// the header there says why the other two did not.
//
// It sits on `orca-dispatch-seam` rather than in `src/main`'s binding directory
// because the predicate is about a REPO, not about one tree's runtime: its
// caller today is main (`resolveWorktreeScanCacheTtlMs` in
// `runtime/orca-runtime.ts`, napi), and the same question — "is this repo the
// agent's own scratch, or the user's project?" — is asked of persisted repo rows
// that the renderer and the relay also hold.
//
// PRE-READY CONTRACT — `parity`.
//
// Why no sentinel exists. The export is a bare `boolean` read inside a ternary
// that picks a cache TTL, so both values are real answers and there is no spare
// state (ported-modules.md, "Signal at the level that has a spare state").
// Lifting to `boolean | null` does not help: the caller returns a number either
// way, so a `null` arm would have to invent a TTL, which is the same guess one
// file over. And a plausible constant is not available in either direction — a
// pre-ready `false` reinstates the 30s fan-out that was measured at ~128 git
// execs/min against these repos, and a pre-ready `true` holds a real user repo's
// worktree list five minutes stale.
//
// So the fallback recomputes the deleted twin's body verbatim over the marker
// table that stayed in TypeScript, which makes pre-ready equal ready for every
// input. `tools/parity/dispatch/agent-scratch-worktrees.ts` drives THIS module
// with the seam unbound (`config/vitest.parity.config.ts` installs no setup
// file), so every corpus vector re-checks that claim on `pnpm parity`, and
// `agent-scratch-repo-roots.test.ts` runs the twin's own cases in both states.
//
// Measured, not asserted: 305,204 comparisons of the HEAD twin against the
// shipped wasm core — 152,602 with the seam unbound and the same 152,602 with it
// bound, because the twin's `normalizeRuntimePathForComparison` is itself a shim
// and a fallback-vs-core differential cannot see a bound-only divergence. Zero
// on both legs. The corpus: every 3-segment path over a 16-atom alphabet
// (drive letters, `é:`, `wsl.localhost`, U+212A, U+FEFF, the real markers and
// their undotted near-misses) in both separators and under four roots, plus
// 40,000 random paths over a 28-atom alphabet under 12 curated roots. The same
// corpus discriminates: re-introducing the two off-by-one bounds this port had to
// get right — `<=` where the worktree matcher needs `<`, `<` where the repo-root
// scan needs `<=` — diverges on 968 and 3,072 paths respectively.
//
// NO WRONG-RUNTIME-TYPE GUARD HERE, and that is a measured decision rather than
// an omission. A non-string `repoPath` is reachable — repo rows are persisted as
// hand-editable JSON and also arrive over the relay — and the arm's
// `Value::as_str().unwrap_or("")` reads one as an EMPTY path, i.e. `false`. But
// the fallback answers a non-string the SAME way, because its own
// `normalizeRuntimePathForComparison` is a shim: bound, that call crosses and
// yields `''` too; unbound, it throws out of `.normalize('NFC')` and so does the
// shim, which has already fallen back by then. Both arms therefore agree in each
// state, and both agree with the HEAD twin, which called the same helper. The
// state-dependence is `cross-platform-path-resolution`'s declared surface, not
// something this shim introduces; `agent-scratch-repo-roots.test.ts` pins it by
// comparing the two arms rather than by asserting a single answer. A `typeof`
// guard here would change no observable behaviour.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import { AGENT_SCRATCH_REPO_ROOT_SEGMENTS } from './agent-scratch-worktrees'
import { normalizeRuntimePathForComparison } from './cross-platform-path-resolution'

const MODULE = 'agent-scratch-worktrees'

export function isAgentScratchRepoRootPath(repoPath: string): boolean {
  // Why the catch: repo paths come off the filesystem and out of hand-editable
  // persisted JSON, so an unpaired UTF-16 surrogate is reachable and the codec
  // refuses to encode it. The twin answered those without crossing anything.
  let answer: unknown = null
  try {
    answer = tryOrcaDispatch(
      MODULE,
      'isAgentScratchRepoRootPath',
      { repoPath },
      { root: 'isAgentScratchRepoRootPath' }
    )
  } catch (error) {
    if (!(error instanceof DispatchPayloadError)) {
      throw error
    }
  }
  return answer === null ? legacyIsAgentScratchRepoRootPath(repoPath) : (answer as boolean)
}

/** The deleted twin's body, verbatim over the kept marker table. Match the
 *  marker anywhere above the repo root (the repo lives at or under the scratch
 *  container), unlike worktree matching, which anchors to a registered checkout. */
export function legacyIsAgentScratchRepoRootPath(repoPath: string): boolean {
  const segments = normalizeRuntimePathForComparison(repoPath).split('/')
  for (const marker of AGENT_SCRATCH_REPO_ROOT_SEGMENTS) {
    for (let index = 0; index + marker.length <= segments.length; index += 1) {
      if (marker.every((segment, offset) => segments[index + offset] === segment)) {
        return true
      }
    }
  }
  return false
}
