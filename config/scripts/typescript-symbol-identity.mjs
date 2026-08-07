// Symbol identity for the semantic verification gates: "does this identifier
// resolve to the export S of module M, and is that binding a real runtime
// door?"
//
// Everything here compares *declaration identity*, never names. That is what
// survives import renaming, re-export laundering, namespace imports and local
// shadowing — none of which change where a symbol is declared, and all of which
// defeat a name match.

import ts from 'typescript-api'

import { normalizeProgramPath, displayPath } from './typescript-program-cache.mjs'

const VALUE_MEANING =
  ts.SymbolFlags.Variable |
  ts.SymbolFlags.Property |
  ts.SymbolFlags.EnumMember |
  ts.SymbolFlags.Function |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum |
  ts.SymbolFlags.ValueModule |
  ts.SymbolFlags.Method |
  ts.SymbolFlags.GetAccessor |
  ts.SymbolFlags.SetAccessor |
  ts.SymbolFlags.ObjectLiteral

/** Program-independent identity of a declaration: two Programs that both parse
 *  src/shared/x.ts produce different node objects but the same key. Span AND
 *  kind are both required — a SourceFile and its first statement share pos 0,
 *  which silently equated a namespace import with the export it wraps. */
export function declarationKey(declaration) {
  const file = normalizeProgramPath(declaration.getSourceFile().fileName)
  return `${file}#${declaration.pos}:${declaration.end}:${declaration.kind}`
}

function isTypeOnlyDeclaration(declaration) {
  if (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration)) {
    if (declaration.isTypeOnly) {
      return true
    }
  }
  if (ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration)) {
    const clause = ts.isImportSpecifier(declaration)
      ? declaration.parent.parent
      : declaration.parent
    return Boolean(clause?.isTypeOnly)
  }
  if (ts.isImportClause(declaration)) {
    return Boolean(declaration.isTypeOnly)
  }
  if (ts.isExportSpecifier(declaration)) {
    return Boolean(declaration.parent.parent.isTypeOnly)
  }
  if (ts.isNamespaceExport(declaration)) {
    return Boolean(declaration.parent.isTypeOnly)
  }
  if (ts.isImportEqualsDeclaration(declaration)) {
    return Boolean(declaration.isTypeOnly)
  }
  return false
}

/** Follows import/export alias hops to the symbol's original declaration.
 *  Returns {symbol, hops, typeOnlyHop} — typeOnlyHop is true when ANY hop was
 *  written `import type` / `export type` / `{ type X }`, i.e. the whole chain
 *  is erased before it reaches runtime. */
export function unwrapAlias(checker, startSymbol) {
  let symbol = startSymbol
  const hops = []
  let typeOnlyHop = false
  const seen = new Set()
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    if (seen.has(symbol)) {
      break
    }
    seen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
      hops.push(declaration)
      if (isTypeOnlyDeclaration(declaration)) {
        typeOnlyHop = true
      }
    }
    let next
    try {
      next = checker.getImmediateAliasedSymbol(symbol)
    } catch {
      next = undefined
    }
    if (!next || next === symbol) {
      break
    }
    symbol = next
  }
  return { symbol, hops, typeOnlyHop }
}

/** The import/export binding this identifier belongs to, if any. Needed because
 *  the checker resolves a specifier's propertyName straight to the target
 *  symbol, hiding the `type` marker that erases the whole binding. */
function enclosingModuleBinding(node) {
  let current = node.parent
  while (current) {
    if (
      ts.isImportSpecifier(current) ||
      ts.isExportSpecifier(current) ||
      ts.isImportClause(current) ||
      ts.isNamespaceImport(current) ||
      ts.isNamespaceExport(current) ||
      ts.isImportEqualsDeclaration(current)
    ) {
      return current
    }
    if (
      ts.isImportDeclaration(current) ||
      ts.isExportDeclaration(current) ||
      ts.isStatement(current)
    ) {
      return undefined
    }
    current = current.parent
  }
  return undefined
}

