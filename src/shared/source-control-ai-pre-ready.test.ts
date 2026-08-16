// The pre-ready contract for `source-control-ai.ts`, measured.
//
// The shim declares `parity` for all fifteen exports, which is a claim about
// two things this file checks separately:
//
//  1. BOUND == UNBOUND. Every case runs with the seam unbound (the renderer
//     before wasm, the relay before initSync) and again against the SHIPPED wasm
//     core, and the two answers must be identical. `config/vitest-orca-dispatch-
//     seam.ts` binds the seam at import time for every test file, so the unbound
//     pass has to unbind first and restore afterwards.
//  2. THE CORE IS ACTUALLY REACHED. A bound==unbound test passes vacuously if the
//     shim silently never crosses, so a counting binding proves each export
//     reached its own arm by name.
//
// The corpus half of the proof is `pnpm parity`: the shared vectors run through
// this same shim UNBOUND against the Rust port. What is here is what a JSON
// vector cannot carry — a TS `undefined` answer, and the out-of-contract inputs
// the shim deliberately refuses to cross.
//
// A FIXTURE HELPER THAT ALWAYS FILLS A FIELD MAKES THAT FIELD'S ABSENCE
// UNTESTABLE. `settings()` below builds `sourceControlAi: {...base.sourceControlAi!}`,
// so it could never produce the two shapes `main/persistence.ts` actually hands
// this module — the member ABSENT and the member NULL. Crossed with a legacy
// `commitMessageAi` that has no `customAgentCommand` (the blob persistence.ts:3286
// builds), that is where `resolveSourceControlAiForOperation` CRASHED while the
// Rust core answered correctly, and neither this file nor the vector corpus could
// see it. `settingsWithoutSourceControlAi` closes the hole; every case built from
// it throws on the twin as it stood before 9026340f57.
import { afterEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { getDefaultSettings } from './constants'
import { setOrcaDispatchBinding, type OrcaDispatchFn } from './orca-dispatch-seam'
import {
  clearSourceControlAiModelChoiceForHost,
  getDefaultSourceControlAiSettings,
  hasConfiguredSourceControlAiInstructions,
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeRepoSourceControlAiOverrides,
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi,
  readSourceControlAiModelChoiceForHost,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiEnabled,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiInstructions,
  resolveSourceControlAiPrCreationDefaults,
  selectSourceControlAiModelChoiceForHost,
  sourceControlAiSettingsFromLegacy
} from './source-control-ai'
import type { GlobalSettings } from './types'

const wasmBinding: OrcaDispatchFn = (module, fn, inputJson) => orcaDispatch(module, fn, inputJson)

afterEach(() => setOrcaDispatchBinding(wasmBinding))

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'codex' as const,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex' as const,
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium' },
      instructionsByOperation: {
        commitMessage: 'Global commit style',
        pullRequest: '',
        branchName: 'Global branch style'
      }
    }
  }
}

/** The two shapes `settings()` can never build. `sourceControlAi` reaches this
 *  module ABSENT (a settings file written before the member existed) and NULL
 *  (`persistence.ts` hands the raw member through), and the legacy blob beside it
 *  is `{enabled, agentId}` with no `customAgentCommand` key at all. */
function settingsWithoutSourceControlAi(member: 'absent' | 'null'): GlobalSettings {
  const base = { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'codex' as const }
  const commitMessageAi = { enabled: true, agentId: 'codex' } as GlobalSettings['commitMessageAi']
  if (member === 'null') {
    return { ...base, commitMessageAi, sourceControlAi: null as unknown as undefined }
  }
  const { sourceControlAi: _dropped, ...withoutMember } = base
  return { ...withoutMember, commitMessageAi } as GlobalSettings
}

const HOST_CHOICE = {
  selectedModelByAgent: { codex: 'gpt-5.5' },
  selectedModelByAgentByHost: { 'ssh:box': { codex: 'gpt-5.4' } },
  selectedThinkingByModel: { 'gpt-5.4': 'high' }
}

const LEGACY = {
  enabled: true,
  agentId: 'claude' as const,
  selectedModelByAgent: { claude: 'opus' },
  selectedThinkingByModel: { opus: 'max' },
  customPrompt: 'Legacy prompt',
  customAgentCommand: ''
}

