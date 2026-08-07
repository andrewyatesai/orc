// WHICH FILES THE GATE LOOKS AT, AND WHY THAT SET IS NOT A GUESS.
//
// The previous gate chose Program roots with a parse-only "does this file
// mention a secret" filter. That filter was strictly WEAKER than the detector it
// fed — the detector also reads declared type names and follows dataflow into
// other files — so deleting an unrelated log line hid a credential write whose
// own bytes never changed. There is no prefilter here any more: EVERY
// non-test source file in the analysed directories is a Program root.
//
// What remains is a pure performance filter with a soundness obligation, and it
// is computed from the checker, not from text:
//
//   REACHABILITY   a call can only classify as a write if the callee resolves to
//                  a declaration in a write module (fs, fs/promises, ssh2's
//                  SFTPWrapper, a seeded repo entry point) or to a repo function
//                  that forwards into one. Either way the file must have an
//                  import path to a write module — in ESM a value cannot arrive
//                  any other way. So files with no such path are skipped.
//
// The seed set is NOT a hand-written list of fs specifiers. It is derived by
// asking the checker, for every module specifier the Program actually uses,
// whether that module exports one of the sink declarations. That is what closes
// `graceful-fs`, `node:fs` (a distinct ambient module that re-exports `fs`), and
// any .d.ts that launders a write function under a new name.
//
// The reachability filter's soundness is not asserted, it is checked at run
// time: `excludedFilesReachingScope` re-derives the closure property from the
// AST rather than from the scanner pre-pass that built the graph, and any
// disagreement is REPORTED as a coverage limit — the report says which files it
// skipped without justification instead of claiming it skipped none.

import ts from 'typescript-api'

import { displayPath, normalizeProgramPath } from './typescript-program-cache.mjs'
import { declarationKey } from './typescript-symbol-identity.mjs'

const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/

/** Non-test source files under the analysed directories. Extensions are the
 *  ones a Program can hold; anything else on disk is caught by the coverage
 *  invariant instead of being silently skipped. */
export function analysedRootsOf(scan, analysedDirs) {
  return scan.fileNames.filter((filePath) => isAnalysedPath(filePath, analysedDirs))
}

export function isAnalysedPath(filePath, analysedDirs) {
  const relative = displayPath(filePath)
  return analysedDirs.some((dir) => relative.startsWith(`${dir}/`)) && !TEST_FILE.test(relative)
}

/** Module specifiers each file in the Program imports, from the parsed text the
 *  Program already holds (no disk read). `preProcessFile` also reports dynamic
 *  `import()` and `require()`, so a lazily-loaded writer still creates an edge. */
function specifiersOf(sourceFile) {
  return ts
    .preProcessFile(sourceFile.text, true, true)
    .importedFiles.map((reference) => reference.fileName)
}

/** The module a sink declaration lives in, as the key the import graph uses:
 *  the name of the enclosing `declare module 'x'` when there is one (that is how
 *  `fs` is declared), otherwise the declaring file. */
function sinkModuleKeys(sinkIndex) {
  const ambient = new Set()
  const files = new Set()
  const declarations = [...sinkIndex.byDeclaration.keys(), ...sinkIndex.streamByDeclaration.keys()]
  for (const [key, declaration] of sinkIndex.declarationNodes ?? []) {
    if (!declarations.includes(key)) {
      continue
    }
    let current = declaration
    let named
    while (current) {
      if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) {
        named = current.name.text
      }
      current = current.parent
    }
    if (named) {
      ambient.add(named)
    } else {
      files.add(normalizeProgramPath(declaration.getSourceFile().fileName))
    }
  }
  return { ambient, files }
}

/** True when this module's exports include one of the sink declarations —
 *  asked of the checker, so a package that re-exports `fs.writeFileSync` under
 *  any name, or an ambient alias module like `node:fs`, is recognised without
 *  anybody listing it. */
function moduleExportsASink(project, moduleSymbol, sinkKeys) {
  if (!moduleSymbol) {
    return false
  }
  let exports
  try {
    exports = project.checker.getExportsOfModule(moduleSymbol)
  } catch {
    return false
  }
  for (const exported of exports) {
    const target =
      (exported.flags & ts.SymbolFlags.Alias) !== 0
        ? (safeAliased(project, exported) ?? exported)
        : exported
    for (const declaration of target.declarations ?? []) {
      if (sinkKeys.has(declarationKey(declaration))) {
        return true
      }
    }
  }
  return false
}

function safeAliased(project, symbol) {
  try {
    return project.checker.getAliasedSymbol(symbol)
  } catch {
    return undefined
  }
}

/** Every file in the Program that can reach a write module through resolved
 *  import edges, plus the seed modules themselves. Ambient modules (`fs`) have
 *  no file, so they participate as `ambient:<name>` nodes. */
