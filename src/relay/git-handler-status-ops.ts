/**
 * Status and conflict-detection operations extracted from git-handler.ts.
 * Why: split to satisfy oxlint max-lines (300); pure data ops on git state, no class coupling.
 */
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseUnmergedEntry } from './git-handler-utils'
import type { GitExec } from './git-handler-ops'
import type { RelayGitStreamExec } from './git-stdout-stream'
import type { GitUpstreamStatus } from '../shared/types'
import { streamRelayGitStatus } from './git-status-stream'
import { splitRemoteBranchName } from '../shared/git-effective-upstream'
import { readOrProbeNoEffectiveUpstreamStatus } from './git-status-upstream-negative-cache'
import { applyLineStats, type GitLineStats } from '../shared/git-uncommitted-line-stats'
import { parseNumstat } from './git-wasm'
import { collectUntrackedAdditionsViaGitNumstat } from './git-numstat-untracked-counter'
import { capGitStatusEntries, resolveGitStatusLimit } from '../shared/git-status-limit'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../shared/git-status-line-stats-cache'

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')
  try {
    const contents = await readFile(dotGitPath, 'utf-8')
    const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // .git is a directory, not a file
  }
  return dotGitPath
}

export async function detectConflictOperation(worktreePath: string): Promise<string> {
  const gitDir = await resolveGitDir(worktreePath)
  try {
    if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      return 'merge'
    }
    if (
      existsSync(path.join(gitDir, 'rebase-merge')) ||
      existsSync(path.join(gitDir, 'rebase-apply'))
    ) {
      return 'rebase'
    }
    if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
      return 'cherry-pick'
    }
  } catch {
    // fs error — treat as no conflict operation
  }
  return 'unknown'
}

