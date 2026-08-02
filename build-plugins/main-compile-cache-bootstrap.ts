import type { Plugin } from 'vite'



// Why: the ~9MB main bundle costs ~80ms of V8 parse+compile before app-ready on
// every cold launch (measured: vm.Script cold 79ms vs 0.1ms with code cache).
// Node's on-disk compile cache (Node >=22.8; Electron 43 ships 24.x) eliminates
// that on every launch after the first — but only for modules loaded through the
// CJS loader AFTER the cache is enabled, so the executing entry cannot cache its
// own compile. The packaged entry is therefore a tiny bootstrap that enables the
// cache and then requires the real bundle (which also covers every external
// dep's compile: zod, yaml, ssh2, i18next, …). package.json "main" points here.
//
// The explicit flush exists because Node only persists entries on CLEAN exit; a
// SIGKILLed app (crash, benchmark harness, force-quit) would otherwise never
// seed the cache.
const BOOTSTRAP_SOURCE = `'use strict'
try {
  require('node:module').enableCompileCache()
} catch {
  // Cache setup must never break launch (read-only tmp, exotic runtimes).
}
require('./index.js')
try {
  require('node:module').flushCompileCache()
} catch {
  // Flushing is an optimization; never let it affect startup.
}
`

export function createMainCompileCacheBootstrapPlugin(): Plugin {
  return {
    name: 'orca-main-compile-cache-bootstrap',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'bootstrap.js', source: BOOTSTRAP_SOURCE })
    }
  }
}
