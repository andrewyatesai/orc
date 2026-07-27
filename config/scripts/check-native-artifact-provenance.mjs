#!/usr/bin/env node

// Provenance gate for the NATIVE half of the aterm engine.
//
// check-aterm-artifact-pin.mjs covers the committed wasm artifacts, but the aterm engine
// also ships as two BUILD OUTPUTS that are not in git and were therefore unverified:
//
//   * native/orca-node/orca_node.node  — the napi addon (the headless engine)
//   * rust/target/release/orca-daemon  — the daemon, which statically embeds its own copy
//
// Nothing bound those to the submodule pin, so a stale addon could ship beside freshly
// rebuilt wasm and no gate objected. Each build now records the exact aterm commit it was
// produced from; this script asserts those stamps match the submodule.
//
// Runs offline. Two modes:
//   (default)   a MISMATCH always fails; a missing artifact is skipped and a missing
//               stamp only warns, so `pnpm lint` works on a fresh clone and on binaries
//               built before stamping existed.
//   --require   every artifact must exist, be stamped, AND match — for build:release,
//               where shipping an unprovenanced binary is the failure this gate exists
//               to prevent.
//
// Usage: node config/scripts/check-native-artifact-provenance.mjs [--require]

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  readCleanAtermSourceCommit,
  readInstalledAtermSourceCommit
} from './terminal-addon-source-stamp.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const SUBMODULE = resolve(ROOT, 'rust/aterm')
const require_ = process.argv.includes('--require')
const binExt = process.platform === 'win32' ? '.exe' : ''

const ARTIFACTS = [
  {
    label: 'orca_node.node',
    binary: resolve(ROOT, 'native/orca-node/orca_node.node'),
    stamp: resolve(ROOT, 'native/orca-node/target/.orca-installed-aterm-source.json'),
    rebuild: 'pnpm run build:terminal-addon --force'
  },
  {
    label: `orca-daemon${binExt}`,
    binary: resolve(ROOT, `rust/target/release/orca-daemon${binExt}`),
    stamp: resolve(ROOT, 'rust/target/release/.orca-daemon-aterm-source.json'),
    rebuild: 'pnpm run build:rust-daemon'
  }
]

function fail(message) {
  console.error(`[check-native-provenance] ${message}`)
  process.exit(1)
}

if (!existsSync(resolve(SUBMODULE, 'Cargo.toml'))) {
  fail('rust/aterm submodule is not initialized — run `git submodule update --init rust/aterm`.')
}

// Why: a dirty submodule has no exact provenance to compare against, so any stamp we
// verified would be meaningless. check-aterm-pin already fails loudly on this; matching
// its posture keeps one answer for "is this tree publishable".
const sourceCommit = readCleanAtermSourceCommit(SUBMODULE)
if (!sourceCommit) {
  if (require_) {
    fail('rust/aterm has uncommitted changes, so native artifact provenance is not exact')
  }
  console.log('[check-native-provenance] skipped — rust/aterm checkout is not clean')
  process.exit(0)
}

const mismatches = []
const warnings = []
const verified = []

for (const artifact of ARTIFACTS) {
  const present = existsSync(artifact.binary)
  if (!present) {
    if (require_) {
      mismatches.push(`${artifact.label} is missing — run \`${artifact.rebuild}\``)
    }
    continue
  }
  const stamped = readInstalledAtermSourceCommit(artifact.stamp)
  if (!stamped) {
    // Why: unstamped is UNKNOWN, not WRONG — a binary built before stamping existed is
    // not evidence of drift. Release refuses it; lint reports it.
    const note = `${artifact.label} carries no aterm source stamp — rebuild it with \`${artifact.rebuild}\``
    ;(require_ ? mismatches : warnings).push(note)
    continue
  }
  if (stamped !== sourceCommit) {
    mismatches.push(
      `${artifact.label} was built from aterm ${stamped.slice(0, 12)} but the submodule pins ` +
        `${sourceCommit.slice(0, 12)} — rebuild it with \`${artifact.rebuild}\``
    )
    continue
  }
  const bytes = readFileSync(artifact.binary)
  verified.push(
    `${artifact.label} @ ${sourceCommit.slice(0, 12)} ` +
      `(${bytes.byteLength} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)})`
  )
}

if (mismatches.length > 0) {
  console.error('[check-native-provenance] native artifacts do not match the aterm submodule pin:')
  for (const m of mismatches) {
    console.error(`  - ${m}`)
  }
  process.exit(1)
}

for (const w of warnings) {
  console.warn(`[check-native-provenance] warning: ${w}`)
}

if (verified.length === 0) {
  console.log('[check-native-provenance] OK — no native artifacts built yet')
} else {
  console.log(`[check-native-provenance] OK — ${verified.join('; ')}`)
}
