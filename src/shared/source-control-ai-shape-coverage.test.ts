// SHAPE-ENUMERATED differential for the fifteen `source-control-ai` exports: the
// TypeScript fallback (seam UNBOUND) against the Rust core (seam BOUND), over a
// cross product of NAMED input shapes rather than a pile of generated calls.
//
// WHY NOT A CALL COUNT. Three cutover attempts on this module each reported a
// clean headline over tens of thousands of calls and an independent rerun refuted
// each one. The failure was structural, not careless: a fifteen-export module has
// a shape space where a six-figure sample still misses an entire input SHAPE, and
// a large denominator reads as exhaustive. So this file enumerates the axes
// (`source-control-ai-{settings,repo,operation}-shape-fixtures.ts`), takes cross
// products of them, and asserts by CLASS — the path list at the bottom of the
// sweep — so a new kind of divergence fails instead of joining an average.
//
// THREE IMAGES, nested by strictness, because one number hides the classes:
//   value  — keys sorted, own-`undefined` dropped. What every `?.` read sees.
//   byte   — `JSON.stringify`. Adds KEY ORDER: what a settings file and a raw
//            `JSON.stringify` comparison carry.
//   strict — key order AND own-`undefined` distinguished from absent.
// value-mismatch is a subset of byte, which is a subset of strict, so the three
// counts separate "different answer" from "same answer spelled differently".
//
// THE CONTROLS AT THE BOTTOM ARE NOT DECORATION. A differential that cannot fail
// proves nothing, so two inputs whose sides MUST differ are asserted to be
// reported: one that differs by VALUE (a blob the core substitutes a default for,
// driven through the raw arm) and one that differs by BYTE only (the key-order
// class). If either stops differing, the comparators have gone blind.
//
// COVERAGE, STATED RATHER THAN IMPLIED. Axis sizes are 82 (`settings.sourceControlAi`)
// x 52 (`settings.commitMessageAi`) x 57 (`repo.sourceControlAi`), plus 3 operations,
// 8 action ids, 4 discovery hosts, 6 PR-creation product defaults, 12 agent
// environments, 18 model choices and 5 merge option shapes. Summed per export, the
// unrestricted product is 215,128,305 cells. Under `SCA_SHAPE_FULL=1` FOURTEEN of the
// fifteen exports run 100% of their own product; the fifteenth,
// `resolveSourceControlAiForOperation`, has a 209,993,472-cell product and runs
// 2,640,222 of it: the complete blob triple x every operation x {local, a host WITH a
// recorded choice, a host WITHOUT one} at the default agent environment and no product
// defaults, plus the core 18x13x15 cube against every agent environment, every product
// default and an ABSENT `discoveryHostKey`.
//
// SO WHAT IS NOT COVERED, by name: for `resolveSourceControlAiForOperation` only, a
// NON-core `sourceControlAi`/`commitMessageAi`/`repo` cell meeting a non-default
// `prCreationProductDefaults`, a non-`codex` agent environment, or an absent
// `discoveryHostKey`. Those three axes are read by code that never touches the two
// blobs — `resolvePrCreationDefaults` (whose OWN complete product IS covered here),
// `collapseDefaultTuiAgentToBuiltin` / `resolveCommitMessageAgentChoice`, and
// `agentCmdOverrides?.[id]` — and an absent `discoveryHostKey` is exactly the covered
// `'local'`. That is the argument for the omission; it is not a proof.
//
// Set `SCA_SHAPE_FULL=1` to run the COMPLETE settings x legacy x repo product
// (82 x 52 x 57) instead of the default design; that is the ~7.8M-case run.
import { describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { setOrcaDispatchBinding, type OrcaDispatchFn } from './orca-dispatch-seam'
import {
  ACTION_IDS,
  AGENT_ENVS,
  AGENT_IDS,
  CHOICE_CELLS,
  HOST_KEYS,
  OPERATIONS,
  PRODUCT_DEFAULTS
} from './source-control-ai-operation-shape-fixtures'
import {
  buildRepo,
  populatedRepo,
  REPO_CORE,
  REPO_FULL,
  REPO_NON_RECORD,
  type RepoCell
} from './source-control-ai-repo-shape-fixtures'
import {
  buildSettings,
  LEGACY_CORE,
  LEGACY_FULL,
  populatedSca,
  SCA_CORE,
  SCA_FULL,
  type Cell,
  type OptionalValue
} from './source-control-ai-settings-shape-fixtures'
import * as sourceControlAi from './source-control-ai'

/* eslint-disable @typescript-eslint/no-explicit-any -- Why: a shape cell is
   untyped by construction; the module's own runtime guards are the subject. */
type Api = Record<string, (...args: any[]) => unknown>
const API = sourceControlAi as unknown as Api

const wasmBinding: OrcaDispatchFn = (module, fn, inputJson) => orcaDispatch(module, fn, inputJson)
const FULL = process.env.SCA_SHAPE_FULL === '1'

type Answer = { threw: false; value: unknown } | { threw: true; message: string }

function evaluate(run: () => unknown): Answer {
  try {
    return { threw: false, value: run() }
  } catch (error) {
    return { threw: true, message: String((error as Error)?.message ?? error) }
  }
}

function strictEncode(value: unknown): string {
  if (value === undefined) {
    return 'U'
  }
  if (value === null) {
    return 'N'
  }
  if (Array.isArray(value)) {
    return `[${value.map(strictEncode).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .map((key) => `${JSON.stringify(key)}:${strictEncode(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'X'
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortDeep(record[key])])
  )
}

function image(answer: Answer, kind: 'value' | 'byte' | 'strict'): string {
  if (answer.threw) {
    return `throw:${answer.message}`
  }
  if (kind === 'strict') {
    return strictEncode(answer.value)
  }
  if (answer.value === undefined) {
    return 'U'
  }
  return JSON.stringify(kind === 'value' ? sortDeep(answer.value) : answer.value) ?? 'X'
}

/** Exactly which key paths differ, and whether by own-`undefined`, ORDER or VALUE. */
function classify(left: unknown, right: unknown, path: string, out: string[]): void {
  if (left === right) {
    return
  }
  const isRecord = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (isRecord(left) && isRecord(right)) {
    const l = left as Record<string, unknown>
    const r = right as Record<string, unknown>
    for (const key of Object.keys(l)) {
      if (!(key in r)) {
        out.push(`${l[key] === undefined ? 'ownUndefinedOnlyTs' : 'keyOnlyTs'}:${path}.${key}`)
      }
    }
    for (const key of Object.keys(r)) {
      if (!(key in l)) {
        out.push(`${r[key] === undefined ? 'ownUndefinedOnlyRust' : 'keyOnlyRust'}:${path}.${key}`)
      }
    }
    const shared = Object.keys(l).filter((key) => key in r)
    if (
      shared.join(',') !==
      Object.keys(r)
        .filter((key) => key in l)
        .join(',')
    ) {
      out.push(`keyOrder:${path}`)
    }
    for (const key of shared) {
      classify(l[key], r[key], `${path}.${key}`, out)
    }
    return
  }
  if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
    left.forEach((item, index) => classify(item, right[index], `${path}[${index}]`, out))
    return
  }
  out.push(`value:${path}`)
}

