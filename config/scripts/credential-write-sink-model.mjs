// Deciding whether a given CALL writes bytes to a disk — from the callee's
// resolved declaration, never from its spelling at the call site.
//
// The catalog of base sinks lives in credential-write-sink-catalog.mjs. This
// module answers the per-call question, and derives the one sink kind that
// cannot be enumerated in advance:
//   WRAPPER  a repo function that forwards one of its own parameters into the
//            payload slot of a sink. Discovered on demand from the call being
//            classified, to a bounded depth — so `writeClaudeManagedAuthFile ->
//            writeFileAtomically -> writeFileSync` is a sink without anyone
//            enumerating it. Chains cut off by that bound are recorded in
//            `depthLimited` and reported, because "I stopped following" is a
//            different answer from "there is no write here".
//
// NOT a sink, by construction (documented holes, not oversights):
//   * indirect invocation through a value (`const f = fs.writeFileSync; f(...)`)
//   * computed member access with a RUNTIME key (`fs[pick()](...)`); a
//     statically foldable key IS resolved, see computedMemberDeclarations
//   * a brand-new remote-write primitive that shells out itself instead of
//     going through ssh2/SFTPWrapper or a seeded entry point
//   * anything reached through `eval` / `new Function` / a patched namespace

import ts from 'typescript-api'

import { normalizeProgramPath } from './typescript-program-cache.mjs'
import { declarationKey, resolveReference } from './typescript-symbol-identity.mjs'
import { foldedStringValue } from './credential-write-string-composition.mjs'
import { STREAM_RECEIVER_TYPES } from './credential-write-sink-catalog.mjs'

// Re-exported so consumers keep one import for "the sink model"; the catalog
// split is a line-budget detail, not a new seam.
export { REPO_WRITE_SEEDS, buildSinkIndex } from './credential-write-sink-catalog.mjs'

/** How many wrapper hops the on-demand discovery follows before giving up. */
const MAX_WRAPPER_DEPTH = 4

function receiverIsWriteStream(project, call) {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false
  }
  const type = project.checker.getTypeAtLocation(callee.expression)
  const candidates = type.isUnionOrIntersection?.() ? type.types : [type]
  for (const member of candidates) {
    const name = member.getSymbol()?.getName() ?? member.aliasSymbol?.getName()
    if (name && STREAM_RECEIVER_TYPES.includes(name)) {
      return true
    }
  }
  return false
}

/** `ns['write' + 'FileSync']` — TypeScript widens the key to `string`, so the
 *  checker binds no symbol and the callee resolves to nothing. Folding the key
 *  ourselves and looking the property up on the receiver's type recovers the
 *  same declaration a dotted access would have given. A key that is not fully
 *  static yields nothing, which is correct: a runtime key is out of scope. */
function computedMemberDeclarations(project, expression) {
  if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) {
    return undefined
  }
  const name = foldedStringValue(project, expression.argumentExpression)
  if (name === undefined) {
    return undefined
  }
  let receiverType
  try {
    receiverType = project.checker.getTypeAtLocation(expression.expression)
  } catch {
    return undefined
  }
  const property = receiverType && project.checker.getPropertyOfType(receiverType, name)
  const declarations = property?.declarations ?? []
  return declarations.length > 0 ? declarations : undefined
}

function calleeDeclarationKeys(project, call) {
  const reference = resolveReference(project, call.expression)
  if (reference?.isRuntimeValueReference && reference.declarationKeys.length > 0) {
    return { keys: reference.declarationKeys, reference }
  }
  const folded = computedMemberDeclarations(project, call.expression)
  if (folded) {
    return {
      keys: folded.map(declarationKey),
      reference: { declarations: folded, declarationKeys: folded.map(declarationKey) }
    }
  }
  if (!reference || !reference.isRuntimeValueReference) {
    return { keys: [], reference }
  }
  return { keys: reference.declarationKeys, reference }
}

/** Nodes that introduce their own call schedule. `functionBodyOf` answers the
 *  same question for declarations; this is the hot, allocation-free form used
 *  while walking a body. */
function isFunctionLikeNode(node) {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return true
    default:
      return false
  }
}

