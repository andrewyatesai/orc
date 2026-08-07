// Finds the real-tree fixtures the reference-index tests need, by scanning the
// tree instead of naming files.
//
// Every fixture this module returns was previously a hardcoded `src/shared/...`
// path in the test file. Those paths are the maintainer's code, not the tests'
// code: a merge that renames one turns a green suite red for no reason, which
// has already happened once. The property under test ("a re-export preserves
// symbol identity, so the barrel's importers are candidates") is true of
// whatever qualifying file the tree currently holds.
//
// The re-export parser here is written independently of
// `typescript-module-reference-index.mjs`'s `reexportsFrom`. That is deliberate:
// the tests compare this module's answer with that one's, so a shared
// implementation would make the comparison vacuous.

import fs from 'node:fs'

import ts from 'typescript-api'

/** Thrown when the tree contains no file with the shape a test needs. Distinct
 *  from an assertion failure: it means the fixture search came up empty, not
 *  that the analysis is wrong. */
export class NoFixtureInTreeError extends Error {
  constructor(message) {
    super(
      `${message}\n` +
        'This is a fixture-discovery failure, not an analysis failure: the ' +
        'scanned project contains no file with the required shape. Either the ' +
        'search criteria are now wrong for this tree, or the project genuinely ' +
        'has no such file.'
    )
    this.name = 'NoFixtureInTreeError'
  }
}

/** Named exports, re-export edges and import bindings of one file, read from
 *  its AST. Comments and strings that merely look like exports create nothing. */
function readModuleFacts(filePath, scan) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  )
  const importBindings = new Map()
  const reexportFromKeys = new Set()
  const localReexportKeys = new Set()
  const valueExportNames = []

  const resolve = (specifier) => scan.resolveModule(specifier, filePath)

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const resolved = resolve(statement.moduleSpecifier.text)
      const clause = statement.importClause
      if (!resolved || !clause || clause.isTypeOnly) {
        continue
      }
      if (clause.name) {
        importBindings.set(clause.name.text, resolved.key)
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        importBindings.set(clause.namedBindings.name.text, resolved.key)
      } else if (clause.namedBindings) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) {
            importBindings.set(element.name.text, resolved.key)
          }
        }
      }
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const resolved = resolve(statement.moduleSpecifier.text)
        if (resolved) {
          reexportFromKeys.add(resolved.key)
        }
        continue
      }
      const elements =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
          : []
      for (const element of elements) {
        const local = (element.propertyName ?? element.name).text
        const source = importBindings.get(local)
        if (source) {
          localReexportKeys.add(source)
        }
      }
      continue
    }
    // Why: the file is parsed without parent pointers, so read the modifier list
    // directly rather than via getCombinedModifierFlags.
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
    if (!exported) {
      continue
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      valueExportNames.push(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          valueExportNames.push(declaration.name.text)
        }
      }
    }
  }
  return { filePath, importBindings, reexportFromKeys, localReexportKeys, valueExportNames }
}

/** Memoised per-file facts, so a search that touches a file twice parses once. */
export function createModuleFactsReader(scan) {
  const cache = new Map()
  return (key, filePath) => {
    if (!cache.has(key)) {
      cache.set(key, readModuleFacts(filePath ?? key, scan))
    }
    return cache.get(key)
  }
}

function sortedKeys(graph) {
  return [...graph.scannedFiles].sort()
}

function pathFor(graph, key) {
  return graph.pathOf.get(key) ?? key
}

function importerCount(graph, key) {
  return (graph.importersOf.get(key) ?? new Set()).size
}

/** A file that re-exports another repo module and is itself imported — the
 *  laundering barrel shape. `kind: 'from'` is `export … from '…'`;
 *  `kind: 'local'` is `import { x } from '…'` followed by a bare `export { x }`,
 *  which carries no module specifier and so is the case a specifier-text scan
 *  misses. */
