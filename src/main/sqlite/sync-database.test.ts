import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import SyncDatabase from './sync-database'

// Why: SSH relay companions run on Node 18, where node:sqlite is not a builtin.
// The relay bundles this adapter into managed-hook-runtime.js, so an eager
// top-level `import ... from 'node:sqlite'` makes the whole companion throw
// ERR_UNKNOWN_BUILTIN_MODULE at load — before any agent installer runs.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const JSONC_PARSER_ESM = join(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js')

// Bundle an entry exactly as config/scripts/build-relay.mjs does its companions.
async function bundleForNode18(entry: string, alias?: Record<string, string>): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    alias,
    write: false,
    logLevel: 'silent'
  })
  return result.outputFiles[0].text
}

// Evaluate a CJS bundle with node:sqlite made unavailable, i.e. as Node 18 sees it.
function loadWithSqliteUnavailable(code: string): unknown {
  const realRequire = createRequire(import.meta.url)
  const unavailable = (): never => {
    const error = new Error('node:sqlite is unavailable in this Node.js runtime') as Error & {
      code?: string
    }
    error.code = 'ERR_UNKNOWN_BUILTIN_MODULE'
    throw error
  }
  const fakeRequire = (id: string): unknown => (id === 'node:sqlite' ? unavailable() : realRequire(id))
  const fakeProcess = Object.create(process) as NodeJS.Process
  fakeProcess.getBuiltinModule = ((name: string) =>
    name === 'node:sqlite' ? unavailable() : process.getBuiltinModule(name as never)) as never
  const module = { exports: {} as Record<string, unknown> }
  const evaluate = new Function('require', 'module', 'exports', 'process', code)
  evaluate(fakeRequire, module, module.exports, fakeProcess)
  return module.exports.default
}

describe('sync-database Node 18 relay-companion loadability', () => {
  it('bundles the managed-hook companion without an eager node:sqlite require', async () => {
    const companion = await bundleForNode18(
      join(ROOT, 'src', 'main', 'agent-hooks', 'managed-hook-runtime.ts'),
      { 'jsonc-parser': JSONC_PARSER_ESM }
    )
    // The adapter is genuinely in the companion graph via a lazy lookup...
    expect(companion).toContain('getBuiltinModule("node:sqlite")')
    // ...and never as a load-time require that Node 18 cannot resolve.
    expect(companion).not.toContain('require("node:sqlite")')
  })

  it('loads under a runtime without node:sqlite and defers resolution to open time', async () => {
    const code = await bundleForNode18(join(ROOT, 'src', 'main', 'sqlite', 'sync-database.ts'))
    let Database: unknown
    // Loading must not throw even when node:sqlite is unavailable.
    expect(() => {
      Database = loadWithSqliteUnavailable(code)
    }).not.toThrow()
    const Ctor = Database as new (path: string) => unknown
    // Opening a database is the point where node:sqlite is finally needed.
    expect(() => new Ctor(':memory:')).toThrow(/node:sqlite is unavailable/)
  })
})

describe('sync-database on a runtime with node:sqlite', () => {
  it('opens, executes, and reads through the built-in adapter', () => {
    const db = new SyncDatabase(':memory:')
    try {
      db.exec('CREATE TABLE t (x INTEGER)')
      db.prepare('INSERT INTO t VALUES (?)').run(7)
      expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 7 }])
      expect(db.pragma('user_version', { simple: true })).toBe(0)
    } finally {
      db.close()
    }
  })
})
