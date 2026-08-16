// The `repo.sourceControlAi` shape axis for
// `source-control-ai-shape-coverage.test.ts`.
//
// The repo side is the one place the core models a TRI-STATE deliberately
// (`normalize_repo_instruction`, `parse_bool_or_null`,
// `RepoSourceControlActionOverride`), so an explicit `null` here is a value both
// sides can hold and every position that accepts one gets its own cell.
import {
  FIELD_STATES,
  withFieldState,
  type Cell
} from './source-control-ai-settings-shape-fixtures'

export function populatedRepo(): Record<string, unknown> {
  return {
    enabled: false,
    customAgentCommand: ' repo-cmd ',
    modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'repo-1' } } },
    instructionsByOperation: { commitMessage: ' repo C ', pullRequest: 'repo P' },
    actionOverrides: {
      commitMessage: { agentId: 'claude', commandInputTemplate: ' repo T ' },
      fixChecks: { agentArgs: ' --repo ' }
    },
    prCreationDefaults: { draft: true, useTemplate: false }
  }
}

const REPO_FIELDS: { field: string; value: unknown; empty: unknown }[] = [
  { field: 'enabled', value: true, empty: false },
  { field: 'customAgentCommand', value: '  ', empty: '' },
  {
    field: 'modelOverridesByOperation',
    value: { branchName: { selectedModelByAgentByHost: { 'ssh:box': { codex: 'repo-h' } } } },
    empty: {}
  },
  {
    field: 'instructionsByOperation',
    value: { commitMessage: '', pullRequest: ' PR ', branchName: 'BR' },
    empty: {}
  },
  {
    field: 'actionOverrides',
    value: { branchName: { commandInputTemplate: 'BT' }, resolveComments: { agentArgs: '-c' } },
    empty: {}
  },
  {
    field: 'prCreationDefaults',
    value: { draft: false, useTemplate: true, generateDetailsOnOpen: true, openAfterCreate: false },
    empty: {}
  }
]

const REPO_NESTED: { key: string; patch: Record<string, unknown> }[] = [
  {
    key: 'nested/instructions.commitMessage=null',
    patch: { instructionsByOperation: { commitMessage: null } }
  },
  {
    key: 'nested/instructions.pullRequest=null',
    patch: { instructionsByOperation: { pullRequest: null } }
  },
  {
    key: 'nested/instructions.branchName=null',
    patch: { instructionsByOperation: { branchName: null } }
  },
  {
    key: 'nested/instructions.mixedNull',
    patch: { instructionsByOperation: { commitMessage: null, pullRequest: 'x', branchName: '' } }
  },
  {
    key: 'nested/instructions.ownUndefined',
    patch: { instructionsByOperation: { commitMessage: undefined, pullRequest: 'x' } }
  },
  { key: 'nested/pr.draft=null', patch: { prCreationDefaults: { draft: null } } },
  { key: 'nested/pr.useTemplate=null', patch: { prCreationDefaults: { useTemplate: null } } },
  {
    key: 'nested/pr.generateDetailsOnOpen=null',
    patch: { prCreationDefaults: { generateDetailsOnOpen: null } }
  },
  {
    key: 'nested/pr.openAfterCreate=null',
    patch: { prCreationDefaults: { openAfterCreate: null } }
  },
  { key: 'nested/pr.mixedNull', patch: { prCreationDefaults: { draft: null, useTemplate: true } } },
  {
    key: 'nested/pr.ownUndefined',
    patch: { prCreationDefaults: { draft: undefined, openAfterCreate: true } }
  },
  {
    key: 'nested/actionOverrides.commandInputTemplate=null',
    patch: { actionOverrides: { commitMessage: { commandInputTemplate: null } } }
  },
  {
    key: 'nested/actionOverrides.agentArgs=null',
    patch: { actionOverrides: { commitMessage: { agentArgs: null } } }
  },
  {
    key: 'nested/actionOverrides.agentId=null',
    patch: { actionOverrides: { commitMessage: { agentId: null } } }
  },
  {
    key: 'nested/actionOverrides.bothNull',
    patch: { actionOverrides: { fixChecks: { agentArgs: null, commandInputTemplate: null } } }
  },
  {
    key: 'nested/actionOverrides.ownUndefined',
    patch: { actionOverrides: { commitMessage: { agentArgs: undefined, agentId: 'codex' } } }
  },
  {
    // The legacy branch template the normalizer is allowed to reorder.
    key: 'nested/actionOverrides.branchLegacyTemplate',
    patch: {
      instructionsByOperation: { branchName: 'Branch style' },
      actionOverrides: { branchName: { commandInputTemplate: '{basePrompt}\n\nBranch style' } }
    }
  },
  { key: 'nested/customAgentCommand=null', patch: { customAgentCommand: null } },
  { key: 'nested/unknownMember', patch: { totallyUnknown: 1 } },
  { key: 'nested/onlyUnknown', patch: {} }
]

