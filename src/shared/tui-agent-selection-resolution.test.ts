// The tui-agent-selection twin's tests, moved with the implementation onto the
// seam shim. Every case runs TWICE — with the dispatch seam unbound (the
// renderer before wasm init, the Playwright specs) and bound to the wasm core
// (main/cli via napi, the relay via initSync, the renderer at ready) — because
// this module answers WHICH AGENT LAUNCHES and which disabled ids get written
// back: `use-onboarding-flow.ts:197` persists the collapsed default agent and
// `main/persistence.ts:5893` persists the normalized disabled list.
//
// `agree` is the differential that makes the shim's `parity` claim an observed
// fact rather than a promise: unbound is the deleted twin's body, bound is the
// Rust core, and every probe asserts they answer identically.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  collapseDefaultTuiAgentToBuiltin,
  filterEnabledTuiAgents,
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents,
  pickTuiAgent
} from './tui-agent-selection-resolution'
import { TUI_AGENT_AUTO_PICK_ORDER } from './tui-agent-selection'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { CustomAgentProfile, TuiAgent } from './types'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

let crossings = 0

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => {
    crossings += 1
    return orcaDispatch(module, fn, inputJson)
  })
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call()).toEqual(expected)
  bindWasm()
  expect(call()).toEqual(expected)
}

/** The pre-ready contract as a measurement: the deleted body and the Rust core
 *  must answer this input identically. Returns the shared answer. */
function agree<T>(call: () => T): T {
  setOrcaDispatchBinding(null)
  const preReady = call()
  bindWasm()
  const ready = call()
  expect({ input: 'see caller', ready }).toEqual({
    input: 'see caller',
    ready: preReady
  })
  return ready
}

afterEach(() => setOrcaDispatchBinding(null))

// --- the twin's own test cases, verbatim ---

describe('pickTuiAgent', () => {
  it('uses an installed preferred agent', () => {
    bothStates(() => pickTuiAgent('codex', ['claude', 'codex']), 'codex')
  })

  it('falls back in desktop catalog order when the preference is absent or stale', () => {
    bothStates(() => pickTuiAgent(null, ['cursor', 'codex']), 'codex')
    bothStates(() => pickTuiAgent('gemini', ['cursor', 'codex']), 'codex')
    bothStates(() => pickTuiAgent(null, ['continue', 'command-code']), 'command-code')
  })

  it('respects the explicit blank terminal preference', () => {
    bothStates(() => pickTuiAgent('blank', ['cursor', 'claude']), null)
  })

  it('ignores disabled preferred and fallback agents', () => {
    bothStates(() => pickTuiAgent('codex', ['claude', 'codex'], ['codex']), 'claude')
    bothStates(() => pickTuiAgent(null, ['claude', 'codex'], ['claude', 'codex']), null)
  })
})

describe('normalizeDisabledTuiAgents', () => {
  it('dedupes supported agent ids and drops unsupported values', () => {
    bothStates(
      () => normalizeDisabledTuiAgents(['codex', 'unknown', 'codex', null, 'claude']),
      ['codex', 'claude']
    )
  })
})

// --- the crossing actually happens ---

describe('the bound state reaches the Rust core', () => {
  it('dispatches once per exported call instead of silently answering locally', () => {
    bindWasm()
    const before = crossings
    pickTuiAgent('codex', ['codex'])
    normalizeDisabledTuiAgents(['codex'])
    isTuiAgentEnabled('codex', ['claude'])
    filterEnabledTuiAgents(['codex'], ['claude'])
    collapseDefaultTuiAgentToBuiltin('codex', [])
    expect(crossings - before).toBe(5)
  })
})

// --- the differential ---

const AGENTS = [...TUI_AGENT_AUTO_PICK_ORDER]

describe('catalog', () => {
  it('agrees with the core on validity for every id either catalog knows', () => {
    // Why both catalogs: the twin validated with `isTuiAgent` (a TUI_AGENT_CONFIG
    // key check) while the core checks membership of the auto-pick order, so a
    // drift between the two TS tables would also be a TS/Rust divergence.
    const universe = [...new Set([...AGENTS, ...Object.keys(TUI_AGENT_CONFIG)])]
    expect(Object.keys(TUI_AGENT_CONFIG).slice().sort()).toEqual(AGENTS.slice().sort())
    for (const id of universe) {
      expect(agree(() => normalizeDisabledTuiAgents([id]))).toEqual([id])
    }
  })

  it('agrees on auto-pick priority for every ordered pair of agents', () => {
    for (const first of AGENTS) {
      for (const second of AGENTS) {
        agree(() => pickTuiAgent(null, [first, second]))
      }
    }
  })
})

