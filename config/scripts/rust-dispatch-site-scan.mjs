// Finds, in production TypeScript, every place a declared Rust door is reached —
// and, just as importantly, every place a door is reached in a way this analysis
// CANNOT attribute to a ported module.
//
// Every step is a symbol question, never a text question: the callee is resolved
// through the type checker to the door DECLARATION, so a renamed import, a
// laundered re-export and a namespace member all resolve correctly while a local
// shadow with the same name does not. `import type` chains and erased positions
// are rejected because a compile-time-only binding is no runtime door.
//
// THE MODULE KEY IS READ AS A LITERAL NODE ONLY
// `literalStringArgument` — a genuine string-literal AST node in the argument
// slot. Deliberately NOT the checker's constant folding
// (`constantStringArgument`), which answers yes for a value whose declared TYPE
// is a string literal even though nothing puts a string in that slot at runtime:
//   declare const KEY: 'ported-module'                  // ambient; no value
//   orcaDispatch(null as unknown as 'ported-module')    // a cast
//   function f(k: 'ported-module') { orcaDispatch(k) }  // a parameter's type
// Each of those folded to a literal and would have removed a module from the
// orphan list from source that provably cannot dispatch it.
//
// WHAT THIS DOES NOT DO, IN THE DIRECTION THAT MATTERS
// A resolved dispatch site is a site in the SOURCE. It is not proof the call
// executes: an exported function nothing ever calls still counts, so a module
// can be missing from the orphan list while its Rust is never actually run. The
// report says this. Under-reporting orphans is the failure this analysis has;
// it does not manufacture merit for anything.

import ts from 'typescript-api'

import {
  DECLARED_DISPATCH_DOORS,
  doorModulePath,
  resolveDoorsInProject
} from './rust-dispatch-keyed-doors.mjs'
import {
  ALL_PROJECT_IDS,
  candidateFilesFor,
  declarationKey,
  displayPath,
  findTargetReferences,
  getProjectScan,
  getScopedProject,
  literalStringArgument,
  normalizeProgramPath,
  resolveReference
} from './typescript-symbol-resolution.mjs'

const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/
const TEST_DIR = /\/(__tests__|__mocks__|test-fixtures)\//

/** Non-test TypeScript under src/. Excluding a file can only ADD orphan
 *  candidates (its dispatch stops being seen), never hide one. */
export function isProductionFile(filePath) {
  const shown = displayPath(filePath)
  return shown.startsWith('src/') && !TEST_FILE.test(shown) && !TEST_DIR.test(`/${shown}`)
}

function constantCondition(project, expression) {
  const type = project.checker.getTypeAtLocation(expression)
  if ((type.flags & ts.TypeFlags.BooleanLiteral) === 0) {
    return undefined
  }
  return project.checker.typeToString(type) === 'true'
}

/** True when the node sits in a branch the language proves is never taken — the
 *  "call it in a dead branch so the checker still sees a call" shape. */
export function isStaticallyDead(project, node) {
  let child = node
  let parent = node.parent
  while (parent) {
    if (ts.isIfStatement(parent) && parent.expression !== child) {
      const taken = constantCondition(project, parent.expression)
      if (taken === true && child === parent.elseStatement) {
        return true
      }
      if (taken === false && child === parent.thenStatement) {
        return true
      }
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== child) {
      const taken = constantCondition(project, parent.condition)
      if (taken === true && child === parent.whenFalse) {
        return true
      }
      if (taken === false && child === parent.whenTrue) {
        return true
      }
    }
    if (ts.isBinaryExpression(parent) && parent.right === child) {
      const left = constantCondition(project, parent.left)
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false) {
        return true
      }
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true) {
        return true
      }
    }
    if (
      ts.isWhileStatement(parent) &&
      parent.statement === child &&
      constantCondition(project, parent.expression) === false
    ) {
      return true
    }
    child = parent
    parent = parent.parent
  }
  return false
}

/** The call/new whose callee IS this reference, seeing through the property
 *  access it hangs off and any parentheses. */
function invocationFor(node) {
  let callee =
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node
  while (ts.isParenthesizedExpression(callee.parent)) {
    callee = callee.parent
  }
  const invocation = callee.parent
  if (!invocation) {
    return undefined
  }
  const invokes = ts.isCallExpression(invocation) || ts.isNewExpression(invocation)
  return invokes && invocation.expression === callee ? invocation : undefined
}

/** True when the reference is the door's own declaration name — the module
 *  declaring the boundary is not a consumer of it. */
function isOwnDeclarationName(node, doorOf) {
  const parent = node.parent
  if (!parent) {
    return false
  }
  const named =
    ts.isPropertySignature(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isClassDeclaration(parent)
  return named && parent.name === node && doorOf.has(declarationKey(parent))
}

/** True for the import/export binding itself (`import { orcaDispatch } from …`).
 *  Naming a door in a module binding moves no data into Rust; the reference
 *  index already follows those edges to the real use sites. */
function isModuleBindingSyntax(node) {
  const parent = node.parent
  return Boolean(
    parent &&
    (ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent))
  )
}

/** `typeof door` reads the binding but never enters Rust. */
function isTypeofProbe(node) {
  const current =
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node
  return Boolean(current.parent && ts.isTypeOfExpression(current.parent))
}

function locationOf(sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  return `${displayPath(sourceFile.fileName)}:${line + 1}`
}

/** Every door reference in one project, classified. Exported so tests and the
 *  report drive the identical code path.
 *
 *  resolved:     keyed dispatch whose module-key argument is a literal node.
 *  unresolvable: a door reached in a way that names no module. THESE QUALIFY
 *                EVERY ORPHAN CLAIM and are never silently dropped. */
