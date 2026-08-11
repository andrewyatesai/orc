// A stable name for one write site, so a reviewed classification can be
// attached to that site and survive ordinary editing.
//
// The identity has to hold still while the line moves, the arguments are
// reformatted, a local variable is renamed AND A NEW WRITE IS ADDED NEXT TO IT,
// but change when this write itself becomes a different write. So it is:
// file + the chain of enclosing FUNCTIONS + which sink it writes through + a
// fingerprint of the call (credential-write-call-shape.mjs).
//
// Deliberately NOT part of it: line/column, formatting, comments, the names of
// locals, and — since the ordinal was retired — the position of the call among
// its siblings. Deliberately part of it: the enclosing function name (renaming
// the function that performs a credential write is a review-worthy event) and
// the payload's shape (a write whose payload changed shape is a new write).
//
// Nothing keys off this identity to hide a site. It is the join key for the
// annotations in credential-write-review-notes.json, and a site whose key
// matches no note is reported as `unreviewed`, never omitted. A note whose key
// matches no site is reported too — see ORPHANED REVIEW NOTES in the report,
// and `pnpm report:credential-writes:rekey` to reconcile one deliberately.

import { createHash } from 'node:crypto'

import ts from 'typescript-api'

import { callShape, callShapeDigest } from './credential-write-call-shape.mjs'
import { displayPath } from './typescript-program-cache.mjs'

function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/** Declarations that name a scope only by lending their name to a function in
 *  their initializer (`const attempt = () => …`). A call sitting directly in
 *  the initializer is NOT in a scope of that name — `const x = write(secret)`
 *  is in the enclosing function, and counting `x` made wrapping a call in a
 *  variable re-key the site. */
function namesViaInitializerOnly(node) {
  return (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node)
  )
}

function declarationName(node) {
  if (ts.isSourceFile(node)) {
    return null
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : '<anonymous>'
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor'
  }
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  return null
}

/** Dotted path of the named declarations enclosing `node`, outermost first. */
export function enclosingDeclarationPath(node) {
  const parts = []
  let current = node.parent
  let crossedFunction = false
  while (current) {
    const name = declarationName(current)
    if (name !== null && (crossedFunction || !namesViaInitializerOnly(current))) {
      parts.unshift(name)
    }
    crossedFunction = crossedFunction || isFunctionLike(current)
    current = current.parent
  }
  return parts.length > 0 ? parts.join('.') : '<module>'
}

/** Sink identity as it appears in a site id: stable across renames of the local
 *  binding, because it names the sink's *declaring* origin. */
export function sinkIdentity(sink) {
  return `${sink.kind}:${sink.origin ?? ''}:${sink.name}`
}

/** Assigns each write site its id. `sites` must be supplied in source order per
 *  file so the `~n` suffix — the last resort, for calls whose shape is
 *  genuinely identical — is deterministic. */
export function assignSiteIds(sites) {
  const counters = new Map()
  return sites.map((site) => {
    const file = displayPath(site.call.getSourceFile().fileName)
    const scope = enclosingDeclarationPath(site.call)
    const sink = sinkIdentity(site.sink)
    const stem = `${file}|${scope}|${sink}|${callShapeDigest(site.call)}`
    const twin = counters.get(stem) ?? 0
    counters.set(stem, twin + 1)
    const key = twin === 0 ? stem : `${stem}~${twin}`
    return {
      ...site,
      file,
      scope,
      sinkId: sink,
      shape: callShape(site.call),
      twin,
      id: createHash('sha256').update(key).digest('hex').slice(0, 16),
      idSource: key
    }
  })
}

/** One-line human form, for diagnostics that want a site in a single string. */
export function describeSite(site) {
  const position = site.call.getSourceFile().getLineAndCharacterOfPosition(site.call.getStart())
  return `${site.file}:${position.line + 1} ${site.scope} -> ${site.sinkId}`
}
