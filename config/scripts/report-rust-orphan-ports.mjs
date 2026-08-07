#!/usr/bin/env node
// report:rust-orphans — ported modules for which NO production dispatch into the
// Rust core could be resolved.
//
// THIS IS A REPORT, NOT A GATE. It is deliberately not in the lint chain and it
// has no pass/fail verdict about the code. Exit 0 means the report was produced;
// exit 1 means it could NOT be produced (the instrument is broken or the
// candidate set is unreadable) and the output is not to be trusted.
//
// WHY THE ORPHAN DIRECTION AND ONLY THE ORPHAN DIRECTION
// An earlier version of this analysis printed "N modules ship". That number was
// defeated: damaging the summariser IMPROVED it, a type-level argument plus a
// ledger edit minted a claim, and the ledger and seam catalog it rested on were
// hand-maintained manifests editable in the same change as the claim they
// supported. The count, the ledger, the seam-catalog artifact anchor and the
// corpus/adapter door bindings are deleted; nothing in this report replaces them.
//
// What survives is the direction that fails safe. To falsely appear orphaned, a
// module's real dispatch would have to be REMOVED from production source — a
// production change, not a manifest edit. The forgeries that work here all push
// the other way: they ADD entries to this list, which costs a reader review time
// and mints no claim of merit for anyone.

import { pathToFileURL } from 'node:url'

import { scanDispatchSites } from './rust-dispatch-site-scan.mjs'
import { DECLARED_DISPATCH_DOORS } from './rust-dispatch-keyed-doors.mjs'
import { loadPortedModuleRoster, portedModuleEvidence } from './rust-port-vector-roster.mjs'
import { uncoveredSourceFiles } from './typescript-symbol-resolution.mjs'

const PREAMBLE = `WHAT THIS REPORT SAYS
  For every module in the parity vector corpus, whether any production
  TypeScript under src/ contains a type-checker-resolved reference to a declared
  Rust dispatch door whose module-key argument is a genuine string-literal node
  naming that module. A module with no such site is listed as an ORPHAN
  CANDIDATE: a candidate for review, nothing more.

WHAT "NO DISPATCH RESOLVED" DOES NOT MEAN
  It does NOT mean provably dead code. A real dispatch is invisible to this
  analysis when it goes through:
    * a runtime-computed module key (a variable, a concatenation, a lookup);
    * eval / new Function / globalThis[name] / a monkey-patched namespace;
    * indirection through a value - a door stored in a variable and called later;
    * a per-function Rust door, which carries a function name and no module key,
      so no production source says which ported module it serves;
    * a source file no project's tsconfig includes.
  Every instance of the first, third and fourth that this run found is listed
  under UNRESOLVABLE DISPATCH below, and the fifth under UNANALYSED FILES. Those
  sections QUALIFY the orphan list; they are not counted as orphans.

WHAT A RESOLVED DISPATCH DOES NOT MEAN EITHER
  It is a site in the SOURCE. It does not prove the call executes: an exported
  function nothing ever calls still counts. This report does no intra-file or
  whole-program reachability, so a module can be absent from the orphan list
  while its Rust is never actually run.

INPUTS THIS REPORT DECLARES RATHER THAN VERIFIES
  * the candidate set is one entry per tools/parity/vectors/*.json, named by that
    file's declared "module" field and falling back to its filename. Two vectors
    declaring one name is refused rather than silently collapsed, because that
    would drop a candidate with both files still on disk;
  * the dispatch doors are the hand-maintained list in
    config/scripts/rust-dispatch-keyed-doors.mjs, printed in full below.
  Both are editable in the same change as the code they describe. Deleting from
  either HIDES an orphan; adding to either ADDS one. Nothing here detects that.

EXIT CODE
  0 = the report was produced. It is not a pass and asserts nothing about the code.
  1 = the report could not be produced. It is not a failure of the code.`

