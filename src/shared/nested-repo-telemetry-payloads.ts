// Nested-repo scan/import funnel telemetry, driven by the Rust
// `orca_core::nested_repo_telemetry` port through the SHARED dispatch seam (the
// twin keeps only its types, enum tables and the count cap).
//
// Why the shared seam and not src/renderer/src/lib/git-wasm/: this module has
// two surfaces. The payload builders run in the renderer (add-repo dialog +
// onboarding), but `bucketNestedRepoTelemetryCount` is also called by
// `src/shared/telemetry-events.ts`, whose zod `superRefine` re-derives every
// `*_bucket` from its `*_count` inside MAIN's fail-closed validator. A
// src/shared module cannot import a surface binding, so both go through
// `orca-dispatch-seam` (main/cli bind napi at bootstrap, renderer binds wasm at
// ready, relay via initSync).
//
// PRE-READY CONTRACT — `parity` for the three scalar answers, MANDATORY:
//  * `bucketNestedRepoTelemetryCount` IS FED TO A VALIDATOR — main drops the
//    event when `bucketNestedRepoTelemetryCount(count) !== bucket`, so anything
//    but the twin's answer makes every nested-repo event fail its own bucket
//    check; its six-member union has no spare state anyway.
//  * `shouldEmitNestedRepoImportSubmitTelemetry` GATES THE IMPORT, not just the
//    event: both call sites `return` on false, so a pre-ready `false` is a dead
//    Import button for the session on a failed core, and `true` is the other
//    real answer.
//  * `capNestedRepoTelemetryCount` is the same arithmetic, one layer down.
// Each fallback rebuilds the deleted body over the cap the twin still exports —
// pure arithmetic on the argument, so pre-ready equals ready for EVERY input.
//
// PRE-READY CONTRACT — `sentinel` = `null` for the two builders, the shape
// `setup-script-telemetry` already uses: the payload is derived end-to-end from
// the input (classification, counts, buckets), so no constant is honest, and a
// schema-VALID guess is the hazard — main's validator would accept it and record
// a wrong funnel step forever. Handled by:
//  * useAddRepoLocalFolderFlow / useAddRepoServerPathFlow /
//    use-add-repo-remote-nested-scan / use-onboarding-flow — skip that scan's
//    `track('add_repo_nested_scan_result', …)`;
//  * useAddRepoNestedImportFlow / use-onboarding-flow — skip
//    `track('add_repo_nested_import_action', …)` and CONTINUE the import.
// Nothing retries: every site fires once per user action, so a step dropped
// pre-ready is never re-counted if the core lands mid-flow. The import-result
// sites set `resultTracked` on the ATTEMPT rather than on a successful emit for
// exactly that reason — see the WHY at both.
//
// NOT CUT OVER (both are ported in orca-core, neither is REACHABLE):
// `orca-dispatch`'s nested_repo_telemetry adapter has no arm for
// `buildNestedRepoImportResultTelemetry` or `createNestedRepoTelemetryAttemptId`,
// so the shipped orca_git_wasm_bg.wasm and orca_node.node both answer
// `__parity_error__: unknown function`. The result builder stays TypeScript HERE
// so it composes this module's cap/bucket instead of forcing a second copy of
// them into the twin; the attempt-id generator is an entropy EDGE
// (`crypto.randomUUID`), not decision logic, and stays in the twin.
import {
  NESTED_REPO_TELEMETRY_MAX_REPO_COUNT,
  type NestedRepoCountBucket,
  type NestedRepoImportActionTelemetry,
  type NestedRepoImportResultTelemetry,
  type NestedRepoImportTelemetryAction,
  type NestedRepoImportTelemetryOutcome,
  type NestedRepoScanTelemetry,
  type NestedRepoTelemetryRuntimeKind,
  type NestedRepoTelemetrySurface
} from './nested-repo-telemetry'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from './types'

const MODULE = 'nested-repo-telemetry'

