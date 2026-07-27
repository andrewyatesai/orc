/**
 * Streamed `git status --porcelain=v2 --branch` for the relay host: stdout is
 * scanned as it arrives and git is stopped the moment the changed-entry count
 * crosses `limit`, so a repo with an enormous un-ignored folder never buffers a
 * status listing big enough to crash the process (#9477). The relay twin of
 * src/main/git/git-status-stream.ts.
 *
 * The scan is the Rust orca-git parser via wasm — the same core the main process
 * drives through the napi streaming parser — so relay and main stay record-for-
 * record identical. The wasm export is a one-shot over a byte range, so chunks are
 * cut at the last newline and scanned segment by segment: porcelain records are
 * independent, so a line-aligned segment scans identically to the whole output.
 */
import type { GitStatusEntry } from '../shared/types'
import { scanStatusPorcelain } from './git-wasm'
import type { RelayGitStreamExec, RelayGitStreamOptions } from './git-stdout-stream'

export type StreamedRelayGitStatus = {
  /** Changed-file entries, already capped to `limit` when the cap was hit. */
  entries: GitStatusEntry[]
  head?: string
  branch?: string
  upstreamName?: string
  upstreamAheadBehind?: { ahead: number; behind: number }
  ignoredPaths: string[]
  /** Raw `u ` records for the caller to resolve via per-file worktree lookups. */
  unmergedLines: string[]
  /** Total changed entries observed (`limit + 1` once the cap stopped the scan). */
  statusLength: number
  didHitLimit: boolean
}

/** Accumulates line-aligned wasm scans across streamed chunks. */
class StatusPorcelainStream {
  /** Incomplete trailing record, carried until its newline arrives. */
  private carry = ''
  private count = 0
  private stopped = false
  readonly entries: GitStatusEntry[] = []
  readonly ignoredPaths: string[] = []
  readonly unmergedLines: string[] = []
  head?: string
  branch?: string
  upstreamName?: string
  upstreamAheadBehind?: { ahead: number; behind: number }

  get statusLength(): number {
    return this.count
  }

  get didHitLimit(): boolean {
    return this.stopped
  }

  /** Feed one decoded chunk; true once the cap is crossed (stop git). */
  update(chunk: string, limit: number): boolean {
    if (this.stopped) {
      return true
    }
    const text = this.carry + chunk
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) {
      this.carry = text
      return false
    }
    this.carry = text.slice(lastNewline + 1)
    return this.scan(text.slice(0, lastNewline + 1), limit)
  }

  /** Flush a final record with no trailing newline (git exited). */
  finish(limit: number): void {
    if (this.stopped || this.carry.length === 0) {
      return
    }
    const tail = this.carry
    this.carry = ''
    this.scan(tail, limit)
  }

  private scan(segment: string, limit: number): boolean {
    // Why: hand the scan only the budget still unspent, so one huge chunk stops
    // inside Rust instead of materializing every entry. 0 means "no cap" to the
    // core, so a fully spent budget asks for 1 and the clamp below restores the
    // stop-at-the-cap counts.
    const budget = limit === 0 ? 0 : Math.max(limit - this.count, 1)
    const scanned = scanStatusPorcelain(segment, budget)
    // Why: loops, not spread-push — an uncapped scan (limit 0) can return more
    // rows than a call's argument limit allows.
    for (const entry of scanned.entries) {
      this.entries.push(entry)
    }
    for (const ignoredPath of scanned.ignoredPaths) {
      this.ignoredPaths.push(ignoredPath)
    }
    for (const unmergedLine of scanned.unmergedLines) {
      this.unmergedLines.push(unmergedLine)
    }
    // Branch headers appear once; keep the first segment's values afterwards.
    if (scanned.head !== undefined) {
      this.head = scanned.head
    }
    if (scanned.branch !== undefined) {
      this.branch = scanned.branch
    }
    if (scanned.upstreamName !== undefined) {
      this.upstreamName = scanned.upstreamName
    }
    if (scanned.ahead !== undefined || scanned.behind !== undefined) {
      this.upstreamAheadBehind = { ahead: scanned.ahead ?? 0, behind: scanned.behind ?? 0 }
    }
    this.count += scanned.statusLength
    if (limit !== 0 && this.count > limit) {
      // Why: exactly one entry past the cap is "observed" and entries never exceed
      // it, however the chunk boundaries happened to fall.
      this.count = limit + 1
      this.entries.length = Math.min(this.entries.length, limit)
      this.stopped = true
      return true
    }
    return false
  }
}

/** Stream + scan `git status`, stopping git once the entry count crosses `limit`
 *  (0 = no cap). Rejects like the underlying runner (abort, spawn failure, or a
 *  non-zero git exit) — the caller decides what a failed scan means. */
export async function streamRelayGitStatus(
  streamGit: RelayGitStreamExec,
  args: string[],
  cwd: string,
  options: Omit<RelayGitStreamOptions, 'onStdout'>,
  limit: number
): Promise<StreamedRelayGitStatus> {
  const stream = new StatusPorcelainStream()
  const { stoppedEarly } = await streamGit(args, cwd, {
    ...options,
    onStdout: (chunk) => stream.update(chunk, limit)
  })
  if (!stoppedEarly) {
    stream.finish(limit)
  }
  return {
    entries: stream.entries,
    head: stream.head,
    branch: stream.branch,
    upstreamName: stream.upstreamName,
    upstreamAheadBehind: stream.upstreamAheadBehind,
    ignoredPaths: stream.ignoredPaths,
    unmergedLines: stream.unmergedLines,
    statusLength: stream.statusLength,
    // Why: a stream stopped early with an intact carry is a truncated read either
    // way — report the cap so the "too many changes" state is never missed.
    didHitLimit: stoppedEarly || stream.didHitLimit
  }
}
