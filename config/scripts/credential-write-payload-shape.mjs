// Applies the secret vocabulary to a concrete write site: the bytes, the
// destination, the declared types, and one hop of local dataflow.
//
// Split from the vocabulary itself so the word list can be reviewed without
// reading AST code, and from the sink model so "is this a write" and "is this a
// secret" stay separately auditable.

import ts from 'typescript-api'

import { secretWordsIn } from './credential-secret-vocabulary.mjs'
import { expressionNames } from './credential-write-string-composition.mjs'

const MAX_TAINT_DEPTH = 3

/** Names a node contributes: identifiers, property names, string text, and —
 *  this is the part a plain leaf walk missed — the names it *assembles* from
 *  concatenation, template text, computed keys and folded constants. The raw
 *  source text of the expression is never matched, so a comment or an unrelated
 *  adjacent literal still cannot create a signal. */
function namesIn(project, node, sink) {
  return expressionNames(project, node, sink)
}

/** The declared type's own name(s) for an expression: `PlaintextKeypairFile`,
 *  or the members of a string-literal union like `'.credentials.json' |
 *  'oauth-account.json'`. A type name is a semantic signal the source text at
 *  the call site does not carry. */
function typeNamesFor(project, node) {
  const names = []
  let type
  try {
    type = project.checker.getTypeAtLocation(node)
  } catch {
    return names
  }
  const members = type.isUnionOrIntersection?.() ? type.types : [type]
  for (const member of members) {
    if (member.isStringLiteral?.()) {
      names.push(member.value)
      continue
    }
    const symbolName = member.aliasSymbol?.getName() ?? member.getSymbol()?.getName()
    if (symbolName && symbolName !== '__type' && symbolName !== '__object') {
      names.push(symbolName)
    }
  }
  return names
}

/** Names reachable from `node` by following identifiers to their same-file
 *  variable declarations and parameters. Bounded depth; a parameter contributes
 *  its own name and declared type, which is how `writeFileAtomically(filePath,
 *  contents)` inherits `.credentials.json` from its caller's literal union. */
function taintedNames(project, node, depth, seen, sink) {
  if (depth > MAX_TAINT_DEPTH) {
    return sink
  }
  const visit = (current) => {
    if (ts.isIdentifier(current)) {
      const symbol = project.checker.getSymbolAtLocation(current)
      if (!symbol || seen.has(symbol)) {
        return
      }
      seen.add(symbol)
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration)) {
          sink.push(declaration.name.getText())
          if (declaration.type) {
            sink.push(...typeNamesFor(project, declaration.name))
          }
          if (declaration.initializer) {
            namesIn(project, declaration.initializer, sink)
            taintedNames(project, declaration.initializer, depth + 1, seen, sink)
          }
        } else if (ts.isParameter(declaration)) {
          sink.push(declaration.name.getText())
          sink.push(...typeNamesFor(project, declaration.name))
        } else if (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) {
          sink.push(declaration.name.getText())
        }
      }
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return sink
}

function signalFrom(where, names) {
  const words = new Set()
  const sources = []
  for (const name of names) {
    const hits = secretWordsIn(name)
    if (hits.length > 0) {
      sources.push(name)
      for (const word of hits) {
        words.add(word)
      }
    }
  }
  return words.size > 0
    ? { where, words: [...words].sort(), names: [...new Set(sources)].sort() }
    : null
}

function argumentsAt(call, slots) {
  return slots.map((slot) => call.arguments[slot]).filter(Boolean)
}

/** Every reason this write site looks like a secret write. Empty means the site
 *  is out of scope for this report — NOT that it is safe. */
export function secrecySignals(project, call, sink) {
  const signals = []
  const payloads = argumentsAt(call, sink.payloadSlots)
  const destinations = argumentsAt(call, sink.pathSlots)

  for (const payload of payloads) {
    const direct = signalFrom('payload', namesIn(project, payload, []))
    if (direct) {
      signals.push(direct)
    }
    const typed = signalFrom('payload-type', typeNamesFor(project, payload))
    if (typed) {
      signals.push(typed)
    }
    const tainted = signalFrom('payload-dataflow', taintedNames(project, payload, 0, new Set(), []))
    if (tainted) {
      signals.push(tainted)
    }
  }
  for (const destination of destinations) {
    const direct = signalFrom('destination', namesIn(project, destination, []))
    if (direct) {
      signals.push(direct)
    }
    const typed = signalFrom('destination-type', typeNamesFor(project, destination))
    if (typed) {
      signals.push(typed)
    }
    const tainted = signalFrom(
      'destination-dataflow',
      taintedNames(project, destination, 0, new Set(), [])
    )
    if (tainted) {
      signals.push(tainted)
    }
  }
  return signals
}

// REMOVED: fileMayHoldSecretWrite, the parse-only root prefilter.
//
// It claimed to be "deliberately looser than secrecySignals", and it was not:
// secrecySignals also reads declared TYPE names and follows one hop of dataflow
// into declarations in OTHER files, neither of which a parse of this file can
// see. Deleting an unrelated `console.warn('token', …)` therefore dropped a file
// out of the analysis with the credential write's own bytes unchanged. A
// prefilter is only sound if it over-approximates the detector it feeds; root
// selection now comes from resolved module edges instead — see
// credential-write-analysis-scope.mjs, which re-derives the closure on every run
// from an independent extraction. That equality is NOT proved by a test suite —
// there is none for this module — so treat it as a design property, not evidence.
