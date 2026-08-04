import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { TerminalSnapshot } from './types'
import { serializeTerminalCheckpointWithinLimit } from './terminal-checkpoint-serializer'

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    snapshotAnsi: 'visible',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/workspace',
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    },
    cols: 80,
    rows: 24,
    scrollbackLines: 0,
    ...overrides
  }
}

const metadata = {
  cwd: '/workspace',
  generation: 1,
  checkpointedAt: '2026-07-29T00:00:00.000Z'
}

describe('terminal checkpoint serializer', () => {
  // Why measured: the over-limit fallback replays through aterm, whose blank visible-only snapshot
  // has a ~1.2 KB floor (xterm-headless's fit under 512) — a cap under it leaves no candidate at all.
  let replayFloorBytes = 0

  beforeAll(async () => {
    const blankReplay = await serializeTerminalCheckpointWithinLimit(
      snapshot({ snapshotAnsi: String.fromCharCode(0).repeat(64 * 1024) }),
      metadata,
      64 * 1024
    )
    replayFloorBytes = Buffer.byteLength(blankReplay, 'utf8')
  })

  it('matches JSON.stringify exactly at the UTF-8 byte limit', async () => {
    const input = snapshot({
      snapshotAnsi: `é漢😀${String.fromCharCode(0xd800, 0xdc00)}"\\${String.fromCharCode(
        0x00,
        0x08,
        0x09,
        0x0a,
        0x0c,
        0x0d,
        0x1f,
        0xd800,
        0xdc00
      )}`,
      oscLinks: [{ row: 0, startCol: 0, endCol: 1, uri: 'https://example.com/😀\n' }]
    })
    const expected = JSON.stringify({
      snapshotAnsi: input.snapshotAnsi,
      scrollbackAnsi: input.scrollbackAnsi,
      oscLinks: input.oscLinks,
      rehydrateSequences: input.rehydrateSequences,
      cwd: metadata.cwd,
      cols: input.cols,
      rows: input.rows,
      modes: input.modes,
      scrollbackLines: input.scrollbackLines,
      generation: metadata.generation,
      checkpointedAt: metadata.checkpointedAt
    })
    const exactBytes = Buffer.byteLength(expected, 'utf8')

    await expect(serializeTerminalCheckpointWithinLimit(input, metadata, exactBytes)).resolves.toBe(
      expected
    )
  })

  it('rejects multibyte input whose code-unit length fits under the byte cap', async () => {
    // 500 multibyte rows: the replayed grid keeps only the visible ones, so the fallback fits a cap
    // sized off the direct candidate's code-unit length.
    const input = snapshot({ snapshotAnsi: 'é\r\n'.repeat(500) })
    const expected = JSON.stringify({
      snapshotAnsi: input.snapshotAnsi,
      scrollbackAnsi: input.scrollbackAnsi,
      oscLinks: input.oscLinks,
      rehydrateSequences: input.rehydrateSequences,
      cwd: metadata.cwd,
      cols: input.cols,
      rows: input.rows,
      modes: input.modes,
      scrollbackLines: input.scrollbackLines,
      generation: metadata.generation,
      checkpointedAt: metadata.checkpointedAt
    })
    const maxBytes = expected.length + 1

    expect(expected.length).toBeLessThan(maxBytes)
    expect(Buffer.byteLength(expected, 'utf8')).toBeGreaterThan(maxBytes)
    expect(maxBytes).toBeGreaterThan(replayFloorBytes)

    const serialized = await serializeTerminalCheckpointWithinLimit(input, metadata, maxBytes)

    expect(serialized).not.toBe(expected)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(maxBytes)
  })

  it('does not materialize and rescan a passing candidate', async () => {
    let reads = 0
    const input = snapshot()
    Object.defineProperty(input, 'snapshotAnsi', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'visible'
      }
    })
    const stringify = vi.spyOn(JSON, 'stringify')
    const byteLength = vi.spyOn(Buffer, 'byteLength')

    try {
      await serializeTerminalCheckpointWithinLimit(input, metadata, 20 * 1024)

      expect({
        fullCandidateStringifies: stringify.mock.calls.filter(
          ([value]) => typeof value === 'object' && value !== null
        ).length,
        byteLengthCalls: byteLength.mock.calls.length,
        snapshotReads: reads
      }).toEqual({ fullCandidateStringifies: 0, byteLengthCalls: 0, snapshotReads: 1 })
    } finally {
      stringify.mockRestore()
      byteLength.mockRestore()
    }
  })

  it('rejects an oversized escaped candidate without materializing it', async () => {
    const oversized = String.fromCharCode(0).repeat(100_000)
    const maxBytes = 20 * 1024
    expect(maxBytes).toBeGreaterThan(replayFloorBytes)
    const stringify = vi.spyOn(JSON, 'stringify')

    try {
      await serializeTerminalCheckpointWithinLimit(
        snapshot({ snapshotAnsi: oversized }),
        metadata,
        maxBytes
      )

      const materializedOversizedCandidate = stringify.mock.calls.some(([value]) => {
        return (value as { snapshotAnsi?: unknown })?.snapshotAnsi === oversized
      })
      expect(materializedOversizedCandidate).toBe(false)
    } finally {
      stringify.mockRestore()
    }
  })
})
