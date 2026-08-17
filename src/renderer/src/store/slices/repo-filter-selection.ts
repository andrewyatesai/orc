// Why: catalog refreshes re-filter this on every fetch; several identity-sensitive subscribers
// (App.tsx at the root among them) re-render on a new array even when nothing was pruned. Returning
// the same array when every id is still valid keeps those selectors quiet — `.every` short-circuits
// so the common case allocates nothing. Lives in its own module rather than ui.ts: repos.ts does not
// import ui.ts and this codebase has a documented circular-slice-import hazard.
export function retainValidFilterRepoIds(
  filterRepoIds: string[],
  validRepoIds: ReadonlySet<string>
): string[] {
  return filterRepoIds.every((repoId) => validRepoIds.has(repoId))
    ? filterRepoIds
    : filterRepoIds.filter((repoId) => validRepoIds.has(repoId))
}
