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

const REGISTRY_PATH = path.join(
  REPO_ROOT,
  'rust',
  'crates',
  'orca-dispatch',
  'src',
  'modules',
  'mod.rs'
)

// The arm shape in orca-dispatch's `match`: `"module-key" => Some(module::dispatch(...))`.
const DISPATCH_ARM = /"(?<key>[\w-]+)"\s*=>/gu

/** Module keys the Rust parity registry has a dispatch arm for. Throws rather than returning an
 *  empty set: "the registry is unreadable" must not look like "nothing is verified", which would
 *  silently move every module into the unverified column. */
export function parityDispatchedModules(registryPath = REGISTRY_PATH) {
  let source
  try {
    source = fs.readFileSync(registryPath, 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read the Rust parity dispatch registry at ${registryPath}, so no module can be told ` +
        `apart from an unverified one: ${error.message}`
    )
  }
  const keys = new Set([...source.matchAll(DISPATCH_ARM)].map((match) => match.groups.key))
  if (keys.size === 0) {
    throw new Error(
      `the Rust parity dispatch registry at ${registryPath} parsed to zero modules — the arm shape ` +
        `this scanner expects has changed, and every module would be reported as unverified`
    )
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
