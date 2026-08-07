// THE WRITE-SINK CATALOG: which declarations count as "puts bytes on a disk",
// and resolving them against one TypeScript project.
//
// Split from credential-write-sink-model.mjs so the enumeration a reviewer has
// to audit — the fs / fs-promises / FileHandle / SFTP / stream member lists and
// the seeded repo entry points — can be read without the classification walk
// around it. Deciding whether a given CALL hits one of these lives next door.
//
// Identity is the declaration key of the .d.ts / .ts declaration, so
// `import { writeFileSync as w }`, `import * as fs`, a laundering re-export and
// a namespace member all resolve to the same sink, while a local
// `function writeFileSync()` shadow resolves to a different declaration and is
// NOT a sink.

import path from 'node:path'

import ts from 'typescript-api'

import { REPO_ROOT, normalizeProgramPath } from './typescript-program-cache.mjs'
import { declarationKey } from './typescript-symbol-identity.mjs'

/** Slot meanings: `pathSlots` name the destination, `payloadSlots` the bytes.
 *  An empty slot list means "no such slot" (fd- and stream-level writes lose
 *  the path). */
const FS_SINKS = [
  { name: 'writeFile', pathSlots: [0], payloadSlots: [1] },
  { name: 'writeFileSync', pathSlots: [0], payloadSlots: [1] },
  { name: 'appendFile', pathSlots: [0], payloadSlots: [1] },
  { name: 'appendFileSync', pathSlots: [0], payloadSlots: [1] },
  { name: 'write', pathSlots: [], payloadSlots: [1] },
  { name: 'writeSync', pathSlots: [], payloadSlots: [1] },
  { name: 'writev', pathSlots: [], payloadSlots: [1] },
  { name: 'writevSync', pathSlots: [], payloadSlots: [1] },
  { name: 'createWriteStream', pathSlots: [0], payloadSlots: [] }
]

const FS_PROMISES_SINKS = [
  { name: 'writeFile', pathSlots: [0], payloadSlots: [1] },
  { name: 'appendFile', pathSlots: [0], payloadSlots: [1] }
]

const FILE_HANDLE_SINKS = [
  { name: 'write', pathSlots: [], payloadSlots: [0] },
  { name: 'writeFile', pathSlots: [], payloadSlots: [0] },
  { name: 'appendFile', pathSlots: [], payloadSlots: [0] },
  { name: 'writev', pathSlots: [], payloadSlots: [0] }
]

const SFTP_SINKS = [
  { name: 'writeFile', pathSlots: [0], payloadSlots: [1] },
  { name: 'appendFile', pathSlots: [0], payloadSlots: [1] },
  { name: 'createWriteStream', pathSlots: [0], payloadSlots: [] },
  { name: 'fastPut', pathSlots: [1], payloadSlots: [] },
  { name: 'write', pathSlots: [], payloadSlots: [1] },
  { name: 'writev', pathSlots: [], payloadSlots: [1] }
]

/** `stream.end(chunk)` / `stream.write(chunk)` are declared once on Writable, so
 *  matching the declaration alone would also catch stdout and sockets. These
 *  sinks additionally require the receiver's type to be a filesystem or SFTP
 *  write stream. */
const STREAM_SINKS = [
  { name: 'write', pathSlots: [], payloadSlots: [0] },
  { name: 'end', pathSlots: [], payloadSlots: [0] }
]

export const STREAM_RECEIVER_TYPES = ['WriteStream', 'FileHandle']

/** Repo entry points that reach a disk through something this model cannot
 *  follow — a spawned `ssh … cat > path`, or an interface method whose
 *  implementation is chosen at runtime. Resolved by module + export name to a
 *  declaration key, so renaming at any call site changes nothing. Wrappers
 *  around these are derived, not listed. */