/** True when the reference sits in a position TypeScript erases: a type
 *  annotation, `typeof` query, `implements` clause, type argument, `as`/
 *  `satisfies` target. A reference in an erased position is not a runtime door
 *  even though the text names the symbol. */
export function isValuePosition(node) {
  let child = node
  let parent = node.parent
  while (parent) {
    if (ts.isExpressionWithTypeArguments(parent)) {
      const heritage = parent.parent
      const isClassExtends =
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent))
      return isClassExtends
    }
    if (
      ts.isTypeQueryNode(parent) ||
      ts.isTypeNode(parent) ||
      ts.isTypeParameterDeclaration(parent)
    ) {
      return false
    }
    if (
      (ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression?.(parent)) &&
      child === parent.type
    ) {
      return false
    }
    if (ts.isImportTypeNode(parent)) {
      return false
    }
    if (ts.isSourceFile(parent)) {
      return true
    }
    child = parent
    parent = parent.parent
  }
  return true
}

function referenceIdentifier(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name
  }
  if (ts.isQualifiedName(node)) {
    return node.right
  }
  return node
}

/** Full semantic story for one identifier: what it resolves to, where that is
 *  declared, and whether the binding survives to runtime. Returns undefined
 *  only when the checker cannot resolve the name at all (unresolved import,
 *  syntax error). */
export function resolveReference(project, node) {
  const identifier = referenceIdentifier(node)
  const local = project.checker.getSymbolAtLocation(identifier)
  if (!local) {
    return undefined
  }
  return buildReference(project, identifier, local)
}

function buildReference(project, identifier, local) {
  const { checker } = project
  const unwrapped = unwrapAlias(checker, local)
  const { symbol, hops } = unwrapped
  const binding = enclosingModuleBinding(identifier)
  const typeOnlyHop = unwrapped.typeOnlyHop || (binding ? isTypeOnlyDeclaration(binding) : false)
  const declarations = symbol?.declarations ?? []
  const hasValueMeaning = Boolean(symbol && (symbol.flags & VALUE_MEANING) !== 0)
  const valuePosition = isValuePosition(identifier)
  return {
    node: identifier,
    localSymbol: local,
    symbol,
    declarations,
    declarationKeys: declarations.map(declarationKey),
    declaringFiles: [
      ...new Set(declarations.map((d) => normalizeProgramPath(d.getSourceFile().fileName)))
    ],
    aliasHops: hops,
    /** True when the import/export chain was written `type`-only — erased. */
    typeOnlyHop,
    /** True when the resolved symbol has no value meaning (interface, type alias). */
    typeOnlySymbol: Boolean(symbol) && !hasValueMeaning,
    valuePosition,
    /** The only field a gate should use to decide "runtime door exists here". */
    isRuntimeValueReference: hasValueMeaning && !typeOnlyHop && valuePosition
  }
}

/** Resolves `ns['exportName']` and `obj[CONST_KEY]` — a computed member access
 *  is a real runtime door that an identifier walk never sees. Falls back to the
 *  checker's literal type for the key, so a `const K = 'x' as const` indirection
 *  still resolves; a key computed at runtime returns undefined and is covered
 *  by the documented non-goal. */
export function resolveComputedMember(project, elementAccess) {
  const argument = elementAccess.argumentExpression
  if (!argument) {
    return undefined
  }
  let symbol
  if (ts.isStringLiteralLike(argument)) {
    symbol = project.checker.getSymbolAtLocation(argument)
  }
  if (!symbol) {
    const keyType = project.checker.getTypeAtLocation(argument)
    if (!keyType.isStringLiteral()) {
      return undefined
    }
    const objectType = project.checker.getTypeAtLocation(elementAccess.expression)
    symbol = project.checker.getPropertyOfType(objectType, keyType.value)
  }
  return symbol ? buildReference(project, elementAccess, symbol) : undefined
}

/** Describes what a reference resolved to, for gate error messages. Never feed
 *  this back into a comparison — it is prose, not identity. */
