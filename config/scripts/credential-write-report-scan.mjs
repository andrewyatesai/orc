// Collecting every secret-named write site in the analysed tree, and the facts
// about how much of the tree was actually looked at.
//
// This module produces DATA. It reaches no verdict about whether the repository
// is acceptable, and it has no exit code — see report-credential-writes.mjs for
// what is done with the result, and for the boundary of what any of it means.
//
// The scoping decisions and their costs are inherited from the analysis-scope
// module: every non-test source file in the analysed directories is a Program
// root, and the only filter is the file-level write-reachability filter, which
// is computed from resolved import edges rather than from text.

import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript-api'

import { secrecySignals } from './credential-write-payload-shape.mjs'
import { buildSinkIndex } from './credential-write-sink-model.mjs'
import { resolvePolicyPredicates, sanctionedGuardFor } from './credential-write-policy-guard.mjs'
import { assignSiteIds } from './credential-write-site-identity.mjs'
import { findSinkEscapes } from './credential-write-sink-escapes.mjs'
import {
  analysedRootsOf,
  dependencyFirstOrder,
  excludedFilesReachingScope,
  isAnalysedPath,
  writeReachableFiles
} from './credential-write-analysis-scope.mjs'
import { discoverWriteCalls } from './credential-write-site-discovery.mjs'
import { javascriptProject, javascriptSourcesIn } from './credential-write-javascript-sources.mjs'
import {
  APP_PROJECT_IDS,
  REPO_ROOT,
  displayPath,
  getProjectScan,
  getScopedProject,
  normalizeProgramPath,
  scanImportGraph
} from './typescript-symbol-resolution.mjs'

export const ANALYSED_DIRS = ['src/main', 'src/cli', 'src/relay', 'src/preload', 'src/shared']

// Why only two of the five projects: tsconfig.node.json already lists main,
// preload, shared and relay, and tsconfig.cli.json lists cli — between them they
// cover every analysed directory, which `analysedFilesMissingFromProjects`
// re-derives on every run rather than trusting.
const ANALYSED_PROJECT_IDS = ['node', 'cli']

const FS_SPECIFIERS = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'original-fs',
  'node:original-fs',
  'graceful-fs',
  'fs-extra'
])
const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/

/** True when some non-test file transitively imports `filePath`. Uses the real
 *  resolved import graph, so "only tests use it" is derived rather than inferred
 *  from a filename convention. */
function reachedByProductionCode(filePath) {
  const key = normalizeProgramPath(filePath)
  const graphs = APP_PROJECT_IDS.map(getProjectScan)
    .filter((scan) => scan.fileKeys.has(key))
    .map(scanImportGraph)
  const seen = new Set([key])
  const queue = [key]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const graph of graphs) {
      for (const importer of graph.importersOf.get(current) ?? []) {
        if (seen.has(importer)) {
          continue
        }
        seen.add(importer)
        if (!TEST_FILE.test(graph.pathOf.get(importer) ?? importer)) {
          return true
        }
        queue.push(importer)
      }
    }
  }
  return false
}

/** Files OUTSIDE the analysed directories that import a filesystem module and
 *  are reachable from production code. These are writes this report does not
 *  look at; naming them is the honest form of the scope statement. */
export function unanalysedFilesystemImporters() {
  const suspects = []
  const seen = new Set()
  for (const id of APP_PROJECT_IDS) {
    for (const filePath of getProjectScan(id).fileNames) {
      const relative = displayPath(filePath)
      if (
        seen.has(relative) ||
        isAnalysedPath(filePath, ANALYSED_DIRS) ||
        TEST_FILE.test(relative)
      ) {
        continue
      }
      seen.add(relative)
      if (!relative.startsWith('src/')) {
        continue
      }
      let text
      try {
        text = fs.readFileSync(filePath, 'utf8')
      } catch {
        continue
      }
      // Every filesystem specifier contains the substring "fs", so a file whose
      // text does not cannot import one; this skips the scanner pass, not a file.
      if (!text.includes('fs')) {
        continue
      }
      const info = ts.preProcessFile(text, true, true)
      if (info.importedFiles.some((reference) => FS_SPECIFIERS.has(reference.fileName))) {
        suspects.push(filePath)
      }
    }
  }
  return suspects.filter(reachedByProductionCode).map(displayPath).sort()
}

