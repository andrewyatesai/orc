import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

// Lives beside the installer it protects: every surface that offers to install a
// skill this build already ships must reach that installer. Wiring one CTA and
// leaving nine on the network path compiles, tests green, and ships broken offline.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const BUNDLED_MANIFEST = path.join(REPO_ROOT, 'resources', 'skills', 'current-manifest.json')
const INSTALL_COMMANDS = path.join(REPO_ROOT, 'src', 'shared', 'agent-feature-install-commands.ts')
const OFFLINE_INSTALL = path.join(
  REPO_ROOT,
  'src/renderer/src/lib/bundled-skill-offline-install.ts'
)
const PRELOAD = path.join(REPO_ROOT, 'src', 'preload', 'index.ts')
const SURFACE_ROOTS = ['src/renderer/src', 'src/main', 'src/shared', 'src/preload']
const RE_EXPORT = /export\s*\{[^}]*\}\s*from\s*'[^']*'/g
const OFFLINE_MODULE = /(?:^|[/\\])bundled-skill-offline-install$/
const OFFLINE_IPC_CALL = 'window.api.skills.installBundled'

/**
 * CTAs for a bundled skill that still only hand the user a terminal command.
 *
 * Rows are removed by wiring the surface, never by widening the rule; this test
 * fails on a row whose surface has since been wired or deleted.
 */
const CTAS_STILL_ON_THE_NETWORK_PATH = new Map([
  [
    'src/renderer/src/components/feature-tips/CliSkillSetupTerminal.tsx',
    'copy/paste + inline terminal only; offers no offline install of orca-cli or orchestration'
  ],
  [
    'src/renderer/src/components/settings/linear-agent-skill-install-cta.tsx',
    'copy-command only; the sibling sidebar prompt for the same skill installs offline'
  ]
])

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

function bundledSkillNames(): string[] {
  const manifest = JSON.parse(read(BUNDLED_MANIFEST)) as { skills: { name: string }[] }
  return manifest.skills.map((skill) => skill.name)
}

/** Each exported install-command constant, mapped to the skills its command installs. */
function installCommandsBySkill(): Map<string, string[]> {
  const source = read(INSTALL_COMMANDS)
  const skillNames = new Map(
    [...source.matchAll(/export const (\w+_SKILL_NAME) = '([^']+)'/g)].map((match) => [
      match[1],
      match[2]
    ])
  )
  const commands = source.matchAll(
    /export const (\w+_INSTALL_COMMAND) = buildAgentFeatureSkillInstallCommand\(\[([\s\S]*?)\]\)/g
  )
  return new Map(
    [...commands].map((match) => [
      match[1],
      [...match[2].matchAll(/\w+_SKILL_NAME/g)].flatMap(
        (reference) => skillNames.get(reference[0]) ?? []
      )
    ])
  )
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => {
    walk(child, visit)
  })
}

type TopLevelDeclaration = { node: ts.Node; exported: boolean }

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
}

function topLevelDeclarations(sourceFile: ts.SourceFile): Map<string, TopLevelDeclaration> {
  const declarations = new Map<string, TopLevelDeclaration>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, { node: statement, exported: isExported(statement) })
      continue
    }
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        declarations.set(declaration.name.text, {
          node: declaration,
          exported: isExported(declaration)
        })
      }
    }
  }
  return declarations
}

/** What this subtree calls — `foo()` and `a.b.c()`. A comment or string is neither. */
function callTargets(node: ts.Node): Set<string> {
  const targets = new Set<string>()
  walk(node, (current) => {
    if (!ts.isCallExpression(current)) {
      return
    }
    if (ts.isIdentifier(current.expression)) {
      targets.add(current.expression.text)
      return
    }
    if (ts.isPropertyAccessExpression(current.expression)) {
      targets.add(current.expression.getText())
    }
  })
  return targets
}

/** Identifiers this subtree references, ignoring member and property-key names. */
function referencedNames(node: ts.Node): Set<string> {
  const names = new Set<string>()
  walk(node, (current) => {
    if (!ts.isIdentifier(current)) {
      return
    }
    const parent = current.parent as ts.Node | undefined
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === current) {
      return
    }
    if (parent && ts.isPropertyAssignment(parent) && parent.name === current) {
      return
    }
    names.add(current.text)
  })
  return names
}

