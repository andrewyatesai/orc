import { describe, expect, it } from 'vitest'
import { loadRustGitBinding } from './daemon/rust-git-addon'
import {
  normalizeTerminalQuickCommands as napiNormalize,
  supportsTerminalAgentQuickCommand as napiSupports
} from './rust-terminal-quick-commands'
import {
  MAX_QUICK_COMMANDS,
  normalizeTerminalQuickCommands as tsNormalize,
  supportsTerminalAgentQuickCommand as tsSupports
} from '../shared/terminal-quick-commands'
import { TUI_AGENT_CONFIG } from '../shared/tui-agent-config'

// The Rust orca-agents core is main's sole quick-command normalizer (napi), but
// src/shared/terminal-quick-commands.ts is still mobile's impl — mobile has no
// napi. Nothing else makes the two run over the same input, so drift between
// them is invisible until a phone and a desktop disagree about one payload.
//
// Skips cleanly when the .node is absent (CI without a native build).
const suite = loadRustGitBinding() ? describe : describe.skip

const SUPPORTED_AGENT = 'claude' // argv prompt injection
const STDIN_AGENT = 'aider' // stdin-after-start — rejected for quick commands

const NON_BMP = '😀'.repeat(60) // UTF-16 slicing: Rust must cut where JS cuts

const VECTORS: readonly (readonly [string, unknown])[] = [
  ['non-array input', { nope: true }],
  ['null input', null],
  ['empty list', []],
  ['non-object items', [null, 42, 'x', ['y'], undefined]],
  [
    'retired presets',
    [
      { id: 'default-pwd', label: 'a' },
      { id: 'default-git-status', label: 'b' }
    ]
  ],
  ['blank row dropped', [{ id: 'only-id' }]],
  ['incomplete row kept', [{ id: 'a', label: 'Label only' }]],
  ['id trimmed then defaulted', [{ id: '   ', label: 'L', command: 'echo 1' }]],
  ['duplicate ids get suffixes', Array.from({ length: 4 }, () => ({ id: 'dup', label: 'L' }))],
  [
    'long id dedup',
    [
      { id: 'x'.repeat(90), label: 'L' },
      { id: 'x'.repeat(90), label: 'L' }
    ]
  ],
  ['non-BMP id and label', [{ id: NON_BMP, label: NON_BMP, command: 'echo hi' }]],
  ['label whitespace trimmed', [{ id: 'a', label: '  spaced  ', command: 'c' }]],
  ['command trailing-space kept at end', [{ id: 'a', label: 'L', command: '  echo hi  \n\n' }]],
  ['oversized command', [{ id: 'a', label: 'L', command: 'z'.repeat(4200) }]],
  ['appendEnter absent', [{ id: 'a', label: 'L', command: 'c' }]],
  ['appendEnter false', [{ id: 'a', label: 'L', command: 'c', appendEnter: false }]],
  ['appendEnter truthy non-bool', [{ id: 'a', label: 'L', command: 'c', appendEnter: 'yes' }]],
  [
    'agent-prompt supported',
    [{ id: 'a', label: 'L', action: 'agent-prompt', agent: SUPPORTED_AGENT, prompt: ' hi \n' }]
  ],
  [
    'agent-prompt stdin agent dropped',
    [{ id: 'a', label: 'L', action: 'agent-prompt', agent: STDIN_AGENT, prompt: 'hi' }]
  ],
  [
    'agent-prompt unknown agent dropped',
    [{ id: 'a', label: 'L', action: 'agent-prompt', agent: 'nope', prompt: 'hi' }]
  ],
  [
    'agent field on terminal-command ignored',
    [{ id: 'a', label: 'L', command: 'c', agent: STDIN_AGENT }]
  ],
  [
    'oversized prompt',
    [
      {
        id: 'a',
        label: 'L',
        action: 'agent-prompt',
        agent: SUPPORTED_AGENT,
        prompt: 'p'.repeat(6200)
      }
    ]
  ],
  ['scope global', [{ id: 'a', label: 'L', command: 'c', scope: { type: 'global' } }]],
  ['scope repo', [{ id: 'a', label: 'L', command: 'c', scope: { type: 'repo', repoId: ' r ' } }]],
  [
    'scope repo blank falls back',
    [{ id: 'a', label: 'L', command: 'c', scope: { type: 'repo', repoId: '  ' } }]
  ],
  [
    'scope repo oversized',
    [{ id: 'a', label: 'L', command: 'c', scope: { type: 'repo', repoId: 'r'.repeat(240) } }]
  ],
  ['scope malformed', [{ id: 'a', label: 'L', command: 'c', scope: 'global' }]],
  [
    'over the cap',
    Array.from({ length: MAX_QUICK_COMMANDS + 12 }, (_, i) => ({
      id: `cmd-${i}`,
      label: `L${i}`,
      command: `echo ${i}`
    }))
  ]
]

suite('terminal quick commands: napi core vs the shared TS impl mobile ships', () => {
  it.each(VECTORS.map(([name, input]) => ({ name, input })))(
    'normalizes identically: $name',
    ({ input }) => {
      expect(napiNormalize(input)).toEqual(tsNormalize(input))
    }
  )

  it('agrees on every configured agent, and on non-string input', () => {
    const candidates: unknown[] = [...Object.keys(TUI_AGENT_CONFIG), 'nope', '', null, 7, {}, []]
    for (const agent of candidates) {
      expect({ agent, supported: napiSupports(agent) }).toEqual({
        agent,
        supported: tsSupports(agent)
      })
    }
  })

  it('caps the list at the catalog maximum', () => {
    const over = Array.from({ length: MAX_QUICK_COMMANDS + 5 }, (_, i) => ({
      id: `c${i}`,
      label: 'L',
      command: 'echo'
    }))
    expect(napiNormalize(over)).toHaveLength(MAX_QUICK_COMMANDS)
  })
})