/** `repo` absent entirely, `repo` null, `repo` without the member, and every
 *  shape of `repo.sourceControlAi`. */
export type RepoCell = {
  repoPresent: boolean
  repoNull: boolean
  scaPresent: boolean
  value: unknown
}

function repoCell(value: unknown): RepoCell {
  return { repoPresent: true, repoNull: false, scaPresent: true, value }
}

export const REPO_FULL: readonly Cell<RepoCell>[] = [
  {
    key: 'repo/absent',
    make: () => ({ repoPresent: false, repoNull: false, scaPresent: false, value: undefined })
  },
  {
    key: 'repo/null',
    make: () => ({ repoPresent: true, repoNull: true, scaPresent: false, value: undefined })
  },
  {
    key: 'repo/{}',
    make: () => ({ repoPresent: true, repoNull: false, scaPresent: false, value: undefined })
  },
  { key: 'sca/ownUndefined', make: () => repoCell(undefined) },
  { key: 'sca/null', make: () => repoCell(null) },
  { key: 'sca/{}', make: () => repoCell({}) },
  { key: 'sca/populated', make: () => repoCell(populatedRepo()) },
  ...REPO_FIELDS.flatMap((spec) =>
    FIELD_STATES.map((state) => ({
      key: `field/${spec.field}=${state}`,
      make: () =>
        repoCell(withFieldState(populatedRepo(), spec.field, state, spec.value, spec.empty))
    }))
  ),
  ...REPO_NESTED.map((entry) => ({
    key: entry.key,
    make: () =>
      repoCell(
        entry.key === 'nested/onlyUnknown'
          ? { nonsense: 1 }
          : { ...populatedRepo(), ...entry.patch }
      )
  }))
]

const REPO_CORE_KEYS: ReadonlySet<string> = new Set([
  'repo/absent',
  'repo/null',
  'repo/{}',
  'sca/null',
  'sca/{}',
  'sca/populated',
  'field/enabled=absent',
  'field/enabled=value',
  'field/customAgentCommand=null',
  'field/instructionsByOperation=value',
  'field/actionOverrides=value',
  'nested/instructions.commitMessage=null',
  'nested/pr.draft=null',
  'nested/actionOverrides.agentArgs=null',
  'nested/onlyUnknown'
])

export const REPO_CORE = REPO_FULL.filter((cell) => REPO_CORE_KEYS.has(cell.key))

/** Non-record `repo.sourceControlAi` values — the normalizer's own axis. */
export const REPO_NON_RECORD: readonly Cell<unknown>[] = [
  { key: 'nonRecord/string', make: () => 'nope' },
  { key: 'nonRecord/number', make: () => 42 },
  { key: 'nonRecord/array', make: () => [] },
  { key: 'nonRecord/true', make: () => true },
  { key: 'nonRecord/date', make: () => new Date(0) },
  { key: 'nonRecord/map', make: () => new Map() }
]

export function buildRepo(cell: RepoCell): unknown {
  if (!cell.repoPresent) {
    return undefined
  }
  if (cell.repoNull) {
    return null
  }
  const repo: Record<string, unknown> = { id: 'r1', path: '/tmp/r1' }
  if (cell.scaPresent) {
    repo.sourceControlAi = cell.value
  }
  return repo
}
