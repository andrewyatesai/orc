import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_TUI_CLEAR_INPUT_LINE } from './agent-tui-input-clear'
import { typeAgentTuiCommand, type AgentTuiCommandWriteOutcome } from './agent-tui-command-typing'

afterEach(() => vi.useRealTimers())

describe('typeAgentTuiCommand', () => {
  it('writes a clear, one key per character, then Enter — never a pasted blob', async () => {
    vi.useFakeTimers()
    const keys: string[] = []
    const result = typeAgentTuiCommand({
      command: '/model',
      write: async (key) => {
        keys.push(key)
        return 'accepted'
      }
    })
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe('accepted')
    expect(keys).toEqual([AGENT_TUI_CLEAR_INPUT_LINE, '/', 'm', 'o', 'd', 'e', 'l', '\r'])
  })

  it('stops and surfaces the first non-accepted write outcome', async () => {
    vi.useFakeTimers()
    const keys: string[] = []
    const outcomes: AgentTuiCommandWriteOutcome[] = ['accepted', 'accepted', 'unknown']
    const result = typeAgentTuiCommand({
      command: '/model',
      write: async (key) => {
        keys.push(key)
        return outcomes.shift() ?? 'accepted'
      }
    })
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe('unknown')
    // clear + '/' accepted, then 'm' returns unknown and the burst halts.
    expect(keys).toEqual([AGENT_TUI_CLEAR_INPUT_LINE, '/', 'm'])
  })

  it('aborts before the next key when the signal fires mid-command', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const keys: string[] = []
    const result = typeAgentTuiCommand({
      command: '/model',
      signal: controller.signal,
      write: async (key) => {
        keys.push(key)
        if (keys.length === 2) {
          controller.abort()
        }
        return 'accepted'
      }
    })
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe('rejected')
    expect(keys).toEqual([AGENT_TUI_CLEAR_INPUT_LINE, '/'])
  })
})
