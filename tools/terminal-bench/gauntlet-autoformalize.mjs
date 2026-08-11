// The `autoformalize` gauntlet axis (Goal A) — the Trust ts2rust two-witness gate
// over the orc corpus, plus the ratchet that keeps an EMPTY discovery from reading
// as a proof.
//
// WHY the empty-set bookkeeping is the interesting part: every input this axis
// quantifies over lives OUTSIDE this repo ($TRUST_REPO/tools/ts2rust — harness,
// toolchain and corpus), so an absence is the normal case and has to be CLASSIFIED
// rather than swallowed. `some(...)` over an empty corpus is false, so "found no
// kernels" and "found no soundness break" are the same value; without the clauses
// below a vanished corpus reads exactly like a clean sweep.
//
//   harness / trustc absent            SKIP    environment gap — exit 3, never green
//   0 kernels, no baseline on file     SKIP    nothing claimed, nothing proven
//   0 kernels, baseline on file        FAIL    the ratcheted corpus is gone
//   fewer controls than the baseline   FAIL    the refutation evidence shrank
//   a control came back TRUSTED        FAIL    soundness break
//   TRUSTED count below the baseline   FAIL    a kernel stopped verifying
//   baseline missing / clause missing  REVIEW  nothing is ratcheted — never a pass
//
// Extracted from gauntlet.mjs so that file stays under its max-lines cap; the host
// passes in the shared primitives (this dir, sh, skip, $TRUST_REPO).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { rustTypeToArgspec } from './rust-type-to-argspec.mjs'

// Convention: a deliberately-buggy port is named *_bug / *_naive (SUFFIX — don't
// match substrings, `..._toobig` is a real predicate name). These are the axis's
// negative controls: the only evidence the verifier can still say NO.
const CONTROL = /_(bug|naive)$/u

function discoverCorpus(orcaDir) {
  const out = []
  let files
  try {
    files = readdirSync(orcaDir).filter((f) => f.endsWith('.rs'))
  } catch {
    return out
  }
  for (const rs of files) {
    const name = rs.slice(0, -3)
    if (!existsSync(join(orcaDir, `${name}.ts`))) {
      continue // the driver needs a same-named .ts reference kernel
    }
    const src = readFileSync(join(orcaDir, rs), 'utf8')
    // Allow a generic/lifetime clause between the fn name and the arg list
    // (`pub fn f<'a>(…)`) — the shape of the &str-slice kernels.
    const sig = src.match(/pub\s+fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/u)
    if (!sig) {
      continue
    }
    // A tuple return (`-> (u16, u16)`) serializes to ONE JSON array via serde,
    // matching a TS twin that returns `[a, b]` — the W2 harness diffs it fine
    // (verified: b11_gridsize/b11_pointcell are TRUSTED), so it is NOT skipped.
    const params = sig[2].trim()
    const specs = []
    let ok = true
    // Filter empties so a trailing comma in a multi-line signature
    // (`cell_height: u16,\n)`) does not split into a phantom empty param that
    // falsely declines an otherwise-runnable kernel.
    for (const p of params
      ? params
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []) {
      const a = rustTypeToArgspec(p.split(':').slice(1).join(':'), src)
      if (!a) {
        ok = false
        break
      }
      specs.push(a)
    }
    if (ok) {
      out.push({
        name,
        fn: sig[1],
        argspec: specs.join(','),
        expect: CONTROL.test(name) ? 'NOT-TRUSTED' : 'TRUSTED'
      })
    } else {
      out.push({ name, fn: sig[1], declined: true })
    }
  }
  return out
}

function locateTrustc(trustRoot, sh) {
  const candidates = [
    process.env.TRUSTC,
    join(trustRoot, 'build', 'host', 'stage2', 'bin', 'trustc')
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) {
      return c
    }
  }
  try {
    return sh('bash', ['-lc', 'command -v trustc']).trim() || null
  } catch {
    return null
  }
}

function readRatchet(file) {
  if (!existsSync(file)) {
    return { missing: true }
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { unreadable: String(e.message).split('\n')[0] }
  }
}

function runKernel(sh, driver, ts2rust, trustc, c) {
  try {
    sh('node', [driver, `orca/${c.name}.ts`, c.fn, c.argspec, `orca/${c.name}.rs`], {
      cwd: ts2rust,
      env: { ...process.env, TRUSTC: trustc },
      timeout: 180000
    })
    return { verdict: 'TRUSTED', note: '' }
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    return {
      verdict: /VERDICT:\s*TRUSTED/u.test(out) ? 'TRUSTED' : 'NOT-TRUSTED',
      note: (
        out.split('\n').find((l) => /counterexample|divergence|ts=|rust=|REFUTED/iu.test(l)) || ''
      )
        .trim()
        .slice(0, 80)
    }
  }
}