const totals = { cases: 0, crossed: 0, value: 0, byte: 0, strict: 0 }
const paths: Record<string, number> = {}
const valueMismatches: string[] = []
const perExport: Record<string, { cases: number; crossed: number; byte: number; strict: number }> =
  {}

let crossedThisCase = 0
const countingBinding: OrcaDispatchFn = (module, fn, inputJson) => {
  if (module === 'source-control-ai') {
    crossedThisCase += 1
  }
  return wasmBinding(module, fn, inputJson)
}

function emit(name: string, cell: string, run: (api: Api) => unknown): void {
  const entry = (perExport[name] ??= { cases: 0, crossed: 0, byte: 0, strict: 0 })
  entry.cases += 1
  totals.cases += 1

  setOrcaDispatchBinding(null)
  const unbound = evaluate(() => run(API))
  crossedThisCase = 0
  setOrcaDispatchBinding(countingBinding)
  const bound = evaluate(() => run(API))
  setOrcaDispatchBinding(wasmBinding)
  if (crossedThisCase > 0) {
    entry.crossed += 1
    totals.crossed += 1
  }

  if (image(unbound, 'strict') === image(bound, 'strict')) {
    return
  }
  entry.strict += 1
  totals.strict += 1
  if (image(unbound, 'byte') !== image(bound, 'byte')) {
    entry.byte += 1
    totals.byte += 1
  }
  if (image(unbound, 'value') !== image(bound, 'value')) {
    totals.value += 1
    if (valueMismatches.length < 20) {
      valueMismatches.push(
        `${name} @ ${cell}\n  ts:   ${image(unbound, 'value')}\n  rust: ${image(bound, 'value')}`
      )
    }
  }
  const out: string[] = []
  if (unbound.threw || bound.threw) {
    out.push(`throw:${image(unbound, 'strict')}|${image(bound, 'strict')}`)
  } else {
    classify(unbound.value, bound.value, '$', out)
  }
  for (const path of out) {
    paths[path] = (paths[path] ?? 0) + 1
  }
}

