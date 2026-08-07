// Facts about a call expression that a text match cannot produce: which symbol
// the callee actually resolves to, which module declares it, and which
// arguments are genuine literals in argument position (not a substring that
// happens to appear in the file).

import ts from 'typescript-api'

import { displayPath, normalizeProgramPath } from './typescript-program-cache.mjs'
import { resolveReference } from './typescript-symbol-identity.mjs'

/** Ambient/`declare module` name when the callee comes from a package with no
 *  file-backed declaration, otherwise undefined. */
function ambientModuleName(declaration) {
  let current = declaration
  while (current) {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) {
      return current.name.text
    }
    current = current.parent
  }
  return undefined
}

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { literal: true, value: node.text, kind: 'string' }
  }
  if (ts.isNumericLiteral(node)) {
    return { literal: true, value: Number(node.text), kind: 'number' }
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return { literal: true, value: true, kind: 'boolean' }
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return { literal: true, value: false, kind: 'boolean' }
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return { literal: true, value: null, kind: 'null' }
  }
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const magnitude = Number(node.operand.text)
    if (node.operator === ts.SyntaxKind.MinusToken) {
      return { literal: true, value: -magnitude, kind: 'number' }
    }
    if (node.operator === ts.SyntaxKind.PlusToken) {
      return { literal: true, value: magnitude, kind: 'number' }
    }
  }
  return { literal: false, value: undefined, kind: ts.SyntaxKind[node.kind] }
}

function constantValue(checker, node) {
  const type = checker.getTypeAtLocation(node)
  if (type.isStringLiteral() || type.isNumberLiteral()) {
    return { constant: true, value: type.value }
  }
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    return { constant: true, value: checker.typeToString(type) === 'true' }
  }
  return { constant: false, value: undefined }
}

/** Everything a gate should need about one call site. `calleeText` is present
 *  for messages ONLY — matching on it is the bug this module exists to remove.
 *  `declaringModule` is an absolute normalized path, an ambient module name, or
 *  null when the callee is unresolvable or locally declared without a file. */
export function callSiteFacts(project, call) {
  const callee = call.expression
  const reference = resolveReference(project, callee)
  const declaration = reference?.declarations?.[0]
  const declaringFile = declaration
    ? normalizeProgramPath(declaration.getSourceFile().fileName)
    : null
  const ambient = declaration ? ambientModuleName(declaration) : undefined

  const args = call.arguments.map((argument, index) => {
    const literal = literalValue(argument)
    const constant = constantValue(project.checker, argument)
    return {
      index,
      node: argument,
      ...literal,
      constantValue: constant.value,
      isConstant: constant.constant
    }
  })

  const position = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart())
  return {
    call,
    project,
    /** Source text of the callee expression — diagnostics only. */
    calleeText: callee.getText(),
    reference,
    resolved: Boolean(reference?.symbol),
    declaringModule: ambient ?? declaringFile,
    isAmbient: Boolean(ambient),
    /** False for `import type` callees and callees with no value meaning. */
    isRuntimeCall: Boolean(reference?.isRuntimeValueReference),
    arguments: args,
    location: `${displayPath(call.getSourceFile().fileName)}:${position.line + 1}:${position.character + 1}`
  }
}

/** The literal string at `index`, or undefined when the argument is missing or
 *  is anything other than a genuine string-literal AST node in that argument
 *  slot. A template with substitutions, a variable, or a concatenation all
 *  return undefined. */
export function literalStringArgument(call, index) {
  const argument = call.arguments[index]
  if (!argument) {
    return undefined
  }
  const literal = literalValue(argument)
  return literal.literal && literal.kind === 'string' ? literal.value : undefined
}

/** The checker's constant folding of argument `index` — sees through
 *  `const KEY = 'x'; f(KEY)` and const enums, which the syntactic form cannot.
 *  Still returns undefined for anything computed at runtime. */
export function constantStringArgument(project, call, index) {
  const argument = call.arguments[index]
  if (!argument) {
    return undefined
  }
  const constant = constantValue(project.checker, argument)
  return typeof constant.value === 'string' ? constant.value : undefined
}
