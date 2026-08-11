// A position-independent fingerprint of ONE call, used to tell sibling write
// sites apart inside the same function.
//
// The identity it replaces was an ordinal — "the second write through this sink
// in this function" — which re-keys every later sibling the moment a write is
// inserted above them. The carried review then detaches from the code it
// describes, silently, on an edit that did not touch it.
//
// So the discriminator is derived from the call ITSELF:
//   * one structural token per argument (what KIND of expression it is, plus
//     the semantic names it carries — the property read, the callee called, the
//     keys of an object literal), and
//   * the string-literal text found anywhere inside the call, which is what
//     actually distinguishes sibling log/diagnostic writes from each other.
//
// Deliberately NOT part of it: identifier names of locals and parameters (a
// rename must not re-key), formatting, comments, line and column. Deliberately
// part of it: object-literal keys and literal text — when the PAYLOAD of a
// credential write changes shape, re-review is the right outcome.
//
// Residual, stated plainly: two sibling calls with the same shape AND the same
// literals are told apart by source order, so inserting an identical twin above
// one of them still re-keys it. `assignSiteIds` marks those with a `~n` suffix,
// which is the visible sign that a site is ordinal-identified after all.

import { createHash } from 'node:crypto'

import ts from 'typescript-api'

/** Nesting depth at which an argument stops being described structurally. */
const MAX_DEPTH = 2
const MAX_LITERALS = 6
const MAX_LITERAL_CHARS = 24

function unwrap(node) {
  let current = node
  for (;;) {
    const inner =
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      (ts.isSatisfiesExpression?.(current) ?? false)
        ? current.expression
        : null
    if (!inner) {
      return current
    }
    current = inner
  }
}

function memberName(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : '?'
}

function objectKeys(node) {
  const keys = node.properties.map((property) =>
    ts.isSpreadAssignment(property) ? '...' : memberName(property.name)
  )
  return [...new Set(keys)].sort().join(',')
}

function calleeName(expression) {
  const callee = unwrap(expression)
  if (ts.isIdentifier(callee)) {
    return callee.text
  }
  return ts.isPropertyAccessExpression(callee) ? memberName(callee.name) : '?'
}

/** One token per argument. Depth-bounded so a deeply nested literal cannot make
 *  the fingerprint grow without limit. */
function token(node, depth) {
  const current = unwrap(node)
  if (ts.isSpreadElement(current)) {
    return `...${token(current.expression, depth)}`
  }
  if (ts.isIdentifier(current)) {
    return 'ref'
  }
  if (ts.isPropertyAccessExpression(current)) {
    return `ref.${memberName(current.name)}`
  }
  if (ts.isElementAccessExpression(current)) {
    return 'ref[]'
  }
  if (ts.isObjectLiteralExpression(current)) {
    return depth >= MAX_DEPTH ? 'obj' : `obj{${objectKeys(current)}}`
  }
  if (ts.isArrayLiteralExpression(current)) {
    return `arr[${current.elements.length}]`
  }
  if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
    return `call:${calleeName(current.expression)}`
  }
  if (ts.isConditionalExpression(current)) {
    return depth >= MAX_DEPTH
      ? 'cond'
      : `cond(${token(current.whenTrue, depth + 1)},${token(current.whenFalse, depth + 1)})`
  }
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    return 'fn'
  }
  if (ts.isBinaryExpression(current)) {
    return 'bin'
  }
  if (ts.isTemplateExpression(current)) {
    return 'tpl'
  }
  if (ts.isStringLiteralLike(current)) {
    return 'str'
  }
  if (ts.isNumericLiteral(current)) {
    return 'num'
  }
  return ts.SyntaxKind[current.kind]
}

function clip(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_LITERAL_CHARS ? collapsed.slice(0, MAX_LITERAL_CHARS) : collapsed
}

/** Every string the call mentions, including the fixed chunks of a template —
 *  the holes are dropped, so renaming an interpolated local changes nothing. */
function literalTexts(call) {
  const found = new Set()
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      found.add(clip(node.text))
    } else if (ts.isTemplateExpression(node)) {
      found.add(clip(node.head.text))
      for (const span of node.templateSpans) {
        found.add(clip(span.literal.text))
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(call, visit)
  found.delete('')
  return [...found].sort().slice(0, MAX_LITERALS)
}

/** Human-readable fingerprint. Kept readable (and carried in `--json`) so a
 *  reviewer reconciling a detached note can see what the write looked like. */
export function callShape(call) {
  const args = (call.arguments ?? []).map((argument) => token(argument, 0)).join(',')
  const literals = literalTexts(call)
  return literals.length > 0 ? `${args}#${literals.join('|')}` : args
}

/** The form that goes into a site id: short, and stable for as long as the
 *  shape is. Truncation is fine — a collision inside one function + one sink
 *  costs a `~n` suffix, not a wrong answer. */
export function callShapeDigest(call) {
  return createHash('sha256').update(callShape(call)).digest('hex').slice(0, 10)
}
