import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Ratchet gate for the react-doctor oxlint rules (`pnpm lint:react-doctor`).
//
// The rules stay `warn` in config/oxlint-react-doctor.json on purpose: .lintstagedrc.mjs
// runs that same config on every commit, and the tree still carries legacy findings, so
// `error` would block commits on code the author never touched. But oxlint exits 0 for
// warnings, so `oxlint --config …` on its own printed findings and gated nothing.
//
// This freezes the per-file, per-rule finding COUNT (the baseline) and fails when any
// count goes up or an unlisted file reports one. The baseline may only shrink — fixing a
// finding forces a prune, which locks the improvement in. New-code enforcement for a
// branch is `check:react-doctor:changed`, which judges only the lines you touched.

const CONFIG_PATH = path.join('config', 'oxlint-react-doctor.json')
const BASELINE_PATH = path.join('config', 'react-doctor-baseline.txt')
const BASELINE_LINE = /^(.+) (\S+) (\d+)$/
const MAX_REPORTED_ENTRIES = 40

function oxlintBinary() {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('oxlint/package.json')
  const { bin } = require(manifestPath)
  const entry = typeof bin === 'string' ? bin : bin.oxlint
  return path.join(path.dirname(manifestPath), entry)
}

/** Rules the config turns on, so an oxlint that silently loaded none cannot pass. */
export function enabledRules(configText) {
  const { rules = {} } = JSON.parse(configText)
  return Object.entries(rules)
    .filter(([, severity]) => {
      const level = Array.isArray(severity) ? severity[0] : severity
      return level !== 'off' && level !== 'allow'
    })
    .map(([rule]) => rule)
}

/** `react-doctor(no-array-index-as-key)` -> `no-array-index-as-key`. */
function ruleOf(code) {
  return /\(([^)]+)\)/.exec(code ?? '')?.[1] ?? code ?? 'unknown'
}

export function findingsFromDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => ({
    file: (diagnostic.filename ?? '').split(path.sep).join('/'),
    rule: ruleOf(diagnostic.code),
    line: diagnostic.labels?.[0]?.span?.line ?? 0,
    column: diagnostic.labels?.[0]?.span?.column ?? 0,
    message: diagnostic.message ?? ''
  }))
}

export function countFindings(findings) {
  const counts = new Map()
  for (const { file, rule } of findings) {
    const key = `${file} ${rule}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function parseBaseline(text) {
  const counts = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const match = BASELINE_LINE.exec(line)
    if (!match) {
      throw new Error(`Unparseable ${BASELINE_PATH} line: ${line}`)
    }
    counts.set(`${match[1]} ${match[2]}`, Number(match[3]))
  }
  return counts
}

export function diffBaseline(current, baseline) {
  const increased = []
  const decreased = []
  for (const [key, count] of current) {
    const allowed = baseline.get(key) ?? 0
    if (count > allowed) {
      increased.push({ key, allowed, count })
    }
  }
  for (const [key, allowed] of baseline) {
    const count = current.get(key) ?? 0
    if (count < allowed) {
      decreased.push({ key, allowed, count })
    }
  }
  increased.sort((a, b) => a.key.localeCompare(b.key))
  decreased.sort((a, b) => a.key.localeCompare(b.key))
  return { increased, decreased }
}

/**
 * A report with no diagnostics is indistinguishable from a run that linted nothing or
 * loaded no rules, and the second one passes forever. Both are refused here.
 */
export function assertReportIsUsable(report, expectedRules) {
  if (!(expectedRules > 0)) {
    throw new Error(`${CONFIG_PATH} enables no react-doctor rules; there is nothing to gate.`)
  }
  if (!report || !Array.isArray(report.diagnostics)) {
    throw new Error('oxlint produced no JSON report; react-doctor was not actually run.')
  }
  if (!(report.number_of_files > 0)) {
    throw new Error('oxlint linted 0 files; react-doctor scanned an empty set.')
  }
  if (report.number_of_rules !== expectedRules) {
    throw new Error(
      `oxlint loaded ${report.number_of_rules} rule(s) but ${CONFIG_PATH} enables ${expectedRules}; the react-doctor plugin did not load.`
    )
  }
}

function runOxlint(root) {
  const result = spawnSync(
    process.execPath,
    [oxlintBinary(), '--config', CONFIG_PATH, '--format', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  if (result.error) {
    throw result.error
  }
  // Warnings alone exit 0 — a non-zero status means the run itself failed, or a rule was
  // raised to `error`. Either way the ratchet cannot speak for the result.
  if (result.status !== 0) {
    throw new Error(
      `oxlint exited ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    )
  }
  try {
    return JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(`Could not parse the oxlint JSON report: ${cause.message}`)
  }
}

