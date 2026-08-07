// Which files can possibly name a given module's exports — computed with the
// scanner, before any Program exists.
//
// In ESM a symbol can only arrive through an import chain. So: seed the target
// module, close over the modules that genuinely re-export it, and take the
// files importing anything in that closure. Everything else provably cannot
// hold a reference, which is what lets the gates build a Program rooted at ~10
// files instead of ~5000 (0.2s / 0.3GB instead of 3s / 1.5GB).
//
// The closure is computed from real module resolution, not from specifier text,
// and re-export detection parses the candidate file — a `// export { x } from
// './seam'` comment creates no edge.

import fs from 'node:fs'

import ts from 'typescript-api'

import {
  displayPath,
  getProjectScan,
  getScopedProject,
  normalizeProgramPath
} from './typescript-program-cache.mjs'
import {
  referenceMatchesTarget,
  resolveComputedMember,
  resolveReference
} from './typescript-symbol-identity.mjs'

const graphCache = new Map()
const preProcessCache = new Map()

function scanSpecifiers(filePath) {
  const cached = preProcessCache.get(filePath)
  if (cached) {
    return cached
  }
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const info = ts.preProcessFile(text, true, true)
  const specifiers = info.importedFiles.map((reference) => reference.fileName)
  preProcessCache.set(filePath, specifiers)
  return specifiers
}

function isRepoInternal(key) {
  return !key.includes('/node_modules/')
}

/** Import graph over every repo-internal module this project can see, keyed by
 *  resolved absolute path. Cached per project. ~0.6s for the largest project;
 *  no Program and no checker involved. */
export function scanImportGraph(scan) {
  const cached = graphCache.get(scan.id)
  if (cached) {
    return cached
  }
  const started = performance.now()
  const importersOf = new Map()
  const importsOf = new Map()
  // Keys are case-folded for comparison; the real path is kept because a
  // case-insensitive host still needs the on-disk spelling to read the file.
  const pathOf = new Map()
  const queue = [...scan.fileNames]
  const seen = new Set()

  while (queue.length > 0) {
    const filePath = queue.pop()
    const key = normalizeProgramPath(filePath)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    pathOf.set(key, filePath)
    const targets = new Set()
    for (const specifier of scanSpecifiers(filePath)) {
      const resolved = scan.resolveModule(specifier, filePath)
      if (!resolved) {
        continue
      }
      targets.add(resolved.key)
      pathOf.set(resolved.key, resolved.path)
      let importers = importersOf.get(resolved.key)
      if (!importers) {
        importers = new Set()
        importersOf.set(resolved.key, importers)
      }
      importers.add(key)
      // Follow repo-internal edges so a barrel outside the tsconfig file list is
      // still known to launder — otherwise the closure would miss it.
      if (isRepoInternal(resolved.key) && !seen.has(resolved.key)) {
        queue.push(resolved.path)
      }
    }
    importsOf.set(key, targets)
  }

  const graph = {
    scanId: scan.id,
    importersOf,
    importsOf,
    pathOf,
    scannedFiles: seen,
    buildMs: performance.now() - started
  }
  graphCache.set(scan.id, graph)
  return graph
}

function importBindingSources(sourceFile, scan, filePath) {
  const bindings = new Map()
  const record = (name, specifier) => {
    const resolved = scan.resolveModule(specifier, filePath)
    if (resolved) {
      bindings.set(name, resolved.key)
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (!clause) {
      continue
    }
    if (clause.name) {
      record(clause.name.text, specifier)
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        record(clause.namedBindings.name.text, specifier)
      } else {
        for (const element of clause.namedBindings.elements) {
          record(element.name.text, specifier)
        }
      }
    }
  }
  return bindings
}

/** True when this file re-exports a binding that originates in `launder` —
 *  either `export … from 'laundered'` or `export { local }` where `local` is an
 *  import binding from a laundered module. Both preserve symbol identity, so
 *  both must extend the closure. */
function reexportsFrom(filePath, scan, launder) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return false
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  )
  let bindings

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const resolved = scan.resolveModule(statement.moduleSpecifier.text, filePath)
        if (resolved && launder.has(resolved.key)) {
          return true
        }
        continue
      }
      bindings ??= importBindingSources(sourceFile, scan, filePath)
      const elements =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
          : []
      for (const element of elements) {
        const local = (element.propertyName ?? element.name).text
        if (launder.has(bindings.get(local))) {
          return true
        }
      }
      continue
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      bindings ??= importBindingSources(sourceFile, scan, filePath)
      if (launder.has(bindings.get(statement.expression.text))) {
        return true
      }
    }
  }
  return false
}

/** The modules whose exports are identity-preserving re-exports of moduleKey,
 *  plus moduleKey itself. Only importers of an already-laundered module are
 *  parsed, so this touches a handful of files. */
export function laundererClosure(scan, graph, moduleKey) {
  const launder = new Set([moduleKey])
  const frontier = [moduleKey]
  while (frontier.length > 0) {
    const current = frontier.pop()
    for (const importer of graph.importersOf.get(current) ?? []) {
      if (launder.has(importer)) {
        continue
      }
      if (reexportsFrom(graph.pathOf.get(importer) ?? importer, scan, launder)) {
        launder.add(importer)
        frontier.push(importer)
      }
    }
  }
  return launder
}