/** The twin's private `normalizeNestedRepoTelemetryCount`, plus a safe-integer
 *  ceiling: the codec rejects NaN/±Infinity/-0, and the core reads count fields
 *  with serde's `as_i64`, which answers 0 for a float or an out-of-range magnitude.
 *  Floor-and-clamp-at-0 is what both cap and the raw all-selected comparison
 *  already apply, so this changes no answer — verified against the deleted bodies
 *  over the ±0 / fractional / 1e21 / MAX_VALUE / non-finite spread. The clamp is
 *  the identity on every reachable count (`repos.length`, `Set.size`); only two
 *  DISTINCT counts above 2^53 would compare equal, which no array can produce. */
function countArg(count: number): number {
  if (!Number.isFinite(count)) {
    return 0
  }
  return Math.min(Math.max(Math.floor(count), 0), Number.MAX_SAFE_INTEGER)
}

/** Ceil, not floor: the submit predicate only asks `> 0`, and `as_i64` reads a
 *  fraction as 0 — flooring a 0.5 would flip the twin's `true` to `false`.
 *  `+Infinity` rides the clamp (still positive, as the twin read it); NaN and
 *  `-Infinity` land on 0, which is what the twin's `> 0` answered for them. */
function positiveCountArg(count: number): number {
  if (Number.isNaN(count)) {
    return 0
  }
  return Math.min(Math.max(Math.ceil(count), 0), Number.MAX_SAFE_INTEGER)
}

/** The deleted twin's cap, rebuilt over the constant it still exports. */
function localCap(count: number): number {
  if (!Number.isFinite(count)) {
    return 0
  }
  return Math.max(0, Math.min(NESTED_REPO_TELEMETRY_MAX_REPO_COUNT, Math.floor(count)))
}

/** The deleted twin's bucket ladder, over `localCap`. */
function localBucket(count: number): NestedRepoCountBucket {
  const capped = localCap(count)
  if (capped === 0) {
    return '0'
  }
  if (capped === 1) {
    return '1'
  }
  if (capped <= 3) {
    return '2-3'
  }
  if (capped <= 7) {
    return '4-7'
  }
  if (capped <= 15) {
    return '8-15'
  }
  return '16+'
}

export function capNestedRepoTelemetryCount(count: number): number {
  const answer = tryOrcaDispatch(MODULE, 'capNestedRepoTelemetryCount', countArg(count), {
    root: 'count'
  })
  return answer === null ? localCap(count) : (answer as number)
}

export function bucketNestedRepoTelemetryCount(count: number): NestedRepoCountBucket {
  const answer = tryOrcaDispatch(MODULE, 'bucketNestedRepoTelemetryCount', countArg(count), {
    root: 'count'
  })
  return answer === null ? localBucket(count) : (answer as NestedRepoCountBucket)
}

export function shouldEmitNestedRepoImportSubmitTelemetry(args: {
  attemptId: string | null
  selectedCount: number
  isBusy?: boolean
}): boolean {
  // Only the three read fields cross, coerced to the exact wire types: an
  // explicitly-undefined `isBusy` is a codec rejection, and the twin read it as
  // falsy. No free-form string crosses, so no encode hazard needs catching here.
  const attemptId = typeof args.attemptId === 'string' ? args.attemptId : null
  const isBusy = args.isBusy === true
  const answer = tryOrcaDispatch(
    MODULE,
    'shouldEmitNestedRepoImportSubmitTelemetry',
    { attemptId, selectedCount: positiveCountArg(args.selectedCount), isBusy },
    { root: 'submit' }
  )
  return answer === null
    ? Boolean(attemptId && args.selectedCount > 0 && !isBusy)
    : (answer as boolean)
}

