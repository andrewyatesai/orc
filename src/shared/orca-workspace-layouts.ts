// `buildKnownOrcaWorkspaceLayouts` on the Rust `orca_core::worktree_ownership`
// core. It sits on `orca-dispatch-seam` rather than in one tree's binding
// directory because both trees build layouts: main + cli drive the worktree
// listing (`ipc/worktrees.ts`, `runtime/orca-runtime.ts`, napi) and the shared
// `worktree-ownership-policy.ts` classifier consumes the result on every
// surface, the renderer included (wasm at ready).
//
// Split out of `worktree-ownership-policy.ts` because it is a separate concern —
// "where could Orca have put a workspace" versus "who owns this worktree" — and
// keeping them in one file put the module over `max-lines`.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED. The returned layouts are the
// `knownOrcaLayouts` every ownership decision is made against, so a degraded
// answer is a wrong `ownership` on every row of the sidebar: an empty list makes
// `canClassifyAsExternal` answer false and turns every external worktree into
// `unknown-legacy`, which a legacy repo then SHOWS. `[]` is also the twin's real
// answer for a repo with no workspace dir, so it cannot double as a signal, and
// there is no spare state in `OrcaWorkspaceLayout[]` for one. The fallback
// therefore re-runs the deleted twin's body, which makes pre-ready equal ready
// for every input.
//
// DECLARED RESIDUAL, reachable only through hand-edited persisted settings: the
// twin spread each `workspaceDirHistory` entry into its output (`{...layout,
// path}`), so an UNDECLARED extra key on a persisted entry rode through; the
// core emits the two fields `OrcaWorkspaceLayout` declares. Nothing reads a
// third field — the classifier reads `path`/`nestWorkspaces`, the layout list is
// recomputed per listing and never persisted (`orcaCreationWorkspaceLayout` is
// stamped by `getWorktreeCreationLayout`, not from here) — so the fallback keeps
// the twin's spread and the two paths differ only in that dead key.
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from './cross-platform-path-resolution'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import { parseWslUncPath } from './wsl-unc-paths'
import type { GlobalSettings, OrcaWorkspaceLayout, Repo } from './types'

export type WorkspaceLayoutSettings = Pick<
  GlobalSettings,
  'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'
>

export type WorkspaceLayoutRepo = Pick<Repo, 'path' | 'connectionId' | 'worktreeBasePath'>

/**
 * The one MEASURED divergence, folded back rather than shipped.
 *
 * The WSL mirror layout is derived from `parseWslUncPath`, and that shim already
 * corrects a known core difference: JS `.` excludes line terminators, so the
 * twin's `WSL_UNC_PATH_PATTERN` REFUSED a UNC tail containing `\n \r U+2028
 * U+2029` while `orca_core::wsl_paths` splits on '/' and accepts it. Crossing
 * `buildKnownOrcaWorkspaceLayouts` reaches the core's own parse and skips that
 * correction, which invents a `//wsl.localhost/<distro>/home/<user>/orca/workspaces`
 * root the twin never had — and a fabricated known-Orca root reclassifies real
 * worktrees. A repo path lifted off a terminal stream keeps a stray CR and a
 * Linux directory name may legally contain a newline, so this is reachable.
 *
 * The test is on the whole repo path, not on the parsed tail: it is one regex on
 * one string, and a non-WSL path carrying a line terminator simply answers from
 * the fallback, which is the twin's answer for it anyway.
 */
const CORE_ONLY_WSL_TAIL_CHARS = /[\n\r\u2028\u2029]/

/**
 * Every workspace root Orca could have created a worktree under for this repo:
 * the repo's own base path, the global workspace dir, its history, and the WSL
 * mirror of the repo's own home. Each carries the nest mode that was active for
 * it, which is what lets a flat-era root stay weak evidence after the setting
 * flipped to nested.
 */
export function buildKnownOrcaWorkspaceLayouts(
  settings: WorkspaceLayoutSettings,
  repo?: WorkspaceLayoutRepo
): OrcaWorkspaceLayout[] {
  if (repo && CORE_ONLY_WSL_TAIL_CHARS.test(repo.path)) {
    return legacyBuildKnownOrcaWorkspaceLayouts(settings, repo)
  }
  // Only the three settings fields and the three repo fields the core reads
  // cross — never the caller's `Repo`, whose display name, badge colour and
  // remote identity are user text that could refuse to encode and turn a real
  // answer into a fallback for a field the logic never looked at.
  const answer = dispatchLayouts({
    settings: {
      workspaceDir: settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces,
      workspaceDirHistory: settings.workspaceDirHistory
    },
    repo: repo && {
      path: repo.path,
      connectionId: repo.connectionId,
      worktreeBasePath: repo.worktreeBasePath
    }
  })
  return answer === null
    ? legacyBuildKnownOrcaWorkspaceLayouts(settings, repo)
    : (answer as OrcaWorkspaceLayout[])
}

