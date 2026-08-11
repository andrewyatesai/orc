#!/usr/bin/env node
// CREDENTIAL-WRITE REPORT — an inventory, not a gate.
//
// Prints every write site in src/{main,cli,relay,preload,shared} whose payload
// or destination NAMES a secret, with the reviewed classification of each. Its
// main value is the handful of `cleartext-fallback-unfixed` findings: real,
// currently-unfixed defects, printed first.
//
// ------------------------------------------------------------- WHAT IT DOES
// 0. CALIBRATES ITSELF FIRST, and this is the one thing that can fail the run.
//    Twenty synthetic cases with fixed answers go through the real pipeline. On
//    any mismatch the process exits non-zero and prints NOTHING ELSE: a report
//    built from a damaged instrument is worse than no report, because a
//    shrunken finding list reads exactly like a clean codebase.
// 1. Resolves write SINKS by declaration identity — node fs / fs/promises,
//    FileHandle, fs/SFTP write streams, ssh2 SFTPWrapper, seeded repo entry
//    points, plus any repo function that forwards a parameter into one of those.
// 2. Decides secret-ness from the payload, the destination, their declared
//    types, one hop of local dataflow, and the names those expressions ASSEMBLE
//    from concatenation, template text, computed keys and folded constants.
// 3. Resolves whether a plaintext-policy predicate selects the branch the write
//    is in. This comes from the type checker on every run and from nothing else.
// 4. Left-joins the reviewed classifications and prints everything.
//
// -------------------------------------------------------- WHAT IT DOES NOT DO
// It does NOT verify that the repository is free of cleartext credential
// writes, and no output of this tool should be read as saying so. Nothing here
// passes or fails; the exit code is 0 whatever the findings are, EXCEPT when
// calibration fails. Specifically:
//   * DETECTION IS NOMINAL, NOT A TAINT PROOF. A secret written through a
//     variable, path and type that all avoid the vocabulary is invisible. The
//     tool reports sites that NAME a secret; it does not prove the set is
//     complete, and "not in this report" means nothing.
//   * `eval`, `new Function`, computed member access with a RUNTIME key, and
//     monkey-patched namespaces are out of scope for any static analysis.
//   * Indirect invocation (`const w = fs.writeFileSync; w(p, token)`) is not a
//     classified write. Base sinks captured as a value are listed separately.
//   * Wrapper chains are followed to a bounded depth; anything cut off by that
//     bound is named in COVERAGE LIMITS.
//   * src/renderer is not analysed. Files outside the analysed directories that
//     import a filesystem module are listed in COVERAGE LIMITS.
//   * The reviewed classifications are a HUMAN JUDGEMENT carried in a JSON file.
//     They annotate rows; they cannot add, remove or hide one. A row whose note
//     is missing prints as `unreviewed`.
//
// Usage: node config/scripts/report-credential-writes.mjs [--json] [--verbose]

import {
  UNREVIEWED,
  VERDICT_ORDER,
  annotate,
  loadReviewNotes,
  reviewNotesPath,
  revivedRetiredKeys,
  unmatchedNoteKeys
} from './credential-write-review-notes.mjs'
import { CANARY_CASES, calibrationFailures } from './credential-write-instrument-canary.mjs'
import { scanCredentialWrites } from './credential-write-report-scan.mjs'
import { displayPath } from './typescript-symbol-resolution.mjs'

const TAG = '[credential-writes]'
const PROMINENT = 'cleartext-fallback-unfixed'

const BOUNDARY = [
  'SCOPE: sites whose payload or destination NAMES a secret, in src/{main,cli,relay,preload,shared}.',
  'Detection is NOMINAL (vocabulary-based), not a taint proof: a secret written through names that',
  'avoid the vocabulary is invisible here, and eval / runtime-computed access is out of scope. This',
  'report does not verify that the tree is free of cleartext credential writes, and absence from it',
  'is not evidence of anything. Verdicts are a carried human review, not a property the tool proved.'
]

/** Runs the known-answer calibration. Returns a list of problems; a non-empty
 *  list must stop the run before anything is printed.
 *
 *  Why the case count is re-checked here: a canary that ran zero cases returns
 *  an empty failure list, which is indistinguishable from a clean instrument. */
