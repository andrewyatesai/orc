import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo } from '../shared/types'
import { isGitRepo } from './git/repo'

type RepoKindStore = {
  getRepos(): Repo[]
  getRepo?(id: string): Repo | undefined
  updateRepo(
    id: string,
    updates: Partial<Pick<Repo, 'kind' | 'externalWorktreeVisibility'>>
  ): Repo | null
}

type PromotionOptions = {
  onChanged?: () => void
}

/** What the spawn-free `.git` triage can settle without asking git. */
type GitMarkerVerdict = 'no-git-marker' | 'needs-git-probe'

function getCurrentRepo(store: RepoKindStore, id: string): Repo | undefined {
  return store.getRepo?.(id) ?? store.getRepos().find((repo) => repo.id === id)
}


/**
 * Spawn-free `.git` triage — the same cheap existence guard promotion always
 * used, and nothing more. Whether a marker IS a repository stays git's call
 * (`isGitRepo`): git's own `is_git_directory()` checks more than any stat-based
 * rule can (HEAD's *content*, objects/refs resolution, GIT_OBJECT_DIRECTORY),
 * so a local rule that promotes on its own would promote rows git rejects and
 * flip a user's project to git-kind wrongly. Everything with a marker therefore
 * goes to the deferred probe; the pre-mount snapshot path never spawns git.
 */
function classifyGitMarker(repoPath: string): GitMarkerVerdict {
  try {
    statSync(join(repoPath, '.git'))
  } catch {
    // Missing or unreadable: same skip the old existsSync guard produced.
    return 'no-git-marker'
  }
  return 'needs-git-probe'
}

function isLocalFolderRepo(repo: Repo): boolean {
  return repo.kind === 'folder' && !repo.connectionId
}

/** Re-reads the live row so a concurrent list/probe cannot promote it twice. */
function applyPromotion(store: RepoKindStore, snapshot: Repo): boolean {
  const current = getCurrentRepo(store, snapshot.id)
  if (!current || current.kind !== 'folder' || current.path !== snapshot.path) {
    return false
  }
  return !!store.updateRepo(snapshot.id, {
    kind: 'git',
    // Why: git-kind repos added directly default to hiding external worktrees;
    // promotion mirrors that so both paths present the same discovery UX.
    ...(current.externalWorktreeVisibility === undefined
      ? { externalWorktreeVisibility: 'hide' as const }
      : {})
  })
}

function runMarkerPass(store: RepoKindStore): Repo[] {
  const needGitProbe: Repo[] = []
  for (const repo of store.getRepos()) {
    if (!isLocalFolderRepo(repo)) {
      continue
    }
    try {
      if (classifyGitMarker(repo.path) === 'needs-git-probe') {
        // Why: snapshot the row — the probe may run later against a mutated store.
        needGitProbe.push({ ...repo })
      }
    } catch (error) {
      console.warn('[repo-kind] Failed to scan folder repo for a git marker:', error)
    }
  }
  return needGitProbe
}

function runGitProbePass(store: RepoKindStore, candidates: readonly Repo[]): boolean {
  let changed = false
  for (const repo of candidates) {
    try {
      const current = getCurrentRepo(store, repo.id)
      if (!current || !isLocalFolderRepo(current) || !isGitRepo(repo.path)) {
        continue
      }
      changed = applyPromotion(store, repo) || changed
    } catch (error) {
      console.warn('[repo-kind] Failed to probe folder repo for git promotion:', error)
    }
  }
  return changed
}

/**
 * Spawn-free half of the folder→git promotion (issue #8125): triage which
 * folder repos even have a `.git` marker and hand them back as probe
 * candidates. Promotes nothing on its own — only git decides. Safe on a
 * latency-critical path: one stat per folder repo.
 */
export function collectFolderReposNeedingGitProbe(store: RepoKindStore): Repo[] {
  return runMarkerPass(store)
}

/**
 * Spawn-capable half: `isGitRepo` runs git synchronously, so this belongs off
 * any path a renderer is waiting on. Idempotent — every candidate is re-checked
 * against the live row, so a repos:list that promoted it first wins and this
 * pass reports no change.
 */
export function promoteFolderReposFromGitProbe(
  store: RepoKindStore,
  candidates: readonly Repo[],
  options: PromotionOptions = {}
): void {
  if (runGitProbePass(store, candidates)) {
    options.onChanged?.()
  }
}

/**
 * Promote folder-kind repos to git-kind once a git repository appears at their
 * path (issue #8125: `git init` after add left the Git tab permanently hidden
 * because kind was fixed at add time). Local-path repos only — SSH-connected
 * repos cannot be probed with local filesystem checks and keep their kind.
 *
 * Triage + probe inline, for callers that can afford the git spawn (repos:list,
 * the runtime RPC). The startup snapshot instead triages inline and defers the
 * probe, so nothing latency-critical waits on git.
 */
export function promoteFolderReposWithGitRepositories(
  store: RepoKindStore,
  options: PromotionOptions = {}
): void {
  if (runGitProbePass(store, runMarkerPass(store))) {
    options.onChanged?.()
  }
}
