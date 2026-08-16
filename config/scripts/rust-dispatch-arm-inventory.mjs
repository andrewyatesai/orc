// Which function names the Rust dispatch layer actually answers to.
//
// This is the check `pnpm parity` structurally cannot make: the corpus iterates
// the cases it has, so it can never miss a case for a function it has never
// named. An export that orca_core implements but orca-dispatch never registered
// is invisible to it, and both shipped cores answer `unknown function <name>`.
//
// `stable-pane-id::makePaneKey` is why this exists — the module's key MINTER,
// ~60 production importers, used as a React key, implemented in orca_core all
// along and simply absent from the match. A shim over it would have thrown on
// the first pane key once wasm initialised.

import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT } from './typescript-symbol-resolution.mjs'

const MODULES_DIR = 'rust/crates/orca-dispatch/src/modules'

/** The arms one dispatch module file registers, or null when there is no file. */
function armsInDispatchModule(moduleName) {
  const file = path.join(REPO_ROOT, MODULES_DIR, `${moduleName.replaceAll('-', '_')}.rs`)
  if (!fs.existsSync(file)) {
    return null
  }
  const source = fs.readFileSync(file, 'utf8')
  const body = source.slice(source.indexOf('match function {'))
  return new Set([...body.matchAll(/^\s*"([A-Za-z0-9_]+)"\s*(?:=>|\|)/gm)].map((m) => m[1]))
}

/** Arms reachable for a twin, across EVERY vector module that names it.
 *
 *  Two vector files can declare the same `source`: commit-message-models and
 *  commit-message-agent-spec both point at src/shared/commit-message-agent-spec.ts.
 *  Looking only in `modules/<thisModule>.rs` reported each module's exports as
 *  unrouted because the arms live in the OTHER module's file — the same false
 *  positive in both directions at once. It cost an agent a slot: it was sent to
 *  route 8 exports, of which 7 were already routed and the report was wrong about
 *  every one. An export is routed if ANY module sharing its twin answers to it. */
export function rustDispatchArms(moduleName, siblingModules = []) {
  const own = armsInDispatchModule(moduleName)
  const siblings = siblingModules.map(armsInDispatchModule).filter(Boolean)
  if (own === null && siblings.length === 0) {
    return null
  }
  return new Set([...(own ?? []), ...siblings.flatMap((set) => [...set])])
}
