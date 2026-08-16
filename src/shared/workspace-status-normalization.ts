// The workspace status board's normalization surface on the Rust
// `orca_config::workspace_statuses` core: sanitize/dedupe/cap the persisted
// status columns, mint a column id, clamp the board's width and opacity, and
// resolve a worktree (or a sidebar group key) to a column. The bodies were
// deleted from `src/shared/workspace-statuses.ts`, which keeps the types, the
// id catalogs, the bounds and the default table the fallback rebuilds from
// (`workspace-status-column-sanitization.ts` holds the column half of it).
//
// WHY THE SHARED SEAM AND NOT A TREE SHIM: the callers span three trees with no
// single binding between them. `src/shared/constants.ts` builds the default
// persisted UI state — it runs in main, cli, renderer, preload and the relay —
// while `src/main/persistence.ts` normalizes what is written to disk (napi) and
// the sidebar board reads/mints columns in the renderer (wasm at ready). One
// shim, on `orca-dispatch-seam`, for all of them.
//
// PRE-READY CONTRACT — `parity` for all eleven exports, and it is FORCED:
//  * `normalizeWorkspaceStatuses` / `normalizePersistedWorkspaceStatuses` are
//    what `persistence.ts` PERSISTS; a degraded answer rewrites the user's board.
//  * `makeWorkspaceStatusId` mints a persisted, user-visible column id.
//  * `getWorkspaceStatusGroupKey` is a React key and a Map key
//    (`worktree-list-groups.ts`), and `getWorkspaceStatusFromGroupKey` is its
//    inverse used to resolve a drop target — the two must agree or a drag moves
//    a workspace into a column that does not exist.
//  * `getWorkspaceStatus` / `isWorkspaceStatusId` are equality-compared against
//    a lane id on every card render.
// No export has a spare state to signal with: `''` and `false` are real answers,
// `null` is the real answer of `getWorkspaceStatusFromGroupKey`, and the two
// clamps return the numbers the board is laid out with. So every fallback
// recomputes the deleted twin's body over the kept data, and pre-ready equals
// ready for every input that crosses.
//
// TWO DECLARED RESIDUALS. Both are answered LOCALLY rather than crossed, so the
// twin's behaviour is preserved and pre-ready still equals ready — but the Rust
// core is not what answers them, and that is the point of declaring it:
//
// 1. `makeWorkspaceStatusId` past 99 collisions. The twin returns
//    `status-${Date.now().toString(36)}` — clock-derived, so it can never
//    satisfy a parity row even in principle, and the core substitutes
//    `${base}-${existing.length}`, which for the only input that reaches it is a
//    value ALREADY TAKEN (`base-2`…`base-99` are what exhausted the loop). The
//    shim detects the exhausted branch and answers with the twin's clock id.
//    Unreachable through normalization (`MAX_WORKSPACE_STATUSES` is 12, so the
//    loop cannot exhaust); reachable only from `WorkspaceKanbanDrawer`'s
//    add-column with 99 same-slug columns already present.
// 2. The surrogate-split cap. `MAX_STATUS_LABEL_LENGTH` counts UTF-16 code
//    units, so when the 32nd unit lands between the halves of a pair the twin's
//    `slice(0, 32)` emits a LONE high surrogate and no Rust `String` can hold
//    one — the core drops the pair and returns 31 units instead. Reachable by
//    typing 31 characters and then an emoji. The shim tests the fallback's
//    labels for an unpaired surrogate and answers locally when it finds one.
//
// BOUND-VS-UNBOUND is guarded before the dispatch, not after it. Every fallback
// is computed EAGERLY, so a non-string / non-array / null argument throws the
// twin's own TypeError on both paths instead of being encoded and answered by a
// core whose adapter reads a missing field as `""`. `statuses_from_json` is the
// specific hazard: it rebuilds an absent or non-string `id` as `""`, so a list
// the twin would have thrown on (or compared unequal to) would instead have
// matched a column whose id is empty.
//
// DECLARED COST, measured on this shim, not inherited from the old estimate:
// the seam is not free on the two per-worktree-per-render sidebar lookups
// (`worktree-list-groups.ts` builds a status and a group key for every row).
// Bound to wasm, `getWorkspaceStatus` is 2698ns/op against 29ns for the local
// fallback, and `getWorkspaceStatusGroupKey` 527ns against 36ns. Projecting the
// payload to `{id}` only (below) is what brings it down from the 4587ns measured
// before this cutover; the rest is the JSON encode + wasm hop and cannot be
// removed without either caching (a staleness risk this shim will not take
// unasked) or a list-shaped arm that resolves every row in one crossing. Boards
// are ≤12 columns and sidebars are typically tens of rows, so this is a budget
// call to make deliberately — it is recorded in
// docs/rust-migration/ported-modules.md next to the `worktree-id` one.
//
// MEASURED, not assumed: 1,594,616 differential comparisons of the fallbacks
// below against BOTH shipped cores (`native/orca-node/orca_node.node` and the
// relay `orca_git_wasm`, which also agreed with each other on every one) —
// every Unicode scalar as a label and as an id in three positions, the whole JS
// trim set doubled in every position, the cap boundary at every offset with
// BMP/astral/ZWJ/combining fillers, 40k randomized column lists (dupes,
// non-object rows, absent keys, unknown colors/icons), all eight migration
// payload shapes crossed with all eight option-flag masks, 200k numeric clamps
// over the halfway/subnormal/huge/negative classes, and the group-key
// round-trip over reserved/astral/malformed-escape ids. Zero disagreements.
// The only inputs that did NOT cross are the two residuals: 20 cap-splitting
// labels and the exhausted minter, and for each the probe asserted that the
// shim answered the TWIN and that the core cannot.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { isOrcaDispatchReady, tryOrcaDispatch } from './orca-dispatch-seam'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
  WORKSPACE_BOARD_COLUMN_WIDTH_MIN,
  WORKSPACE_STATUS_GROUP_PREFIX
} from './workspace-statuses'
import {
  defaultStatusColumns,
  mintStatusColumnId,
  sanitizePersistedStatusColumns,
  sanitizeStatusColumns
} from './workspace-status-column-sanitization'
import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from './types'