export function describeReference(reference) {
  if (!reference?.symbol) {
    return 'unresolved'
  }
  const where = reference.declarations
    .map(
      (d) =>
        `${displayPath(d.getSourceFile().fileName)}:${d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line + 1}`
    )
    .join(', ')
  return `${reference.symbol.getName()} declared at ${where || '<ambient>'}`
}

function moduleSymbolFor(project, moduleFilePath) {
  const key = normalizeProgramPath(moduleFilePath)
  const sourceFile = project.program
    .getSourceFiles()
    .find((file) => normalizeProgramPath(file.fileName) === key)
  if (!sourceFile) {
    return undefined
  }
  return project.checker.getSymbolAtLocation(sourceFile)
}

/** Identity of "export `exportName` of module `moduleFile`", resolved through
 *  that module's own re-export chain, as a set of declaration keys. Omit
 *  exportName to target ANY symbol declared in the module. Keys are
 *  program-independent, so one target can be reused across projects; pass every
 *  project that contains the module so a re-export declared only in one of them
 *  is not missed. */
export function createSymbolTarget(projects, { moduleFile, exportName }) {
  const list = Array.isArray(projects) ? projects : [projects]
  const moduleKey = normalizeProgramPath(moduleFile)
  const declarationKeys = new Set()
  let found = false

  for (const project of list) {
    const moduleSymbol = moduleSymbolFor(project, moduleFile)
    if (!moduleSymbol) {
      continue
    }
    found = true
    if (!exportName) {
      continue
    }
    const exported = project.checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.getName() === exportName)
    if (!exported) {
      continue
    }
    const { symbol } = unwrapAlias(project.checker, exported)
    for (const declaration of symbol?.declarations ?? []) {
      declarationKeys.add(declarationKey(declaration))
    }
  }

  if (!found) {
    throw new Error(`module ${displayPath(moduleFile)} is not in any supplied Program`)
  }
  if (exportName && declarationKeys.size === 0) {
    throw new Error(`module ${displayPath(moduleFile)} does not export '${exportName}'`)
  }

  return {
    moduleKey,
    exportName: exportName ?? null,
    declarationKeys: exportName ? declarationKeys : null,
    label: exportName ? `${displayPath(moduleFile)}#${exportName}` : displayPath(moduleFile)
  }
}

/** True when the resolved symbol IS the target — by declaration identity, so a
 *  renamed import, a laundered re-export and a namespace member all match,
 *  while a local shadow with the right name does not. Says nothing about
 *  whether the reference is a runtime door; check isRuntimeValueReference. */
export function referenceMatchesTarget(reference, target) {
  if (!reference?.symbol) {
    return false
  }
  if (target.declarationKeys) {
    return reference.declarationKeys.some((key) => target.declarationKeys.has(key))
  }
  return reference.declaringFiles.includes(target.moduleKey)
}

/** Convenience: resolve then match. Returns false for anything unresolvable. */
export function resolvesToTarget(project, node, target) {
  return referenceMatchesTarget(resolveReference(project, node), target)
}

/** True when this import binding contributes no runtime import: written
 *  `import type`, or a value-syntax import whose every reference in the file
 *  sits in an erased position. Scans only the declaring file, which is
 *  sufficient because an import binding is file-local. */
export function importBindingIsErased(project, importedNameNode) {
  const reference = resolveReference(project, importedNameNode)
  if (!reference) {
    return true
  }
  if (reference.typeOnlyHop || reference.typeOnlySymbol) {
    return true
  }
  const local = reference.localSymbol
  const sourceFile = importedNameNode.getSourceFile()
  let sawValueUse = false
  const visit = (node) => {
    if (sawValueUse) {
      return
    }
    if (ts.isIdentifier(node) && node !== importedNameNode && node.text === importedNameNode.text) {
      const here = project.checker.getSymbolAtLocation(node)
      if (here === local && isValuePosition(node)) {
        sawValueUse = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return !sawValueUse
}