export function collect(root = process.cwd()) {
  const expectedRules = enabledRules(fs.readFileSync(path.join(root, CONFIG_PATH), 'utf8')).length
  const report = runOxlint(root)
  assertReportIsUsable(report, expectedRules)
  const findings = findingsFromDiagnostics(report.diagnostics)
  return { findings, counts: countFindings(findings), files: report.number_of_files }
}

function printIncreased(increased, findings) {
  for (const { key, allowed, count } of increased) {
    console.error(`::error::New react-doctor finding: ${key} (baseline ${allowed}, now ${count})`)
  }
  console.error('')
  console.error('❌  react-doctor ratchet failed — NEW React state/effect findings appeared.')
  console.error('')
  for (const { key } of increased.slice(0, MAX_REPORTED_ENTRIES)) {
    const split = key.lastIndexOf(' ')
    const [file, rule] = [key.slice(0, split), key.slice(split + 1)]
    for (const finding of findings.filter((f) => f.file === file && f.rule === rule)) {
      console.error(`    • ${file}:${finding.line}:${finding.column}  ${rule}`)
      console.error(`        ↳ ${finding.message}`)
    }
  }
  console.error('')
  console.error('  ✅  Fix the finding. If it is a deliberate exception, suppress it AT THE LINE')
  console.error('      with `oxlint-disable-next-line react-doctor/<rule> -- Why: …`, the way the')
  console.error(`      existing exceptions do. Do NOT raise a count in ${BASELINE_PATH}.`)
  console.error('')
}

function printDecreased(decreased) {
  for (const { key, allowed, count } of decreased) {
    console.error(
      `::error::Stale react-doctor baseline entry (prune it): ${key} (baseline ${allowed}, now ${count})`
    )
  }
  console.error('')
  console.error('⚠️  react-doctor baseline is out of date — nice work removing findings!')
  console.error('  The baseline may only shrink, so it has to record the lower count now:')
  console.error('')
  console.error('  ✅  Fix it (one command):  pnpm lint:react-doctor --prune')
  console.error('')
}

function writeBaseline(root, counts) {
  const header = [
    '# react-doctor findings currently tolerated, as `<file> <rule> <count>`.',
    '# This is a RATCHET: counts may only SHRINK. Do NOT raise one to get the gate green —',
    '# fix the finding, or suppress that line with an `-- Why:` reason.',
    '# Regenerate/prune: pnpm lint:react-doctor --prune   (never raises a count)',
    ''
  ].join('\n')
  const body = [...counts]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)
    .sort()
  fs.writeFileSync(path.join(root, BASELINE_PATH), `${header}${body.join('\n')}\n`)
  return body.length
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(
      `::error::Missing ${BASELINE_PATH}. Generate it with: node config/scripts/lint-react-doctor.mjs --init`
    )
    return 1
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const { findings, counts, files } = collect(root)
  const { increased, decreased } = diffBaseline(counts, baseline)

  if (increased.length > 0) {
    printIncreased(increased, findings)
    if (decreased.length > 0) {
      printDecreased(decreased)
    }
    return 1
  }
  if (decreased.length > 0) {
    printDecreased(decreased)
    return 1
  }
  console.log(
    `react-doctor ratchet OK — ${findings.length} grandfathered finding(s) over ${files} file(s), none new.`
  )
  return 0
}

function rewriteBaseline(root, flag) {
  const { counts } = collect(root)
  const baselineFile = path.join(root, BASELINE_PATH)
  const previous =
    flag === '--prune' && fs.existsSync(baselineFile)
      ? parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
      : null
  // --prune only lowers: a count that grew is a new finding, not a baseline update.
  const next = previous
    ? new Map([...previous].map(([key, allowed]) => [key, Math.min(allowed, counts.get(key) ?? 0)]))
    : counts
  console.log(`Wrote ${BASELINE_PATH} with ${writeBaseline(root, next)} entries.`)
  const grew = previous ? diffBaseline(counts, previous).increased : []
  if (grew.length === 0) {
    return 0
  }
  console.error(
    `::error::--prune never raises a count; ${grew.length} new finding(s) remain — fix those.`
  )
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const flag = process.argv[2]
  try {
    process.exit(flag === '--init' || flag === '--prune' ? rewriteBaseline(root, flag) : main(root))
  } catch (error) {
    // A gate that cannot run has not passed: report the reason and exit non-zero.
    console.error(`::error::${error.message}`)
    process.exit(1)
  }
}
