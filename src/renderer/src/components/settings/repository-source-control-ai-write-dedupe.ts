import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'

/**
 * "Would this write change anything?" for the repository Source Control AI pane.
 *
 * Both call sites used to be a raw `JSON.stringify(next) === JSON.stringify(base)`,
 * which is key-ORDER sensitive, and both operands are
 * `normalizeRepoSourceControlAiOverrides` output. That function is now the Rust
 * core through the shared dispatch seam, and the two sides of the seam emit
 * DIFFERENT key order — measured, not assumed: for
 * `{enabled, customAgentCommand, instructionsByOperation, actionOverrides:
 * {fixChecks}, prCreationDefaults}` the twin body emits `actionOverrides` as
 * `{fixChecks, pullRequest}` and the core as `{pullRequest, fixChecks}`.
 *
 * `base` is whatever the pane last persisted and `next` is re-normalized by every
 * `withRepoAi*` transform, so a base normalized before the renderer's wasm was
 * ready and an edit normalized after it are compared across that boundary. Byte
 * comparison then reports "changed" for an unchanged value and the dedupe stops
 * deduping — a redundant repo write on every blur until the next real save.
 *
 * Key order in a persisted settings blob is not semantic, so compare by VALUE.
 * This can only skip MORE writes than the byte comparison did, never fewer.
 */
export function sameRepoSourceControlAiOverrides(
  next: RepoSourceControlAiOverrides,
  base: RepoSourceControlAiOverrides
): boolean {
  return canonicalJson(next) === canonicalJson(base)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(withSortedKeys(value))
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, withSortedKeys(record[key])])
  )
}