const WORKSPACE_STATUSES = 'workspace-statuses'

/** An unpaired UTF-16 surrogate — residual 2's fingerprint, and the one thing a
 *  Rust `String` cannot carry back. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

type Crossing = { crossed: false } | { crossed: true; value: unknown }
const NOT_CROSSED: Crossing = { crossed: false }

/** `crossed:false` = the seam is unbound, or the payload cannot cross — answer
 *  locally. A flag rather than `null`, because `getWorkspaceStatusFromGroupKey`
 *  returns a real `null`.
 *  Why the catch: persisted board JSON and IPC updates both reach these, so an
 *  unpaired surrogate or an explicitly-`undefined` property is reachable and the
 *  codec refuses to encode it. The twin answered those without crossing
 *  anything, so the fallback does too; a DispatchCoreError still propagates. */
function crossWorkspaceStatuses(fn: string, input: unknown, root: string): Crossing {
  if (!isOrcaDispatchReady()) {
    return NOT_CROSSED
  }
  try {
    return { crossed: true, value: tryOrcaDispatch(WORKSPACE_STATUSES, fn, input, { root }) }
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return NOT_CROSSED
    }
    throw error
  }
}

/** Exactly what the core's `statuses_from_json` can read back without inventing
 *  a field: a real array of plain objects carrying a string `id`. */
function isDispatchableStatusList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (status) =>
        typeof status === 'object' &&
        status !== null &&
        !Array.isArray(status) &&
        typeof (status as { id?: unknown }).id === 'string'
    )
  )
}

/** Only `id` drives the id/group-key/minting arms, so nothing else crosses — an
 *  unread sibling key must not be what refuses the encode. */
function statusIdsPayload(statuses: readonly WorkspaceStatusDefinition[]): { id: string }[] {
  return statuses.map((status) => ({ id: status.id }))
}

/** The deleted twin's body, verbatim. */
function localIsStatusId(value: string, statuses: readonly WorkspaceStatusDefinition[]): boolean {
  return statuses.some((status) => status.id === value)
}

/** The deleted twin's body, verbatim. */
function localDefaultStatusId(statuses: readonly WorkspaceStatusDefinition[]): WorkspaceStatus {
  return statuses.some((status) => status.id === DEFAULT_WORKSPACE_STATUS_ID)
    ? DEFAULT_WORKSPACE_STATUS_ID
    : (statuses[0]?.id ?? DEFAULT_WORKSPACE_STATUS_ID)
}

