// How many bytes of an aterm wasm blob are reachable ONLY from wasm-bindgen exports
// the Orca renderer never calls. Builds a wasm-metadce graph whose roots are the
// exports referenced anywhere in src/, DCEs against a COPY, and reports the delta.
//
// The result is an upper bound on what feature-gating the engine's #[wasm_bindgen]
// surface could save — it is a MEASUREMENT, not a shippable transform: the generated
// glue still binds every export, so a DCE'd blob would fault on the first stale call.
//
// Usage: node tools/wasm-unused-export-weight.mjs [--keep-temp]
// Requires wasm-metadce + wasm-opt on PATH (binaryen, same dependency as the build).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ATERM = join(ROOT, 'src/renderer/src/lib/pane-manager/aterm')
const BLOBS = ['aterm_wasm_bg.wasm', 'aterm_gpu_web_bg.wasm']
// Same feature set the build's wasm-opt pass enables; binaryen rejects the module otherwise.
const FEATURES = [
  '--enable-bulk-memory',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-mutable-globals',
  '--enable-reference-types',
  '--enable-simd'
]
// wasm-bindgen name-mangles instance methods as `<lowercased class>_<method>`.
const CLASS_PREFIX =
  /^(atermterminal|atermgputerminal|budgetedsearchresult|linkhit|searchmeta|selectionrange|selectionpoint)_/

function readExports(file) {
  const bytes = readFileSync(file)
  const varu32 = (pos) => {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = bytes[pos++]
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) {
        return [result >>> 0, pos]
      }
      shift += 7
    }
  }
  let pos = 8
  let section = null
  while (pos < bytes.length) {
    const id = bytes[pos++]
    let size
    ;[size, pos] = varu32(pos)
    if (id === 7) {
      section = pos
    }
    pos += size
  }
  let cursor = section
  let count
  ;[count, cursor] = varu32(cursor)
  const exports = []
  for (let i = 0; i < count; i++) {
    let len
    ;[len, cursor] = varu32(cursor)
    const name = bytes.toString('utf8', cursor, cursor + len)
    cursor += len
    const kind = bytes[cursor++]
    ;[, cursor] = varu32(cursor)
    exports.push({ name, kind })
  }
  return exports
}

function rendererSources() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'out', 'dist'].includes(entry.name)) {
          walk(path)
        }
      } else if (
        /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        // The generated glue names every export; counting it would root everything.
        !/^aterm_(wasm|gpu_web)\.js$/.test(entry.name)
      ) {
        files.push(path)
      }
    }
  }
  walk(join(ROOT, 'src'))
  return files.map((file) => readFileSync(file, 'utf8')).join('\n')
}

// Deliberately loose: a bare method-name match counts as "used", so the reported
// dead weight is a floor, never an over-claim.
function isReferenced(name, corpus) {
  if (name.startsWith('__wbindgen') || name.startsWith('__wbg_') || name.startsWith('__externref')) {
    return true
  }
  const method = name.replace(CLASS_PREFIX, '')
  return new RegExp(`[.\\b]${method}\\s*[(=<]|['"\`]${method}['"\`]`).test(corpus)
}

const corpus = rendererSources()
const work = mkdtempSync(join(tmpdir(), 'wasm-export-weight-'))
try {
  for (const blob of BLOBS) {
    const source = join(ATERM, blob)
    const exports = readExports(source)
    const reaches = []
    const graph = exports.map(({ name, kind }) => {
      const id = `e_${name}`
      if (kind !== 0 || isReferenced(name, corpus)) {
        reaches.push(id)
      }
      return { name: id, export: name }
    })
    graph.unshift({ name: 'orca-roots', root: true, reaches })
    const graphFile = join(work, `${blob}.graph.json`)
    writeFileSync(graphFile, JSON.stringify(graph))

    const dced = join(work, `dce_${blob}`)
    const collected = join(work, `dce_o3_${blob}`)
    execFileSync('wasm-metadce', [...FEATURES, '--graph-file', graphFile, '-o', dced, source], {
      stdio: 'ignore'
    })
    // metadce only unroots; -O3 is what actually collects the now-unreachable bodies.
    execFileSync('wasm-opt', [...FEATURES, '-O3', '-o', collected, dced], { stdio: 'ignore' })

    const before = statSync(source).size
    const after = statSync(collected).size
    const dead = exports.length - reaches.length
    console.log(
      `${blob}: ${dead}/${exports.length} exports unreferenced by src/ → ` +
        `${before} -> ${after} bytes (-${before - after}, -${(((before - after) * 100) / before).toFixed(2)}%)`
    )
  }
} finally {
  if (!process.argv.includes('--keep-temp')) {
    rmSync(work, { recursive: true, force: true })
  }
}