function formatDoorInventory(surfaces) {
  const byDoor = new Map()
  for (const surface of surfaces) {
    const existing = byDoor.get(surface.door.id) ?? { surface, projects: new Set() }
    existing.projects.add(surface.projectId)
    byDoor.set(surface.door.id, existing)
  }
  const lines = []
  for (const door of DECLARED_DISPATCH_DOORS) {
    const found = byDoor.get(door.id)
    if (!found) {
      lines.push(
        `  ${door.id.padEnd(24)} NOT PRESENT in any project's import graph — nothing traced through it`
      )
      continue
    }
    const { surface, projects } = found
    const keyed = [...surface.keyed.values()].sort()
    lines.push(
      `  ${door.id.padEnd(24)} ${surface.displayModule}\n` +
        `  ${''.padEnd(24)} keyed doors: ${keyed.length > 0 ? keyed.join(', ') : '(none)'}` +
        `; per-function doors: ${surface.perFunction.size}` +
        `; projects: ${[...projects].sort().join(', ')}`
    )
  }
  return lines.join('\n')
}

function groupBy(items, keyOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

function formatUnresolvable(unresolvable, verbose) {
  if (unresolvable.length === 0) {
    return '  none found. That is not proof there are none — see the list of shapes above.'
  }
  const lines = []
  for (const [kind, items] of [...groupBy(unresolvable, (item) => item.kind)].sort()) {
    lines.push(`  ${kind} (${items.length})`)
    const shown = verbose ? items : items.slice(0, 6)
    for (const item of shown) {
      lines.push(`    ${item.location}  ${item.door}`)
      if (item.detail && verbose) {
        lines.push(`      ${item.detail}`)
      }
    }
    if (shown.length < items.length) {
      lines.push(`    … ${items.length - shown.length} more (pass --verbose)`)
    }
  }
  return lines.join('\n')
}

function formatOrphan(module) {
  const rust = module.rust.file
    ? `${module.rust.file} (${module.rust.lines} lines)`
    : `rust source not located: ${module.rust.reason}`
  const twin =
    module.twin.count === null
      ? `ts twin: ${module.tsSource ?? 'not named by the vector'} (not resolved)`
      : `ts twin: ${module.tsSource} — ${module.twin.count} production importer${module.twin.count === 1 ? '' : 's'}`
  const lines = [`  ${module.name}`, `      rust: ${rust}`, `      ${twin}`]
  if (module.specMarker) {
    lines.push(
      `      self-declared spec: "${module.specMarker.text}"`,
      `        at ${module.specMarker.location}. A text marker in a Rust doc comment, quoted so you can`,
      '        judge it. Nothing here distinguishes a genuine spec crate from an abandoned port that had',
      '        the sentence added, so this module stays on the list.'
    )
  }
  return lines.join('\n')
}

function orphanSortKey(module) {
  return [-(module.twin.count ?? 0), -(module.rust.lines ?? 0), module.name]
}

function compareOrphans(a, b) {
  const left = orphanSortKey(a)
  const right = orphanSortKey(b)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1
    }
  }
  return 0
}

/** Builds the whole report as data, so the formatter and any test read one
 *  object and the text can never drift from what was measured. */
export function buildOrphanReport({ projectIds } = {}) {
  const roster = loadPortedModuleRoster()
  const scan = scanDispatchSites(projectIds ? { projectIds } : undefined)

  const resolvedByModule = new Map()
  const unknownKeys = new Map()
  for (const site of scan.resolved) {
    if (!roster.has(site.moduleKey)) {
      unknownKeys.set(site.moduleKey, [...(unknownKeys.get(site.moduleKey) ?? []), site.location])
      continue
    }
    resolvedByModule.set(site.moduleKey, [...(resolvedByModule.get(site.moduleKey) ?? []), site])
  }

  const orphans = []
  const dispatched = []
  for (const entry of roster.values()) {
    const sites = resolvedByModule.get(entry.name)
    if (sites) {
      dispatched.push({ name: entry.name, sites })
      continue
    }
    orphans.push(portedModuleEvidence(entry))
  }
  orphans.sort(compareOrphans)
  dispatched.sort((a, b) => a.name.localeCompare(b.name))

  return {
    orphans,
    dispatched,
    unknownKeys,
    unresolvable: scan.unresolvable,
    surfaces: scan.surfaces,
    uncovered: uncoveredSourceFiles(),
    rosterSize: roster.size,
    elapsedMs: scan.elapsedMs
  }
}

