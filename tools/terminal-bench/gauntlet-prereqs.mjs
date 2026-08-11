// What "bootstrapped" MEANS — the content checks behind the gauntlet's bootstrap axis.
//
// WHY these are not existsSync: a path proves nothing about the artifact at it. An
// orca_node.node truncated by a killed `cp`, an @xterm install left at the previous
// pin, or a corpus.bin whose generator was Ctrl-C'd all pass an existence test and
// then take conformance/perf down with them — or worse, hand perf real-looking MB/s
// measured over 4 KB. Every check here LOADS or MEASURES the artifact, so a
// prerequisite that is present but unusable is a FAIL, never a green bootstrap.
//
// Each check returns { name, path, present, ok, reason?, info? }: `present` is what
// separates "this machine lacks a toolchain" (bootstrap REVIEWs) from "the artifact
// is here and broken" (bootstrap FAILs).
//
// Extracted from gauntlet.mjs so planted-corruption tests drive the checks directly
// and that file stays under its max-lines cap.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

// rust/crates/orca-terminal/examples/bench.rs `gen` fills until len >= mb*1024*1024,
// so the byte floor below is exact, not an estimate.
export const PERF_CORPUS_MB = 16
export const PERF_CORPUS_MIN_BYTES = PERF_CORPUS_MB * 1024 * 1024

const firstLine = (e) =>
  String(e?.message ?? e)
    .split('\n')[0]
    .slice(0, 160)
const mib = (n) => `${(n / (1024 * 1024)).toFixed(2)} MiB`
const good = (name, path, info) => ({ name, path, present: true, ok: true, info })
const bad = (name, path, reason) => ({ name, path, present: existsSync(path), ok: false, reason })

/** The napi addon must load in THIS process and actually parse — that is what perf/conformance do. */
export function checkNapiAddon(path) {
  if (!existsSync(path)) {
    return bad('addon', path, 'not built — bootstrap runs config/scripts/build-terminal-addon.mjs')
  }
  let mod
  try {
    mod = require(path)
  } catch (e) {
    return bad('addon', path, `does not load (delete it and re-run bootstrap): ${firstLine(e)}`)
  }
  if (typeof mod.HeadlessTerminal !== 'function' || typeof mod.engine !== 'function') {
    return bad('addon', path, 'loads but is not orca-node: no HeadlessTerminal/engine export')
  }
  try {
    const term = new mod.HeadlessTerminal(16, 2, 4)
    term.write(Buffer.from('aterm'))
    const row = (term.snapshot()[0] ?? '').replace(/\s+$/u, '')
    if (row !== 'aterm') {
      return bad('addon', path, `engine parsed nothing — visible row 0 = ${JSON.stringify(row)}`)
    }
    return good('addon', path, String(mod.engine()))
  } catch (e) {
    return bad('addon', path, `engine threw on a 5-byte write: ${firstLine(e)}`)
  }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The differential oracle. It must load, expose the buffer API the conformance diff
 * reads, and be the PINNED build — a stale install silently moves the baseline every
 * parity verdict is measured against.
 */
export function checkXtermBaseline(entry, benchManifest) {
  if (!existsSync(entry)) {
    return bad(
      'xterm',
      entry,
      'baseline not installed — bootstrap runs `pnpm -C tools/terminal-bench install --ignore-workspace`'
    )
  }
  let Terminal
  try {
    const mod = require(entry)
    Terminal = mod.Terminal ?? mod.default?.Terminal
  } catch (e) {
    return bad('xterm', entry, `present but does not load: ${firstLine(e)}`)
  }
  if (typeof Terminal !== 'function') {
    return bad('xterm', entry, 'loads but exports no Terminal — not @xterm/headless')
  }
  try {
    const term = new Terminal({ cols: 8, rows: 2, allowProposedApi: true })
    if (!term.buffer?.active) {
      return bad(
        'xterm',
        entry,
        'Terminal exposes no buffer.active — the conformance diff would read an empty grid'
      )
    }
  } catch (e) {
    return bad('xterm', entry, `Terminal constructor threw: ${firstLine(e)}`)
  }
  const installed = readJson(join(dirname(dirname(entry)), 'package.json'))?.version
  const pinned = readJson(benchManifest)?.dependencies?.['@xterm/headless']
  // Only an exact pin can be compared without a semver resolver; ranges just report.
  if (pinned && /^\d/u.test(pinned) && installed !== pinned) {
    return bad(
      'xterm',
      entry,
      `installed ${installed ?? 'unknown'} ≠ pinned ${pinned} — stale oracle; re-run \`pnpm -C tools/terminal-bench install --ignore-workspace\``
    )
  }
  return good('xterm', entry, installed ?? 'unknown')
}

/** The perf corpus: full size (a short read means a killed generator) and actually ANSI. */
export function checkPerfCorpus(path, minBytes = PERF_CORPUS_MIN_BYTES) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return bad('corpus', path, 'not generated — bootstrap runs the orca-terminal bench example')
  }
  if (!stat.isFile()) {
    return bad('corpus', path, 'is not a regular file')
  }
  if (stat.size < minBytes) {
    return bad(
      'corpus',
      path,
      `truncated: ${stat.size} B (${mib(stat.size)}) < ${mib(minBytes)} — delete it and re-run bootstrap`
    )
  }
  const head = Buffer.alloc(4096)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  if (!head.subarray(0, read).includes(0x1b)) {
    return bad('corpus', path, 'no ESC byte in the first 4 KiB — this is not the ANSI perf corpus')
  }
  return good('corpus', path, mib(stat.size))
}

export function prereqChecks({ addon, xtermEntry, benchManifest, corpus, corpusMinBytes }) {
  return [
    checkNapiAddon(addon),
    checkXtermBaseline(xtermEntry, benchManifest),
    checkPerfCorpus(corpus, corpusMinBytes)
  ]
}
