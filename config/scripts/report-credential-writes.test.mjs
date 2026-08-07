// What these tests are for: the properties that make the credential-write
// REPORT safe to ship after the gate version of it was defeated.
//
// The gate was defeated twice over — its refusal could be deleted with nothing
// going red, and its baseline was an exemption list editable in the same commit
// as the write it excused. Both mechanisms are gone. What has to be true now is
// narrower and checkable:
//
//   1. the review notes cannot suppress, add or reclassify a row
//   2. a damaged instrument refuses instead of reporting
//   3. the canary is wired to the exit code, and is not vacuous
//
// These are tests of the REPORT's honesty, not of the repository's security.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { expect, it } from 'vitest'

import { CANARY_CASES, calibrationFailures } from './credential-write-instrument-canary.mjs'
import {
  UNREVIEWED,
  annotate,
  loadReviewNotes,
  reviewNotesPath,
  unmatchedNoteKeys
} from './credential-write-review-notes.mjs'
import { REPO_ROOT } from './typescript-program-cache.mjs'

// Thin assert-style wrappers so each check reads as one line; vitest is the
// runner the repo's config/vitest.config.ts actually collects this file with.
const expect2eq = (actual, expected, message) => expect(actual, message).toBe(expected)
const expect2ne = (actual, expected, message) => expect(actual, message).not.toBe(expected)
const expect2deep = (actual, expected, message) => expect(actual, message).toEqual(expected)
const expect2match = (actual, pattern, message) => expect(actual, message).toMatch(pattern)
const expect2nomatch = (actual, pattern, message) => expect(actual, message).not.toMatch(pattern)
const expect2ok = (actual, message) => expect(Boolean(actual), message).toBe(true)

const REPORT = path.join(REPO_ROOT, 'config', 'scripts', 'report-credential-writes.mjs')