/** `null` = the seam is unbound, or the payload cannot cross — answer locally.
 *  Unambiguous: the arm always answers an array, never null.
 *  Why the catch: a workspace dir is user-typed and a repo path comes off the
 *  filesystem, so both can carry an unpaired UTF-16 surrogate the codec refuses
 *  to encode. The twin answered those without crossing anything, so the fallback
 *  does too; a DispatchCoreError still propagates. */
function dispatchLayouts(input: unknown): unknown {
  try {
    return tryOrcaDispatch('worktree-ownership', 'buildKnownOrcaWorkspaceLayouts', input, {
      root: 'buildKnownOrcaWorkspaceLayouts',
      undefinedProperties: 'omit'
    })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** The deleted twin's body, verbatim. */
function legacyBuildKnownOrcaWorkspaceLayouts(
  settings: WorkspaceLayoutSettings,
  repo?: WorkspaceLayoutRepo
): OrcaWorkspaceLayout[] {
  const layouts: OrcaWorkspaceLayout[] = []
  const repoBasePath = getRepoWorktreeBasePath(repo)
  if (repo && repoBasePath) {
    layouts.push({
      path: resolveWorkspaceLayoutPath(repo.path, repoBasePath),
      nestWorkspaces: settings.nestWorkspaces
    })
  }
  if (settings.workspaceDir && shouldIncludeWorkspaceLayout(repo, settings.workspaceDir)) {
    layouts.push({
      path: repo
        ? resolveWorkspaceLayoutPath(repo.path, settings.workspaceDir)
        : settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces
    })
    appendWorkspaceLayouts(
      layouts,
      (settings.workspaceDirHistory ?? [])
        .filter((layout) => shouldIncludeWorkspaceLayout(repo, layout.path))
        .map((layout) => ({
          ...layout,
          path: repo ? resolveWorkspaceLayoutPath(repo.path, layout.path) : layout.path
        }))
    )
  }

  const wslLayouts = repo ? buildWslWorkspaceLayouts(repo.path, settings) : []
  appendWorkspaceLayouts(layouts, wslLayouts)

  const seen = new Set<string>()
  return layouts.filter((layout) => {
    const key = `${normalizeRuntimePathForComparison(layout.path)}:${layout.nestWorkspaces}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return Boolean(layout.path)
  })
}

function appendWorkspaceLayouts(
  target: OrcaWorkspaceLayout[],
  source: readonly OrcaWorkspaceLayout[]
): void {
  // Why: workspace history is persisted user data and can grow large enough
  // for `push(...source)` to exceed the JavaScript call argument limit.
  for (const layout of source) {
    target.push(layout)
  }
}

function getRepoWorktreeBasePath(repo: WorkspaceLayoutRepo | undefined): string | undefined {
  const trimmed = repo?.worktreeBasePath?.trim()
  return trimmed || undefined
}

function resolveWorkspaceLayoutPath(repoPath: string, layoutPath: string): string {
  return isRuntimePathAbsoluteForRepo(repoPath, layoutPath)
    ? normalizeRuntimePathSeparators(layoutPath)
    : resolveRuntimePath(repoPath, layoutPath)
}

function isRuntimePathAbsoluteForRepo(repoPath: string, layoutPath: string): boolean {
  const pathFlavor =
    isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(layoutPath)
      ? 'windows'
      : 'posix'
  return isRuntimePathAbsolute(layoutPath, pathFlavor)
}

function shouldIncludeWorkspaceLayout(
  repo: Pick<Repo, 'path' | 'connectionId'> | undefined,
  layoutPath: string
): boolean {
  return !repo?.connectionId || !isRuntimePathAbsoluteForRepo(repo.path, layoutPath)
}

function buildWslWorkspaceLayouts(
  repoPath: string,
  settings: Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDirHistory'>
): OrcaWorkspaceLayout[] {
  const parsed = parseWslUncPath(repoPath)
  if (!parsed) {
    return []
  }
  const homeMatch = parsed.linuxPath.match(/^\/home\/[^/]+(?:\/|$)/)
  const linuxHome = homeMatch?.[0].replace(/\/$/, '')
  if (!linuxHome) {
    return []
  }
  const root = `//wsl.localhost/${parsed.distro}${linuxHome}/orca/workspaces`
  const historicalModes = (settings.workspaceDirHistory ?? []).map(
    (layout) => layout.nestWorkspaces
  )
  const modes = [settings.nestWorkspaces, ...historicalModes]
  return [...new Set(modes)].map((nestWorkspaces) => ({ path: root, nestWorkspaces }))
}