/** Every export, including the answers no JSON vector can carry. */
const CASES: { name: string; call: () => unknown }[] = [
  { name: 'getDefaultSourceControlAiSettings', call: () => getDefaultSourceControlAiSettings() },
  {
    name: 'normalizeRepoSourceControlAiOverrides(recognised)',
    call: () => normalizeRepoSourceControlAiOverrides({ enabled: false, customAgentCommand: ' x ' })
  },
  {
    // Answers TS `undefined`; the arm spells that `Value::Null`.
    name: 'normalizeRepoSourceControlAiOverrides(nothing recognised)',
    call: () => normalizeRepoSourceControlAiOverrides({ nonsense: 1 })
  },
  {
    name: 'normalizeRepoSourceControlAiOverrides(not a record)',
    call: () => normalizeRepoSourceControlAiOverrides('nope')
  },
  {
    name: 'sourceControlAiSettingsFromLegacy(null)',
    call: () => sourceControlAiSettingsFromLegacy(null)
  },
  {
    name: 'sourceControlAiSettingsFromLegacy(legacy)',
    call: () => sourceControlAiSettingsFromLegacy(LEGACY)
  },
  {
    name: 'normalizeSourceControlAiSettings(undefined, legacy)',
    call: () => normalizeSourceControlAiSettings(undefined, LEGACY)
  },
  {
    name: 'normalizeSourceControlAiSettings(settings)',
    call: () => normalizeSourceControlAiSettings(settings().sourceControlAi)
  },
  {
    name: 'mergeLegacyCommitMessageAiIntoSourceControlAi',
    call: () => mergeLegacyCommitMessageAiIntoSourceControlAi(settings().sourceControlAi, LEGACY)
  },
  {
    name: 'mergeLegacyCommitMessageAiIntoSourceControlAi(pullRequestInstructionsFromLegacy)',
    call: () =>
      mergeLegacyCommitMessageAiIntoSourceControlAi(settings().sourceControlAi, LEGACY, {
        pullRequestInstructionsFromLegacy: true
      })
  },
  {
    name: 'projectSourceControlAiToLegacyCommitMessageAi',
    call: () => projectSourceControlAiToLegacyCommitMessageAi(settings().sourceControlAi!)
  },
  {
    name: 'readSourceControlAiModelChoiceForHost(ssh host)',
    call: () => readSourceControlAiModelChoiceForHost(HOST_CHOICE, 'ssh:box', 'codex')
  },
  {
    // Answers TS `undefined`.
    name: 'readSourceControlAiModelChoiceForHost(no choice recorded)',
    call: () => readSourceControlAiModelChoiceForHost(HOST_CHOICE, 'ssh:other', 'claude')
  },
  {
    name: 'selectSourceControlAiModelChoiceForHost',
    call: () => selectSourceControlAiModelChoiceForHost(HOST_CHOICE, 'ssh:box', 'claude', 'opus')
  },
  {
    name: 'clearSourceControlAiModelChoiceForHost(keeps other hosts)',
    call: () => clearSourceControlAiModelChoiceForHost(HOST_CHOICE, 'local', 'codex')
  },
  {
    // Answers TS `undefined` — the last selection cleared.
    name: 'clearSourceControlAiModelChoiceForHost(last selection)',
    call: () =>
      clearSourceControlAiModelChoiceForHost(
        { selectedModelByAgent: { codex: 'gpt-5.5' } },
        'local',
        'codex'
      )
  },
  {
    name: 'resolveSourceControlAiInstructions',
    call: () =>
      resolveSourceControlAiInstructions({
        settings: settings(),
        repo: { sourceControlAi: { instructionsByOperation: { pullRequest: ' repo PR ' } } },
        operation: 'pullRequest'
      })
  },
  {
    name: 'hasConfiguredSourceControlAiInstructions',
    call: () =>
      hasConfiguredSourceControlAiInstructions({
        settings: settings(),
        repo: null,
        operation: 'pullRequest'
      })
  },
  {
    name: 'resolveSourceControlAiPrCreationDefaults',
    call: () =>
      resolveSourceControlAiPrCreationDefaults({
        settings: settings(),
        repo: { sourceControlAi: { prCreationDefaults: { draft: true, useTemplate: null } } },
        prCreationProductDefaults: { openAfterCreate: true }
      })
  },
  {
    name: 'resolveSourceControlAiEnabled(no settings)',
    call: () => resolveSourceControlAiEnabled({ settings: null, repo: null })
  },
  {
    name: 'resolveSourceControlAiEnabled(repo override)',
    call: () =>
      resolveSourceControlAiEnabled({
        settings: settings(),
        repo: { sourceControlAi: { enabled: false } }
      })
  },
  {
    name: 'resolveSourceControlActionRecipe(launch action)',
    call: () =>
      resolveSourceControlActionRecipe({
        settings: settings(),
        repo: { sourceControlAi: { actionOverrides: { fixChecks: { agentArgs: ' --yolo ' } } } },
        actionId: 'fixChecks'
      })
  },
  {
    name: 'resolveSourceControlAiForOperation(ok)',
    call: () =>
      resolveSourceControlAiForOperation({
        settings: settings(),
        repo: null,
        operation: 'commitMessage',
        discoveryHostKey: 'local'
      })
  },
  {
    name: 'resolveSourceControlAiForOperation(ssh host)',
    call: () =>
      resolveSourceControlAiForOperation({
        settings: settings(),
        repo: { sourceControlAi: { modelOverridesByOperation: { branchName: HOST_CHOICE } } },
        operation: 'branchName',
        discoveryHostKey: 'ssh:box'
      })
  },
  {
    name: 'resolveSourceControlAiForOperation(error)',
    call: () => {
      const base = settings()
      base.sourceControlAi = { ...base.sourceControlAi!, agentId: 'custom', customAgentCommand: '' }
      return resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'pullRequest'
      })
    }
  },
  // The out-of-contract inputs the shim refuses to cross — the answer must still
  // be the twin's, on both sides of the seam.
  {
    name: 'resolveSourceControlAiForOperation(non-string discoveryHostKey)',
    call: () =>
      resolveSourceControlAiForOperation({
        settings: settings(),
        repo: null,
        operation: 'commitMessage',
        discoveryHostKey: 7 as unknown as string
      })
  },
  {
    name: 'resolveSourceControlActionRecipe(unknown actionId)',
    call: () =>
      resolveSourceControlActionRecipe({
        settings: settings(),
        repo: null,
        actionId: 'notAnAction' as never
      })
  },
  {
    name: 'readSourceControlAiModelChoiceForHost(non-string hostKey)',
    call: () => readSourceControlAiModelChoiceForHost(HOST_CHOICE, 3 as unknown as string, 'codex')
  },
  // Blobs the core's typed structs cannot hold, so they must not cross. Each of
  // these DID cross once and answered a substituted default; the refusal in
  // `source-control-ai-core-representable.ts` is what makes them agree again.
  {
    name: 'normalizeSourceControlAiSettings(customAgentCommand: null)',
    call: () =>
      normalizeSourceControlAiSettings({
        ...settings().sourceControlAi!,
        customAgentCommand: null as unknown as string
      })
  },
  {
    name: 'normalizeSourceControlAiSettings(instruction: null)',
    call: () =>
      normalizeSourceControlAiSettings({
        ...settings().sourceControlAi!,
        instructionsByOperation: { commitMessage: null as unknown as string }
      })
  },
  {
    name: 'normalizeSourceControlAiSettings(prCreationDefaults: null member)',
    call: () =>
      normalizeSourceControlAiSettings({
        ...settings().sourceControlAi!,
        prCreationDefaults: { draft: true, useTemplate: null as unknown as boolean }
      })
  },
  {
    name: 'normalizeSourceControlAiSettings(own-undefined enabled)',
    call: () =>
      normalizeSourceControlAiSettings({
        ...settings().sourceControlAi!,
        enabled: undefined as unknown as boolean
      })
  },
  {
    name: 'sourceControlAiSettingsFromLegacy(discovered models that are not capabilities)',
    call: () =>
      sourceControlAiSettingsFromLegacy({
        ...LEGACY,
        discoveredModelsByAgent: { codex: ['a', 'b'] as unknown as [] }
      })
  },
  {
    name: 'clearSourceControlAiModelChoiceForHost(own-undefined entry)',
    call: () =>
      clearSourceControlAiModelChoiceForHost(
        { selectedModelByAgent: { codex: undefined } },
        'local',
        'claude'
      )
  },
  {
    name: 'resolveSourceControlAiForOperation(customAgentCommand: null)',
    call: () => {
      const base = settings()
      base.sourceControlAi = {
        ...base.sourceControlAi!,
        customAgentCommand: null as unknown as string
      }
      return resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'commitMessage'
      })
    }
  },
  // THE CORPUS HOLE. `settings.sourceControlAi` absent and null, each crossed with
  // a legacy blob that has no `customAgentCommand` — the shape persistence.ts:3286
  // builds. The twin produced an OWN `customAgentCommand: undefined` here and then
  // read `.trim()` off it unguarded, so every one of these THREW before 9026340f57
  // while the core answered. They are the cases the old fixture could not express.
  ...(['absent', 'null'] as const).flatMap((member) =>
    (['commitMessage', 'pullRequest', 'branchName'] as const).map((operation) => ({
      name: `resolveSourceControlAiForOperation(sourceControlAi ${member}, legacy without customAgentCommand, ${operation})`,
      call: () =>
        resolveSourceControlAiForOperation({
          settings: settingsWithoutSourceControlAi(member),
          repo: null,
          operation
        })
    }))
  ),
  // THE OTHER CORPUS HOLE, same shape as the one above and its own regression:
  // `resolveSourceControlAiEnabled` is typed `boolean`, and for a legacy blob with
  // NO `enabled` key the normalizer produces an own-undefined `enabled`, so the
  // coalesce falls through both operands. f2dccc5740 closed that with `?? false`;
  // nothing pinned it, and the split re-introduced it. Every fixture above hands
  // the legacy blob an `enabled`, so none of them can reach it.
  ...(['absent', 'null', 'empty'] as const).flatMap((member) =>
    ([{}, { agentId: 'codex' }, { customPrompt: 'p' }] as const).map((legacy, index) => ({
      name: `resolveSourceControlAiEnabled(sourceControlAi ${member}, legacy without enabled #${index})`,
      call: () => {
        const base = { ...getDefaultSettings('/tmp') } as GlobalSettings
        const { sourceControlAi: _dropped, ...withoutMember } = base
        const settingsValue =
          member === 'absent'
            ? withoutMember
            : { ...withoutMember, sourceControlAi: (member === 'null' ? null : {}) as never }
        return resolveSourceControlAiEnabled({
          settings: {
            ...settingsValue,
            commitMessageAi: legacy as GlobalSettings['commitMessageAi']
          } as GlobalSettings,
          repo: null
        })
      }
    }))
  ),
  ...(['absent', 'null'] as const).flatMap((member) => [
    {
      name: `resolveSourceControlAiEnabled(sourceControlAi ${member})`,
      call: () =>
        resolveSourceControlAiEnabled({ settings: settingsWithoutSourceControlAi(member) })
    },
    {
      name: `resolveSourceControlAiInstructions(sourceControlAi ${member})`,
      call: () =>
        resolveSourceControlAiInstructions({
          settings: settingsWithoutSourceControlAi(member),
          repo: null,
          operation: 'commitMessage' as const
        })
    },
    {
      name: `resolveSourceControlActionRecipe(sourceControlAi ${member})`,
      call: () =>
        resolveSourceControlActionRecipe({
          settings: settingsWithoutSourceControlAi(member),
          repo: null,
          actionId: 'commitMessage' as const
        })
    },
    {
      name: `normalizeSourceControlAiSettings(sourceControlAi ${member}, legacy without customAgentCommand)`,
      call: () =>
        normalizeSourceControlAiSettings(
          settingsWithoutSourceControlAi(member).sourceControlAi,
          settingsWithoutSourceControlAi(member).commitMessageAi
        )
    },
    {
      name: `sourceControlAiSettingsFromLegacy(legacy without customAgentCommand, ${member})`,
      call: () =>
        sourceControlAiSettingsFromLegacy(settingsWithoutSourceControlAi(member).commitMessageAi)
    },
    {
      name: `resolveSourceControlAiForOperation(sourceControlAi ${member}, repo custom command)`,
      call: () =>
        resolveSourceControlAiForOperation({
          settings: settingsWithoutSourceControlAi(member),
          repo: {
            sourceControlAi: {
              customAgentCommand: ' repo cmd ',
              actionOverrides: { commitMessage: { agentId: 'custom' } }
            }
          },
          operation: 'commitMessage' as const
        })
    }
  ]),
  {
    name: 'resolveSourceControlAiPrCreationDefaults(settings-level null member)',
    call: () =>
      resolveSourceControlAiPrCreationDefaults({
        settings: {
          ...settings(),
          sourceControlAi: {
            ...settings().sourceControlAi!,
            prCreationDefaults: { draft: true, useTemplate: null as unknown as boolean }
          }
        },
        repo: null
      })
  }
]

