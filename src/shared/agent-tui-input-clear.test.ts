import { describe, expect, it } from 'vitest'
import {
  AGENT_TUI_CLEAR_INPUT_FORWARD,
  AGENT_TUI_CLEAR_INPUT_LINE,
  AGENT_TUI_CLEAR_INPUT_MAX,
  AGENT_TUI_CLEAR_LINE_SLACK,
  AGENT_TUI_CLEAR_MAX_LINES,
  buildAgentTuiClearInput,
  buildAgentTuiClearInputForText,
  countAgentTuiInputLines
} from './agent-tui-input-clear'

const countOf = (burst: string, char: string) =>
  [...burst].filter((candidate) => candidate === char).length

describe('agent TUI input clear', () => {
  // Why: this is the regression. A lone Ctrl+U kills only toward the start of the
  // CURRENT line, so every line above the cursor of a multi-line draft survived and
  // glued onto the next message on both desktop native chat and mobile.
  it('emits more than one kill so a multi-line draft cannot survive', () => {
    const burst = buildAgentTuiClearInput(3)
    expect(burst).not.toBe(AGENT_TUI_CLEAR_INPUT_LINE)
    expect(countOf(burst, AGENT_TUI_CLEAR_INPUT_LINE)).toBe(5)
    expect(countOf(burst, AGENT_TUI_CLEAR_INPUT_FORWARD)).toBe(5)
  })

  it('kills in both directions because the cursor position is unknown', () => {
    const burst = buildAgentTuiClearInput(1)
    expect(countOf(burst, AGENT_TUI_CLEAR_INPUT_LINE)).toBe(1)
    expect(countOf(burst, AGENT_TUI_CLEAR_INPUT_FORWARD)).toBe(1)
  })

  it('counts logical lines across every newline convention', () => {
    expect(countAgentTuiInputLines('one')).toBe(1)
    expect(countAgentTuiInputLines('one\ntwo')).toBe(2)
    expect(countAgentTuiInputLines('one\r\ntwo\rthree')).toBe(3)
  })

  it('biases the count upward, because Orca only knows what it injected', () => {
    const burst = buildAgentTuiClearInputForText('a\nb')
    expect(countOf(burst, AGENT_TUI_CLEAR_INPUT_LINE)).toBe(
      2 * (2 + AGENT_TUI_CLEAR_LINE_SLACK) - 1
    )
  })

  it('bounds a pathological draft instead of emitting an unbounded write', () => {
    const huge = buildAgentTuiClearInput(10_000)
    expect(huge).toBe(AGENT_TUI_CLEAR_INPUT_MAX)
    expect(countOf(huge, AGENT_TUI_CLEAR_INPUT_LINE)).toBe(2 * AGENT_TUI_CLEAR_MAX_LINES - 1)
  })

  it('clamps a zero or negative line count to one line', () => {
    expect(buildAgentTuiClearInput(0)).toBe(buildAgentTuiClearInput(1))
    expect(buildAgentTuiClearInput(-5)).toBe(buildAgentTuiClearInput(1))
  })
})
