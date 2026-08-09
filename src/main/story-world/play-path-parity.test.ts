/**
 * The TypeScript half of the shared oracle.
 *
 * `rust/crates/orca-policy/parity-corpus.txt` is run by BOTH implementations —
 * `matches_shared_parity_corpus` in the crate, and this test. One file, two
 * runners, so a divergence between the Rust decision and the TS decision fails
 * here rather than in production.
 *
 * This is the mechanism the repo already uses for every ported module
 * (`rust/README.md`: "cargo test is the parity gate"). It is what makes the port
 * a port rather than a rewrite.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decidePlayPath } from './play-path-guard'

const CORPUS = join(
  __dirname,
  '..',
  '..',
  '..',
  'rust',
  'crates',
  'orca-policy',
  'parity-corpus.txt'
)

type CorpusRow = { input: string; expected: string }

function readCorpus(): CorpusRow[] {
  return readFileSync(CORPUS, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .flatMap((line) => {
      const [input, expected] = line.split('=>')
      return input !== undefined && expected !== undefined
        ? [{ input: input.trim(), expected: expected.trim() }]
        : []
    })
}

describe('play-path parity with orca-policy', () => {
  const rows = readCorpus()

  it('reads a corpus big enough to mean something', () => {
    expect(rows.length).toBeGreaterThanOrEqual(12)
  })

  it.each(rows.map((row): [string, string, string] => [row.input, row.input, row.expected]))(
    '%s',
    (_label, input, expected) => {
      // Identity realpath: the corpus covers the LEXICAL half, which is the part
      // both implementations share. Symlink containment depends on a filesystem
      // and is tested separately on each side.
      const decision = decidePlayPath({
        root: '/worlds/kitty',
        requestPath: input,
        realpath: (path) => path
      })
      const actual = decision.allowed ? 'allowed' : decision.reason
      expect(actual).toBe(expected)
    }
  )
})
