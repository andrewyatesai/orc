// Offline composition report for a .wasm blob: per-section bytes, custom-section
// inventory, top function/crate byte owners when a name section survives, and — for
// the release blobs, whose names are already stripped — a data-section breakdown that
// attributes passenger crates from their embedded panic-location paths.
// No external tooling — parses the binary format directly, so it works on any host
// that can run node (twiggy/wasm-tools/wasm-objdump are not vendored here).
//
// Usage: node tools/wasm-blob-composition.mjs <file.wasm> [more.wasm ...] [--top N] [--json]
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const SECTION_NAMES = [
  'custom',
  'type',
  'import',
  'function',
  'table',
  'memory',
  'global',
  'export',
  'start',
  'element',
  'code',
  'data',
  'datacount',
  'tag'
]

class Reader {
  constructor(bytes, pos = 0) {
    this.bytes = bytes
    this.pos = pos
  }
  u8() {
    return this.bytes[this.pos++]
  }
  varu32() {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = this.bytes[this.pos++]
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) {
        return result >>> 0
      }
      shift += 7
    }
  }
  vari32() {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = this.bytes[this.pos++]
      result |= (byte & 0x7f) << shift
      shift += 7
      if ((byte & 0x80) === 0) {
        // sign-extend
        return shift < 32 && (byte & 0x40) !== 0 ? result | (~0 << shift) : result
      }
    }
  }
  name() {
    const len = this.varu32()
    const text = Buffer.from(this.bytes.buffer, this.bytes.byteOffset + this.pos, len).toString(
      'utf8'
    )
    this.pos += len
    return text
  }
  skip(n) {
    this.pos += n
  }
}

function parseSections(bytes) {
  if (bytes.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('not a wasm module (bad magic)')
  }
  const reader = new Reader(bytes, 8)
  const sections = []
  while (reader.pos < bytes.length) {
    const id = reader.u8()
    const sizeStart = reader.pos
    const size = reader.varu32()
    const body = reader.pos
    const headerBytes = 1 + (body - sizeStart)
    let customName = null
    if (id === 0) {
      const probe = new Reader(bytes, body)
      customName = probe.name()
    }
    sections.push({ id, name: SECTION_NAMES[id] ?? `unknown(${id})`, customName, body, size, headerBytes })
    reader.pos = body + size
  }
  return sections
}

function countImportedFunctions(bytes, section) {
  const reader = new Reader(bytes, section.body)
  const count = reader.varu32()
  let funcs = 0
  for (let i = 0; i < count; i++) {
    reader.name() // module
    reader.name() // field
    const kind = reader.u8()
    if (kind === 0) {
      reader.varu32()
      funcs++
    } else if (kind === 1) {
      reader.u8()
      readLimits(reader)
    } else if (kind === 2) {
      readLimits(reader)
    } else if (kind === 3) {
      reader.u8()
      reader.u8()
    } else if (kind === 4) {
      reader.u8()
      reader.varu32()
    }
  }
  return funcs
}

function readLimits(reader) {
  const flags = reader.varu32()
  reader.varu32()
  if (flags & 0x01) {
    reader.varu32()
  }
}

// Per-function body bytes, keyed by absolute function index.
function parseCodeSizes(bytes, section, importedFuncs) {
  const reader = new Reader(bytes, section.body)
  const count = reader.varu32()
  const sizes = new Map()
  for (let i = 0; i < count; i++) {
    const start = reader.pos
    const size = reader.varu32()
    const entryBytes = size + (reader.pos - start)
    sizes.set(importedFuncs + i, entryBytes)
    reader.pos += size
  }
  return sizes
}

function parseNameSection(bytes, section) {
  const reader = new Reader(bytes, section.body)
  reader.name() // "name"
  const end = section.body + section.size
  const functionNames = new Map()
  const subsectionBytes = new Map()
  while (reader.pos < end) {
    const id = reader.u8()
    const size = reader.varu32()
    const payload = reader.pos
    subsectionBytes.set(id, (subsectionBytes.get(id) ?? 0) + size)
    if (id === 1) {
      const sub = new Reader(bytes, payload)
      const count = sub.varu32()
      for (let i = 0; i < count; i++) {
        functionNames.set(sub.varu32(), sub.name())
      }
    }
    reader.pos = payload + size
  }
  return { functionNames, subsectionBytes }
}