function runReport() {
  return JSON.parse(
    execFileSync(process.execPath, [REPORT, '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  )
}

function fakeSites() {
  return [
    { idSource: 'a.ts|f|fs:fs:writeFileSync|0', file: 'a.ts', line: 1 },
    { idSource: 'b.ts|g|fs:fs:writeFileSync|0', file: 'b.ts', line: 2 },
    { idSource: 'c.ts|h|fs:fs:writeFileSync|0', file: 'c.ts', line: 3 }
  ]
}

it('review notes cannot remove a site from the report', () => {
  const sites = fakeSites()
  // Every hostile shape a note could take: a matching key, an unknown verdict,
  // an empty verdict, and an entry for a site that does not exist.
  const notes = new Map([
    ['a.ts|f|fs:fs:writeFileSync|0', { verdict: 'deliberate-plaintext-interop', reason: 'x' }],
    ['b.ts|g|fs:fs:writeFileSync|0', { verdict: '', reason: '' }],
    ['ghost.ts|z|fs:fs:writeFileSync|0', { verdict: 'non-secret-payload', reason: 'y' }]
  ])
  const rows = annotate(sites, notes)
  expect2eq(rows.length, sites.length)
  expect2deep(
    rows.map((row) => row.idSource),
    sites.map((site) => site.idSource)
  )
})

it('a site with no note is reported as unreviewed, never dropped', () => {
  const rows = annotate(fakeSites(), new Map())
  expect2eq(rows.length, 3)
  for (const row of rows) {
    expect2eq(row.review.verdict, UNREVIEWED)
  }
})

it('an empty or missing notes file annotates nothing and hides nothing', () => {
  const missing = loadReviewNotes(path.join(REPO_ROOT, 'config', 'scripts', 'no-such-notes.json'))
  expect2eq(missing.notes.size, 0)
  expect2match(missing.problem, /unreviewed/)
  expect2eq(annotate(fakeSites(), missing.notes).length, 3)
})

it('a notes entry matching no live site is surfaced, not silently kept', () => {
  const notes = new Map([
    ['ghost.ts|z|fs:fs:writeFileSync|0', { verdict: 'non-secret-payload', reason: '' }]
  ])
  expect2deep(unmatchedNoteKeys(fakeSites(), notes), ['ghost.ts|z|fs:fs:writeFileSync|0'])
})

it('the committed review notes parse and carry the four unfixed findings', () => {
  const { notes, problem } = loadReviewNotes()
  expect2eq(problem, null)
  const unfixed = [...notes.values()].filter(
    (note) => note.verdict === 'cleartext-fallback-unfixed'
  )
  expect2eq(unfixed.length, 4)
  for (const note of unfixed) {
    expect2ok(note.reason.length > 0, 'every real finding must carry its reason')
  }
})

it('the canary runs every case and passes on the real pipeline', () => {
  const result = calibrationFailures()
  expect2eq(result.casesRun, CANARY_CASES.length)
  expect2ok(CANARY_CASES.length >= 20, 'a canary with few cases is not a canary')
  expect2deep(result.failures, [])
})

it('the canary is not vacuous — a wrong expected answer fails it', () => {
  const sabotaged = CANARY_CASES.map((testCase) =>
    testCase.id === 'plain-write' ? { ...testCase, writes: 99 } : testCase
  )
  const result = calibrationFailures(sabotaged)
  expect2ok(
    result.failures.some((failure) => failure.includes('plain-write')),
    'the canary must notice a case whose answer it cannot reproduce'
  )
})

// Why spawn the real binary: the point of the previous round's failure was that
// a check existed but nothing proved it reached the exit code. This asserts the
// process outcome, not a function's return value.
it('a damaged detector makes the report refuse, with a non-zero exit and no findings', () => {
  const target = path.join(REPO_ROOT, 'config', 'scripts', 'credential-secret-vocabulary.mjs')
  const original = fs.readFileSync(target, 'utf8')
  // Damage the instrument the way a weakening edit would: empty the vocabulary,
  // which makes every real site vanish and would otherwise read as "all clear".
  const damaged = original.replace(
    /const SECRET_WORDS = new Set\(\[[\s\S]*?\]\)/,
    'const SECRET_WORDS = new Set([])'
  )
  expect2ne(damaged, original, 'the damage pattern must actually apply')
  fs.writeFileSync(target, damaged)
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [REPORT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    status = error.status
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  } finally {
    fs.writeFileSync(target, original)
  }
  expect2eq(status, 1, 'a damaged instrument must exit non-zero')
  expect2match(output, /INSTRUMENT FAILURE/)
  expect2nomatch(output, /BY CLASSIFICATION/, 'a refused run must not publish counts')
  expect2nomatch(output, /cleartext-fallback-unfixed/, 'a refused run must not publish findings')
}, 120_000)

// One test, two subprocess runs: the report is ~12s per run, and this is the
// pair of facts that has to hold together — the printed totals account for
// every site, and emptying the annotation data changes none of them.
it('prints every site it finds, and emptying the review notes changes no site, only its label', () => {
  const notesFile = reviewNotesPath()
  const original = fs.readFileSync(notesFile, 'utf8')
  let before
  let after
  try {
    before = runReport()
    fs.writeFileSync(notesFile, `${JSON.stringify({ sites: {} }, null, 2)}\n`)
    after = runReport()
  } finally {
    fs.writeFileSync(notesFile, original)
  }

  expect2eq(before.kind, 'report')
  expect2eq(before.sites.length, before.totalSites)
  expect2eq(
    Object.values(before.counts).reduce((sum, count) => sum + count, 0),
    before.totalSites,
    'the summary must account for every site, with nothing filtered out of it'
  )
  expect2eq(
    before.sites.filter((site) => site.review.verdict === 'cleartext-fallback-unfixed').length,
    4
  )

  expect2eq(after.totalSites, before.totalSites, 'no note may remove a site')
  expect2deep(
    after.sites.map((site) => site.idSource),
    before.sites.map((site) => site.idSource)
  )
  expect2eq(
    after.counts[UNREVIEWED],
    after.totalSites,
    'with no notes, every site reads as unreviewed'
  )
}, 240_000)
