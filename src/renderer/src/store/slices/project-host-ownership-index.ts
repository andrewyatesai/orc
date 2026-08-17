import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'

// Why: mergeFetchedProjectCompatibilityForHost's host-id resolvers rescanned every setup and every
// repo once per project, so a catalog refresh was O(projects x (setups + repos)). Precompute the
// per-project slices once and hand each resolver only its own project's inputs — no ownership logic
// is reimplemented, the same resolvers run on pre-sliced arrays.

export function indexProjectHostSetupsByProjectId(
  setups: readonly ProjectHostSetup[]
): Map<string, ProjectHostSetup[]> {
  const setupsByProjectId = new Map<string, ProjectHostSetup[]>()
  for (const setup of setups) {
    const existing = setupsByProjectId.get(setup.projectId)
    if (existing) {
      existing.push(setup)
    } else {
      setupsByProjectId.set(setup.projectId, [setup])
    }
  }
  return setupsByProjectId
}

export function getProjectSourceRepos(
  project: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>
): Repo[] {
  const sourceRepos: Repo[] = []
  for (const repoId of project.sourceRepoIds) {
    for (const repo of reposById.get(repoId) ?? []) {
      sourceRepos.push(repo)
    }
  }
  return sourceRepos
}

// Why: feeding each host-id resolver only its project's setups and source repos keeps a refresh
// linear; the result is memoized per project object so repeat lookups within one merge are free.
export function createProjectHostIdIndex(
  setups: readonly ProjectHostSetup[],
  reposById: ReadonlyMap<string, readonly Repo[]>,
  resolveHostIds: (
    project: Project,
    setups: readonly ProjectHostSetup[],
    repos: readonly Repo[]
  ) => Set<string>
): (project: Project) => ReadonlySet<string> {
  const noSetups: readonly ProjectHostSetup[] = []
  const hostIdsByProject = new Map<Project, ReadonlySet<string>>()
  let setupsByProjectId: Map<string, ProjectHostSetup[]> | null = null
  return (project) => {
    const cached = hostIdsByProject.get(project)
    if (cached) {
      return cached
    }
    setupsByProjectId ??= indexProjectHostSetupsByProjectId(setups)
    const hostIds = resolveHostIds(
      project,
      setupsByProjectId.get(project.id) ?? noSetups,
      getProjectSourceRepos(project, reposById)
    )
    hostIdsByProject.set(project, hostIds)
    return hostIds
  }
}

// Why: mergePreviousProjectMetadata otherwise rebuilt the whole catalog's repo key-set per project;
// a view holding only this project pair's repos keeps that scan per-project.
export function restrictReposToProjectPair(
  previous: Project,
  current: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>
): Map<string, readonly Repo[]> {
  const restricted = new Map<string, readonly Repo[]>()
  for (const project of [previous, current]) {
    for (const repoId of project.sourceRepoIds) {
      const matches = reposById.get(repoId)
      if (matches) {
        restricted.set(repoId, matches)
      }
    }
  }
  return restricted
}
