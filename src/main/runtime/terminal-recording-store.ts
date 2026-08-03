/**
 * Where `terminal.record` casts live on disk, and how they stop living there.
 *
 * A recording is a file, so three questions need answers a caller can act on:
 * where it is, how to get it, and when it disappears. This module owns all
 * three. Files land in a per-user directory under the OS temp root (override
 * with `ORCA_TERMINAL_RECORDING_DIR`), and retention is bounded twice — by age
 * and by count — because a driving AI recording every run would otherwise fill
 * a disk that nobody is watching.
 *
 * The path is on the host that RUNS the runtime. A CLI talking to a remote
 * runtime gets a path it cannot open, which is why the list result says so
 * rather than letting the caller assume it is local.
 *
 * Writes are async and tracked per recording id, so the ingest path never
 * blocks on a multi-megabyte write and `stop` can still await the exact file it
 * asked for.
 */
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalCastCapture } from './terminal-cast-recorder'

/** A day is long enough to notice a recording and convert it, short enough that
 *  an unattended agent loop cannot accumulate a week of casts. */
export const TERMINAL_RECORDING_RETENTION_MS = 24 * 60 * 60 * 1000
export const TERMINAL_RECORDING_FILE_LIMIT = 32
const CAST_SUFFIX = '.cast'

export type TerminalRecordingFile = {
  path: string | null
  fileBytes: number | null
  /** Non-null only when the cast was captured and the write failed. */
  error: string | null
}

function sanitizeStem(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)
}

export function terminalRecordingFileName(capture: TerminalCastCapture): string {
  return `${capture.id}--${sanitizeStem(capture.handle)}${CAST_SUFFIX}`
}

/** Creates the directory 0700 and refuses a path that is not a directory this
 *  user owns — the same guard the computer-use screenshot temp dir applies. */
export function terminalRecordingDir(): string {
  const dir = process.env.ORCA_TERMINAL_RECORDING_DIR || join(tmpdir(), 'orca-terminal-recordings')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = lstatSync(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe terminal recording directory: ${dir}`)
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`Terminal recording directory is not owned by the current user: ${dir}`)
  }
  chmodSync(dir, 0o700)
  return dir
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TerminalRecordingStore {
  private readonly writes = new Map<string, Promise<TerminalRecordingFile>>()
  private directoryError: string | null = null

  constructor(private readonly resolveDir: () => string = terminalRecordingDir) {}

  /** Null when the directory could not be opened; `lastDirectoryError` says why. */
  directory(): string | null {
    try {
      const dir = this.resolveDir()
      this.directoryError = null
      return dir
    } catch (error) {
      this.directoryError = messageOf(error)
      return null
    }
  }

  get lastDirectoryError(): string | null {
    return this.directoryError
  }

  /** Starts the write and returns immediately. Never throws: a failed write is
   *  reported on the recording, so the capture is not lost silently. */
  write(capture: TerminalCastCapture, cast: string): void {
    this.writes.set(capture.id, this.performWrite(capture, cast))
  }

  private async performWrite(
    capture: TerminalCastCapture,
    cast: string
  ): Promise<TerminalRecordingFile> {
    const dir = this.directory()
    if (!dir) {
      return { path: null, fileBytes: null, error: this.directoryError ?? 'store-unavailable' }
    }
    const path = join(dir, terminalRecordingFileName(capture))
    try {
      await writeFile(path, cast, { mode: 0o600 })
      // Prune after the write, so a store already at its limit still keeps the
      // recording the caller just asked for rather than evicting it first.
      await this.prune(dir)
      return { path, fileBytes: Buffer.byteLength(cast), error: null }
    } catch (error) {
      return { path: null, fileBytes: null, error: messageOf(error) }
    }
  }

  /** The written file for a recording, once its write settles. Null when this
   *  runtime never wrote a cast under that id. */
  async fileFor(id: string): Promise<TerminalRecordingFile | null> {
    return (await this.writes.get(id)) ?? null
  }

  /** Settles every outstanding write, so a list never reports a recording as
   *  unwritten merely because its write had not finished. */
  async settleAll(): Promise<Map<string, TerminalRecordingFile>> {
    const settled = new Map<string, TerminalRecordingFile>()
    for (const [id, pending] of this.writes) {
      settled.set(id, await pending)
    }
    return settled
  }

  /** Casts on disk this runtime did not write — earlier runs. Reported as a
   *  count rather than invented metadata: their capture facts are gone. */
  async foreignFileCount(dir: string): Promise<number> {
    const known = new Set([...this.writes.keys()].map((id) => `${id}--`))
    try {
      const entries = await readdir(dir)
      return entries.filter(
        (entry) =>
          entry.endsWith(CAST_SUFFIX) && ![...known].some((prefix) => entry.startsWith(prefix))
      ).length
    } catch {
      return 0
    }
  }

  /** Age then count, oldest first. Best-effort: a racing delete must not fail
   *  the recording that triggered the prune. */
  async prune(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    const cutoff = Date.now() - TERMINAL_RECORDING_RETENTION_MS
    const surviving: { path: string; mtimeMs: number }[] = []
    for (const entry of entries) {
      if (!entry.endsWith(CAST_SUFFIX)) {
        continue
      }
      const path = join(dir, entry)
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) {
          await unlink(path)
          continue
        }
        surviving.push({ path, mtimeMs: info.mtimeMs })
      } catch {
        // A file that vanished under us needs no eviction.
      }
    }
    surviving.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const stale of surviving.slice(
      0,
      Math.max(0, surviving.length - TERMINAL_RECORDING_FILE_LIMIT)
    )) {
      await unlink(stale.path).catch(() => {})
    }
  }
}
