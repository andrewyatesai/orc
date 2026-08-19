// Main-process task-query parser/serializer, driven by the Rust orca-core
// task_query port via napi (the shared TS impl was deleted). One source of truth
// with the parity-proven Rust port — the GitHub client parses the saved search
// string through the same core the renderer runs via wasm.
import { dispatchToRustCore } from './rust-core-dispatch'
import type { ParsedTaskQuery, TaskQueryFilterKey } from '../shared/task-query'

// ParsedTaskQuery is a closed record (every field required, absences spelled
// `null`), so no undefined-property relaxation is warranted.
function dispatch(fn: string, input: unknown): unknown {
  return dispatchToRustCore('task-query', fn, input)
}

export function tokenizeSearchQuery(rawQuery: string): string[] {
  return dispatch('tokenizeSearchQuery', rawQuery) as string[]
}

export function parseTaskQuery(rawQuery: string): ParsedTaskQuery {
  return dispatch('parseTaskQuery', rawQuery) as ParsedTaskQuery
}

export function serializeTaskQuery(query: ParsedTaskQuery): string {
  return dispatch('serializeTaskQuery', query) as string
}

export function withQualifier(
  rawQuery: string,
  key: TaskQueryFilterKey,
  value: string | string[] | null
): string {
  return dispatch('withQualifier', { rawQuery, key, value }) as string
}

export function stripRepoQualifiers(rawQuery: string): string {
  return dispatch('stripRepoQualifiers', rawQuery) as string
}
