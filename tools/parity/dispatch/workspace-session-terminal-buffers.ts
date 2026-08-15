// TS dispatch for the workspace-session-terminal-buffers parity module. The
// shared TS impl was DELETED (`src/shared/workspace-session-terminal-buffers.ts`
// keeps only the `RepoConnection` type) — every surface now reaches
// `orca_config::workspace_session_terminal_buffers` through
// `src/shared/workspace-session-terminal-buffer-pruning.ts` on the
// orca-dispatch seam.
//
// Like the worktree-id adapter, this one drives the SHIM rather than the wasm
// oracle, so the harness keeps a real TS-vs-Rust differential instead of
// degenerating to wasm-vs-binary: config/vitest.parity.config.ts installs no
// setup file, so the seam is unbound here and the shim answers from its
// `parity` fallback — which is exactly the deleted body, and exactly the code
// the renderer runs before (or without) a binding.

import {
  capTerminalScrollbackSessionBuffer,
  pruneLocalTerminalScrollbackBuffers,
  shouldPreserveTerminalScrollbackBuffers,
  type RepoConnection
} from '../../../src/shared/workspace-session-terminal-buffer-pruning'
import type { WorkspaceSessionState } from '../../../src/shared/types'

/** JSON has no `undefined`, so an absent-or-null limit selects the TS default
 *  parameter. The Rust adapter applies the same rule — JS `null` would coerce to
 *  0 instead of defaulting, which no caller wants and no vector exercises. */
function optionalLimit(value: number | null | undefined): number | undefined {
  return value ?? undefined
}

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'shouldPreserveTerminalScrollbackBuffers': {
      const { worktreeId, repos } = input as {
        worktreeId?: string
        repos: RepoConnection[]
      }
      return shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)
    }
    case 'capTerminalScrollbackSessionBuffer': {
      const { buffer, byteLimit } = input as { buffer: string; byteLimit?: number | null }
      const limit = optionalLimit(byteLimit)
      return limit === undefined
        ? capTerminalScrollbackSessionBuffer(buffer)
        : capTerminalScrollbackSessionBuffer(buffer, limit)
    }
    case 'pruneLocalTerminalScrollbackBuffers': {
      const { session, repos, opts } = input as {
        session: WorkspaceSessionState
        repos: RepoConnection[]
        opts?: { bufferByteLimit?: number | null }
      }
      // Why the third argument is omitted rather than passed as `{}`: the
      // twin-derived harness infers the vector encoding from the arguments the
      // adapter actually passes, and a phantom `opts` on every legacy vector
      // makes the named-argument convention unmatchable — which drops the
      // module's derived cases instead of reporting them.
      const limit = optionalLimit(opts?.bufferByteLimit)
      return limit === undefined
        ? pruneLocalTerminalScrollbackBuffers(session, repos)
        : pruneLocalTerminalScrollbackBuffers(session, repos, { bufferByteLimit: limit })
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
