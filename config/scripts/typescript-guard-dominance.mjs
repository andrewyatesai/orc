// Dominance, not reachability: "is O guarded by P" is a control-flow question,
// and answering it with "P appears somewhere in this file" is what let a call
// in a dead branch pass a gate.
//
// APPROXIMATION (read before relying on this): a node A dominates node B iff,
// staying inside B's own function, A is reached by walking up from B through
// positions whose evaluation order is *guaranteed*, and A itself sits at an
// unconditionally-evaluated position within a region that provably precedes B.
// Every construct is DENY BY DEFAULT — an unrecognised node kind yields no
// dominators, so the answer is "not guarded" and the gate reports a violation.
// Known deliberate under-approximations, each producing a false positive rather
// than a false negative:
//   * a guard in a different function (helper, wrapper, base class) never counts
//   * a guard inside a `try` that has a `catch` never counts (it may have thrown)
//   * a guard inside a switch case, loop body, or short-circuit right operand
//     never counts
//   * a guard after the first `break`/`continue`-capable statement of a region
//     entered from outside never counts

import ts from 'typescript-api'

const SHORT_CIRCUIT_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken
])

/** The function-ish node whose body owns this node — the boundary dominance
 *  refuses to cross, because a closure may run later, elsewhere, or never. */
export function enclosingFunction(node) {
  let current = node.parent
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassStaticBlockDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isModuleBlock(current) ||
      ts.isSourceFile(current)
    ) {
      return current
    }
    current = current.parent
  }
  return undefined
}

function statementList(node) {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
    return node.statements
  }
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return node.statements
  }
  return undefined
}

/** Nodes definitely evaluated before `child`, given that `parent` is evaluated.
 *  Deny by default: an unmodelled parent kind contributes nothing. */
function precedingRegions(parent, child) {
  const statements = statementList(parent)
  if (statements) {
    const index = statements.indexOf(child)
    return index > 0 ? statements.slice(0, index) : []
  }
  if (ts.isIfStatement(parent)) {
    return child === parent.thenStatement || child === parent.elseStatement
      ? [parent.expression]
      : []
  }
  if (ts.isConditionalExpression(parent)) {
    return child === parent.whenTrue || child === parent.whenFalse ? [parent.condition] : []
  }
  if (ts.isBinaryExpression(parent)) {
    return child === parent.right ? [parent.left] : []
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const args = parent.arguments ?? []
    const index = args.indexOf(child)
    if (index >= 0) {
      return [parent.expression, ...args.slice(0, index)]
    }
    return []
  }
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
    return child === parent.name || child === parent.argumentExpression ? [parent.expression] : []
  }
  if (ts.isVariableDeclarationList(parent)) {
    const index = parent.declarations.indexOf(child)
    return index > 0 ? parent.declarations.slice(0, index) : []
  }
  if (ts.isForStatement(parent)) {
    if (child === parent.statement) {
      return [parent.initializer, parent.condition].filter(Boolean)
    }
    if (child === parent.condition || child === parent.incrementor) {
      return [parent.initializer].filter(Boolean)
    }
    return []
  }
  if (ts.isWhileStatement(parent)) {
    return child === parent.statement ? [parent.expression] : []
  }
  if (ts.isDoStatement(parent)) {
    return child === parent.expression ? [parent.statement] : []
  }
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
    return child === parent.statement ? [parent.expression] : []
  }
  return []
}

