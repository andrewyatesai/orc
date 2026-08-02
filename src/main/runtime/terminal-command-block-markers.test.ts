import { describe, expect, it } from 'vitest'
import { createTerminalCommandMarkerScanner } from './terminal-command-block-markers'

const FRAME = { cursorBefore: 0, cursorAfter: 0 }

function scanAll(chunks: [string, { cursorBefore: number; cursorAfter: number }][]) {
  const scanner = createTerminalCommandMarkerScanner()
  return chunks.flatMap(([data, frame]) => scanner.scan(data, frame))
}

describe('terminal command marker scanner', () => {
  it('decodes prompt, command start and command finished with the exit code', () => {
    expect(scanAll([['\x1b]133;A\x07\x1b]133;C\x07\x1b]133;D;3\x07', FRAME]])).toEqual([
      { kind: 'prompt', cursor: 0 },
      { kind: 'command-start', cursor: 0 },
      { kind: 'command-end', cursor: 0, exitCode: 3 }
    ])
  })

  it('accepts the ST terminator as well as BEL', () => {
    const markers = scanAll([['\x1b]133;C\x1b\\', FRAME]])
    expect(markers).toEqual([{ kind: 'command-start', cursor: 0 }])
  })

  it('reports a missing exit code as null rather than zero', () => {
    expect(scanAll([['\x1b]133;D\x07', FRAME]])).toEqual([
      { kind: 'command-end', cursor: 0, exitCode: null }
    ])
    expect(scanAll([['\x1b]133;D;nope\x07', FRAME]])).toEqual([
      { kind: 'command-end', cursor: 0, exitCode: null }
    ])
  })

  it('unescapes an OSC 633;E command line and stops at the nonce separator', () => {
    expect(scanAll([['\x1b]633;E;echo \\x3bhi\\x3b;abc123\x07', FRAME]])).toEqual([
      { kind: 'command-line', command: 'echo ;hi;' }
    ])
  })

  it('survives a sequence split across chunk boundaries', () => {
    const scanner = createTerminalCommandMarkerScanner()
    expect(scanner.scan('\x1b]13', FRAME)).toEqual([])
    expect(scanner.scan('3;C', FRAME)).toEqual([])
    expect(scanner.scan('\x07', FRAME)).toEqual([{ kind: 'command-start', cursor: 0 }])
    expect(scanner.hasCarry()).toBe(false)
  })

  it('survives a lone ESC at the chunk edge', () => {
    const scanner = createTerminalCommandMarkerScanner()
    expect(scanner.scan('output\x1b', FRAME)).toEqual([])
    expect(scanner.scan(']133;C\x07', FRAME)).toEqual([{ kind: 'command-start', cursor: 0 }])
  })

  it('ignores unrelated OSC sequences without losing a following marker', () => {
    expect(scanAll([['\x1b]0;a title\x07\x1b]133;C\x07', FRAME]])).toEqual([
      { kind: 'command-start', cursor: 0 }
    ])
  })

  it('drops an oversized unterminated sequence but keeps parsing after it', () => {
    const scanner = createTerminalCommandMarkerScanner()
    expect(scanner.scan(`\x1b]633;E;${'x'.repeat(9000)}`, FRAME)).toEqual([])
    expect(scanner.scan('\x07\x1b]133;C\x07', FRAME)).toEqual([
      { kind: 'command-start', cursor: 0 }
    ])
  })

  it('lands a command-start cursor before output that arrived in the same chunk', () => {
    // The shell echoed the command's newline (cursor 10 -> 11), emitted C, then
    // the child wrote two lines in the same read.
    const markers = scanAll([
      ['\x1b]133;C\x07first line\nsecond line\n', { cursorBefore: 11, cursorAfter: 13 }]
    ])
    expect(markers).toEqual([{ kind: 'command-start', cursor: 11 }])
  })

  it('lands a command-end cursor after the last output line, before the prompt repaint', () => {
    const markers = scanAll([
      ['last output\n\x1b]133;D;0\x07user@host $ ', { cursorBefore: 40, cursorAfter: 41 }]
    ])
    expect(markers).toEqual([{ kind: 'command-end', cursor: 41, exitCode: 0 }])
  })

  it('clamps a derived cursor into the range the fold actually produced', () => {
    // A redraw-folded chunk can carry more raw newlines than completed lines;
    // the marker must not be attributed before the chunk started.
    const markers = scanAll([['\x1b]133;C\x07\n\n\n\n\n', { cursorBefore: 100, cursorAfter: 101 }]])
    expect(markers).toEqual([{ kind: 'command-start', cursor: 100 }])
  })
})