export const REPO_WRITE_SEEDS = [
  {
    module: 'src/main/ssh/system-ssh-file-binary-transfer.ts',
    name: 'writeBufferViaSystemSsh',
    pathSlots: [1],
    payloadSlots: [2]
  },
  {
    module: 'src/main/ssh/system-ssh-file-transfer.ts',
    name: 'writeFileViaSystemSsh',
    pathSlots: [1],
    payloadSlots: [2]
  },
  {
    module: 'src/main/ssh/ssh-connection.ts',
    name: 'SshConnection',
    member: 'writeFile',
    pathSlots: [0],
    payloadSlots: [1]
  },
  {
    module: 'src/main/ssh/sftp-upload.ts',
    name: 'writeStringViaSftp',
    pathSlots: [1],
    payloadSlots: [2]
  }
]
/** A resolution context: where declarations land, the declaration NODES (the
 *  analysis scope needs them to name the module a sink lives in), and a
 *  per-spec resolution log. The log is why a rotted sink enumeration is
 *  reportable instead of silently producing a tree with no writes in it. */
function sinkContext(nodes, found) {
  return { index: new Map(), nodes, found }
}

function addDeclarations(context, symbol, sink) {
  let added = false
  for (const declaration of symbol?.declarations ?? []) {
    const key = declarationKey(declaration)
    context.index.set(key, sink)
    context.nodes.set(key, declaration)
    added = true
  }
  context.found.push({ label: `${sink.kind}:${sink.origin}:${sink.name}`, resolved: added })
  return added
}

function ambientSinks(project, moduleName, specs, kind, context) {
  const moduleSymbol = project.checker.tryFindAmbientModule?.(moduleName)
  if (!moduleSymbol) {
    for (const spec of specs) {
      context.found.push({ label: `${kind}:${moduleName}:${spec.name}`, resolved: false })
    }
    return false
  }
  const exports = project.checker.getExportsOfModule(moduleSymbol)
  for (const spec of specs) {
    const symbol = exports.find((candidate) => candidate.getName() === spec.name)
    addDeclarations(context, symbol, { ...spec, kind, origin: moduleName })
  }
  return true
}

function typeMembersFrom(checker, typeSymbol, specs, kind, origin, context) {
  if (!typeSymbol) {
    for (const spec of specs) {
      context.found.push({ label: `${kind}:${origin}:${spec.name}`, resolved: false })
    }
    return
  }
  const declared = checker.getDeclaredTypeOfSymbol(typeSymbol)
  for (const spec of specs) {
    const property = checker.getPropertyOfType(declared, spec.name)
    addDeclarations(context, property, { ...spec, kind, origin })
  }
}

function exportedSymbol(project, moduleFile, name) {
  const key = normalizeProgramPath(moduleFile)
  const sourceFile = project.program
    .getSourceFiles()
    .find((file) => normalizeProgramPath(file.fileName) === key)
  if (!sourceFile) {
    return undefined
  }
  const moduleSymbol = project.checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) {
    return undefined
  }
  return project.checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === name)
}

function repoSeedSinks(project, seeds, context, missing) {
  for (const seed of seeds) {
    const absolute = path.isAbsolute(seed.module) ? seed.module : path.join(REPO_ROOT, seed.module)
    const symbol = exportedSymbol(project, absolute, seed.name)
    if (!symbol) {
      missing.push(seed)
      continue
    }
    if (seed.member) {
      typeMembersFrom(
        project.checker,
        symbol,
        [{ name: seed.member, pathSlots: seed.pathSlots, payloadSlots: seed.payloadSlots }],
        'repo-seed',
        seed.module,
        context
      )
      continue
    }
    const unwrapped =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? project.checker.getAliasedSymbol(symbol)
        : symbol
    addDeclarations(context, unwrapped, {
      name: seed.name,
      pathSlots: seed.pathSlots,
      payloadSlots: seed.payloadSlots,
      kind: 'repo-seed',
      origin: seed.module
    })
  }
}

/** Every base sink declaration visible from this project, keyed by declaration.
 *
 *  `baseSinkResolution` logs one entry per expected sink spec, so the caller can
 *  report exactly which primitives this project could and could not see rather
 *  than trusting a hand-maintained expected-count constant. `missingSeeds` is
 *  non-empty when a seeded repo entry point is absent from the Program. */
