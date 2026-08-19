#!/usr/bin/env node
// Which TS exports can NEVER be cut over, because a shim's pre-ready fallback
// calls them?
//
// The `parity` contract (docs/rust-migration/ported-modules.md) says a shim
// whose degraded answer has no safe sentinel recomputes the deleted twin's body
// locally. That body has to run when the seam is UNBOUND — the renderer's boot
// window, and permanently on the web preload and mobile, which never install a
// binding. So anything the fallback itself calls must stay a real TS
// implementation: a fallback that dispatches is not a fallback.
//
// Run this before attempting a cutover. If the export is listed, the answer is
// not "measure the cost" — it is "this one is load-bearing".
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const DISPATCH = /tryOrcaDispatch|requireOrcaDispatch|dispatchToWasmCore/

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      yield* walk(path)
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      yield path
    }
  }
}

function resolveImport(from, spec) {
  const base = normalize(join(dirname(from), spec))
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      /* not this one */
    }
  }
  return null
}

const shims = [...walk(join(ROOT, 'src'))]
  .map((path) => [path, readFileSync(path, 'utf8')])
  .filter(([, text]) => DISPATCH.test(text))

const loadBearing = new Map()
for (const [path, text] of shims) {
  const fallbackBodies = [...text.matchAll(/function legacy\w+\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
    .map((match) => match[1])
    .join('')
  if (!fallbackBodies) {
    continue
  }
  for (const [, block, spec] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const target = resolveImport(path, spec)
    if (!target || DISPATCH.test(readFileSync(target, 'utf8'))) {
      continue
    }
    for (const raw of block.split(',')) {
      const name = raw.trim()
      if (!name || name.startsWith('type ')) {
        continue
      }
      if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(fallbackBodies)) {
        continue
      }
      const key = `${relative(ROOT, target)}::${name}`
      loadBearing.set(key, [...new Set([...(loadBearing.get(key) ?? []), relative(ROOT, path)])])
    }
  }
}

console.log(`${shims.length} shim files dispatch on the seam.`)
console.log(`${loadBearing.size} exports are called from inside a pre-ready fallback and cannot cross:\n`)
for (const key of [...loadBearing.keys()].sort()) {
  console.log(`  ${key}`)
  console.log(`      needed by: ${loadBearing.get(key).sort().join(', ')}`)
}
