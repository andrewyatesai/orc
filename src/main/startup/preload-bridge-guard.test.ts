import { describe, expect, it } from 'vitest'
import { createPreloadBridgeGuardPlugin } from '../../../build-plugins/preload-bridge-guard'

// Why this exists: a sandboxed preload is loaded as ONE file from a literal path,
// so a renamed entry, a split-out chunk, or an ESM module are all fatal AND silent
// — Electron loads nothing, window.api is undefined, and the renderer lands in its
// error boundary with every suite still green. That shipped once (the rolldown
// migration emitted `.mjs` entries plus a shared `chunks/electron-*.js`), so the
// guard is the contract and these cases are its proof.

type Chunk = {
  type: 'chunk'
  isEntry: boolean
  name: string
  fileName: string
  imports: string[]
  dynamicImports: string[]
  code: string
}

function chunk(name: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    type: 'chunk',
    isEntry: true,
    name,
    fileName: `${name}.js`,
    imports: [],
    dynamicImports: [],
    code: '',
    ...overrides
  }
}

function runGuard(bundle: Record<string, Chunk>, format = 'cjs'): string | null {
  const plugin = createPreloadBridgeGuardPlugin()
  const generateBundle = plugin.generateBundle as unknown as (
    this: { error: (message: string) => never },
    options: { format: string },
    bundle: Record<string, Chunk>
  ) => void
  let message: string | null = null
  const context = {
    error: (raised: string) => {
      message = raised
      throw new Error(raised)
    }
  }
  try {
    generateBundle.call(context as never, { format }, bundle)
  } catch {
    // The guard reports through this.error; the message is captured above.
  }
  return message
}

const healthyBundle = (): Record<string, Chunk> => ({
  'index.js': chunk('index', { imports: ['electron'] }),
  'coordinator.js': chunk('coordinator', { imports: ['electron'] })
})

describe('preload bridge guard', () => {
  it('passes a single-file CommonJS bridge that externalizes electron', () => {
    expect(runGuard(healthyBundle())).toBeNull()
  })

  it('fails when an entry is emitted under a different extension', () => {
    const bundle = healthyBundle()
    bundle['index.mjs'] = chunk('index', { fileName: 'index.mjs' })
    delete bundle['index.js']

    expect(runGuard(bundle)).toContain('index.mjs')
  })

  it('fails when an entry imports an emitted chunk, which a sandboxed preload cannot load', () => {
    const bundle = healthyBundle()
    bundle['chunks/electron-abc123.js'] = chunk('electron', {
      isEntry: false,
      fileName: 'chunks/electron-abc123.js'
    })
    bundle['index.js'] = chunk('index', { imports: ['chunks/electron-abc123.js'] })

    expect(runGuard(bundle)).toContain('chunks/electron-abc123.js')
  })

  it('fails when the build emits ESM, which is unloadable even under a .js name', () => {
    expect(runGuard(healthyBundle(), 'es')).toContain('CommonJS')
  })

  it('fails when an entry a window loads was not emitted at all', () => {
    const bundle = healthyBundle()
    delete bundle['coordinator.js']

    expect(runGuard(bundle)).toContain('coordinator')
  })

  it('accepts externals, which are resolved by Electron rather than emitted', () => {
    const bundle = healthyBundle()
    bundle['index.js'] = chunk('index', { imports: ['electron', 'node:path'] })

    expect(runGuard(bundle)).toBeNull()
  })
})