/** Top-level statements that run on import, so their calls are live without a caller. */
function moduleLoadRoots(sourceFile: ts.SourceFile): ts.Node[] {
  return sourceFile.statements.flatMap((statement): ts.Node[] => {
    if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
      return []
    }
    if (!ts.isVariableStatement(statement)) {
      return [statement]
    }
    return statement.declarationList.declarations.flatMap((declaration): ts.Node[] =>
      declaration.initializer &&
      !ts.isArrowFunction(declaration.initializer) &&
      !ts.isFunctionExpression(declaration.initializer)
        ? [declaration.initializer]
        : []
    )
  })
}

/** Declarations an importer can reach: the exports, plus whatever they call. */
function reachableDeclarations(sourceFile: ts.SourceFile): Map<string, TopLevelDeclaration> {
  const declarations = topLevelDeclarations(sourceFile)
  const reachable = new Set<string>()
  const queue: string[] = []
  const enqueue = (name: string): void => {
    if (declarations.has(name) && !reachable.has(name)) {
      reachable.add(name)
      queue.push(name)
    }
  }
  for (const [name, declaration] of declarations) {
    if (declaration.exported) {
      enqueue(name)
    }
  }
  for (const root of moduleLoadRoots(sourceFile)) {
    for (const name of referencedNames(root)) {
      enqueue(name)
    }
  }
  while (queue.length > 0) {
    const name = queue.pop() as string
    for (const referenced of referencedNames(
      (declarations.get(name) as TopLevelDeclaration).node
    )) {
      enqueue(referenced)
    }
  }
  return new Map([...declarations].filter(([name]) => reachable.has(name)))
}

/** Exports of the offline module that reach the installer, directly or through a sibling. */
function offlineInstallEntryPoints(): string[] {
  const sourceFile = parse(OFFLINE_INSTALL, read(OFFLINE_INSTALL))
  const declarations = topLevelDeclarations(sourceFile)
  const reaching = new Set<string>()
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, declaration] of declarations) {
      const calls = callTargets(declaration.node)
      const reaches =
        calls.has(OFFLINE_IPC_CALL) || [...reaching].some((entryPoint) => calls.has(entryPoint))
      if (!reaching.has(name) && reaches) {
        reaching.add(name)
        changed = true
      }
    }
  }
  return [...reaching].filter((name) => declarations.get(name)?.exported)
}

type OfflineImports = { named: Map<string, string>; namespaces: Set<string> }

function offlineImports(sourceFile: ts.SourceFile): OfflineImports {
  const named = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const clause = statement.importClause
    if (!OFFLINE_MODULE.test(statement.moduleSpecifier.text) || !clause || clause.isTypeOnly) {
      continue
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text)
      continue
    }
    for (const element of clause.namedBindings?.elements ?? []) {
      if (!element.isTypeOnly) {
        named.set(element.name.text, (element.propertyName ?? element.name).text)
      }
    }
  }
  return { named, namespaces }
}

/**
 * Offline entry points this file actually calls from code an importer can reach.
 *
 * The point of parsing: a mention in a comment, a string, an import nobody calls, or
 * a helper nothing references is exactly the textual residue a deleted call leaves.
 *
 * What makes "calls an entry point" mean "installs offline" is the click test in
 * `bundled-skill-offline-install-panel-click.test.ts`. Rendering all fourteen CTAs
 * instead is not open to us: each needs its own stores, runtimes and contexts, and a
 * surface added tomorrow could not be rendered by a test that finds it on disk.
 */
function offlineEntryPointCalls(file: string, entryPoints: readonly string[]): string[] {
  const sourceFile = parse(file, read(file))
  const { named, namespaces } = offlineImports(sourceFile)
  if (named.size === 0 && namespaces.size === 0) {
    return []
  }
  const entries = new Set(entryPoints)
  const called = new Set<string>()
  const collect = (node: ts.Node): void => {
    for (const target of callTargets(node)) {
      const imported = named.get(target)
      if (imported && entries.has(imported)) {
        called.add(imported)
        continue
      }
      const [namespace, member] = target.split('.')
      if (namespaces.has(namespace) && entries.has(member)) {
        called.add(member)
      }
    }
  }
  for (const declaration of reachableDeclarations(sourceFile).values()) {
    collect(declaration.node)
  }
  for (const root of moduleLoadRoots(sourceFile)) {
    collect(root)
  }
  return [...called]
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(entryPath)
    }
    return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [entryPath] : []
  })
}

