// Worktree-id types and data. The parsing was CUT OVER to the Rust
// `orca_core::worktree_id` core — reach it through `worktree-id-parsing.ts`,
// which also rebuilds the deleted bodies from the constants below for the
// surfaces that have not bound the dispatch seam yet.
export { WORKTREE_ID_SEPARATOR } from './pty-session-id-format'

export type ParsedWorktreeId = {
  repoId: string
  worktreePath: string
}

export const FOLDER_WORKSPACE_INSTANCE_SEPARATOR = '::workspace:'

/** `::workspace:<uuid>` anchored to the end of a worktree path — the data half of
 *  the filesystem-path strip, so the seam shim's fallback can rebuild the body. */
export const FOLDER_WORKSPACE_INSTANCE_SUFFIX = new RegExp(
  `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f-]{36}$`
)
