/**
 * asciicast v2 encoding and validation.
 *
 * The format is a JSON header line followed by one JSON array per line:
 *
 *   {"version":2,"width":80,"height":24,"timestamp":1504467315}
 *   [0.248848,"o","[1;31mHello[0m\r\n"]
 *
 * Why a real parser lives beside the encoder rather than only in a test: a
 * malformed cast is worthless to `asciinema`, `agg` and `ffmpeg`, and those
 * failures surface far from here. `parseAsciicastV2` is the shape gate the
 * recorder's own tests run against, so "we wrote a file" can never stand in for
 * "we wrote a cast something can play".
 *
 * Pure module: no clock, no I/O.
 */

export const ASCIICAST_VERSION = 2

/** asciinema records at microsecond resolution; more digits are noise that
 *  inflates every line of a long capture. */
const TIME_DECIMALS = 6

/** `o` output, `i` input, `r` resize, `m` marker. Only `o` and `r` are minted
 *  here — Orca taps the output stream, and input it did not send is not its to
 *  claim. */
export type AsciicastEventCode = 'o' | 'i' | 'r' | 'm'

export type AsciicastHeader = {
  version: typeof ASCIICAST_VERSION
  width: number
  height: number
  /** Unix SECONDS (not ms) — the format's own unit. */
  timestamp?: number
  /** Total span in seconds; players use it for a progress bar. */
  duration?: number
  title?: string
  env?: Record<string, string>
}

export type AsciicastEvent = {
  /** Seconds since the header timestamp. */
  time: number
  code: AsciicastEventCode
  data: string
}

export function asciicastTimeSeconds(elapsedMs: number): number {
  return Number((Math.max(0, elapsedMs) / 1000).toFixed(TIME_DECIMALS))
}

/** `WxH`, the payload an `r` event carries. */
export function asciicastResizeData(cols: number, rows: number): string {
  return `${cols}x${rows}`
}

export function encodeAsciicastHeader(header: AsciicastHeader): string {
  return JSON.stringify(header)
}

/** One event line. JSON.stringify is well-formed since ES2019, so a lone
 *  surrogate arriving from a split UTF-16 chunk escapes to \uD800-form rather
 *  than producing invalid UTF-8 in the file. */
export function encodeAsciicastEvent(event: AsciicastEvent): string {
  return JSON.stringify([event.time, event.code, event.data])
}

export function encodeAsciicast(
  header: AsciicastHeader,
  events: readonly AsciicastEvent[]
): string {
  const lines = [encodeAsciicastHeader(header)]
  for (const event of events) {
    lines.push(encodeAsciicastEvent(event))
  }
  // Trailing newline: a cast is line-delimited, and a final line without one
  // makes `tail`-style appenders concatenate two records.
  return `${lines.join('\n')}\n`
}

export type AsciicastParseResult =
  | { ok: true; header: AsciicastHeader; events: AsciicastEvent[] }
  | { ok: false; error: string; line: number }

function parseHeaderLine(raw: string): AsciicastHeader | string {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return 'header is not JSON'
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'header is not a JSON object'
  }
  const header = value as Record<string, unknown>
  if (header.version !== ASCIICAST_VERSION) {
    return `header version must be ${ASCIICAST_VERSION}`
  }
  if (!Number.isInteger(header.width) || (header.width as number) <= 0) {
    return 'header width must be a positive integer'
  }
  if (!Number.isInteger(header.height) || (header.height as number) <= 0) {
    return 'header height must be a positive integer'
  }
  return header as AsciicastHeader
}

const EVENT_CODES = new Set<string>(['o', 'i', 'r', 'm'])

function parseEventLine(raw: string): AsciicastEvent | string {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return 'event is not JSON'
  }
  if (!Array.isArray(value) || value.length !== 3) {
    return 'event must be a 3-element array'
  }
  const [time, code, data] = value as [unknown, unknown, unknown]
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
    return 'event time must be a non-negative finite number'
  }
  if (typeof code !== 'string' || !EVENT_CODES.has(code)) {
    return 'event code must be one of o, i, r, m'
  }
  if (typeof data !== 'string') {
    return 'event data must be a string'
  }
  return { time, code: code as AsciicastEventCode, data }
}

/** Strict shape check. Rejects rather than repairs: a cast this cannot parse is
 *  one `agg` would also refuse, and the caller needs to hear that here. */
export function parseAsciicastV2(text: string): AsciicastParseResult {
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  const first = lines.shift()
  if (first === undefined) {
    return { ok: false, error: 'empty file', line: 0 }
  }
  const header = parseHeaderLine(first)
  if (typeof header === 'string') {
    return { ok: false, error: header, line: 1 }
  }
  const events: AsciicastEvent[] = []
  let previousTime = 0
  for (const [index, raw] of lines.entries()) {
    const event = parseEventLine(raw)
    if (typeof event === 'string') {
      return { ok: false, error: event, line: index + 2 }
    }
    if (event.time < previousTime) {
      return { ok: false, error: 'event times must be non-decreasing', line: index + 2 }
    }
    previousTime = event.time
    events.push(event)
  }
  return { ok: true, header, events }
}
