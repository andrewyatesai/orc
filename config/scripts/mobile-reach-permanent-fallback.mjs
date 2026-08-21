#!/usr/bin/env node
// Why `terminal-stream-protocol` and `browser-screencast-protocol` are NOT cut
// over, as a check rather than a paragraph. Exits 0 while the reason holds and
// non-zero once it does not, so the refusal expires instead of going stale.
//
// Both are frame codecs — terminal binary framing and screencast decode, the
// two highest-rate paths in the app — and both are imported by
// `mobile/src/transport/`. Mobile never installs an orca-dispatch binding, so a
// shim there would not have a boot window that ends: the pre-ready fallback
// would be the permanent answer, on the hottest code in the product, plus a
// seam round trip per frame to reach it.
//
// The blocker clears if mobile ever binds the seam. That is what this checks.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const BINDING = /setOrcaDispatchBinding|initSync|orca_git_wasm|orcaDispatch\(/

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'node_modules') {
      continue
    }
    if (statSync(path).isDirectory()) {
      yield* walk(path)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield path
    }
  }
}

const mobileFiles = [...walk(join(ROOT, 'mobile/src'))]
const binds = mobileFiles.filter((path) => BINDING.test(readFileSync(path, 'utf8')))

const CODECS = ['terminal-stream-protocol', 'browser-screencast-protocol']
for (const codec of CODECS) {
  const importers = mobileFiles.filter((path) => readFileSync(path, 'utf8').includes(codec))
  console.log(`  ${codec}: ${importers.length} mobile importer(s)`)
  for (const path of importers) {
    console.log(`      ${path.slice(ROOT.length)}`)
  }
}
console.log(`  mobile files installing a dispatch binding: ${binds.length}`)

if (binds.length > 0) {
  console.log('\nMobile now binds the seam — this refusal is stale. Re-cost both codecs;')
  console.log('the fallback would no longer be permanent, only the per-frame seam cost remains.')
  process.exit(1)
}
console.log('\nMobile installs no binding, so a shim there would answer from its fallback')
console.log('FOREVER — per frame, on the hottest paths in the app. Both stay in TS.')