export async function getStatusOp(
  git: GitExec,
  streamGit: RelayGitStreamExec,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal } = {}
): Promise<{
  entries: Record<string, unknown>[]
  conflictOperation: string
  head?: string
  branch?: string
  upstreamStatus?: GitUpstreamStatus
  ignoredPaths?: string[]
  didHitLimit?: boolean
  statusLength?: number
}> {
  const worktreePath = params.worktreePath as string
  const lineStatsCacheKey = `relay\0${worktreePath}`
  const lineStatsWriteToken = beginGitStatusLineStatsCacheWrite(lineStatsCacheKey)
  const includeIgnored = params.includeIgnored === true
  // Why: reject NaN/negative limits — NaN would silently disable capping, negatives would over-truncate.
  const limit = resolveGitStatusLimit(params.limit)
  const conflictOperation = await detectConflictOperation(worktreePath)
  const entries: Record<string, unknown>[] = []
  let head: string | undefined
  let branch: string | undefined
  let upstreamStatus: GitUpstreamStatus | undefined
  let ignoredPaths: string[] = []
  let didHitLimit = false
  let statusLength = 0

  try {
    // Why: core.quotePath=false keeps non-ASCII filenames as raw UTF-8 instead of octal escapes that render as gibberish.
    const statusArgs = [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ]
    if (includeIgnored) {
      statusArgs.push('--ignored=matching')
    }
    // Why: stream + scan incrementally and stop git the moment the entry count
    // crosses `limit`, so an enormous un-ignored folder never buffers a status
    // listing big enough to crash the process. The scan is the Rust orca-git
    // parser via wasm — the same core the main process runs through napi.
    const streamed = await streamRelayGitStatus(
      streamGit,
      statusArgs,
      worktreePath,
      {
        // Why: status polling is read-like; avoid racing terminal Git on .git/worktrees/*/index.lock.
        disableOptionalLocks: true,
        signal: options.signal
      },
      limit
    )
    head = streamed.head
    branch = streamed.branch
    ignoredPaths = streamed.ignoredPaths
    statusLength = streamed.statusLength
    didHitLimit = streamed.didHitLimit
    const { upstreamName, upstreamAheadBehind } = streamed
    upstreamStatus = upstreamName
      ? {
          hasUpstream: true,
          upstreamName,
          ahead: upstreamAheadBehind?.ahead ?? 0,
          behind: upstreamAheadBehind?.behind ?? 0
        }
      : { hasUpstream: false, ahead: 0, behind: 0 }

    if (!didHitLimit) {
      if (shouldProbeEffectiveUpstreamStatus(branch, upstreamStatus?.upstreamName)) {
        const branchName = getShortBranchName(branch)
        if (branchName) {
          try {
            // Why: this probe coalesces across concurrent status reads, so one request's abort must not reject the shared in-flight promise.
            upstreamStatus = await readOrProbeNoEffectiveUpstreamStatus(
              { worktreePath, branchName, upstreamName: upstreamStatus?.upstreamName },
              (args) => git(args, worktreePath),
              {
                bypassCache: params.bypassEffectiveUpstreamNegativeCache === true
              }
            )
          } catch {
            // Why: keep returning working-tree entries even if the upstream probe hits a transient SSH/git ref error.
          }
        }
      }
    }

    // Why: unmerged (`u`) records need per-file worktree lookups (conflicts are
    // rare). The scan collects them separately and never counts them toward the
    // entry cap, so resolve them even when the cap was hit — otherwise a capped
    // huge change set silently drops early conflict rows behind later ordinary
    // ones (#9477).
    const unmergedEntries: Record<string, unknown>[] = []
    for (const line of streamed.unmergedLines) {
      const entry = parseUnmergedEntry(worktreePath, line)
      if (entry) {
        unmergedEntries.push(entry)
      }
    }
    // Why: conflicts always appear before the cap boundary, so surface them ahead
    // of the capped ordinary rows and re-cap the combined list to `limit` (#9477).
    // Below the cap, keep the original entries-then-conflicts order.
    const scannedEntries = streamed.entries as Record<string, unknown>[]
    const combined = didHitLimit
      ? capGitStatusEntries([...unmergedEntries, ...scannedEntries], limit).entries
      : [...scannedEntries, ...unmergedEntries]
    for (const entry of combined) {
      entries.push(entry)
    }
  } catch (error) {
    // Why: an aborted scan must reject, not resolve as a completed (empty) status result.
    if (options.signal?.aborted) {
      throw error
    }
    // not a git repo or git not available
  }

  // Why: skip line-stats when the limit was hit — numstat over a huge change set would reintroduce the cost the limit avoids.
  if (!didHitLimit) {
    await reuseOrRecomputeGitStatusLineStats({
      cacheKey: lineStatsCacheKey,
      head,
      entries,
      writeToken: lineStatsWriteToken,
      reuse: params.reuseLineStats === true,
      isAborted: () => options.signal?.aborted === true,
      recompute: () => attachLineStats(git, worktreePath, entries, options.signal)
    })
  } else {
    clearGitStatusLineStatsCacheKey(lineStatsCacheKey, lineStatsWriteToken)
  }

  // Why: a late abort (during unmerged/upstream/line-stats work) must still reject, not resolve as completed.
  if (options.signal?.aborted) {
    const error = new Error('The operation was aborted.')
    error.name = 'AbortError'
    throw error
  }

  return {
    entries,
    conflictOperation,
    head,
    branch,
    upstreamStatus,
    ...(includeIgnored ? { ignoredPaths } : {}),
    ...(didHitLimit ? { didHitLimit: true, statusLength } : {})
  }
}

// Why: the status entries already name every changed path, so scope the numstat
// scan to them instead of rescanning the whole worktree on every status poll
// (issue #7983: a large monorepo over SSH paid for a full-tree diff each SCM
// refresh). A rename shows up as old→new, and `-M` needs BOTH sides in the
// pathspec or it mis-reports the new path as a plain add — so include oldPath for
// renamed/copied entries. Returns null (= full scan) if a rename is missing its
// old side, so a rename's counts are never silently wrong.
export function collectNumstatPathspecs(
  entries: Record<string, unknown>[],
  area: 'staged' | 'unstaged'
): string[] | null {
  const paths = new Set<string>()
  for (const entry of entries) {
    if (entry.area !== area) {
      continue
    }
    const oldPath = entry.oldPath as string | undefined
    if (entry.status === 'renamed' && !oldPath) {
      return null
    }
    paths.add(entry.path as string)
    if (oldPath) {
      paths.add(oldPath)
    }
  }
  return [...paths]
}

