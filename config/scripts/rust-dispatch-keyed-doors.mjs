// The declared doors from TypeScript into the Rust core, resolved to declaration
// identities so downstream matching is by symbol, never by text.
//
// WHAT THIS LIST IS, AND WHAT IT IS NOT
// It is a DECLARED INPUT. It is hand-maintained, it is editable in the same
// change as any code it describes, and nothing here verifies that it is
// complete. It is kept only because you cannot look for "calls into Rust"
// without first naming where Rust is entered. `report-rust-orphan-ports.mjs`
// prints this list in full on every run so a reader can see exactly what was
// traced rather than take a number on trust.
//
// It is NOT a trust anchor and no claim of merit rests on it. Earlier versions
// of this machinery reconciled the wasm-bindgen `.d.ts` doors against the pinned
// `.wasm` binary and used that to back a "N modules ship" headline. That headline
// is gone, so the reconciliation it existed to justify is gone too: this module
// reads the `.d.ts` and does not check it against any artifact. A door name
// hand-added to a generated `.d.ts` would be treated as a Rust door here.
//
// WHICH DIRECTION AN EDIT TO THIS LIST MOVES THE REPORT
//   * removing a door  -> modules dispatched through it lose their evidence and
//     appear as orphan CANDIDATES. More review work, never a claim of merit.
//   * adding a fake door -> nothing, unless production also calls it with a real
//     module key, which is a production change and is printed with its file:line.
// Both directions are stated in the report output.

import path from 'node:path'

import ts from 'typescript-api'

import {
  REPO_ROOT,
  declarationKey,
  displayPath,
  normalizeProgramPath
} from './typescript-symbol-resolution.mjs'

/** wasm-bindgen glue exports that load the module rather than enter Rust logic. */
const WASM_GLUE_INFRASTRUCTURE = new Set([
  'initSync',
  'default',
  'init',
  'finalizeInit',
  '__wbindgen_start'
])

/** Every door this report knows how to trace.
 *
 *  keyed: names taking a parity-module key as argument `moduleArgIndex`. Only a
 *         keyed door can ever say WHICH ported module is being dispatched.
 *  perFunctionDoors: true when the module's other exports are themselves Rust
 *         entry points. Those carry a function name, not a module key, so they
 *         can never attribute a module — they are collected only to be reported
 *         as Rust reach this analysis cannot attribute. */
export const DECLARED_DISPATCH_DOORS = Object.freeze([
  {
    id: 'shared-injection-seam',
    kind: 'module-exports',
    moduleFile: 'src/shared/orca-dispatch-seam.ts',
    keyed: ['tryOrcaDispatch', 'requireOrcaDispatch'],
    moduleArgIndex: 0,
    perFunctionDoors: false,
    why: 'surface-agnostic indirection; main/cli install napi, renderer/relay install wasm'
  },
  {
    id: 'main-napi-addon',
    kind: 'type-members',
    moduleFile: 'src/main/daemon/rust-git-addon.ts',
    keyed: ['orcaDispatch'],
    moduleArgIndex: 0,
    perFunctionDoors: false,
    why: 'the orca_node.node napi surface used by the Electron main process'
  },
  {
    id: 'cli-napi-addon',
    kind: 'type-members',
    moduleFile: 'src/cli/orca-dispatch-binding.ts',
    keyed: ['orcaDispatch'],
    moduleArgIndex: 0,
    perFunctionDoors: false,
    why: 'the CLI loads the same orca_node.node through its own local addon type'
  },
  {
    id: 'renderer-git-wasm',
    kind: 'module-exports',
    moduleFile: 'src/renderer/src/lib/git-wasm/orca_git_wasm.d.ts',
    keyed: ['orcaDispatch'],
    moduleArgIndex: 0,
    perFunctionDoors: true,
    why: 'orca-git wasm-bindgen glue loaded by the renderer'
  },
  {
    id: 'relay-git-wasm',
    kind: 'module-exports',
    moduleFile: 'src/relay/wasm/orca_git_wasm.d.ts',
    keyed: ['orcaDispatch'],
    moduleArgIndex: 0,
    perFunctionDoors: true,
    why: 'orca-git wasm-bindgen glue loaded by the SSH relay'
  },
  {
    id: 'node-crypto-wasm',
    kind: 'module-exports',
    moduleFile: 'src/shared/crypto-wasm/orca_crypto_wasm.d.ts',
    keyed: [],
    moduleArgIndex: 0,
    perFunctionDoors: true,
    why: 'orca-crypto wasm-bindgen glue; per-function exports, no keyed aggregate'
  },
  {
    id: 'browser-crypto-wasm',
    kind: 'module-exports',
    moduleFile: 'src/renderer/src/lib/crypto-wasm/orca_crypto_wasm.d.ts',
    keyed: [],
    moduleArgIndex: 0,
    perFunctionDoors: true,
    why: 'orca-crypto wasm-bindgen glue for the renderer'
  }
])