/** Every file in this project that could hold a reference to moduleKey's
 *  exports. Sound modulo the documented non-goals (globals, eval, runtime
 *  namespace patching) — a file with no import edge into the laundering closure
 *  cannot name the symbol. */
export function candidateFilesFor(scan, moduleKey) {
  const graph = scanImportGraph(scan)
  const launder = laundererClosure(scan, graph, moduleKey)
  const candidateKeys = new Set()
  for (const laundered of launder) {
    if (graph.scannedFiles.has(laundered)) {
      candidateKeys.add(laundered)
    }
    for (const importer of graph.importersOf.get(laundered) ?? []) {
      candidateKeys.add(importer)
    }
  }
  const candidates = [...candidateKeys].sort().map((key) => graph.pathOf.get(key) ?? key)
  return { candidates, candidateKeys, launderedModules: launder, graph }
}

/** Opens a scoped Program per project over exactly the files that can reference
 *  the module. Projects with no candidate file are skipped. This is the entry
 *  point a gate should use. */
export function openModuleScope(moduleFile, projectIds) {
  const moduleKey = normalizeProgramPath(moduleFile)
  const scopes = []
  for (const id of projectIds) {
    const scan = getProjectScan(id)
    const { candidates, launderedModules } = candidateFilesFor(scan, moduleKey)
    if (candidates.length === 0) {
      continue
    }
    const project = getScopedProject(id, candidates)
    if (project) {
      scopes.push({ project, candidates, launderedModules, moduleKey })
    }
  }
  if (scopes.length === 0) {
    throw new Error(`no project references ${displayPath(moduleFile)}`)
  }
  return scopes
}

/** Same scopes as openModuleScope, one at a time, dropping each Program before
 *  building the next. Peak memory is one scoped Program (~0.2GB) instead of one
 *  per project (~1GB for five) — use this unless you need them simultaneously. */
export function forEachModuleScope(moduleFile, projectIds, visitor) {
  const moduleKey = normalizeProgramPath(moduleFile)
  const results = []
  let opened = 0
  for (const id of projectIds) {
    const scan = getProjectScan(id)
    const { candidates, launderedModules } = candidateFilesFor(scan, moduleKey)
    if (candidates.length === 0) {
      continue
    }
    const project = getScopedProject(id, candidates)
    if (!project) {
      continue
    }
    opened += 1
    results.push(visitor({ project, candidates, launderedModules, moduleKey }))
  }
  if (opened === 0) {
    throw new Error(`no project references ${displayPath(moduleFile)}`)
  }
  return results
}

function scanFileForTarget(project, sourceFile, target, sink) {
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const reference = resolveReference(project, node)
      if (reference && referenceMatchesTarget(reference, target)) {
        sink.push({ project, sourceFile, node, reference })
      }
      return
    }
    // `ns['export']` names no identifier, so an identifier walk would miss it.
    if (ts.isElementAccessExpression(node)) {
      const reference = resolveComputedMember(project, node)
      if (reference && referenceMatchesTarget(reference, target)) {
        sink.push({ project, sourceFile, node, reference })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
}

/** Every identifier that resolves to the target, including its declaration
 *  sites. Walks the project's proved candidate set by default (a scoped Program
 *  also contains the candidates' transitive imports, which are not candidates);
 *  pass `files: null` to force a walk of every file in the Program. */
export function findTargetReferences(project, target, { files = project.defaultScanFiles } = {}) {
  const results = []
  const wanted = files ? new Set(files.map(normalizeProgramPath)) : undefined
  for (const sourceFile of project.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue
    }
    if (wanted && !wanted.has(normalizeProgramPath(sourceFile.fileName))) {
      continue
    }
    scanFileForTarget(project, sourceFile, target, results)
  }
  return results
}

/** Call expressions whose callee resolves to the target. Skips runtime-erased
 *  references. Does NOT find indirect invocation (`const f = seam.write; f()`):
 *  that shows up in runtimeAliasEscapes, and a gate must treat a non-empty
 *  escape list as "I can no longer see every call", not as clean. */
export function findTargetCallSites(project, target, options) {
  const calls = []
  for (const hit of findTargetReferences(project, target, options)) {
    if (!hit.reference.isRuntimeValueReference) {
      continue
    }
    const callee = ts.isPropertyAccessExpression(hit.node.parent) ? hit.node.parent : hit.node
    const call = callee.parent
    if (ts.isCallExpression(call) && call.expression === callee) {
      calls.push({ ...hit, call })
    }
  }
  return calls
}

/** Runtime references to the target that are not a direct call: stored in a
 *  variable, passed as an argument, default-exported. Import bindings and
 *  identity-preserving re-exports are excluded — the module graph already
 *  follows those. */
export function runtimeAliasEscapes(project, target, options) {
  const escapes = []
  for (const hit of findTargetReferences(project, target, options)) {
    if (!hit.reference.isRuntimeValueReference) {
      continue
    }
    const parent = hit.node.parent
    if (ts.isCallExpression(parent) && parent.expression === hit.node) {
      continue
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      continue
    }
    if (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent)
    ) {
      continue
    }
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isClassDeclaration(parent)) &&
      parent.name === hit.node
    ) {
      continue
    }
    escapes.push(hit)
  }
  return escapes
}
