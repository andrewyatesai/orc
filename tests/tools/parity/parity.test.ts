// Differential parity driver (TS half).
//
// Proves the fresh Rust ports against the live TypeScript reference: for every
// case in the shared vector corpus it runs the real `src/shared` function and
// asserts its output equals the Rust port's output (read from rust_outputs.json,
// produced by `cargo run -p orca-parity`). The compared outputs are both
// computed live — neither is hand-authored — so an agreement is real evidence
// of behavioural parity, and a disagreement is a concrete divergence to review.
//
// A module whose TS original a Rust cutover deleted is checked Rust-vs-golden
// instead — see registerGoldenOnly.
//
// Run order (both legs): node config/scripts/run-parity.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { semanticEqual } from './compare'
import { DISPATCH } from './dispatch'

const HERE = __dirname
const VECTORS_DIR = join(HERE, 'vectors')
const RUST_OUTPUTS = join(HERE, 'rust_outputs.json')

type VectorCase = {
  function: string
  note?: string
  input: unknown
  expected?: unknown
  /** Mark an intended fresh-reimplementation divergence; reported, never failed. */
  allowDivergence?: string
}

type RustRun = {
  module: string
  caseIndex: number
  function: string
  rustOutput: unknown
}

const rustRuns: RustRun[] = existsSync(RUST_OUTPUTS)
  ? (JSON.parse(readFileSync(RUST_OUTPUTS, 'utf8')) as RustRun[])
  : []
const rustByKey = new Map(rustRuns.map((run) => [`${run.module}::${run.caseIndex}`, run]))

type VectorDoc = {
  module: string
  cases: VectorCase[]
  /** Set when the TS original was deleted by a Rust cutover — see below. */
  tsReferenceRetired?: string
}

// A module whose TS original is gone cannot be compared live: the TS entry point
// is now a shim over the very Rust code under test, so a TS leg would compare
// Rust to itself and always agree. Such a module is checked against the goldens
// recorded from the real TS store before deletion instead — still an independent
// oracle, just a frozen one.
function registerGoldenOnly(doc: VectorDoc, dispatcher: (typeof DISPATCH)[string]): void {
  describe(`${doc.module} (Rust vs recorded golden)`, () => {
    it('is not also wired to a live TS dispatch', () => {
      expect(
        dispatcher,
        `module "${doc.module}" is marked tsReferenceRetired but still has a TS dispatch — ` +
          `remove one or the other, a self-comparison proves nothing`
      ).toBeUndefined()
    })

    doc.cases.forEach((vectorCase, index) => {
      it(`${vectorCase.function} #${index}${vectorCase.note ? ` — ${vectorCase.note}` : ''}`, () => {
        const rustRun = rustByKey.get(`${doc.module}::${index}`)
        expect(
          rustRun,
          `no Rust output for ${doc.module}#${index} — re-run the Rust harness`
        ).toBeTruthy()
        expect(
          vectorCase.expected,
          `${doc.module}#${index} has no golden — a retired-reference module cannot be checked without one`
        ).toBeDefined()
        expect(
          semanticEqual(rustRun!.rustOutput, vectorCase.expected),
          `DIVERGENCE: Rust disagrees with the recorded TS golden` +
            `\n  input:    ${JSON.stringify(vectorCase.input)}` +
            `\n  rust:     ${JSON.stringify(rustRun!.rustOutput)}` +
            `\n  golden:   ${JSON.stringify(vectorCase.expected)}`
        ).toBe(true)
      })
    })
  })
}

function registerDifferential(doc: VectorDoc, dispatcher: (typeof DISPATCH)[string]): void {
  describe(doc.module, () => {
    it('has a TS dispatch adapter', () => {
      expect(dispatcher, `no TS dispatch registered for module "${doc.module}"`).toBeTypeOf(
        'function'
      )
    })

    doc.cases.forEach((vectorCase, index) => {
      const label = `${vectorCase.function} #${index}${vectorCase.note ? ` — ${vectorCase.note}` : ''}`
      it(label, async () => {
        if (!dispatcher) {
          return
        }
        // Why: entries with injected async readers (e.g. setup-script-imports)
        // return promises; await passes sync dispatcher results through unchanged.
        const tsOutput = await dispatcher(vectorCase.function, vectorCase.input)
        const rustRun = rustByKey.get(`${doc.module}::${index}`)
        expect(
          rustRun,
          `no Rust output for ${doc.module}#${index} — re-run the Rust harness`
        ).toBeTruthy()

        const matches = semanticEqual(tsOutput, rustRun!.rustOutput)
        const detail =
          `\n  input:    ${JSON.stringify(vectorCase.input)}` +
          `\n  ts:       ${JSON.stringify(tsOutput)}` +
          `\n  rust:     ${JSON.stringify(rustRun!.rustOutput)}`

        if (vectorCase.allowDivergence) {
          // Intended fresh-reimplementation difference: report, do not fail.
          if (!matches) {
            console.warn(`KNOWN DIVERGENCE (${vectorCase.allowDivergence})${detail}`)
          }
          return
        }

        expect(matches, `DIVERGENCE: TS and Rust disagree${detail}`).toBe(true)

        if (vectorCase.expected !== undefined) {
          expect(
            semanticEqual(tsOutput, vectorCase.expected),
            `TS output disagrees with the golden expected value${detail}`
          ).toBe(true)
        }
      })
    })
  })
}

describe('TS↔Rust parity', () => {
  it('rust_outputs.json exists (run `cargo run -p orca-parity` first)', () => {
    expect(existsSync(RUST_OUTPUTS)).toBe(true)
  })

  const vectorFiles = existsSync(VECTORS_DIR)
    ? readdirSync(VECTORS_DIR).filter((name) => name.endsWith('.json'))
    : []

  for (const file of vectorFiles) {
    const doc = JSON.parse(readFileSync(join(VECTORS_DIR, file), 'utf8')) as VectorDoc
    const register = doc.tsReferenceRetired ? registerGoldenOnly : registerDifferential
    register(doc, DISPATCH[doc.module])
  }
})
