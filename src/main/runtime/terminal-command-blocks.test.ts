import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RETAINED_COMMAND_BLOCKS,
  TerminalCommandBlockLedger,
  resetTerminalCommandBlockLedgerForTest,
  terminalCommandBlockLedger
} from './terminal-command-blocks'

const PTY = 'pty-1'

function feed(
  ledger: TerminalCommandBlockLedger,
  data: string,
  cursorBefore = 0,
  cursorAfter = cursorBefore,
  at = 1000
): void {
  ledger.ingest(PTY, data, { cursorBefore, cursorAfter, at })
}

describe('terminal command block ledger', () => {
  beforeEach(() => {
    resetTerminalCommandBlockLedgerForTest()
  })

  it('records a full prompt → command → exit cycle with the command line', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, '\x1b]133;A\x07user@host $ ', 0, 0, 100)
    feed(ledger, '\x1b]633;E;npm test\x07\x1b]133;C\x07', 1, 1, 200)
    feed(ledger, 'ok\n', 1, 2, 300)
    feed(ledger, '\x1b]133;D;0\x07', 2, 2, 400)

    expect(ledger.snapshot(PTY)).toEqual({
      blocks: [
        {
          index: 0,
          command: 'npm test',
          exitCode: 0,
          startCursor: 1,
          endCursor: 2,
          startedAt: 200,
          endedAt: 400
        }
      ],
      totalObserved: 1,
      evictedCount: 0,
      shellIntegrationSeen: true
    })
  })

  it('leaves a running block open with a null end cursor', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, '\x1b]133;C\x07', 5, 5, 100)
    const block = ledger.last(PTY)
    expect(block?.endCursor).toBeNull()
    expect(block?.exitCode).toBeNull()
    expect(block?.startCursor).toBe(5)
  })

  it('closes an open block at the next prompt when the shell emitted no D', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, '\x1b]133;C\x07', 0, 0, 100)
    feed(ledger, 'output\n', 0, 1, 150)
    feed(ledger, '\x1b]133;A\x07', 1, 1, 200)
    const block = ledger.last(PTY)
    expect(block).toMatchObject({ endCursor: 1, exitCode: null, endedAt: 200 })
  })

  it('never lets one command swallow the next when D is missing entirely', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, '\x1b]133;C\x07', 0, 0, 100)
    feed(ledger, '\x1b]133;C\x07', 3, 3, 200)
    const snapshot = ledger.snapshot(PTY)
    expect(snapshot.blocks).toHaveLength(2)
    expect(snapshot.blocks[0]).toMatchObject({
      index: 0,
      startCursor: 0,
      endCursor: 3
    })
    expect(snapshot.blocks[1]).toMatchObject({
      index: 1,
      startCursor: 3,
      endCursor: null
    })
  })

  it('does not reuse a command line on the block after the one it named', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, '\x1b]633;E;ls\x07\x1b]133;C\x07', 0, 0, 100)
    feed(ledger, '\x1b]133;D;0\x07\x1b]133;C\x07', 1, 1, 200)
    const [first, second] = ledger.snapshot(PTY).blocks
    expect(first?.command).toBe('ls')
    expect(second?.command).toBeNull()
  })

  it('keeps monotone indices and reports eviction once the cap is passed', () => {
    const ledger = new TerminalCommandBlockLedger()
    for (let i = 0; i < MAX_RETAINED_COMMAND_BLOCKS + 5; i += 1) {
      feed(ledger, '\x1b]133;C\x07', i, i, 1000 + i)
      feed(ledger, '\x1b]133;D;0\x07', i, i, 1000 + i)
    }
    const snapshot = ledger.snapshot(PTY)
    expect(snapshot.blocks).toHaveLength(MAX_RETAINED_COMMAND_BLOCKS)
    expect(snapshot.totalObserved).toBe(MAX_RETAINED_COMMAND_BLOCKS + 5)
    expect(snapshot.evictedCount).toBe(5)
    expect(snapshot.blocks[0]?.index).toBe(5)
    expect(ledger.get(PTY, 4)).toBeNull()
    expect(ledger.get(PTY, 5)?.index).toBe(5)
  })

  it('bounds the returned list without changing the observed totals', () => {
    const ledger = new TerminalCommandBlockLedger()
    for (let i = 0; i < 4; i += 1) {
      feed(ledger, '\x1b]133;C\x07\x1b]133;D;0\x07', i, i, 1000 + i)
    }
    const snapshot = ledger.snapshot(PTY, 2)
    expect(snapshot.blocks.map((block) => block.index)).toEqual([2, 3])
    expect(snapshot.totalObserved).toBe(4)
  })

  it('reports no shell integration seen for a pane that only printed text', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, 'plain output with \x1b[31mcolour\x1b[0m\n', 0, 1)
    expect(ledger.snapshot(PTY)).toMatchObject({
      blocks: [],
      totalObserved: 0,
      shellIntegrationSeen: false
    })
  })

  it('stitches a marker split across chunks that both lack the full introducer', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, 'tail of output\x1b', 0, 0, 100)
    feed(ledger, ']133;C\x07', 0, 0, 200)
    expect(ledger.last(PTY)?.index).toBe(0)
  })

  it('drops a pty so a respawn reusing the id inherits no boundaries', () => {
    const ledger = terminalCommandBlockLedger()
    ledger.ingest(PTY, '\x1b]133;C\x07', {
      cursorBefore: 0,
      cursorAfter: 0,
      at: 1
    })
    expect(ledger.last(PTY)).not.toBeNull()
    ledger.dropPty(PTY)
    expect(ledger.last(PTY)).toBeNull()
    expect(ledger.snapshot(PTY).shellIntegrationSeen).toBe(false)
  })

  it('hands back copies so a caller cannot mutate the ledger', () => {
    const ledger = new TerminalCommandBlockLedger()
    feed(ledger, '\x1b]133;C\x07', 0, 0, 100)
    const block = ledger.last(PTY)!
    block.startCursor = 999
    expect(ledger.last(PTY)?.startCursor).toBe(0)
  })
})