function parseDataSegments(bytes, section) {
  const reader = new Reader(bytes, section.body)
  const count = reader.varu32()
  let payload = 0
  const segments = []
  for (let i = 0; i < count; i++) {
    const flags = reader.varu32()
    if (flags === 2) {
      reader.varu32()
    }
    if (flags !== 1) {
      // constant offset expr, terminated by `end`
      while (reader.u8() !== 0x0b) {
        reader.vari32()
      }
    }
    const len = reader.varu32()
    segments.push(bytes.subarray(reader.pos, reader.pos + len))
    payload += len
    reader.pos += len
  }
  return { count, payload, segments }
}

// Unicode codepoint-range tables (regex-syntax, unicode-*) are long ascending u32
// runs below the max scalar value — a reliable fingerprint even with names stripped.
function codepointTableBytes(segments) {
  let total = 0
  let runs = 0
  for (const segment of segments) {
    let i = 0
    while (i + 4 <= segment.length) {
      let j = i
      let previous = -1
      let count = 0
      while (j + 4 <= segment.length) {
        const value = segment.readUInt32LE(j)
        if (value > 0x10ffff || value < previous) {
          break
        }
        previous = value
        j += 4
        count++
      }
      if (count >= 32) {
        total += count * 4
        runs++
        i = j
      } else {
        i += 4
      }
    }
  }
  return { bytes: total, runs }
}

// `--remap-path-prefix` rewrites builder paths but keeps crate-name/version, so the
// surviving `location!()` strings are a per-crate census of what got linked in.
const CRATE_PATH = new RegExp(
  [
    String.raw`(?:index\.crates\.io-[0-9a-f]+|deps)\/([A-Za-z0-9_.-]+?)-\d+\.\d+[\w.+-]*\/src\/`,
    String.raw`(?:^|[^\w])crates\/(aterm-[a-z-]+)\/src\/`,
    String.raw`library\/(core|std|alloc)\/src\/`
  ].join('|'),
  'g'
)

