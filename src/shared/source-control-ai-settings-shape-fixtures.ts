// The `settings.sourceControlAi` and `settings.commitMessageAi` SHAPE AXES that
// `source-control-ai-shape-coverage.test.ts` takes a cross product of.
//
// Why an enumerated axis and not a generator: three cutover attempts on this
// module reported a large CALL COUNT and were refuted, because a fifteen-export
// module has a shape space where a six-figure sample can still miss an entire
// input SHAPE. A named cell list makes coverage a set you can subtract from —
// a cell nobody reached is visible in the report instead of invisible in an
// average.
//
// Each axis is a list of `{key, make}`. `make` returns a FRESH value per call so
// a case can be evaluated on both sides of the dispatch seam without either side
// seeing the other's object.

/** One named point on a shape axis. `make` is fresh per evaluation. */
export type Cell<T> = { key: string; make: () => T }

/** A member is ABSENT, present holding `undefined`, `null`, an empty value, or a
 *  real value. These five are not interchangeable: the payload codec omits an
 *  own-`undefined`, object spread lets a present-`undefined` shadow a default
 *  where an absent key inherits it, and the core's non-tri-state fields turn a
 *  `null` into a substituted default. */
export type FieldState = 'absent' | 'ownUndefined' | 'null' | 'empty' | 'value'
export const FIELD_STATES: readonly FieldState[] = [
  'absent',
  'ownUndefined',
  'null',
  'empty',
  'value'
]

export function withFieldState(
  base: Record<string, unknown>,
  field: string,
  state: FieldState,
  value: unknown,
  empty: unknown
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base }
  if (state === 'absent') {
    delete next[field]
  } else if (state === 'ownUndefined') {
    next[field] = undefined
  } else if (state === 'null') {
    next[field] = null
  } else {
    next[field] = state === 'empty' ? empty : value
  }
  return next
}

/** An argument that can be absent entirely, which `undefined` alone cannot say. */
export type OptionalValue = { present: boolean; value: unknown }

export function populatedSca(): Record<string, unknown> {
  return {
    enabled: true,
    actions: {
      commitMessage: { agentId: 'codex', commandInputTemplate: '{basePrompt}' },
      branchName: { commandInputTemplate: '{basePrompt}' },
      fixChecks: { agentArgs: '--yes' }
    },
    agentId: 'codex',
    selectedModelByAgent: { codex: 'gpt-5.5' },
    selectedModelByAgentByHost: { 'ssh:box': { codex: 'gpt-5.4' } },
    discoveredModelsByAgent: {
      codex: [{ id: 'disc-1', label: 'Disc 1', thinkingLevels: [{ id: 'high', label: 'High' }] }]
    },
    discoveredModelsByAgentByHost: { 'ssh:box': { codex: [{ id: 'disc-2', label: 'Disc 2' }] } },
    selectedThinkingByModel: { 'gpt-5.5': 'medium' },
    customAgentCommand: 'global-cmd',
    instructionsByOperation: { commitMessage: 'C', pullRequest: 'P', branchName: 'B' },
    modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'over-1' } } },
    prCreationDefaults: { draft: true },
    launchActionDefaults: { fixChecks: { agentArgs: '--legacy' } }
  }
}

const SCA_FIELDS: { field: string; value: unknown; empty: unknown }[] = [
  { field: 'enabled', value: false, empty: false },
  { field: 'agentId', value: 'claude', empty: '' },
  { field: 'customAgentCommand', value: ' spaced-cmd ', empty: '' },
  {
    field: 'actions',
    value: { commitMessage: { agentId: 'claude', commandInputTemplate: 'T', agentArgs: '-a' } },
    empty: {}
  },
  { field: 'selectedModelByAgent', value: { codex: 'm1', claude: 'm2' }, empty: {} },
  {
    field: 'selectedModelByAgentByHost',
    value: { 'ssh:box': { codex: 'm3' }, local: { claude: 'm4' } },
    empty: {}
  },
  { field: 'discoveredModelsByAgent', value: { claude: [{ id: 'd1', label: 'D1' }] }, empty: {} },
  {
    field: 'discoveredModelsByAgentByHost',
    value: { 'ssh:other': { claude: [{ id: 'd2', label: 'D2' }] } },
    empty: {}
  },
  { field: 'selectedThinkingByModel', value: { 'gpt-5.5': 'high' }, empty: {} },
  {
    field: 'instructionsByOperation',
    value: { commitMessage: '  C2  ', pullRequest: '', branchName: 'B2' },
    empty: {}
  },
  {
    field: 'modelOverridesByOperation',
    value: {
      commitMessage: { selectedModelByAgentByHost: { 'ssh:box': { codex: 'mo-host' } } },
      branchName: { selectedThinkingByModel: { 'gpt-5.4': 'low' } }
    },
    empty: {}
  },
  {
    field: 'prCreationDefaults',
    value: { draft: true, useTemplate: true, generateDetailsOnOpen: true, openAfterCreate: true },
    empty: {}
  },
  { field: 'launchActionDefaults', value: { resolveConflicts: { agentArgs: '-r' } }, empty: {} }
]

