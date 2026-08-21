// The machinery of the pre-ready contract gate for the git-wasm shims. The row
// catalog is split by domain across this directory's
// shim-pre-ready-contract*.test.ts files; each hands its rows to
// runShimPreReadyContractSuite.
//
// The rule (docs/rust-migration/ported-modules.md, "The pre-ready fallback
// contract"): a shim's not-ready value must be what the deleted TypeScript twin
// would have returned FOR THAT INPUT. The Rust core is a parity port of that
// twin, so the twin's answer is observable — it is the READY answer. That makes
// the rule mechanically checkable with no heuristic: call the shim before
// `initGitWasmForTestFromBytes`, call it again after, compare.
//
// Every row is an observed fact, so this gate cannot false-flag. What it does
// NOT prove is that a caller handles a `sentinel`; that stays a review
// obligation, named in `handledBy`. `divergence` rows are the KNOWN violations
// from the 2026-07 audit, pinned in the row files so a fix flips a test red and
// gets re-declared as `parity` instead of drifting back.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from '../../../../shared/orca-dispatch-seam'
import { initGitWasmForTestFromBytes } from './git-line-stats'

export type Contract =
  /** Pre-ready value equals the ready value — the rule, satisfied. */
  | { kind: 'parity'; why: string }
  /** Pre-ready is a declared not-ready SIGNAL the caller branches on. */
  | { kind: 'sentinel'; value: unknown; handledBy: string }
  /** Known violation: pre-ready is a value the caller reads as a real answer. */
  | { kind: 'divergence'; consequence: string }

export type PreReadyCase = { name: string; call: () => unknown; contract: Contract }

// Serialized so a Set/undefined compares stably; the shims are JSON-boundary
// functions, so a JSON view loses nothing they can return.
function snapshot(call: () => unknown): string {
  return (
    JSON.stringify(call(), (_key, value) => (value instanceof Set ? [...value] : value)) ??
    'undefined'
  )
}

// Takes every row's pre-ready snapshot SYNCHRONOUSLY (during the calling test
// file's module evaluation, before any hook can init the wasm core), then
// registers the suite that compares it against the ready answer.
export function runShimPreReadyContractSuite(cases: PreReadyCase[]): void {
  // Why: config/vitest-orca-dispatch-seam.ts binds the shared seam for every test
  // file at import time, so a shim that reaches Rust through the seam (rather than
  // through this directory's isGitWasmReady/dispatchToWasmCore) would be READY
  // during the pre-ready pass and its row would pass vacuously. Unbind first;
  // beforeAll's initGitWasmForTestFromBytes → markReady rebinds it.
  setOrcaDispatchBinding(null)

  const preReadySnapshots = cases.map((testCase) => snapshot(testCase.call))

  beforeAll(() => {
    initGitWasmForTestFromBytes(readFileSync(new URL('./orca_git_wasm_bg.wasm', import.meta.url)))
  })

  describe('git-wasm shim pre-ready contract', () => {
    cases.forEach((testCase, index) => {
      const preReady = preReadySnapshots[index]!
      const { contract } = testCase

      if (contract.kind === 'parity') {
        it(`${testCase.name} — pre-ready matches ready (${contract.why})`, () => {
          expect(preReady).toBe(snapshot(testCase.call))
        })
        return
      }

      if (contract.kind === 'sentinel') {
        it(`${testCase.name} — signals not-ready (${contract.handledBy})`, () => {
          expect(preReady).toBe(JSON.stringify(contract.value) ?? 'undefined')
          expect(preReady).not.toBe(snapshot(testCase.call))
        })
        return
      }

      it(`${testCase.name} — KNOWN VIOLATION: ${contract.consequence}`, () => {
        // Fix it by making the pre-ready value the ready value, or by turning it
        // into a `sentinel` the caller branches on — then re-declare this row.
        expect(preReady).not.toBe(snapshot(testCase.call))
      })
    })
  })
}
