// Which model selections a legacy `commitMessageAi` write actually CHANGED.
//
// The legacy blob is also our own rollback projection, so a plain overwrite
// would keep resurrecting values the user has since changed in the new shape.
// These compare the incoming legacy record against what we last projected and
// import only the differing keys — including a key the legacy write DELETED.
//
// This is deleted-twin code. `source-control-ai.ts` is now the dispatch shim on
// `orca_git::source_control_ai`; these bodies are its pre-ready `parity` answer
// and its answer for every input the core models differently, and nothing else
// calls them. Change them only alongside the Rust core.
import { copyRecord } from './source-control-ai-settings-normalization'
import type { TuiAgent } from './types'

type HostAgentModels = Partial<Record<string, Partial<Record<TuiAgent, string>>>>

export function mergeSelectedModelByAgentByHost(
  base: HostAgentModels | undefined,
  override: HostAgentModels | undefined
): HostAgentModels {
  const merged = copyRecord(base) ?? {}
  for (const [hostKey, hostModels] of Object.entries(override ?? {})) {
    merged[hostKey] = {
      ...merged[hostKey],
      ...hostModels
    }
  }
  return merged
}

export function mergeLegacyModelSelectionDelta<T>(
  existing: Record<string, T> | null | undefined,
  legacy: Record<string, T> | null | undefined,
  projected: Record<string, T> | null | undefined
): Record<string, T> | undefined {
  const merged: Record<string, T> = { ...existing }
  let changed = false
  const keys = new Set([...Object.keys(legacy ?? {}), ...Object.keys(projected ?? {})])
  for (const key of keys) {
    const legacyHasKey = Object.prototype.hasOwnProperty.call(legacy ?? {}, key)
    const legacyValue = legacy?.[key]
    if (JSON.stringify(projected?.[key]) === JSON.stringify(legacyValue)) {
      continue
    }
    changed = true
    if (legacyHasKey && legacyValue !== undefined) {
      merged[key] = legacyValue
    } else {
      delete merged[key]
    }
  }
  return changed ? merged : (existing ?? undefined)
}

export function mergeLegacyHostModelSelectionDelta(
  existing: HostAgentModels | null | undefined,
  legacy: HostAgentModels | null | undefined,
  projected: HostAgentModels | null | undefined
): HostAgentModels | undefined {
  const merged = copyRecord(existing) ?? {}
  let changed = false
  const hostKeys = new Set([...Object.keys(legacy ?? {}), ...Object.keys(projected ?? {})])
  for (const hostKey of hostKeys) {
    const nextHostModels = mergeLegacyModelSelectionDelta(
      merged[hostKey],
      legacy?.[hostKey],
      projected?.[hostKey]
    )
    if (nextHostModels !== merged[hostKey]) {
      changed = true
    }
    if (nextHostModels && Object.keys(nextHostModels).length > 0) {
      merged[hostKey] = nextHostModels
    } else {
      delete merged[hostKey]
    }
  }
  return changed ? merged : (existing ?? undefined)
}
