// `splitRemoteBranchName` on the Rust `orca_git::effective_upstream` core.
//
// Reaches three surfaces, all of which bind: main via napi (`git/status.ts`,
// `github/client.ts`), the relay via its embedded wasm
// (`git-handler-status-ops.ts`), and the renderer via wasm at ready
// (`git-history-ref-display.ts` → `GitHistoryRow`). Mobile never reaches it.
//
// PRE-READY CONTRACT — `parity`. The renderer's boot window is real, and a
// degraded answer there is not neutral: `null` means "not a remote-tracking
// ref", so git-history rows would stop de-duplicating `origin/main` against a
// local `main` until wasm arrives, then silently start. The fallback is the
// deleted body, six lines over its own argument.
//
// COST, measured rather than assumed, because a 23 ns function crossing a seam
// is the shape that got `quick-open-filter`'s per-file exports refused: 23.2 ns
// TS body, 407.8 ns napi (18×), 740.7 ns wasm (32×). The difference is what the
// call count is bounded BY. quick-open-filter ran per FILE over a 1.5M-line
// scan; this runs per REF — `git-history-ref-display` is the only per-item
// caller, twice per ref, so a 1000-ref history costs +1.44 ms and a realistic
// one is a fraction of that. Every other call site is once per operation.
//
// FIDELITY was probed against BOTH shipped cores over 20 cases, 20/20 equal.
// The interesting ones are non-ASCII: the twin indexes with `indexOf`/`.length`
// (UTF-16 units) and the core with `find`/`len` (bytes), so `'😀/main'`,
// `'a😀/b'` and `'x/😀'` are where a unit confusion would show. They agree
// because both only ask whether the slash is FIRST or LAST — the split point is
// the same character either way — but that is a property worth having probed
// rather than argued.
// `null` is one of this function's REAL answers, and `tryOrcaDispatch` also
// returns `null` for "no binding installed" — so the result cannot carry both
// meanings. Readiness is therefore asked separately via `isOrcaDispatchReady()`
// rather than inferred, which is the whole reason that predicate is exported.
//
// One tension worth naming: the seam's own doc-comment says never to keep the
// old TS impl as the fallback, on the grounds that it defeats the dedup. The
// `parity` contract in docs/rust-migration/ported-modules.md overrides that for
// the case where no sentinel is safe, and every other shim on this seam follows
// it. The dedup that matters is that the SHIPPED answer has one source; the
// fallback covers a boot window the core cannot answer in at all.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { isOrcaDispatchReady, tryOrcaDispatch } from './orca-dispatch-seam'

export type RemoteBranchNameParts = {
  remoteName: string
  branchName: string
}

/** The deleted twin's body, verbatim. */
function legacySplitRemoteBranchName(refName: string): RemoteBranchNameParts | null {
  const slashIndex = refName.indexOf('/')
  if (slashIndex <= 0 || slashIndex === refName.length - 1) {
    return null
  }
  return {
    remoteName: refName.slice(0, slashIndex),
    branchName: refName.slice(slashIndex + 1)
  }
}

/**
 * Split `remote/branch` into its two halves, or `null` when `refName` is not of
 * that shape — no leading slash, no trailing slash, and a slash must be present.
 * The branch half keeps any further slashes (`origin/feature/x`).
 */
export function splitRemoteBranchName(refName: string): RemoteBranchNameParts | null {
  if (!isOrcaDispatchReady()) {
    return legacySplitRemoteBranchName(refName)
  }
  try {
    return tryOrcaDispatch('effective-upstream', 'splitRemoteBranchName', refName, {
      root: 'refName'
    }) as RemoteBranchNameParts | null
  } catch (error) {
    // A ref name carrying an unpaired surrogate cannot cross the codec. The twin
    // answered those without crossing anything (it only ever looked for a
    // slash), so this is its answer, not a degrade.
    if (error instanceof DispatchPayloadError) {
      return legacySplitRemoteBranchName(refName)
    }
    throw error
  }
}