describe('normalizeDisabledTuiAgents differential', () => {
  it('agrees on every mixed-type array up to length 3', () => {
    const alphabet: unknown[] = ['codex', 'claude', 'unknown', '', null, 5, true, {}, ['codex']]
    const walk = (prefix: unknown[]): void => {
      if (prefix.length > 0) {
        agree(() => normalizeDisabledTuiAgents(prefix))
      }
      if (prefix.length === 3) {
        return
      }
      for (const item of alphabet) {
        walk([...prefix, item])
      }
    }
    walk([])
  })

  it('agrees on non-arrays, which the twin answered [] for', () => {
    const nonArrays: unknown[] = [
      null,
      undefined,
      '',
      'codex',
      0,
      true,
      {},
      { 0: 'codex' },
      new Set(['codex']),
      new Map(),
      new Date(0)
    ]
    for (const value of nonArrays) {
      expect(agree(() => normalizeDisabledTuiAgents(value))).toEqual([])
    }
  })

  it('agrees on a lone surrogate, which cannot cross the codec at all', () => {
    expect(agree(() => normalizeDisabledTuiAgents(['\uD800', 'codex']))).toEqual(['codex'])
  })
})

const LISTS: unknown[][] = [
  [],
  ['codex'],
  ['claude', 'codex'],
  ['cursor', 'codex'],
  ['continue', 'command-code'],
  ['unknown'],
  ['', null],
  [null, 'codex'],
  ['codex', 'codex'],
  AGENTS,
  [5, 'codex'],
  ['claude-agent-teams', 'claude']
]

describe('pickTuiAgent differential', () => {
  it('agrees over preferred x detected x disabled', () => {
    const prefs: unknown[] = [
      undefined,
      null,
      'blank',
      '',
      'codex',
      'claude',
      'unknown',
      5,
      true,
      '__proto__'
    ]
    for (const preferred of prefs) {
      for (const detected of LISTS) {
        for (const disabled of [undefined, null, ...LISTS]) {
          agree(() =>
            pickTuiAgent(
              preferred as TuiAgent,
              detected as TuiAgent[],
              disabled as TuiAgent[] | null
            )
          )
        }
      }
    }
  })

  it('reads a Set of detected agents, which the twin took as an Iterable', () => {
    expect(agree(() => pickTuiAgent(null, new Set<TuiAgent>(['cursor', 'codex'])))).toBe('codex')
  })

  it('keeps the twin answer for a non-string preference the core cannot model', () => {
    // Out of the declared union, but `defaultTuiAgent` is read off persisted
    // JSON: the twin returned the value when `detected` held it, the core reads
    // it as "no preference", so the shim must not let the core answer.
    const junk = 5 as unknown as TuiAgent
    expect(agree(() => pickTuiAgent(junk, [junk, 'codex']))).toBe(junk)
  })

  it('treats an empty preference as no preference, exactly as the falsy twin did', () => {
    const blankish = '' as unknown as TuiAgent
    expect(agree(() => pickTuiAgent(blankish, [blankish, 'codex']))).toBe('codex')
  })
})

describe('isTuiAgentEnabled / filterEnabledTuiAgents differential', () => {
  const disabledLists: unknown[] = [
    undefined,
    null,
    [],
    ['codex'],
    AGENTS,
    ['unknown'],
    [null],
    [5],
    'codex'
  ]

  it('agrees over agent x disabled', () => {
    for (const agent of [...AGENTS, '', 'unknown', '__proto__', 'toString']) {
      for (const disabled of disabledLists) {
        agree(() => isTuiAgentEnabled(agent as TuiAgent, disabled as TuiAgent[] | null))
      }
    }
  })

  it('agrees over agents x disabled', () => {
    const agentLists: TuiAgent[][] = [
      [],
      ['codex'],
      AGENTS,
      ['codex', 'codex'],
      ['unknown' as TuiAgent, 'codex']
    ]
    for (const agents of agentLists) {
      for (const disabled of disabledLists) {
        agree(() => filterEnabledTuiAgents(agents, disabled as TuiAgent[] | null))
      }
    }
  })

  it('keeps a non-string entry instead of the empty string the core substitutes', () => {
    const junk = 5 as unknown as TuiAgent
    expect(agree(() => filterEnabledTuiAgents([junk, 'codex'], ['claude']))).toEqual([
      junk,
      'codex'
    ])
  })
})