export function writeReachableFiles(project, sinkIndex) {
  const started = performance.now()
  const sinkKeys = new Set([
    ...sinkIndex.byDeclaration.keys(),
    ...sinkIndex.streamByDeclaration.keys()
  ])
  const { ambient: seedAmbient, files: seedFiles } = sinkModuleKeys(sinkIndex)

  const importersOf = new Map()
  const importsOf = new Map()
  const specifierNodes = new Set()
  const link = (target, importer) => {
    let set = importersOf.get(target)
    if (!set) {
      set = new Set()
      importersOf.set(target, set)
    }
    set.add(importer)
  }

  for (const sourceFile of project.program.getSourceFiles()) {
    const key = normalizeProgramPath(sourceFile.fileName)
    // A node_modules module contributes only its export set (checked below);
    // its own import edges cannot put a repo file in the closure, because the
    // repo file's edge to it is already recorded.
    if (key.includes('/node_modules/')) {
      continue
    }
    const targets = new Set()
    for (const specifier of specifiersOf(sourceFile)) {
      const resolved = project.scan.resolveModule(specifier, sourceFile.fileName)
      if (resolved) {
        link(resolved.key, key)
        targets.add(resolved.key)
        continue
      }
      const node = `ambient:${specifier}`
      specifierNodes.add(specifier)
      link(node, key)
    }
    importsOf.set(key, targets)
  }

  // Any module that re-exports a sink is itself a seed — asked of the checker,
  // which is what makes a laundering .d.ts or `node:fs` impossible to hide behind.
  const seeds = new Set(seedFiles)
  for (const specifier of specifierNodes) {
    const moduleSymbol = project.checker.tryFindAmbientModule?.(specifier)
    if (seedAmbient.has(specifier) || moduleExportsASink(project, moduleSymbol, sinkKeys)) {
      seeds.add(`ambient:${specifier}`)
    }
  }
  for (const sourceFile of project.program.getSourceFiles()) {
    const key = normalizeProgramPath(sourceFile.fileName)
    if (seeds.has(key) || !key.includes('/node_modules/')) {
      continue
    }
    if (moduleExportsASink(project, project.checker.getSymbolAtLocation(sourceFile), sinkKeys)) {
      seeds.add(key)
    }
  }

  const reachable = new Set(seeds)
  const frontier = [...seeds]
  while (frontier.length > 0) {
    const current = frontier.pop()
    for (const importer of importersOf.get(current) ?? []) {
      if (!reachable.has(importer)) {
        reachable.add(importer)
        frontier.push(importer)
      }
    }
  }
  return { reachable, seeds, importsOf, ms: performance.now() - started }
}

/** Walk order with a module's dependencies before the module itself. The write
 *  detector grows a set of writer names from the innermost sink outwards, so
 *  visiting importers last means almost everything is already known on the first
 *  round: it turns a six-round fixpoint into a two-round one. Cycles are broken
 *  arbitrarily — the fixpoint is what makes the result order-independent, this
 *  only makes it cheap. */
export function dependencyFirstOrder(fileKeys, importsOf) {
  const order = []
  const seen = new Set()
  for (const root of fileKeys) {
    if (seen.has(root)) {
      continue
    }
    // Explicit stack: the import graph is thousands of modules deep in places.
    const stack = [{ key: root, expanded: false }]
    while (stack.length > 0) {
      const frame = stack.at(-1)
      if (frame.expanded) {
        stack.pop()
        order.push(frame.key)
        continue
      }
      frame.expanded = true
      if (seen.has(frame.key)) {
        stack.pop()
        continue
      }
      seen.add(frame.key)
      for (const target of importsOf.get(frame.key) ?? []) {
        if (fileKeys.has(target) && !seen.has(target)) {
          stack.push({ key: target, expanded: false })
        }
      }
    }
  }
  return order
}

/** Module specifiers named anywhere in a parsed file, read from the AST rather
 *  than from the scanner pre-pass that built the graph. Two independent
 *  extractions of the same fact is the point: if one has a blind spot, the
 *  cross-check below sees the disagreement. */
function specifiersFromAst(sourceFile) {
  const specifiers = []
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const reference = node.moduleReference.expression
      if (ts.isStringLiteralLike(reference)) {
        specifiers.push(reference.text)
      }
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text)
    }
    if (ts.isCallExpression(node)) {
      const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const first = node.arguments[0]
      if ((isImportCall || isRequire) && first && ts.isStringLiteralLike(first)) {
        specifiers.push(first.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return specifiers
}

/** Files the reachability filter EXCLUDED that nevertheless import something it
 *  included. Must always be empty: it is the closure property of the set, re-derived
 *  from the AST instead of from the scanner pre-pass. Non-empty means the graph
 *  the filter was built from has a blind spot, so the walk skipped files it had
 *  no right to skip, and the report names them as a coverage limit. */
export function excludedFilesReachingScope(project, analysedFiles, reachable) {
  const escapes = []
  for (const filePath of analysedFiles) {
    const key = normalizeProgramPath(filePath)
    if (reachable.has(key)) {
      continue
    }
    const sourceFile = project.program.getSourceFile(filePath)
    if (!sourceFile) {
      continue
    }
    for (const specifier of specifiersFromAst(sourceFile)) {
      const resolved = project.scan.resolveModule(specifier, filePath)
      if ((resolved && reachable.has(resolved.key)) || reachable.has(`ambient:${specifier}`)) {
        escapes.push(`${displayPath(filePath)} -> ${specifier}`)
        break
      }
    }
  }
  return escapes.sort()
}
