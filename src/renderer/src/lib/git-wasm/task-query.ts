// Renderer task-query parser/serializer, driven by the Rust orca-core task_query
// port in the orca-git wasm module (the shared TS impl was deleted). Every
// callsite runs SYNCHRONOUSLY in TaskPage render/useMemo, so the not-ready
// branch returns a valid non-null default (empty query / the raw string
// unchanged / []) — never null into a sync consumer — degrading to a no-filter
// view for the ~tens-of-ms wasm-boot window, then recomputing once wasm is ready.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { ParsedTaskQuery, TaskQueryFilterKey } from '../../../../shared/task-query'

function emptyParsedTaskQuery(): ParsedTaskQuery {
  return {
    scope: 'all',
    state: null,
    draft: false,
    assignee: null,
    author: null,
    reviewRequested: null,
    reviewedBy: null,
    labels: [],
    freeText: ''
  }
}

// ParsedTaskQuery is a closed record (every field required, absences spelled
// `null`), so no undefined-property relaxation is warranted.
function op(fn: string, input: unknown): unknown {
  if (!isGitWasmReady()) {return null}
  return dispatchToWasmCore('task-query', fn, input)
}

export function tokenizeSearchQuery(rawQuery: string): string[] {
  return (op('tokenizeSearchQuery', rawQuery) as string[] | null) ?? []
}

export function parseTaskQuery(rawQuery: string): ParsedTaskQuery {
  return (op('parseTaskQuery', rawQuery) as ParsedTaskQuery | null) ?? emptyParsedTaskQuery()
}

export function serializeTaskQuery(query: ParsedTaskQuery): string {
  return (op('serializeTaskQuery', query) as string | null) ?? ''
}

export function withQualifier(
  rawQuery: string,
  key: TaskQueryFilterKey,
  value: string | string[] | null
): string {
  return (op('withQualifier', { rawQuery, key, value }) as string | null) ?? rawQuery
}

export function stripRepoQualifiers(rawQuery: string): string {
  return (op('stripRepoQualifiers', rawQuery) as string | null) ?? rawQuery
}
