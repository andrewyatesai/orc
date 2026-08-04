import type { RustOrchestrationStoreHandle } from '../../daemon/rust-git-addon'
import type { OrchestrationDb } from './db'

/**
 * Raw-SQL access to the store an `OrchestrationDb` owns — **specs and tooling
 * only**.
 *
 * The fork's store lives in Rust, so there is no `node:sqlite` handle to reach
 * for, and a `:memory:` database cannot be opened a second time. Specs that must
 * seed a table directly, read `EXPLAIN QUERY PLAN`, or assert on `sqlite_master`
 * use this instead; it deliberately mirrors the little of `sync-database`'s
 * shape those specs use so they read the same on both sides of the cutover.
 */
export type SqliteBindValue = string | number | boolean | null

export type OrchestrationSqliteStatement = {
  run(...params: SqliteBindValue[]): void
  get<T>(...params: SqliteBindValue[]): T | undefined
  all<T>(...params: SqliteBindValue[]): T[]
}

export type OrchestrationSqliteProbe = {
  exec(sql: string): void
  prepare(sql: string): OrchestrationSqliteStatement
  pragma(name: string, options: { simple: true }): unknown
}

export function orchestrationSqliteProbe(db: OrchestrationDb): OrchestrationSqliteProbe {
  // The napi handle is `protected` on the shim; reaching it here keeps the cast
  // in one place instead of once per spec.
  const store = (db as unknown as { store: RustOrchestrationStoreHandle }).store
  const query = <T>(sql: string, params: SqliteBindValue[]): T[] =>
    JSON.parse(store.rawQueryJson(sql, JSON.stringify(params))) as T[]

  return {
    exec: (sql) => store.rawExec(sql, '[]'),
    prepare: (sql) => ({
      run: (...params) => store.rawExec(sql, JSON.stringify(params)),
      get: <T>(...params: SqliteBindValue[]) => query<T>(sql, params)[0],
      all: <T>(...params: SqliteBindValue[]) => query<T>(sql, params)
    }),
    pragma: (name) => query<Record<string, unknown>>(`PRAGMA ${name}`, [])[0]?.[name]
  }
}