function calibrationProblems() {
  let result
  try {
    result = calibrationFailures()
  } catch (error) {
    return [`the calibration canary threw before finishing: ${error.message}`]
  }
  const problems = Array.isArray(result?.failures)
    ? [...result.failures]
    : ['the calibration canary returned no failure list at all, so nothing was calibrated']
  if (result?.casesRun !== CANARY_CASES.length || CANARY_CASES.length < 20) {
    problems.push(
      `the canary ran ${result?.casesRun ?? 0} of ${CANARY_CASES.length} known-answer case(s) — a canary that does not run is not a canary`
    )
  }
  return problems
}

function verdictRank(verdict) {
  const index = VERDICT_ORDER.indexOf(verdict)
  return index === -1 ? VERDICT_ORDER.length : index
}

function tally(rows) {
  const counts = new Map()
  for (const row of rows) {
    counts.set(row.review.verdict, (counts.get(row.review.verdict) ?? 0) + 1)
  }
  return [...counts.entries()].sort(
    (a, b) => verdictRank(a[0]) - verdictRank(b[0]) || a[0].localeCompare(b[0])
  )
}

function renderRow(row, indent = '  ') {
  const guard = row.guard ? ` gated-by=${row.guard}` : ''
  return [
    `${indent}${row.file}:${row.line}  ${row.scope}`,
    `${indent}  sink=${row.sinkId}${guard}`,
    `${indent}  named [${row.words.join(', ')}] in ${row.where.join('+')}`,
    `${indent}  ${row.review.verdict}${row.review.reason ? `: ${row.review.reason}` : ''}`
  ].join('\n')
}

function printSection(title, lines) {
  if (lines.length === 0) {
    return
  }
  console.log(`\n${title}`)
  for (const line of lines) {
    console.log(line)
  }
}

function printReport(scan, rows, notes, verbose) {
  console.log(`${TAG} ${rows.length} secret-named write site(s) in ${scan.elapsedMs}ms`)
  for (const line of BOUNDARY) {
    console.log(`  ${line}`)
  }

  printSection(
    '  BY CLASSIFICATION',
    tally(rows).map(([verdict, count]) => `    ${String(count).padStart(4)}  ${verdict}`)
  )

  // Why this is a section of its own and not a coverage footnote: an orphaned
  // note is a review that has come unstuck from the code it judged, and the
  // site it judged is now printing as `unreviewed` somewhere above. Buried at
  // the bottom, that read as housekeeping for four releases.
  printSection(
    `  ORPHANED REVIEW NOTES (${notes.stale.length}) — carried judgement attached to no site in this run\n` +
      `    Each one means a real review is no longer being applied. Reconcile with:\n` +
      `      pnpm report:credential-writes:rekey          (proposes, changes nothing)\n` +
      `      pnpm report:credential-writes:rekey --apply  (rewrites the keys it can prove)`,
    notes.stale.map((key) => `    ${key}`)
  )
  printSection(
    `  RETIRED NOTES REVIVED (${notes.revived.length}) — a retired note's site is back and is reading unreviewed`,
    notes.revived.map((key) => `    ${key}`)
  )

  // Why MEMBERSHIP is keyed on `guard` and only ORDER is keyed on the review:
  // relabelling a note must not be able to delete a finding, so every unguarded
  // site is printed whatever the JSON says. The review may promote a row up the
  // list; it can never remove one.
  const unguarded = rows.filter((row) => row.guard === null)
  const leads = (row) => row.review.verdict === PROMINENT || row.review.verdict === UNREVIEWED
  const ordered = [...unguarded.filter(leads), ...unguarded.filter((row) => !leads(row))]
  const leadCount = unguarded.filter(leads).length
  printSection(
    `  UNGUARDED WRITES THAT NAME A SECRET (${unguarded.length}) — no sanctioned predicate selects this branch\n` +
      `    ${leadCount} reviewed as a real defect or not yet reviewed, listed first; the rest carry a review explaining why they are accepted`,
    ordered.map((row) => renderRow(row, '    '))
  )

  const unreviewed = rows.filter((row) => row.review.verdict === UNREVIEWED)
  printSection(
    `  UNREVIEWED SITES (${unreviewed.length}) — found by the analysis, no carried classification`,
    unreviewed.map((row) => renderRow(row, '    '))
  )

  const limits = [
    ...scan.caveats.map((caveat) => `    - ${caveat}`),
    ...(notes.problem ? [`    - ${notes.problem}`] : []),
    ...(scan.unreadFiles.length > 0
      ? [
          `    - ${scan.unreadFiles.length} file(s) in the analysed directories are in no Program, so they were NOT read:\n        ${scan.unreadFiles.slice(0, 20).join('\n        ')}`
        ]
      : []),
    ...(scan.outOfScopeWriters.length > 0
      ? [
          `    - ${scan.outOfScopeWriters.length} file(s) outside the analysed directories import a filesystem module and were NOT analysed:\n        ${scan.outOfScopeWriters.join('\n        ')}`
        ]
      : []),
    ...(scan.escapes.length > 0
      ? [
          `    - ${scan.escapes.length} write sink(s) captured as a value; calls through the captured value are NOT in the list above:\n        ${scan.escapes.map((escape) => `${escape.location} ${escape.text}`).join('\n        ')}`
        ]
      : []),
    ...(notes.stale.length > 0
      ? [
          `    - ${notes.stale.length} carried review note(s) match no site in this run — see ORPHANED REVIEW NOTES above`
        ]
      : [])
  ]
  printSection('  COVERAGE LIMITS — read the counts above against these', limits)
  if (limits.length === 0) {
    console.log('\n  COVERAGE LIMITS — none beyond the permanent ones stated at the top')
  }

  printSection(
    '  ALL SITES',
    verbose
      ? rows.map((row) => renderRow(row, '    '))
      : [
          `    ${rows.length} site(s); re-run with --verbose to print every one, or --json for the data`
        ]
  )

  console.log(
    `\n${TAG} report only — nothing here passed or failed. ${unguarded.length} unguarded (${leadCount} reviewed as a real defect or unreviewed), ${rows.length} total. ` +
      `${notes.stale.length} orphaned review note(s), ${notes.retiredCount} retired.`
  )
}