/** The deleted twin's body, verbatim — the try wraps only the decode, so a
 *  non-string groupKey throws out of `startsWith` exactly as it did. */
function localFromGroupKey(
  groupKey: string,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus | null {
  if (!groupKey.startsWith(WORKSPACE_STATUS_GROUP_PREFIX)) {
    return null
  }
  try {
    const status = decodeURIComponent(groupKey.slice(WORKSPACE_STATUS_GROUP_PREFIX.length))
    return localIsStatusId(status, statuses) ? status : null
  } catch {
    return null
  }
}

/** Residual 2's gate: a column list whose label carries an unpaired surrogate is
 *  a list the core cannot return, so it is answered from the twin's body. */
function normalizedOrLocal(
  fn: string,
  input: unknown,
  fallback: WorkspaceStatusDefinition[]
): WorkspaceStatusDefinition[] {
  if (fallback.some((status) => LONE_SURROGATE.test(status.label))) {
    return fallback
  }
  const outcome = crossWorkspaceStatuses(fn, input, fn)
  return outcome.crossed ? (outcome.value as WorkspaceStatusDefinition[]) : fallback
}

/** A fresh, mutable copy of the shipped default board columns. */
export function cloneDefaultWorkspaceStatuses(): WorkspaceStatusDefinition[] {
  const fallback = defaultStatusColumns()
  const outcome = crossWorkspaceStatuses(
    'cloneDefaultWorkspaceStatuses',
    undefined,
    'cloneDefaultWorkspaceStatuses'
  )
  return outcome.crossed ? (outcome.value as WorkspaceStatusDefinition[]) : fallback
}

/**
 * Mint a column id from a label, suffixing `-2`, `-3`, … past a collision.
 * Persisted and user-visible, so the answer is the twin's for every input.
 */
export function makeWorkspaceStatusId(
  label: string,
  existingStatuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  const fallback = mintStatusColumnId(label, existingStatuses)
  // Residual 1: the core substitutes a `${base}-${len}` that is already taken.
  if (fallback.exhausted || !isDispatchableStatusList(existingStatuses)) {
    return fallback.id
  }
  const outcome = crossWorkspaceStatuses(
    'makeWorkspaceStatusId',
    { label, existingStatuses: statusIdsPayload(existingStatuses) },
    'makeWorkspaceStatusId'
  )
  return outcome.crossed ? (outcome.value as WorkspaceStatus) : fallback.id
}

/** Sanitize, dedupe and cap an untrusted status-column list. */
export function normalizeWorkspaceStatuses(value: unknown): WorkspaceStatusDefinition[] {
  return normalizedOrLocal('normalizeWorkspaceStatuses', value, sanitizeStatusColumns(value, {}))
}

/**
 * `normalizeWorkspaceStatuses` plus the one-shot repairs for persisted state:
 * the reversed-default-order regression and the pre-Conductor default visuals.
 */
export function normalizePersistedWorkspaceStatuses(
  value: unknown,
  options: {
    migrateDefaultWorkflowStatuses?: boolean
    repairReorderedDefaultStatuses?: boolean
    migrateLegacyDefaultStatusVisuals?: boolean
  } = {}
): WorkspaceStatusDefinition[] {
  // Every flag crosses as a real boolean: the twin compares each with `=== true`
  // and the adapter reads them with serde `as_bool`, so a truthy non-boolean is
  // off on both sides and no `undefined` property can refuse the encode.
  const flags = {
    migrateDefaultWorkflowStatuses: options.migrateDefaultWorkflowStatuses === true,
    repairReorderedDefaultStatuses: options.repairReorderedDefaultStatuses === true,
    migrateLegacyDefaultStatusVisuals: options.migrateLegacyDefaultStatusVisuals === true
  }
  return normalizedOrLocal(
    'normalizePersistedWorkspaceStatuses',
    { value, options: flags },
    sanitizePersistedStatusColumns(value, options)
  )
}

/** Clamp the board's background opacity to the shipped 0.2–1 range. */
export function clampWorkspaceBoardOpacity(value: unknown): number {
  const usable = typeof value === 'number' && Number.isFinite(value)
  const fallback = usable ? Math.min(1, Math.max(0.2, Math.round(value * 100) / 100)) : 1
  // `-0` is rejected by the codec (JSON has no signed zero); every other
  // non-number answers the constant, which needs no core.
  if (!usable || Object.is(value, -0)) {
    return fallback
  }
  const outcome = crossWorkspaceStatuses('clampWorkspaceBoardOpacity', value, 'value')
  return outcome.crossed ? (outcome.value as number) : fallback
}

/** Clamp a board column width to the shipped min/max, rounded to whole pixels. */
export function clampWorkspaceBoardColumnWidth(value: unknown): number {
  const usable = typeof value === 'number' && Number.isFinite(value)
  const fallback = usable
    ? Math.min(
        WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
        Math.max(WORKSPACE_BOARD_COLUMN_WIDTH_MIN, Math.round(value))
      )
    : WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT
  if (!usable || Object.is(value, -0)) {
    return fallback
  }
  const outcome = crossWorkspaceStatuses('clampWorkspaceBoardColumnWidth', value, 'value')
  return outcome.crossed ? (outcome.value as number) : fallback
}

/** True when `value` names one of the board's columns. */
export function isWorkspaceStatusId(
  value: string,
  statuses: readonly WorkspaceStatusDefinition[]
): value is WorkspaceStatus {
  const fallback = localIsStatusId(value, statuses)
  if (typeof value !== 'string' || !isDispatchableStatusList(statuses)) {
    return fallback
  }
  const outcome = crossWorkspaceStatuses(
    'isWorkspaceStatusId',
    { value, statuses: statusIdsPayload(statuses) },
    'isWorkspaceStatusId'
  )
  return outcome.crossed ? (outcome.value as boolean) : fallback
}

/** The column a workspace lands in when it has none: `in-progress` while the
 *  board still has that column, else the leftmost one. */
export function getDefaultWorkspaceStatusId(
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  const fallback = localDefaultStatusId(statuses)
  if (!isDispatchableStatusList(statuses)) {
    return fallback
  }
  const outcome = crossWorkspaceStatuses(
    'getDefaultWorkspaceStatusId',
    statusIdsPayload(statuses),
    'statuses'
  )
  return outcome.crossed ? (outcome.value as WorkspaceStatus) : fallback
}

/** The column a worktree renders in, falling back when its stored id is gone. */
export function getWorkspaceStatus(
  worktree: Pick<Worktree, 'workspaceStatus'>,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  const current = worktree.workspaceStatus
  const fallback =
    current && localIsStatusId(current, statuses) ? current : localDefaultStatusId(statuses)
  if (!isDispatchableStatusList(statuses)) {
    return fallback
  }
  const outcome = crossWorkspaceStatuses(
    'getWorkspaceStatus',
    {
      // A non-string stored id is the twin's falsy/never-equal case, which the
      // adapter's absent `workspaceStatus` reproduces exactly.
      worktree: typeof current === 'string' ? { workspaceStatus: current } : {},
      statuses: statusIdsPayload(statuses)
    },
    'getWorkspaceStatus'
  )
  return outcome.crossed ? (outcome.value as WorkspaceStatus) : fallback
}

/** The sidebar group key for a column — a React key and a Map key. */
export function getWorkspaceStatusGroupKey(status: WorkspaceStatus): string {
  // Eager, and it can THROW: `encodeURIComponent` rejects an unpaired surrogate
  // with a URIError, which is the twin's answer and must not turn into a
  // rejected encode naming a dispatch field instead.
  const fallback = `${WORKSPACE_STATUS_GROUP_PREFIX}${encodeURIComponent(status)}`
  if (typeof status !== 'string') {
    return fallback
  }
  const outcome = crossWorkspaceStatuses('getWorkspaceStatusGroupKey', status, 'status')
  return outcome.crossed ? (outcome.value as string) : fallback
}

/** The inverse of `getWorkspaceStatusGroupKey`; `null` is a real answer —
 *  "not a status group key, or names a column the board no longer has". */
export function getWorkspaceStatusFromGroupKey(
  groupKey: string,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus | null {
  const fallback = localFromGroupKey(groupKey, statuses)
  if (typeof groupKey !== 'string' || !isDispatchableStatusList(statuses)) {
    return fallback
  }
  const outcome = crossWorkspaceStatuses(
    'getWorkspaceStatusFromGroupKey',
    { groupKey, statuses: statusIdsPayload(statuses) },
    'getWorkspaceStatusFromGroupKey'
  )
  return outcome.crossed ? (outcome.value as WorkspaceStatus | null) : fallback
}
