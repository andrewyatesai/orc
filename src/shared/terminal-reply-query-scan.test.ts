import { describe, expect, it } from 'vitest'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from './terminal-reply-query-scan'

describe('terminal reply query scan', () => {
  it('records reply-eliciting queries with their output high-water sequence', () => {
    const data = `before\x1b[6nafter\x1b[?2031h`
    const result = scanTerminalReplyQuerySequences(data, 100, EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE)

    expect(result.queries).toEqual([
      { data: '\x1b[6n', startSeq: 106, endSeq: 110 },
      { data: '\x1b[?2031h', startSeq: 115, endSeq: 123 }
    ])
    expect(result.state).toEqual(EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE)
  })

  it('assembles a query split across contiguous PTY chunks', () => {
    const first = scanTerminalReplyQuerySequences(
      '\x1b[?',
      20,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    const second = scanTerminalReplyQuerySequences('2026$p', 23, first.state)

    expect(first.queries).toEqual([])
    expect(second.queries).toEqual([{ data: '\x1b[?2026$p', startSeq: 20, endSeq: 29 }])
  })

  it('drops a partial query when output sequence continuity is lost', () => {
    const first = scanTerminalReplyQuerySequences(
      '\x1b[?',
      20,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    const second = scanTerminalReplyQuerySequences('2026$p', 30, first.state)

    expect(second.queries).toEqual([])
  })

  // #9993: the 2031 withdraw must replay alongside its arm, or a late-attaching client
  // registers a subscription the TUI already retired (fish rearms/withdraws per prompt).
  it('replays a DECRST 2031 withdrawal alongside the arm', () => {
    const data = `\x1b[?2031h paint \x1b[?2031l`
    const result = scanTerminalReplyQuerySequences(data, 0, EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE)

    expect(result.queries.map((query) => query.data)).toEqual(['\x1b[?2031h', '\x1b[?2031l'])
  })

  it('does not replay a combined DECRST that toggles unrelated modes with 2031', () => {
    // Exact-form only — replaying `CSI ?2004;2031l` would also flip mode 2004 in the client.
    const result = scanTerminalReplyQuerySequences(
      `\x1b[?2004;2031l`,
      0,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )

    expect(result.queries).toEqual([])
  })
})
