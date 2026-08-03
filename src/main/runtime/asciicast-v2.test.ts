import { describe, expect, it } from 'vitest'
import {
  asciicastResizeData,
  asciicastTimeSeconds,
  encodeAsciicast,
  parseAsciicastV2
} from './asciicast-v2'

describe('asciicast v2', () => {
  it('encodes a document the parser accepts, header first', () => {
    const text = encodeAsciicast(
      { version: 2, width: 120, height: 40, timestamp: 1_700_000_000, duration: 1.5 },
      [
        { time: 0, code: 'o', data: 'hello' },
        { time: 0.5, code: 'r', data: asciicastResizeData(80, 24) },
        { time: 1.25, code: 'o', data: '[31mred[0m\r\n' }
      ]
    )
    const lines = text.split('\n')
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 120, height: 40 })
    expect(text.endsWith('\n')).toBe(true)
    const parsed = parseAsciicastV2(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.events).toEqual([
      { time: 0, code: 'o', data: 'hello' },
      { time: 0.5, code: 'r', data: '80x24' },
      { time: 1.25, code: 'o', data: '[31mred[0m\r\n' }
    ])
  })

  it('escapes control bytes and lone surrogates rather than emitting them raw', () => {
    const text = encodeAsciicast({ version: 2, width: 80, height: 24 }, [
      { time: 0, code: 'o', data: ']0;title\ud83d' }
    ])
    // A raw ESC or a lone surrogate in the file makes the line unparseable for
    // agg/asciinema; both must survive as escapes.
    expect(text).toContain('\\u001b')
    expect(text).toContain('\\ud83d')
    expect(parseAsciicastV2(text).ok).toBe(true)
  })

  it('rounds times to microseconds and never below zero', () => {
    expect(asciicastTimeSeconds(1234)).toBe(1.234)
    expect(asciicastTimeSeconds(1)).toBe(0.001)
    expect(asciicastTimeSeconds(-50)).toBe(0)
  })

  it.each([
    ['not json at all\n', 'header is not JSON'],
    ['[1,2,3]\n', 'header is not a JSON object'],
    ['{"version":1,"width":80,"height":24}\n', 'header version must be 2'],
    ['{"version":2,"width":0,"height":24}\n', 'header width must be a positive integer'],
    ['{"version":2,"width":80,"height":-1}\n', 'header height must be a positive integer']
  ])('rejects a malformed header: %s', (text, error) => {
    expect(parseAsciicastV2(text)).toEqual({ ok: false, error, line: 1 })
  })

  it.each([
    ['{"time":0}', 'event must be a 3-element array'],
    ['[0,"o"]', 'event must be a 3-element array'],
    ['[-1,"o","x"]', 'event time must be a non-negative finite number'],
    ['[0,"z","x"]', 'event code must be one of o, i, r, m'],
    ['[0,"o",5]', 'event data must be a string']
  ])('rejects a malformed event: %s', (line, error) => {
    const text = `{"version":2,"width":80,"height":24}\n${line}\n`
    expect(parseAsciicastV2(text)).toEqual({ ok: false, error, line: 2 })
  })

  it('rejects events that go backwards in time', () => {
    const text = '{"version":2,"width":80,"height":24}\n[1,"o","a"]\n[0.5,"o","b"]\n'
    expect(parseAsciicastV2(text)).toEqual({
      ok: false,
      error: 'event times must be non-decreasing',
      line: 3
    })
  })

  it('accepts a header-only cast', () => {
    const parsed = parseAsciicastV2(encodeAsciicast({ version: 2, width: 80, height: 24 }, []))
    expect(parsed.ok && parsed.events).toEqual([])
  })
})
