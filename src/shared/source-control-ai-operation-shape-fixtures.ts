// The scalar shape axes crossed with the settings and repo blobs: recorded model
// choice, discovery host, agent id, operation, action id, PR-creation product
// defaults and the agent environment.
//
// `HOST_KEYS` deliberately carries a host WITH a recorded choice and one WITHOUT,
// because the twin folds the local key onto `selectedModelByAgent` and only the
// unrecorded host proves the fallback chain.
import type { Cell, OptionalValue } from './source-control-ai-settings-shape-fixtures'

export const CHOICE_CELLS: readonly Cell<unknown>[] = [
  { key: 'choice/undefined', make: () => undefined },
  { key: 'choice/null', make: () => null },
  { key: 'choice/{}', make: () => ({}) },
  { key: 'choice/byAgent', make: () => ({ selectedModelByAgent: { codex: 'a1' } }) },
  { key: 'choice/byAgentEmpty', make: () => ({ selectedModelByAgent: {} }) },
  {
    key: 'choice/byAgentOwnUndefined',
    make: () => ({ selectedModelByAgent: { codex: undefined } })
  },
  { key: 'choice/byAgentNull', make: () => ({ selectedModelByAgent: null }) },
  {
    key: 'choice/byHost',
    make: () => ({ selectedModelByAgentByHost: { 'ssh:box': { codex: 'a2' } } })
  },
  { key: 'choice/byHostEmpty', make: () => ({ selectedModelByAgentByHost: {} }) },
  {
    key: 'choice/byHostEmptyInner',
    make: () => ({ selectedModelByAgentByHost: { 'ssh:box': {} } })
  },
  {
    key: 'choice/byHostLocal',
    make: () => ({ selectedModelByAgentByHost: { local: { codex: 'a3' } } })
  },
  { key: 'choice/thinkingOnly', make: () => ({ selectedThinkingByModel: { a1: 'high' } }) },
  {
    key: 'choice/full',
    make: () => ({
      selectedModelByAgent: { codex: 'a1', claude: 'a4' },
      selectedModelByAgentByHost: { 'ssh:box': { codex: 'a2' }, local: { claude: 'a5' } },
      selectedThinkingByModel: { a1: 'high' }
    })
  },
  {
    key: 'choice/fullOwnUndefinedThinking',
    make: () => ({ selectedModelByAgent: { codex: 'a1' }, selectedThinkingByModel: undefined })
  },
  { key: 'choice/unknownMember', make: () => ({ nonsense: 1 }) },
  {
    key: 'choice/localOnly',
    make: () => ({ selectedModelByAgent: { codex: 'a1', claude: 'a4' } })
  },
  { key: 'choice/nonRecord', make: () => 'nope' },
  {
    key: 'choice/hostNonString',
    make: () => ({ selectedModelByAgentByHost: { 'ssh:box': { codex: 7 } } })
  }
]

/** A host WITH a recorded model choice and a host WITHOUT one, plus the local key
 *  the twin folds onto `selectedModelByAgent`. */
export const HOST_KEYS: readonly Cell<unknown>[] = [
  { key: 'host/local', make: () => 'local' },
  { key: 'host/recorded', make: () => 'ssh:box' },
  { key: 'host/unrecorded', make: () => 'ssh:nowhere' },
  { key: 'host/empty', make: () => '' }
]

export const AGENT_IDS: readonly Cell<unknown>[] = [
  { key: 'agent/codex', make: () => 'codex' },
  { key: 'agent/claude', make: () => 'claude' },
  { key: 'agent/unknown', make: () => 'nope' }
]

export const OPERATIONS = ['commitMessage', 'pullRequest', 'branchName'] as const

export const ACTION_IDS = [
  'commitMessage',
  'pullRequest',
  'branchName',
  'fixCommitFailure',
  'fixPushFailure',
  'fixChecks',
  'resolveConflicts',
  'resolveComments'
] as const

export const PRODUCT_DEFAULTS: readonly Cell<OptionalValue>[] = [
  { key: 'product/absent', make: () => ({ present: false, value: undefined }) },
  { key: 'product/ownUndefined', make: () => ({ present: true, value: undefined }) },
  { key: 'product/null', make: () => ({ present: true, value: null }) },
  { key: 'product/{}', make: () => ({ present: true, value: {} }) },
  {
    key: 'product/full',
    make: () => ({
      present: true,
      value: { draft: true, useTemplate: true, generateDetailsOnOpen: true, openAfterCreate: true }
    })
  },
  { key: 'product/partial', make: () => ({ present: true, value: { openAfterCreate: true } }) }
]

/** `defaultTuiAgent` / `customAgents` / `disabledTuiAgents` / `agentCmdOverrides` —
 *  the members `resolveSourceControlAiForOperation` reads beyond the two blobs. */
export const AGENT_ENVS: readonly Cell<Record<string, unknown>>[] = [
  { key: 'env/codex', make: () => ({ defaultTuiAgent: 'codex' }) },
  { key: 'env/claude', make: () => ({ defaultTuiAgent: 'claude' }) },
  { key: 'env/absent', make: () => ({}) },
  { key: 'env/null', make: () => ({ defaultTuiAgent: null }) },
  { key: 'env/blank', make: () => ({ defaultTuiAgent: 'blank' }) },
  {
    key: 'env/customProfile',
    make: () => ({
      defaultTuiAgent: { id: 'profile-1' },
      customAgents: [{ id: 'profile-1', baseAgent: 'codex' }]
    })
  },
  {
    key: 'env/customProfileNoBase',
    make: () => ({
      defaultTuiAgent: { id: 'profile-2' },
      customAgents: [{ id: 'profile-2', baseAgent: null }]
    })
  },
  { key: 'env/disabled', make: () => ({ defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] }) },
  {
    key: 'env/disabledNonArray',
    make: () => ({ defaultTuiAgent: 'codex', disabledTuiAgents: null })
  },
  {
    key: 'env/cmdOverrides',
    make: () => ({ defaultTuiAgent: 'codex', agentCmdOverrides: { codex: '  codex-x  ' } })
  },
  {
    key: 'env/cmdOverridesEmpty',
    make: () => ({ defaultTuiAgent: 'codex', agentCmdOverrides: {} })
  },
  {
    key: 'env/cmdOverridesNull',
    make: () => ({ defaultTuiAgent: 'codex', agentCmdOverrides: null })
  }
]
