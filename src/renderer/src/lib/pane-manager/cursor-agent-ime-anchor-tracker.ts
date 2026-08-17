import type { IBuffer } from './aterm/terminal-types'
import { resolveCursorAgentImeAnchor, type TerminalImeAnchor } from './terminal-ime-anchor'

export type CursorAgentImeAnchorInput = {
  buffer: IBuffer
  rows: number
  cols: number
  cursorX: number
  cursorY: number
}

export type CursorAgentImeAnchorTracker = (input: CursorAgentImeAnchorInput) => TerminalImeAnchor | null

/**
 * Per-pane latch around resolveCursorAgentImeAnchor: once the pane has resolved a
 * Cursor Agent anchor, it stays "known" so typed follow-ups keep anchoring to the
 * prompt row after the "Cursor Agent" header scrolls out of the top rows.
 */
export function createCursorAgentImeAnchorTracker(): CursorAgentImeAnchorTracker {
  let seen = false
  return (input) => {
    const anchor = resolveCursorAgentImeAnchor({ ...input, knownCursorAgent: seen })
    seen ||= anchor !== null
    return anchor
  }
}
