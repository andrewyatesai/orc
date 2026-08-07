// Program construction for the semantic verification gates, cached per process.
//
// A Program over a whole project is the entire cost of a semantic gate: the
// five projects together take ~13s and peak near 4GB, which no contributor
// would tolerate in `pnpm lint`. So the default path builds a Program rooted
// only at the files a scanner-level import graph proves can reach the module
// under test (see typescript-module-reference-index.mjs) — ~0.2s and ~0.3GB.
// getFullProject stays available for verification runs and tests.

import fs from 'node:fs'
import path from 'node:path'

// TypeScript 7 is a native CLI; AST/type-checker consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

/** Every tsconfig the app actually type-checks, plus a synthetic project for
 *  the .mjs scripts no tsconfig includes. */
const TSCONFIG_PROJECTS = {
  node: 'config/tsconfig.node.json',
  web: 'config/tsconfig.web.json',
  cli: 'config/tsconfig.cli.json',
  relay: 'config/tsconfig.relay.json'
}

const SCRIPT_PROJECT_DIRS = ['config/scripts', 'tools', 'private']
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.mts', '.js'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git', 'vendor', '__snapshots__'])

export const APP_PROJECT_IDS = Object.freeze(['node', 'web', 'cli', 'relay'])
export const SCRIPT_PROJECT_ID = 'config-scripts'
export const ALL_PROJECT_IDS = Object.freeze([...APP_PROJECT_IDS, SCRIPT_PROJECT_ID])

const scanCache = new Map()
const fullProgramCache = new Map()
const timings = []

/** Canonical path form for cross-program comparison: TypeScript stores forward
 *  slashes even on Windows, and folds case only where the filesystem does. */
export function normalizeProgramPath(filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(REPO_ROOT, filePath)
  const slashed = absolute.split(path.sep).join('/')
  return ts.sys.useCaseSensitiveFileNames ? slashed : slashed.toLowerCase()
}

/** Repo-relative display form for gate messages only — never for identity. */
export function displayPath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/')
}

// Why: gates only read symbols, so emit/incremental machinery is pure cost.
function gateCompilerOptions(base) {
  return {
    ...base,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    noEmit: true,
    skipLibCheck: true
  }
}

function walkFiles(absoluteDir, accept, sink) {
  if (!fs.existsSync(absoluteDir)) {
    return
  }
  const stack = [absoluteDir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(child)
        }
      } else if (accept(entry.name)) {
        sink.push(child)
      }
    }
  }
}

function scriptProjectFiles() {
  const files = []
  for (const dir of SCRIPT_PROJECT_DIRS) {
    walkFiles(path.join(REPO_ROOT, dir), (name) => SCRIPT_EXTENSIONS.has(path.extname(name)), files)
  }
  return files.sort()
}

function parseTsconfig(tsconfigPath) {
  const raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (raw.error) {
    throw new Error(
      `cannot read ${displayPath(tsconfigPath)}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`
    )
  }
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(tsconfigPath))
}

/** The cheap half of a project: its compiler options, the exact file list a
 *  gate is responsible for, and a module resolver — no Program, no checker.
 *  Costs ~30ms. Everything that decides *which* files to look at uses this. */
