// Clearing an agent TUI's input buffer when it may hold MORE THAN ONE line.
//
// Why: a single Ctrl+U only kills toward the start of the CURRENT line, so a
// multi-line unsent draft keeps every line above the cursor and glues onto the
// next prompt. The law below is a property of the agent TUIs (Claude Code,
// codex), not of either client, so desktop native chat and mobile share it.

/** Ctrl+U — clears toward the start of the input buffer. */
export const AGENT_TUI_CLEAR_INPUT_LINE = '\x15'
/** Ctrl+K — clears toward the end of the input buffer. */
export const AGENT_TUI_CLEAR_INPUT_FORWARD = '\x0b'

/**
 * Headroom over the line count Orca knows about. The text Orca injected is a
 * LOWER BOUND on what the buffer holds — the user can also type straight into
 * the TUI line — so the count is deliberately biased upward. Overshoot is free;
 * an undershoot is what leaves residue to glue onto the next message.
 */
export const AGENT_TUI_CLEAR_LINE_SLACK = 8
/** Bounds the burst so a pathological draft cannot emit an unbounded write. */
export const AGENT_TUI_CLEAR_MAX_LINES = 40

/** Clear up to `lineCount` logical lines from any cursor position. */
export function buildAgentTuiClearInput(lineCount: number): string {
  const lines = Math.max(1, Math.min(AGENT_TUI_CLEAR_MAX_LINES, Math.floor(lineCount)))
  // Why: from an unknown cursor position each logical line can need a kill in
  // both directions, and the seam between two lines needs one extra.
  const repetitions = 2 * lines - 1
  return (
    AGENT_TUI_CLEAR_INPUT_LINE.repeat(repetitions) +
    AGENT_TUI_CLEAR_INPUT_FORWARD.repeat(repetitions)
  )
}

/** Logical lines in `text`. Visual wrapping is irrelevant to the clear cost. */
export function countAgentTuiInputLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}

/** Clear bytes for a buffer believed to hold `text`, with slack for TUI-side edits. */
export function buildAgentTuiClearInputForText(text: string): string {
  return buildAgentTuiClearInput(countAgentTuiInputLines(text) + AGENT_TUI_CLEAR_LINE_SLACK)
}

/** Widest burst we ever send — the remedy when a clear is not observed to land. */
export const AGENT_TUI_CLEAR_INPUT_MAX = buildAgentTuiClearInput(AGENT_TUI_CLEAR_MAX_LINES)