type Triple = { sca: Cell<OptionalValue>; legacy: Cell<OptionalValue>; repo: Cell<RepoCell> }

function product(
  scas: readonly Cell<OptionalValue>[],
  legacies: readonly Cell<OptionalValue>[],
  repos: readonly Cell<RepoCell>[]
): Triple[] {
  const out: Triple[] = []
  for (const sca of scas) {
    for (const legacy of legacies) {
      for (const repo of repos) {
        out.push({ sca, legacy, repo })
      }
    }
  }
  return out
}

function tripleKey(triple: Triple): string {
  return `${triple.sca.key}|${triple.legacy.key}|${triple.repo.key}`
}

/** Default: every single-axis cell against a representative pair, plus the whole
 *  core-by-core-by-core cube. `SCA_SHAPE_FULL=1`: the complete product. */
function designedTriples(): Triple[] {
  if (FULL) {
    return product(SCA_FULL, LEGACY_FULL, REPO_FULL)
  }
  const repSca = [SCA_FULL[4]]
  const repLegacy = [LEGACY_FULL[4]]
  const repRepo = [REPO_FULL[6]]
  const seen = new Set<string>()
  const out: Triple[] = []
  for (const triple of [
    ...product(SCA_FULL, repLegacy, repRepo),
    ...product(repSca, LEGACY_FULL, repRepo),
    ...product(repSca, repLegacy, REPO_FULL),
    ...product(SCA_CORE, LEGACY_CORE, REPO_CORE)
  ]) {
    const key = tripleKey(triple)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(triple)
  }
  return out
}

const TRIPLES = designedTriples()
const CORE_TRIPLES = product(SCA_CORE, LEGACY_CORE, REPO_CORE)

function callArgs(triple: Triple, env: Record<string, unknown> = {}) {
  const repoCell = triple.repo.make()
  return {
    settings: buildSettings(triple.sca.make(), triple.legacy.make(), env),
    repoArg: buildRepo(repoCell),
    repoPresent: repoCell.repoPresent
  }
}

function withRepo(base: Record<string, unknown>, repoArg: unknown, present: boolean): any {
  return present ? { ...base, repo: repoArg } : base
}