/** Absolute on-disk path of a declared door module. */
export function doorModulePath(door) {
  return path.join(REPO_ROOT, door.moduleFile)
}

function typeMembers(sourceFile) {
  const members = []
  const collect = (node) => {
    if (
      (ts.isPropertySignature(node) || ts.isMethodSignature(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      members.push({ name: node.name.text, declaration: node })
    }
    ts.forEachChild(node, collect)
  }
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      collect(statement)
    }
  }
  return members
}

function moduleExports(project, sourceFile) {
  const moduleSymbol = project.checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) {
    return []
  }
  const members = []
  for (const symbol of project.checker.getExportsOfModule(moduleSymbol)) {
    for (const declaration of symbol.declarations ?? []) {
      // A wasm-bindgen class is as much a Rust entry point as a function:
      // constructing it moves state into linear memory.
      if (
        ts.isFunctionDeclaration(declaration) ||
        ts.isVariableDeclaration(declaration) ||
        ts.isClassDeclaration(declaration)
      ) {
        members.push({ name: symbol.getName(), declaration })
      }
    }
  }
  return members
}

/** One declared door module resolved inside ONE project.
 *
 *  Returns undefined when the project's Program does not contain the module — a
 *  door is not expected in every surface. Returns `missing` names when the
 *  module is present but a declared keyed name is gone: that is a broken
 *  instrument, and the report says so instead of reporting a clean result. */
export function resolveDoorSurface(project, door) {
  const modulePath = doorModulePath(door)
  const sourceFile = project.sourceFileFor(modulePath)
  if (!sourceFile) {
    return undefined
  }

  const members =
    door.kind === 'type-members' ? typeMembers(sourceFile) : moduleExports(project, sourceFile)
  const keyed = new Map()
  const perFunction = new Map()

  for (const { name, declaration } of members) {
    const key = declarationKey(declaration)
    if (door.keyed.includes(name)) {
      keyed.set(key, name)
      continue
    }
    if (door.perFunctionDoors && !WASM_GLUE_INFRASTRUCTURE.has(name)) {
      perFunction.set(key, name)
    }
  }

  const resolvedKeyedNames = new Set(keyed.values())
  const missing = door.keyed.filter((name) => !resolvedKeyedNames.has(name))

  return {
    door,
    moduleKey: normalizeProgramPath(modulePath),
    displayModule: displayPath(modulePath),
    keyed,
    perFunction,
    missing
  }
}

/** Resolve every declared door inside one project, merged into a single
 *  identity target the reference index can walk in one pass. Attribution is read
 *  back off the resolved declaration, so merging cannot change an answer. */
export function resolveDoorsInProject(project, doors = DECLARED_DISPATCH_DOORS) {
  const surfaces = []
  const doorOf = new Map()
  const declarationKeys = new Set()
  const instrumentProblems = []

  for (const door of doors) {
    const surface = resolveDoorSurface(project, door)
    if (!surface) {
      continue
    }
    surfaces.push(surface)
    for (const name of surface.missing) {
      instrumentProblems.push({
        kind: 'declared-door-missing',
        location: door.moduleFile,
        detail:
          `door '${door.id}' (${door.moduleFile}) no longer declares '${name}'; ` +
          'this report cannot trace dispatch through it, so any module that used it will read as an orphan candidate'
      })
    }
    for (const [key, name] of surface.keyed) {
      doorOf.set(key, { doorId: door.id, name, keyed: true, door, surface })
      declarationKeys.add(key)
    }
    for (const [key, name] of surface.perFunction) {
      doorOf.set(key, { doorId: door.id, name, keyed: false, door, surface })
      declarationKeys.add(key)
    }
  }

  return {
    surfaces,
    doorOf,
    instrumentProblems,
    target: { moduleKey: null, exportName: null, declarationKeys, label: 'rust-dispatch-doors' }
  }
}
