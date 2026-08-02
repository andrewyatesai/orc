/**
 * Chunk-boundary-safe scanner turning raw PTY bytes into shell command-block
 * markers: OSC 133 A/B/C/D (prompt / command start / command finished) and the
 * OSC 633;E command line Orca's own shell hooks emit just before 133;C.
 *
 * Split from terminal-command-blocks.ts so the byte grammar (split prefixes,
 * BEL/ST terminators, oversized-sequence skip) stays separately testable from
 * the block bookkeeping. Carry semantics mirror
 * shared/terminal-osc133-command-finished.ts.
 */
import { unescapeOsc633Commandline } from '../../shared/terminal-osc633-commandline'

const OSC_PREFIX = '\x1b]'
const OSC_133 = '133;'
const OSC_633_E = '633;E;'
/** Our hooks truncate the command line at 2 KB; past that the sequence is
 *  foreign or corrupt, so its bytes are skipped rather than buffered forever. */
const MAX_OSC_CARRY_LENGTH = 8192
const MAX_COMMAND_CHARS = 2048

/** The transcript counters framing one raw chunk: the PTY record's completed
 *  line totals either side of the tail fold that consumed it. */
export type TerminalChunkTranscriptFrame = {
  cursorBefore: number
  cursorAfter: number
}

export type TerminalCommandMarker =
  | { kind: 'command-line'; command: string }
  | { kind: 'command-start'; cursor: number }
  | { kind: 'command-end'; cursor: number; exitCode: number | null }
  | { kind: 'prompt'; cursor: number }

type OscTerminator = { index: number; length: number }

function findOscTerminator(data: string, startIndex: number): OscTerminator | null {
  const bel = data.indexOf('\x07', startIndex)
  const st = data.indexOf('\x1b\\', startIndex)
  if (bel === -1 && st === -1) {
    return null
  }
  if (bel !== -1 && (st === -1 || bel < st)) {
    return { index: bel, length: 1 }
  }
  return { index: st, length: 2 }
}

function parseBestEffortExitCode(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Transcript cursor for a marker whose sequence ended at `tailStart`.
 *
 * Why newlines AFTER the marker rather than before: the shell emits 133;C from
 * preexec, after it has already echoed the command's own newline, and 133;A/D
 * from precmd, where everything that follows is the prompt repaint — which
 * completes no line. So post-marker bytes are ordinary program output whose
 * line completions are its raw newlines, and subtracting them from the
 * post-fold total lands the boundary exactly in the normal shell flow. The
 * clamp keeps a redraw-folded chunk inside the range the fold really produced.
 */
function markerCursor(
  combined: string,
  tailStart: number,
  frame: TerminalChunkTranscriptFrame
): number {
  let newlinesAfter = 0
  let index = combined.indexOf('\n', tailStart)
  while (index !== -1) {
    newlinesAfter += 1
    index = combined.indexOf('\n', index + 1)
  }
  const derived = frame.cursorAfter - newlinesAfter
  return Math.min(frame.cursorAfter, Math.max(frame.cursorBefore, derived))
}

function decodeOsc133(payload: string, cursor: number): TerminalCommandMarker | null {
  const [kind, field] = payload.split(';')
  if (kind === 'C') {
    return { kind: 'command-start', cursor }
  }
  if (kind === 'D') {
    return {
      kind: 'command-end',
      cursor,
      exitCode: parseBestEffortExitCode(field)
    }
  }
  if (kind === 'A' || kind === 'B') {
    return { kind: 'prompt', cursor }
  }
  return null
}

export type TerminalCommandMarkerScanner = {
  /** Feed one raw chunk in stream order; returns its markers, oldest first. */
  scan: (data: string, frame: TerminalChunkTranscriptFrame) => TerminalCommandMarker[]
  /** True once any byte has been buffered across a chunk boundary. */
  hasCarry: () => boolean
}

export function createTerminalCommandMarkerScanner(): TerminalCommandMarkerScanner {
  let carry = ''
  // Why: an oversized unterminated sequence is dropped, but its terminator has
  // not arrived yet — swallow bytes until it does so later sequences still parse.
  let skipUntilTerminator = false

  const scan = (data: string, frame: TerminalChunkTranscriptFrame): TerminalCommandMarker[] => {
    if (carry === '' && !skipUntilTerminator && !data.includes(OSC_PREFIX)) {
      // A trailing ESC may be an introducer's first byte, so it still has to
      // survive to the next chunk even on the no-OSC fast path.
      carry = data.endsWith('\x1b') ? '\x1b' : ''
      return []
    }
    let combined = carry + data
    carry = ''
    if (skipUntilTerminator) {
      const terminator = findOscTerminator(combined, 0)
      if (!terminator) {
        return []
      }
      skipUntilTerminator = false
      combined = combined.slice(terminator.index + terminator.length)
    }

    const markers: TerminalCommandMarker[] = []
    let cursor = 0
    for (;;) {
      const start = combined.indexOf(OSC_PREFIX, cursor)
      if (start === -1) {
        // Only a lone ESC can begin an introducer that is still undecided.
        carry = combined.endsWith('\x1b') ? '\x1b' : ''
        return markers
      }
      const bodyStart = start + OSC_PREFIX.length
      const is133 = combined.startsWith(OSC_133, bodyStart)
      const is633 = combined.startsWith(OSC_633_E, bodyStart)
      if (!is133 && !is633) {
        // A truncated `\x1b]13` at the chunk edge must survive to the next
        // chunk, so only step past an introducer long enough to have decided.
        if (combined.length - bodyStart < OSC_633_E.length) {
          carry = combined.slice(start)
          return markers
        }
        cursor = bodyStart
        continue
      }
      const payloadStart = bodyStart + (is133 ? OSC_133.length : OSC_633_E.length)
      const terminator = findOscTerminator(combined, payloadStart)
      if (!terminator) {
        carry = combined.slice(start)
        if (carry.length > MAX_OSC_CARRY_LENGTH) {
          carry = ''
          skipUntilTerminator = true
        }
        return markers
      }
      const payload = combined.slice(payloadStart, terminator.index)
      const tailStart = terminator.index + terminator.length
      if (is633) {
        // A nonce-suffixed emission is `633;E;<command>;<nonce>`; the command's
        // own `;` are escaped as \x3b, so the first raw `;` ends the command.
        const commandField = payload.split(';', 1)[0] ?? ''
        markers.push({
          kind: 'command-line',
          command: unescapeOsc633Commandline(commandField).slice(0, MAX_COMMAND_CHARS)
        })
      } else {
        const marker = decodeOsc133(payload, markerCursor(combined, tailStart, frame))
        if (marker) {
          markers.push(marker)
        }
      }
      cursor = tailStart
    }
  }

  return {
    scan,
    hasCarry: () => carry !== '' || skipUntilTerminator
  }
}
