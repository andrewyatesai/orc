// The synthetic-agent-title twin's tests, moved with the implementation onto the
// seam shim. Every case runs TWICE — with the dispatch seam unbound (the renderer
// before wasm init) and bound to the wasm core (main/cli via napi, the relay via
// initSync) — because these answers are written back: main turns them into an
// OSC 0 title sequence in the PTY, and agent-title-owner rewrites mirrored remote
// status entries with them, so the two states disagreeing is a stuck wrong title.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { SYNTHETIC_AGENT_TITLE_PROFILES } from './synthetic-agent-title'
import {
  getSyntheticAgentTerminalTitle,
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook
} from './synthetic-agent-title-resolution'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call()).toEqual(expected)
  bindWasm()
  expect(call()).toEqual(expected)
}

afterEach(() => setOrcaDispatchBinding(null))

describe('synthetic agent titles', () => {
  it('provides terminal-state titles for Codex hook completion', () => {
    bothStates(() => getSyntheticAgentTerminalTitle('codex', 'done'), 'Codex ready')
    bothStates(() => getSyntheticAgentTerminalTitle('codex', 'waiting'), 'Codex - action required')
  })

  it('does not synthesize Codex working titles over Codex native spinner titles', () => {
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('codex', 'working'), false)
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('codex', 'done'), true)
  })

  it('does not synthesize OpenCode titles over native session titles', () => {
    bothStates(() => getSyntheticAgentTerminalTitle('opencode', 'done'), null)
    bothStates(() => getSyntheticAgentTerminalTitle('opencode', 'waiting'), null)
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('opencode', 'working'), false)
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('opencode', 'done'), false)
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('opencode', 'waiting'), false)
  })

  it('provides Devin titles for hook-driven status updates', () => {
    bothStates(() => getSyntheticAgentTerminalTitle('devin', 'done'), 'Devin ready')
    bothStates(() => getSyntheticAgentTerminalTitle('devin', 'waiting'), 'Devin - action required')
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('devin', 'working'), true)
  })

  it('provides Pi-compatible OMP titles for hook-driven status updates', () => {
    bothStates(() => getSyntheticAgentTerminalTitle('omp', 'done'), 'OMP ready')
    bothStates(() => getSyntheticAgentTerminalTitle('omp', 'waiting'), 'OMP - action required')
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('omp', 'working'), true)
  })

  it('provides Pi titles for hook-driven status updates', () => {
    bothStates(() => getSyntheticAgentTerminalTitle('pi', 'done'), 'Pi ready')
    bothStates(() => getSyntheticAgentTerminalTitle('pi', 'waiting'), 'Pi - action required')
    bothStates(() => shouldDriveSyntheticAgentTitleFromHook('pi', 'working'), true)
  })
})

describe('getSyntheticAgentTitleProfile (seam shim)', () => {
  it('answers every kept profile identically unbound and bound', () => {
    for (const [agentType, profile] of Object.entries(SYNTHETIC_AGENT_TITLE_PROFILES)) {
      bothStates(() => getSyntheticAgentTitleProfile(agentType), profile)
    }
  })

  it('answers null for an absent, empty, or unknown agent type', () => {
    bothStates(() => getSyntheticAgentTitleProfile(null), null)
    bothStates(() => getSyntheticAgentTitleProfile(undefined), null)
    bothStates(() => getSyntheticAgentTitleProfile(''), null)
    bothStates(() => getSyntheticAgentTitleProfile('claude'), null)
    bothStates(() => getSyntheticAgentTitleProfile('my-custom-agent'), null)
  })

  it('keeps pi and omp in one titleIdentityGroup and codex out of it', () => {
    bothStates(() => getSyntheticAgentTitleProfile('pi')?.titleIdentityGroup, 'pi-compatible')
    bothStates(() => getSyntheticAgentTitleProfile('omp')?.titleIdentityGroup, 'pi-compatible')
    bothStates(() => getSyntheticAgentTitleProfile('codex')?.titleIdentityGroup, undefined)
  })
})

// A custom agent may be named anything (`AgentType` is `string & {}`), and the
// deleted twin's `TABLE[agentType]` reached Object.prototype: 'toString' came
// back as a function, was treated as a profile, and main then wrote
// `\x1b]0;<undefined>\x07` into the PTY. Both shim paths now answer as the core
// does — wiring either one back to a raw index lookup turns this red.
describe('inherited Object.prototype keys are not profiles', () => {
  const INHERITED = [
    'toString',
    'constructor',
    '__proto__',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString'
  ]

  it('answers no profile, no title, and no title ownership in both states', () => {
    for (const agentType of INHERITED) {
      bothStates(() => getSyntheticAgentTitleProfile(agentType), null)
      bothStates(() => getSyntheticAgentTerminalTitle(agentType, 'done'), null)
      bothStates(() => shouldDriveSyntheticAgentTitleFromHook(agentType, 'done'), false)
    }
  })
})

describe('the dispatch seam is really the implementation', () => {
  it('routes each export to its orca-core function', () => {
    const calls: [string, string][] = []
    setOrcaDispatchBinding((module, fn, inputJson) => {
      calls.push([module, fn])
      return orcaDispatch(module, fn, inputJson)
    })

    getSyntheticAgentTitleProfile('codex')
    getSyntheticAgentTerminalTitle('codex', 'done')
    shouldDriveSyntheticAgentTitleFromHook('codex', 'done')

    expect(calls).toEqual([
      ['synthetic-agent-title', 'getSyntheticAgentTitleProfile'],
      ['synthetic-agent-title', 'getSyntheticAgentTerminalTitle'],
      ['synthetic-agent-title', 'shouldDriveSyntheticAgentTitleFromHook']
    ])
  })

  it('propagates a core failure instead of degrading to the local body', () => {
    setOrcaDispatchBinding(() => '{"__dispatch_error__":"unknown module"}')
    expect(() => getSyntheticAgentTitleProfile('codex')).toThrow(/failed in the Rust core/)
  })

  it('answers a codec-refused agent name locally instead of throwing', () => {
    // JSON.stringify emits a lone surrogate as `"\ud800"` — valid JSON text that
    // is not valid UTF-8, so the codec refuses the payload before it crosses.
    const binding = vi.fn((module: string, fn: string, inputJson: string) =>
      orcaDispatch(module, fn, inputJson)
    )
    setOrcaDispatchBinding(binding)
    expect(getSyntheticAgentTitleProfile('codex\ud800')).toBeNull()
    expect(shouldDriveSyntheticAgentTitleFromHook('codex\ud800', 'done')).toBe(false)
    expect(binding).not.toHaveBeenCalled()
  })
})
