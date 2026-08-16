// Types, bounds and catalogs for the workspace status board. The normalization,
// minting, clamping and lookup implementation was cut over to the Rust
// `orca_config::workspace_statuses` core: `workspace-status-normalization.ts` is
// the shim every surface calls, and it (with
// `workspace-status-column-sanitization.ts`) rebuilds its pre-ready fallback
// from the data kept here.
import type { WorkspaceStatus } from './types'

export { DEFAULT_WORKSPACE_STATUSES } from './workspace-status-defaults'

/** The board's own group-key namespace, shared by the encoder and the parser. */
export const WORKSPACE_STATUS_GROUP_PREFIX = 'workspace-status:'
/** `String.prototype.slice` bound — UTF-16 code units, not code points. */
export const MAX_STATUS_LABEL_LENGTH = 32
export const MAX_WORKSPACE_STATUSES = 12

export const DEFAULT_WORKSPACE_STATUS_ID: WorkspaceStatus = 'in-progress'
export const DEFAULT_WORKSPACE_STATUS_COLOR_ID = 'neutral'
export const DEFAULT_WORKSPACE_STATUS_ICON_ID = 'circle-dot'
export const WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT = 308
export const WORKSPACE_BOARD_COLUMN_WIDTH_MIN = 220
export const WORKSPACE_BOARD_COLUMN_WIDTH_MAX = 520
export const WORKSPACE_BOARD_COLUMN_WIDTH_STEP = 20

export const WORKSPACE_STATUS_COLOR_IDS = [
  'neutral',
  'blue',
  'sky',
  'violet',
  'amber',
  'emerald',
  'rose',
  'zinc',
  'conductor-done',
  'conductor-review',
  'conductor-progress'
] as const

export const WORKSPACE_STATUS_ICON_IDS = [
  'circle',
  'circle-dot',
  'circle-progress',
  'circle-dashed',
  'circle-ellipsis',
  'git-pull-request',
  'timer',
  'flag',
  'circle-alert',
  'circle-pause',
  'circle-play',
  'circle-check',
  'ban',
  'conductor-done',
  'conductor-review',
  'conductor-progress'
] as const
