// Every check here exists because existsSync said "present" about something broken.
// So each case PLANTS the corruption and watches the check fail — an empty addon, a
// stale oracle, a corpus the generator never finished — and the last case runs the
// REAL built addon through the same function, so the checks are pinned against the
// artifact production actually loads, not only against fixtures.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PERF_CORPUS_MIN_BYTES,
  checkNapiAddon,
  checkPerfCorpus,
  checkXtermBaseline
} from './gauntlet-prereqs.mjs'

const repo = path.resolve(import.meta.dirname, '..', '..')
const ADDON = path.join(repo, 'native', 'orca-node', 'orca_node.node')
const BENCH_MANIFEST = path.join(import.meta.dirname, 'package.json')

let dir
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gauntlet-prereqs-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (name, content) => {
  const file = path.join(dir, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

// A fake @xterm/headless install: entry module + the package.json the pin is read from.
function fakeXtermInstall(slug, version, entrySource) {
  write(`${slug}/node_modules/@xterm/headless/package.json`, JSON.stringify({ version }))
  return write(`${slug}/node_modules/@xterm/headless/lib-headless/xterm-headless.js`, entrySource)
}

const CONFORMING_XTERM = `class Terminal {
  constructor() { this.buffer = { active: { getLine: () => null, viewportY: 0 } } }
}
module.exports = { Terminal }`

describe('napi addon check', () => {
  it('reports an absent addon as MISSING, not broken (bootstrap installs it)', () => {
    const r = checkNapiAddon(path.join(dir, 'nope.node'))
    expect(r.ok).toBe(false)
    expect(r.present).toBe(false)
  })

  it('fails an empty orca_node.node instead of counting the path as a prerequisite', () => {
    const r = checkNapiAddon(write('empty/orca_node.node', ''))
    expect(r.ok).toBe(false)
    expect(r.present).toBe(true) // present + broken => bootstrap FAILs
    expect(r.reason).toMatch(/does not load/)
  })

  it('fails a module that loads but is not orca-node', () => {
    const r = checkNapiAddon(write('foreign/addon.js', 'module.exports = { version: 1 }'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not orca-node/)
  })

  it('fails an addon whose engine parses nothing', () => {
    const stub = `class HeadlessTerminal {
      write() {}
      snapshot() { return ['', ''] }
    }
    module.exports = { HeadlessTerminal, engine: () => 'stub' }`
    const r = checkNapiAddon(write('dead/addon.js', stub))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/parsed nothing/)
  })

  // Reachability: the real artifact conformance/perf load. `pnpm test` runs
  // build:terminal-addon first, so this is not environment-conditional.
  it('passes the addon this repo actually builds, and names the engine', () => {
    const r = checkNapiAddon(ADDON)
    expect(r.reason).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.info).toBeTruthy()
  })
})

describe('@xterm/headless oracle check', () => {
  it('reports an absent baseline as MISSING', () => {
    const r = checkXtermBaseline(path.join(dir, 'none', 'xterm-headless.js'), BENCH_MANIFEST)
    expect(r.ok).toBe(false)
    expect(r.present).toBe(false)
  })

  it('fails an entry file that loads but exports no Terminal', () => {
    const entry = fakeXtermInstall('hollow', '9.9.9', 'module.exports = {}')
    const r = checkXtermBaseline(entry, BENCH_MANIFEST)
    expect(r.ok).toBe(false)
    expect(r.present).toBe(true)
    expect(r.reason).toMatch(/exports no Terminal/)
  })

  it('fails a Terminal with no buffer.active — the conformance diff would read blanks', () => {
    const entry = fakeXtermInstall('blind', '9.9.9', 'module.exports = { Terminal: class {} }')
    const r = checkXtermBaseline(entry, BENCH_MANIFEST)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/buffer\.active/)
  })

  it('fails a stale install: the oracle must be the pinned build', () => {
    const entry = fakeXtermInstall('stale', '1.2.3', CONFORMING_XTERM)
    const r = checkXtermBaseline(entry, BENCH_MANIFEST)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/1\.2\.3 ≠ pinned/)
  })

  it('passes an install that matches the pin in tools/terminal-bench/package.json', () => {
    // The pin is the contract; read it rather than duplicating the version here.
    const pinned = JSON.parse(readFileSync(BENCH_MANIFEST, 'utf8')).dependencies['@xterm/headless']
    const entry = fakeXtermInstall('pinned', pinned, CONFORMING_XTERM)
    const r = checkXtermBaseline(entry, BENCH_MANIFEST)
    expect(r.reason).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.info).toBe(pinned)
  })
})

describe('perf corpus check', () => {
  it('reports an ungenerated corpus as MISSING', () => {
    const r = checkPerfCorpus(path.join(dir, 'absent.bin'))
    expect(r.ok).toBe(false)
    expect(r.present).toBe(false)
  })

  it('fails a corpus the generator never finished writing', () => {
    const r = checkPerfCorpus(write('short/corpus.bin', Buffer.alloc(4096, 0x1b)))
    expect(r.ok).toBe(false)
    expect(r.present).toBe(true)
    expect(r.reason).toMatch(/truncated: 4096 B/)
  })

  it('fails a full-size file that is not the ANSI corpus', () => {
    const r = checkPerfCorpus(write('zeros/corpus.bin', Buffer.alloc(PERF_CORPUS_MIN_BYTES, 0)))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no ESC byte/)
  })

  it('passes a full-size ANSI corpus', () => {
    const r = checkPerfCorpus(write('full/corpus.bin', Buffer.alloc(PERF_CORPUS_MIN_BYTES, 0x1b)))
    expect(r.reason).toBeUndefined()
    expect(r.ok).toBe(true)
  })
})