describe('collapseDefaultTuiAgentToBuiltin differential', () => {
  const CLAUDE_PROFILE = {
    id: 'p1',
    baseAgent: 'claude'
  } as CustomAgentProfile
  const rosters: unknown[] = [
    undefined,
    null,
    [],
    [CLAUDE_PROFILE],
    [{ id: 'p0', baseAgent: 'codex' }, CLAUDE_PROFILE],
    [CLAUDE_PROFILE, { id: 'p1', baseAgent: 'codex' }],
    [{ id: 'p1' }],
    [{ id: 'p1', baseAgent: null }],
    [{ id: 'p1', baseAgent: '' }],
    [{ id: 'p1', baseAgent: 7 }],
    [{ baseAgent: 'codex' }],
    [{ id: 123, baseAgent: 'codex' }],
    ['p1'],
    [5],
    [
      {
        id: 'p1',
        baseAgent: 'claude',
        label: 'x',
        command: 'claude',
        env: { A: 'b' }
      }
    ]
  ]
  const prefs: unknown[] = [
    undefined,
    null,
    '',
    'codex',
    'blank',
    'unknown',
    '__undefined__',
    '__proto__',
    { kind: 'custom', id: 'p1' },
    { kind: 'custom', id: 'gone' },
    { kind: 'custom', id: '' },
    { kind: 'custom' },
    { id: 'p1' },
    [],
    ['p1'],
    0,
    42,
    true,
    false,
    { kind: 'custom', id: 123 }
  ]

  it('agrees over pref x roster, including every out-of-union class', () => {
    for (const pref of prefs) {
      for (const roster of rosters) {
        agree(() => {
          try {
            return collapseDefaultTuiAgentToBuiltin(
              pref as TuiAgent,
              roster as CustomAgentProfile[] | null
            )
          } catch (error) {
            // A roster that is not a list has no `.find`; the twin threw a
            // TypeError there and the shim must throw the same one.
            return `THREW ${(error as Error).name}`
          }
        })
      }
    }
  })

  it('resolves a custom preference to its profile base agent', () => {
    bothStates(
      () => collapseDefaultTuiAgentToBuiltin({ kind: 'custom', id: 'p1' }, [CLAUDE_PROFILE]),
      'claude'
    )
  })

  it('falls back to auto when the custom profile is gone', () => {
    bothStates(
      () => collapseDefaultTuiAgentToBuiltin({ kind: 'custom', id: 'gone' }, [CLAUDE_PROFILE]),
      null
    )
  })

  it('keeps undefined distinct from null, because callers spread the answer', () => {
    // An absent `defaultTuiAgent` key and an explicit `null` mean different
    // things downstream; the core round-trips undefined through a sentinel and
    // the shim must turn it back.
    expect(agree(() => collapseDefaultTuiAgentToBuiltin(undefined, []))).toBeUndefined()
    expect(agree(() => collapseDefaultTuiAgentToBuiltin(null, []))).toBeNull()
  })

  it('passes a built-in preference through without validating it', () => {
    bothStates(
      () => collapseDefaultTuiAgentToBuiltin('not-an-agent' as TuiAgent, [CLAUDE_PROFILE]),
      'not-an-agent' as TuiAgent
    )
  })

  it('keeps the sentinel string as a value the way the twin did', () => {
    // '__undefined__' is how the core spells `undefined`, so it can never make
    // the round trip as data — the shim answers it without crossing.
    bothStates(
      () => collapseDefaultTuiAgentToBuiltin('__undefined__' as TuiAgent, []),
      '__undefined__' as TuiAgent
    )
  })

  it('ignores a profile field the core cannot read rather than dropping the answer', () => {
    const numeric = [{ id: 'p1', baseAgent: 7 }] as unknown as CustomAgentProfile[]
    expect(
      agree(() => collapseDefaultTuiAgentToBuiltin({ kind: 'custom', id: 'p1' }, numeric))
    ).toBe(7 as unknown as TuiAgent)
  })

  it('agrees when a profile carries an explicitly undefined optional field', () => {
    // `env?: Record<string, string>` spelled as `env: undefined` is what the
    // codec refuses to encode; the shim sends only id/baseAgent.
    const withUndefined = [
      { id: 'p1', baseAgent: 'claude', env: undefined }
    ] as unknown as CustomAgentProfile[]
    expect(
      agree(() => collapseDefaultTuiAgentToBuiltin({ kind: 'custom', id: 'p1' }, withUndefined))
    ).toBe('claude')
  })
})