describe('source-control-ai shape-enumerated TS-vs-Rust differential', () => {
  it(
    'agrees by VALUE on every enumerated shape, and the seam is really reached',
    () => {
      emit('getDefaultSourceControlAiSettings', 'only', (api) =>
        api.getDefaultSourceControlAiSettings()
      )

      for (const cell of REPO_FULL) {
        if (!cell.make().scaPresent) {
          continue
        }
        emit('normalizeRepoSourceControlAiOverrides', cell.key, (api) =>
          api.normalizeRepoSourceControlAiOverrides(cell.make().value)
        )
      }
      for (const cell of REPO_NON_RECORD) {
        emit('normalizeRepoSourceControlAiOverrides', cell.key, (api) =>
          api.normalizeRepoSourceControlAiOverrides(cell.make())
        )
      }

      for (const legacy of LEGACY_FULL) {
        emit('sourceControlAiSettingsFromLegacy', legacy.key, (api) =>
          api.sourceControlAiSettingsFromLegacy(legacy.make().value)
        )
      }

      // The two settings-blob exports take the COMPLETE settings x legacy product
      // in both modes; it is only 4,264 cells.
      for (const sca of SCA_FULL) {
        for (const legacy of LEGACY_FULL) {
          const key = `${sca.key}|${legacy.key}`
          emit('normalizeSourceControlAiSettings', key, (api) => {
            const l = legacy.make()
            return l.present
              ? api.normalizeSourceControlAiSettings(sca.make().value, l.value)
              : api.normalizeSourceControlAiSettings(sca.make().value)
          })
          emit('projectSourceControlAiToLegacyCommitMessageAi', key, (api) => {
            const l = legacy.make()
            return l.present
              ? api.projectSourceControlAiToLegacyCommitMessageAi(sca.make().value, l.value)
              : api.projectSourceControlAiToLegacyCommitMessageAi(sca.make().value)
          })
          for (const option of MERGE_OPTIONS) {
            emit('mergeLegacyCommitMessageAiIntoSourceControlAi', `${key}|${option.key}`, (api) => {
              const o = option.make()
              return o.present
                ? api.mergeLegacyCommitMessageAiIntoSourceControlAi(
                    sca.make().value,
                    legacy.make().value,
                    o.value
                  )
                : api.mergeLegacyCommitMessageAiIntoSourceControlAi(
                    sca.make().value,
                    legacy.make().value
                  )
            })
          }
        }
      }

      for (const choice of CHOICE_CELLS) {
        for (const host of HOST_KEYS) {
          for (const agent of AGENT_IDS) {
            const key = `${choice.key}|${host.key}|${agent.key}`
            emit('readSourceControlAiModelChoiceForHost', key, (api) =>
              api.readSourceControlAiModelChoiceForHost(choice.make(), host.make(), agent.make())
            )
            emit('clearSourceControlAiModelChoiceForHost', key, (api) =>
              api.clearSourceControlAiModelChoiceForHost(choice.make(), host.make(), agent.make())
            )
            for (const modelId of ['m-new', '']) {
              emit('selectSourceControlAiModelChoiceForHost', `${key}|model=${modelId}`, (api) =>
                api.selectSourceControlAiModelChoiceForHost(
                  choice.make(),
                  host.make(),
                  agent.make(),
                  modelId
                )
              )
            }
          }
        }
      }

      for (const triple of TRIPLES) {
        const key = tripleKey(triple)
        emit('resolveSourceControlAiEnabled', key, (api) => {
          const { settings, repoArg, repoPresent } = callArgs(triple)
          return api.resolveSourceControlAiEnabled(withRepo({ settings }, repoArg, repoPresent))
        })
        for (const operation of OPERATIONS) {
          for (const name of [
            'resolveSourceControlAiInstructions',
            'hasConfiguredSourceControlAiInstructions'
          ]) {
            emit(name, `${key}|${operation}`, (api) => {
              const { settings, repoArg, repoPresent } = callArgs(triple)
              return api[name](withRepo({ settings, operation }, repoArg, repoPresent))
            })
          }
          for (const host of ['local', 'ssh:box', 'ssh:nowhere']) {
            emit('resolveSourceControlAiForOperation', `${key}|${operation}|${host}`, (api) => {
              const { settings, repoArg, repoPresent } = callArgs(triple, {
                defaultTuiAgent: 'codex'
              })
              return api.resolveSourceControlAiForOperation(
                withRepo({ settings, operation, discoveryHostKey: host }, repoArg, repoPresent)
              )
            })
          }
        }
        for (const actionId of ACTION_IDS) {
          emit('resolveSourceControlActionRecipe', `${key}|${actionId}`, (api) => {
            const { settings, repoArg, repoPresent } = callArgs(triple)
            return api.resolveSourceControlActionRecipe(
              withRepo({ settings, actionId }, repoArg, repoPresent)
            )
          })
        }
        for (const productDefaults of PRODUCT_DEFAULTS) {
          emit(
            'resolveSourceControlAiPrCreationDefaults',
            `${key}|${productDefaults.key}`,
            (api) => {
              const { settings, repoArg, repoPresent } = callArgs(triple)
              const p = productDefaults.make()
              const base: Record<string, unknown> = { settings }
              if (p.present) {
                base.prCreationProductDefaults = p.value
              }
              return api.resolveSourceControlAiPrCreationDefaults(
                withRepo(base, repoArg, repoPresent)
              )
            }
          )
        }
      }

      // The agent environment and an absent discovery host, against the core cube.
      for (const triple of CORE_TRIPLES) {
        const key = tripleKey(triple)
        for (const operation of OPERATIONS) {
          emit('resolveSourceControlAiForOperation', `${key}|${operation}|host/absent`, (api) => {
            const { settings, repoArg, repoPresent } = callArgs(triple, {
              defaultTuiAgent: 'codex'
            })
            return api.resolveSourceControlAiForOperation(
              withRepo({ settings, operation }, repoArg, repoPresent)
            )
          })
          for (const env of AGENT_ENVS) {
            emit(
              'resolveSourceControlAiForOperation',
              `${key}|${operation}|env:${env.key}`,
              (api) => {
                const { settings, repoArg, repoPresent } = callArgs(triple, env.make())
                return api.resolveSourceControlAiForOperation(
                  withRepo(
                    { settings, operation, discoveryHostKey: 'ssh:box' },
                    repoArg,
                    repoPresent
                  )
                )
              }
            )
          }
          for (const productDefaults of PRODUCT_DEFAULTS) {
            emit(
              'resolveSourceControlAiForOperation',
              `${key}|${operation}|${productDefaults.key}`,
              (api) => {
                const { settings, repoArg, repoPresent } = callArgs(triple, {
                  defaultTuiAgent: 'codex'
                })
                const p = productDefaults.make()
                const base: Record<string, unknown> = {
                  settings,
                  operation,
                  discoveryHostKey: 'ssh:box'
                }
                if (p.present) {
                  base.prCreationProductDefaults = p.value
                }
                return api.resolveSourceControlAiForOperation(withRepo(base, repoArg, repoPresent))
              }
            )
          }
        }
      }

      // 1. Every export was exercised and every one really reached its arm, so a
      //    zero mismatch count cannot be the seam quietly never crossing.
      expect(Object.keys(perExport).sort()).toEqual(EXPECTED_EXPORTS)
      for (const [name, entry] of Object.entries(perExport)) {
        expect(`${name}:${entry.crossed > 0}`).toBe(`${name}:true`)
      }
      // 2. The answer is the same VALUE everywhere. Byte and strict differ only by
      //    the two declared residuals, asserted by path below.
      expect(valueMismatches.join('\n---\n')).toBe('')
      expect(totals.value).toBe(0)
      // 3. The only classes of difference are key ORDER and an own-`undefined` the
      //    core omits. A `value:` path, a `keyOnly*` path or an
      //    `ownUndefinedOnlyRust` path would be a new residual, not a known one.
      const unexpected = Object.keys(paths).filter(
        (path) => !path.startsWith('keyOrder:') && !path.startsWith('ownUndefinedOnlyTs:')
      )
      expect(unexpected).toEqual([])
      // 4. Own-`undefined` appears only at the five positions the module header
      //    declares. A new one means a new shape reached a spread-shadowing read.
      const ownUndefined = Object.keys(paths)
        .filter((path) => path.startsWith('ownUndefinedOnlyTs:'))
        .sort()
      expect(ownUndefined).toEqual([
        'ownUndefinedOnlyTs:$.agentId',
        'ownUndefinedOnlyTs:$.customAgentCommand',
        'ownUndefinedOnlyTs:$.enabled',
        'ownUndefinedOnlyTs:$.modelOverridesByOperation',
        'ownUndefinedOnlyTs:$.selectedModelByAgent'
      ])
    },
    30 * 60 * 1000
  )

  it('reports a VALUE difference when the two sides really have one', () => {
    // Without this the run above proves nothing: a comparator that always agrees
    // would report the same zero. A settings blob with an explicit
    // `customAgentCommand: null` is a shape the shim REFUSES to cross precisely
    // because the core substitutes `""` for it, so driving the arm directly is
    // the way to see the difference the refusal is hiding.
    setOrcaDispatchBinding(null)
    const blob = { ...populatedSca(), customAgentCommand: null }
    const ts = evaluate(() => API.normalizeSourceControlAiSettings(blob))
    setOrcaDispatchBinding(wasmBinding)
    const rawCore = evaluate(() =>
      JSON.parse(
        orcaDispatch(
          'source-control-ai',
          'normalizeSourceControlAiSettings',
          JSON.stringify({ value: blob, legacy: null })
        )
      )
    )
    expect(image(ts, 'value')).not.toBe(image(rawCore, 'value'))
    expect(image(ts, 'byte')).not.toBe(image(rawCore, 'byte'))
    expect(image(ts, 'strict')).not.toBe(image(rawCore, 'strict'))
    // And the shim, which refuses the blob, keeps the twin's `null`.
    expect((API.normalizeSourceControlAiSettings(blob) as any).customAgentCommand).toBeNull()
  })

  it('reports a BYTE-only difference when the two sides really have one', () => {
    // The key-order residual, seen through the shim on an input it DOES cross. If
    // the byte image ever stops differing here the residual is over-declared; if
    // the value image starts differing it is under-declared.
    const overrides = { ...populatedRepo(), instructionsByOperation: { pullRequest: 'p' } }
    setOrcaDispatchBinding(null)
    const unbound = evaluate(() => API.normalizeRepoSourceControlAiOverrides(overrides))
    setOrcaDispatchBinding(wasmBinding)
    const bound = evaluate(() => API.normalizeRepoSourceControlAiOverrides(overrides))
    expect(image(unbound, 'byte')).not.toBe(image(bound, 'byte'))
    expect(image(unbound, 'value')).toBe(image(bound, 'value'))
  })
})

