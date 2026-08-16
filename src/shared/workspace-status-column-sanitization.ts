// How a raw status column becomes a valid one: sanitize label/id/color/icon,
// dedupe, cap, mint an id, and apply the two one-shot persisted-state repairs.
//
// This is the pre-cutover TypeScript body of `orca_config::workspace_statuses`,
// kept deliberately and used for exactly two things:
//  * the pre-ready fallback of `workspace-status-normalization.ts` — the shim's
//    answer while the orca-dispatch seam is unbound must be the answer the
//    deleted twin gave for that input, and every one of these results is
//    PERSISTED, so no constant or sentinel is honest here;
//  * the TS side of `pnpm parity`, which drives the shim with the seam unbound
//    and so compares this copy against the Rust copy on every vector.
// It has no other callers, and it must not grow behaviour the Rust core lacks —
// a one-sided edit turns `pnpm parity` red rather than shipping two boards.
import {
  DEFAULT_WORKSPACE_STATUS_COLOR_ID,
  DEFAULT_WORKSPACE_STATUS_ICON_ID,
  MAX_STATUS_LABEL_LENGTH,
  MAX_WORKSPACE_STATUSES,
  WORKSPACE_STATUS_COLOR_IDS,
  WORKSPACE_STATUS_ICON_IDS
} from './workspace-statuses'
import { DEFAULT_STATUS_VISUALS, DEFAULT_WORKSPACE_STATUSES } from './workspace-status-defaults'
import {
  isKnownBadPRReorderedDefaultStatusPayload,
  isLegacyDefaultWorkflowStatusPayload
} from './workspace-status-default-migration'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from './types'

export type StatusColumnSanitizeOptions = {
  migrateDefaultWorkflowStatuses?: boolean
  repairReorderedDefaultStatuses?: boolean
  migrateLegacyDefaultStatusVisuals?: boolean
}

export function defaultStatusColumns(): WorkspaceStatusDefinition[] {
  return DEFAULT_WORKSPACE_STATUSES.map((status) => ({ ...status }))
}

/** The `slice` counts UTF-16 code units, which is where the surrogate-split
 *  residual declared in `workspace-status-normalization.ts` comes from. */
function sanitizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, MAX_STATUS_LABEL_LENGTH) : fallback
}

function slugLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'status'
}

function sanitizeId(value: unknown, fallbackLabel: string): WorkspaceStatus {
  if (typeof value !== 'string') {
    return slugLabel(fallbackLabel)
  }
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return slugLabel(fallbackLabel)
  }
  return trimmed.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'status'
}

function sanitizeColor(
  value: unknown,
  statusId: string,
  label: string,
  index: number,
  options: StatusColumnSanitizeOptions
): string {
  if (
    options.migrateLegacyDefaultStatusVisuals === true &&
    ((statusId === 'in-progress' && label === 'In progress' && value === 'blue') ||
      (statusId === 'in-review' && label === 'In review' && value === 'violet') ||
      (statusId === 'completed' &&
        (label === 'Completed' || label === 'Done') &&
        value === 'emerald')) &&
    DEFAULT_STATUS_VISUALS[statusId]
  ) {
    return DEFAULT_STATUS_VISUALS[statusId]?.color ?? DEFAULT_WORKSPACE_STATUS_COLOR_ID
  }
  if (typeof value === 'string' && WORKSPACE_STATUS_COLOR_IDS.some((id) => id === value)) {
    return value
  }
  const defaultVisual = DEFAULT_STATUS_VISUALS[statusId]
  if (defaultVisual) {
    return defaultVisual.color
  }
  return WORKSPACE_STATUS_COLOR_IDS[index % WORKSPACE_STATUS_COLOR_IDS.length]
}

function sanitizeIcon(
  value: unknown,
  statusId: string,
  label: string,
  options: StatusColumnSanitizeOptions
): string {
  if (
    options.migrateLegacyDefaultStatusVisuals === true &&
    ((statusId === 'in-progress' &&
      label === 'In progress' &&
      (value === 'circle-dot' || value === 'circle-progress')) ||
      (statusId === 'in-review' && label === 'In review' && value === 'git-pull-request') ||
      (statusId === 'completed' &&
        (label === 'Completed' || label === 'Done') &&
        value === 'circle-check')) &&
    DEFAULT_STATUS_VISUALS[statusId]
  ) {
    return DEFAULT_STATUS_VISUALS[statusId]?.icon ?? DEFAULT_WORKSPACE_STATUS_ICON_ID
  }
  if (typeof value === 'string' && WORKSPACE_STATUS_ICON_IDS.some((id) => id === value)) {
    return value
  }
  return DEFAULT_STATUS_VISUALS[statusId]?.icon ?? DEFAULT_WORKSPACE_STATUS_ICON_ID
}

/** `exhausted` flags the clock-derived branch — declared residual 1 in the shim,
 *  which is the one answer no Rust core can reproduce. */
export function mintStatusColumnId(
  label: string,
  existingStatuses: readonly WorkspaceStatusDefinition[]
): { id: WorkspaceStatus; exhausted: boolean } {
  const base = slugLabel(label)
  const existingIds = new Set(existingStatuses.map((status) => status.id))
  if (!existingIds.has(base)) {
    return { id: base, exhausted: false }
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (!existingIds.has(candidate)) {
      return { id: candidate, exhausted: false }
    }
  }
  return { id: `status-${Date.now().toString(36)}`, exhausted: true }
}

export function sanitizeStatusColumns(
  value: unknown,
  options: StatusColumnSanitizeOptions
): WorkspaceStatusDefinition[] {
  if (!Array.isArray(value)) {
    return defaultStatusColumns()
  }
  const statuses: WorkspaceStatusDefinition[] = []
  const usedIds = new Set<string>()
  for (const rawStatus of value.slice(0, MAX_WORKSPACE_STATUSES)) {
    if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
      continue
    }
    const raw = rawStatus as Record<string, unknown>
    const fallbackLabel = `Status ${statuses.length + 1}`
    const label = sanitizeLabel(raw.label, fallbackLabel)
    let id = sanitizeId(raw.id, label)
    if (usedIds.has(id)) {
      id = mintStatusColumnId(label, statuses).id
    }
    usedIds.add(id)
    statuses.push({
      id,
      label,
      color: sanitizeColor(raw.color, id, label, statuses.length, options),
      icon: sanitizeIcon(raw.icon, id, label, options)
    })
  }
  return statuses.length === 0 ? defaultStatusColumns() : statuses
}

export function sanitizePersistedStatusColumns(
  value: unknown,
  options: StatusColumnSanitizeOptions
): WorkspaceStatusDefinition[] {
  if (
    options.migrateDefaultWorkflowStatuses === true &&
    isLegacyDefaultWorkflowStatusPayload(value)
  ) {
    return defaultStatusColumns()
  }
  // Why: a previous build briefly wrote the default columns in reverse order.
  // The repair is one-shot and checks the raw payload, because normalized
  // IDs/labels are indistinguishable from a user-authored column reorder.
  if (
    options.repairReorderedDefaultStatuses === true &&
    isKnownBadPRReorderedDefaultStatusPayload(value)
  ) {
    return defaultStatusColumns()
  }
  return sanitizeStatusColumns(value, {
    migrateLegacyDefaultStatusVisuals: options.migrateLegacyDefaultStatusVisuals
  })
}