function functionBodyOf(declaration) {
  if (!declaration) {
    return undefined
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isConstructorDeclaration(declaration)
  ) {
    return declaration
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return initializer
    }
  }
  if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return initializer
    }
  }
  return undefined
}

/** Parameter symbols of `fn`, in declaration order. Destructured parameters
 *  contribute every binding they introduce, all attributed to the same slot. */
function parameterSlots(project, fn) {
  const slots = new Map()
  fn.parameters.forEach((parameter, slotIndex) => {
    const collect = (nameNode) => {
      if (ts.isIdentifier(nameNode)) {
        const symbol = project.checker.getSymbolAtLocation(nameNode)
        if (symbol) {
          slots.set(symbol, slotIndex)
        }
        return
      }
      for (const element of nameNode.elements ?? []) {
        if (element.name) {
          collect(element.name)
        }
      }
    }
    collect(parameter.name)
  })
  return slots
}

/** Slots of `fn` whose value can reach `expression`. Follows identifiers to
 *  same-function `const`/`let` initializers so `const body = JSON.stringify(x)`
 *  still attributes to x's slot. */
function slotsReaching(project, expression, slots, depth = 0) {
  const found = new Set()
  if (depth > 3) {
    return found
  }
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const symbol = project.checker.getSymbolAtLocation(node)
      if (!symbol) {
        return
      }
      if (slots.has(symbol)) {
        found.add(slots.get(symbol))
        return
      }
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          for (const slot of slotsReaching(project, declaration.initializer, slots, depth + 1)) {
            found.add(slot)
          }
        }
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return found
}

function argumentsAt(call, slots) {
  return slots.map((slot) => call.arguments[slot]).filter(Boolean)
}

function mergeSlots(target, additions) {
  for (const value of additions) {
    target.add(value)
  }
}

/** A stable label for a function the depth bound cut off, for the report. */
function declarationLabel(declaration) {
  const name = declaration.name?.getText?.() ?? '<anonymous>'
  const sourceFile = declaration.getSourceFile()
  const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line + 1
  return `${normalizeProgramPath(sourceFile.fileName).split('/').slice(-2).join('/')}:${line} ${name}`
}

/** Is `declaration` a repo function that forwards a parameter into a sink?
 *  Memoized per declaration key; recursion-guarded.
 *
 *  A `null` reached under the depth bound is deliberately NOT memoized. It is
 *  "I stopped following", which depends on where the walk started, whereas the
 *  cache is read as "this function is not a writer" from every other call site.
 *  Caching it made classification order-dependent and silently dropped real
 *  sites: a chain first entered four hops deep poisoned the shallow answer. */
