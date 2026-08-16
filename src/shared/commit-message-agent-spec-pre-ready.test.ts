// The pre-ready contract for the seven lookups `commit-message-agent-spec.ts`
// cut over, and the evidence for the one export that stayed in TypeScript.
//
// The shim declares `parity`, which is three separate claims:
//  1. BOUND == UNBOUND for every named edge class. The renderer builds
//     `TEXT_GENERATION_AGENT_ID_SET` from `listCommitMessageAgentCapabilities()`
//     at import time, before wasm, and never recomputes it, so a pre-ready answer
//     that is not the twin's answer is frozen for the session.
//  2. THE FALLBACK IS STILL HEAD'S BODY. It is compared against
//     `commit-message-agent-spec-pre-cutover-lookups.ts`, a frozen transcription,
//     because the fallback is a fourth implementation the moment anyone edits it.
//  3. THE CORE IS ACTUALLY REACHED. A bound==unbound test passes vacuously if the
//     shim silently never crosses, so a counting binding proves each export
//     reached its own arm by name.
//
// The residual list is not asserted, it is DEMONSTRATED: for each refused class
// the raw core is called directly and shown to answer differently from the twin,
// so the refusal is necessary rather than defensive, and a guard that has never
// been seen to fail is not left in the file.
//
// The corpus half of the proof is `pnpm parity`, which drives this shim UNBOUND
// over the shared vectors against the natively built crate — a third build of the
// same Rust, since these suites bind the wasm blob.
import { afterEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import {
  COMMIT_MESSAGE_AGENT_SPEC_LOOKUP_FALLBACKS,
  COMMIT_MESSAGE_AGENT_SPECS,
  getCommitMessageAgentCapability,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  getCommitMessageModelCapability,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  listCommitMessageAgentIds,
  resolveCommitMessageAgentChoice
} from './commit-message-agent-spec'
import {
  preCutoverGetCommitMessageAgentCapability,
  preCutoverGetCommitMessageModel,
  preCutoverGetCommitMessageModelCapability,
  preCutoverIsCustomAgentId,
  preCutoverListCommitMessageAgentCapabilities,
  preCutoverListCommitMessageAgentIds,
  preCutoverResolveCommitMessageAgentChoice
} from './commit-message-agent-spec-pre-cutover-lookups'
import { byteImage, callImage, strictImage } from './commit-message-agent-spec-shape-fixtures'
import { decodeDispatchResult, DispatchCoreError } from './dispatch-payload-codec'
import { getAgentModelProbeSpec } from './agent-model-probe-spec'
import { setOrcaDispatchBinding, type OrcaDispatchFn } from './orca-dispatch-seam'
import type { TuiAgent } from './types'

const wasmBinding: OrcaDispatchFn = (module, fn, inputJson) => orcaDispatch(module, fn, inputJson)

afterEach(() => setOrcaDispatchBinding(wasmBinding))

/** Straight to the arm, past the shim's refusals — the only way to show that a
 *  refusal is answering a real difference. */
function rawCore(fn: string, input: unknown): unknown {
  return JSON.parse(orcaDispatch('commit-message-agent-spec', fn, JSON.stringify(input)))
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Why: these are the inputs
   the declared types forbid and persisted settings still hold. */
type Case = { name: string; shim: () => unknown; reference: () => unknown }

/** Every export, including the answers no JSON vector can carry (TS `undefined`)
 *  and the inputs the shim deliberately refuses. */
const CASES: Case[] = [
  {
    name: 'listCommitMessageAgentIds',
    shim: () => listCommitMessageAgentIds(),
    reference: () => preCutoverListCommitMessageAgentIds()
  },
  {
    name: 'listCommitMessageAgentCapabilities',
    shim: () => listCommitMessageAgentCapabilities(),
    reference: () => preCutoverListCommitMessageAgentCapabilities()
  },
  {
    name: 'isCustomAgentId(custom)',
    shim: () => isCustomAgentId('custom'),
    reference: () => preCutoverIsCustomAgentId('custom')
  },
  {
    name: 'isCustomAgentId(undefined)',
    shim: () => isCustomAgentId(undefined),
    reference: () => preCutoverIsCustomAgentId(undefined)
  },
  {
    // Present because a fallback that started case-folding slipped past an
    // earlier version of this list while the shape sweep caught it.
    name: 'isCustomAgentId(CUSTOM)',
    shim: () => isCustomAgentId('CUSTOM'),
    reference: () => preCutoverIsCustomAgentId('CUSTOM')
  },
  {
    name: 'isCustomAgentId(Custom)',
    shim: () => isCustomAgentId('Custom'),
    reference: () => preCutoverIsCustomAgentId('Custom')
  },
  {
    name: 'isCustomAgentId(lone surrogate) — the codec refuses the payload',
    shim: () => isCustomAgentId('\ud800' as any),
    reference: () => preCutoverIsCustomAgentId('\ud800' as any)
  },
  {
    // Answers TS `undefined`; the arm spells that `Value::Null`.
    name: 'getCommitMessageModel(claude, no such model)',
    shim: () => getCommitMessageModel('claude' as TuiAgent, 'nope'),
    reference: () => preCutoverGetCommitMessageModel('claude' as TuiAgent, 'nope')
  },
  {
    name: 'getCommitMessageModel(claude, haiku) — a catalog row with no effort levels',
    shim: () => getCommitMessageModel('claude' as TuiAgent, 'haiku'),
    reference: () => preCutoverGetCommitMessageModel('claude' as TuiAgent, 'haiku')
  },
  {
    name: 'getCommitMessageModel(codex, unlisted) — the synthesized dynamic model',
    shim: () => getCommitMessageModel('codex' as TuiAgent, 'gpt-5.9-turbo'),
    reference: () => preCutoverGetCommitMessageModel('codex' as TuiAgent, 'gpt-5.9-turbo')
  },
  {
    // The JS trim set: U+FEFF is whitespace to `String.prototype.trim`, so the id
    // is blank and NO model is synthesized. `str::trim` disagrees, which is why
    // the core has to use `trim_js`.
    name: 'getCommitMessageModel(codex, BOM only)',
    shim: () => getCommitMessageModel('codex' as TuiAgent, '﻿'),
    reference: () => preCutoverGetCommitMessageModel('codex' as TuiAgent, '﻿')
  },
  {
    // U+0085 is NOT in the JS trim set, so the id is non-blank and a model IS
    // synthesized, carrying the NEL in the `--model` argv.
    name: 'getCommitMessageModel(codex, NEL only)',
    shim: () => getCommitMessageModel('codex' as TuiAgent, ''),
    reference: () => preCutoverGetCommitMessageModel('codex' as TuiAgent, '')
  },
  {
    name: 'getCommitMessageModel(codex, lone surrogate) — the codec refuses',
    shim: () => getCommitMessageModel('codex' as TuiAgent, 'x\ud800'),
    reference: () => preCutoverGetCommitMessageModel('codex' as TuiAgent, 'x\ud800')
  },
  {
    name: 'getCommitMessageModel(toString, x) — a prototype key, which the twin CRASHES on',
    shim: () => getCommitMessageModel('toString' as TuiAgent, 'x'),
    reference: () => preCutoverGetCommitMessageModel('toString' as TuiAgent, 'x')
  },
  {
    name: 'getCommitMessageModel(["claude"], haiku) — a coerced non-string key',
    shim: () => getCommitMessageModel(['claude'] as any, 'haiku'),
    reference: () => preCutoverGetCommitMessageModel(['claude'] as any, 'haiku')
  },
  {
    name: 'getCommitMessageModel(codex, 5) — a non-string id the twin CRASHES on',
    shim: () => getCommitMessageModel('codex' as TuiAgent, 5 as any),
    reference: () => preCutoverGetCommitMessageModel('codex' as TuiAgent, 5 as any)
  },
  {
    name: 'getCommitMessageAgentCapability(codex)',
    shim: () => getCommitMessageAgentCapability('codex' as TuiAgent),
    reference: () => preCutoverGetCommitMessageAgentCapability('codex' as TuiAgent)
  },
  {
    name: 'getCommitMessageAgentCapability(grok) — a TuiAgent with no spec',
    shim: () => getCommitMessageAgentCapability('grok' as TuiAgent),
    reference: () => preCutoverGetCommitMessageAgentCapability('grok' as TuiAgent)
  },
  {
    name: 'getCommitMessageAgentCapability(__proto__) — the twin CRASHES',
    shim: () => getCommitMessageAgentCapability('__proto__' as TuiAgent),
    reference: () => preCutoverGetCommitMessageAgentCapability('__proto__' as TuiAgent)
  },
  {
    name: 'getCommitMessageModelCapability(codex, gpt-5.4-mini)',
    shim: () => getCommitMessageModelCapability('codex' as TuiAgent, 'gpt-5.4-mini'),
    reference: () => preCutoverGetCommitMessageModelCapability('codex' as TuiAgent, 'gpt-5.4-mini')
  },
  {
    name: 'getCommitMessageModelCapability(codex, unlisted) — dynamic ids are NOT synthesized here',
    shim: () => getCommitMessageModelCapability('codex' as TuiAgent, 'gpt-5.9-turbo'),
    reference: () => preCutoverGetCommitMessageModelCapability('codex' as TuiAgent, 'gpt-5.9-turbo')
  },
  {
    name: 'resolveCommitMessageAgentChoice(configured wins)',
    shim: () => resolveCommitMessageAgentChoice('codex' as TuiAgent, 'claude', ['codex']),
    reference: () =>
      preCutoverResolveCommitMessageAgentChoice('codex' as TuiAgent, 'claude', ['codex'])
  },
  {
    name: 'resolveCommitMessageAgentChoice(default disabled falls back to claude)',
    shim: () => resolveCommitMessageAgentChoice(null, 'codex', ['codex']),
    reference: () => preCutoverResolveCommitMessageAgentChoice(null, 'codex', ['codex'])
  },
  {
    name: 'resolveCommitMessageAgentChoice(claude disabled answers null)',
    shim: () => resolveCommitMessageAgentChoice(null, null, ['claude']),
    reference: () => preCutoverResolveCommitMessageAgentChoice(null, null, ['claude'])
  },
  {
    name: 'resolveCommitMessageAgentChoice(blank preference)',
    shim: () => resolveCommitMessageAgentChoice(null, 'blank', []),
    reference: () => preCutoverResolveCommitMessageAgentChoice(null, 'blank', [])
  },
  {
    name: 'resolveCommitMessageAgentChoice(default has no commit-message spec)',
    shim: () => resolveCommitMessageAgentChoice(null, 'grok' as TuiAgent, []),
    reference: () => preCutoverResolveCommitMessageAgentChoice(null, 'grok' as TuiAgent, [])
  },
  {
    name: 'resolveCommitMessageAgentChoice(Set roster disables nothing)',
    shim: () => resolveCommitMessageAgentChoice(null, 'codex', new Set(['codex'])),
    reference: () => preCutoverResolveCommitMessageAgentChoice(null, 'codex', new Set(['codex']))
  },
  {
    name: 'resolveCommitMessageAgentChoice(non-string configured is returned verbatim)',
    shim: () => resolveCommitMessageAgentChoice(5 as any, null, []),
    reference: () => preCutoverResolveCommitMessageAgentChoice(5 as any, null, [])
  },
  {
    name: 'resolveCommitMessageAgentChoice(non-string default answers null)',
    shim: () => resolveCommitMessageAgentChoice(null, 5 as any, []),
    reference: () => preCutoverResolveCommitMessageAgentChoice(null, 5 as any, [])
  },
  {
    name: 'resolveCommitMessageAgentChoice(prototype-key default is returned as an agent)',
    shim: () => resolveCommitMessageAgentChoice(null, 'toString' as TuiAgent, []),
    reference: () => preCutoverResolveCommitMessageAgentChoice(null, 'toString' as TuiAgent, [])
  }
]

describe('commit-message-agent-spec — the pre-ready contract', () => {
  it('answers identically unbound and bound, in the byte and the strict image', () => {
    setOrcaDispatchBinding(null)
    const unbound = CASES.map((probe) => ({
      byte: byteImage(callImage(probe.shim)),
      strict: strictImage(callImage(probe.shim))
    }))
    setOrcaDispatchBinding(wasmBinding)
    const bound = CASES.map((probe) => ({
      byte: byteImage(callImage(probe.shim)),
      strict: strictImage(callImage(probe.shim))
    }))
    expect(
      CASES.map((probe) => probe.name).filter(
        (_, index) =>
          unbound[index].byte !== bound[index].byte || unbound[index].strict !== bound[index].strict
      )
    ).toEqual([])
  })

  it('the shipped fallback is still the body Orca shipped before the cutover', () => {
    setOrcaDispatchBinding(null)
    const drifted = CASES.filter(
      (probe) => strictImage(callImage(probe.shim)) !== strictImage(callImage(probe.reference))
    ).map((probe) => probe.name)
    setOrcaDispatchBinding(wasmBinding)
    expect(drifted).toEqual([])
  })

  it('the exported fallback table is the same code the shim falls back to', () => {
    // Not a tautology: the table is what the two suites compare against, so a
    // shim that fell back to something else would still look self-consistent.
    setOrcaDispatchBinding(null)
    const table = COMMIT_MESSAGE_AGENT_SPEC_LOOKUP_FALLBACKS
    expect(byteImage(callImage(() => table.listCommitMessageAgentIds()))).toBe(
      byteImage(callImage(() => listCommitMessageAgentIds()))
    )
    expect(byteImage(callImage(() => table.getCommitMessageModel('codex' as TuiAgent, 'zz')))).toBe(
      byteImage(callImage(() => getCommitMessageModel('codex' as TuiAgent, 'zz')))
    )
    expect(
      byteImage(callImage(() => table.resolveCommitMessageAgentChoice(null, 'codex', ['codex'])))
    ).toBe(byteImage(callImage(() => resolveCommitMessageAgentChoice(null, 'codex', ['codex']))))
    setOrcaDispatchBinding(wasmBinding)
  })

  it('reaches every one of the seven arms by name', () => {
    const reached: string[] = []
    setOrcaDispatchBinding((module, fn, inputJson) => {
      if (module === 'commit-message-agent-spec') {
        reached.push(fn)
      }
      return orcaDispatch(module, fn, inputJson)
    })
    for (const probe of CASES) {
      callImage(probe.shim)
    }
    expect([...new Set(reached)].sort()).toEqual([
      'getCommitMessageAgentCapability',
      'getCommitMessageModel',
      'getCommitMessageModelCapability',
      'isCustomAgentId',
      'listCommitMessageAgentCapabilities',
      'listCommitMessageAgentIds',
      'resolveCommitMessageAgentChoice'
    ])
  })

  it('a core that lies is caught, so a clean result is not vacuous', () => {
    setOrcaDispatchBinding((module, fn, inputJson) =>
      module === 'commit-message-agent-spec' && fn === 'listCommitMessageAgentIds'
        ? JSON.stringify(['claude'])
        : orcaDispatch(module, fn, inputJson)
    )
    expect(byteImage(callImage(() => listCommitMessageAgentIds()))).not.toBe(
      byteImage(callImage(() => preCutoverListCommitMessageAgentIds()))
    )
  })
})

describe('the declared residuals are real differences, not defensive guards', () => {
  // Each case calls the arm DIRECTLY. If the core agreed with the twin, the
  // refusal above the seam would be dead weight and this test would say so.
  it('1. a prototype-chain agent id: the twin dereferences Object.prototype', () => {
    expect(rawCore('getCommitMessageAgentCapability', { agentId: 'toString' })).toBeNull()
    expect(() => preCutoverGetCommitMessageAgentCapability('toString' as TuiAgent)).toThrow(
      TypeError
    )
    // and the shim keeps the twin's answer, crash included
    expect(() => getCommitMessageAgentCapability('toString' as TuiAgent)).toThrow(TypeError)
  })

  it('2. a non-string agent id is COERCED into a registry key by the twin', () => {
    expect(rawCore('getCommitMessageModel', { agentId: ['claude'], modelId: 'haiku' })).toBeNull()
    expect(getCommitMessageModel(['claude'] as any, 'haiku')).toEqual({
      id: 'haiku',
      label: 'Haiku'
    })
  })

  it('3. a non-string model id crashes the twin on a dynamic agent', () => {
    expect(rawCore('getCommitMessageModel', { agentId: 'codex', modelId: 5 })).toBeNull()
    expect(() => getCommitMessageModel('codex' as TuiAgent, 5 as any)).toThrow(TypeError)
    // …but NOT on a static one, where the catalog scan misses and returns first
    expect(getCommitMessageModel('claude' as TuiAgent, 5 as any)).toBeUndefined()
  })

  it('4. a truthy non-string preference: the twin returns one and refuses the other', () => {
    expect(rawCore('resolveCommitMessageAgentChoice', { configuredAgentId: 5 })).toBe('claude')
    expect(resolveCommitMessageAgentChoice(5 as any, null, [])).toBe(5)
    expect(rawCore('resolveCommitMessageAgentChoice', { defaultTuiAgent: 5 })).toBe('claude')
    expect(resolveCommitMessageAgentChoice(null, 5 as any, [])).toBeNull()
  })

  it('5. a lone surrogate in a model id cannot be encoded at all', () => {
    expect(() =>
      orcaDispatch(
        'commit-message-agent-spec',
        'getCommitMessageModel',
        '{"agentId":"codex","modelId":"\\ud800"}'
      )
    ).not.toThrow()
    // The codec refuses before the call, so the shim answers from the body.
    expect(getCommitMessageModel('codex' as TuiAgent, '\ud800')).toEqual({
      id: '\ud800',
      label: '\ud800'
    })
  })
})

describe('getCommitMessageAgentSpec cannot be routed', () => {
  it('has no arm, and asking for one is an error rather than an answer', () => {
    const envelope = rawCore('getCommitMessageAgentSpec', { agentId: 'claude' }) as Record<
      string,
      unknown
    >
    expect(envelope.__parity_error__).toBe('unknown function getCommitMessageAgentSpec')
    // Through the real decoder that is a throw, never a value, so a shim over it
    // could not degrade quietly either.
    expect(() =>
      decodeDispatchResult(
        orcaDispatch(
          'commit-message-agent-spec',
          'getCommitMessageAgentSpec',
          JSON.stringify({ agentId: 'claude' })
        )
      )
    ).toThrow(DispatchCoreError)
  })

  it('its answer carries two closures that JSON deletes', () => {
    const codex = getCommitMessageAgentSpec('codex' as TuiAgent)!
    expect(typeof codex.buildArgs).toBe('function')
    expect(typeof codex.modelDiscovery?.parse).toBe('function')
    const crossedImage = JSON.parse(JSON.stringify(codex)) as Record<string, unknown>
    expect('buildArgs' in crossedImage).toBe(false)
    expect(Object.keys(crossedImage.modelDiscovery as object)).toEqual(['binary', 'args'])
    // Both are CALLED — `modelDiscovery.parse` on the production discovery path
    // and `buildArgs` by this module's suite — so the loss is not cosmetic.
    expect(
      codex.modelDiscovery!.parse('{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5"}]}')
    ).toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5' }])
    expect(codex.buildArgs({ prompt: '', model: 'gpt-5.5' })).toContain('--model')
  })

  it('and reference identity, which a per-call crossing cannot hold', () => {
    for (const id of Object.keys(COMMIT_MESSAGE_AGENT_SPECS) as TuiAgent[]) {
      expect(getAgentModelProbeSpec(id)).toBe(getCommitMessageAgentSpec(id))
      expect(getCommitMessageAgentSpec(id)).toBe(COMMIT_MESSAGE_AGENT_SPECS[id])
    }
  })
})