// Why: source-control selections are concrete paths, not user-authored Git globs;
// :(literal) matches them exactly (mirrors the git-handler relay pathspec helper).
function literalPathspec(filePath: string): string {
  return `:(literal)${filePath}`
}

async function runNumstat(
  git: GitExec,
  worktreePath: string,
  cached: boolean,
  // null → scan the whole worktree (rename-fallback); otherwise the exact set of
  // changed paths (both rename sides) that scopes the scan.
  pathspecs: string[] | null,
  signal?: AbortSignal
): Promise<Map<string, GitLineStats> | null> {
  // No changed paths of this kind: nothing to scan.
  if (pathspecs && pathspecs.length === 0) {
    return new Map()
  }
  try {
    const { stdout } = await git(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        ...(cached ? ['--cached'] : []),
        '--numstat',
        '-M',
        // Scope the scan to the known changed paths (both rename sides) so a large
        // monorepo's status poll doesn't rescan the whole worktree; :(literal)
        // keeps glob/rename-marker chars exact. null → full scan (rename fallback).
        ...(pathspecs ? ['--', ...pathspecs.map(literalPathspec)] : [])
      ],
      worktreePath,
      { disableOptionalLocks: true, signal }
    )
    return parseNumstat(stdout)
  } catch (error) {
    // Why: an aborted pass must reject so a cancelled scan is never treated as completed.
    if (signal?.aborted) {
      throw error
    }
    // Why: null (vs an empty map) tells the caller the pass is incomplete and must not be cached.
    return null
  }
}

/** Returns false when a numstat pass failed, so callers skip caching it. */
async function attachLineStats(
  git: GitExec,
  worktreePath: string,
  entries: Record<string, unknown>[],
  signal?: AbortSignal
): Promise<boolean> {
  if (entries.length === 0) {
    return true
  }
  const hasStaged = entries.some((entry) => entry.area === 'staged')
  const hasUnstaged = entries.some((entry) => entry.area === 'unstaged')
  const untrackedPaths = entries
    .filter((entry) => entry.area === 'untracked')
    .map((entry) => entry.path as string)
  const emptyStats = new Map<string, GitLineStats>()
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged
      ? runNumstat(git, worktreePath, true, collectNumstatPathspecs(entries, 'staged'), signal)
      : Promise.resolve(emptyStats),
    hasUnstaged
      ? runNumstat(git, worktreePath, false, collectNumstatPathspecs(entries, 'unstaged'), signal)
      : Promise.resolve(emptyStats),
    // No native addon ships to the relay host, so untracked counts come from git
    // itself (diff --no-index vs /dev/null) instead of the Rust counter.
    collectUntrackedAdditionsViaGitNumstat(git, worktreePath, untrackedPaths, signal)
  ])
  for (const entry of entries) {
    const filePath = entry.path as string
    applyLineStats(
      entry as { added?: number; removed?: number },
      entry.area === 'staged'
        ? (stagedStats ?? emptyStats).get(filePath)
        : entry.area === 'unstaged'
          ? (unstagedStats ?? emptyStats).get(filePath)
          : untrackedStats.get(filePath)
    )
  }
  return stagedStats !== null && unstagedStats !== null
}

function getShortBranchName(branch: string | undefined): string | null {
  const prefix = 'refs/heads/'
  return branch?.startsWith(prefix) ? branch.slice(prefix.length) : null
}

function shouldProbeEffectiveUpstreamStatus(
  branch: string | undefined,
  upstreamName: string | undefined
): boolean {
  const branchName = getShortBranchName(branch)
  if (!branchName) {
    return false
  }
  if (!upstreamName) {
    return true
  }
  const parsed = splitRemoteBranchName(upstreamName)
  return parsed?.remoteName === 'origin' && parsed.branchName !== branchName
}
