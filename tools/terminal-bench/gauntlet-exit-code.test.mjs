// A SKIP that exits 0 is the failure mode this repo keeps hitting: the gate never
// ran, and the shell reads "proved". These tests pin both directions through the
// real CLI — a gate that genuinely passes still exits 0, and a selection that only
// skipped exits 3 (NOTHING PROVEN). The autoformalize block extends that to the
// EMPTY SET, the other way a gate goes silently green: that axis's corpus lives
// outside this repo, so "discovered nothing" must never read as "verified everything".
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT, gauntletExit } from './gauntlet-exit-code.mjs'

const GAUNTLET = path.join(import.meta.dirname, 'gauntlet.mjs')
const REPORT = path.join(import.meta.dirname, '.gauntlet-report.json')
const RATCHET = path.join(import.meta.dirname, 'autoformalize-ratchet.json')
let priorReport = null
let priorRatchet = null

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
  priorRatchet = existsSync(RATCHET) ? readFileSync(RATCHET, 'utf8') : null
})
afterAll(() => {
  // The CLI runs clobber a developer's last report; the ratchet arms below rewrite
  // the committed baseline. Put both back.
  if (priorReport === null) {
    rmSync(REPORT, { force: true })
  } else {
    writeFileSync(REPORT, priorReport)
  }
  if (priorRatchet === null) {
    rmSync(RATCHET, { force: true })
  } else {
    writeFileSync(RATCHET, priorRatchet)
  }
})

// A stand-in $TRUST_REPO: the real harness, toolchain and corpus all live outside
// this repo, so the only way to plant a violation of THIS axis's stated property is
// to hand it a corpus we control. The stub driver speaks the driver's contract
// (exit 0 + "VERDICT: TRUSTED", or exit 1) and refutes any candidate marked REFUTE.
const STUB_DRIVER = `import { readFileSync } from 'node:fs'
if (readFileSync(process.argv[5], 'utf8').includes('REFUTE')) {
  console.log('VERDICT: NOT TRUSTED — planted refutation')
  process.exit(1)
}
console.log('VERDICT: TRUSTED')
`

function makeTrustRepo(kernels) {
  const root = mkdtempSync(path.join(tmpdir(), 'gauntlet-trust-'))
  const ts2rust = path.join(root, 'tools', 'ts2rust')
  const trustc = path.join(root, 'build', 'host', 'stage2', 'bin', 'trustc')
  mkdirSync(path.join(ts2rust, 'orca'), { recursive: true })
  mkdirSync(path.dirname(trustc), { recursive: true })
  writeFileSync(path.join(ts2rust, 'autoformalize.mjs'), STUB_DRIVER)
  writeFileSync(trustc, '')
  for (const { name, refute } of kernels) {
    writeFileSync(
      path.join(ts2rust, 'orca', `${name}.ts`),
      'export function k(x) {\n  return x\n}\n'
    )
    writeFileSync(
      path.join(ts2rust, 'orca', `${name}.rs`),
      `${refute ? '// REFUTE\n' : ''}pub fn k(x: u32) -> u32 {\n    x\n}\n`
    )
  }
  return { root, trustc }
}

function runAutoformalize(kernels, ratchet) {
  const { root, trustc } = makeTrustRepo(kernels)
  if (ratchet === null) {
    rmSync(RATCHET, { force: true })
  } else {
    writeFileSync(RATCHET, JSON.stringify(ratchet))
  }
  try {
    // Pin TRUSTC too: on a machine that really has the Trust toolchain, PATH
    // discovery would run the REAL verifier against these stub kernels.
    return runGauntlet('autoformalize', { TRUST_REPO: root, TRUSTC: trustc })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const HEALTHY = [{ name: 'k1' }, { name: 'k2' }, { name: 'ctl_bug', refute: true }]
const BASELINE = { minTrusted: 2, soundnessControls: 1 }

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

// Every arm below plants a violation of the axis's stated property and watches the
// real CLI fail on it — a guard nobody has seen fail proves nothing.
describe('autoformalize empty-set guards', () => {
  it('exits 0 on a healthy corpus (the arm the guards must not break)', () => {
    const { code, report } = runAutoformalize(HEALTHY, BASELINE)
    const r = report.results.autoformalize
    expect(r.status).toBe('PASS')
    expect(r.metrics).toMatchObject({ trusted: 2, total: 3, controls: 1 })
    expect(code).toBe(EXIT.pass)
  })

  it('FAILs when the ratcheted corpus vanished instead of skipping', () => {
    const { code, report } = runAutoformalize([], BASELINE)
    const r = report.results.autoformalize
    expect(r.status).toBe('FAIL')
    expect(r.detail).toMatch(/ratcheted corpus is GONE/)
    expect(code).toBe(EXIT.fail)
  })

  it('FAILs when the soundness controls vanished (the check would be vacuous)', () => {
    const { code, report } = runAutoformalize([{ name: 'k1' }, { name: 'k2' }], BASELINE)
    const r = report.results.autoformalize
    expect(r.status).toBe('FAIL')
    expect(r.metrics.controls).toBe(0)
    expect(r.detail).toMatch(/soundness controls SHRANK: 0 < baseline 1.*vacuous/u)
    expect(code).toBe(EXIT.fail)
  })

  it('FAILs when a known-bug control comes back TRUSTED', () => {
    const kernels = [{ name: 'k1' }, { name: 'k2' }, { name: 'ctl_bug' }]
    const { code, report } = runAutoformalize(kernels, BASELINE)
    expect(report.results.autoformalize.detail).toMatch(/SOUNDNESS BREAK/)
    expect(code).toBe(EXIT.fail)
  })

  it('FAILs when the TRUSTED count drops below the baseline', () => {
    const kernels = [
      { name: 'k1', refute: true },
      { name: 'k2' },
      { name: 'ctl_bug', refute: true }
    ]
    const { code, report } = runAutoformalize(kernels, BASELINE)
    expect(report.results.autoformalize.detail).toMatch(/TRUSTED count regressed: 1 < baseline 2/)
    expect(code).toBe(EXIT.fail)
  })

  it('never exits 0 when no baseline ratchets the run', () => {
    for (const ratchet of [null, { minTrusted: 2 }, { soundnessControls: 1 }]) {
      const { code, report } = runAutoformalize(HEALTHY, ratchet)
      expect(report.results.autoformalize.status).toBe('REVIEW')
      expect(report.results.autoformalize.detail).toMatch(/NOT ratcheted/)
      expect(code).toBe(EXIT.review)
      expect(code).not.toBe(EXIT.pass)
    }
  })

  it('still skips honestly — and not as a pass — when nothing is claimed or present', () => {
    const { code, report } = runAutoformalize([], null)
    expect(report.results.autoformalize.status).toBe('SKIP')
    expect(report.results.autoformalize.detail).toMatch(/nothing ran, nothing proven/)
    expect(code).toBe(EXIT.nothingProven)
    expect(code).not.toBe(EXIT.pass)
  })
})
