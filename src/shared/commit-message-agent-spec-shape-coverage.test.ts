// The `commit-message-agent-spec` cutover, measured over the COMPLETE cross
// product of its named input cells, four evaluations per input.
//
// FOUR, not two. HEAD's twin and the shim, each with the seam unbound and again
// bound to the SHIPPED wasm core:
//   1. reference unbound  — the bodies Orca shipped before the cutover
//   2. shim unbound       — the shim's pre-ready fallback
//   3. reference bound    — the pre-cutover bodies with the seam live, which is
//                           not a no-op: `resolveCommitMessageAgentChoice` calls
//                           `isTuiAgentEnabled`, itself already a shim
//   4. shim bound         — the Rust core
// A twin-vs-core differential compares 1 against 4 and says NOTHING about the
// fallback, which is a fourth implementation the moment anyone edits it. That is
// exactly how the source-control-ai cutover shipped a fallback missing a `?? false`
// landed an hour earlier: only the reference-unbound vs shim-unbound pair sees it.
//
// THREE IMAGES, REPORTED SEPARATELY, because they catch different classes: VALUE
// (keys sorted, own-`undefined` dropped) is what every consumer reads, BYTE
// (`JSON.stringify`) adds key order, and STRICT adds own-`undefined` vs absent.
// A single "equal" verdict hides which one moved. They are not decorative: a
// planted key-order swap moves BYTE and STRICT with VALUE at 0, and a planted
// own-`undefined` key moves STRICT alone.
//
// WHAT THIS DOES NOT COVER, named rather than left implicit:
//  * Model ids outside the 90 atoms and their 925 compositions. The id space is
//    infinite; the atoms are one per branch of `labelFromModelId`,
//    `withOpenAiThinking` and the JS trim set, and the compositions glue each
//    atom to the six affixes on both sides. NOT covered: three-or-more-atom
//    compositions, and any atom class nobody has named yet.
//  * Disabled rosters beyond the 16 named shapes — 2^34 subsets of the agent
//    catalog, times their orderings and duplicates. The ARGUMENT (an argument,
//    not a proof) is that both sides reduce the roster to set membership against
//    a fixed catalog and this export only ever asks about two ids
//    (`defaultTuiAgent` and `claude`), so all four containment combinations are
//    already cells.
//  * Prototype-chain agent ids beyond the eight named — `__defineGetter__`,
//    `__lookupSetter__`, `toSource` and friends. Same class as `toString`: the
//    registry read has exactly three outcomes (own key, inherited key, absent)
//    and all three are cells.
//  * `configuredAgentId` / `defaultTuiAgent` strings outside the 12 and 13 named.
//  * A model carrying `isDefault`. No registry row sets it and no arm emits it;
//    it only arises on DISCOVERED models, which reach the UI through
//    `commit-message-models`, not through these seven.
//  * The napi addon. These suites bind the wasm blob; the natively built crate is
//    covered by the `pnpm parity` corpus leg instead, and the shipped napi binary
//    by `pnpm parity`'s vitest leg for the modules that reach it through main.
//  * Rebinding the seam mid-call, and concurrent callers.
import { afterAll, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import {
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
  preCutoverGetCommitMessageAgentSpec,
  preCutoverGetCommitMessageModel,
  preCutoverGetCommitMessageModelCapability,
  preCutoverIsCustomAgentId,
  preCutoverListCommitMessageAgentCapabilities,
  preCutoverListCommitMessageAgentIds,
  preCutoverResolveCommitMessageAgentChoice
} from './commit-message-agent-spec-pre-cutover-lookups'
import {
  AGENT_ID_CELLS,
  byteImage,
  callImage,
  COMPOSED_MODEL_ID_CELLS,
  CONFIGURED_AGENT_CELLS,
  DEFAULT_AGENT_CELLS,
  DISABLED_CELLS,
  DISCOVERY_STDOUT_CELLS,
  MODEL_ID_CELLS,
  CUSTOM_SENTINEL_CELLS,
  strictImage,
  valueImage
} from './commit-message-agent-spec-shape-fixtures'
import { setOrcaDispatchBinding, type OrcaDispatchFn } from './orca-dispatch-seam'
import type { TuiAgent } from './types'

const wasmBinding: OrcaDispatchFn = (module, fn, inputJson) => orcaDispatch(module, fn, inputJson)

afterAll(() => setOrcaDispatchBinding(wasmBinding))

/* eslint-disable @typescript-eslint/no-explicit-any -- Why: a cell is untyped by
   construction; the runtime guards are the subject of the measurement, so the
   arguments must be handed over unnarrowed. */
type Probe = { name: string; reference: () => unknown; shim: () => unknown }

/** Every input, as a pair of calls that differ only in which implementation runs. */
function probes(): Probe[] {
  const list: Probe[] = []
  list.push({
    name: 'listCommitMessageAgentIds()',
    reference: () => preCutoverListCommitMessageAgentIds(),
    shim: () => listCommitMessageAgentIds()
  })
  list.push({
    name: 'listCommitMessageAgentCapabilities()',
    reference: () => preCutoverListCommitMessageAgentCapabilities(),
    shim: () => listCommitMessageAgentCapabilities()
  })
  for (const id of CUSTOM_SENTINEL_CELLS) {
    list.push({
      name: `isCustomAgentId[${id.name}]`,
      reference: () => preCutoverIsCustomAgentId(id.value as any),
      shim: () => isCustomAgentId(id.value as any)
    })
  }
  for (const agent of AGENT_ID_CELLS) {
    list.push({
      name: `getCommitMessageAgentCapability[${agent.name}]`,
      reference: () => preCutoverGetCommitMessageAgentCapability(agent.value as any),
      shim: () => getCommitMessageAgentCapability(agent.value as any)
    })
    for (const model of MODEL_ID_CELLS) {
      list.push({
        name: `getCommitMessageModel[${agent.name}][${model.name}]`,
        reference: () => preCutoverGetCommitMessageModel(agent.value as any, model.value as any),
        shim: () => getCommitMessageModel(agent.value as any, model.value as any)
      })
      list.push({
        name: `getCommitMessageModelCapability[${agent.name}][${model.name}]`,
        reference: () =>
          preCutoverGetCommitMessageModelCapability(agent.value as any, model.value as any),
        shim: () => getCommitMessageModelCapability(agent.value as any, model.value as any)
      })
    }
  }
  for (const configured of CONFIGURED_AGENT_CELLS) {
    for (const preferred of DEFAULT_AGENT_CELLS) {
      for (const disabled of DISABLED_CELLS) {
        const name = `resolveCommitMessageAgentChoice[${configured.name}][${preferred.name}][${disabled.name}]`
        list.push({
          name,
          reference: () =>
            preCutoverResolveCommitMessageAgentChoice(
              configured.value as any,
              preferred.value as any,
              disabled.value as any
            ),
          shim: () =>
            resolveCommitMessageAgentChoice(
              configured.value as any,
              preferred.value as any,
              disabled.value as any
            )
        })
      }
    }
  }
  return list
}

type Images = { byte: string; value: string; strict: string }

function images(call: () => unknown): Images {
  const answer = callImage(call)
  return { byte: byteImage(answer), value: valueImage(answer), strict: strictImage(answer) }
}

type Leg = 'referenceUnbound' | 'shimUnbound' | 'referenceBound' | 'shimBound'
type Row = { name: string; legs: Record<Leg, Images>; crossed: string[] }

function sweep(): Row[] {
  const all = probes()
  setOrcaDispatchBinding(null)
  const unbound = all.map((probe) => ({
    referenceUnbound: images(probe.reference),
    shimUnbound: images(probe.shim)
  }))
  // A counting binding on the bound leg, so every row records whether the shim
  // actually reached the core for THAT input. Without it, "0 mismatches" is
  // equally true of a shim that crossed nothing.
  let reached: string[] = []
  setOrcaDispatchBinding((module, fn, inputJson) => {
    if (module === 'commit-message-agent-spec') {
      reached.push(fn)
    }
    return orcaDispatch(module, fn, inputJson)
  })
  const rows = all.map((probe, index) => {
    const referenceBound = images(probe.reference)
    reached = []
    const shimBound = images(probe.shim)
    return {
      name: probe.name,
      legs: { ...unbound[index], referenceBound, shimBound },
      crossed: reached
    }
  })
  setOrcaDispatchBinding(wasmBinding)
  return rows
}

/** The cells the shim REFUSES to cross, derived from the residual list in
 *  `commit-message-agent-spec.ts` and applied to a row's own cell names. */
function expectedToCross(name: string): boolean {
  const agentRefused = /\[(prototype-key|non-string):/.test(name.split('][')[0] ?? name)
  if (name.startsWith('getCommitMessageModel[') || name.startsWith('getCommitMessageModelCap')) {
    const model = name.split('][')[1] ?? ''
    // `surrogate:escape-text` is the six ASCII characters `\ud800`, which encode
    // fine; only a real lone code unit is refused by the codec.
    return !agentRefused && !/^(non-string:|surrogate:lone-)/.test(model)
  }
  if (name.startsWith('getCommitMessageAgentCapability[')) {
    return !agentRefused
  }
  if (name.startsWith('isCustomAgentId[')) {
    return !name.includes('[lone-surrogate]')
  }
  if (name.startsWith('resolveCommitMessageAgentChoice[')) {
    const [, configured = '', preferred = ''] = name.split('[')
    return !configured.startsWith('non-string:') && !/^(non-string:|prototype-key)/.test(preferred)
  }
  return true
}

const PAIRS: [Leg, Leg][] = [
  ['referenceUnbound', 'shimUnbound'],
  ['referenceUnbound', 'referenceBound'],
  ['referenceBound', 'shimBound'],
  ['shimUnbound', 'shimBound']
]

describe('commit-message-agent-spec — the four-way shape sweep', () => {
  const rows = sweep()

  it('runs the complete cross product of the named cells', () => {
    // 2 nullary + |sentinel| + |agent| x (1 + 2 x |model|) + |configured| x |default| x |disabled|
    const expected =
      2 +
      CUSTOM_SENTINEL_CELLS.length +
      AGENT_ID_CELLS.length * (1 + 2 * MODEL_ID_CELLS.length) +
      CONFIGURED_AGENT_CELLS.length * DEFAULT_AGENT_CELLS.length * DISABLED_CELLS.length
    expect(rows.length).toBe(expected)
    expect(rows.length).toBeGreaterThan(7000)
    // Four evaluations each, so the measurement is 4x this.
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length)
  })

  for (const [left, right] of PAIRS) {
    it(`${left} vs ${right} — byte, value and strict`, () => {
      const counts = { byte: 0, value: 0, strict: 0 }
      const examples: string[] = []
      for (const row of rows) {
        for (const image of ['byte', 'value', 'strict'] as const) {
          if (row.legs[left][image] !== row.legs[right][image]) {
            counts[image] += 1
            if (examples.length < 5 && image === 'strict') {
              examples.push(
                `${row.name}\n  ${left}=${row.legs[left][image]}\n  ${right}=${row.legs[right][image]}`
              )
            }
          }
        }
      }
      // Every pair must be identical in all three images: the shim declares
      // `parity`, the fallback is HEAD's body, and the refusals above the seam
      // are exactly the inputs the core models differently.
      expect({ pair: `${left} vs ${right}`, ...counts, examples }).toEqual({
        pair: `${left} vs ${right}`,
        byte: 0,
        value: 0,
        strict: 0,
        examples: []
      })
    })
  }

  it('reaches all seven arms by name, and never the unrouted eighth', () => {
    // A pair-equality result is vacuous if the shim never crossed.
    const byFunction = new Map<string, number>()
    for (const row of rows) {
      for (const fn of row.crossed) {
        byFunction.set(fn, (byFunction.get(fn) ?? 0) + 1)
      }
    }
    expect([...byFunction.keys()].sort()).toEqual([
      'getCommitMessageAgentCapability',
      'getCommitMessageModel',
      'getCommitMessageModelCapability',
      'isCustomAgentId',
      'listCommitMessageAgentCapabilities',
      'listCommitMessageAgentIds',
      'resolveCommitMessageAgentChoice'
    ])
    // `getCommitMessageAgentSpec` must never appear: there is no arm for it, and
    // its answer carries two closures JSON cannot express.
    expect(byFunction.has('getCommitMessageAgentSpec')).toBe(false)
  })

  it('crosses exactly the cells the residual list says it should', () => {
    // NAMES the cells answered locally, so a shim that silently stopped crossing
    // a whole class — or started crossing one it must refuse — goes red instead
    // of quietly agreeing with itself.
    const wronglyLocal = rows.filter((row) => expectedToCross(row.name) && row.crossed.length === 0)
    const wronglyCrossed = rows.filter(
      (row) => !expectedToCross(row.name) && row.crossed.length > 0
    )
    expect({
      wronglyLocal: wronglyLocal.slice(0, 5).map((row) => row.name),
      wronglyCrossed: wronglyCrossed.slice(0, 5).map((row) => row.name)
    }).toEqual({ wronglyLocal: [], wronglyCrossed: [] })
    // The split is reported, not averaged away: the refused side is dominated by
    // the fourteen hostile agent-id cells (eight prototype keys, six non-strings)
    // multiplied across the model axis, which is a property of how the axis was
    // built, not of how much of the real product runs on Rust.
    expect({
      rows: rows.length,
      crossed: rows.filter((row) => row.crossed.length > 0).length
    }).toEqual({
      rows: rows.length,
      crossed: rows.filter((row) => expectedToCross(row.name)).length
    })
  })

  it('a planted wrong core answer fails the differential', () => {
    // Why: two of this session's probes passed against unfixed cores by being
    // malformed. If the harness cannot see a deliberate lie, a clean result from
    // it means nothing.
    setOrcaDispatchBinding((module, fn, inputJson) =>
      module === 'commit-message-agent-spec' && fn === 'getCommitMessageModel'
        ? JSON.stringify({ id: 'planted', label: 'Planted' })
        : orcaDispatch(module, fn, inputJson)
    )
    const planted = images(() => getCommitMessageModel('claude' as TuiAgent, 'haiku'))
    setOrcaDispatchBinding(wasmBinding)
    const honest = images(() => getCommitMessageModel('claude' as TuiAgent, 'haiku'))
    expect(planted.byte).not.toBe(honest.byte)
    expect(planted.value).not.toBe(honest.value)
    expect(planted.strict).not.toBe(honest.strict)
  })
})

describe('composed model ids — the label/thinking/trim derivation', () => {
  // `labelFromModelId` splits on `/` and `-` and then branches per part, and
  // `withOpenAiThinking` matches a substring, so the interesting cases are atoms
  // GLUED to separators and to family markers. Only the export that reads the
  // id's text runs here, across every agent whose registry row differs.
  const agents = [
    ...Object.keys(COMMIT_MESSAGE_AGENT_SPECS),
    'grok',
    'aider',
    'gemini'
  ] as TuiAgent[]

  it('agrees in all three images, unbound and bound, twin and shim', () => {
    let referenceUnbound: Images[] = []
    let shimUnbound: Images[] = []
    setOrcaDispatchBinding(null)
    for (const agentId of agents) {
      for (const model of COMPOSED_MODEL_ID_CELLS) {
        referenceUnbound.push(images(() => preCutoverGetCommitMessageModel(agentId, model.value)))
        shimUnbound.push(images(() => getCommitMessageModel(agentId, model.value)))
      }
    }
    // The same vacuity guard as the main product: count the crossings per row, so
    // "0 mismatches" cannot be true of a sweep that never reached the core.
    let reached = 0
    let crossedRows = 0
    setOrcaDispatchBinding((module, fn, inputJson) => {
      if (module === 'commit-message-agent-spec') {
        reached += 1
      }
      return orcaDispatch(module, fn, inputJson)
    })
    const mismatches: string[] = []
    const counts = { byte: 0, value: 0, strict: 0 }
    let index = 0
    for (const agentId of agents) {
      for (const model of COMPOSED_MODEL_ID_CELLS) {
        const referenceBound = images(() => preCutoverGetCommitMessageModel(agentId, model.value))
        reached = 0
        const shimBound = images(() => getCommitMessageModel(agentId, model.value))
        crossedRows += reached > 0 ? 1 : 0
        for (const image of ['byte', 'value', 'strict'] as const) {
          const legs = [
            referenceUnbound[index][image],
            shimUnbound[index][image],
            referenceBound[image],
            shimBound[image]
          ]
          if (new Set(legs).size !== 1) {
            counts[image] += 1
            if (mismatches.length < 5) {
              mismatches.push(`${agentId}[${model.name}] ${legs.join(' | ')}`)
            }
          }
        }
        index += 1
      }
    }
    setOrcaDispatchBinding(wasmBinding)
    referenceUnbound = []
    shimUnbound = []
    expect({ compared: index, ...counts, mismatches }).toEqual({
      compared: agents.length * COMPOSED_MODEL_ID_CELLS.length,
      byte: 0,
      value: 0,
      strict: 0,
      mismatches: []
    })
    expect(index).toBeGreaterThan(9000)
    // Every composed id is a string on a registry-safe agent, so the only rows
    // answered locally are the ones carrying a lone UTF-16 surrogate.
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    expect(crossedRows).toBe(
      agents.length * COMPOSED_MODEL_ID_CELLS.filter((c) => !loneSurrogate.test(c.value)).length
    )
    expect(crossedRows).toBeGreaterThan(10_000)
  })
})

describe('the unrouted accessor still delivers the Rust-backed discovery parser', () => {
  // `getCommitMessageAgentSpec` stays in TypeScript, so the axis it owns — raw
  // agent-CLI stdout, reached through `modelDiscovery.parse` — is measured here
  // rather than declared out of scope. The parsers themselves are the already
  // cut-over `commit-message-models` shims, so this checks the accessor hands
  // out the shim (not a stale local copy) and that its answer is the same before
  // and after wasm is ready.
  const dynamicAgents = ['codex', 'opencode', 'pi', 'cursor', 'antigravity'] as TuiAgent[]

  it('parses identically unbound and bound, through both accessors', () => {
    const rows: { name: string; unbound: string; bound: string; reference: string }[] = []
    setOrcaDispatchBinding(null)
    for (const agentId of dynamicAgents) {
      const parse = getCommitMessageAgentSpec(agentId)?.modelDiscovery?.parse
      const referenceParse = preCutoverGetCommitMessageAgentSpec(agentId)?.modelDiscovery?.parse
      expect(parse).toBe(referenceParse)
      for (const stdout of DISCOVERY_STDOUT_CELLS) {
        rows.push({
          name: `${agentId}[${stdout.name}]`,
          unbound: byteImage(callImage(() => parse!(stdout.value))),
          bound: '',
          reference: byteImage(callImage(() => referenceParse!(stdout.value)))
        })
      }
    }
    setOrcaDispatchBinding(wasmBinding)
    let index = 0
    for (const agentId of dynamicAgents) {
      const parse = getCommitMessageAgentSpec(agentId)!.modelDiscovery!.parse
      for (const stdout of DISCOVERY_STDOUT_CELLS) {
        rows[index].bound = byteImage(callImage(() => parse(stdout.value)))
        index += 1
      }
    }
    expect(rows.length).toBe(dynamicAgents.length * DISCOVERY_STDOUT_CELLS.length)
    expect(rows.filter((row) => row.unbound !== row.bound)).toEqual([])
    expect(rows.filter((row) => row.unbound !== row.reference)).toEqual([])
  })
})