const MERGE_OPTIONS: readonly Cell<OptionalValue>[] = [
  { key: 'opt/absent', make: () => ({ present: false, value: undefined }) },
  { key: 'opt/{}', make: () => ({ present: true, value: {} }) },
  {
    key: 'opt/true',
    make: () => ({ present: true, value: { pullRequestInstructionsFromLegacy: true } })
  },
  {
    key: 'opt/false',
    make: () => ({ present: true, value: { pullRequestInstructionsFromLegacy: false } })
  },
  {
    key: 'opt/truthy',
    make: () => ({ present: true, value: { pullRequestInstructionsFromLegacy: 'yes' } })
  }
]

const EXPECTED_EXPORTS = [
  'clearSourceControlAiModelChoiceForHost',
  'getDefaultSourceControlAiSettings',
  'hasConfiguredSourceControlAiInstructions',
  'mergeLegacyCommitMessageAiIntoSourceControlAi',
  'normalizeRepoSourceControlAiOverrides',
  'normalizeSourceControlAiSettings',
  'projectSourceControlAiToLegacyCommitMessageAi',
  'readSourceControlAiModelChoiceForHost',
  'resolveSourceControlActionRecipe',
  'resolveSourceControlAiEnabled',
  'resolveSourceControlAiForOperation',
  'resolveSourceControlAiInstructions',
  'resolveSourceControlAiPrCreationDefaults',
  'selectSourceControlAiModelChoiceForHost',
  'sourceControlAiSettingsFromLegacy'
]