/** Source files on disk in the analysed directories that no analysed Program
 *  holds — the files this report did not read at all.
 *
 *  Why `javascriptCovered` is the set the JavaScript Program actually WALKED and
 *  not the roots it was asked for: a damaged javascriptProject that builds an
 *  empty Program would otherwise still mark every .js file covered. */
export function analysedFilesMissingFromProjects(javascriptCovered) {
  const covered = new Set()
  for (const id of ANALYSED_PROJECT_IDS) {
    for (const key of getProjectScan(id).fileKeys) {
      covered.add(key)
    }
  }
  for (const key of javascriptCovered) {
    covered.add(normalizeProgramPath(key))
  }
  const missing = []
  for (const dir of ANALYSED_DIRS) {
    const stack = [path.join(REPO_ROOT, dir)]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!fs.existsSync(current)) {
        continue
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__snapshots__') {
            stack.push(child)
          }
        } else if (
          isAnalysedPath(child, ANALYSED_DIRS) &&
          /\.([cm]?tsx?|[cm]?jsx?)$/.test(entry.name) &&
          !covered.has(normalizeProgramPath(child))
        ) {
          missing.push(displayPath(child))
        }
      }
    }
  }
  return missing.sort()
}

/** The ONE place the escape detector is wired in. `scanned` is counted inside
 *  the loop so "did not look" cannot report as "nothing captured". */
function scanSinkEscapes(project, sourceFiles, sinks) {
  const escapes = []
  let scanned = 0
  for (const sourceFile of sourceFiles) {
    escapes.push(...findSinkEscapes(project, sourceFile, sinks))
    scanned += 1
  }
  return { escapes, escapeFiles: scanned }
}

function collectSites(project, classified, reportKeys, predicates, projectId) {
  const perFile = new Map()
  for (const [call, result] of classified) {
    const sourceFile = call.getSourceFile()
    const key = normalizeProgramPath(sourceFile.fileName)
    if (!reportKeys.has(key)) {
      continue
    }
    const signals = secrecySignals(project, call, result.sink)
    if (signals.length === 0) {
      continue
    }
    let bucket = perFile.get(key)
    if (!bucket) {
      bucket = []
      perFile.set(key, bucket)
    }
    bucket.push({
      call,
      sink: result.sink,
      signals,
      guard: sanctionedGuardFor(project, call, predicates)?.entry ?? null,
      projectId
    })
  }
  const sites = []
  for (const key of [...perFile.keys()].sort()) {
    sites.push(...perFile.get(key).sort((a, b) => a.call.getStart() - b.call.getStart()))
  }
  return assignSiteIds(sites)
}

/** Turns each site into a plain record. The AST node is dropped here so nothing
 *  downstream can re-derive a different answer from it. */
function siteRecords(sites) {
  return sites.map((site) => {
    const position = site.call.getSourceFile().getLineAndCharacterOfPosition(site.call.getStart())
    return {
      id: site.id,
      idSource: site.idSource,
      file: site.file,
      line: position.line + 1,
      scope: site.scope,
      sinkId: site.sinkId,
      projectId: site.projectId,
      guard: site.guard ? `${site.guard.module}#${site.guard.name}` : null,
      words: [...new Set(site.signals.flatMap((signal) => signal.words))].sort(),
      where: [...new Set(site.signals.map((signal) => signal.where))].sort()
    }
  })
}

/** One TypeScript project: roots are every analysed file, the reachability
 *  filter narrows only which of them are walked, and both counts are reported
 *  so a shrinking analysis is visible in the output. */
