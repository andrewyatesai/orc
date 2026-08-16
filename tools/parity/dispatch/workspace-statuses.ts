// TS dispatch for the workspace-statuses parity module. The shared TS impl was
// DELETED (`src/shared/workspace-statuses.ts` keeps only the types, bounds and
// catalogs) — every surface now reaches `orca_config::workspace_statuses`
// through `src/shared/workspace-status-normalization.ts` on the orca-dispatch
// seam.
//
// Like the branch-name-from-work, wsl-paths, worktree-id and stable-pane-id
// adapters, this drives the SHIM rather than a wasm oracle, so the harness keeps
// a real TS-vs-Rust differential instead of degenerating to wasm-vs-binary:
// config/vitest.parity.config.ts installs no setup file, so the seam is unbound
// here and the shim answers from its `parity` fallback — which is the deleted
// body, and exactly the code main/renderer/relay run before (or without) a
// binding.

import {
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  cloneDefaultWorkspaceStatuses,
  getDefaultWorkspaceStatusId,
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  isWorkspaceStatusId,
  makeWorkspaceStatusId,
  normalizePersistedWorkspaceStatuses,
  normalizeWorkspaceStatuses
} from '../../../src/shared/workspace-status-normalization'
import type { Worktree, WorkspaceStatusDefinition } from '../../../src/shared/types'

type StatusList = readonly WorkspaceStatusDefinition[]
type PersistOptions = {
  migrateDefaultWorkflowStatuses?: boolean
  repairReorderedDefaultStatuses?: boolean
  migrateLegacyDefaultStatusVisuals?: boolean
}

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    // No parameters, so the vector input is an empty named-argument object.
    case 'cloneDefaultWorkspaceStatuses':
      return cloneDefaultWorkspaceStatuses()
    case 'normalizeWorkspaceStatuses':
      return normalizeWorkspaceStatuses(input)
    case 'normalizePersistedWorkspaceStatuses': {
      const { value, options } = input as { value: unknown; options?: PersistOptions }
      // Why the branch: a vector that omits `options` must call the twin with ONE
      // argument. Passing an explicit `undefined` records as a second arg, which
      // JSON.stringify writes as `null`, and parity:twin-derived then cannot match
      // the call back to the named-argument encoding — the function goes
      // UNDERIVABLE and its twin-test cases are dropped.
      return options === undefined
        ? normalizePersistedWorkspaceStatuses(value)
        : normalizePersistedWorkspaceStatuses(value, options)
    }
    case 'makeWorkspaceStatusId': {
      const { label, existingStatuses } = input as { label: string; existingStatuses: StatusList }
      return makeWorkspaceStatusId(label, existingStatuses)
    }
    case 'clampWorkspaceBoardOpacity':
      return clampWorkspaceBoardOpacity(input)
    case 'clampWorkspaceBoardColumnWidth':
      return clampWorkspaceBoardColumnWidth(input)
    case 'isWorkspaceStatusId': {
      const { value, statuses } = input as { value: string; statuses: StatusList }
      return isWorkspaceStatusId(value, statuses)
    }
    case 'getDefaultWorkspaceStatusId':
      return getDefaultWorkspaceStatusId(input as StatusList)
    case 'getWorkspaceStatus': {
      const { worktree, statuses } = input as {
        worktree: Pick<Worktree, 'workspaceStatus'>
        statuses: StatusList
      }
      return getWorkspaceStatus(worktree, statuses)
    }
    case 'getWorkspaceStatusGroupKey':
      return getWorkspaceStatusGroupKey(input as string)
    case 'getWorkspaceStatusFromGroupKey': {
      const { groupKey, statuses } = input as { groupKey: string; statuses: StatusList }
      return getWorkspaceStatusFromGroupKey(groupKey, statuses)
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
