import { describe, expect, it } from 'vitest'
import {
  TERMINAL_AGENT_VIEW_MAX_SCREEN_ROWS,
  buildTerminalAgentView,
  type TerminalAgentViewParts
} from './terminal-agent-view'

function parts(over: Partial<TerminalAgentViewParts> = {}): TerminalAgentViewParts {
  return {
    handle: 'term-1',
    status: 'running',
    screen: {
      rows: ['> ready', ''],
      cols: 120,
      rowCount: 24,
      cursor: { row: 1, col: 2 },
      alternateScreen: false
    },
    agent: { isRunningAgent: true, status: 'working' },
    lastBlock: null,
    scrollback: { originRow: 400, scrollbackRows: 900 },
    transcript: { lines: ['a', 'b'], linesTotal: 42 },
    ...over
  }
}

describe('terminal agent view', () => {
  it('answers screen, agent state, history depth and a resume cursor in one shape', () => {
    const view = buildTerminalAgentView(parts())
    expect(view.status).toBe('running')
    expect(view.screen).toMatchObject({
      available: true,
      rows: ['> ready', ''],
      cols: 120,
      rowCount: 24,
      cursor: { row: 1, col: 2 }
    })
    expect(view.agent).toEqual({ isRunningAgent: true, status: 'working' })
    expect(view.latestCursor).toBe('42')
  })

  it('reports the newest addressable row as the last GRID row, not the last history row', () => {
    const view = buildTerminalAgentView(parts())
    expect(view.history).toMatchObject({
      available: true,
      oldestHostRow: 400,
      latestHostRow: 400 + 900 + 24 - 1,
      scrollbackRows: 900,
      hasMoreAbove: true
    })
  })

  it('says the screen is unavailable rather than substituting the transcript', () => {
    const view = buildTerminalAgentView(parts({ screen: null, scrollback: null }))
    expect(view.screen).toEqual({
      available: false,
      rows: [],
      cols: null,
      rowCount: null,
      cursor: null,
      alternateScreen: false
    })
    expect(view.history.available).toBe(false)
    expect(view.history.latestHostRow).toBeNull()
  })

  it('reports no history above when the engine has not scrolled yet', () => {
    const view = buildTerminalAgentView(parts({ scrollback: { originRow: 0, scrollbackRows: 0 } }))
    expect(view.history.hasMoreAbove).toBe(false)
    expect(view.history.latestHostRow).toBe(23)
  })

  it('summarises the last block so a driver need not call terminal.blocks', () => {
    const view = buildTerminalAgentView(
      parts({
        lastBlock: {
          index: 4,
          command: 'npm test',
          exitCode: 1,
          startCursor: 10,
          endCursor: 30,
          startedAt: 1,
          endedAt: 2
        }
      })
    )
    expect(view.lastBlock).toMatchObject({
      index: 4,
      command: 'npm test',
      exitCode: 1,
      running: false,
      startCursor: '10',
      endCursor: '30',
      outputLineCount: 20
    })
  })

  it('keeps the newest rows when a very tall pane exceeds the row bound', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `row ${i}`)
    const view = buildTerminalAgentView(
      parts({
        screen: {
          rows,
          cols: 80,
          rowCount: 400,
          cursor: null,
          alternateScreen: true
        }
      })
    )
    expect(view.screen.rows).toHaveLength(TERMINAL_AGENT_VIEW_MAX_SCREEN_ROWS)
    expect(view.screen.rows.at(-1)).toBe('row 399')
    expect(view.screen.alternateScreen).toBe(true)
  })

  it('names every channel it cannot serve, including video and collapsed agent output', () => {
    const capabilities = buildTerminalAgentView(parts()).blindSpots.map((spot) => spot.capability)
    expect(capabilities).toEqual(['styles', 'graphics', 'video', 'agent-collapsed-output'])
  })
})
