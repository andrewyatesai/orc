// "Is this write behind the sanctioned plaintext opt-in?"
//
// Two things must both hold, and each kills a different attack:
//   IDENTITY   the condition calls a declaration in the sanctioned registry.
//              Resolved through the checker, so a renamed import, a re-export,
//              a namespace member and a `type`-only import are all handled, and
//              a local `function allowsPlaintextPersistedSecret()` shadow is
//              simply a different declaration — it does not satisfy anything.
//   STRUCTURE  the write is in the branch the predicate *selects*, and the
//              predicate call is evaluated on every path reaching the write.
//              A call in a dead branch, a sibling `if`, a loop body or another
//              function satisfies neither half.
//
// The registry is (module, name) pairs resolved to declarations. A predicate
// that is only a file-local function can guard writes in its own file alone;
// that is a property of the codebase, not of this resolver, and it is reported
// as `fileLocal: true` so a reviewer can see why a cross-file write cannot
// currently be gated.

import path from 'node:path'

import ts from 'typescript-api'

import { evaluationDominates } from './typescript-guard-dominance.mjs'
import { REPO_ROOT, normalizeProgramPath } from './typescript-program-cache.mjs'
import { declarationKey, resolveReference } from './typescript-symbol-identity.mjs'

/** The reviewed opt-in predicates. Adding one is a security decision: it must
 *  refuse in packaged/production builds and require an explicit env opt-in. */
export const SANCTIONED_POLICY_PREDICATES = [
  // Exported from one module so every store shares one opt-in decision; a per-file copy would be a
  // different declaration and would have to be sanctioned separately.
  { module: 'src/main/plaintext-secret-policy.ts', name: 'allowsPlaintextPersistedSecret' },
  {
    module: 'src/main/orca-profiles/profile-cloud-auth-config.ts',
    name: 'allowsPlaintextOrcaCloudSession'
  }
]

function topLevelDeclaration(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return statement
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          return declaration
        }
      }
    }
  }
  return undefined
}

/** Declaration keys of every sanctioned predicate this project can see, plus
 *  the ones it cannot. A missing predicate is reported as a coverage limit, not
 *  shrugged off: an entry that stops resolving makes every write it guards read
 *  as ungated, and the reader has to be told that rather than shown the number. */
export function resolvePolicyPredicates(project, registry = SANCTIONED_POLICY_PREDICATES) {
  const keys = new Map()
  const resolved = []
  const missing = []
  for (const entry of registry) {
    const absolute = path.isAbsolute(entry.module)
      ? entry.module
      : path.join(REPO_ROOT, entry.module)
    const wanted = normalizeProgramPath(absolute)
    const sourceFile = project.program
      .getSourceFiles()
      .find((file) => normalizeProgramPath(file.fileName) === wanted)
    if (!sourceFile) {
      missing.push({ ...entry, reason: 'module not in this project' })
      continue
    }
    const declaration = topLevelDeclaration(sourceFile, entry.name)
    if (!declaration) {
      missing.push({ ...entry, reason: 'no top-level declaration with that name' })
      continue
    }
    const exported = Boolean(
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      declaration.parent?.parent?.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    )
    keys.set(declarationKey(declaration), entry)
    resolved.push({ ...entry, fileLocal: !exported })
  }
  return { keys, resolved, missing }
}

function callMatchesPredicate(project, call, keys) {
  const reference = resolveReference(project, call.expression)
  if (!reference?.isRuntimeValueReference) {
    return undefined
  }
  for (const key of reference.declarationKeys) {
    const entry = keys.get(key)
    if (entry) {
      return { entry, call }
    }
  }
  return undefined
}

/** A condition expression that is true exactly when the predicate allowed the
 *  write. `polarity` false means the expression is the negation. Only
 *  structures whose truth value is *determined* by the predicate count: `&&`
 *  chains and `!`; a `||` with the predicate on one side does not, because the
 *  branch can be taken without the predicate holding. */
function predicateTest(project, expression, keys, polarity = true) {
  if (!expression) {
    return undefined
  }
  if (ts.isParenthesizedExpression(expression)) {
    return predicateTest(project, expression.expression, keys, polarity)
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return predicateTest(project, expression.operand, keys, !polarity)
  }
  if (ts.isCallExpression(expression)) {
    const match = callMatchesPredicate(project, expression, keys)
    return match ? { ...match, polarity } : undefined
  }
  if (ts.isBinaryExpression(expression)) {
    const { kind } = expression.operatorToken
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken && polarity) {
      return (
        predicateTest(project, expression.left, keys, polarity) ??
        predicateTest(project, expression.right, keys, polarity)
      )
    }
    if (kind === ts.SyntaxKind.BarBarToken && !polarity) {
      return (
        predicateTest(project, expression.left, keys, polarity) ??
        predicateTest(project, expression.right, keys, polarity)
      )
    }
    if (
      kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      kind === ts.SyntaxKind.EqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      const negated =
        kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsToken
      const literal =
        expression.right.kind === ts.SyntaxKind.TrueKeyword
          ? true
          : expression.right.kind === ts.SyntaxKind.FalseKeyword
            ? false
            : undefined
      if (literal === undefined) {
        return undefined
      }
      const effective = literal === !negated ? polarity : !polarity
      return predicateTest(project, expression.left, keys, effective)
    }
  }
  return undefined
}

function alwaysExits(statement) {
  if (!statement) {
    return false
  }
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return true
  }
  if (ts.isBlock(statement)) {
    return statement.statements.some(alwaysExits)
  }
  return false
}

/** Walks out from the write to the enclosing function, looking for the branch
 *  structure that makes the predicate decide whether the write happens. */
function structuralGuard(project, writeCall, keys) {
  let child = writeCall
  let parent = writeCall.parent
  while (parent) {
    if (ts.isIfStatement(parent)) {
      const inThen = child === parent.thenStatement
      const inElse = child === parent.elseStatement
      if (inThen || inElse) {
        const test = predicateTest(project, parent.expression, keys)
        if (test && test.polarity === inThen) {
          return test
        }
      }
    }
    if (ts.isConditionalExpression(parent)) {
      const inTrue = child === parent.whenTrue
      const inFalse = child === parent.whenFalse
      if (inTrue || inFalse) {
        const test = predicateTest(project, parent.condition, keys)
        if (test && test.polarity === inTrue) {
          return test
        }
      }
    }
    if (ts.isBinaryExpression(parent) && child === parent.right) {
      const positive = parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      const negative = parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
      if (positive || negative) {
        const test = predicateTest(project, parent.left, keys)
        if (test && test.polarity === positive) {
          return test
        }
      }
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const index = parent.statements.indexOf(child)
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const statement = parent.statements[earlier]
        if (
          !ts.isIfStatement(statement) ||
          !alwaysExits(statement.thenStatement) ||
          statement.elseStatement
        ) {
          continue
        }
        const test = predicateTest(project, statement.expression, keys)
        if (test && test.polarity === false) {
          return test
        }
      }
    }
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isSourceFile(parent)
    ) {
      return undefined
    }
    child = parent
    parent = parent.parent
  }
  return undefined
}

/** The sanctioned predicate that gates this write, or undefined. Requires the
 *  branch structure AND independent dominance of the predicate call, so a
 *  predicate call parked in a dead branch never counts. */
export function sanctionedGuardFor(project, writeCall, predicates) {
  const guard = structuralGuard(project, writeCall, predicates.keys)
  if (!guard) {
    return undefined
  }
  if (!evaluationDominates(guard.call, writeCall)) {
    return undefined
  }
  return guard
}
