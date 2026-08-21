import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
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
  const fakeRequire = (id: string): unknown =>
    id === 'node:sqlite' ? unavailable() : realRequire(id)
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

const temporaryDirectories: string[] = []
const openDatabases: SyncDatabase.Database[] = []

async function createDatabase(): Promise<SyncDatabase.Database> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-sync-database-'))
  temporaryDirectories.push(directory)
  const db = new SyncDatabase(join(directory, 'test.db'))
  openDatabases.push(db)
  db.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT); ' +
      "INSERT INTO items (id, label) VALUES ('a', 'alpha'), ('b', 'beta')"
  )
  return db
}

afterEach(async () => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('SyncDatabase statement cache', () => {
  it('reuses the same statement object for identical SQL', async () => {
    const db = await createDatabase()
    const sql = 'SELECT label FROM items WHERE id = ?'

    expect(db.prepare(sql)).toBe(db.prepare(sql))
    expect(db.prepare('SELECT id FROM items WHERE id = ?')).not.toBe(db.prepare(sql))
  })

  it('returns correct rows when a reused statement is bound to different values', async () => {
    const db = await createDatabase()
    const sql = 'SELECT label FROM items WHERE id = ?'

    expect(db.prepare(sql).get('a')).toEqual({ label: 'alpha' })
    expect(db.prepare(sql).get('b')).toEqual({ label: 'beta' })
    expect(db.prepare(sql).get('missing')).toBeUndefined()
    expect(db.prepare(sql).all('a')).toEqual([{ label: 'alpha' }])
  })

  it('bounds the cache so per-arity SQL cannot grow it without limit', async () => {
    const db = await createDatabase()
    const first = 'SELECT 0 AS n'
    const firstStatement = db.prepare(first)
    for (let index = 1; index <= 256; index += 1) {
      db.prepare(`SELECT ${index} AS n`)
    }

    expect(db.prepare(first)).not.toBe(firstStatement)
    expect(db.prepare('SELECT 256 AS n')).toBe(db.prepare('SELECT 256 AS n'))
  })

  it('drops cached statements on close', async () => {
    const db = await createDatabase()
    db.prepare('SELECT label FROM items WHERE id = ?')
    db.close()

    const cache = (db as unknown as { statementCache: Map<string, unknown> }).statementCache
    expect(cache.size).toBe(0)
  })

  it('does not serve a stale statement after DDL adds a column', async () => {
    const db = await createDatabase()
    expect(db.prepare('SELECT * FROM items WHERE id = ?').all('a')).toEqual([
      { id: 'a', label: 'alpha' }
    ])

    db.exec("ALTER TABLE items ADD COLUMN note TEXT; UPDATE items SET note = 'noted'")

    expect(db.prepare('SELECT * FROM items WHERE id = ?').all('a')).toEqual([
      { id: 'a', label: 'alpha', note: 'noted' }
    ])
    expect(db.prepare('SELECT label FROM items WHERE id = ?').all('a')).toEqual([
      { label: 'alpha' }
    ])
  })

  it('keeps a cached statement correct when another connection changes the schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-sync-database-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'shared.db')
    const writer = new SyncDatabase(path)
    const reader = new SyncDatabase(path)
    openDatabases.push(writer, reader)
    writer.exec("CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES ('a')")
    const sql = 'SELECT id FROM items ORDER BY id'
    expect(reader.prepare(sql).all()).toEqual([{ id: 'a' }])

    writer.exec("ALTER TABLE items ADD COLUMN note TEXT; INSERT INTO items VALUES ('b', 'noted')")

    expect(reader.prepare(sql).all()).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(reader.prepare('SELECT note FROM items WHERE id = ?').all('b')).toEqual([
      { note: 'noted' }
    ])
  })

  it('does not cache wildcard selects or pragma statements', async () => {
    const db = await createDatabase()

    expect(db.prepare('SELECT * FROM items')).not.toBe(db.prepare('SELECT * FROM items'))
    expect(db.prepare('PRAGMA table_info(items)')).not.toBe(db.prepare('PRAGMA table_info(items)'))
    expect(db.prepare('SELECT COUNT(*) AS n FROM items')).toBe(
      db.prepare('SELECT COUNT(*) AS n FROM items')
    )
  })

  it('keeps cached statements across transaction control and other non-DDL exec calls', async () => {
    const db = await createDatabase()
    const sql = 'SELECT label FROM items WHERE id = ?'
    const statement = db.prepare(sql)

    db.exec('BEGIN IMMEDIATE')
    db.exec("INSERT INTO items (id, label) VALUES ('c', 'gamma')")
    db.exec('COMMIT')

    expect(db.prepare(sql)).toBe(statement)
    expect(statement.get('c')).toEqual({ label: 'gamma' })
  })
})