function wrapperSinkFor(index, declaration, depth) {
  const key = declarationKey(declaration)
  const cached = index.wrapperCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  if (depth >= MAX_WRAPPER_DEPTH) {
    index.depthLimited.add(declarationLabel(declaration))
    index.depthLimitHits += 1
    return null
  }
  const fn = functionBodyOf(declaration)
  // A wrapper is a function that forwards one of its OWN parameters into a
  // sink, so a nullary function can never be one — and skipping those avoids
  // walking a third of the repo's function bodies. Depth-independent, so it is
  // always safe to memoize.
  if (!fn?.body || fn.parameters.length === 0) {
    index.wrapperCache.set(key, null)
    return null
  }
  const truncationsBefore = index.depthLimitHits
  // Placeholder blocks a recursive wrapper from re-entering itself.
  index.wrapperCache.set(key, null)

  const { project } = index
  const slots = parameterSlots(project, fn)
  const pathSlots = new Set()
  const payloadSlots = new Set()
  let via = null

  // Why: a write inside a nested callback runs on that callback's schedule, not
  // this function's, so forwarding into it does not make this function a writer
  // (it also turned every `registerXHandlers` into a credential sink).
  // Why the cheap kind test rather than functionBodyOf: this runs on every AST
  // node of every probed function and was the single hottest frame in the walk.
  const visit = (node) => {
    if (node !== fn && isFunctionLikeNode(node)) {
      return
    }
    if (ts.isCallExpression(node)) {
      const inner = classifyCall(index, node, depth + 1)
      if (inner) {
        for (const argument of argumentsAt(node, inner.sink.payloadSlots)) {
          mergeSlots(payloadSlots, slotsReaching(project, argument, slots))
        }
        for (const argument of argumentsAt(node, inner.sink.pathSlots)) {
          mergeSlots(pathSlots, slotsReaching(project, argument, slots))
        }
        if (payloadSlots.size > 0 && !via) {
          via = inner
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(fn.body)

  const truncated = index.depthLimitHits > truncationsBefore
  if (payloadSlots.size === 0) {
    if (truncated) {
      // The placeholder would otherwise persist as a definitive "not a writer".
      index.wrapperCache.delete(key)
    }
    return null
  }
  const sink = {
    name: fn.name?.getText() ?? declaration.name?.getText() ?? '<anonymous>',
    pathSlots: [...pathSlots].sort((a, b) => a - b),
    payloadSlots: [...payloadSlots].sort((a, b) => a - b),
    kind: 'wrapper',
    // Why the inner sink's NAME and not its kind:name — a wrapper's identity
    // has to survive the inner sink being reclassified (an fs call becoming a
    // wrapper call as intermediate helpers appear), and the name alone already
    // distinguishes it. The reviewed notes are keyed on this form.
    origin: via ? via.sink.name : 'wrapper'
  }
  const result = { sink, declaration }
  index.wrapperCache.set(key, result)
  return result
}

function classifyCallee(index, call, depth) {
  const { project } = index
  const { keys, reference } = calleeDeclarationKeys(project, call)
  if (keys.length === 0) {
    return null
  }
  for (const key of keys) {
    const sink = index.byDeclaration.get(key)
    if (sink) {
      return { sink, declaration: reference.declarations[0] ?? null, reference }
    }
  }
  for (const key of keys) {
    const sink = index.streamByDeclaration.get(key)
    if (sink) {
      // Receiver-qualified, so the answer is per call — never cached.
      return {
        sink,
        declaration: reference.declarations[0] ?? null,
        reference,
        needsWriteStreamReceiver: true
      }
    }
  }
  for (const declaration of reference.declarations) {
    if (declaration.getSourceFile().isDeclarationFile) {
      continue
    }
    const wrapper = wrapperSinkFor(index, declaration, depth)
    if (wrapper) {
      return { ...wrapper, reference }
    }
  }
  return null
}

/** The identifier whose scope lookup decides the callee. Bare identifiers and
 *  property names both bind to exactly one symbol per file, which is what makes
 *  the per-symbol cache below correct. */
function calleeBindingIdentifier(expression) {
  if (ts.isIdentifier(expression)) {
    return expression
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return expression.name
  }
  return undefined
}

/** The sink this call writes through, or null. Base sinks match by declaration
 *  identity; anything else that resolves to a repo function is probed for
 *  parameter-forwarding.
 *
 *  Cached per callee symbol: resolving 44k call sites one at a time cost 4.3s,
 *  and every call to the same binding has the same answer. The receiver-typed
 *  stream sinks are re-checked per call because their answer is not. */
export function classifyCall(index, call, depth = 0) {
  const binding = calleeBindingIdentifier(call.expression)
  const symbol = binding ? index.project.checker.getSymbolAtLocation(binding) : undefined
  let classified
  if (symbol && index.symbolCache.has(symbol)) {
    classified = index.symbolCache.get(symbol)
  } else {
    const truncationsBefore = index.depthLimitHits
    classified = classifyCallee(index, call, depth)
    // Same reason as wrapperSinkFor: a null that the depth bound produced is
    // not a fact about the callee, so it must not be reused at a shallower
    // call site that could have followed the chain to the end.
    const truncated = classified === null && index.depthLimitHits > truncationsBefore
    if (symbol && !truncated) {
      index.symbolCache.set(symbol, classified)
    }
  }
  if (!classified) {
    return null
  }
  if (classified.needsWriteStreamReceiver && !receiverIsWriteStream(index.project, call)) {
    return null
  }
  return classified
}
