// A write sink captured as a value — `const w = fs.writeFileSync` — means the
// analysis can no longer see where the write happens. The foundation's contract
// is explicit that a non-empty escape list must never be read as clean, so the
// report prints every escape under COVERAGE LIMITS.
//
// The file's import bindings are resolved to sink declarations first, and the
// names of those bindings are then used only to decide which identifiers are
// worth asking the checker about. The answer itself is declaration identity:
// comparing text alone reported `private async writeFile(params)` and an object
// literal's `writeFile(...)` METHOD as captured fs writes, because a declaration
// name is not a reference to anything. Computed access with a runtime key stays
// a documented non-goal.

import { createHash } from 'node:crypto'

import ts from 'typescript-api'

import { displayPath } from './typescript-program-cache.mjs'
import { declarationKey, isValuePosition, resolveReference } from './typescript-symbol-identity.mjs'

function sinkNameSet(index) {
  const names = new Set()
  for (const sink of index.byDeclaration.values()) {
    names.add(sink.name)
  }
  return names
}

/** Local binding names in this file that resolve to a sink declaration, and
 *  namespace binding names whose module declares any sink. */
function sinkBindings(project, sourceFile, index) {
  const direct = new Set()
  const namespaces = new Set()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue
    }
    const clause = statement.importClause
    const consider = (nameNode, isNamespace) => {
      const reference = resolveReference(project, nameNode)
      if (!reference) {
        return
      }
      if (isNamespace) {
        const exports = reference.symbol ? project.checker.getExportsOfModule(reference.symbol) : []
        for (const exported of exports) {
          for (const declaration of exported.declarations ?? []) {
            if (index.byDeclaration.has(declarationKey(declaration))) {
              namespaces.add(nameNode.text)
              return
            }
          }
        }
        return
      }
      if (reference.declarationKeys.some((key) => index.byDeclaration.has(key))) {
        direct.add(nameNode.text)
      }
    }
    if (clause.name) {
      consider(clause.name, true)
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        consider(clause.namedBindings.name, true)
      } else {
        for (const element of clause.namedBindings.elements) {
          consider(element.name, false)
        }
      }
    }
  }
  return { direct, namespaces }
}

function isCallee(node) {
  const parent = node.parent
  if (ts.isCallExpression(parent) && parent.expression === node) {
    return true
  }
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === node &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  )
}

function isImportBindingNode(node) {
  const parent = node.parent
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  )
}

/** Sink values in this file that are read without being immediately called. */
export function findSinkEscapes(project, sourceFile, index) {
  const { direct, namespaces } = sinkBindings(project, sourceFile, index)
  if (direct.size === 0 && namespaces.size === 0) {
    return []
  }
  const names = sinkNameSet(index)
  const file = displayPath(sourceFile.fileName)
  const escapes = []

  /** The identifier must RESOLVE to a sink declaration. A method or property
   *  called `writeFile` declares a new symbol; it references nothing. */
  const resolvesToSink = (node) => {
    const reference = resolveReference(project, node)
    return Boolean(
      reference?.isRuntimeValueReference &&
      reference.declarationKeys.some((key) => index.byDeclaration.has(key))
    )
  }

  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const isDirect = direct.has(node.text)
      const isNamespaceMember =
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node &&
        ts.isIdentifier(node.parent.expression) &&
        namespaces.has(node.parent.expression.text) &&
        names.has(node.text)
      if (
        (isDirect || isNamespaceMember) &&
        !isCallee(node) &&
        !isImportBindingNode(node) &&
        isValuePosition(node) &&
        resolvesToSink(node)
      ) {
        const target = isNamespaceMember ? node.parent : node
        const position = sourceFile.getLineAndCharacterOfPosition(target.getStart())
        escapes.push({
          id: createHash('sha256')
            .update(`escape|${file}|${target.getText()}`)
            .digest('hex')
            .slice(0, 16),
          location: `${file}:${position.line + 1}`,
          text: target.getText()
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return escapes
}