/** Canonical JSON — keys sorted, so this compares VALUES the way the parity
 *  comparator does. `JSON.stringify` alone would fail on key ORDER, which the
 *  Rust core emits differently (BTreeMap / struct order) and which no consumer
 *  reads; that difference is declared as a residual in the shim's header, and
 *  measured here by the sorting being the only thing that reconciles the two.
 *  `undefined` still snapshots apart from `null` and from an absent key. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])])
  )
}

function snapshot(call: () => unknown): string {
  // A THROW is an answer too: the twin threw on some persisted shapes, and a
  // core that answers instead is a divergence, not a repair.
  let answer: unknown
  try {
    answer = call()
  } catch (error) {
    return `__throw__:${(error as Error).message}`
  }
  return answer === undefined ? '__undefined__' : JSON.stringify(canonical(answer))
}

describe('source-control-ai shim pre-ready contract', () => {
  const preReady = CASES.map((testCase) => {
    setOrcaDispatchBinding(null)
    try {
      return snapshot(testCase.call)
    } finally {
      setOrcaDispatchBinding(wasmBinding)
    }
  })

  CASES.forEach((testCase, index) => {
    it(`${testCase.name} — pre-ready matches ready`, () => {
      expect(preReady[index]).toBe(snapshot(testCase.call))
    })
  })

  it('reaches the Rust core for every export, so the match above is not vacuous', () => {
    const reached: string[] = []
    setOrcaDispatchBinding((module, fn, inputJson) => {
      reached.push(`${module}.${fn}`)
      return wasmBinding(module, fn, inputJson)
    })
    for (const testCase of CASES) {
      try {
        testCase.call()
      } catch {
        // A case whose answer IS a throw still had to reach (or refuse) its arm.
      }
    }
    // Only this module's arms: a sibling shim on the same seam is not the
    // subject. The refusal cases at the end of CASES never cross, by design.
    expect(new Set(reached.filter((call) => call.startsWith('source-control-ai.')))).toEqual(
      new Set([
        'source-control-ai.getDefaultSourceControlAiSettings',
        'source-control-ai.normalizeRepoSourceControlAiOverrides',
        'source-control-ai.sourceControlAiSettingsFromLegacy',
        'source-control-ai.normalizeSourceControlAiSettings',
        'source-control-ai.mergeLegacyCommitMessageAiIntoSourceControlAi',
        'source-control-ai.projectSourceControlAiToLegacyCommitMessageAi',
        'source-control-ai.readSourceControlAiModelChoiceForHost',
        'source-control-ai.selectSourceControlAiModelChoiceForHost',
        'source-control-ai.clearSourceControlAiModelChoiceForHost',
        'source-control-ai.resolveSourceControlAiInstructions',
        'source-control-ai.hasConfiguredSourceControlAiInstructions',
        'source-control-ai.resolveSourceControlAiPrCreationDefaults',
        'source-control-ai.resolveSourceControlAiEnabled',
        'source-control-ai.resolveSourceControlActionRecipe',
        'source-control-ai.resolveSourceControlAiForOperation'
      ])
    )
  })

  it('answers undefined, never null, for the three exports that can have no answer', () => {
    // The arm spells TS `undefined` as `Value::Null`. Reading that back as a
    // value would turn "no choice recorded" into "the choice is null", and these
    // three feed persisted settings.
    expect(
      readSourceControlAiModelChoiceForHost(HOST_CHOICE, 'ssh:other', 'claude')
    ).toBeUndefined()
    expect(
      clearSourceControlAiModelChoiceForHost(
        { selectedModelByAgent: { codex: 'x' } },
        'local',
        'codex'
      )
    ).toBeUndefined()
    expect(normalizeRepoSourceControlAiOverrides({ nonsense: 1 })).toBeUndefined()
  })

  it('resolveSourceControlAiEnabled answers a boolean, never undefined', () => {
    // Plant the violation the split re-introduced: `sourceControlAi` gone and a
    // legacy blob with no `enabled`, so `repoOverrides?.enabled ?? source.enabled`
    // falls through both operands. Drop the `?? false` and this goes red on the
    // unbound pass while the bound pass still answers `false`.
    const base = { ...getDefaultSettings('/tmp') } as GlobalSettings
    const { sourceControlAi: _dropped, ...withoutMember } = base
    const settingsValue = {
      ...withoutMember,
      commitMessageAi: {} as GlobalSettings['commitMessageAi']
    } as GlobalSettings
    for (const binding of [null, wasmBinding]) {
      setOrcaDispatchBinding(binding)
      expect(resolveSourceControlAiEnabled({ settings: settingsValue, repo: null })).toBe(false)
    }
    setOrcaDispatchBinding(wasmBinding)
  })

  it('keeps null a real value for the eleven that never answer undefined', () => {
    // `agentId: null` is "explicitly no agent", not "absent" — the twin's
    // `hasActionAgentRecipe` reads the two apart, so the round trip must too.
    const normalized = normalizeSourceControlAiSettings({
      ...settings().sourceControlAi!,
      agentId: null
    })
    expect(normalized.agentId).toBeNull()
    const projected = projectSourceControlAiToLegacyCommitMessageAi({
      ...settings().sourceControlAi!,
      agentId: null,
      actions: { commitMessage: { agentId: null, commandInputTemplate: '{basePrompt}' } }
    })
    expect(projected.agentId).toBeNull()
  })

  it('a blob the core would answer with a SUBSTITUTED default does not cross', () => {
    // The core's settings-level fields are not tri-state
    // (`custom_agent_command: Option<String>`,
    // `instructions_by_operation: BTreeMap<_, String>`,
    // `pr_creation_defaults: { draft: Option<bool> }`), so a persisted `null`
    // decodes as `None` and comes back as `""` / `false` — a substituted value
    // on a PERSISTED write, the same class as the rollback-bridge defect. The
    // twin returned what it was given, so these must answer from its body.
    // Built BEFORE the counting binding: `getDefaultSettings` crosses on its own.
    const blob = {
      ...settings().sourceControlAi!,
      customAgentCommand: null as unknown as string,
      instructionsByOperation: { commitMessage: null as unknown as string },
      prCreationDefaults: { draft: true, useTemplate: null as unknown as boolean }
    }
    let crossed = 0
    setOrcaDispatchBinding((module, fn, inputJson) => {
      if (module === 'source-control-ai') {
        crossed += 1
      }
      return wasmBinding(module, fn, inputJson)
    })
    const withNulls = normalizeSourceControlAiSettings(blob)
    const projected = projectSourceControlAiToLegacyCommitMessageAi(withNulls)
    setOrcaDispatchBinding(wasmBinding)
    expect(crossed).toBe(0)
    expect(withNulls.customAgentCommand).toBeNull()
    expect(withNulls.instructionsByOperation.commitMessage).toBeNull()
    expect(withNulls.prCreationDefaults?.useTemplate).toBeNull()
    // And the rollback bridge keeps the explicit null instead of writing `""`.
    expect(projected.customAgentCommand).toBeNull()
  })

  it('a well-typed discovered-model list DOES cross and round-trips whole', () => {
    // The refusal above must not be so broad that real data stops crossing.
    let crossed = 0
    setOrcaDispatchBinding((module, fn, inputJson) => {
      if (module === 'source-control-ai') {
        crossed += 1
      }
      return wasmBinding(module, fn, inputJson)
    })
    const answer = sourceControlAiSettingsFromLegacy({
      ...LEGACY,
      discoveredModelsByAgent: {
        codex: [
          {
            id: 'gpt-5.5',
            label: 'GPT-5.5',
            thinkingLevels: [{ id: 'high', label: 'High' }],
            defaultThinkingLevel: 'high'
          }
        ]
      }
    })
    setOrcaDispatchBinding(wasmBinding)
    expect(crossed).toBeGreaterThan(0)
    expect(answer.discoveredModelsByAgent?.codex).toEqual([
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        thinkingLevels: [{ id: 'high', label: 'High' }],
        defaultThinkingLevel: 'high'
      }
    ])
  })

  it('a payload the codec refuses falls back instead of throwing', () => {
    // A lone UTF-16 surrogate cannot cross (serde cannot decode it as UTF-8), so
    // the shim must answer from the twin's body — the twin answered these.
    const lone = '\ud800'
    expect(normalizeRepoSourceControlAiOverrides({ customAgentCommand: lone })).toEqual({
      customAgentCommand: lone
    })
  })

  it('a core failure envelope throws instead of being read as an answer', () => {
    setOrcaDispatchBinding(() => '{"__dispatch_error__":"unknown module"}')
    expect(() => getDefaultSourceControlAiSettings()).toThrow(/failed in the Rust core/)
  })
})