function analyseProject(id) {
  const started = performance.now()
  const scan = getProjectScan(id)
  const roots = analysedRootsOf(scan, ANALYSED_DIRS)
  if (roots.length === 0) {
    return { id, sites: [], escapes: [], caveats: [], roots: 0, walked: 0, ms: 0 }
  }
  const project = getScopedProject(id, roots)
  const programMs = performance.now() - started

  const probe = buildSinkIndex(project)
  const { reachable, importsOf } = writeReachableFiles(project, probe)
  const caveats = []
  const strays = excludedFilesReachingScope(project, roots, reachable)
  if (strays.length > 0) {
    caveats.push(
      `${strays.length} file(s) the write-reachability filter excluded do import something it included, so this project's walk skipped files it should have read:\n    ${strays.slice(0, 10).join('\n    ')}`
    )
  }

  const sinks = buildSinkIndex(project, { reachableFiles: reachable })
  const predicates = resolvePolicyPredicates(project)
  const walkKeys = new Set()
  for (const sourceFile of project.program.getSourceFiles()) {
    const key = normalizeProgramPath(sourceFile.fileName)
    if (!sourceFile.isDeclarationFile && reachable.has(key)) {
      walkKeys.add(key)
    }
  }
  const found = discoverWriteCalls(project, sinks, dependencyFirstOrder(walkKeys, importsOf))

  const reportKeys = new Set(roots.map(normalizeProgramPath).filter((key) => walkKeys.has(key)))
  const sites = collectSites(project, found.classified, reportKeys, predicates, id)
  const reportedFiles = project.program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile && reportKeys.has(normalizeProgramPath(sourceFile.fileName))
    )
  const { escapes, escapeFiles } = scanSinkEscapes(project, reportedFiles, sinks)

  return {
    id,
    sites: siteRecords(sites),
    escapes,
    escapeFiles,
    caveats,
    sinks,
    predicates,
    depthLimited: [...sinks.depthLimited],
    roots: roots.length,
    walked: reportKeys.size,
    calls: found.totalCalls,
    programMs: Math.round(programMs),
    ms: Math.round(performance.now() - started)
  }
}

/** The JavaScript sources under the analysed directories, in their own allowJs
 *  Program. No reachability filter: the set is tiny, so it is walked
 *  exhaustively. */
function analyseJavaScript() {
  const started = performance.now()
  const roots = javascriptSourcesIn(ANALYSED_DIRS)
  const project = javascriptProject(roots)
  if (!project) {
    return {
      id: 'analysed-javascript',
      sites: [],
      escapes: [],
      caveats: [],
      roots: 0,
      walked: 0,
      ms: 0
    }
  }
  const sinks = buildSinkIndex(project)
  const predicates = resolvePolicyPredicates(project)
  const reportKeys = new Set(roots.map(normalizeProgramPath))
  const discovered = discoverWriteCalls(project, sinks, [...reportKeys])
  const sites = collectSites(
    project,
    discovered.classified,
    reportKeys,
    predicates,
    'analysed-javascript'
  )
  const { escapes, escapeFiles } = scanSinkEscapes(
    project,
    project.program
      .getSourceFiles()
      .filter((file) => reportKeys.has(normalizeProgramPath(file.fileName))),
    sinks
  )
  return {
    id: 'analysed-javascript',
    sites: siteRecords(sites),
    escapes,
    escapeFiles,
    caveats: [],
    sinks,
    depthLimited: [...sinks.depthLimited],
    // A predicate module is TypeScript, so an unresolved one here is expected
    // and says nothing about the instrument; only sink resolution matters.
    predicates: { resolved: predicates.resolved, missing: [] },
    roots: roots.length,
    walked: roots.length,
    calls: discovered.totalCalls,
    ms: Math.round(performance.now() - started)
  }
}

/** Facts about the instrument itself. These are REPORTED, not enforced: each
 *  one means the site list below it is incomplete in a specific, named way, and
 *  the reader is told so rather than shown a green light. */