function render(report, { verbose }) {
  const out = []
  out.push('rust orphan-port report — ported modules with no resolvable production dispatch')
  out.push('')
  out.push(PREAMBLE)
  out.push('')
  out.push(`DISPATCH DOORS TRACED (declared input, ${DECLARED_DISPATCH_DOORS.length} entries)`)
  out.push(formatDoorInventory(report.surfaces))
  out.push('')
  out.push('UNRESOLVABLE DISPATCH — these qualify every entry in the orphan list below')
  out.push(formatUnresolvable(report.unresolvable, verbose))
  out.push('')
  out.push('UNANALYSED FILES — under src/, in no project file list, so never searched')
  out.push(
    report.uncovered.length === 0
      ? '  none.'
      : report.uncovered.map((file) => `  ${file}`).join('\n')
  )
  out.push('')
  if (report.unknownKeys.size > 0) {
    out.push('DISPATCHED KEYS THAT NAME NO CANDIDATE MODULE')
    for (const [key, locations] of [...report.unknownKeys].sort()) {
      out.push(`  '${key}' dispatched at ${locations.slice(0, 3).join(', ')}`)
    }
    out.push('')
  }
  out.push(
    `ORPHAN CANDIDATES — ${report.orphans.length} of ${report.rosterSize} candidate modules, ` +
      'sorted by production importers of the TypeScript twin'
  )
  out.push(
    '  Each is a CANDIDATE FOR REVIEW: no dispatch resolved, which is not proof none exists.'
  )
  out.push('')
  out.push(report.orphans.map(formatOrphan).join('\n'))
  out.push('')
  out.push('MODULES EXCLUDED — a dispatch call naming this key resolved at this location')
  out.push('  Not a claim that the port is complete, correct, or ever executed at runtime.')
  for (const entry of report.dispatched) {
    const locations = verbose ? entry.sites : entry.sites.slice(0, 2)
    const elided = entry.sites.length - locations.length
    const shown = locations.map((site) => site.location).join(', ')
    out.push(`  ${entry.name.padEnd(34)} ${shown}${elided > 0 ? `, +${elided} more` : ''}`)
  }
  out.push('')
  out.push(`scanned in ${Math.round(report.elapsedMs)}ms`)
  return out.join('\n')
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${PREAMBLE}\n`)
    return 0
  }
  let report
  try {
    report = buildOrphanReport()
  } catch (error) {
    process.stderr.write(
      `report:rust-orphans could not run, so NOTHING is reported about the code: ${error.message}\n`
    )
    return 1
  }
  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          // Why: a machine consumer never sees the printed preamble, so the epistemics travel with the data.
          whatThisDoesNotVerify: PREAMBLE,
          orphanCandidates: report.orphans,
          excludedByResolvedDispatch: report.dispatched,
          unresolvableDispatch: report.unresolvable,
          unanalysedFiles: report.uncovered,
          dispatchedKeysNamingNoCandidate: Object.fromEntries(report.unknownKeys),
          candidateModules: report.rosterSize
        },
        null,
        2
      )}\n`
    )
    return 0
  }
  process.stdout.write(`${render(report, { verbose: argv.includes('--verbose') })}\n`)
  return 0
}

// Why: `file://${argv[1]}` mangles Windows drive paths; pathToFileURL is the portable form.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