/** Shapes INSIDE a settings blob that the flat per-field axis cannot spell —
 *  the explicit nulls and nested own-`undefined`s a hand-edited or rolled-back
 *  settings file really carries. */
const SCA_NESTED: { key: string; patch: Record<string, unknown> }[] = [
  {
    key: 'nested/instructions.commitMessage=null',
    patch: { instructionsByOperation: { commitMessage: null } }
  },
  {
    key: 'nested/instructions.commitMessage=ownUndefined',
    patch: { instructionsByOperation: { commitMessage: undefined, pullRequest: 'P' } }
  },
  { key: 'nested/prCreationDefaults.draft=null', patch: { prCreationDefaults: { draft: null } } },
  {
    key: 'nested/prCreationDefaults.draft=ownUndefined',
    patch: { prCreationDefaults: { draft: undefined, useTemplate: true } }
  },
  {
    key: 'nested/actions.commitMessage.commandInputTemplate=null',
    patch: { actions: { commitMessage: { commandInputTemplate: null } } }
  },
  {
    key: 'nested/actions.commitMessage.agentId=null',
    patch: { actions: { commitMessage: { agentId: null, commandInputTemplate: '{basePrompt}' } } }
  },
  {
    key: 'nested/actions.commitMessage.agentArgs=ownUndefined',
    patch: { actions: { commitMessage: { agentArgs: undefined, commandInputTemplate: 'X' } } }
  },
  { key: 'nested/unknownMember', patch: { totallyUnknown: 1 } },
  {
    key: 'nested/modelOverrides.commitMessage={}',
    patch: { modelOverridesByOperation: { commitMessage: {} } }
  },
  {
    key: 'nested/modelOverrides.commitMessage.selectedModelByAgent={}',
    patch: { modelOverridesByOperation: { commitMessage: { selectedModelByAgent: {} } } }
  },
  { key: 'nested/agentId=custom', patch: { agentId: 'custom' } },
  { key: 'nested/agentId=unknownAgent', patch: { agentId: 'not-an-agent' } }
]

/** `settings.sourceControlAi`: present / ABSENT / null / own-undefined, and every
 *  per-field and nested shape of a present blob. */
export const SCA_FULL: readonly Cell<OptionalValue>[] = [
  { key: 'blob/absent', make: () => ({ present: false, value: undefined }) },
  { key: 'blob/ownUndefined', make: () => ({ present: true, value: undefined }) },
  { key: 'blob/null', make: () => ({ present: true, value: null }) },
  { key: 'blob/{}', make: () => ({ present: true, value: {} }) },
  { key: 'blob/populated', make: () => ({ present: true, value: populatedSca() }) },
  ...SCA_FIELDS.flatMap((spec) =>
    FIELD_STATES.map((state) => ({
      key: `field/${spec.field}=${state}`,
      make: () => ({
        present: true,
        value: withFieldState(populatedSca(), spec.field, state, spec.value, spec.empty)
      })
    }))
  ),
  ...SCA_NESTED.map((entry) => ({
    key: entry.key,
    make: () => ({ present: true, value: { ...populatedSca(), ...entry.patch } })
  }))
]

/** The representative subset used where an export takes so many axes that the
 *  complete product is out of reach; every cell here is one whose behaviour a
 *  different axis can plausibly interact with. */
const SCA_CORE_KEYS: ReadonlySet<string> = new Set([
  'blob/absent',
  'blob/ownUndefined',
  'blob/null',
  'blob/{}',
  'blob/populated',
  'field/enabled=absent',
  'field/enabled=ownUndefined',
  'field/agentId=null',
  'field/customAgentCommand=absent',
  'field/customAgentCommand=ownUndefined',
  'field/customAgentCommand=null',
  'field/instructionsByOperation=absent',
  'field/modelOverridesByOperation=value',
  'field/prCreationDefaults=value',
  'field/actions=value',
  'nested/instructions.commitMessage=null',
  'nested/agentId=custom',
  'nested/actions.commitMessage.commandInputTemplate=null'
])