function instrumentCaveats(results) {
  const caveats = []
  const resolvedAnywhere = new Set(
    results.flatMap((result) => [
      ...[...(result.sinks?.byDeclaration.values() ?? [])].map(
        (sink) => `${sink.origin}#${sink.name}`
      ),
      ...(result.predicates?.resolved ?? []).map((entry) => `${entry.module}#${entry.name}`)
    ])
  )
  const baseSinkResolvedAnywhere = new Set(
    results.flatMap((result) =>
      (result.sinks?.baseSinkResolution ?? [])
        .filter((entry) => entry.resolved)
        .map((entry) => entry.label)
    )
  )
  for (const result of results) {
    // Why per project and not in aggregate: the escape detector was once wired
    // out of exactly one project, and a project-wide zero read the same as
    // "nothing captured". "Did not look" must not look like "nothing there".
    if (result.walked > 0 && (result.escapeFiles ?? 0) === 0) {
      caveats.push(
        `the ${result.id} project walked ${result.walked} file(s) but ran the sink-escape detector over none of them — a sink captured as a value there is invisible to this report`
      )
    }
    for (const label of result.sinks?.unresolvedBaseSinks ?? []) {
      if (!baseSinkResolvedAnywhere.has(label)) {
        caveats.push(
          `write sink ${label} did not resolve in any analysed project — writes through it are NOT in the site list`
        )
      }
    }
    for (const seed of result.sinks?.missingSeeds ?? []) {
      const label = `${seed.module}#${seed.member ?? seed.name}`
      if (!resolvedAnywhere.has(label)) {
        caveats.push(
          `seeded write entry point ${label} no longer resolves — writes through it are NOT in the site list`
        )
      }
    }
    for (const missing of result.predicates?.missing ?? []) {
      if (!resolvedAnywhere.has(`${missing.module}#${missing.name}`)) {
        caveats.push(
          `plaintext-policy predicate ${missing.module}#${missing.name} no longer resolves (${missing.reason}) — writes it guards are reported as ungated`
        )
      }
    }
    caveats.push(...(result.caveats ?? []))
  }
  // Why a count and not the list: the bound is hit by any four-deep call chain,
  // so most entries are ordinary code with no write anywhere in them. The tool
  // cannot tell which are which, which is exactly what the reader needs told.
  // The names are in --json for anyone who wants to audit them.
  const truncated = results.reduce((sum, result) => sum + (result.depthLimited ?? []).length, 0)
  if (truncated > 0) {
    caveats.push(
      `${truncated} call chain(s) were cut off at the wrapper-following depth bound (4). Most are ordinary deep call chains containing no write at all, but a write below one of them would NOT be in the site list, and this tool cannot tell the two apart. Names are in --json under depthLimitedChains.`
    )
  }
  if (!results.some((result) => (result.predicates?.resolved ?? []).length > 0)) {
    caveats.push(
      'no plaintext-policy predicate resolved in any project — the guard column below is meaningless, every write will read as ungated'
    )
  }
  return [...new Set(caveats)]
}

/** Every secret-named write site in the analysed directories, plus the coverage
 *  and instrument facts needed to read the list honestly. */
export function scanCredentialWrites() {
  const started = performance.now()
  const javascriptRoots = javascriptSourcesIn(ANALYSED_DIRS)
  const results = [...ANALYSED_PROJECT_IDS.map(analyseProject), analyseJavaScript()]

  const byId = new Map()
  for (const result of results) {
    for (const site of result.sites) {
      const existing = byId.get(site.id)
      // A file in several tsconfigs is analysed several times; keep the run that
      // found a guard so a shared module is not reported twice.
      if (!existing || (!existing.guard && site.guard)) {
        byId.set(site.id, site)
      }
    }
  }

  return {
    sites: [...byId.values()].sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.idSource.localeCompare(b.idSource)
    ),
    escapes: results.flatMap((result) => result.escapes),
    caveats: instrumentCaveats(results),
    unreadFiles: analysedFilesMissingFromProjects(javascriptRoots),
    outOfScopeWriters: unanalysedFilesystemImporters(),
    depthLimitedChains: [...new Set(results.flatMap((result) => result.depthLimited ?? []))].sort(),
    projects: results.map((result) => ({
      id: result.id,
      roots: result.roots,
      walked: result.walked,
      calls: result.calls,
      ms: result.ms
    })),
    analysedDirs: ANALYSED_DIRS,
    elapsedMs: Math.round(performance.now() - started)
  }
}