export function scanDispatchSitesInProject(
  project,
  { files, isProduction = isProductionFile, doors } = {}
) {
  const { surfaces, doorOf, instrumentProblems, target } = resolveDoorsInProject(project, doors)
  if (doorOf.size === 0) {
    // Why unresolvable carries them here too: the caller only reads
    // `unresolvable`, so returning [] in the total-damage case hid the fact that
    // NO door resolved — the one situation most likely to fake an empty result.
    return { surfaces, resolved: [], unresolvable: [...instrumentProblems], instrumentProblems }
  }

  const resolved = []
  const unresolvable = [...instrumentProblems]
  const options = files ? { files } : undefined

  for (const hit of findTargetReferences(project, target, options)) {
    if (!isProduction(hit.sourceFile.fileName)) {
      continue
    }
    const door = doorOf.get(hit.reference.declarationKeys[0])
    if (!door || !hit.reference.isRuntimeValueReference) {
      continue
    }
    if (
      isOwnDeclarationName(hit.node, doorOf) ||
      isTypeofProbe(hit.node) ||
      isModuleBindingSyntax(hit.node)
    ) {
      continue
    }
    if (isStaticallyDead(project, hit.node)) {
      continue
    }

    const invocation = invocationFor(hit.node)
    const location = locationOf(hit.sourceFile, invocation ?? hit.node)
    const base = { projectId: project.id, doorId: door.doorId, door: door.name, location }

    if (!door.keyed) {
      // A per-function door IS a Rust entry point, but its name is a FUNCTION
      // name, not a module key: no production source says which ported module it
      // serves. Reported as reach this analysis cannot attribute — never used to
      // remove a module from the orphan list, which is exactly the
      // cross-attribution that let a corpus edit mint a claim.
      unresolvable.push({
        kind: 'unattributable-per-function-door',
        ...base,
        detail: `'${door.name}' enters Rust here, but carries a function name, not a module key`
      })
      continue
    }

    if (!invocation) {
      unresolvable.push({
        kind: 'keyed-door-escapes-as-value',
        ...base,
        detail:
          `the keyed door '${door.name}' is used as a value here, not called; ` +
          'a module could be dispatched through this reference with a key this scan never sees'
      })
      continue
    }

    const key = literalStringArgument(invocation, door.door.moduleArgIndex)
    if (key !== undefined) {
      resolved.push({ ...base, moduleKey: key })
      continue
    }

    const argument = invocation.arguments[door.door.moduleArgIndex]
    // A binding installer forwards its own (module, fn, json) parameters. It is
    // structural, finite and names no module, so it gets its own kind rather
    // than reading as a suspicious computed key.
    const forwarded =
      argument &&
      ts.isIdentifier(argument) &&
      ts.isParameter(resolveReference(project, argument)?.declarations?.[0] ?? argument)
    unresolvable.push({
      kind: forwarded ? 'module-key-forwarded-from-a-parameter' : 'module-key-is-not-a-literal',
      ...base,
      detail: forwarded
        ? `'${door.name}(...)' forwards its caller's module-key parameter; whichever module flows through here ` +
          'is resolved at the call site that supplies it, not here'
        : `'${door.name}(...)' is called with a module-key argument that is not a string-literal node ` +
          `(${argument ? ts.SyntaxKind[argument.kind] : 'no argument'}); any ported module could be dispatched here`
    })
  }

  return { surfaces, resolved, unresolvable, instrumentProblems }
}

/** Every project, one scoped Program each, rooted at the union of the declared
 *  doors' proved candidate sets. Each door is still walked over only its own
 *  candidates, so the scoping guarantee from the foundation is unchanged. */
export function scanDispatchSites({ projectIds = ALL_PROJECT_IDS, doors } = {}) {
  const resolved = []
  const unresolvable = []
  const surfaces = []
  const doorsSeen = new Set()
  const declaredDoors = doors ?? DECLARED_DISPATCH_DOORS
  const started = performance.now()

  for (const id of projectIds) {
    const scan = getProjectScan(id)
    const roots = new Set()
    const walked = new Set()
    for (const door of declaredDoors) {
      const { candidates } = candidateFilesFor(scan, normalizeProgramPath(doorModulePath(door)))
      for (const file of candidates) {
        roots.add(file)
        walked.add(file)
      }
    }
    if (roots.size === 0) {
      continue
    }
    const project = getScopedProject(id, [...roots])
    if (!project) {
      continue
    }
    const measured = scanDispatchSitesInProject(project, {
      files: [...walked],
      doors: declaredDoors
    })
    for (const surface of measured.surfaces) {
      doorsSeen.add(surface.door.id)
      surfaces.push({ projectId: id, ...surface })
    }
    resolved.push(...measured.resolved)
    unresolvable.push(...measured.unresolvable)
  }

  return {
    resolved: dedupe(
      resolved,
      (site) => `${site.location}|${site.doorId}|${site.door}|${site.moduleKey}`
    ),
    unresolvable: dedupe(
      unresolvable,
      (site) => `${site.kind}|${site.location}|${site.doorId}|${site.door}`
    ),
    surfaces,
    doorsSeen,
    elapsedMs: performance.now() - started
  }
}

/** The same file is analysed once per project containing it; a site is one
 *  physical location, so collapse duplicates and keep the project list. */
function dedupe(sites, identityOf) {
  const byIdentity = new Map()
  for (const site of sites) {
    const identity = identityOf(site)
    const existing = byIdentity.get(identity)
    if (existing) {
      existing.projectIds.add(site.projectId)
      continue
    }
    byIdentity.set(identity, { ...site, projectIds: new Set([site.projectId]) })
  }
  return [...byIdentity.values()]
    .map((site) => ({ ...site, projectIds: [...site.projectIds].sort() }))
    .sort((a, b) => a.location.localeCompare(b.location) || a.door.localeCompare(b.door))
}
