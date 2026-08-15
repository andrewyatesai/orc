// Types for the terminal-scrollback pruning tier. The IMPLEMENTATION was cut
// over to `orca_config::workspace_session_terminal_buffers`; every surface now
// reaches it through `src/shared/workspace-session-terminal-buffer-pruning.ts`
// on the orca-dispatch seam. This file keeps the shape the callers pass so the
// shim, the parity adapter and the persistence store share one definition.
import type { Repo } from './types'

/** The only repo fields the scrollback classifier reads: a truthy `connectionId`
 *  means SSH-backed, and `executionHostId` distinguishes runtime/ssh hosts from
 *  local ones for repos that carry no connection. */
export type RepoConnection = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