function crateCensus(segments) {
  const text = Buffer.concat(segments).toString('latin1')
  const counts = new Map()
  for (const match of text.matchAll(CRATE_PATH)) {
    const crate = match[1] ?? match[2] ?? `rust-${match[3]}`
    counts.set(crate, (counts.get(crate) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([crate, sites]) => ({ crate, sites }))
    .sort((a, b) => b.sites - a.sites)
}

// Legacy rustc mangling: _ZN <len><seg>... 17h<hash> E
function demangle(symbol) {
  if (!symbol.startsWith('_ZN') || !symbol.endsWith('E')) {
    return symbol
  }
  const segments = []
  let i = 3
  while (i < symbol.length - 1) {
    let digits = ''
    while (i < symbol.length && symbol[i] >= '0' && symbol[i] <= '9') {
      digits += symbol[i++]
    }
    if (digits === '') {
      break
    }
    const len = Number(digits)
    segments.push(symbol.slice(i, i + len))
    i += len
  }
  if (segments.length === 0) {
    return symbol
  }
  if (/^h[0-9a-f]{16}$/.test(segments.at(-1))) {
    segments.pop()
  }
  return segments.join('::')
}

// Best-effort owner bucket: crate for plain paths, the trait/type crate for
// `<A as B>::m` forms, `?` when the symbol carries no path at all.
function ownerOf(demangled) {
  const generic = demangled.match(/^<(?:&(?:mut )?)?(?:\[)?([A-Za-z_][\w]*)/)
  if (demangled.startsWith('<') && generic) {
    return generic[1]
  }
  const head = demangled.split('::')[0]
  if (/^[A-Za-z_][\w]*$/.test(head)) {
    return head
  }
  return '?'
}

function analyze(path, topN) {
  const bytes = readFileSync(path)
  const sections = parseSections(bytes)
  const bySectionKey = new Map()
  for (const section of sections) {
    const key = section.id === 0 ? `custom "${section.customName}"` : section.name
    const prior = bySectionKey.get(key) ?? { key, id: section.id, bytes: 0, count: 0 }
    prior.bytes += section.size + section.headerBytes
    prior.count += 1
    bySectionKey.set(key, prior)
  }

  const importSection = sections.find((s) => s.id === 2)
  const codeSection = sections.find((s) => s.id === 10)
  const dataSection = sections.find((s) => s.id === 11)
  const nameSection = sections.find((s) => s.id === 0 && s.customName === 'name')

  const importedFuncs = importSection ? countImportedFunctions(bytes, importSection) : 0
  const codeSizes = codeSection ? parseCodeSizes(bytes, codeSection, importedFuncs) : new Map()
  const data = dataSection
    ? parseDataSegments(bytes, dataSection)
    : { count: 0, payload: 0, segments: [] }
  const names = nameSection ? parseNameSection(bytes, nameSection) : null

  const functions = []
  for (const [index, size] of codeSizes) {
    const raw = names?.functionNames.get(index) ?? null
    const demangled = raw ? demangle(raw) : null
    functions.push({ index, size, raw, demangled, owner: demangled ? ownerOf(demangled) : '?' })
  }
  functions.sort((a, b) => b.size - a.size)

  const owners = new Map()
  for (const fn of functions) {
    const prior = owners.get(fn.owner) ?? { owner: fn.owner, bytes: 0, count: 0 }
    prior.bytes += fn.size
    prior.count += 1
    owners.set(fn.owner, prior)
  }

  return {
    path,
    file: basename(path),
    total: bytes.length,
    sections: [...bySectionKey.values()].sort((a, b) => b.bytes - a.bytes),
    importedFuncs,
    definedFuncs: codeSizes.size,
    hasNames: Boolean(names),
    nameSubsections: names ? [...names.subsectionBytes.entries()] : [],
    data: {
      count: data.count,
      payload: data.payload,
      codepointTables: codepointTableBytes(data.segments)
    },
    crates: crateCensus(data.segments),
    topFunctions: functions.slice(0, topN),
    owners: [...owners.values()].sort((a, b) => b.bytes - a.bytes).slice(0, topN)
  }
}

function pct(part, whole) {
  return `${((part * 100) / whole).toFixed(1)}%`
}

function kib(n) {
  return `${(n / 1024).toFixed(1)} KiB`
}

const args = process.argv.slice(2)
const topIndex = args.indexOf('--top')
const topN = topIndex >= 0 ? Number(args[topIndex + 1]) : 25
const json = args.includes('--json')
// Why the guard: indexOf returns -1 when --top is absent, and -1 + 1 === 0 would
// silently drop the FIRST file argument.
const topValueIndex = topIndex >= 0 ? topIndex + 1 : -1
const files = args.filter((a, i) => !a.startsWith('--') && i !== topValueIndex)
if (files.length === 0) {
  console.error('usage: node tools/wasm-blob-composition.mjs <file.wasm> [...] [--top N] [--json]')
  process.exit(1)
}

const reports = files.map((f) => analyze(f, topN))
if (json) {
  console.log(JSON.stringify(reports, null, 2))
} else {
  for (const report of reports) {
    console.log(`\n=== ${report.file} — ${report.total} bytes (${kib(report.total)}) ===`)
    console.log('  section                          bytes        share')
    for (const section of report.sections) {
      console.log(
        `  ${section.key.padEnd(30)} ${String(section.bytes).padStart(9)}  ${pct(section.bytes, report.total).padStart(7)}`
      )
    }
    console.log(
      `  functions: ${report.definedFuncs} defined + ${report.importedFuncs} imported; ` +
        `data segments: ${report.data.count} (${report.data.payload} payload bytes, of which ` +
        `${report.data.codepointTables.bytes} in ${report.data.codepointTables.runs} unicode ` +
        `codepoint tables = ${pct(report.data.codepointTables.bytes, report.data.payload)})`
    )
    console.log(`\n  crate census (panic-location sites in the data section):`)
    for (const { crate, sites } of report.crates.slice(0, topN)) {
      console.log(`  ${String(sites).padStart(5)}x  ${crate}`)
    }
    console.log(`  ${report.crates.length} distinct crates total`)
    if (!report.hasNames) {
      console.log('\n  (no name section — per-function attribution unavailable)')
      continue
    }
    console.log(`\n  top ${report.owners.length} owners by code bytes:`)
    for (const owner of report.owners) {
      console.log(
        `  ${owner.owner.padEnd(30)} ${String(owner.bytes).padStart(9)}  ${pct(owner.bytes, report.total).padStart(7)}  (${owner.count} fns)`
      )
    }
    console.log(`\n  top ${report.topFunctions.length} functions by code bytes:`)
    for (const fn of report.topFunctions) {
      console.log(`  ${String(fn.size).padStart(8)}  ${(fn.demangled ?? `#${fn.index}`).slice(0, 150)}`)
    }
  }
}
