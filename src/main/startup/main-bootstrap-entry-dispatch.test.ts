import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Plugin } from 'vite'
import { createMainCompileCacheBootstrapPlugin } from '../../../build-plugins/main-compile-cache-bootstrap'
import { E2EE_SECRET_HELPER_ENV_FLAG } from '../runtime/e2ee-secret-unseal-protocol'

function emittedBootstrap(): string {
  const plugin: Plugin = createMainCompileCacheBootstrapPlugin()
  const hook = plugin.generateBundle
  if (!hook) {
    throw new Error('Expected a generateBundle hook')
  }
  const handler = typeof hook === 'function' ? hook : hook.handler
  let source = ''
  const context = {
    emitFile(file: { fileName: string; source: string }) {
      if (file.fileName === 'bootstrap.js') {
        source = file.source
      }
    }
  }
  handler.call(context as never, {} as never, {} as never, {} as never)
  return source
}

describe('main bundle entry dispatch', () => {
  it('routes the keychain helper child away from the app bundle', () => {
    const bootstrap = emittedBootstrap()
    const helperIndex = bootstrap.indexOf(E2EE_SECRET_HELPER_ENV_FLAG)
    const appIndex = bootstrap.indexOf("require('./index.js')")

    // A packaged Electron binary has no default_app, so it ignores a script path in argv: the only
    // way to run a REAL Electron child (safeStorage does not exist under ELECTRON_RUN_AS_NODE) is
    // to re-enter through this entry. Dispatching after index.js would load the ~9MB app bundle —
    // and a second full app instance — for what is meant to be a disposable oracle.
    expect(helperIndex).toBeGreaterThanOrEqual(0)
    expect(bootstrap).toContain("require('./e2ee-secret-unseal-entry.js')")
    expect(appIndex).toBeGreaterThan(helperIndex)
  })

  it('emits the keychain helper as its own main entry', () => {
    const config = readFileSync(join(process.cwd(), 'electron.vite.config.ts'), 'utf8')

    // bootstrap.js requires ./e2ee-secret-unseal-entry.js by literal path; an unlisted input means
    // that file never exists and every unseal fails as helper_unavailable at runtime only.
    expect(config).toContain(
      "'e2ee-secret-unseal-entry': resolve('src/main/runtime/e2ee-secret-unseal-entry.ts')"
    )
  })
})