export function getProjectScan(id) {
  const cached = scanCache.get(id)
  if (cached) {
    return cached
  }
  let options
  let fileNames
  let tsconfigPath = null

  if (id === SCRIPT_PROJECT_ID) {
    fileNames = scriptProjectFiles()
    options = gateCompilerOptions({
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      resolveJsonModule: true,
      types: []
    })
  } else {
    const relative = TSCONFIG_PROJECTS[id]
    if (!relative) {
      throw new Error(`unknown project '${id}'; known: ${ALL_PROJECT_IDS.join(', ')}`)
    }
    tsconfigPath = path.join(REPO_ROOT, relative)
    const parsed = parseTsconfig(tsconfigPath)
    fileNames = parsed.fileNames
    options = gateCompilerOptions(parsed.options)
  }

  const resolutionCache = ts.createModuleResolutionCache(
    REPO_ROOT,
    (fileName) => normalizeProgramPath(fileName),
    options
  )
  const scan = {
    id,
    tsconfigPath,
    options,
    fileNames,
    fileKeys: new Set(fileNames.map(normalizeProgramPath)),
    /** {key, path} a specifier resolves to, or undefined. Uses the same
     *  resolver and options the Program will use, so the import graph it
     *  produces matches the checker's. */
    resolveModule(specifier, containingFile) {
      const resolved = ts.resolveModuleName(
        specifier,
        containingFile,
        options,
        ts.sys,
        resolutionCache
      )
      const fileName = resolved.resolvedModule?.resolvedFileName
      return fileName ? { key: normalizeProgramPath(fileName), path: fileName } : undefined
    }
  }
  scanCache.set(id, scan)
  return scan
}

function makeProject(id, scan, program, kind, rootFiles) {
  const checker = program.getTypeChecker()
  return {
    id,
    kind,
    scan,
    tsconfigPath: scan.tsconfigPath,
    program,
    checker,
    rootFiles,
    ownedPaths: new Set(
      program.getSourceFiles().map((file) => normalizeProgramPath(file.fileName))
    ),
    sourceFileFor(filePath) {
      const key = normalizeProgramPath(filePath)
      return program.getSourceFiles().find((file) => normalizeProgramPath(file.fileName) === key)
    }
  }
}

/** A Program rooted at just these files (plus whatever they import). Symbol
 *  resolution inside them is complete and identical to the full Program;
 *  files outside the root set are simply absent, so a gate must only pass a
 *  root set it has *proved* is a superset of the interesting files. */
export function getScopedProject(id, rootFiles) {
  const scan = getProjectScan(id)
  const started = performance.now()
  const roots = [...new Set(rootFiles)]
  if (roots.length === 0) {
    return undefined
  }
  const program = ts.createProgram({ rootNames: roots, options: scan.options })
  const project = makeProject(id, scan, program, 'scoped', roots)
  // The Program also holds the roots' transitive imports; only the roots were
  // proved to be candidates, so reference walks stop there by default.
  project.defaultScanFiles = roots.map(normalizeProgramPath)
  timings.push({
    id,
    kind: 'scoped',
    ms: performance.now() - started,
    roots: roots.length,
    files: program.getSourceFiles().length
  })
  return project
}

/** The whole project, every file the tsconfig lists. ~2.5-5s and ~1.5GB each —
 *  used by verification runs and tests, not by the default gate path. Cached
 *  per process; call releaseFullProject to let V8 reclaim it. */
export function getFullProject(id) {
  const cached = fullProgramCache.get(id)
  if (cached) {
    return cached
  }
  const scan = getProjectScan(id)
  const started = performance.now()
  const program = ts.createProgram({ rootNames: scan.fileNames, options: scan.options })
  const project = makeProject(id, scan, program, 'full', scan.fileNames)
  timings.push({
    id,
    kind: 'full',
    ms: performance.now() - started,
    roots: scan.fileNames.length,
    files: program.getSourceFiles().length
  })
  fullProgramCache.set(id, project)
  return project
}

/** Drops a cached full Program so V8 can reclaim ~1.5GB. */
export function releaseFullProject(id) {
  fullProgramCache.delete(id)
}

/** Builds each full project in turn, runs the visitors, then evicts it, so peak
 *  memory is one Program rather than five. Only for gates that genuinely need
 *  every file; prefer a scoped project. */
export function forEachFullProject(ids, visitors) {
  const list = Array.isArray(visitors) ? visitors : [visitors]
  const results = []
  for (const id of ids) {
    const project = getFullProject(id)
    try {
      for (const visitor of list) {
        results.push({ projectId: id, value: visitor(project) })
      }
    } finally {
      releaseFullProject(id)
    }
  }
  return results
}

