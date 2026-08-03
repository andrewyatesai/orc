import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_RECORDING_FILE_LIMIT,
  TERMINAL_RECORDING_RETENTION_MS,
  TerminalRecordingStore,
  terminalRecordingFileName
} from './terminal-recording-store'
import type { TerminalCastCapture } from './terminal-cast-recorder'

const dirs: string[] = []

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cast-store-'))
  dirs.push(dir)
  return dir
}

function capture(overrides: Partial<TerminalCastCapture> = {}): TerminalCastCapture {
  return {
    id: 'rec_1',
    ptyId: 'pty-1',
    handle: 'term_a',
    startedAt: 1_000,
    endedAt: 2_000,
    cols: 80,
    rows: 24,
    sizeSource: 'engine',
    bytesCaptured: 4,
    eventsCaptured: 1,
    bytesDroppedAfterCap: 0,
    stopReason: 'requested',
    caps: { maxDurationMs: 1_000, maxBytes: 1_000, maxEvents: 10 },
    ...overrides
  }
}

afterEach(() => {
  dirs.length = 0
})

describe('TerminalRecordingStore', () => {
  it('writes the cast and reports its path and size', async () => {
    const dir = scratchDir()
    const store = new TerminalRecordingStore(() => dir)
    const entry = capture()
    const cast = '{"version":2,"width":80,"height":24}\n'
    store.write(entry, cast)
    const file = await store.fileFor(entry.id)
    expect(file?.error).toBeNull()
    expect(file?.path).toBe(join(dir, terminalRecordingFileName(entry)))
    expect(file?.fileBytes).toBe(cast.length)
    expect(readFileSync(file?.path ?? '', 'utf8')).toBe(cast)
  })

  it('sanitises the handle out of the filename', () => {
    expect(terminalRecordingFileName(capture({ handle: '../../etc/passwd' }))).toBe(
      'rec_1--.._.._etc_passwd.cast'
    )
  })

  it('reports a store it cannot open instead of throwing on the ingest path', async () => {
    const store = new TerminalRecordingStore(() => {
      throw new Error('EACCES')
    })
    expect(store.directory()).toBeNull()
    expect(store.lastDirectoryError).toBe('EACCES')
    const entry = capture()
    store.write(entry, 'cast')
    expect(await store.fileFor(entry.id)).toMatchObject({ path: null, error: 'EACCES' })
  })

  it('has no file for a recording it never wrote', async () => {
    const store = new TerminalRecordingStore(() => scratchDir())
    expect(await store.fileFor('rec_missing')).toBeNull()
  })

  it('deletes casts older than the retention window', async () => {
    const dir = scratchDir()
    const stale = join(dir, 'rec_old--term_x.cast')
    writeFileSync(stale, 'old')
    const staleSeconds = (Date.now() - TERMINAL_RECORDING_RETENTION_MS - 60_000) / 1000
    utimesSync(stale, staleSeconds, staleSeconds)
    const keep = join(dir, 'keep.txt')
    writeFileSync(keep, 'not a cast')
    utimesSync(keep, staleSeconds, staleSeconds)

    await new TerminalRecordingStore(() => dir).prune(dir)
    const entries = readdirSync(dir)
    expect(entries).not.toContain('rec_old--term_x.cast')
    // Only .cast files are the store's to delete.
    expect(entries).toContain('keep.txt')
  })

  it('keeps only the newest N casts', async () => {
    const dir = scratchDir()
    for (let index = 0; index < TERMINAL_RECORDING_FILE_LIMIT + 5; index += 1) {
      const path = join(dir, `rec_${index}--term_a.cast`)
      writeFileSync(path, 'x')
      const seconds = (Date.now() - (TERMINAL_RECORDING_FILE_LIMIT + 5 - index) * 1000) / 1000
      utimesSync(path, seconds, seconds)
    }
    await new TerminalRecordingStore(() => dir).prune(dir)
    const remaining = readdirSync(dir).filter((entry) => entry.endsWith('.cast'))
    expect(remaining).toHaveLength(TERMINAL_RECORDING_FILE_LIMIT)
    expect(remaining).toContain(`rec_${TERMINAL_RECORDING_FILE_LIMIT + 4}--term_a.cast`)
    expect(remaining).not.toContain('rec_0--term_a.cast')
  })

  it('counts casts it did not write as foreign, not as its own', async () => {
    const dir = scratchDir()
    const store = new TerminalRecordingStore(() => dir)
    const entry = capture()
    store.write(entry, 'cast')
    await store.fileFor(entry.id)
    writeFileSync(join(dir, 'rec_from_last_boot--term_z.cast'), 'x')
    expect(await store.foreignFileCount(dir)).toBe(1)
  })

  it('settleAll waits for every outstanding write', async () => {
    const dir = scratchDir()
    const store = new TerminalRecordingStore(() => dir)
    store.write(capture({ id: 'rec_a' }), 'a')
    store.write(capture({ id: 'rec_b' }), 'b')
    const settled = await store.settleAll()
    expect([...settled.keys()].sort()).toEqual(['rec_a', 'rec_b'])
    expect(settled.get('rec_a')?.path).not.toBeNull()
  })
})