export function findLaunderingBarrel(
  scan,
  graph,
  { kind, readFacts = createModuleFactsReader(scan) } = {}
) {
  const field = kind === 'local' ? 'localReexportKeys' : 'reexportFromKeys'
  for (const barrelKey of sortedKeys(graph)) {
    if (importerCount(graph, barrelKey) === 0) {
      continue
    }
    const facts = readFacts(barrelKey, pathFor(graph, barrelKey))
    if (!facts) {
      continue
    }
    for (const originKey of [...facts[field]].sort()) {
      if (originKey !== barrelKey && graph.scannedFiles.has(originKey)) {
        return {
          kind: kind === 'local' ? 'local' : 'from',
          barrelKey,
          barrelPath: pathFor(graph, barrelKey),
          originKey,
          originPath: pathFor(graph, originKey),
          importerKeys: [...(graph.importersOf.get(barrelKey) ?? [])].sort()
        }
      }
    }
  }
  throw new NoFixtureInTreeError(
    `no file in project '${scan.id}' both re-exports another scanned module via ` +
      `${kind === 'local' ? '`export { imported }` with no module specifier' : '`export … from`'} ` +
      'and is imported by at least one other file.'
  )
}

/** Closure of `moduleKey` over identity-preserving re-export edges, computed
 *  from this module's own parse. Used only to pick fixtures; the tests compare
 *  it against the production `laundererClosure`. */
export function independentLaundererClosure(
  scan,
  graph,
  moduleKey,
  readFacts = createModuleFactsReader(scan)
) {
  const launder = new Set([moduleKey])
  const frontier = [moduleKey]
  while (frontier.length > 0) {
    const current = frontier.pop()
    for (const importer of graph.importersOf.get(current) ?? []) {
      if (launder.has(importer)) {
        continue
      }
      const facts = readFacts(importer, pathFor(graph, importer))
      if (!facts) {
        continue
      }
      const reexported = [...facts.reexportFromKeys, ...facts.localReexportKeys]
      if (reexported.some((key) => launder.has(key))) {
        launder.add(importer)
        frontier.push(importer)
      }
    }
  }
  return launder
}

/** A module the barrel imports but does NOT re-export, and that cannot reach the
 *  barrel through any re-export chain. The discriminating negative case: a naive
 *  "importers of importers" closure would wrongly pull the barrel in. */
export function findImportedButNotReexported(
  scan,
  graph,
  barrelKey,
  readFacts = createModuleFactsReader(scan)
) {
  const facts = readFacts(barrelKey, pathFor(graph, barrelKey))
  const reexported = new Set([
    ...(facts?.reexportFromKeys ?? []),
    ...(facts?.localReexportKeys ?? [])
  ])
  for (const importedKey of [...(graph.importsOf.get(barrelKey) ?? [])].sort()) {
    if (reexported.has(importedKey) || importedKey === barrelKey) {
      continue
    }
    if (!graph.scannedFiles.has(importedKey) || importedKey.includes('/node_modules/')) {
      continue
    }
    if (!independentLaundererClosure(scan, graph, importedKey, readFacts).has(barrelKey)) {
      return { moduleKey: importedKey, modulePath: pathFor(graph, importedKey) }
    }
  }
  throw new NoFixtureInTreeError(
    `every repo-internal module imported by ${barrelKey} is also re-exported by it ` +
      '(or reaches it through a re-export chain), so there is no negative case to test.'
  )
}

/** A module with named value exports that other files import — the shape a gate
 *  seam has. `withinBudget(originKey)` lets the caller reject a module whose
 *  candidate set is too large to be worth calling a prefilter. */
export function findReferencedExportModule(
  scan,
  graph,
  {
    minImporters = 2,
    withinBudget = () => true,
    maxExports = 3,
    readFacts = createModuleFactsReader(scan)
  } = {}
) {
  for (const moduleKey of sortedKeys(graph)) {
    if (importerCount(graph, moduleKey) < minImporters || !scan.fileKeys.has(moduleKey)) {
      continue
    }
    const facts = readFacts(moduleKey, pathFor(graph, moduleKey))
    if (!facts || facts.valueExportNames.length === 0) {
      continue
    }
    if (!withinBudget(moduleKey)) {
      continue
    }
    return {
      moduleKey,
      modulePath: pathFor(graph, moduleKey),
      exportNames: facts.valueExportNames.slice(0, maxExports)
    }
  }
  throw new NoFixtureInTreeError(
    `no module in project '${scan.id}' has a named value export, at least ${minImporters} ` +
      'importers, and a candidate set inside the prefilter budget.'
  )
}
