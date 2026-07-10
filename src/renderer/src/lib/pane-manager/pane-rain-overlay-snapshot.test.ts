import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

import { RainOverlaySnapshotCollector } from './pane-rain-overlay-snapshot'
import {
  RAIN_CELL_BOLD,
  RAIN_CELL_OVERLINE,
  RAIN_CELL_UNDERLINE,
  RAIN_COLOR_PALETTE,
  RAIN_COLOR_RGB
} from './pane-rain-overlay-types'

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('RainOverlaySnapshotCollector', () => {
  it('reads literal visible glyphs and xterm-resolved cell colors', async () => {
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols: 10,
      rows: 2,
      theme: { foreground: '#d0d0d0', background: '#101010' }
    })
    const collector = new RainOverlaySnapshotCollector()

    await write(terminal, '\x1b[1;4;53;38;2;12;34;56;44mCodex\x1b[0m 猫')
    const snapshot = collector.capture(terminal as unknown as Terminal, 7)

    expect(snapshot.glyphs.slice(0, 5).join('')).toBe('Codex')
    expect(snapshot.glyphs[6]).toBe('猫')
    expect(snapshot.widths[6]).toBe(2)
    expect(snapshot.widths[7]).toBe(0)
    expect(snapshot.foreground[0]).toBe(RAIN_COLOR_RGB | 0x0c2238)
    expect(snapshot.background[0]).toBe(RAIN_COLOR_PALETTE | 4)
    expect(snapshot.attributes[0] & RAIN_CELL_BOLD).toBe(RAIN_CELL_BOLD)
    expect(snapshot.attributes[0] & RAIN_CELL_UNDERLINE).toBe(RAIN_CELL_UNDERLINE)
    expect(snapshot.attributes[0] & RAIN_CELL_OVERLINE).toBe(RAIN_CELL_OVERLINE)
    expect(snapshot.defaultForeground).toBe('#d0d0d0')
    expect(snapshot.defaultBackground).toBe('#101010')
    expect(snapshot.contentSequence).toBe(7)
  })

  it('reuses storage and follows the active viewport instead of scrollback origin', async () => {
    const terminal = new HeadlessTerminal({ cols: 4, rows: 2, scrollback: 10 })
    const collector = new RainOverlaySnapshotCollector()

    await write(terminal, 'one\r\ntwo\r\ntri')
    const first = collector.capture(terminal as unknown as Terminal, 1)
    const glyphStorage = first.glyphs
    const widthStorage = first.widths

    expect(first.glyphs.slice(0, 4).join('')).toBe('two')
    expect(first.glyphs.slice(4, 8).join('')).toBe('tri')

    await write(terminal, '\rFOUR')
    const second = collector.capture(terminal as unknown as Terminal, 2)
    expect(second).toBe(first)
    expect(second.glyphs).toBe(glyphStorage)
    expect(second.widths).toBe(widthStorage)
    expect(second.glyphs.slice(4, 8).join('')).toBe('FOUR')
    expect(second.sequence).toBe(2)
  })
})
