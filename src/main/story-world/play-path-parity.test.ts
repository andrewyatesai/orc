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
import { decidePlayPath, MAX_REQUEST_PATH_BYTES } from './play-path-guard'

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

  /**
   * The cap cannot live in the corpus rows — a 4097-byte row would be unreadable
   * — so it is declared in the corpus HEADER and each side asserts its own
   * constant against it. Without this, the two implementations capped at 4096
   * and infinity respectively and every row still passed.
   */
  it('caps request paths at the length the corpus declares', () => {
    const declared = readFileSync(CORPUS, 'utf8')
      .split('\n')
      .map((line) => line.trim().match(/^#\s*max-request-path-bytes:\s*(\d+)$/))
      .find((match) => match !== null)
    expect(declared?.[1]).toBeDefined()
    expect(MAX_REQUEST_PATH_BYTES).toBe(Number(declared?.[1]))
  })

  it('refuses a path one byte over the cap, and allows one under', () => {
    const decide = (requestPath: string): string => {
      const decision = decidePlayPath({ root: '/worlds/kitty', requestPath, realpath: (p) => p })
      return decision.allowed ? 'allowed' : decision.reason
    }
    expect(decide(`/${'a'.repeat(MAX_REQUEST_PATH_BYTES)}.js`)).toBe('unresolvable')
    expect(decide(`/${'a'.repeat(MAX_REQUEST_PATH_BYTES - 5)}.js`)).toBe('allowed')
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
