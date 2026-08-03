/**
 * `terminal.record` end to end in the runtime: the byte tap really is
 * `onPtyData`, the cast really parses, and every "no" is a named cause rather
 * than an empty recording.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { parseAsciicastV2 } from './asciicast-v2'
import { resetTerminalCastRecorderForTest } from './terminal-cast-recorder'

type RuntimeInternals = {
  handles: Map<
    string,
    {
      handle: string
      worktreeId: string
      tabId: string
      ptyId: string | null
      runtimeId: string
      rendererGraphEpoch: number
      leafId: string
      ptyGeneration: number
    }
  >
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
}

let storeDir: string
let previousDir: string | undefined

function seedPane(runtime: OrcaRuntimeService, handle: string, ptyId: string | null): void {
  const internals = runtime as unknown as RuntimeInternals
  internals.handles.set(handle, {
    handle,
    worktreeId: 'wt-1',
    // A `pty:` tab short-circuits leaf lookup, which is how background CLI panes
    // are addressed.
    tabId: `pty:${ptyId ?? 'none'}`,
    ptyId,
    runtimeId: 'rt-test',
    rendererGraphEpoch: 1,
    leafId: 'leaf-1',
    ptyGeneration: 1
  })
}

/** Gives the runtime the ingest state onPtyData would have created. */
function ingestedPane(runtime: OrcaRuntimeService, handle: string, ptyId: string): void {
  seedPane(runtime, handle, ptyId)
  ;(runtime as unknown as RuntimeInternals).recordPtyWorktree(ptyId, 'wt-1', { connected: true })
}

beforeEach(() => {
  resetTerminalCastRecorderForTest()
  storeDir = mkdtempSync(join(tmpdir(), 'orca-cast-runtime-'))
  previousDir = process.env.ORCA_TERMINAL_RECORDING_DIR
  process.env.ORCA_TERMINAL_RECORDING_DIR = storeDir
})

afterEach(() => {
  if (previousDir === undefined) {
    delete process.env.ORCA_TERMINAL_RECORDING_DIR
  } else {
    process.env.ORCA_TERMINAL_RECORDING_DIR = previousDir
  }
  rmSync(storeDir, { recursive: true, force: true })
})

describe('terminal.record in the runtime', () => {
  it('records the bytes onPtyData sees and writes a parseable cast', async () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')

    const started = runtime.startTerminalRecording('h1')
    expect(started.started).toBe(true)
    expect(started.recording?.state).toBe('recording')

    runtime.onPtyData('pty-1', 'hello \x1b[31mworld\x1b[0m\r\n', Date.now())
    runtime.onPtyData('pty-1', 'second chunk\r\n', Date.now() + 20)

    const stopped = await runtime.stopTerminalRecording('h1')
    expect(stopped.stopped).toBe(true)
    expect(stopped.recording?.stopReason).toBe('requested')
    expect(stopped.recording?.eventsCaptured).toBe(2)
    expect(stopped.playback?.gif).toContain('agg ')

    const path = stopped.recording?.path
    expect(path).toBeTruthy()
    const parsed = parseAsciicastV2(readFileSync(path ?? '', 'utf8'))
    expect(parsed.ok).toBe(true)
    // The SGR the transcript verbs strip is exactly what a cast must keep.
    expect(parsed.ok && parsed.events.map((event) => event.data).join('')).toContain('[31mworld')
  })

  it('refuses a pane this runtime does not host, by name', async () => {
    const runtime = new OrcaRuntimeService()
    const started = runtime.startTerminalRecording('h-remote')
    expect(started).toMatchObject({ started: false, unavailable: 'pane-not-hosted-here' })
    expect(started.detail).toContain('remote runtime')
    const stopped = await runtime.stopTerminalRecording('h-remote')
    expect(stopped).toMatchObject({ stopped: false, unavailable: 'pane-not-hosted-here' })
  })

  it('refuses a pane whose bytes this runtime does not ingest', () => {
    const runtime = new OrcaRuntimeService()
    // Addressable, but no PTY record and no headless engine: nothing feeds it here.
    seedPane(runtime, 'h1', 'pty-elsewhere')
    expect(runtime.startTerminalRecording('h1')).toMatchObject({
      started: false,
      unavailable: 'bytes-not-local'
    })
  })

  it('refuses a pane with no PTY yet, distinctly from an untappable one', () => {
    const runtime = new OrcaRuntimeService()
    seedPane(runtime, 'h1', null)
    expect(runtime.startTerminalRecording('h1')).toMatchObject({
      started: false,
      unavailable: 'no-pty'
    })
  })

  it('refuses a second recording and names the one already running', () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')
    const first = runtime.startTerminalRecording('h1')
    const second = runtime.startTerminalRecording('h1')
    expect(second).toMatchObject({ started: false, unavailable: 'already-recording' })
    expect(second.recording?.id).toBe(first.recording?.id)
  })

  it('stop on a pane that never recorded says so instead of writing an empty cast', async () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')
    expect(await runtime.stopTerminalRecording('h1')).toMatchObject({
      stopped: false,
      unavailable: 'not-recording'
    })
  })

  it('ends the recording when the PTY exits, and still writes the cast', async () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')
    runtime.startTerminalRecording('h1')
    runtime.onPtyData('pty-1', 'partial\r\n', Date.now())
    runtime.onPtyExit('pty-1', 0)

    const stopped = await runtime.stopTerminalRecording('h1')
    expect(stopped.recording?.stopReason).toBe('pty-exit')
    expect(readFileSync(stopped.recording?.path ?? '', 'utf8')).toContain('partial')
  })

  it('a byte cap ends the recording without a stop call and the file is already there', async () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')
    runtime.startTerminalRecording('h1', { maxBytes: 8 })
    runtime.onPtyData('pty-1', 'over the cap', Date.now())
    runtime.onPtyData('pty-1', 'more after', Date.now() + 5)

    const list = await runtime.listTerminalRecordings()
    expect(list.available).toBe(true)
    expect(list.directory).toBe(storeDir)
    expect(list.recordings).toHaveLength(1)
    expect(list.recordings[0]).toMatchObject({
      state: 'finalized',
      stopReason: 'byte-cap',
      bytesDroppedAfterCap: 10
    })
    expect(list.recordings[0].fileBytes).toBeGreaterThan(0)
    expect(parseAsciicastV2(readFileSync(list.recordings[0].path ?? '', 'utf8')).ok).toBe(true)
  })

  it('takes its geometry from the live engine when there is one, else says it assumed', () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')
    // No headless engine is hydrated in this posture, so the size is not observed.
    expect(runtime.startTerminalRecording('h1').recording).toMatchObject({
      sizeSource: 'assumed',
      cols: 80
    })
  })

  it('honours a caller-declared size when the engine cannot answer', () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')
    expect(runtime.startTerminalRecording('h1', { cols: 132, rows: 43 }).recording).toMatchObject({
      sizeSource: 'requested',
      cols: 132,
      rows: 43
    })
  })

  it('every result carries the content-not-pixels caveat', async () => {
    const runtime = new OrcaRuntimeService()
    ingestedPane(runtime, 'h1', 'pty-1')
    runtime.startTerminalRecording('h1')
    const stopped = await runtime.stopTerminalRecording('h1')
    const list = await runtime.listTerminalRecordings()
    for (const spots of [stopped.blindSpots, list.blindSpots]) {
      expect(spots.map((spot) => spot.reason)).toContain('cast-is-content-not-pixels')
    }
  })
})
