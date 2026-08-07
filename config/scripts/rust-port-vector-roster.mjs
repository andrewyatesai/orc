// The candidate module set this report looks at, plus the per-module facts that
// let a reader judge each entry without opening five files.
//
// THE ROSTER IS A DECLARED INPUT, NOT EVIDENCE
// It is the filename set of `tools/parity/vectors/*.json` — the corpus the
// TS<->Rust differential harness runs. It says which modules were ported; it
// says NOTHING about whether anything dispatches them, and this module reads no
// field of it that could. An earlier gate bound a per-function Rust door to a
// module by having the corpus name that door in a test case, which meant
// appending one case object minted a shipping claim with no production change.
// That binding is gone: only `module`, `source` and `rustCrate` are read here,
// and none of them can remove a module from the orphan list.
//
// Which direction a roster edit moves the report:
//   * adding an entry    -> one more orphan CANDIDATE unless production
//     dispatches it. More review work, never a claim of merit.
//   * deleting an entry  -> the module stops being looked at. This is the one
//     edit that can hide an orphan, it is a deletion from a directory the parity
//     harness also reads, and the report states it out loud.

import fs from 'node:fs'
import path from 'node:path'

import {
  ALL_PROJECT_IDS,
  REPO_ROOT,
  displayPath,
  getProjectScan,
  normalizeProgramPath,
  scanImportGraph
} from './typescript-symbol-resolution.mjs'

export const VECTORS_DIR = path.join(REPO_ROOT, 'tools', 'parity', 'vectors')
const CRATES_DIR = path.join(REPO_ROOT, 'rust', 'crates')

/** Fail closed: a missing directory, an unreadable file, malformed JSON or an
 *  empty roster all throw. "No ported modules" and "I could not read the ported
 *  modules" must not produce the same clean output. */
export function loadPortedModuleRoster(vectorsDir = VECTORS_DIR) {
  let entries
  try {
    entries = fs.readdirSync(vectorsDir).sort()
  } catch (error) {
    throw new Error(`cannot read the parity vector directory ${vectorsDir}: ${error.message}`)
  }
  const modules = new Map()
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }
    const file = path.join(vectorsDir, entry)
    let document
    try {
      document = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(
        `parity vector ${entry} is unreadable, so the candidate set is incomplete: ${error.message}`
      )
    }
    const name =
      typeof document.module === 'string' ? document.module : entry.slice(0, -'.json'.length)
    // Why refuse instead of overwrite: `module` is a declared field, so two files
    // claiming one name silently drops a candidate — that is a one-field edit
    // that removes an orphan from the report with the vector file still on disk.
    const clash = modules.get(name)
    if (clash) {
      throw new Error(
        `parity vectors ${clash.vectorFile} and ${displayPath(file)} both declare module "${name}", so a candidate would be dropped; give each vector a distinct module`
      )
    }
    modules.set(name, {
      name,
      vectorFile: displayPath(file),
      tsSource: typeof document.source === 'string' ? document.source : null,
      rustCrate: typeof document.rustCrate === 'string' ? document.rustCrate : null
    })
  }
  if (modules.size === 0) {
    throw new Error(`no parity vector corpus under ${vectorsDir}; the candidate set would be empty`)
  }
  return modules
}

function findRustFile(crateDir, moduleSegment) {
  const direct = path.join(crateDir, 'src', `${moduleSegment}.rs`)
  if (fs.existsSync(direct)) {
    return direct
  }
  const nested = path.join(crateDir, 'src', moduleSegment, 'mod.rs')
  if (fs.existsSync(nested)) {
    return nested
  }
  const lib = path.join(crateDir, 'src', 'lib.rs')
  return fs.existsSync(lib) ? lib : null
}

/** `orca-core::cross_platform_path` -> the .rs file and its line count. Returns
 *  `{ file: null }` when the crate or module cannot be located on disk: an
 *  unlocatable port is reported as unlocatable, not as zero lines. */
export function rustSourceEvidence(rustCrate) {
  if (!rustCrate) {
    return {
      file: null,
      lines: null,
      crateDir: null,
      reason: 'the parity vector names no rustCrate'
    }
  }
  const [crate, ...rest] = rustCrate.split('::')
  const crateDir = path.join(CRATES_DIR, crate)
  if (!fs.existsSync(crateDir)) {
    return {
      file: null,
      lines: null,
      crateDir: null,
      reason: `rust/crates/${crate} is not on disk`
    }
  }
  const file = findRustFile(crateDir, rest.join('/') || 'lib')
  if (!file) {
    return { file: null, lines: null, crateDir, reason: `no .rs found for ${rustCrate}` }
  }
  const text = fs.readFileSync(file, 'utf8')
  return { file: displayPath(file), lines: text.split('\n').length, crateDir, reason: null }
}

// Strongest first: orca-flow-control says "It is NOT a production cutover" before
// it says "SPEC", and the explicit sentence is the one worth quoting.
const SPEC_MARKERS = [/not a production cutover/i, /\bSPEC\b/]

/** A self-declaration, in a Rust doc comment, that this port is a deliberate
 *  specification rather than a cutover — e.g. orca-flow-control's "It is NOT a
 *  production cutover ... this core is the machine-checkable, ay-provable SPEC".
 *
 *  This is a TEXT MARKER and is treated as one: it is quoted with its file:line
 *  so a reader can judge it, and it NEVER removes a module from the orphan list.
 *  Nothing distinguishes a genuine spec crate from an abandoned port that had
 *  the sentence added, so the report does not pretend to. */
export function specSelfDeclaration(rustFile, crateDir) {
  const files = []
  if (rustFile) {
    files.push(path.join(REPO_ROOT, rustFile))
  }
  if (crateDir) {
    files.push(path.join(crateDir, 'src', 'lib.rs'))
  }
  for (const marker of SPEC_MARKERS) {
    for (const file of files) {
      if (!fs.existsSync(file)) {
        continue
      }
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('//') || !marker.test(trimmed)) {
          continue
        }
        return {
          location: `${displayPath(file)}:${index + 1}`,
          text: trimmed.replace(/^\/+!?\s*/, '')
        }
      }
    }
  }
  return null
}

/** Production files that import the module's TypeScript twin, across every
 *  project's scanner import graph. A high count next to an unreachable Rust port
 *  is the shape worth reviewing: the TypeScript is load-bearing and the Rust
 *  beside it is not entered. */
export function typescriptTwinImporters(tsSource, projectIds = ALL_PROJECT_IDS) {
  if (!tsSource) {
    return { count: null, resolved: false }
  }
  const key = normalizeProgramPath(path.join(REPO_ROOT, tsSource))
  if (!fs.existsSync(path.join(REPO_ROOT, tsSource))) {
    return { count: null, resolved: false }
  }
  const importers = new Set()
  for (const id of projectIds) {
    const graph = scanImportGraph(getProjectScan(id))
    for (const importer of graph.importersOf.get(key) ?? []) {
      const shown = displayPath(graph.pathOf.get(importer) ?? importer)
      if (shown.startsWith('src/') && !/\.(test|spec)\.[cm]?tsx?$/.test(shown)) {
        importers.add(shown)
      }
    }
  }
  return { count: importers.size, resolved: true }
}

/** Everything the report knows about one candidate module, gathered once. */
export function portedModuleEvidence(entry) {
  const { crateDir, ...rust } = rustSourceEvidence(entry.rustCrate)
  // Why: crateDir is an absolute machine path — useful for the marker lookup, never for output.
  return {
    ...entry,
    rust,
    specMarker: specSelfDeclaration(rust.file, crateDir),
    twin: typescriptTwinImporters(entry.tsSource)
  }
}
