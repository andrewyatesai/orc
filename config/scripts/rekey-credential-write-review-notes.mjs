#!/usr/bin/env node
// RECONCILE DETACHED REVIEW NOTES — the deliberate half of the join.
//
// Site ids are derived from the code (file + enclosing functions + sink + the
// call's shape), so they are stable across the edits that used to churn them.
// They are not stable across every edit, and they never can be: rename the
// function that performs the write, change the payload's shape, or replace the
// wrapper it writes through, and the site is honestly a different site. The
// carried review then matches nothing, the report prints it under ORPHANED
// REVIEW NOTES, and the write it judged goes back to reading `unreviewed`.
//
// This tool proposes the reattachment and — only with --apply — performs it. It
// never invents, edits or deletes a verdict; it moves an existing note from one
// key to another, and prints every move it makes. What it cannot prove, it
// leaves for a human, because "which write does this review describe" is a
// review question, not a text-matching question.
//
// It pairs an orphaned note with an unreviewed site only inside a group where
// the counts match exactly, trying the narrowest evidence first:
//   1. same file, same enclosing function, same sink
//   2. same file, same enclosing function
//   3. same file, same sink
//   4. same file, and exactly one candidate on each side
// Within a group the pairing is by source order, which is what the retired
// ordinal in an old key meant.
//
// Usage: node config/scripts/rekey-credential-write-review-notes.mjs [--apply]

import fs from 'node:fs'

import { loadReviewNotes, reviewNotesPath } from './credential-write-review-notes.mjs'
import { scanCredentialWrites } from './credential-write-report-scan.mjs'

const TAG = '[rekey]'

const TIERS = [
  {
    name: 'same function + sink',
    of: (item) => `${item.file}|${item.scope}|${item.sinkId}`
  },
  { name: 'same function', of: (item) => `${item.file}|${item.scope}` },
  { name: 'same sink', of: (item) => `${item.file}|${item.sinkId}` },
  { name: 'same file', of: (item) => item.file, requireSingleton: true }
]

/** An old key's trailing `|<n>` was its position among identical siblings; a new
 *  key's `~<n>` is the same thing. Either way it is how a group is ordered. */
function legacyOrdinal(key) {
  const match = /(?:\||~)(\d+)$/.exec(key)
  return match ? Number(match[1]) : 0
}

function keyParts(key) {
  const [file = '', scope = '', sinkId = ''] = key.split('|')
  return { file, scope, sinkId, key }
}

function groupBy(items, of) {
  const groups = new Map()
  for (const item of items) {
    const groupKey = of(item)
    const bucket = groups.get(groupKey)
    if (bucket) {
      bucket.push(item)
    } else {
      groups.set(groupKey, [item])
    }
  }
  return groups
}

/** One tier of evidence. Consumes the pairs it proves and returns the rest. */
function pairTier(tier, orphans, sites) {
  const proposals = []
  const siteGroups = groupBy(sites, tier.of)
  const takenNotes = new Set()
  const takenSites = new Set()
  for (const [groupKey, notesInGroup] of groupBy(orphans, tier.of)) {
    const sitesInGroup = siteGroups.get(groupKey) ?? []
    if (sitesInGroup.length !== notesInGroup.length) {
      continue
    }
    if (tier.requireSingleton && sitesInGroup.length !== 1) {
      continue
    }
    const orderedNotes = [...notesInGroup].sort(
      (a, b) => legacyOrdinal(a.key) - legacyOrdinal(b.key) || a.key.localeCompare(b.key)
    )
    const orderedSites = [...sitesInGroup].sort((a, b) => a.line - b.line)
    orderedNotes.forEach((note, index) => {
      const site = orderedSites[index]
      takenNotes.add(note.key)
      takenSites.add(site.idSource)
      proposals.push({
        from: note.key,
        to: site.idSource,
        site,
        tier: tier.name
      })
    })
  }
  return {
    proposals,
    orphans: orphans.filter((note) => !takenNotes.has(note.key)),
    sites: sites.filter((site) => !takenSites.has(site.idSource))
  }
}

function plan(orphanKeys, unreviewedSites) {
  let orphans = orphanKeys.map(keyParts)
  let sites = unreviewedSites
  const proposals = []
  for (const tier of TIERS) {
    const round = pairTier(tier, orphans, sites)
    proposals.push(...round.proposals)
    orphans = round.orphans
    sites = round.sites
  }
  return { proposals, unresolved: orphans }
}

function applyPlan(proposals) {
  const notesPath = reviewNotesPath()
  const parsed = JSON.parse(fs.readFileSync(notesPath, 'utf8'))
  for (const proposal of proposals) {
    const note = parsed.sites[proposal.from]
    if (!note) {
      throw new Error(`${proposal.from} is no longer in the notes file`)
    }
    if (parsed.sites[proposal.to]) {
      throw new Error(`${proposal.to} already carries a note; refusing to overwrite it`)
    }
    delete parsed.sites[proposal.from]
    parsed.sites[proposal.to] = note
  }
  parsed.sites = Object.fromEntries(
    Object.entries(parsed.sites).sort(([a], [b]) => a.localeCompare(b))
  )
  fs.writeFileSync(notesPath, `${JSON.stringify(parsed, null, 2)}\n`)
  return notesPath
}

function main() {
  const wantsApply = process.argv.slice(2).includes('--apply')
  const scan = scanCredentialWrites()
  const { notes, problem } = loadReviewNotes()
  if (problem) {
    console.error(`${TAG} ${problem}`)
    return 1
  }

  const live = new Set(scan.sites.map((site) => site.idSource))
  const orphanKeys = [...notes.keys()].filter((key) => !live.has(key)).sort()
  const unreviewed = scan.sites.filter((site) => !notes.has(site.idSource))
  console.log(
    `${TAG} ${notes.size} note(s), ${scan.sites.length} site(s) — ${orphanKeys.length} orphaned note(s), ${unreviewed.length} site(s) with no note`
  )
  if (orphanKeys.length === 0) {
    console.log(`${TAG} nothing to reconcile.`)
    return 0
  }

  const { proposals, unresolved } = plan(orphanKeys, unreviewed)
  for (const proposal of proposals) {
    console.log(
      `\n  ${proposal.from}\n  -> ${proposal.to}\n     ${proposal.site.file}:${proposal.site.line}  (${proposal.tier})`
    )
  }
  if (unresolved.length > 0) {
    console.log(
      `\n  UNRESOLVED (${unresolved.length}) — no unambiguous site. Re-key by hand, or move the note into\n  "retired" with a retiredBecause explaining where the judgement went:`
    )
    for (const note of unresolved) {
      console.log(`    ${note.key}`)
    }
  }

  if (!wantsApply) {
    console.log(
      `\n${TAG} proposal only — nothing was written. Re-run with --apply to move ${proposals.length} note(s).`
    )
    return 0
  }
  if (proposals.length === 0) {
    console.log(`\n${TAG} nothing could be proved; the notes file is unchanged.`)
    return 0
  }
  const written = applyPlan(proposals)
  console.log(`\n${TAG} moved ${proposals.length} note(s) in ${written}.`)
  return 0
}

process.exitCode = main()