export const SCA_CORE = SCA_FULL.filter((cell) => SCA_CORE_KEYS.has(cell.key))

export function populatedLegacy(): Record<string, unknown> {
  return {
    enabled: true,
    agentId: 'claude',
    selectedModelByAgent: { claude: 'opus' },
    selectedModelByAgentByHost: { 'ssh:box': { claude: 'opus-host' } },
    discoveredModelsByAgent: { claude: [{ id: 'leg-1', label: 'Leg 1' }] },
    discoveredModelsByAgentByHost: { 'ssh:box': { claude: [{ id: 'leg-2', label: 'Leg 2' }] } },
    selectedThinkingByModel: { opus: 'max' },
    customPrompt: 'Legacy prompt',
    customAgentCommand: 'legacy-cmd'
  }
}

const LEGACY_FIELDS: { field: string; value: unknown; empty: unknown }[] = [
  { field: 'enabled', value: false, empty: false },
  { field: 'agentId', value: 'custom', empty: '' },
  { field: 'customPrompt', value: '  Legacy 2  ', empty: '' },
  { field: 'customAgentCommand', value: 'legacy-cmd-2', empty: '' },
  { field: 'selectedModelByAgent', value: { claude: 'sonnet', codex: 'gpt' }, empty: {} },
  { field: 'selectedModelByAgentByHost', value: { local: { claude: 'local-opus' } }, empty: {} },
  { field: 'selectedThinkingByModel', value: { opus: 'high' }, empty: {} },
  { field: 'discoveredModelsByAgent', value: { codex: [{ id: 'l3', label: 'L3' }] }, empty: {} },
  {
    field: 'discoveredModelsByAgentByHost',
    value: { local: { codex: [{ id: 'l4', label: 'L4' }] } },
    empty: {}
  }
]

/** `settings.commitMessageAi`: absent / own-undefined / null / `{}` / populated,
 *  and with AND without each member. */
export const LEGACY_FULL: readonly Cell<OptionalValue>[] = [
  { key: 'blob/absent', make: () => ({ present: false, value: undefined }) },
  { key: 'blob/ownUndefined', make: () => ({ present: true, value: undefined }) },
  { key: 'blob/null', make: () => ({ present: true, value: null }) },
  { key: 'blob/{}', make: () => ({ present: true, value: {} }) },
  { key: 'blob/populated', make: () => ({ present: true, value: populatedLegacy() }) },
  ...LEGACY_FIELDS.flatMap((spec) =>
    FIELD_STATES.map((state) => ({
      key: `field/${spec.field}=${state}`,
      make: () => ({
        present: true,
        value: withFieldState(populatedLegacy(), spec.field, state, spec.value, spec.empty)
      })
    }))
  ),
  {
    key: 'nested/unknownMember',
    make: () => ({ present: true, value: { ...populatedLegacy(), unknownLegacy: 1 } })
  },
  {
    // The blob `main/persistence.ts` builds: no customPrompt, no customAgentCommand.
    key: 'nested/persistenceShape',
    make: () => ({ present: true, value: { enabled: true, agentId: 'codex' } })
  }
]

const LEGACY_CORE_KEYS: ReadonlySet<string> = new Set([
  'blob/absent',
  'blob/ownUndefined',
  'blob/null',
  'blob/{}',
  'blob/populated',
  'field/customPrompt=absent',
  'field/customPrompt=empty',
  'field/customPrompt=null',
  'field/customAgentCommand=absent',
  'field/enabled=absent',
  'field/agentId=null',
  'field/selectedModelByAgent=value',
  'nested/persistenceShape'
])

export const LEGACY_CORE = LEGACY_FULL.filter((cell) => LEGACY_CORE_KEYS.has(cell.key))

/** `settings` with each member present only when the axis cell says so. */
export function buildSettings(
  sca: OptionalValue,
  legacy: OptionalValue,
  env: Record<string, unknown> = {}
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...env }
  if (sca.present) {
    settings.sourceControlAi = sca.value
  }
  if (legacy.present) {
    settings.commitMessageAi = legacy.value
  }
  return settings
}