/** Child positions evaluated whenever `node` is evaluated. Deny by default. */
function unconditionalChildren(node) {
  // `a?.b(P())` short-circuits: only the chain head is guaranteed to evaluate.
  if (ts.isOptionalChain?.(node)) {
    return node.expression ? [node.expression] : []
  }
  if (ts.isExpressionStatement(node)) {
    return [node.expression]
  }
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isAwaitExpression(node)) {
    return [node.expression].filter(Boolean)
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression?.(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isVoidExpression(node) ||
    ts.isSpreadElement(node)
  ) {
    return [node.expression ?? node.operand].filter(Boolean)
  }
  if (ts.isPostfixUnaryExpression(node)) {
    return [node.operand]
  }
  if (ts.isVariableStatement(node)) {
    return [node.declarationList]
  }
  if (ts.isVariableDeclarationList(node)) {
    return [...node.declarations]
  }
  if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
    return [node.initializer].filter(Boolean)
  }
  if (ts.isBinaryExpression(node)) {
    return SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)
      ? [node.left]
      : [node.left, node.right]
  }
  if (ts.isIfStatement(node)) {
    return [node.expression]
  }
  if (ts.isConditionalExpression(node)) {
    return [node.condition]
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return [node.expression, ...(node.arguments ?? [])]
  }
  if (ts.isPropertyAccessExpression(node)) {
    return [node.expression]
  }
  if (ts.isElementAccessExpression(node)) {
    return [node.expression, node.argumentExpression].filter(Boolean)
  }
  if (ts.isForStatement(node)) {
    return [node.initializer, node.condition].filter(Boolean)
  }
  if (ts.isWhileStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return [node.expression]
  }
  if (ts.isDoStatement(node)) {
    return [node.statement, node.expression]
  }
  if (ts.isLabeledStatement(node)) {
    return [node.statement]
  }
  if (ts.isTryStatement(node)) {
    // A catch clause resumes execution after a partial try block, so nothing in
    // the try body is guaranteed; without one a throw kills every later path.
    const children = node.catchClause ? [] : [node.tryBlock]
    if (node.finallyBlock) {
      children.push(node.finallyBlock)
    }
    return children
  }
  if (ts.isBlock(node)) {
    return [...node.statements]
  }
  if (ts.isArrayLiteralExpression(node)) {
    return [...node.elements]
  }
  if (ts.isObjectLiteralExpression(node)) {
    return [...node.properties]
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.map((span) => span.expression)
  }
  if (ts.isCommaListExpression?.(node)) {
    return [...node.elements]
  }
  return []
}

function containsEarlyExit(node) {
  let found = false
  const visit = (current) => {
    if (found) {
      return
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isClassDeclaration(current)
    ) {
      return
    }
    if (ts.isBreakStatement(current) || ts.isContinueStatement(current)) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

/** Every node guaranteed to be evaluated before `target` on all paths reaching
 *  it, within target's own function. Never includes target or its ancestors. */
export function dominatingNodes(target) {
  const boundary = enclosingFunction(target)
  const dominators = []
  const emit = (region) => {
    const stack = [region]
    while (stack.length > 0) {
      const node = stack.pop()
      dominators.push(node)
      const isStatementList = Boolean(statementList(node))
      for (const child of unconditionalChildren(node)) {
        stack.push(child)
        // A region entered from outside can be abandoned by break/continue, so
        // stop admitting later statements once one can jump out.
        if (isStatementList && containsEarlyExit(child)) {
          break
        }
      }
    }
  }

  let child = target
  let parent = target.parent
  while (parent) {
    for (const region of precedingRegions(parent, child)) {
      emit(region)
    }
    if (parent === boundary) {
      break
    }
    child = parent
    parent = parent.parent
  }
  return dominators
}

/** True when `candidate`'s evaluation is guaranteed to have completed before
 *  `target` is evaluated, on every path that reaches target. Sound in the
 *  reporting direction: false does NOT prove the code is unguarded, it proves
 *  this analysis cannot see a guard. */
export function evaluationDominates(candidate, target) {
  return dominatingNodes(target).includes(candidate)
}

/** The first dominating call expression matching `predicate(call)`, or
 *  undefined. This is the primitive a "must be guarded by P" gate calls: a P in
 *  a dead branch, a sibling `if`, a loop body, or another function is not
 *  returned. */
export function findDominatingCall(target, predicate) {
  for (const node of dominatingNodes(target)) {
    if (ts.isCallExpression(node) && predicate(node)) {
      return node
    }
  }
  return undefined
}

export const DOMINANCE_CONTRACT = `evaluationDominates(A, B) is a sound under-approximation of CFG dominance:
true  => A is evaluated on every path reaching B (trustworthy).
false => this analysis found no such guarantee; it may still hold in reality.
Boundaries that always return false: different function, inside a try-with-catch,
switch case body, loop body, short-circuit right operand, optional-chain tail,
after a break/continue-capable statement in a region entered from outside.`
