// The names an expression *assembles*, not just the names it spells.
//
// The gate's vocabulary is applied to names. An attacker therefore does not
// have to rename the secret — splitting the name across a syntactic boundary is
// enough, and three of those boundaries defeated the previous gate on a file it
// was already analysing:
//
//   writeFileSync(dir + '/to' + 'ken' + '.json', raw)   // two innocent fragments
//   writeFileSync(`${dir}/oauth-credentials.json`, raw) // template text is not a StringLiteral
//   writeFileSync(p, bag['pass' + 'word'])              // computed key
//
// So before the vocabulary sees anything, statically-known string fragments that
// are *adjacent in the value being built* are concatenated back into maximal
// runs. `'/to' + 'ken' + '.json'` becomes `/token.json` and matches; the
// unknown `dir` breaks the run, which is correct — nothing can be claimed about
// bytes we cannot see.
//
// Every constant lookup goes through the type checker (a string-literal type),
// so `const TOKEN_FILE = 'token.json'` imported from another module folds too.
// A value only known at runtime yields an unknown fragment: it ends the run,
// it never silently disappears.

import ts from 'typescript-api'

const UNKNOWN = { known: false }

function known(text) {
  return { known: true, text }
}

/** The checker's own constant folding for one node: a string-literal type. This
 *  is what makes `const K = 'token' as const` and a const enum member fold,
 *  which no syntactic walk can do. */
function checkerConstant(project, node) {
  let type
  try {
    type = project.checker.getTypeAtLocation(node)
  } catch {
    return undefined
  }
  return type?.isStringLiteral?.() ? type.value : undefined
}

/** Ordered fragments of the string this expression evaluates to. Unknown
 *  fragments are kept in place so adjacency is preserved. */
function fragmentsOf(project, node, depth = 0) {
  if (depth > 6) {
    return [UNKNOWN]
  }
  const constant = checkerConstant(project, node)
  if (constant !== undefined) {
    return [known(constant)]
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [known(node.text)]
  }
  if (ts.isTemplateExpression(node)) {
    const parts = [known(node.head.text)]
    for (const span of node.templateSpans) {
      parts.push(...fragmentsOf(project, span.expression, depth + 1), known(span.literal.text))
    }
    return parts
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [
      ...fragmentsOf(project, node.left, depth + 1),
      ...fragmentsOf(project, node.right, depth + 1)
    ]
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return fragmentsOf(project, node.expression, depth + 1)
  }
  return [UNKNOWN]
}

/** Maximal runs of adjacent statically-known fragments. */
function runsFrom(fragments) {
  const runs = []
  let current = ''
  for (const fragment of fragments) {
    if (fragment.known) {
      current += fragment.text
      continue
    }
    if (current) {
      runs.push(current)
    }
    current = ''
  }
  if (current) {
    runs.push(current)
  }
  return runs
}

/** Composition of a call's arguments, so `join(dir, 'to', 'ken.json')` assembles
 *  the same name `path.join` will. Over-approximates (it ignores the separator
 *  the callee inserts), which can only add a site to review. */
function argumentComposition(project, call, depth) {
  const fragments = []
  for (const argument of call.arguments) {
    fragments.push(...fragmentsOf(project, argument, depth + 1))
  }
  return runsFrom(fragments)
}

/** Every name this expression names or assembles: identifiers, property names,
 *  string literals, folded constants, concatenations, template text, computed
 *  member keys, and the assembled form of each call's arguments.
 *
 *  Replaces a plain identifier/string-literal walk. A name that only exists
 *  after concatenation is exactly the case the walk could not see. */
export function expressionNames(project, node, sink = []) {
  const visit = (current, depth) => {
    if (depth > 12) {
      return
    }
    if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) {
      sink.push(current.text)
      const constant = checkerConstant(project, current)
      if (constant !== undefined) {
        sink.push(constant)
      }
      return
    }
    if (ts.isStringLiteralLike(current)) {
      sink.push(current.text)
      return
    }
    if (ts.isTemplateExpression(current) || ts.isBinaryExpression(current)) {
      sink.push(...runsFrom(fragmentsOf(project, current, 0)))
    }
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      // The computed key IS the property name; `o['pass' + 'word']` names one.
      sink.push(...runsFrom(fragmentsOf(project, current.argumentExpression, 0)))
    }
    if (ts.isCallExpression(current)) {
      sink.push(...argumentComposition(project, current, depth))
    }
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      sink.push(current.name.getText())
    }
    ts.forEachChild(current, (child) => visit(child, depth + 1))
  }
  visit(node, 0)
  return sink
}

/** The assembled runs of one expression, for tests and diagnostics. */
export function assembledRuns(project, node) {
  return runsFrom(fragmentsOf(project, node, 0))
}

/** The full string an expression evaluates to, or undefined when any part of it
 *  is only known at runtime. Unlike the checker's own literal-type folding this
 *  sees `'write' + 'FileSync'`, which TypeScript widens to `string`. */
export function foldedStringValue(project, node) {
  const fragments = fragmentsOf(project, node, 0)
  return fragments.every((fragment) => fragment.known)
    ? fragments.map((fragment) => fragment.text).join('')
    : undefined
}
