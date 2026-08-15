// Legacy base-ref search-result derivation, driven by the Rust orca-core
// base_ref_search_result port in the orca-git wasm module (the shared TS impl
// was deleted; src/shared/base-ref-search-result.ts is the type re-export only).
//
// `BaseRefSearchResult` is ONE row of a ref search, not a found/not-found
// result: "nothing matched" is the caller's empty array, so this function has no
// absent case to represent and must always return a row.
//
// Why the not-ready fallback is the identity row and never null: both callers
// reach it as `refs.map(...)` building a picker list, so a null would enter that
// list as a hole the caller renders as a missing/blank branch, indistinguishable
// from "the search found nothing". An unstripped refName is a real selectable
// row — the pre-`legacyBaseRefSearchResult` behaviour, degraded but never empty.
// Reachable while the core is `pending` AND permanently once it is `unavailable`
// (git-wasm-availability), so this is not only a boot-window branch.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { BaseRefSearchResult } from '../../../../shared/types'

// Payload is a bare ref-name string, so the codec's default applies unrelaxed.
function op(fn: string, input: unknown): unknown {
  if (!isGitWasmReady()) {return null}
  return dispatchToWasmCore('base-ref-search-result', fn, input, { root: 'refName' })
}

export function legacyBaseRefSearchResult(refName: string): BaseRefSearchResult {
  const r = op('legacyBaseRefSearchResult', refName) as BaseRefSearchResult | null
  return r ?? { refName, localBranchName: refName }
}