function mentions(source: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(source)
}

/** A commented-out call is not a call, so reachability must read code, not text. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Files that name an install command for a bundled skill — the CTAs, minus re-exports. */
function bundledSkillInstallSurfaces(commands: string[]): Map<string, string> {
  const surfaces = new Map<string, string>()
  for (const root of SURFACE_ROOTS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
      if (file === INSTALL_COMMANDS) {
        continue
      }
      // A pass-through re-export is not a surface; whoever imports it is.
      const source = code(read(file)).replace(RE_EXPORT, '')
      if (commands.some((command) => mentions(source, command))) {
        surfaces.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), file)
      }
    }
  }
  return surfaces
}

describe('every bundled-skill CTA can install from the app bundle', () => {
  const bundled = bundledSkillNames()
  const commands = installCommandsBySkill()
  const bundledCommands = [...commands]
    .filter(([, skills]) => skills.some((skill) => bundled.includes(skill)))
    .map(([command]) => command)
  const surfaces = bundledSkillInstallSurfaces(bundledCommands)
  const entryPoints = offlineInstallEntryPoints()
  const wiring = new Map(
    [...surfaces].map(([name, file]) => [name, offlineEntryPointCalls(file, entryPoints)])
  )

  it('derives skills, commands, surfaces and wiring from data rather than a hand list', () => {
    expect(bundled.length).toBeGreaterThan(0)
    expect(commands.size).toBeGreaterThan(0)
    expect(bundledCommands.length).toBeGreaterThan(0)
    expect(entryPoints.length).toBeGreaterThan(0)
    // An empty surface set would make the wiring check below pass by enumerating nothing.
    expect(surfaces.size).toBeGreaterThan(0)
    // Zero calls anywhere means the parse stopped resolving them, not that CTAs are wired.
    expect([...wiring.values()].flat().length).toBeGreaterThan(0)
    // Every command names skills that exist; a renamed skill must not silently drop out.
    expect([...commands.values()].filter((skills) => skills.length === 0)).toEqual([])
  })

  it('offers the offline install on every surface that installs a bundled skill', () => {
    const unwired = [...wiring].filter(([, calls]) => calls.length === 0).map(([file]) => file)

    expect(unwired.filter((file) => !CTAS_STILL_ON_THE_NETWORK_PATH.has(file))).toEqual([])
  })

  it('keeps the acknowledged-debt list accurate as CTAs are wired', () => {
    const acknowledged = [...CTAS_STILL_ON_THE_NETWORK_PATH.keys()]

    expect(acknowledged.filter((file) => !surfaces.has(file))).toEqual([])
    expect(acknowledged.filter((file) => (wiring.get(file) ?? []).length > 0)).toEqual([])
  })
})

/** Where the renderer's call actually lands: preload channel, main handler, real caller. */
describe('the offline install rail is constructed in production', () => {
  const offlineSource = read(OFFLINE_INSTALL)
  const mainFiles = sourceFiles(path.join(REPO_ROOT, 'src', 'main'))

  it('routes the renderer call to a channel a main handler registers and a bootstrap wires', () => {
    expect(offlineSource).toContain(OFFLINE_IPC_CALL)

    const channel = /installBundled[\s\S]{0,300}?ipcRenderer\.invoke\('([^']+)'/.exec(
      read(PRELOAD)
    )?.[1]
    expect(channel).toBeTruthy()

    const registration = new RegExp(`ipcMain\\.handle\\(\\s*'${channel}'`)
    const handlers = mainFiles.filter((file) => registration.test(code(read(file))))
    expect(handlers).toHaveLength(1)

    // The registrar is dead code until a bootstrap calls it — the exact shape of the
    // handler that was written, wired to nothing, and shipped.
    const handlerSource = code(read(handlers[0]))
    const declarations = [...handlerSource.matchAll(/export function (\w+)/g)]
    const registrar = declarations.findLast(
      (declaration) => (declaration.index ?? 0) < handlerSource.indexOf(`'${channel}'`)
    )?.[1]
    expect(registrar).toBeTruthy()

    const callers = mainFiles.filter(
      (file) => file !== handlers[0] && code(read(file)).includes(`${registrar}(`)
    )
    expect(callers.length).toBeGreaterThan(0)
  })
})