/** `null` = core not ready, so this scan emits no event (never a guessed one). */
export function buildNestedRepoScanTelemetry(args: {
  attemptId: string
  surface: NestedRepoTelemetrySurface
  runtimeKind: NestedRepoTelemetryRuntimeKind
  scan: NestedRepoScanResult | null
}): NestedRepoScanTelemetry | null {
  const scan = args.scan
  return tryOrcaDispatch(
    MODULE,
    'buildNestedRepoScanTelemetry',
    {
      attemptId: args.attemptId,
      surface: args.surface,
      runtimeKind: args.runtimeKind,
      scan: scan
        ? {
            // Why length-only placeholders: the core reads `repos` for its LENGTH
            // alone, and shipping the candidates would put scanned filesystem
            // paths on the wire — one unpaired UTF-16 surrogate out of a Windows
            // filename fails the encode and throws into the add-repo flow. Capped
            // one past the count cap, above which every length buckets alike.
            repos: Array.from(
              {
                length: Math.min(
                  Array.isArray(scan.repos) ? scan.repos.length : 0,
                  NESTED_REPO_TELEMETRY_MAX_REPO_COUNT + 1
                )
              },
              () => 0
            ),
            selectedPathKind: scan.selectedPathKind,
            truncated: scan.truncated ?? false,
            timedOut: scan.timedOut ?? false
          }
        : null
    },
    { root: 'scanTelemetry' }
  ) as NestedRepoScanTelemetry | null
}

/** `null` = core not ready, so this step emits no event; the import still runs. */
export function buildNestedRepoImportActionTelemetry(args: {
  attemptId: string
  surface: NestedRepoTelemetrySurface
  runtimeKind: NestedRepoTelemetryRuntimeKind
  action: NestedRepoImportTelemetryAction
  foundCount: number
  selectedCount: number
}): NestedRepoImportActionTelemetry | null {
  return tryOrcaDispatch(
    MODULE,
    'buildNestedRepoImportActionTelemetry',
    {
      attemptId: args.attemptId,
      surface: args.surface,
      runtimeKind: args.runtimeKind,
      action: args.action,
      foundCount: countArg(args.foundCount),
      selectedCount: countArg(args.selectedCount)
    },
    { root: 'actionTelemetry' }
  ) as NestedRepoImportActionTelemetry | null
}

/** UNPORTED at the dispatch surface (see the header) — still TypeScript, but it
 *  composes this module's Rust-backed cap/bucket, so there is one bucket ladder. */
export function buildNestedRepoImportResultTelemetry(args: {
  attemptId: string
  surface: NestedRepoTelemetrySurface
  runtimeKind: NestedRepoTelemetryRuntimeKind
  mode: ProjectGroupImportMode
  foundCount: number
  selectedCount: number
  result: ProjectGroupImportResult | null
}): NestedRepoImportResultTelemetry {
  const rawFoundCount = countArg(args.foundCount)
  const rawSelectedCount = countArg(args.selectedCount)
  const foundCount = capNestedRepoTelemetryCount(args.foundCount)
  const selectedCount = capNestedRepoTelemetryCount(args.selectedCount)
  const importedCount = capNestedRepoTelemetryCount(args.result?.importedCount ?? 0)
  const alreadyKnownCount = capNestedRepoTelemetryCount(args.result?.alreadyKnownCount ?? 0)
  const failedCount = capNestedRepoTelemetryCount(args.result?.failedCount ?? selectedCount)
  const acceptedCount = importedCount + alreadyKnownCount
  const outcome: NestedRepoImportTelemetryOutcome =
    acceptedCount === 0 ? 'failed' : failedCount > 0 ? 'partial_failure' : 'success'

  return {
    attempt_id: args.attemptId,
    surface: args.surface,
    runtime_kind: args.runtimeKind,
    mode: args.mode,
    outcome,
    found_count: foundCount,
    found_count_bucket: bucketNestedRepoTelemetryCount(foundCount),
    selected_count: selectedCount,
    selected_count_bucket: bucketNestedRepoTelemetryCount(selectedCount),
    imported_count: importedCount,
    imported_count_bucket: bucketNestedRepoTelemetryCount(importedCount),
    already_known_count: alreadyKnownCount,
    already_known_count_bucket: bucketNestedRepoTelemetryCount(alreadyKnownCount),
    failed_count: failedCount,
    failed_count_bucket: bucketNestedRepoTelemetryCount(failedCount),
    all_selected: rawFoundCount > 0 && rawSelectedCount === rawFoundCount
  }
}