export function autoformalizeGate({ here, sh, skip, trustRoot, trustRootLabel }) {
  const ts2rust = join(trustRoot, 'tools', 'ts2rust')
  const driver = join(ts2rust, 'autoformalize.mjs')
  if (!existsSync(driver)) {
    return skip(
      `Trust ts2rust harness not found (${trustRootLabel}/tools/ts2rust) — Goal A engine lives in the Trust repo; nothing ran, nothing proven`
    )
  }
  const ratchet = readRatchet(join(here, 'autoformalize-ratchet.json'))
  const num = (k) => (typeof ratchet[k] === 'number' ? ratchet[k] : null)
  const minTrusted = num('minTrusted')
  const minControls = num('soundnessControls')
  const where = `${trustRootLabel}/tools/ts2rust/orca`
  const corpus = discoverCorpus(join(ts2rust, 'orca'))
  const runnable = corpus.filter((c) => !c.declined)
  const controls = runnable.filter((c) => c.expect === 'NOT-TRUSTED').length
  // The vacuous-pass door: with nothing discovered every check below is trivially
  // satisfied. A baseline on file is proof the corpus WAS non-empty, so zero is a
  // regression; with no baseline nobody ever claimed otherwise, so it is a SKIP.
  if (!runnable.length) {
    const metrics = { corpus: 0, declined: corpus.length, minTrusted }
    return minTrusted === null
      ? {
          status: 'SKIP',
          metrics,
          detail: `0 autoformalizable .ts/.rs pairs discovered under ${where} — nothing ran, nothing proven`
        }
      : {
          status: 'FAIL',
          metrics,
          detail: `0 autoformalizable .ts/.rs pairs discovered under ${where} while the ratchet claims >=${minTrusted} TRUSTED — the ratcheted corpus is GONE; an empty corpus proves nothing`
        }
  }
  const trustc = locateTrustc(trustRoot, sh)
  if (!trustc) {
    return {
      status: 'SKIP',
      metrics: {
        corpus: runnable.length,
        declined: corpus.length - runnable.length,
        controls
      },
      detail: `trustc not built — ${runnable.length} orc functions ready to autoformalize; build the Trust stage2 toolchain or set TRUSTC=<path>, then re-run (nothing proven until then)`
    }
  }
  const rows = runnable.map((c) => ({
    fn: c.fn,
    argspec: c.argspec,
    expect: c.expect,
    ...runKernel(sh, driver, ts2rust, trustc, c)
  }))
  const trusted = rows.filter((r) => r.verdict === 'TRUSTED').length
  const broke = rows.filter((r) => r.expect === 'NOT-TRUSTED' && r.verdict === 'TRUSTED')
  const faithfulMiss = rows.filter(
    (r) => r.expect === 'TRUSTED' && r.verdict === 'NOT-TRUSTED'
  ).length
  // A ratchet clause that is absent is a clause that never ran — REVIEW, not PASS.
  const unratcheted = [
    ratchet.missing ? 'no autoformalize-ratchet.json on disk' : null,
    ratchet.unreadable ? `autoformalize-ratchet.json unreadable (${ratchet.unreadable})` : null,
    !ratchet.missing && !ratchet.unreadable && minTrusted === null
      ? 'ratchet has no minTrusted'
      : null,
    !ratchet.missing && !ratchet.unreadable && minControls === null
      ? 'ratchet has no soundnessControls'
      : null
  ].filter(Boolean)
  const fails = [
    broke.length
      ? `SOUNDNESS BREAK: known-bug port(s) came back TRUSTED — ${broke.map((r) => r.fn).join(', ')}`
      : null,
    minControls !== null && controls < minControls
      ? `soundness controls SHRANK: ${controls} < baseline ${minControls}${controls === 0 ? ' — ZERO controls left, so the soundness check above is vacuous' : ''}`
      : null,
    minTrusted !== null && trusted < minTrusted
      ? `TRUSTED count regressed: ${trusted} < baseline ${minTrusted} (a kernel stopped verifying, or the verifier changed — ratchet measured with ${ratchet.toolchain ?? 'an unrecorded toolchain'}, this run used ${trustcVersion(sh, trustc)})`
      : null
  ].filter(Boolean)
  return {
    status: fails.length ? 'FAIL' : unratcheted.length || faithfulMiss ? 'REVIEW' : 'PASS',
    metrics: {
      trusted,
      total: rows.length,
      declined: corpus.length - runnable.length,
      controls,
      minTrusted,
      minControls
    },
    detail:
      fails.join(' · ') ||
      (unratcheted.length
        ? `${trusted}/${rows.length} TRUSTED but NOT ratcheted: ${unratcheted.join('; ')} — write the baseline before calling this green`
        : `${trusted}/${rows.length} TRUSTED (baseline ${minTrusted}), ${controls} soundness control(s) all refuted${faithfulMiss ? `, ${faithfulMiss} faithful port(s) NOT-TRUSTED — triage` : ''}${trusted > minTrusted ? ' — grew, bump baseline' : ''}`),
    rows
  }
}

function trustcVersion(sh, trustc) {
  try {
    return sh(trustc, ['--version']).trim()
  } catch {
    return trustc
  }
}
