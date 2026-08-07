// Finding every classified write call in the analysed tree.
//
// THERE IS NO CALLEE PREFILTER, AND THE REMOVAL WAS DELIBERATE.
//
// A previous version of this module resolved a property callee (`x.foo()`) only
// when `foo` was already a known writer name, on the stated ground that "a
// property access has no renaming form, so `x.foo()` can only resolve to a
// declaration named `foo`". That is false. A renamed re-export reached as a
// namespace member breaks it:
//
//   barrel.ts    export { writeFileSync as saveIt } from './disk'
//   consumer.ts  import * as ns from './barrel'; ns.saveIt(path, apiToken)
//
// The checker resolves `ns.saveIt` to the declaration named `writeFileSync`,
// which IS a sink — but the property text is `saveIt`, so the name filter
// dropped the call and the write was never classified. Verified by hand against
// this exact fixture: filter on found 0 sites, filter off found 1.
//
// The filter could have been patched (resolve the alias chain before skipping,
// or close the name set over every `export { X as Y }` in the Program), but
// every patch leaves the same residual claim — "these are all the renaming forms
// TypeScript has" — which is a trust anchor outside the checker. Deleting the
// filter removes the claim instead of narrowing it.
//
// MEASURED COST OF THE DELETION on this repo (M-series mac, warm cache):
//   node project discovery  2.3s -> 6.8s
//   cli  project discovery  0.33s -> 0.40s
//   whole gate              ~12.5s -> ~17s
// The site set was unchanged (0 added, 0 removed on both projects) when this was
// measured by hand. NOT PROVED: there is no test covering the one filter that
// remains (the file-level reachability filter), so that equality is an
// observation from a single run, not an invariant anything re-checks.

import ts from 'typescript-api'

import { normalizeProgramPath } from './typescript-program-cache.mjs'
import { classifyCall } from './credential-write-sink-model.mjs'

/** Every classified write call in the walked files. `orderedKeys` fixes the walk
 *  order only — it warms the wrapper memo depth-first. Order-independence was
 *  checked by hand against a differently ordered walk; no test pins it. */
export function discoverWriteCalls(project, sinks, orderedKeys) {
  const started = performance.now()
  const byKey = new Map()
  for (const sourceFile of project.program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      byKey.set(normalizeProgramPath(sourceFile.fileName), sourceFile)
    }
  }

  const classified = new Map()
  let totalCalls = 0
  for (const key of orderedKeys) {
    const sourceFile = byKey.get(key)
    if (!sourceFile) {
      continue
    }
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        totalCalls += 1
        const result = classifyCall(sinks, node)
        if (result) {
          classified.set(node, result)
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sourceFile, visit)
  }

  return { classified, totalCalls, resolvedCalls: totalCalls, ms: performance.now() - started }
}
