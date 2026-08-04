import type { Plugin, Rollup } from 'vite'
import { describe, expect, it } from 'vitest'
import { createPlainNodeEntryGuardPlugin } from '../../build-plugins/plain-node-entry-guard'

// Mirrors PLAIN_NODE_ENTRY_NAMES in build-plugins/plain-node-entry-guard.ts; upstream's
// `daemon-entry` is absent because the fork's daemon is the Rust runtime, not a Node fork.
const PLAIN_NODE_ENTRY_NAMES = [
  'parcel-watcher-process-entry',
  'computer-sidecar',
  'agent-hooks/managed-agent-hook-controls',
  'codex/codex-app-server-grant-entry'
] as const

function entryChunk(name: string, code: string): Rollup.OutputChunk {
  return {
    type: 'chunk',
    code,
    dynamicImports: [],
    fileName: `${name}.js`,
    imports: [],
    isEntry: true,
    name
  } as Rollup.OutputChunk
}

// Why: the guard hard-fails on any unresolved entry, so a partial fixture would never
// reach the electron-require scan the tests below are actually asserting.
function bundleWithEveryGuardedEntry(code = ''): Rollup.OutputBundle {
  const bundle: Rollup.OutputBundle = {}
  for (const name of PLAIN_NODE_ENTRY_NAMES) {
    bundle[`${name}.js`] = entryChunk(name, code)
  }
  return bundle
}

function runWriteBundle(plugin: Plugin, bundle: Rollup.OutputBundle): void {
  const hook = plugin.writeBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected writeBundle hook')
  }
  hook.call({ meta: { watchMode: false } } as never, {} as Rollup.NormalizedOutputOptions, bundle)
}

describe('plain Node entry guard', () => {
  it('passes when every guarded entry is emitted and none requires electron', () => {
    expect(() =>
      runWriteBundle(createPlainNodeEntryGuardPlugin(), bundleWithEveryGuardedEntry())
    ).not.toThrow()
  })

  it('rejects Electron imports during the static bundle scan', () => {
    expect(() =>
      runWriteBundle(
        createPlainNodeEntryGuardPlugin(),
        bundleWithEveryGuardedEntry('require("electron")')
      )
    ).toThrow('requires electron')
  })

  it('hard-fails when a guarded plain-Node entry is renamed or removed', () => {
    const bundle = bundleWithEveryGuardedEntry()
    delete bundle['computer-sidecar.js']

    expect(() => runWriteBundle(createPlainNodeEntryGuardPlugin(), bundle)).toThrow(
      /no emitted entry chunk for "computer-sidecar"/
    )
  })

  it('stays a static scan — the fork has no forked daemon-entry to smoke-load', () => {
    expect(createPlainNodeEntryGuardPlugin().closeBundle).toBeUndefined()
  })
})
