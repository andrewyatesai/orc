// Which ported modules the Rust parity harness dispatches — i.e. which ones have a differential
// TS-vs-Rust check behind them at all.
//
// WHY THIS SPLIT EXISTS. Without it, report:rust-orphans lumps two very different things together
// under one heading. A module whose Rust is proven case-by-case equal to its TypeScript twin and is
// simply awaiting a production cutover is the SPEC pattern the codebase uses on purpose
// (rust/crates/orca-flow-control/src/lib.rs: "It is NOT a production cutover ... this core is the
// machine-checkable, ay-provable SPEC"). A module with neither a production caller NOR a
// differential check is the one nothing at all vouches for. Reporting 57 of the first kind buries
// the 2 of the second.
//
// THIS IS A DECLARED INPUT, read from Rust source text, and the honest direction note is that
// forging it moves a module the WRONG way — adding a bogus `"x" => …` arm would promote x out of
// the unverified list. It is not evidence that the check passed; `pnpm parity` is. The measured
// alternative, tools/parity/rust_outputs.json, is gitignored build output that does not exist on a
// fresh clone, so it cannot be the primary source.

import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT } from './typescript-symbol-resolution.mjs'

// Why TWO registries and not one: orca-dispatch is the shipped registry, shared by production
// napi/wasm and the harness. orca-parity layers over it the modules that are parity-only oracles
// with no production consumer, kept out of the shipped artifact on purpose — `orchestration-store`
// pulls rusqlite/orca-runtime and `nacl-box` drags curve25519/salsa20/poly1305 into the relay wasm
// for no caller. Reading only the first reported exactly those two as unverified, which inverted
// the finding: they are the most deliberate spec twins in the corpus, not the neglected ones.
const REGISTRY_PATHS = [
  path.join(REPO_ROOT, 'rust', 'crates', 'orca-dispatch', 'src', 'modules', 'mod.rs'),
  path.join(REPO_ROOT, 'rust', 'crates', 'orca-parity', 'src', 'modules', 'mod.rs')
]

// The arm shape in orca-dispatch's `match`: `"module-key" => Some(module::dispatch(...))`.
const DISPATCH_ARM = /"(?<key>[\w-]+)"\s*=>/gu

/** Module keys the Rust parity registry has a dispatch arm for. Throws rather than returning an
 *  empty set: "the registry is unreadable" must not look like "nothing is verified", which would
 *  silently move every module into the unverified column. */
export function parityDispatchedModules(registryPaths = REGISTRY_PATHS) {
  const keys = new Set()
  for (const registryPath of registryPaths) {
    let source
    try {
      source = fs.readFileSync(registryPath, 'utf8')
    } catch (error) {
      throw new Error(
        `cannot read the Rust parity dispatch registry at ${registryPath}, so no module can be ` +
          `told apart from an unverified one: ${error.message}`
      )
    }
    // Why per-file and not only on the union: a registry that stops parsing contributes silently to
    // a non-empty union, and its modules quietly become "unverified" with nothing reporting why.
    const found = [...source.matchAll(DISPATCH_ARM)].map((match) => match.groups.key)
    if (found.length === 0) {
      throw new Error(
        `the Rust parity dispatch registry at ${registryPath} parsed to zero modules — the arm ` +
          `shape this scanner expects has changed, and its modules would read as unverified`
      )
    }
    for (const key of found) {
      keys.add(key)
    }
  }
  return keys
}

/** Splits orphan candidates into the ones a differential check covers and the ones nothing does. */
export function partitionByParityCoverage(orphans, dispatched = parityDispatchedModules()) {
  const verified = []
  const unverified = []
  for (const module of orphans) {
    ;(dispatched.has(module.name) ? verified : unverified).push(module)
  }
  return { verified, unverified }
}