/** Source files on disk under `dirs` that no project's file list contains — the
 *  files a gate would silently skip. Costs ~150ms (no Program). Gates MUST fail
 *  on a non-empty result: an unanalyzed file is not a clean file, and dropping
 *  a file out of a tsconfig is exactly how a file-granular exemption is smuggled
 *  in. */
export function uncoveredSourceFiles(
  dirs = ['src'],
  ids = ALL_PROJECT_IDS,
  extensions = ['.ts', '.tsx', '.mts', '.cts']
) {
  const covered = new Set()
  for (const id of ids) {
    for (const key of getProjectScan(id).fileKeys) {
      covered.add(key)
    }
  }
  const extensionSet = new Set(extensions)
  const found = []
  for (const dir of dirs) {
    walkFiles(path.join(REPO_ROOT, dir), (name) => extensionSet.has(path.extname(name)), found)
  }
  return found
    .filter((file) => !covered.has(normalizeProgramPath(file)))
    .map(displayPath)
    .sort()
}

/** Wall-clock cost of every Program built in this process, for gate reporting. */
export function programCacheTimings() {
  return timings.map((entry) => ({ ...entry }))
}

/** Drops every cached scan and Program. Tests only. */
export function resetProgramCache() {
  scanCache.clear()
  fullProgramCache.clear()
  timings.length = 0
}

/** Builds a throwaway Program from an in-memory {relativePath: source} map, for
 *  fixtures and attack tests. Resolves relative imports between the supplied
 *  files and reads real lib.d.ts from disk; NOT cached, NOT wired to the repo's
 *  tsconfigs. */
export function createInMemoryProject(files, overrides = {}) {
  const virtualRoot = path.join(REPO_ROOT, '__semantic-gate-fixture__')
  const sources = new Map()
  for (const [relative, text] of Object.entries(files)) {
    sources.set(normalizeProgramPath(path.join(virtualRoot, relative)), text)
  }

  const options = gateCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    strict: true,
    types: [],
    ...overrides
  })

  const host = ts.createCompilerHost(options, true)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  const originalFileExists = host.fileExists.bind(host)
  const originalReadFile = host.readFile.bind(host)
  const originalDirectoryExists = host.directoryExists?.bind(host)
  const originalRealpath = host.realpath?.bind(host)
  const virtualDirs = new Set()
  for (const key of sources.keys()) {
    let dir = key.slice(0, key.lastIndexOf('/'))
    while (dir.length > 1 && !virtualDirs.has(dir)) {
      virtualDirs.add(dir)
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
  }

  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) => {
    const text = sources.get(normalizeProgramPath(fileName))
    if (text === undefined) {
      return originalGetSourceFile(fileName, languageVersionOrOptions, ...rest)
    }
    return ts.createSourceFile(fileName, text, languageVersionOrOptions, true)
  }
  host.fileExists = (fileName) =>
    sources.has(normalizeProgramPath(fileName)) || originalFileExists(fileName)
  host.readFile = (fileName) =>
    sources.get(normalizeProgramPath(fileName)) ?? originalReadFile(fileName)
  // Module resolution probes directories before files; the fixture root is not on disk.
  host.directoryExists = (dirName) =>
    virtualDirs.has(normalizeProgramPath(dirName)) || Boolean(originalDirectoryExists?.(dirName))
  host.realpath = (fileName) =>
    sources.has(normalizeProgramPath(fileName))
      ? fileName
      : (originalRealpath?.(fileName) ?? fileName)

  const rootNames = Object.keys(files).map((relative) => path.join(virtualRoot, relative))
  const program = ts.createProgram({ rootNames, options, host })
  const fileNames = rootNames.map(normalizeProgramPath)
  const scan = {
    id: 'in-memory-fixture',
    tsconfigPath: null,
    options,
    fileNames: rootNames,
    fileKeys: new Set(fileNames),
    resolveModule: () => undefined
  }
  const project = makeProject('in-memory-fixture', scan, program, 'fixture', rootNames)
  project.resolve = (relative) => path.join(virtualRoot, relative)
  project.sourceFile = (relative) => program.getSourceFile(path.join(virtualRoot, relative))
  return project
}