function main() {
  const argv = process.argv.slice(2)
  const wantsJson = argv.includes('--json')
  const verbose = argv.includes('--verbose')

  // Why nothing else runs on failure: an instrument that fails its own
  // calibration has no readings, so there is nothing to publish.
  const problems = calibrationProblems()
  if (problems.length > 0) {
    console.error(
      `\n${TAG} INSTRUMENT FAILURE — the detector does not agree with its own known-answer cases, so no report is produced:\n\n  ${problems.join('\n  ')}\n`
    )
    return 1
  }

  const scan = scanCredentialWrites()
  const { notes, retired, problem: notesProblem } = loadReviewNotes()
  const rows = annotate(scan.sites, notes)
  // The annotation step is a left join and must stay one; this is the check
  // that the review data cannot remove a site from the report.
  if (rows.length !== scan.sites.length) {
    console.error(
      `\n${TAG} INTERNAL ERROR — annotation changed the site count from ${scan.sites.length} to ${rows.length}. Review notes must never add or remove a row.\n`
    )
    return 1
  }
  const noteState = {
    problem: notesProblem,
    stale: unmatchedNoteKeys(scan.sites, notes),
    revived: revivedRetiredKeys(scan.sites, retired),
    retiredCount: retired.size
  }

  if (wantsJson) {
    console.log(
      JSON.stringify(
        {
          tool: 'report:credential-writes',
          kind: 'report',
          boundary: BOUNDARY,
          totalSites: rows.length,
          counts: Object.fromEntries(tally(rows)),
          reviewNotes: displayPath(reviewNotesPath()),
          reviewNotesProblem: notesProblem,
          staleReviewNotes: noteState.stale,
          revivedRetiredNotes: noteState.revived,
          retiredReviewNotes: noteState.retiredCount,
          coverageLimits: scan.caveats,
          unreadFiles: scan.unreadFiles,
          outOfScopeWriters: scan.outOfScopeWriters,
          depthLimitedChains: scan.depthLimitedChains,
          escapes: scan.escapes,
          projects: scan.projects,
          elapsedMs: scan.elapsedMs,
          sites: rows
        },
        null,
        2
      )
    )
    return 0
  }

  printReport(scan, rows, noteState, verbose)
  return 0
}

process.exitCode = main()
