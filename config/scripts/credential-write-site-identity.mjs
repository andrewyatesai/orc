// A stable name for one write site, so a reviewed classification can be
// attached to that site and survive ordinary editing.
//
// The identity has to hold still while the line moves, the arguments are
// reformatted and a local variable is renamed, but change when a genuinely new
// write appears next to an old one. So it is: file + the chain of named
// declarations enclosing the call + which sink it writes through + an ordinal
// among identical siblings. Deliberately NOT part of it: line/column, argument
// text, comments. Deliberately part of it: the enclosing declaration name —
// renaming the function that performs a credential write is a review-worthy
// event, and the site reading as newly unreviewed is the intended behaviour.
//
// Nothing keys off this identity to hide a site. It is the join key for the
// annotations in credential-write-review-notes.json, and a site whose key
// matches no note is reported as `unreviewed`, never omitted.

import { createHash } from 'node:crypto'

import ts from 'typescript-api'

import { displayPath } from './typescript-program-cache.mjs'

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

/** Dotted path of named declarations enclosing `node`, outermost first. */
export function enclosingDeclarationPath(node) {
  const parts = []
  let current = node.parent
  while (current) {
    const name = declarationName(current)
    if (name) {
      parts.unshift(name)
    }
    current = current.parent
  }
  return parts.length > 0 ? parts.join('.') : '<module>'
}

/** Sink identity as it appears in a site id: stable across renames of the local
 *  binding, because it names the sink's *declaring* origin. */
export function sinkIdentity(sink) {
  return `${sink.kind}:${sink.origin ?? ''}:${sink.name}`
}

/** Assigns each write site a content-addressed id. `sites` must be supplied in
 *  source order per file so the sibling ordinal is deterministic. */
export function assignSiteIds(sites) {
  const counters = new Map()
  return sites.map((site) => {
    const file = displayPath(site.call.getSourceFile().fileName)
    const scope = enclosingDeclarationPath(site.call)
    const sink = sinkIdentity(site.sink)
    const stem = `${file}|${scope}|${sink}`
    const ordinal = counters.get(stem) ?? 0
    counters.set(stem, ordinal + 1)
    const key = `${stem}|${ordinal}`
    return {
      ...site,
      file,
      scope,
      sinkId: sink,
      ordinal,
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