export function buildSinkIndex(project, options = {}) {
  const declarationNodes = new Map()
  const baseSinkResolution = []
  const base = sinkContext(declarationNodes, baseSinkResolution)
  const stream = sinkContext(declarationNodes, baseSinkResolution)
  const missingSeeds = []

  const sawFs = ambientSinks(project, 'fs', FS_SINKS, 'fs', base)
  const sawFsPromises = ambientSinks(project, 'fs/promises', FS_PROMISES_SINKS, 'fs/promises', base)

  const fsModule = project.checker.tryFindAmbientModule?.('fs')
  if (fsModule) {
    const exports = project.checker.getExportsOfModule(fsModule)
    const promises = exports.find((s) => s.getName() === 'promises')
    if (promises) {
      const promisesType = project.checker.getTypeOfSymbolAtLocation(
        promises,
        promises.declarations?.[0] ?? project.program.getSourceFiles()[0]
      )
      for (const spec of FS_PROMISES_SINKS) {
        addDeclarations(base, project.checker.getPropertyOfType(promisesType, spec.name), {
          ...spec,
          kind: 'fs/promises',
          origin: 'fs.promises'
        })
      }
    }
    typeMembersFrom(
      project.checker,
      exports.find((s) => s.getName() === 'WriteStream'),
      STREAM_SINKS,
      'stream',
      'fs.WriteStream',
      stream
    )
  }

  const fsPromisesModule = project.checker.tryFindAmbientModule?.('fs/promises')
  if (fsPromisesModule) {
    typeMembersFrom(
      project.checker,
      project.checker
        .getExportsOfModule(fsPromisesModule)
        .find((s) => s.getName() === 'FileHandle'),
      FILE_HANDLE_SINKS,
      'file-handle',
      'fs/promises.FileHandle',
      base
    )
  }

  const ssh2 = project.program
    .getSourceFiles()
    .find((file) => normalizeProgramPath(file.fileName).endsWith('/@types/ssh2/index.d.ts'))
  if (ssh2) {
    const ssh2Module = project.checker.getSymbolAtLocation(ssh2)
    if (ssh2Module) {
      typeMembersFrom(
        project.checker,
        project.checker.getExportsOfModule(ssh2Module).find((s) => s.getName() === 'SFTPWrapper'),
        SFTP_SINKS,
        'sftp',
        'ssh2.SFTPWrapper',
        base
      )
    }
  }

  repoSeedSinks(project, options.seeds ?? REPO_WRITE_SEEDS, base, missingSeeds)

  const resolvedLabels = new Set(
    baseSinkResolution.filter((entry) => entry.resolved).map((entry) => entry.label)
  )
  return {
    project,
    byDeclaration: base.index,
    /** Receiver-qualified: only a sink when the receiver is a file/SFTP stream. */
    streamByDeclaration: stream.index,
    /** declaration key -> declaration node, for both indexes. */
    declarationNodes,
    baseSinkResolution,
    unresolvedBaseSinks: [
      ...new Set(
        baseSinkResolution
          .filter((entry) => !resolvedLabels.has(entry.label))
          .map((entry) => entry.label)
      )
    ].sort(),
    hasNodeTypes: sawFs || sawFsPromises,
    missingSeeds,
    wrapperCache: new Map(),
    symbolCache: new Map(),
    /** Functions a wrapper probe hit MAX_WRAPPER_DEPTH on, so the chain past
     *  them was never followed. Reported, because "I stopped looking" is not
     *  the same answer as "there is no write here". */
    depthLimited: new Set(),
    /** Why a counter as well as the Set: truncation is detected by comparing
     *  before/after, and a Set silently stops growing the second time the SAME
     *  function is cut off — which let the second truncated null be memoized
     *  and hid three reviewed sites. */
    depthLimitHits: 0
  }
}
