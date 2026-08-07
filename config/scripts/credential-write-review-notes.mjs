// The reviewed classifications, attached to the sites the analysis found.
//
// THIS DATA CANNOT SUPPRESS ANYTHING, AND THAT IS THE WHOLE POINT.
//
// The previous version of this data was a shrink-only baseline: a site listed
// in it stopped being reported, which made it an exemption list. Whoever added
// a credential write could add its exemption in the same commit, and no static
// check can tell a legitimate policy edit from a self-serving one, because the
// list IS the policy. So the mechanism is gone; only the knowledge is kept.
//
// `annotate` is a pure left join. It returns exactly the sites it was given, in
// the same order, each with a `review` field added. There is no filter, no
// predicate and no early `continue` anywhere in this module — the site list it
// returns is `===` in length to the site list it received, which
// report-credential-writes.mjs asserts before printing.
//
// The worst a hostile edit to the JSON can do is print a wrong REASON next to a
// site that is still printed, in full, with its file, line, sink and matched
// vocabulary. Deleting the file entirely makes every site print as
// `unreviewed`, which is louder than the truth, not quieter.

import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, displayPath } from './typescript-program-cache.mjs'

export const UNREVIEWED = 'unreviewed'

/** Verdicts the review used. Listed so the report can order and explain them;
 *  an unknown verdict in the JSON is passed through and rendered as-is rather
 *  than dropped, because dropping it would hide the annotation AND the site. */
export const VERDICT_ORDER = [
  'cleartext-fallback-unfixed',
  UNREVIEWED,
  'deliberate-plaintext-interop',
  'locally-minted-handshake-token',
  'fd-write-not-a-file',
  'orchestrator-forwarding',
  'encrypted-payload',
  'non-secret-payload'
]

export function reviewNotesPath() {
  return path.join(REPO_ROOT, 'config', 'scripts', 'credential-write-review-notes.json')
}

/** `{ notes: Map, problem }`. A missing or unparseable file is NOT an error —
 *  it just means nothing is annotated. `problem` is reported so the reader
 *  knows why every row says `unreviewed`. */
export function loadReviewNotes(notesPath = reviewNotesPath()) {
  const notes = new Map()
  if (!fs.existsSync(notesPath)) {
    return {
      notes,
      problem: `no review notes at ${displayPath(notesPath)} — every site is reported as unreviewed`
    }
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(notesPath, 'utf8'))
  } catch (error) {
    return {
      notes,
      problem: `${displayPath(notesPath)} is not valid JSON (${error.message}) — every site is reported as unreviewed`
    }
  }
  for (const [key, value] of Object.entries(parsed?.sites ?? {})) {
    notes.set(key, {
      verdict: typeof value?.verdict === 'string' && value.verdict ? value.verdict : UNREVIEWED,
      reason: typeof value?.reason === 'string' ? value.reason : ''
    })
  }
  return { notes, problem: null }
}

/** Left join of `sites` with the notes. One `.map` — same length, same order,
 *  every input site present in the output. */
export function annotate(sites, notes) {
  return sites.map((site) => ({
    ...site,
    review: notes.get(site.idSource) ?? { verdict: UNREVIEWED, reason: '' }
  }))
}

/** Note keys that matched no site in this run. Reported so the reader can see
 *  the review drifting from the code, rather than silently carrying knowledge
 *  about writes that no longer exist. */
export function unmatchedNoteKeys(sites, notes) {
  const live = new Set(sites.map((site) => site.idSource))
  return [...notes.keys()].filter((key) => !live.has(key)).sort()
}
