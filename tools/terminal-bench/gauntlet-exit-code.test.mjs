// A SKIP that exits 0 is the failure mode this repo keeps hitting: the gate never
// ran, and the shell reads "proved". These tests pin both directions through the
// real CLI — a gate that genuinely passes still exits 0, and a selection that only
// skipped exits 3 (NOTHING PROVEN).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT, gauntletExit } from './gauntlet-exit-code.mjs'

const GAUNTLET = path.join(import.meta.dirname, 'gauntlet.mjs')
const REPORT = path.join(import.meta.dirname, '.gauntlet-report.json')
let priorReport = null

function runGauntlet(gate, env = {}) {
  const r = spawnSync(process.execPath, [GAUNTLET, gate], {
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
})
