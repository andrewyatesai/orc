// A SKIP that exits 0 is the failure mode this repo keeps hitting: the gate never
// ran, and the shell reads "proved". These tests pin both directions through the
// real CLI — a gate that genuinely passes still exits 0, and a selection that only
// skipped exits 3 (NOTHING PROVEN).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT, gauntletExit } from './gauntlet-exit-code.mjs'
import { PERF_CORPUS_MIN_BYTES } from './gauntlet-prereqs.mjs'

const GAUNTLET = path.join(import.meta.dirname, 'gauntlet.mjs')
const REPORT = path.join(import.meta.dirname, '.gauntlet-report.json')
let priorReport = null

function runGauntlet(gate, env = {}, args = []) {
  const r = spawnSync(process.execPath, [GAUNTLET, gate, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    report: JSON.parse(readFileSync(REPORT, 'utf8'))
  }
}

beforeAll(() => {
  priorReport = existsSync(REPORT) ? readFileSync(REPORT, 'utf8') : null
})
afterAll(() => {
  // The CLI runs clobber a developer's last report; put it back.
  if (priorReport === null) {
    rmSync(REPORT, { force: true })
  } else {
    writeFileSync(REPORT, priorReport)
  }
})

describe('gauntletExit', () => {
  it('exits 0 only when every selected gate proved green', () => {
    expect(gauntletExit(['PASS']).code).toBe(EXIT.pass)
    expect(gauntletExit(['PASS', 'PASS']).code).toBe(EXIT.pass)
  })

  it('never exits 0 when any selected gate skipped', () => {
    for (const statuses of [
      ['SKIP'],
      ['SKIP', 'SKIP'],
      ['PASS', 'SKIP'],
      ['PASS', 'PASS', 'SKIP']
    ]) {
      expect(gauntletExit(statuses).code).not.toBe(EXIT.pass)
    }
  })

  it('separates "nothing ran" (3) from "an axis ran and needs triage" (2)', () => {
    expect(gauntletExit(['SKIP']).code).toBe(EXIT.nothingProven)
    expect(gauntletExit(['SKIP', 'SKIP']).code).toBe(EXIT.nothingProven)
    expect(gauntletExit(['PASS', 'SKIP']).code).toBe(EXIT.review)
    expect(gauntletExit(['REVIEW']).code).toBe(EXIT.review)
  })

  it('keeps FAIL dominant and treats an empty selection as nothing proven', () => {
    expect(gauntletExit(['FAIL', 'SKIP', 'REVIEW', 'PASS']).code).toBe(EXIT.fail)
    expect(gauntletExit([]).code).toBe(EXIT.nothingProven)
  })

  it('says skips proved nothing in the summary line', () => {
    expect(gauntletExit(['SKIP']).line).toMatch(/NOTHING PROVEN/)
    expect(gauntletExit(['PASS', 'SKIP']).line).toMatch(/skipped \(proved nothing\)/)
    expect(gauntletExit(['PASS']).line).not.toMatch(/skip/i)
  })
})

// Reachability: the exit code the shell sees, from the gate's own CLI.
describe('gauntlet CLI', () => {
  it('still exits 0 for a gate that really passes', () => {
    const { code, out, report } = runGauntlet('corpus')
    expect(report.results.corpus.status).toBe('PASS')
    expect(code).toBe(0)
    expect(out).toMatch(/every selected gate proved green/)
  })

  it('does not look like success when the only selected gate skipped', () => {
    // TRUST_REPO at an empty dir makes autoformalize skip on every machine (the
    // ts2rust harness lives outside this repo) — the same path conformance takes
    // when the napi addon is missing.
    const trustRepo = mkdtempSync(path.join(tmpdir(), 'gauntlet-no-trust-'))
    try {
      const { code, out, report } = runGauntlet('autoformalize', { TRUST_REPO: trustRepo })
      expect(report.results.autoformalize.status).toBe('SKIP')
      expect(code).toBe(EXIT.nothingProven)
      expect(code).not.toBe(0)
      expect(out).toMatch(/NOTHING PROVEN/)
      expect(report.exit).toBe(EXIT.nothingProven)
    } finally {
      rmSync(trustRepo, { recursive: true, force: true })
    }
  })

  // bootstrap used to call three existsSync hits "all prerequisites already present"
  // and exit 0, so an empty addon or a half-written corpus read as green. TMPDIR
  // relocates the gate's own BENCH_DIR, so the corpus can be corrupted for real;
  // --verify keeps the run from installing anything on the way there.
  const benchTmp = (corpusBytes) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gauntlet-bench-'))
    if (corpusBytes) {
      mkdirSync(path.join(root, 'orca-bench'), { recursive: true })
      writeFileSync(path.join(root, 'orca-bench', 'corpus.bin'), corpusBytes)
    }
    return { root, env: { TMPDIR: root, TEMP: root, TMP: root } }
  }

  it('FAILs bootstrap on a truncated perf corpus rather than counting the path', () => {
    const { root, env } = benchTmp(Buffer.alloc(4096, 0x1b))
    try {
      const { code, out, report } = runGauntlet('bootstrap', env, ['--verify'])
      expect(report.results.bootstrap.status).toBe('FAIL')
      expect(report.results.bootstrap.detail).toMatch(/truncated: 4096 B/)
      expect(code).toBe(EXIT.fail)
      expect(out).toMatch(/UNUSABLE/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads the built addon and never calls a missing corpus green', () => {
    const { root, env } = benchTmp(null)
    try {
      const { code, report } = runGauntlet('bootstrap', env, ['--verify'])
      const boot = report.results.bootstrap
      // `pnpm test` runs build:terminal-addon first, so the addon must verify here.
      expect(boot.metrics.addon).not.toBe('MISSING')
      expect(boot.metrics.addon).not.toBe('BROKEN')
      expect(boot.metrics.corpus).toBe('MISSING')
      expect(boot.status).toBe('REVIEW')
      expect(code).toBe(EXIT.review)
      // --verify must not kick off a multi-minute cargo build behind the caller.
      expect(existsSync(path.join(root, 'orca-bench', 'corpus.bin'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a full-size ANSI corpus — a bootstrapped tree still passes', () => {
    const { root, env } = benchTmp(Buffer.alloc(PERF_CORPUS_MIN_BYTES, 0x1b))
    try {
      const { report } = runGauntlet('bootstrap', env, ['--verify'])
      const corpus = report.results.bootstrap.checks.find((c) => c.name === 'corpus')
      expect(corpus.ok).toBe(true)
      expect(report.results.bootstrap.status).not.toBe('FAIL')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
